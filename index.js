/**
 * dsh-mcp-manager —— 本机 MCP 服务管理器（DeepSeek Harness / Cordis 插件）
 *
 * 设计目标：做一个"轻量版 MCP 连接器"，只管理**本机已经接入**的 MCP 服务，
 * 不包含插件市场、远程目录、OAuth 授权、安装分发等重型能力。
 *
 * 数据来源（全部取自 Harness 运行时，不读私存文件）：
 *   - `ctx.loader.entries()` 中 `name === '@deepseek-ai/dsh-mcp-client'` 的条目
 *     （既包括 profile 的 cordis.patch.yml 静态声明的服务，也包括其他插件动态
 *     provision 出来的服务）；
 *   - `ctx.tools.schemas()` 中已注册的 `mcp__<serverName>__<tool>` 工具，用于
 *     统计每个服务当前"真正可用"的工具数量并据此判断连接状态。
 *
 * 管理动作全部走 Harness 公开的运行时接口：
 *   - 启停 / 增删条目：`ctx.loader.update() / create() / remove()`（仅本次运行生效，
 *     重启后以 profile 配置为准 —— 这是有意为之，避免插件偷偷改写用户配置）；
 *   - 展示层：一组 `mcp_manager_*` 对话工具 + 同源 HTTP API（供自带 UI 使用）。
 *
 * 本文件刻意不 import 任何裸包名（连 `@deepseek-ai/dsh-tools` 也不 import），
 * 以便作为 profile 插件从任意目录加载时不依赖模块解析兜底。
 *
 * @module dsh-mcp-manager
 */

/** 被管理的 MCP 客户端插件名（Harness 官方 MCP 桥）。 */
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

/** 动态创建条目时使用的 id 前缀，避免与 profile 里手写的 `mcp-*` 条目冲突。 */
const OWN_ENTRY_PREFIX = 'mcp-manager-';

/** 看起来像凭据的字段名：导出配置时一律脱敏。 */
const SENSITIVE_KEY = /(authorization|proxy-authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|credential|private[-_]?key)/i;

/** MCP 服务名约束（与 dsh-mcp-client 的 serverName 约束一致）。 */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** 工具描述截断长度。 */
const TOOL_DESC_LIMIT = 400;

/** 启用/停用后等待工具注册变化的最长时间（毫秒）。 */
const TOOLS_WAIT_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncate(text, limit = TOOL_DESC_LIMIT) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function isJsExpr(value) {
  return Boolean(value) && typeof value === 'object' && '__jsExpr' in value;
}

/** 只保留协议 + 主机 + 路径，去掉可能含凭据的 query / hash。 */
function redactUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(无法解析的 URL)';
  }
}

/** stdio 命令只展示可执行文件名与参数个数，不展开参数（参数里常含 token）。 */
function describeCommand(command, args) {
  if (typeof command !== 'string') return undefined;
  const base = command.split(/[\\/]/).pop() || command;
  const count = Array.isArray(args) ? args.length : 0;
  return count > 0 ? `${base}（+${count} 个参数）` : base;
}

function endpointOf(config) {
  if (!isPlainObject(config)) return '';
  if (config.transport === 'streamable-http') {
    if (isJsExpr(config.url)) return '运行时 URL 表达式';
    return redactUrl(config.url) ?? '';
  }
  if (config.transport === 'stdio') {
    if (isJsExpr(config.command)) return '运行时命令表达式';
    return describeCommand(config.command, config.args) ?? '';
  }
  return '';
}

/** 从条目 id 推导服务名兜底（config.serverName 缺失时）。 */
function deriveServerName(entryId) {
  const last = String(entryId ?? '').split(':').pop() ?? '';
  return last.replace(/^mcp-manager-/, '').replace(/^mcp-/, '') || last;
}

function schemaToolNamePrefix(serverName) {
  return `mcp__${serverName}__`;
}

/**
 * 创建管理器。所有方法都只依赖 ctx 上的公开服务，便于测试时注入假 ctx。
 *
 * @param {object} ctx - Cordis 上下文，需含 `tools` 与 `loader`。
 * @param {object} [config] - 插件配置。
 * @returns {object} 管理器 API。
 */
