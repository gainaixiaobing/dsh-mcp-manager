/**
 * 导出器：
 *   - `exportPatchYaml`：导出为 profile 的 `cordis.patch.yml` 片段（持久化用）；
 *   - `exportMcpServersJson`：导出为通用 `mcpServers` JSON（Claude Desktop / Cursor 等可读）；
 *   - `exportMarkdown`：人工排障用的服务清单（不含凭据）。
 *
 * 两类数据来源：
 *   - `managed`：本插件存储里的记录（明文，导出时脱敏）；
 *   - `profile`：loader 条目里的原始配置（可能含 `!!js process.env.X` 表达式，原样保留）。
 */
import { isJsExpr, isPlainObject, redactSecrets, yamlize, ManagerError } from './util.js';
import { liveConfig, rawConfig } from './inventory.js';

/** 表达式 `process.env.FOO` → `${FOO}`（mcpServers JSON 的通用占位写法）。 */
function exprToPlaceholder(value, warnings, path) {
  if (!isJsExpr(value)) return value;
  const expr = String(value.__jsExpr ?? '');
  const env = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr.trim());
  if (env) return `\${${env[1]}}`;
  warnings.push(`${path}: 表达式 ${expr} 无法转成 \${VAR} 占位符，已标记为 <js:${expr}>`);
  return `<js:${expr}>`;
}

function mapValues(object, fn, path) {
  const out = {};
  for (const [key, value] of Object.entries(object)) out[key] = fn(value, `${path}.${key}`);
  return out;
}

/** 从一条 loader 条目生成可导出的 record（保留 !!js 表达式，JSON 导出时再替换）。 */
function recordFromEntry(entry, warnings) {
  const config = isPlainObject(entry?.fiber?.config) ? entry.fiber.config : rawConfig(entry);
  const raw = rawConfig(entry);
  const serverName = (isPlainObject(config) ? config.serverName : undefined)
    ?? String(entry?.options?.id ?? '').replace(/^mcp-/, '');
  const record = { serverName, transport: isPlainObject(config) ? config.transport : 'unknown' };
  if (record.transport === 'streamable-http' || record.transport === 'http') {
    record.transport = 'streamable-http';
    record.url = isPlainObject(raw) ? raw.url : config.url;
    const headers = (isPlainObject(raw) && isPlainObject(raw.headers)) ? raw.headers : undefined;
    if (headers !== undefined) record.headers = { ...headers };
  } else if (record.transport === 'stdio') {
    record.command = isPlainObject(raw) ? raw.command : config.command;
    const args = (isPlainObject(raw) && Array.isArray(raw.args)) ? raw.args : undefined;
    if (args !== undefined) record.args = [...args];
    const env = (isPlainObject(raw) && isPlainObject(raw.env)) ? raw.env : undefined;
    if (env !== undefined) record.env = { ...env };
    if (isPlainObject(raw) && typeof raw.cwd === 'string') record.cwd = raw.cwd;
  } else {
    warnings.push(`${serverName}: 未知 transport “${record.transport}”，导出时跳过`);
    return undefined;
  }
  if (isPlainObject(raw) && raw.failOnStartupError !== undefined) record.failOnStartupError = raw.failOnStartupError;
  if (isPlainObject(raw) && isPlainObject(raw.reconnect)) record.reconnect = { ...raw.reconnect };
  if (isPlainObject(raw) && Number.isFinite(raw.maxInstructionBytes)) record.maxInstructionBytes = raw.maxInstructionBytes;
  if (isPlainObject(raw) && Number.isFinite(raw.toolCallTimeoutMs)) record.toolCallTimeoutMs = raw.toolCallTimeoutMs;
  else if (isPlainObject(config) && Number.isFinite(config.toolCallTimeoutMs)) record.toolCallTimeoutMs = config.toolCallTimeoutMs;
  record.enabled = !entry.disabled;
  return record;
}

