/**
 * MCP 工具「查看 + 试用」。
 *
 * 数据来源是 Harness 的工具注册表：MCP 客户端把每个工具注册成
 * `mcp__<serverName>__<toolName>`，因此本模块不需要自己连 MCP 服务：
 *   - `resolveTool`：从 `ctx.tools.schemas()` 里找到目标工具（含 JSON Schema 参数定义）；
 *   - `invokeTool`：走 `ctx.tools.execute()` 真正调用一次（与模型调用走同一条执行管线，
 *     包含 guard / 审批 / 超时等宿主策略），再把结果折叠成 UI/对话可展示的形状。
 *
 * 纪律：
 *   - 只允许调用 `mcp__*` 命名空间下的工具（不能借这个入口调用 shell/文件等宿主工具）；
 *   - 参数与结果都有字节上限，结果超出时截断并显式标记 `truncated`；
 *   - 错误信息过 `sanitizeText`，成功结果原样返回（用户主动调用，需要看到真实数据）；
 *   - 超时、中断、未知工具都归一成稳定的 `code`，便于 UI 展示与测试。
 */
import { randomBytes } from 'node:crypto';
import { isPlainObject, ManagerError, truncate } from './util.js';
import { sanitizeText } from './sanitize.js';

export const INVOKE_LIMITS = Object.freeze({
  /** 参数 JSON 最大字节数。 */
  argumentsBytes: 256 * 1024,
  /** 结果正文最多保留的字符数。 */
  textChars: 64 * 1024,
  /** 结果里保留的内容块数量上限。 */
  blocks: 100,
  /** raw value / meta 最多序列化的字节数。 */
  rawBytes: 16 * 1024,
  /** 默认与最大超时。 */
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
});

/** 调用失败时抛出的错误（带稳定 code）。 */
export class InvokeError extends ManagerError {
  constructor(code, message, extra = {}) {
    super(code, message);
    this.name = 'InvokeError';
    Object.assign(this, extra);
  }
}

function publicToolName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`;
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function jsonPreview(value, limit = INVOKE_LIMITS.rawBytes) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return { text: undefined, truncated: true };
  }
  if (typeof text !== 'string') return { text: undefined, truncated: false };
  if (byteLength(text) <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

/** 把 MCP 内容块折叠成可展示的纯文本片段。 */
function describeBlock(block, index) {
  if (!isPlainObject(block)) return `[#${index}] ${truncate(String(block), 200)}`;
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  if (type === 'text') {
    return typeof block.text === 'string' ? block.text : `[text #${index}]`;
  }
  if (type === 'image') {
    const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image';
    const bytes = typeof block.data === 'string' ? Math.trunc((block.data.length * 3) / 4) : undefined;
    return `[image ${mime}${bytes !== undefined ? ` · ~${bytes} bytes` : ''}]`;
  }
  if (type === 'audio') {
    const mime = typeof block.mimeType === 'string' ? block.mimeType : 'audio';
    return `[audio ${mime}]`;
  }
  if (type === 'resource') {
    const resource = isPlainObject(block.resource) ? block.resource : {};
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    const text = typeof resource.text === 'string' ? resource.text : undefined;
    return text === undefined ? `[resource ${uri}]` : `[resource ${uri}]\n${text}`;
  }
  if (type === 'resource_link') {
    return `[resource link ${typeof block.uri === 'string' ? block.uri : ''}]`;
  }
  const preview = jsonPreview(block, 400);
  return `[${type}${preview.text !== undefined ? ` ${preview.text}` : ''}]`;
}

/**
 * 从工具注册表里找目标工具。
 *
 * @param {object} ctx - Cordis 上下文（需 `tools`）。
 * @param {string} serverName - 服务名（命名空间）。
 * @param {string} toolName - 工具名（可带 `mcp__server__` 前缀）。
 * @returns {{publicName: string, toolName: string, description: string, parameters: object}} 工具元数据。
 */
