/**
 * `!!js` 表达式的窄口径求值。
 *
 * profile 的 `cordis.patch.yml` 允许 `url: !!js process.env.AMAP_MCP_URL`、
 * `headers.Authorization: !!js process.env.QCC_AUTH_HEADER`。loader 交给插件的是
 * `{ __jsExpr: '…' }` 对象，`dsh-mcp-client` 在自己 apply 时会求值，但 `entry.fiber.config`
 * 里仍是表达式对象。
 *
 * 探针如果直接把对象塞进 `fetch` / `spawn`，就会得到
 * `Failed to parse URL from [object Object]` 或 401（凭据头变成 `[object Object]`）——
 * 看起来像"服务坏了"，其实是探针没求值。这里只支持几种确定安全的形态，
 * 其余一律报「无法求值」，绝不 `eval`。
 *
 * 支持：
 *   - `process.env.NAME`
 *   - `process.env.NAME ?? 'default'` / `|| 'default'`
 *   - `String(process.env.NAME)`
 *   - 字符串字面量 `'x'` / `"x"` / 反引号（无插值）
 */
import { isJsExpr, isPlainObject } from './util.js';

const ENV_ONLY = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/;
const ENV_WITH_DEFAULT = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\?|\|\|)\s*(['"])(.*?)\2$/;
const ENV_STRING = /^String\(\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\)$/;
const LITERAL = /^(['"])([\s\S]*)\1$/;
const TEMPLATE_LITERAL = /^`([^`$]*)`$/;

/**
 * 求值一个 `!!js` 表达式。
 *
 * @param {unknown} value - 字符串或 `{ __jsExpr }`。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - 变量来源（默认 process.env，便于测试注入）。
 * @returns {{ resolved: boolean, value?: string, expression?: string }}
 */
export function resolveExpression(value, options = {}) {
  const env = isPlainObject(options.env) ? options.env : process.env;
  if (typeof value === 'string') return { resolved: true, value };
  if (!isJsExpr(value)) return { resolved: false };
  const expression = String(value.__jsExpr ?? '').trim();
  const envOnly = ENV_ONLY.exec(expression);
  if (envOnly !== null) {
    const resolved = env[envOnly[1]];
    return typeof resolved === 'string' ? { resolved: true, value: resolved } : { resolved: false, expression };
  }
  const withDefault = ENV_WITH_DEFAULT.exec(expression);
  if (withDefault !== null) {
    const resolved = env[withDefault[1]];
    return typeof resolved === 'string' && resolved !== ''
      ? { resolved: true, value: resolved }
      : { resolved: true, value: withDefault[3] };
  }
  const stringOf = ENV_STRING.exec(expression);
  if (stringOf !== null) {
    const resolved = env[stringOf[1]];
    return typeof resolved === 'string' ? { resolved: true, value: resolved } : { resolved: false, expression };
  }
  const literal = LITERAL.exec(expression);
  if (literal !== null) return { resolved: true, value: literal[2] };
  const template = TEMPLATE_LITERAL.exec(expression);
  if (template !== null) return { resolved: true, value: template[1] };
  return { resolved: false, expression };
}

function resolveField(value, path, unresolved, env) {
  const result = resolveExpression(value, { env });
  if (result.resolved) return result.value;
  unresolved.push({ path, expression: result.expression ?? String(value) });
  return undefined;
}

/**
 * 把一条记录里的 `!!js` 摊平，得到可直接交给探针的配置。
 *
 * @param {object} record - 原始/生效配置（可含 `{ __jsExpr }`）。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - 变量来源。
 * @returns {{ record: object, unresolved: Array<{path: string, expression: string}> }}
 */
export function resolveRecordExpressions(record, options = {}) {
  const env = isPlainObject(options.env) ? options.env : process.env;
  const unresolved = [];
  if (!isPlainObject(record)) return { record: {}, unresolved };
  const out = { ...record };

  if (record.url !== undefined) {
    const url = resolveField(record.url, 'url', unresolved, env);
    if (url === undefined) delete out.url;
    else out.url = url;
  }
  if (record.command !== undefined) {
    const command = resolveField(record.command, 'command', unresolved, env);
    if (command === undefined) delete out.command;
    else out.command = command;
  }
  if (record.cwd !== undefined) {
    const cwd = resolveField(record.cwd, 'cwd', unresolved, env);
    if (cwd === undefined) delete out.cwd;
    else out.cwd = cwd;
  }
  if (Array.isArray(record.args)) {
    const args = [];
    record.args.forEach((value, index) => {
      const resolved = resolveField(value, `args[${index}]`, unresolved, env);
      if (resolved !== undefined) args.push(resolved);
    });
    out.args = args;
  }
  for (const field of ['headers', 'env']) {
    if (!isPlainObject(record[field])) continue;
    const mapped = {};
    for (const [key, value] of Object.entries(record[field])) {
      const resolved = resolveField(value, `${field}.${key}`, unresolved, env);
      if (resolved !== undefined) mapped[key] = resolved;
    }
    out[field] = mapped;
  }
  return { record: out, unresolved };
}
