/**
 * Token 账本：估算「每个 MCP 服务注册的工具 schema 占多少上下文」。
 *
 * 借鉴 `2026heshao/dsh-armory` 的「工具裁缝：谁在吃 token」与
 * `Brightwing-Systems-LLC/mcp-manager` 的 token budget 展示：29 个服务、300 个工具时，
 * 真正贵的不是服务本身，而是塞进模型上下文的工具名 + 描述 + JSON Schema。
 *
 * 口径说明（重要）：
 *   - 只统计 `ctx.tools.schemas()` 里已注册的 `mcp__<server>__<tool>` 工具；
 *   - 统计对象是「工具名 + 描述 + 参数 schema」序列化后的文本量；
 *   - token 数是**启发式估算**：CJK 字符按 1 token/字，其余按 3.5 字符/token，
 *     与真实分词器有偏差（通常 ±20%），只用于横向比较，不要当成计费依据。
 */
import { serverNameOfTool } from './inventory.js';

/** CJK 字符（含中文标点、全角符号）。 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/g;

/** 非 CJK 字符平均每 token 多少字符。 */
const CHARS_PER_TOKEN = 3.5;

/**
 * 估算一段文本的 token 数。
 *
 * @param {string} text - 输入文本。
 * @returns {number} 估算 token 数（整数）。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / CHARS_PER_TOKEN);
}

/** 工具 schema → 参与上下文计费的文本（名字 + 描述 + 参数 schema）。 */
export function schemaText(schema) {
  const name = typeof schema?.name === 'string' ? schema.name : '';
  const description = typeof schema.description === 'string' ? schema.description : '';
  let parameters = '';
  if (schema?.parameters !== undefined) {
    try {
      parameters = JSON.stringify(schema.parameters) ?? '';
    } catch {
      parameters = '';
    }
  }
  return { name, description, parameters, text: `${name}${description}${parameters}` };
}

/**
 * 生成 token 账本。
 *
 * @param {object} input
 * @param {object[]} input.schemas - 全局工具 schema 列表（`ctx.tools.schemas()`）。
 * @param {Iterable<string>} [input.serverNames] - 已知服务名（用于切分 `mcp__<server>__<tool>`）。
 * @param {string} [input.only] - 只看某个服务（服务名）。
 * @param {number} [input.limitTools] - 返回多少个「最贵工具」（默认 10，上限 50）。
 * @returns {object} 账本。
 */
export function buildTokenReport(input = {}) {
  const schemas = Array.isArray(input.schemas) ? input.schemas : [];
  const known = input.serverNames !== undefined ? [...input.serverNames] : [];
  const knownSet = new Set(known);
  const only = typeof input.only === 'string' && input.only !== '' ? input.only : undefined;
  const limitTools = Number.isFinite(input.limitTools)
    ? Math.min(Math.max(Math.trunc(input.limitTools), 1), 50)
    : 10;

  const perServer = new Map();
  const allTools = [];
  let totalChars = 0;

  for (const schema of schemas) {
    const name = schema?.name;
    if (typeof name !== 'string' || !name.startsWith('mcp__')) continue;
    const serverName = serverNameOfTool(name, knownSet);
    if (only !== undefined && serverName !== only) continue;
    const payload = schemaText(schema);
    const chars = payload.text.length;
    const tokens = estimateTokens(payload.text);
    const prefixLength = `mcp__${serverName}__`.length;
    const toolName = name.slice(prefixLength);
    totalChars += chars;

    const bucket = perServer.get(serverName) ?? { serverName, toolCount: 0, chars: 0, tokens: 0, described: 0 };
    bucket.toolCount += 1;
    bucket.chars += chars;
    bucket.tokens += tokens;
    if (payload.description !== '') bucket.described += 1;
    perServer.set(serverName, bucket);

    allTools.push({
      serverName,
      toolName,
      publicName: name,
      chars,
      tokens,
      descriptionChars: payload.description.length,
      schemaChars: payload.parameters.length,
    });
  }

  const totalTokens = [...perServer.values()].reduce((sum, bucket) => sum + bucket.tokens, 0);
  const servers = [...perServer.values()]
    .map((bucket) => ({
      ...bucket,
      avgTokens: bucket.toolCount === 0 ? 0 : Math.round(bucket.tokens / bucket.toolCount),
      share: totalTokens === 0 ? 0 : bucket.tokens / totalTokens,
    }))
    .sort((left, right) => right.tokens - left.tokens || left.serverName.localeCompare(right.serverName));

  allTools.sort((left, right) => right.tokens - left.tokens || left.serverName.localeCompare(right.serverName));

  return {
    generatedAt: new Date().toISOString(),
    estimator: { cjkPerToken: 1, otherCharsPerToken: CHARS_PER_TOKEN, note: '启发式估算（±20%），只用于横向比较' },
    serverCount: servers.length,
    toolCount: allTools.length,
    totalTokens,
    totalChars,
    avgTokensPerTool: allTools.length === 0 ? 0 : Math.round(totalTokens / allTools.length),
    servers,
    topTools: allTools.slice(0, limitTools),
    ...(only !== undefined ? { only } : {}),
  };
}

/** 人类可读的数量级（1.2k / 34.5k / 1.2M），只用于展示。 */
export function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number < 1000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}
