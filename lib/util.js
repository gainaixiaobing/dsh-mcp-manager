/**
 * 通用工具：对象判断、脱敏、YAML 序列化、错误类型。
 * 本文件与其余 lib/* 一样只用 node 内建模块，保持插件零 npm 依赖。
 */
import { basename } from 'node:path';
import { sanitizeText, sanitizeUrl } from './sanitize.js';

export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
export const SENSITIVE_KEY = /(authorization|proxy-authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|credential|private[-_]?key)/i;
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const TOOL_DESC_LIMIT = 400;

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isJsExpr(value) {
  return Boolean(value) && typeof value === 'object' && '__jsExpr' in value;
}

export function truncate(text, limit = TOOL_DESC_LIMIT) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function slug(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/** 脱敏 URL：隐藏 userinfo，query 里的凭据参数替换为 ***。 */
export function redactUrl(raw) {
  return sanitizeUrl(raw, { keepPath: true });
}

/** stdio 命令只展示可执行文件名与参数个数，不展开参数（参数里常含 token）。 */
export function describeCommand(command, args) {
  if (typeof command !== 'string') return undefined;
  const base = command.split(/[\\/]/).pop() || command;
  const count = Array.isArray(args) ? args.length : 0;
  return count > 0 ? `${base}（+${count} 个参数）` : base;
}

export function endpointOf(config) {
  if (!isPlainObject(config)) return '';
  if (config.transport === 'streamable-http' || config.transport === 'http') {
    if (isJsExpr(config.url)) return '运行时 URL 表达式';
    return redactUrl(config.url) ?? '';
  }
  if (config.transport === 'stdio') {
    if (isJsExpr(config.command)) return '运行时命令表达式';
    return describeCommand(config.command, config.args) ?? '';
  }
  return '';
}

/** 判断某个字段名是否像凭据。 */
export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

/** 判断一个字符串是否「看起来就是凭据」（按值形状补漏，而不只按 key 名）。 */
export function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 16 || /\s/.test(text)) return false;
  if (text.includes('://') || text.startsWith('${')) return false;
  if (/^(sk-|pk-|ghp_|gho_|ghu_|ghs_|xox[bp]-|AKIA|eyJ)/.test(text)) return true;
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(text);
}

/**
 * 把敏感字段的值替换成 !!js process.env.<占位符>（用于导出配置）。
 *
 * 命中条件：key 名像凭据，或值本身看起来就是凭据（`looksLikeSecret`）。
 */
export function redactSecrets(target, path, envPrefix, warnings) {
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (isSensitiveKey(key) || looksLikeSecret(value)) {
      const envName = `${envPrefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      target[key] = { __jsExpr: `process.env.${envName}` };
      warnings.push(`${path}.${key} 已脱敏为 !!js process.env.${envName}，请替换为真实凭据来源。`);
    } else if (isPlainObject(value)) {
      redactSecrets(value, `${path}.${key}`, envPrefix, warnings);
    }
  }
}

// ── YAML（只覆盖插件需要的最小子集）────────────────────────────────────────

/** YAML 保留词：不能当裸字符串。 */
const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;

/** 判断字符串能否安全地作为 plain scalar 输出（不加引号）。 */
function yamlPlainSafe(text) {
  if (text === '' || /[\n\r]/.test(text)) return false;
  if (YAML_RESERVED.test(text)) return false;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(text)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return false; // 保持字符串类型
  if (/:\s|\s#/.test(text)) return false;
  if (/\s$/.test(text)) return false;
  return /^[A-Za-z0-9_./@+][A-Za-z0-9_./@+: -]*$/.test(text);
}

/** 单引号转义。 */
function yamlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** map 的 key：非法/保留字符一律加引号。 */
function yamlKey(key) {
  const text = String(key);
  if (yamlPlainSafe(text) && !text.startsWith('-')) return text;
  return yamlQuote(text);
}

function yamlScalar(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : yamlQuote(String(value));
  if (typeof value === 'boolean') return String(value);
  const text = String(value);
  return yamlPlainSafe(text) ? text : yamlQuote(text);
}

/** 多行字符串用块标量（|- 保留换行、去掉末尾换行），避免折叠改值。 */
function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent);
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return ` |-\n${lines.map((line) => `${pad}${line}`).join('\n')}`;
}

function yamlScalarOrBlock(value, blockIndent) {
  const text = String(value);
  if (/[\n\r]/.test(text)) return yamlBlock(text, blockIndent);
  return ` ${yamlScalar(value)}`;
}

export function yamlize(value, indent) {
  const pad = ' '.repeat(indent);
  if (isJsExpr(value)) return ` !!js ${value.__jsExpr}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []';
    return `\n${value
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item) || isJsExpr(item)) {
          return `${pad}-${yamlize(item, indent + 2)}`;
        }
        if (typeof item === 'string' && /[\n\r]/.test(item)) return `${pad}-${yamlBlock(item, indent + 2)}`;
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
        if (isPlainObject(child) || Array.isArray(child) || isJsExpr(child)) {
          return `${pad}${yamlKey(key)}:${yamlize(child, indent + 2)}`;
        }
        if (typeof child === 'string' && /[\n\r]/.test(child)) {
          return `${pad}${yamlKey(key)}:${yamlBlock(child, indent + 2)}`;
        }
        return `${pad}${yamlKey(key)}: ${yamlScalar(child)}`;
      })
      .join('\n')}`;
  }
  return ` ${yamlScalar(value)}`;
}

// ── 错误类型 ────────────────────────────────────────────────────────────────

/**
 * 带稳定错误码的管理错误：工具层根据 code 决定文案与建议动作。
 */
export class ManagerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ManagerError';
    this.code = code;
    this.detail = detail;
  }
}

/** 把任意异常收敛成可展示文本（统一过脱敏出口）。 */
export function errorText(error) {
  if (error instanceof Error) return sanitizeText(error.message ?? error, 500);
  return sanitizeText(error, 500);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { basename };