function safeIdFor(serverName) {
  return `mcp-${String(serverName).replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * 收集要导出的记录（按 serverName 去重；profile 行优先）。
 *
 * @param {object[]} servers - inventory 的服务列表。
 * @param {object} options
 * @param {object} [options.store] - 自管存储。
 * @param {string} [options.only] - 只导出某个服务（serverName 或条目 id）。
 * @param {Record<string,object>} [options.records] - 可注入的 store 记录（测试用）。
 * @returns {{records: object[], warnings: string[]}}
 */
export function collectExportRecords(servers, options = {}) {
  const warnings = [];
  const storeRecords = new Map(
    (options.records ?? options.store?.list?.() ?? []).map((record) => [record.serverName, record]),
  );
  const selected = options.only === undefined
    ? servers
    : [servers.find((server) => server.serverName === options.only || server.id === options.only || server.shortId === options.only)]
      .filter(Boolean);
  if (selected.length === 0) throw new ManagerError('server-not-found', `找不到要导出的服务：${options.only}`);

  // profile 行优先保留（它已经是持久声明），同名 managed 记录给出提示。
  const byName = new Map();
  for (const server of selected) {
    const existing = byName.get(server.serverName);
    if (existing !== undefined) {
      if (existing.origin === 'profile' && server.origin === 'managed') {
        warnings.push(`${server.serverName}: 同时存在 profile 声明与受管记录，导出保留 profile 声明，跳过受管记录。`);
      }
      continue;
    }
    byName.set(server.serverName, server);
  }

  const records = [];
  for (const server of byName.values()) {
    if (server.origin === 'managed') {
      const record = storeRecords.get(server.serverName);
      if (record === undefined) {
        warnings.push(`${server.serverName}: 受管记录缺失，跳过`);
        continue;
      }
      records.push({
        id: safeIdFor(server.serverName),
        record: { ...record, enabled: server.enabled },
        origin: 'managed',
      });
    } else {
      const entry = options.entryOf?.(server);
      if (entry === undefined) {
        warnings.push(`${server.serverName}: 找不到 loader 条目，跳过`);
        continue;
      }
      const record = recordFromEntry(entry, warnings);
      if (record !== undefined) records.push({ id: server.shortId ?? safeIdFor(server.serverName), record, origin: 'profile' });
    }
  }
  return { records, warnings };
}

/** URL query 里像凭据的参数名。 */
const SENSITIVE_QUERY_KEY = /(token|access_token|refresh_token|id_token|key|api_key|apikey|secret|client_secret|password|passwd|sig|signature|auth|credential)/i;

/** 命令行参数里像凭据的 flag 名。 */
const SENSITIVE_ARG_FLAG = /(token|key|secret|password|passwd|pat|auth|credential)/i;

/**
 * 把 URL 里的凭据型 query 值替换成 `${ENV}` 占位符（不破坏 URL 结构）。
 *
 * @param {string} rawUrl - 原始 URL。
 * @param {string} envPrefix - 环境变量前缀。
 * @param {string[]} warnings - 收集提示。
 * @param {string} path - 报错定位。
 * @returns {string} 替换后的 URL。
 */
export function redactUrlSecrets(rawUrl, envPrefix, warnings, path) {
  if (typeof rawUrl !== 'string' || isJsExpr(rawUrl)) return rawUrl;
  return rawUrl.replace(/([?&]([^=&#]+)=)([^&#]*)/g, (match, prefix, rawKey, value) => {
    if (!SENSITIVE_QUERY_KEY.test(rawKey) || value === '') return match;
    const envName = `${envPrefix}_URL_${String(rawKey).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    warnings.push(`${path}: url 参数 ${rawKey} 已替换为 \${${envName}} 占位符，导出后需手动填真实值。`);
    return `${prefix}\${${envName}}`;
  });
}

const ARG_FLAG = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/;

/**
 * 把命令行参数里的凭据值替换成 `${ENV}` 占位符：`--token xxx` / `--api-key=xxx` / 裸 token。
 *
 * @param {Array} args - 原始参数数组。
 * @param {string} envPrefix - 环境变量前缀。
 * @param {string[]} warnings - 收集提示。
 * @param {string} path - 报错定位。
 * @returns {Array} 替换后的参数数组。
 */