export function createManager(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const includeDescriptions = config.includeDescriptions !== false;

  /** 读取所有 MCP 客户端条目（loader 树递归）。 */
  function mcpEntries() {
    const found = [];
    let iterable;
    try {
      iterable = ctx.loader.entries();
    } catch (error) {
      logger.warn?.(`[mcp-manager] 无法读取 loader 条目：${error?.message ?? error}`);
      return found;
    }
    try {
      for (const entry of iterable) {
        if (entry?.options?.name === MCP_CLIENT) found.push(entry);
      }
    } catch (error) {
      logger.warn?.(`[mcp-manager] 遍历 loader 条目失败：${error?.message ?? error}`);
    }
    return found;
  }

  /** 已注册的全局工具 schema（失败时降级为空，不致命）。 */
  function toolSchemas() {
    try {
      if (typeof ctx.tools?.schemas !== 'function') return [];
      const schemas = ctx.tools.schemas();
      return Array.isArray(schemas) ? schemas : [];
    } catch (error) {
      logger.warn?.(`[mcp-manager] 无法读取工具注册表：${error?.message ?? error}`);
      return [];
    }
  }

  /** 条目原始配置（含 `!!js` 表达式，未求值）。 */
  function rawConfig(entry) {
    return isPlainObject(entry?.options?.config) ? entry.options.config : {};
  }

  /** 条目生效配置：优先用已求值的 fiber.config，停用/未启动时退回原始配置。 */
  function liveConfig(entry) {
    const resolved = entry?.fiber?.config;
    return isPlainObject(resolved) ? resolved : rawConfig(entry);
  }

  /** 某个服务已注册的工具（rawName / 描述）。 */
  function toolsOfServer(serverName, schemas = toolSchemas()) {
    const prefix = schemaToolNamePrefix(serverName);
    const tools = [];
    for (const schema of schemas) {
      const name = schema?.name;
      if (typeof name !== 'string' || !name.startsWith(prefix)) continue;
      tools.push({
        name: name.slice(prefix.length),
        publicName: name,
        description: includeDescriptions ? truncate(schema.description) : '',
      });
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
  }

  /** 单个服务的摘要。 */
  function summarize(entry, schemas = toolSchemas()) {
    const live = liveConfig(entry);
    const serverName = typeof live.serverName === 'string' ? live.serverName : deriveServerName(entry?.options?.id);
    const tools = toolsOfServer(serverName, schemas);
    const enabled = !entry.disabled;
    // 条目已启用但没有 fiber：加载失败（典型原因：同一 serverName 被重复声明，
    // dsh-mcp-client 的命名空间保留冲突会让后加载的条目启动失败）。
    const loaded = entry.fiber !== undefined;
    const loaderId = entry.id ?? entry.options?.id ?? serverName;
    return {
      id: loaderId,
      shortId: entry.options?.id ?? serverName,
      origin: String(loaderId).includes(':') ? 'profile' : 'plugin',
      serverName,
      transport: typeof live.transport === 'string' ? live.transport : 'unknown',
      endpoint: endpointOf(live),
      enabled,
      loaded,
      status: !enabled ? 'disabled' : !loaded ? 'failed' : tools.length > 0 ? 'connected' : 'no-tools',
      toolCount: loaded ? tools.length : 0,
      toolNames: tools.map((tool) => tool.name),
      tools,
    };
  }

  /** 全部服务（按服务名排序，附带全局汇总）。 */
  function list() {
    const schemas = toolSchemas();
    const servers = mcpEntries()
      .map((entry) => summarize(entry, schemas))
      .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.id.localeCompare(b.id));

    // 同名条目共享工具命名空间：按唯一 serverName 统计工具数，并给每个条目打 duplicate 标记。
    const byName = new Map();
    for (const server of servers) {
      byName.set(server.serverName, [...(byName.get(server.serverName) ?? []), server]);
    }
    let uniqueToolCount = 0;
    for (const [serverName, group] of byName) {
      const count = group.some((server) => server.loaded) ? toolsOfServer(serverName, schemas).length : 0;
      uniqueToolCount += count;
      for (const server of group) {
        server.duplicate = group.length > 1;
        server.duplicateIds = group.length > 1 ? group.map((item) => item.id) : undefined;
      }
    }

    const summary = {
      total: servers.length,
      uniqueServers: byName.size,
      duplicateServers: [...byName.values()].filter((group) => group.length > 1).length,
      enabled: servers.filter((server) => server.enabled).length,
      disabled: servers.filter((server) => !server.enabled).length,
      connected: servers.filter((server) => server.status === 'connected').length,
      failed: servers.filter((server) => server.status === 'failed').length,
      toolCount: uniqueToolCount,
      orphanToolCount: schemas.filter(
        (schema) => typeof schema?.name === 'string'
          && schema.name.startsWith('mcp__')
          && !byName.has(serverNameOfTool(schema.name, byName.keys())),
      ).length,
    };
    return { servers, summary };
  }

  /** 从 `mcp__<server>__<tool>` 里取出 server 段（按已登记的服务名匹配，避免误切）。 */
  function serverNameOfTool(publicName, serverNames) {
    const known = [...serverNames]
      .sort((a, b) => b.length - a.length)
      .find((serverName) => publicName.startsWith(schemaToolNamePrefix(serverName)));
    return known ?? publicName.slice('mcp__'.length).split('__')[0];
  }

  /** 把用户输入解析到唯一服务：支持条目 id、服务名、唯一子串。 */
  function resolve(key) {
    const servers = list().servers;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('缺少 server 参数：请传服务名（可用 mcp_manager_list 查看）。');
    }
    const needle = key.trim();
    // 1) 条目 id 精确匹配优先（同名服务的两个条目只能靠 id 区分）。
    const byId = servers.find(
      (server) => server.id === needle || server.shortId === needle || server.id.endsWith(`:${needle}`),
    );
    if (byId) return byId;

    // 2) 服务名精确匹配；同名多个条目时拒绝猜测。
    const sameName = servers.filter((server) => server.serverName === needle);
    if (sameName.length === 1) return sameName[0];
    if (sameName.length > 1) {
      throw new Error(
        `“${needle}”对应 ${sameName.length} 个同名条目（共享 mcp__${needle}__ 工具命名空间）：${sameName.map((server) => server.id).join('、')}；请改用条目 id 精确指定。`,
      );
    }

    const lower = needle.toLowerCase();
    const ci = servers.filter(
      (server) => server.serverName.toLowerCase() === lower || server.id.toLowerCase() === lower,
    );
    if (ci.length === 1) return ci[0];
    const fuzzy = servers.filter(
      (server) => server.serverName.toLowerCase().includes(lower)
        || server.id.toLowerCase().includes(lower),
    );
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) {
      throw new Error(
        `“${needle}”匹配到多个 MCP 服务：${fuzzy.map((server) => server.id).join('、')}；请传更精确的服务名或条目 id。`,
      );
    }
    const known = servers.map((server) => server.serverName).join('、') || '(当前没有 MCP 服务)';
    throw new Error(`找不到 MCP 服务 “${needle}”。已接入：${known}。`);
  }

  /** 找到服务对应的 loader 条目。 */
  function entryOf(server) {
    const entry = mcpEntries().find((candidate) => (candidate.id ?? candidate.options?.id) === server.id);
    if (!entry) throw new Error(`MCP 服务 “${server.serverName}” 的 loader 条目已不存在（可能被其他插件移除）。`);
    return entry;
  }

  /** 某服务当前工具数（轻量，不构建完整摘要）。 */
  function toolCount(serverName) {
    return toolsOfServer(serverName, toolSchemas()).length;
  }

  /** 轮询等待工具数满足条件（异步连接/注销需要时间）。 */
  async function waitForToolCount(serverName, predicate) {
    const started = Date.now();
    let count = toolCount(serverName);
    while (Date.now() - started < TOOLS_WAIT_MS && !predicate(count)) {
      await sleep(100);
      count = toolCount(serverName);
    }
    return count;
  }

  /** 启用 / 停用一个服务（运行时生效）。 */
  async function setEnabled(key, enabled) {
    const target = resolve(key);
    const entry = entryOf(target);
    const before = !entry.disabled;
    const loaded = target.loaded !== false;
    if (before === Boolean(enabled)) {
      // 已启用但加载失败的条目：允许"再启用一次"来重试 apply（例如同名冲突已解除）。
      if (enabled && !loaded) {
        await ctx.loader.update(entry.id, { disabled: false });
        await waitForToolCount(target.serverName, (count) => count > 0);
        const retried = mcpEntries().find((candidate) => (candidate.id ?? candidate.options?.id) === entry.id);
        return { changed: true, retried: true, server: retried ? summarize(retried) : summarize(entry) };
      }
      return { changed: false, server: summarize(entry) };
    }
    await ctx.loader.update(entry.id, { disabled: !enabled });
    // 启用要等 mcp-client 重新 initialize + tools/list；停用则等工具注销。
    if (enabled) await waitForToolCount(target.serverName, (count) => count > 0);
    else await waitForToolCount(target.serverName, (count) => count === 0);
    const fresh = mcpEntries().find((candidate) => (candidate.id ?? candidate.options?.id) === entry.id);
    return { changed: true, server: fresh ? summarize(fresh) : target };
  }

  /** 校验并规范化一个待创建的 MCP 客户端配置。 */
  function normalizeConfig(input) {
    if (!isPlainObject(input)) throw new Error('配置必须是对象。');
    const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
    if (!SERVER_NAME.test(serverName)) {
      throw new Error('serverName 必须为 1-32 位字母、数字、下划线或连字符（它会成为工具名 mcp__<serverName>__<tool> 的命名空间）。');
    }
    const transport = input.transport;
    if (transport !== 'streamable-http' && transport !== 'stdio') {
      throw new Error('transport 只能是 "streamable-http" 或 "stdio"。');
    }
    const config = { serverName, transport };
    if (transport === 'streamable-http') {
      if (typeof input.url !== 'string' || !/^https?:\/\//i.test(input.url)) {
        throw new Error('streamable-http 需要合法的 http(s) url。');
      }
      config.url = input.url;
      if (isPlainObject(input.headers)) config.headers = { ...input.headers };
    } else {
      if (typeof input.command !== 'string' || input.command.trim() === '') {
        throw new Error('stdio 需要 command（可执行文件）。');
      }
      config.command = input.command;
      if (Array.isArray(input.args)) config.args = input.args.map((arg) => String(arg));
      if (isPlainObject(input.env)) config.env = { ...input.env };
      if (typeof input.cwd === 'string' && input.cwd !== '') config.cwd = input.cwd;
    }
    if (typeof input.failOnStartupError === 'boolean') config.failOnStartupError = input.failOnStartupError;
    if (Number.isFinite(input.toolCallTimeoutMs)) config.toolCallTimeoutMs = input.toolCallTimeoutMs;
    return config;
  }

  /** 新增或更新一个服务（运行时生效；已有同名服务则更新其配置）。 */
  async function add(input) {
    const config = normalizeConfig(input);
    const existing = list().servers.find((server) => server.serverName === config.serverName);
    if (existing) {
      const entry = entryOf(existing);
      await ctx.loader.update(entry.id, { config, disabled: false });
      const count = await waitForToolCount(config.serverName, (value) => value > 0);
      return { updated: true, id: entry.id, serverName: config.serverName, toolCount: count };
    }
    const id = `${OWN_ENTRY_PREFIX}${config.serverName}`;
    await ctx.loader.create({ id, name: MCP_CLIENT, config, disabled: false });
    const count = await waitForToolCount(config.serverName, (value) => value > 0);
    return { updated: false, id, serverName: config.serverName, toolCount: count };
  }

  /** 移除一个服务（运行时生效；profile 静态声明的服务重启后会回来）。 */
  async function remove(key) {
    const target = resolve(key);
    const entry = entryOf(target);
    await ctx.loader.remove(entry.id);
    return { removed: true, serverName: target.serverName, id: target.id };
  }

  // ── 导出为 profile patch（持久化模板，凭据自动脱敏）──────────────────────

  function yamlScalar(value) {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    const text = String(value);
    if (/^[A-Za-z0-9_./:@+-]+$/.test(text) && !/^(true|false|null|yes|no)$/i.test(text)) return text;
    return `'${text.replace(/'/g, "''")}'`;
  }

  function yamlize(value, indent) {
    const pad = ' '.repeat(indent);
    if (isJsExpr(value)) return ` !!js ${value.__jsExpr}`;
    if (Array.isArray(value)) {
      if (value.length === 0) return ' []';
      return `\n${value
        .map((item) => {
          if (isPlainObject(item) || Array.isArray(item) || isJsExpr(item)) {
            return `${pad}-${yamlize(item, indent + 2)}`;
          }
          return `${pad}- ${yamlScalar(item)}`;
        })
        .join('\n')}`;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined);
      if (keys.length === 0) return ' {}';
      return `\n${keys
        .map((key) => {
          const child = value[key];
          const rendered = isPlainObject(child) || Array.isArray(child) || isJsExpr(child)
            ? yamlize(child, indent + 2)
            : ` ${yamlScalar(child)}`;
          return `${pad}${key}:${rendered}`;
        })
        .join('\n')}`;
    }
    return ` ${yamlScalar(value)}`;
  }

  /** 生成持久化用的 patch 片段：把当前运行时配置写回 cordis.patch.yml。 */
  function exportPatch(only) {
    const warnings = [];
    const candidates = only === undefined ? list().servers : [resolve(only)];
    const servers = [];
    const seenNames = new Set();
    for (const server of candidates) {
      if (seenNames.has(server.serverName)) {
        warnings.push(`${server.id}：与导出的同名服务 ${server.serverName} 重复（共享工具命名空间），已跳过该条目。`);
        continue;
      }
      seenNames.add(server.serverName);
      servers.push(server);
    }
    const rows = [];
    for (const server of servers) {
      const entry = entryOf(server);
      const raw = rawConfig(entry);
      const config = { serverName: server.serverName, transport: server.transport };
      if (server.transport === 'streamable-http') {
        config.url = raw.url;
        if (typeof raw.url === 'string' && raw.url.includes('?')) {
          warnings.push(`${server.serverName}：url 含 query 参数，导出时原样保留，请确认其中没有明文凭据。`);
        }
        if (isPlainObject(raw.headers)) config.headers = raw.headers;
      } else if (server.transport === 'stdio') {
        config.command = raw.command;
        if (raw.args !== undefined) config.args = raw.args;
        if (isPlainObject(raw.env)) config.env = raw.env;
        if (typeof raw.cwd === 'string') config.cwd = raw.cwd;
      }
      if (raw.failOnStartupError !== undefined) config.failOnStartupError = raw.failOnStartupError;
      if (Number.isFinite(raw.toolCallTimeoutMs)) config.toolCallTimeoutMs = raw.toolCallTimeoutMs;

      // 凭据脱敏：headers / env 里敏感键的值替换为 !!js process.env 占位表达式。
      const redact = (target, path) => {
        for (const key of Object.keys(target)) {
          const value = target[key];
          if (SENSITIVE_KEY.test(key)) {
            const envName = `MCP_${server.serverName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
            target[key] = { __jsExpr: `process.env.${envName}` };
            warnings.push(`${server.serverName}：${path}.${key} 已脱敏为 !!js process.env.${envName}，请替换为真实凭据来源。`);
          } else if (isPlainObject(value)) {
            redact(value, `${path}.${key}`);
          }
        }
      };
      if (isPlainObject(config.headers)) redact(config.headers, 'headers');
      if (isPlainObject(config.env)) redact(config.env, 'env');

      const exportId = server.id.startsWith(OWN_ENTRY_PREFIX)
        ? `mcp-${server.id.slice(OWN_ENTRY_PREFIX.length)}`
        : server.id;
      const disabledLine = server.enabled ? '' : '\n      disabled: true';
      rows.push(`    - id: ${exportId}\n      name: '${MCP_CLIENT}'\n      config:${yamlize(config, 8)}${disabledLine}`);
    }
    const yaml = `# 由 dsh-mcp-manager 导出：把下面片段并入 profile 的 cordis.patch.yml 即可持久化\n- insert:\n${rows.join('\n')}\n`;
    return { yaml, warnings };
  }

  return {
    list,
    resolve,
    setEnabled,
    add,
    remove,
    exportPatch,
    mcpEntries,
    toolSchemas,
    rawConfig,
    inspect(key) {
      return resolve(key);
    },
  };
}

// ─── 输出 schema 片段 ────────────────────────────────────────────────────────

const STATUS_LABEL = {
  connected: '已连接',
  disabled: '已停用',
  'no-tools': '已配置·无工具',
  failed: '加载失败',
};

function serverItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'serverName', 'transport', 'enabled', 'status', 'toolCount'],
    properties: {
      id: { type: 'string' },
      shortId: { type: 'string' },
      origin: { type: 'string', enum: ['profile', 'plugin'] },
      serverName: { type: 'string' },
      transport: { type: 'string' },
      endpoint: { type: 'string' },
      enabled: { type: 'boolean' },
      status: { type: 'string', enum: ['connected', 'disabled', 'no-tools', 'failed'] },
      loaded: { type: 'boolean' },
      toolCount: { type: 'integer' },
      duplicate: { type: 'boolean' },
      tools: { type: 'array', items: { type: 'string' } },
    },
  };
}

