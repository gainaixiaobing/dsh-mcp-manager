/**
 * 运行时清单：把 Harness 的 loader 条目 + 工具注册表，整理成「MCP 服务列表」。
 *
 * 数据来源（全部走 Harness 公开运行时）：
 *   - `ctx.loader.entries()` 里 `name === '@deepseek-ai/dsh-mcp-client'` 的条目；
 *   - `ctx.tools.schemas()` 里 `mcp__<serverName>__<tool>` 形式的工具。
 *
 * 本模块只读，不修改任何东西；写操作在 `provision.js` 与 `lib/index.js`。
 */
import { MCP_CLIENT, endpointOf, isJsExpr, isPlainObject, sleep, truncate } from './util.js';

export const TOOLS_WAIT_MS = 2500;

/** 某服务在工具注册表里的命名空间前缀。 */
export function toolPrefix(serverName) {
  return `mcp__${serverName}__`;
}

/** 读取所有 MCP 客户端条目（loader 树递归）。 */
export function mcpEntries(ctx) {
  const found = [];
  let iterable;
  try {
    iterable = ctx.loader.entries();
  } catch (error) {
    ctx.logger?.warn?.(`[mcp-manager] 无法读取 loader 条目：${error?.message ?? error}`);
    return found;
  }
  try {
    for (const entry of iterable) {
      if (entry?.options?.name === MCP_CLIENT) found.push(entry);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[mcp-manager] 遍历 loader 条目失败：${error?.message ?? error}`);
  }
  return found;
}

/** 已注册的全局工具 schema（失败时降级为空，不致命）。 */
export function toolSchemas(ctx) {
  try {
    if (typeof ctx.tools?.schemas !== 'function') return [];
    const schemas = ctx.tools.schemas();
    return Array.isArray(schemas) ? schemas : [];
  } catch (error) {
    ctx.logger?.warn?.(`[mcp-manager] 无法读取工具注册表：${error?.message ?? error}`);
    return [];
  }
}

/** 条目原始配置（含 `!!js` 表达式，未求值）。 */
export function rawConfig(entry) {
  return isPlainObject(entry?.options?.config) ? entry.options.config : {};
}

/** 条目生效配置：优先用已求值的 fiber.config，停用/未启动时退回原始配置。 */
export function liveConfig(entry) {
  const resolved = entry?.fiber?.config;
  return isPlainObject(resolved) ? resolved : rawConfig(entry);
}

/** 从条目 id 推导服务名兜底（config.serverName 缺失时）。 */
export function deriveServerName(entryId) {
  const last = String(entryId ?? '').split(':').pop() ?? '';
  return last.replace(/^mcp-manager-/, '').replace(/^mcp-/, '') || last;
}

/** 某个服务已注册的工具（rawName / 描述）。 */
export function toolsOfServer(ctx, serverName, schemas = toolSchemas(ctx), { includeDescriptions = true } = {}) {
  const prefix = toolPrefix(serverName);
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

/** 从 `mcp__<server>__<tool>` 里取 server 段（按已知服务名匹配，避免误切）。 */
export function serverNameOfTool(publicName, serverNames) {
  const known = [...serverNames]
    .sort((a, b) => b.length - a.length)
    .find((serverName) => publicName.startsWith(toolPrefix(serverName)));
  return known ?? publicName.slice('mcp__'.length).split('__')[0];
}

/**
 * 单条 loader 条目的摘要。
 *
 * `status` 语义：
 *   - connected：已启用、已加载、命名空间下有工具；
 *   - no-tools：已启用、已加载，但没有工具；
 *   - failed：已启用但没有 fiber（apply 抛错，常见于 serverName 冲突）；
 *   - disabled：被停用。
 */
export function summarizeEntry(ctx, entry, { schemas = toolSchemas(ctx), managed = false } = {}) {
  const live = liveConfig(entry);
  const serverName = typeof live.serverName === 'string' ? live.serverName : deriveServerName(entry?.options?.id);
  const tools = toolsOfServer(ctx, serverName, schemas);
  const enabled = !entry.disabled;
  const loaded = entry.fiber !== undefined;
  const loaderId = entry.id ?? entry.options?.id ?? serverName;
  return {
    id: loaderId,
    shortId: entry.options?.id ?? serverName,
    origin: managed ? 'managed' : 'profile',
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

/**
 * 组装完整清单（loader 条目 + 自管存储里尚未生效的记录 + 全局统计）。
 *
 * @param {object} ctx - Cordis 上下文（需 `tools`、`loader`）。
 * @param {object} [options]
 * @param {import('./store.js').ConnectionStore} [options.store] - 自管连接存储。
 * @param {boolean} [options.includeDescriptions] - 工具描述开关。
 * @returns {{servers: object[], summary: object}}
 */
export function listServers(ctx, options = {}) {
  const schemas = toolSchemas(ctx);
  const includeDescriptions = options.includeDescriptions !== false;
  const store = options.store;
  const managedNames = new Set(store?.list?.().map((record) => record.serverName) ?? []);

  const servers = mcpEntries(ctx)
    .map((entry) => summarizeEntry(ctx, entry, {
      schemas,
      managed: managedNames.has(liveConfig(entry).serverName),
    }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.id.localeCompare(b.id));

  // 已登记但当前 loader 里没有的受管记录（例如该 profile 启动时 provision 失败/被停用移除）
  const present = new Set(servers.map((server) => server.serverName));
  const failures = options.failures instanceof Map ? options.failures : new Map(Object.entries(options.failures ?? {}));
  for (const record of store?.list?.() ?? []) {
    if (present.has(record.serverName)) continue;
    const failure = failures.get(record.serverName);
    servers.push({
      id: `mcp-manager-${record.serverName}`,
      shortId: `mcp-manager-${record.serverName}`,
      origin: 'managed',
      serverName: record.serverName,
      transport: record.transport,
      endpoint: endpointOf(record),
      enabled: record.enabled !== false,
      loaded: false,
      status: record.enabled === false ? 'disabled' : failure !== undefined ? 'failed' : 'not-provisioned',
      toolCount: 0,
      toolNames: [],
      tools: [],
      ...(failure !== undefined ? { error: failure } : {}),
    });
  }
  servers.sort((a, b) => a.serverName.localeCompare(b.serverName) || a.id.localeCompare(b.id));

  // 同名条目共享工具命名空间：按唯一 serverName 统计工具数，并打 duplicate 标记。
  const byName = new Map();
  for (const server of servers) {
    byName.set(server.serverName, [...(byName.get(server.serverName) ?? []), server]);
  }
  let uniqueToolCount = 0;
  for (const [serverName, group] of byName) {
    const count = group.some((server) => server.loaded && server.status === 'connected') || group.some((server) => server.loaded)
      ? toolsOfServer(ctx, serverName, schemas).length
      : 0;
    uniqueToolCount += count;
    for (const server of group) {
      server.duplicate = group.length > 1;
      server.duplicateIds = group.length > 1 ? group.map((item) => item.id) : undefined;
      if (includeDescriptions === false) server.tools = [];
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
    notProvisioned: servers.filter((server) => server.status === 'not-provisioned').length,
    managed: servers.filter((server) => server.origin === 'managed').length,
    toolCount: uniqueToolCount,
    orphanToolCount: schemas.filter(
      (schema) => typeof schema?.name === 'string'
        && schema.name.startsWith('mcp__')
        && !byName.has(serverNameOfTool(schema.name, byName.keys())),
    ).length,
  };
  return { servers, summary };
}

/**
 * 把用户输入解析到唯一服务：条目 id / 短 id / 服务名 / 唯一子串。
 *
 * @param {object[]} servers - `listServers().servers`。
 * @param {string} key - 用户输入。
 * @returns {object} 唯一匹配的服务。
 */
export function resolveServer(servers, key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('缺少 server 参数：请传服务名（可用 mcp_manager_list 查看）。');
  }
  const needle = key.trim();
  const byId = servers.find(
    (server) => server.id === needle || server.shortId === needle || server.id.endsWith(`:${needle}`),
  );
  if (byId) return byId;

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
    (server) => server.serverName.toLowerCase().includes(lower) || server.id.toLowerCase().includes(lower),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`“${needle}”匹配到多个 MCP 服务：${fuzzy.map((server) => server.id).join('、')}；请传更精确的服务名或条目 id。`);
  }
  const known = servers.map((server) => server.serverName).join('、') || '(当前没有 MCP 服务)';
  throw new Error(`找不到 MCP 服务 “${needle}”。已接入：${known}。`);
}

/** 轮询等待某条目达到期望状态（enable 等 fiber 出现，disable 等 disabled=true）。 */
export async function waitForEntryState(ctx, id, predicate, timeoutMs = TOOLS_WAIT_MS) {
  const started = Date.now();
  const find = () => [...ctx.loader.entries()].find((entry) => (entry.id ?? entry.options?.id) === id);
  let entry = find();
  while (Date.now() - started < timeoutMs) {
    if (entry !== undefined && predicate(entry)) return entry;
    await sleep(100);
    entry = find();
  }
  return entry;
}

/** 轮询等待某服务的工具数变化（异步连接/注销需要时间）。 */
export async function waitForToolCount(ctx, serverName, predicate, timeoutMs = TOOLS_WAIT_MS) {
  const started = Date.now();
  let count = toolsOfServer(ctx, serverName, toolSchemas(ctx)).length;
  while (Date.now() - started < timeoutMs && !predicate(count)) {
    await sleep(100);
    count = toolsOfServer(ctx, serverName, toolSchemas(ctx)).length;
  }
  return count;
}

export { isJsExpr };