export function redactArgsSecrets(args, envPrefix, warnings, path) {
  if (!Array.isArray(args)) return args;
  const out = [...args];
  for (let index = 0; index < out.length; index += 1) {
    const arg = out[index];
    if (typeof arg !== 'string' || arg === '') continue;
    const flag = ARG_FLAG.exec(arg);
    if (flag !== null && SENSITIVE_ARG_FLAG.test(flag[1])) {
      const envName = `${envPrefix}_ARG_${index}`;
      if (flag[2] !== undefined) {
        out[index] = `${arg.slice(0, arg.indexOf('=') + 1)}\${${envName}}`;
      } else if (index + 1 < out.length && typeof out[index + 1] === 'string') {
        out[index + 1] = `\${${envName}}`;
        index += 1;
      }
      warnings.push(`${path}[${index}]: 参数 ${arg.split('=')[0]} 的值已替换为 \${${envName}} 占位符。`);
      continue;
    }
    if (arg.length >= 16 && !/\s/.test(arg) && /^(sk-|pk-|ghp_|xox[bp]-|eyJ)/.test(arg)) {
      const envName = `${envPrefix}_ARG_${index}`;
      out[index] = `\${${envName}}`;
      warnings.push(`${path}[${index}]: 疑似凭据参数已替换为 \${${envName}} 占位符。`);
    }
  }
  return out;
}

/**
 * 导出为 `cordis.patch.yml` 片段（凭据脱敏为 `!!js process.env.*`）。
 *
 * @param {object[]} records - `collectExportRecords().records`。
 * @param {object} [options]
 * @param {boolean} [options.redact] - 是否脱敏（默认 true）。
 * @returns {{yaml: string, warnings: string[]}}
 */
