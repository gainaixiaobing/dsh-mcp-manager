/**
 * 接入片段（snippet）：把一条/多条 MCP 连接导出成「别的客户端可以直接用」的形式。
 *
 * 借鉴 `pathintegral-institute/mcpm.sh` 的 client integration（mcpm client add）、
 * `folay-git/mcp-dock` 的多客户端配置生成，以及 `microsoft/vscode` 的 `mcp.json` 约定：
 * 同一个服务，往往要同时进 Claude Code、Cursor、VS Code、Codex 和 DSH。
 * 与其让用户手抄，不如生成可直接粘贴/执行的片段。
 *
 * 支持的目标：
 *   - `dsh-patch`：DSH profile 的 cordis.patch.yml 片段（与 export 的 patch 同源）；
 *   - `cursor`：Cursor / Claude Desktop 的 `mcpServers` JSON；
 *   - `vscode`：VS Code `.vscode/mcp.json`（`servers` + `inputs`）；
 *   - `claude-code`：`claude mcp add …` 命令行；
 *   - `codex`：`~/.config/codex/config.toml` 的 `[mcp_servers.*]`。
 *
 * 脱敏复用 export.js 的同一套规则（URL query、args flag、凭据型 header/env），
 * 保证「导出的片段」和「导出的文件」不会一个泄露一个不泄露。
 */
import { exportMcpServersJson, exportPatchYaml } from './export.js';
import { ManagerError } from './util.js';

export const SNIPPET_TARGETS = ['dsh-patch', 'cursor', 'vscode', 'claude-code', 'codex'];

const TARGET_LABEL = {
  'dsh-patch': 'DSH cordis.patch.yml',
  cursor: 'Cursor / Claude Desktop（mcpServers JSON）',
  vscode: 'VS Code（.vscode/mcp.json）',
  'claude-code': 'Claude Code（claude mcp add）',
  codex: 'Codex（config.toml）',
};

/** 片段里出现的目标说明（工具输出与 UI 共用）。 */
export function snippetTargetLabel(target) {
  return TARGET_LABEL[target] ?? target;
}

/** shell 参数安全引用：只在必要时加单引号。 */
function shellArg(value) {
  const text = String(value);
  if (text === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** JSON 字符串字面量（TOML basic string 与它兼容）。 */
function quote(value, style = 'double') {
  const json = JSON.stringify(String(value));
  if (style === 'double') return json;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 把 `mcpServers` 条目转成 VS Code 的 `servers` 条目。 */
function toVsCodeEntry(entry) {
  if (entry.url !== undefined) {
    return {
      type: 'http',
      url: entry.url,
      ...(entry.headers !== undefined ? { headers: { ...entry.headers } } : {}),
    };
  }
  return {
    type: 'stdio',
    command: entry.command,
    ...(entry.args !== undefined ? { args: [...entry.args] } : {}),
    ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
  };
}

/** 生成 Claude Code CLI 的 `claude mcp add` 行。 */
function toClaudeCode(servers) {
  const lines = [
    '# Claude Code：逐条执行（--scope user 写入用户级配置，可改成 --scope project）',
  ];
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.url !== undefined) {
      const parts = ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', shellArg(name), shellArg(entry.url)];
      for (const [key, value] of Object.entries(entry.headers ?? {})) {
        parts.push('--header', shellArg(`${key}: ${value}`));
      }
      lines.push(parts.join(' '));
      continue;
    }
    const parts = ['claude', 'mcp', 'add', '--scope', 'user', shellArg(name)];
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      parts.push('-e', shellArg(`${key}=${value}`));
    }
    parts.push('--', shellArg(entry.command), ...(entry.args ?? []).map((arg) => shellArg(arg)));
    if (entry.cwd !== undefined) lines.push(`# ${name}: 需要 cwd=${entry.cwd}，请先 cd 到该目录`);
    lines.push(parts.join(' '));
  }
  lines.push('', '# 校验：claude mcp list');
  return `${lines.join('\n')}\n`;
}

/** 生成 Codex 的 config.toml 片段。 */
function toCodex(servers) {
  const blocks = ['# Codex：合并进 ~/.config/codex/config.toml（或 $CODEX_HOME/config.toml）'];
  for (const [name, entry] of Object.entries(servers)) {
    const header = `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : quote(name)}]`;
    const rows = [header];
    if (entry.url !== undefined) {
      rows.push(`url = ${quote(entry.url)}`);
      const headers = Object.entries(entry.headers ?? {});
      if (headers.length > 0) {
        rows.push(`http_headers = { ${headers.map(([key, value]) => `${quote(key)} = ${quote(value)}`).join(', ')} }`);
      }
    } else {
      rows.push(`command = ${quote(entry.command)}`);
      if (Array.isArray(entry.args) && entry.args.length > 0) {
        rows.push(`args = [${entry.args.map((arg) => quote(arg)).join(', ')}]`);
      }
      const env = Object.entries(entry.env ?? {});
      if (env.length > 0) {
        rows.push(`env = { ${env.map(([key, value]) => `${quote(key)} = ${quote(value)}`).join(', ')} }`);
      }
      if (entry.cwd !== undefined) rows.push(`cwd = ${quote(entry.cwd)}`);
    }
    blocks.push('', ...rows);
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * 生成接入片段。
 *
 * @param {object[]} records - `collectExportRecords().records`（`{ serverName, record, origin }`）。
 * @param {object} [options]
 * @param {string} [options.target] - `SNIPPET_TARGETS` 之一，默认 `dsh-patch`。
 * @param {boolean} [options.redact] - 是否脱敏（默认 true）。
 * @returns {{target:string, label:string, content:string, recordCount:number, warnings:string[]}} 片段。
 */
export function buildSnippet(records, options = {}) {
  const target = typeof options.target === 'string' && options.target !== '' ? options.target : 'dsh-patch';
  if (!SNIPPET_TARGETS.includes(target)) {
    throw new ManagerError('invalid-snippet-target', `不支持的目标 "${target}"（可用：${SNIPPET_TARGETS.join('、')}）`);
  }
  const redact = options.redact !== false;
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    throw new ManagerError('snippet-empty', '没有可生成片段的服务：请先接入至少一个 MCP 服务。');
  }

  if (target === 'dsh-patch') {
    const out = exportPatchYaml(list, { redact });
    return {
      target,
      label: TARGET_LABEL[target],
      content: out.yaml,
      recordCount: list.length,
      warnings: out.warnings,
    };
  }

  const json = exportMcpServersJson(list, { redact });
  const servers = json.data.mcpServers;
  let content;
  if (target === 'cursor') {
    content = json.json;
  } else if (target === 'vscode') {
    const out = { servers: {}, inputs: [] };
    for (const [name, entry] of Object.entries(servers)) out.servers[name] = toVsCodeEntry(entry);
    content = `${JSON.stringify(out, null, 2)}\n`;
  } else if (target === 'claude-code') {
    content = toClaudeCode(servers);
  } else {
    content = toCodex(servers);
  }
  return {
    target,
    label: TARGET_LABEL[target],
    content,
    recordCount: list.length,
    warnings: json.warnings,
  };
}
