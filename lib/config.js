/**
 * 连接记录（record）的规范化与格式互操作：
 *   - `normalizeRecord`：校验/补全一条连接（管理用 schema，与 dsh-mcp-client 配置对齐）；
 *   - `buildEntryConfig`：record → `@deepseek-ai/dsh-mcp-client` 的配置对象；
 *   - `fromMcpServersJson` / `toMcpServersJson`：与 Claude Desktop / Cursor 等
 *     `mcpServers` JSON 约定互转（导入导出都用它）。
 */
import { SERVER_NAME, isPlainObject, ManagerError } from './util.js';

/** 插件支持的传输方式（与 dsh-mcp-client 一致）。 */
export const TRANSPORTS = ['streamable-http', 'stdio'];

const DEFAULT_TIMEOUT_MS = 180_000;

function invalid(message) {
  return new ManagerError('invalid-config', message);
}

function optionalString(input, key, max = 4096) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'string') throw invalid(`${key} 必须是字符串`);
  const value = input[key].trim();
  if (value.length > max) throw invalid(`${key} 过长（>${max} 字符）`);
  return value;
}

function stringRecord(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (!isPlainObject(input[key])) throw invalid(`${key} 必须是对象`);
  const out = {};
  for (const [name, value] of Object.entries(input[key])) {
    if (typeof value !== 'string') throw invalid(`${key}.${name} 必须是字符串`);
    out[name] = value;
  }
  return out;
}

/**
 * 校验并补全一条连接记录。
 *
 * @param {object} input - 原始输入（工具参数 / store 内容 / 导入的 mcpServers 条目）。
 * @param {object} [options]
 * @param {string} [options.source] - 记录来源标记（'managed' 表示插件自管）。
 * @returns {object} 规范化后的 record。
 */
export function normalizeRecord(input, options = {}) {
  if (!isPlainObject(input)) throw invalid('连接配置必须是对象');
  const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
  if (!SERVER_NAME.test(serverName)) {
    throw invalid('serverName 必须为 1-32 位字母、数字、下划线或连字符（它会成为工具名 mcp__<serverName>__<tool> 的命名空间）');
  }

  let transport = input.transport;
  if (transport === 'http') transport = 'streamable-http';
  if (transport === undefined) transport = typeof input.url === 'string' ? 'streamable-http' : 'stdio';
  if (!TRANSPORTS.includes(transport)) throw invalid(`transport 只能是 ${TRANSPORTS.join(' / ')}`);

  const record = { serverName, transport };

  if (transport === 'streamable-http') {
    const url = optionalString(input, 'url', 8192);
    if (url === undefined || !/^https?:\/\//i.test(url)) throw invalid('streamable-http 需要合法的 http(s) url');
    record.url = url;
    const headers = stringRecord(input, 'headers');
    if (headers !== undefined) record.headers = headers;
  } else {
    const command = optionalString(input, 'command', 4096);
    if (command === undefined || command === '') throw invalid('stdio 需要 command（可执行文件）');
    record.command = command;
    if (Array.isArray(input.args)) record.args = input.args.map((arg) => String(arg));
    const env = stringRecord(input, 'env');
    if (env !== undefined) record.env = env;
    const cwd = optionalString(input, 'cwd', 4096);
    if (cwd !== undefined && cwd !== '') record.cwd = cwd;
  }

  if (input.failOnStartupError !== undefined) {
    if (typeof input.failOnStartupError !== 'boolean') throw invalid('failOnStartupError 必须是布尔值');
    record.failOnStartupError = input.failOnStartupError;
  }
  const timeout = input.toolCallTimeoutMs;
  if (timeout !== undefined && timeout !== null) {
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 2_147_483_647) {
      throw invalid('toolCallTimeoutMs 必须是 1000-2147483647 之间的整数');
    }
    record.toolCallTimeoutMs = Math.trunc(timeout);
  } else {
    record.toolCallTimeoutMs = DEFAULT_TIMEOUT_MS;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw invalid('enabled 必须是布尔值');
    record.enabled = input.enabled;
  } else {
    record.enabled = true;
  }
  const note = optionalString(input, 'note', 500);
  if (note !== undefined) record.note = note;

  if (options.source !== undefined) record.source = options.source;
  return record;
}

/**
 * record → `@deepseek-ai/dsh-mcp-client` 配置（去掉插件自管的字段）。
 *
 * @param {object} record - 规范化记录。
 * @param {object} [overrides]
 * @param {boolean} [overrides.failOnStartupError] - 强制覆盖的启动失败策略。
 * @returns {object} mcp-client 配置。
 */
export function buildEntryConfig(record, overrides = {}) {
  const config = { serverName: record.serverName, transport: record.transport };
  if (record.transport === 'streamable-http') {
    config.url = record.url;
    if (record.headers !== undefined) config.headers = { ...record.headers };
  } else {
    config.command = record.command;
    if (record.args !== undefined) config.args = [...record.args];
    if (record.env !== undefined) config.env = { ...record.env };
    if (record.cwd !== undefined) config.cwd = record.cwd;
  }
  if (record.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = record.toolCallTimeoutMs;
  if (overrides.failOnStartupError !== undefined) config.failOnStartupError = overrides.failOnStartupError;
  else if (record.failOnStartupError !== undefined) config.failOnStartupError = record.failOnStartupError;
  return config;
}

/**
 * 把一条 `mcpServers` JSON 条目（Claude Desktop / Cursor / 常见约定）转成 record。
 *
 * 支持：
 *   - stdio：`{ command, args, env, cwd }`
 *   - http：`{ url, headers }`（`type`/`transport` 写成 `http`、`streamable-http` 都可以）
 *   - `type: "sse"` 会被拒绝（dsh-mcp-client 只支持 streamable-http/native stdio）。
 *
 * @param {string} serverName - 服务名（JSON 的 key）。
 * @param {object} entry - JSON 条目。
 * @returns {object} record（enabled 默认 true）。
 */
export function fromMcpServersJson(serverName, entry) {
  if (!isPlainObject(entry)) throw invalid(`mcpServers.${serverName} 必须是对象`);
  const declaredType = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  if (declaredType === 'sse') {
    throw new ManagerError('unsupported-transport', `mcpServers.${serverName} 使用 SSE，dsh-mcp-client 不支持；请改用 streamable-http 端点`);
  }
  const transport = declaredType === 'http' || declaredType === 'streamable-http'
    ? 'streamable-http'
    : declaredType === 'stdio'
      ? 'stdio'
      : undefined;
  const raw = { ...entry, serverName };
  if (transport !== undefined) raw.transport = transport;
  return normalizeRecord(raw, { source: 'managed' });
}

/** record → `mcpServers` 条目（可用于导出给其它客户端）。 */
export function toMcpServersJson(record) {
  if (record.transport === 'streamable-http') {
    return {
      type: 'streamable-http',
      url: record.url,
      ...(record.headers !== undefined ? { headers: { ...record.headers } } : {}),
    };
  }
  return {
    type: 'stdio',
    command: record.command,
    ...(record.args !== undefined ? { args: [...record.args] } : {}),
    ...(record.env !== undefined ? { env: { ...record.env } } : {}),
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
  };
}

/** record 是否携带疑似凭据（用于 UI 提示与导出脱敏提示）。 */
export function recordHasSecrets(record) {
  const values = [];
  if (record.headers) values.push(...Object.keys(record.headers));
  if (record.env) values.push(...Object.keys(record.env));
  return values.some((key) => /(authorization|token|secret|password|key)/i.test(key));
}