export function exportPatchYaml(records, options = {}) {
  const warnings = [];
  const insertRows = [];
  const overrideRows = [];
  for (const { id, record, origin } of records) {
    const config = { serverName: record.serverName, transport: record.transport };
    if (record.transport === 'streamable-http') {
      config.url = record.url;
      if (isPlainObject(record.headers)) config.headers = { ...record.headers };
    } else {
      config.command = record.command;
      if (record.args !== undefined) config.args = [...record.args];
      if (isPlainObject(record.env)) config.env = { ...record.env };
      if (record.cwd !== undefined) config.cwd = record.cwd;
    }
    if (record.failOnStartupError !== undefined) config.failOnStartupError = record.failOnStartupError;
    if (isPlainObject(record.reconnect)) config.reconnect = { ...record.reconnect };
    if (record.maxInstructionBytes !== undefined) config.maxInstructionBytes = record.maxInstructionBytes;
    if (record.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = record.toolCallTimeoutMs;

    if (options.redact !== false) {
      const envPrefix = `MCP_${String(record.serverName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      config.url = redactUrlSecrets(config.url, envPrefix, warnings, `${record.serverName}.url`);
      config.args = redactArgsSecrets(config.args, envPrefix, warnings, `${record.serverName}.args`);
      if (isPlainObject(config.headers)) redactSecrets(config.headers, `${record.serverName} headers`, envPrefix, warnings);
      if (isPlainObject(config.env)) redactSecrets(config.env, `${record.serverName} env`, envPrefix, warnings);
    }

    if (origin === 'profile') {
      // profile 行已经在 cordis.patch.yml 里：输出「按 id 覆盖」而不是 insert，
      // 否则合并后会产生重复 loader id，导致下次启动 fail-loud。
      warnings.push(`${record.serverName}: 以 override 片段导出（id=${id}），合并时是覆盖已有行，不要再放进 - insert。`);
      overrideRows.push(`- id: ${id}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:${yamlize(config, 4)}${record.enabled === false ? '\n  disabled: true' : ''}`);
    } else {
      insertRows.push(`    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:${yamlize(config, 8)}${record.enabled === false ? '\n      disabled: true' : ''}`);
    }
  }
  let yaml = '# 由 dsh-mcp-manager 导出：把下面片段并入 profile 的 cordis.patch.yml 即可持久化\n';
  if (insertRows.length > 0) yaml += `- insert:\n${insertRows.join('\n')}\n`;
  if (overrideRows.length > 0) yaml += `${overrideRows.join('\n')}\n`;
  return { yaml, warnings };
}

/**
 * 导出为通用 `mcpServers` JSON（凭据脱敏为 `${ENV}` 占位符）。
 *
 * @param {object[]} records - `collectExportRecords().records`。
 * @param {object} [options]
 * @param {boolean} [options.redact] - 是否脱敏（默认 true）。
 * @returns {{json: string, data: object, warnings: string[]}}
 */
export function exportMcpServersJson(records, options = {}) {
  const warnings = [];
  const servers = {};
  for (const { record } of records) {
    const redact = options.redact !== false;
    const envPrefix = `MCP_${String(record.serverName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    if (record.transport === 'streamable-http') {
      const entry = {
        type: 'streamable-http',
        url: redact
          ? redactUrlSecrets(exprToPlaceholder(record.url, warnings, `${record.serverName}.url`), envPrefix, warnings, `${record.serverName}.url`)
          : exprToPlaceholder(record.url, warnings, `${record.serverName}.url`),
      };
      if (isPlainObject(record.headers)) {
        entry.headers = mapValues(record.headers, (value, path) => {
          const placeholder = exprToPlaceholder(value, warnings, path);
          if (!redact || typeof placeholder !== 'string') return placeholder;
          return shouldRedactKey(path) ? `\${${envPrefix}_${lastKey(path)}}` : placeholder;
        }, `${record.serverName}.headers`);
      }
      servers[record.serverName] = entry;
    } else {
      const entry = {
        type: 'stdio',
        command: exprToPlaceholder(record.command, warnings, `${record.serverName}.command`),
      };
      if (Array.isArray(record.args)) {
        const mapped = record.args.map((arg, index) => exprToPlaceholder(arg, warnings, `${record.serverName}.args[${index}]`));
        entry.args = redact ? redactArgsSecrets(mapped, envPrefix, warnings, `${record.serverName}.args`) : mapped;
      }
      if (isPlainObject(record.env)) {
        entry.env = mapValues(record.env, (value, path) => {
          const placeholder = exprToPlaceholder(value, warnings, path);
          if (!redact || typeof placeholder !== 'string') return placeholder;
          return shouldRedactKey(path) ? `\${${envPrefix}_${lastKey(path)}}` : placeholder;
        }, `${record.serverName}.env`);
      }
      if (typeof record.cwd === 'string') entry.cwd = record.cwd;
      servers[record.serverName] = entry;
    }
  }
  return {
    json: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    data: { mcpServers: servers },
    warnings,
  };
}

function lastKey(path) {
  return String(path).split('.').pop().replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}

function shouldRedactKey(path) {
  return /(authorization|token|secret|password|key|cookie)/i.test(String(path));
}

/** 生成 Markdown 清单（不含凭据，用于贴到 issue / 报告）。 */
export function exportMarkdown(servers, summary) {  const lines = [
    '# MCP 服务清单',
    '',
    `共 ${summary.total} 个条目（唯一服务 ${summary.uniqueServers} 个）：${summary.enabled} 个启用，${summary.connected} 个已连接，${summary.disabled} 个停用；工具 ${summary.toolCount} 个。`,
    '',
    '| 服务 | 来源 | 状态 | 传输 | 工具数 | 端点 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const statusLabel = { connected: '已连接', disabled: '已停用', 'no-tools': '无工具', failed: '加载失败', 'not-provisioned': '未生效' };
  for (const server of servers) {
    lines.push(`| ${server.serverName}${server.duplicate ? '（同名）' : ''} | ${server.origin === 'managed' ? '受管' : 'profile'} | ${statusLabel[server.status] ?? server.status} | ${server.transport} | ${server.toolCount} | ${server.endpoint || '—'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function formatTimestamp(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '—';
  }
}

/**
 * 生成 Markdown 诊断报告：状态汇总 + 问题清单 + 探针历史（不含凭据）。
 *
 * @param {object} input
 * @param {object[]} input.servers - inventory 服务列表。
 * @param {object} input.summary - inventory 汇总。
 * @param {object} [input.prefs] - 偏好快照（含 servers[].probe/history）。
 * @param {string} [input.storePath] - 受管存储路径。
 * @param {string} [input.prefsPath] - 偏好存储路径。
 * @param {object} [input.provisionFailures] - serverName → 错误文本。
 * @param {string} [input.generatedAt] - ISO 时间。
 * @returns {string} Markdown 文本。
 */
export function exportDiagnostics(input = {}) {
  const servers = Array.isArray(input.servers) ? input.servers : [];
  const summary = input.summary ?? { total: 0, uniqueServers: 0, connected: 0, failed: 0, disabled: 0, managed: 0, toolCount: 0 };
  const prefs = isPlainObject(input.prefs) ? input.prefs : { servers: {} };
  const prefsServers = isPlainObject(prefs.servers) ? prefs.servers : {};
  const statusLabel = { connected: '已连接', disabled: '已停用', 'no-tools': '无工具', failed: '加载失败', 'not-provisioned': '未生效' };
  const lines = [
    '# MCP 诊断报告',
    '',
    `生成时间：${input.generatedAt ?? new Date().toISOString()}`,
    '',
    `- 条目：${summary.total} 个（唯一服务 ${summary.uniqueServers} 个，受管 ${summary.managed ?? 0} 条）`,
    `- 状态：已连接 ${summary.connected} / 加载失败 ${summary.failed} / 停用 ${summary.disabled}`
    + `${summary.notProvisioned !== undefined ? ` / 未生效 ${summary.notProvisioned}` : ''}`,
    `- 工具：${summary.toolCount} 个`,
  ];
  if (typeof input.storePath === 'string' && input.storePath !== '') lines.push(`- 受管存储：${input.storePath}`);
  if (typeof input.prefsPath === 'string' && input.prefsPath !== '') lines.push(`- 偏好存储：${input.prefsPath}`);

  lines.push('', '## 服务清单', '', '| 服务 | 来源 | 状态 | 传输 | 工具数 | 最近探针 | 端点 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const server of servers) {
    const meta = prefsServers[server.serverName] ?? {};
    const probe = isPlainObject(meta.probe) ? meta.probe : undefined;
    const probeText = probe === undefined
      ? '—'
      : `${probe.ok ? '成功' : '失败'} · ${probe.latencyMs ?? 0}ms · ${formatTimestamp(probe.at)}`;
    lines.push(
      `| ${server.serverName}${server.duplicate ? '（同名）' : ''} | ${server.origin === 'managed' ? '受管' : 'profile'} | ${statusLabel[server.status] ?? server.status} | ${server.transport} | ${server.toolCount} | ${probeText} | ${server.endpoint || '—'} |`,
    );
  }

  const problems = [];
  for (const server of servers) {
    if (server.status === 'failed') problems.push(`${server.serverName}：加载失败${server.error ? `（${server.error}）` : ''}`);
    if (server.status === 'no-tools') problems.push(`${server.serverName}：已启用但没有注册工具（可能是连接失败或服务本身不提供工具）`);
    if (server.status === 'not-provisioned') problems.push(`${server.serverName}：受管记录存在，但本次启动没有成功创建条目`);
  }
  for (const [serverName, message] of Object.entries(input.provisionFailures ?? {})) {
    problems.push(`${serverName}：接入失败（${message}）`);
  }
  if (summary.duplicateServers > 0) problems.push(`有 ${summary.duplicateServers} 个服务被多个条目重复声明，共享 mcp__<server>__ 命名空间`);
  const failedProbes = Object.entries(prefsServers)
    .filter(([, meta]) => isPlainObject(meta?.probe) && meta.probe.ok === false)
    .map(([serverName, meta]) => `${serverName}：最近一次探针失败${meta.probe.errorCode ? `（${meta.probe.errorCode}）` : ''}${meta.probe.error ? `：${meta.probe.error}` : ''}`);
  problems.push(...failedProbes);
  lines.push('', '## 问题清单', '');
  lines.push(...(problems.length === 0 ? ['- 未发现结构性异常。'] : problems.map((item) => `- ${item}`)));

  const withHistory = Object.entries(prefsServers).filter(([, meta]) => Array.isArray(meta?.history) && meta.history.length > 0);
  lines.push('', '## 探针历史', '');
  if (withHistory.length === 0) {
    lines.push('- 还没有探针记录（在面板里点「探针」或「全部探测」即可积累）。');
  } else {
    for (const [serverName, meta] of withHistory) {
      lines.push(`### ${serverName}`);
      for (const item of meta.history.slice().reverse().slice(0, 10)) {
        lines.push(
          `- ${formatTimestamp(item.at)} · ${item.ok ? '成功' : '失败'} · ${item.latencyMs ?? 0}ms`
          + `${item.toolCount !== undefined ? ` · ${item.toolCount} 个工具` : ''}`
          + `${item.errorCode ? ` · ${item.errorCode}` : ''}`,
        );
      }
      lines.push('');
    }
  }

  const pinned = Object.entries(prefsServers).filter(([, meta]) => meta?.pinned === true).map(([serverName]) => serverName);
  if (pinned.length > 0) lines.push('', '## 收藏的服务', '', ...pinned.map((serverName) => `- ${serverName}`));
  return `${lines.join('\n')}\n`;
}
