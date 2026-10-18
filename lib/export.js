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
  const rows = [];
  for (const { id, record } of records) {
    const config = { serverName: record.serverName, transport: record.transport };
    if (record.transport === 'streamable-http') {
      config.url = record.url;
      if (typeof record.url === 'string' && record.url.includes('?') && !isJsExpr(record.url)) {
        warnings.push(`${record.serverName}: url 含 query 参数，导出时原样保留，请确认其中没有明文凭据。`);
      }
      if (isPlainObject(record.headers)) config.headers = { ...record.headers };
    } else {
      config.command = record.command;
      if (record.args !== undefined) config.args = [...record.args];
      if (isPlainObject(record.env)) config.env = { ...record.env };
      if (record.cwd !== undefined) config.cwd = record.cwd;
    }
    if (record.failOnStartupError !== undefined) config.failOnStartupError = record.failOnStartupError;
    if (record.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = record.toolCallTimeoutMs;

    if (options.redact !== false) {
      const envPrefix = `MCP_${String(record.serverName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      if (isPlainObject(config.headers)) redactSecrets(config.headers, `${record.serverName} headers`, envPrefix, warnings);
      if (isPlainObject(config.env)) redactSecrets(config.env, `${record.serverName} env`, envPrefix, warnings);
    }

    rows.push(`    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:${yamlize(config, 8)}${record.enabled === false ? '\n      disabled: true' : ''}`);
  }
  const yaml = `# 由 dsh-mcp-manager 导出：把下面片段并入 profile 的 cordis.patch.yml 即可持久化\n- insert:\n${rows.join('\n')}\n`;
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
        url: exprToPlaceholder(record.url, warnings, `${record.serverName}.url`),
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
      if (Array.isArray(record.args)) entry.args = record.args.map((arg, index) => exprToPlaceholder(arg, warnings, `${record.serverName}.args[${index}]`));
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
export function exportMarkdown(servers, summary) {
  const lines = [
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