export function resolveTool(ctx, serverName, toolName) {
  if (typeof serverName !== 'string' || serverName.trim() === '') {
    throw new InvokeError('invalid-target', '缺少 serverName');
  }
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (name === '') throw new InvokeError('invalid-target', '缺少 toolName');
  const prefix = `mcp__${serverName.trim()}__`;
  const publicName = name.startsWith(prefix) ? name : name.startsWith('mcp__') ? name : `${prefix}${name}`;
  if (!publicName.startsWith(prefix)) {
    throw new InvokeError('invalid-target', `工具 "${name}" 不属于 MCP 服务 "${serverName}"（期望前缀 ${prefix}）`);
  }

  let schemas = [];
  try {
    schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
  } catch (error) {
    throw new InvokeError('registry-unavailable', `读取工具注册表失败：${sanitizeText(error?.message ?? error)}`);
  }
  const found = Array.isArray(schemas) ? schemas.find((schema) => schema?.name === publicName) : undefined;
  if (found === undefined) {
    const near = (Array.isArray(schemas) ? schemas : [])
      .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix))
      .map((schema) => schema.name.slice(prefix.length))
      .slice(0, 8);
    throw new InvokeError(
      'tool-not-found',
      `服务 ${serverName} 下没有工具 "${name.slice(prefix.length)}"`
      + (near.length > 0 ? `；现有：${near.join('、')}${near.length >= 8 ? '…' : ''}` : '（该服务当前没有已注册工具）'),
      { available: near },
    );
  }
  return {
    publicName,
    toolName: publicName.slice(prefix.length),
    description: typeof found.description === 'string' ? found.description : '',
    parameters: isPlainObject(found.parameters) ? found.parameters : { type: 'object', properties: {} },
  };
}

/** 把 schema 转成一个「可运行的示例参数」（供 UI 一键填充）。 */
export function sampleArgumentsFromSchema(schema) {
  const out = {};
  const properties = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};
  const required = isPlainObject(schema) && Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  for (const [key, node] of Object.entries(properties)) {
    const sample = sampleValue(node);
    if (sample === undefined && !required.has(key)) continue;
    out[key] = sample ?? null;
  }
  return out;
}

function sampleValue(node) {
  if (!isPlainObject(node)) return undefined;
  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;
  const type = typeof node.type === 'string' ? node.type : Array.isArray(node.type) ? node.type[0] : undefined;
  switch (type) {
    case 'string': return '';
    case 'number': return 0;
    case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    case 'null': return null;
    default: return node.oneOf?.[0] !== undefined ? sampleValue(node.oneOf[0]) : undefined;
  }
}