function textRender(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

function serverRows(servers) {
  const lines = ['| 服务 | 状态 | 传输 | 工具数 | 端点 |', '| --- | --- | --- | --- | --- |'];
  for (const server of servers) {
    const label = STATUS_LABEL[server.status] ?? server.status;
    const name = server.duplicate ? `${server.serverName}（同名）` : server.serverName;
    lines.push(`| ${name} | ${label} | ${server.transport} | ${server.toolCount} | ${server.endpoint || '—'} |`);
  }
  return lines;
}

// ─── 对话工具 ────────────────────────────────────────────────────────────────

/**
 * 注册对话工具（注册器在插件卸载时统一释放）。
 *
 * @param {object} ctx - Cordis 上下文（需 `tools` 服务）。
 * @param {object} manager - createManager() 的返回值。
 */
export function registerTools(ctx, manager) {
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  register({
    name: 'mcp_manager_list',
    description:
      '列出本机已接入的全部 MCP 服务（含 profile 静态声明与其他插件动态接入的服务）：服务名、传输方式、端点、启停状态、当前可用工具数。不读取任何凭据。verbose=true 时附带每个服务的工具名。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verbose: { type: 'boolean', description: '是否附带每个服务的工具名列表（默认 false）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['servers', 'summary'],
        properties: {
          servers: { type: 'array', items: serverItemSchema() },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: ['total', 'uniqueServers', 'duplicateServers', 'enabled', 'disabled', 'connected', 'failed', 'toolCount'],
            properties: {
              total: { type: 'integer' },
              uniqueServers: { type: 'integer' },
              duplicateServers: { type: 'integer' },
              enabled: { type: 'integer' },
              disabled: { type: 'integer' },
              connected: { type: 'integer' },
              failed: { type: 'integer' },
              toolCount: { type: 'integer' },
              orphanToolCount: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => {
        const { servers, summary } = value;
        if (servers.length === 0) return textRender(['当前 profile 没有接入任何 MCP 服务。']);
        const lines = [
          `共 ${summary.total} 个 MCP 条目（唯一服务 ${summary.uniqueServers} 个）：${summary.enabled} 个启用（其中 ${summary.connected} 个已连接），${summary.disabled} 个停用；已注册 MCP 工具 ${summary.toolCount} 个。`,
          ...(summary.duplicateServers > 0
            ? [`注意：有 ${summary.duplicateServers} 个服务被多个条目重复声明（profile 静态行 + 插件动态行），它们共享 mcp__<server>__ 工具命名空间，实际只有一份工具生效；启停请用条目 id 精确指定。`]
            : []),
          '',
          ...serverRows(servers),
        ];
        if (servers.some((server) => server.tools?.length)) {
          lines.push('', '工具明细：');
          for (const server of servers) {
            if (!server.tools?.length) continue;
            lines.push(`- ${server.serverName}：${server.tools.join('、')}`);
          }
        }
        return textRender(lines);
      },
    },
    async execute(args) {
      const { servers, summary } = manager.list();
      const verbose = args?.verbose === true;
      return {
        servers: servers.map((server) => ({
          id: server.id,
          shortId: server.shortId,
          origin: server.origin,
          serverName: server.serverName,
          transport: server.transport,
          endpoint: server.endpoint,
          enabled: server.enabled,
          status: server.status,
          loaded: server.loaded === true,
          toolCount: server.toolCount,
          duplicate: server.duplicate === true,
          ...(verbose ? { tools: server.toolNames } : {}),
        })),
        summary,
      };
    },
  });

  register({
    name: 'mcp_manager_inspect',
    description:
      '查看某个 MCP 服务的详情：传输方式、端点、启停状态、已注册工具清单及工具说明。服务名可用 mcp_manager_list 获取，也接受唯一子串。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名（entryId 或 serverName，支持唯一子串）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['server', 'tools'],
        properties: {
          server: serverItemSchema(),
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'publicName'],
              properties: {
                name: { type: 'string' },
                publicName: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const server = value.server;
        const lines = [
          `服务：${server.serverName}（${server.id}${server.origin === 'profile' ? ' · profile 声明' : ' · 插件动态接入'}${server.duplicate ? ' · 同名重复' : ''}）`,
          `状态：${STATUS_LABEL[server.status] ?? server.status} · 传输：${server.transport}${server.endpoint ? ` · 端点：${server.endpoint}` : ''}`,
          `工具：${server.toolCount} 个`,
        ];
        if (server.status === 'failed') {
          lines.push('该条目已启用但加载失败（没有 fiber）：通常是与另一条目 serverName 重复，工具命名空间被拒绝；可停用或移除其中一个。');
        }
        for (const tool of value.tools ?? []) {
          lines.push(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`);
        }
        if (!value.tools?.length) lines.push('（当前没有已注册的工具；服务可能已停用或连接失败）');
        return textRender(lines);
      },
    },
    async execute(args) {
      const server = manager.inspect(args?.server);
      return {
        server: {
          id: server.id,
          shortId: server.shortId,
          origin: server.origin,
          serverName: server.serverName,
          transport: server.transport,
          endpoint: server.endpoint,
          enabled: server.enabled,
          status: server.status,
          loaded: server.loaded === true,
          toolCount: server.toolCount,
          duplicate: server.duplicate === true,
        },
        tools: server.tools.map((tool) => ({
          name: tool.name,
          publicName: tool.publicName,
          description: tool.description,
        })),
      };
    },
  });

  register({
    name: 'mcp_manager_set_enabled',
    description:
      '启用或停用一个已接入的 MCP 服务（运行时生效：立即断开/重建连接并增删其 mcp__<server>__* 工具；重启 DSH 后恢复 profile 配置）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server', 'enabled'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名（entryId 或 serverName，支持唯一子串）。' },
        enabled: { type: 'boolean', description: 'true 启用，false 停用。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'changed', 'serverName', 'enabled', 'status', 'toolCount'],
        properties: {
          ok: { type: 'boolean' },
          changed: { type: 'boolean' },
          serverName: { type: 'string' },
          enabled: { type: 'boolean' },
          status: { type: 'string', enum: ['connected', 'disabled', 'no-tools', 'failed'] },
          toolCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message ?? `${value.serverName} → ${STATUS_LABEL[value.status]}`]),
    },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await manager.setEnabled(args?.server, args?.enabled === true);
      const server = result.server;
      const message = result.retried
        ? `${server.serverName} 曾加载失败，已尝试重新加载；当前状态：${STATUS_LABEL[server.status] ?? server.status}，工具 ${server.toolCount} 个${server.status === 'failed' ? '（仍失败，请检查同名冲突或凭据）' : '。'}`
        : result.changed
          ? `${server.serverName} 已${server.enabled ? '启用' : '停用'}，当前状态：${STATUS_LABEL[server.status] ?? server.status}，工具 ${server.toolCount} 个。`
          : `${server.serverName} 本来就是${server.enabled ? '启用' : '停用'}状态，未做改动。`;
      return {
        ok: true,
        changed: result.changed,
        serverName: server.serverName,
        enabled: server.enabled,
        status: server.status,
        toolCount: server.toolCount,
        message,
      };
    },
  });

  register({
    name: 'mcp_manager_add',
    description:
      '在本次运行中接入一个新的 MCP 服务（streamable-http 或 stdio）；同名服务已存在时更新其配置。凭据经 headers/env 传入、绝不回显。运行时生效，重启后恢复 profile 配置——需要持久化时用 mcp_manager_export。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['serverName', 'transport'],
      properties: {
        serverName: { type: 'string', description: '1-32 位字母/数字/下划线/连字符，会成为 mcp__<serverName>__<tool> 命名空间。' },
        transport: { type: 'string', enum: ['streamable-http', 'stdio'], description: '传输方式。' },
        url: { type: 'string', description: 'streamable-http：MCP 端点 URL。' },
        headers: { type: 'object', additionalProperties: true, description: 'streamable-http：额外请求头（可放 Authorization 等凭据，不会回显）。' },
        command: { type: 'string', description: 'stdio：可执行文件。' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：参数列表。' },
        env: { type: 'object', additionalProperties: true, description: 'stdio：子进程环境变量（可放凭据，不会回显）。' },
        cwd: { type: 'string', description: 'stdio：工作目录。' },
        failOnStartupError: { type: 'boolean', description: '启动失败时是否让插件激活失败（默认 false，仅记录错误）。' },
        toolCallTimeoutMs: { type: 'integer', description: '单次工具调用超时（毫秒）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'serverName', 'updated', 'toolCount'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          serverName: { type: 'string' },
          updated: { type: 'boolean' },
          toolCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message ?? `${value.serverName} 已接入`]),
    },
    timeoutMs: 60_000,
    async execute(args) {
      const result = await manager.add(args ?? {});
      const message = result.updated
        ? `已更新 MCP 服务 ${result.serverName}，当前注册工具 ${result.toolCount} 个。`
        : `已接入 MCP 服务 ${result.serverName}（条目 ${result.id}），当前注册工具 ${result.toolCount} 个。若为 0，请检查端点/凭据，稍后再用 mcp_manager_list 查看。`;
      return { ok: true, ...result, message };
    },
  });

  register({
    name: 'mcp_manager_remove',
    description:
      '从本次运行中移除一个 MCP 服务（运行时生效；profile 静态声明的服务在重启后会恢复；持久化删除请改 profile 的 cordis.patch.yml）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名（entryId 或 serverName，支持唯一子串）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'removed', 'serverName'],
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'boolean' },
          serverName: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message ?? `已移除 ${value.serverName}`]),
    },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await manager.remove(args?.server);
      return {
        ok: true,
        removed: true,
        serverName: result.serverName,
        message: `已移除 MCP 服务 ${result.serverName}（本次运行生效；重启后若 profile 仍声明会恢复）。`,
      };
    },
  });

  register({
    name: 'mcp_manager_export',
    description:
      '把当前 MCP 服务导出为可直接并入 profile cordis.patch.yml 的 YAML 片段（用于持久化运行时改动）。凭据类字段自动替换成 process.env 占位符，不会泄露 token。可选 server 只导出单个服务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        server: { type: 'string', description: '可选：只导出某个服务（serverName 或唯一子串）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'yaml'],
        properties: {
          ok: { type: 'boolean' },
          yaml: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = ['```yaml', value.yaml.trimEnd(), '```'];
        if (value.warnings?.length) {
          lines.push('', '脱敏提示：', ...value.warnings.map((warning) => `- ${warning}`));
        }
        return textRender(lines);
      },
    },
    async execute(args) {
      const result = manager.exportPatch(args?.server);
      return { ok: true, yaml: result.yaml, warnings: result.warnings };
    },
  });

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 注册器可能已随宿主一起释放 */
      }
    }
  });
}

// ─── Web API（供可选 UI 调用，同源 + 回环 fence）──────────────────────────────

function headerValue(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isTrustedRequest(request) {
  const host = headerValue(request, 'host');
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname;
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || hostname.endsWith('.localhost');
  if (!loopback) return false;
  if (headerValue(request, 'sec-fetch-site') === 'cross-site') return false;
  const origin = headerValue(request, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 挂载同源 HTTP API：GET /mcp-manager/api/state、POST /mcp-manager/api/action。
 * webServer 不可用（纯 headless 部署）时静默跳过。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} manager - createManager() 的返回值。
 * @param {object} [config] - 插件配置。
 */
export function mountWebApi(ctx, manager, config = {}) {
  if (config.webApi === false) return;
  if (typeof ctx.inject !== 'function') return;
  const logger = ctx.logger ?? console;
  const handlers = {
    list: () => manager.list(),
    inspect: (params) => {
      const server = manager.inspect(params?.server);
      return { server: { ...server, tools: undefined }, tools: server.tools };
    },
    setEnabled: async (params) => manager.setEnabled(params?.server, params?.enabled === true),
    add: async (params) => manager.add(params ?? {}),
    remove: async (params) => manager.remove(params?.server),
    export: (params) => manager.exportPatch(params?.server),
  };
  try {
    ctx.inject(['webServer'], (wctx) => {
      wctx.effect(() => {
        const apiDisposer = wctx.webServer.register({
          kind: 'prefix',
          path: '/mcp-manager/api',
          handler: async (request, response) => {
            if (!isTrustedRequest(request)) {
              writeJson(response, 403, { ok: false, message: 'forbidden' });
              return;
            }
            const url = new URL(request.url ?? '/', 'http://localhost');
            const pathname = url.pathname.replace(/^\/mcp-manager\/api/, '') || '/';
            if (pathname === '/state' && request.method === 'GET') {
              try {
                const { servers, summary } = manager.list();
                writeJson(response, 200, {
                  ok: true,
                  servers: servers.map((server) => ({
                    id: server.id,
                    shortId: server.shortId,
                    origin: server.origin,
                    serverName: server.serverName,
                    transport: server.transport,
                    endpoint: server.endpoint,
                    enabled: server.enabled,
                    status: server.status,
                    loaded: server.loaded === true,
                    toolCount: server.toolCount,
                    duplicate: server.duplicate === true,
                    tools: server.toolNames,
                  })),
                  summary,
                });
              } catch (error) {
                writeJson(response, 500, { ok: false, message: String(error?.message ?? error) });
              }
              return;
            }
            if (pathname === '/action' && request.method === 'POST') {
              try {
                const body = await readJsonBody(request);
                const dispatch = handlers[body?.method];
                if (typeof dispatch !== 'function') {
                  writeJson(response, 400, { ok: false, message: `未知方法 "${body?.method}"（可用：${Object.keys(handlers).join('、')}）` });
                  return;
                }
                const result = await dispatch(body?.params ?? {});
                writeJson(response, 200, { ok: true, result });
              } catch (error) {
                writeJson(response, 400, { ok: false, message: String(error?.message ?? error) });
              }
              return;
            }
            writeJson(response, 404, { ok: false, message: 'not found' });
          },
        });
        logger.info?.('[mcp-manager] 管理 API 已挂载：/mcp-manager/api');
        return () => apiDisposer?.();
      });
    });
  } catch (error) {
    logger.warn?.(`[mcp-manager] 管理 API 未挂载：${error?.message ?? error}`);
  }
}

/** 插件配置（不 import schemastery：这里手工归一化，未知字段直接忽略）。 */
export function normalizePluginConfig(input) {
  const config = isPlainObject(input) ? input : {};
  return {
    webApi: config.webApi !== false,
    includeDescriptions: config.includeDescriptions !== false,
  };
}

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [input] - 插件行 config。
 */
export function apply(ctx, input) {
  const config = normalizePluginConfig(input);
  const manager = createManager(ctx, config);
  registerTools(ctx, manager);
  mountWebApi(ctx, manager, config);
  ctx.logger?.info?.('[mcp-manager] 已加载：mcp_manager_list / inspect / set_enabled / add / remove / export');
}

export const name = 'mcp-manager';
export const inject = ['tools', 'loader'];
