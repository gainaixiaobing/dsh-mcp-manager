/**
 * 统一脱敏出口：凡是可能出现在 UI / 对话 / 日志里的外部文本，先过这里。
 *
 * 覆盖：Bearer token、JWT、URL userinfo、query 里的凭据参数、`KEY=value` /
 * `KEY: value` 形式的凭据赋值、以及 sk-/ghp_ 等常见 token 前缀。
 * 目标是「不泄露」，因此宁可多遮一点；原始值不保留任何副本。
 */
const MAX_LENGTH = 800;

const RULES = [
  // Authorization: Bearer xxx / bearer xxx
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***'],
  // JWT（header.payload.signature）
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '***JWT***'],
  // 常见 token 前缀
  [/\b(sk|pk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|AKIA)[-_][A-Za-z0-9_-]{10,}\b/g, '***TOKEN***'],
  // URL 里的 userinfo：https://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@'],
  // query / fragment 里的凭据参数
  [/([?&#](?:token|access_token|refresh_token|id_token|key|api_key|apikey|secret|client_secret|password|passwd|sig|signature|code)=)[^&#\s"']+/gi, '$1***'],
  // x-api-key / api-key 这类带连字符的凭据头
  [/\b(x-api-key|api-key)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=***'],
  // KEY=value / KEY: value（key 名像凭据）
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1$2***'],
];

/**
 * 脱敏一段文本并按需截断。
 *
 * @param {unknown} text - 任意文本（非字符串会被 String 化）。
 * @param {number} [limit] - 最大长度，默认 800。
 * @returns {string} 脱敏后的文本。
 */
export function sanitizeText(text, limit = MAX_LENGTH) {
  let value = typeof text === 'string' ? text : String(text ?? '');
  if (value === '') return '';
  for (const [pattern, replacement] of RULES) value = value.replace(pattern, replacement);
  if (value.length > limit) value = `${value.slice(0, limit - 1)}…`;
  return value;
}

/**
 * 脱敏一个 URL：去掉 query 里像凭据的参数、userinfo，仅保留可展示的最小信息。
 *
 * @param {unknown} raw - URL 字符串。
 * @param {object} [options]
 * @param {boolean} [options.keepPath] - 是否保留 pathname（默认 true）。
 * @returns {string|undefined} 脱敏后的 URL；无法解析时返回提示文本。
 */
export function sanitizeUrl(raw, options = {}) {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      url.username = '***';
      url.password = '***';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|passwd|sig|signature|code|auth)/i.test(key)) url.searchParams.set(key, '***');
    }
    if (options.keepPath === false) return `${url.protocol}//${url.host}`;
    const search = url.search === '' ? '' : url.search;
    return `${url.protocol}//${url.host}${url.pathname}${search}`;
  } catch {
    return '(无法解析的 URL)';
  }
}

/** 对一个对象里所有字符串值做浅层脱敏（用于日志/诊断字段）。 */
export function sanitizeRecordValues(value, depth = 0) {
  if (depth > 3) return '[嵌套过深]';
  if (typeof value === 'string') return sanitizeText(value, 300);
  if (Array.isArray(value)) return value.map((item) => sanitizeRecordValues(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeRecordValues(item, depth + 1);
    return out;
  }
  return value;
}
