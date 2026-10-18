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

/** 把敏感字段的值替换成 !!js process.env.<占位符>（用于导出配置）。 */
export function redactSecrets(target, path, envPrefix, warnings) {
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (isSensitiveKey(key)) {
      const envName = `${envPrefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      target[key] = { __jsExpr: `process.env.${envName}` };
      warnings.push(`${path}.${key} 已脱敏为 !!js process.env.${envName}，请替换为真实凭据来源。`);
    } else if (isPlainObject(value)) {
      redactSecrets(value, `${path}.${key}`, envPrefix, warnings);
    }
  }
}

// ── YAML（只覆盖插件需要的最小子集）────────────────────────────────────────

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text) && !/^(true|false|null|yes|no)$/i.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
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