/** 失败结果的稳定描述。 */
function failureResult(error, startedAt) {
  const isInvoke = error instanceof InvokeError;
  return {
    ok: false,
    isError: true,
    code: isInvoke ? error.code : 'invoke-failed',
    message: sanitizeText(error?.message ?? String(error), 800),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 调用一个 MCP 工具。
 *
 * @param {object} ctx - Cordis 上下文（需 `tools`）。
 * @param {object} input
 * @param {string} input.serverName - 服务名。
 * @param {string} input.toolName - 工具名（可带前缀）。
 * @param {unknown} [input.arguments] - 工具参数（必须是对象，缺省为 {}）。
 * @param {number} [input.timeoutMs] - 超时（默认 30s，上限 120s）。
 * @param {AbortSignal} [input.signal] - 外部取消信号。
 * @param {boolean} [input.dryRun] - 只校验参数与工具是否存在，不真正执行。
 * @returns {Promise<object>} 折叠后的结果。
 */
export async function invokeTool(ctx, input = {}) {
  const startedAt = Date.now();
  let target;
  try {
    target = resolveTool(ctx, input.serverName, input.toolName);
  } catch (error) {
    return failureResult(error, startedAt);
  }

  const args = input.arguments === undefined || input.arguments === null ? {} : input.arguments;
  if (!isPlainObject(args)) {
    return failureResult(new InvokeError('invalid-arguments', '工具参数必须是一个 JSON 对象'), startedAt);
  }
  const serialized = (() => {
    try {
      return JSON.stringify(args);
    } catch (error) {
      return undefined;
    }
  })();
  if (typeof serialized !== 'string') {
    return failureResult(new InvokeError('invalid-arguments', '工具参数无法序列化为 JSON（是否含循环引用？）'), startedAt);
  }
  if (byteLength(serialized) > INVOKE_LIMITS.argumentsBytes) {
    return failureResult(
      new InvokeError('arguments-too-large', `工具参数过大（${byteLength(serialized)} 字节，上限 ${INVOKE_LIMITS.argumentsBytes}）`),
      startedAt,
    );
  }
  if (input.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      serverName: input.serverName,
      toolName: target.toolName,
      publicName: target.publicName,
      description: target.description,
      parameters: target.parameters,
      argumentsPreview: args,
      durationMs: Date.now() - startedAt,
    };
  }
  if (typeof ctx.tools?.execute !== 'function') {
    return failureResult(new InvokeError('execute-unavailable', '当前宿主没有暴露 ctx.tools.execute()，无法试用工具'), startedAt);
  }

  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(Math.max(Math.trunc(input.timeoutMs), 1000), INVOKE_LIMITS.maxTimeoutMs)
    : INVOKE_LIMITS.defaultTimeoutMs;
  const controller = new AbortController();
  let timer;
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('aborted'));
  if (input.signal?.aborted === true) forwardAbort();
  else input.signal?.addEventListener?.('abort', forwardAbort, { once: true });

  let raw;
  let timedOut = false;
  const execution = ctx.tools.execute({
    callId: `mcp-manager-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    name: target.publicName,
    arguments: args,
    signal: controller.signal,
  });
  // 即使宿主实现没有及时响应 abort，也不要让调用方无限等待。
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`tool call timeout ${timeoutMs}ms`));
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    raw = await Promise.race([
      execution,
      deadline.then(() => {
        if (timedOut) throw new InvokeError('timeout', `调用超时（>${timeoutMs}ms）或已取消`);
        return undefined;
      }),
    ]);
  } catch (error) {
    if (error instanceof InvokeError) return failureResult(error, startedAt);
    const aborted = controller.signal.aborted === true;
    const code = aborted ? 'timeout' : 'invoke-failed';
    const message = aborted
      ? `调用超时（>${timeoutMs}ms）或已取消`
      : `调用抛出异常：${sanitizeText(error?.message ?? error, 600)}`;
    return failureResult(new InvokeError(code, message), startedAt);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener?.('abort', forwardAbort);
    execution.catch?.(() => {});
  }

  return foldResult(raw, startedAt, { serverName: input.serverName, toolName: target.toolName, publicName: target.publicName });
}

/**
 * 把 ToolExecutionResult 折叠成 UI/对话友好的结构。
 *
 * @param {object} raw - `ctx.tools.execute()` 的返回值。
 * @param {number} startedAt - 开始时间戳。
 * @param {object} identity - 服务/工具标识。
 * @returns {object} 折叠结果。
 */
export function foldResult(raw, startedAt, identity = {}) {
  const result = {
    ok: raw?.isError !== true,
    isError: raw?.isError === true,
    ...identity,
    durationMs: Date.now() - startedAt,
  };
  const blocks = Array.isArray(raw?.content) ? raw.content : [];
  const pieces = [];
  let budget = INVOKE_LIMITS.textChars;
  const summarized = [];
  for (const [index, block] of blocks.slice(0, INVOKE_LIMITS.blocks).entries()) {
    const text = describeBlock(block, index);
    summarized.push({ type: typeof block?.type === 'string' ? block.type : 'unknown', text: text.slice(0, 2000) });
    if (budget <= 0) continue;
    const piece = text.length > budget ? `${text.slice(0, budget)}…` : text;
    budget -= piece.length;
    pieces.push(piece);
  }
  const text = pieces.join('\n');
  result.text = text;
  result.blocks = summarized;
  result.truncated = blocks.length > INVOKE_LIMITS.blocks || text.length >= INVOKE_LIMITS.textChars || budget <= 0;
  const valuePreview = jsonPreview(raw?.value);
  if (valuePreview.text !== undefined) {
    result.value = valuePreview.text;
    if (valuePreview.truncated) result.valueTruncated = true;
  }
  const metaPreview = jsonPreview(raw?.meta);
  if (metaPreview.text !== undefined) {
    result.meta = metaPreview.text;
    if (metaPreview.truncated) result.metaTruncated = true;
  }
  if (raw?.isError === true) {
    result.error = {
      message: sanitizeText(raw?.error?.message ?? '工具返回错误', 800),
      ...(typeof raw?.error?.info?.code === 'string' ? { code: raw.error.info.code } : {}),
    };
    if (!result.text) result.text = result.error.message;
  }
  return result;
}
