/**
 * 导入器：发现并读取本机其它 MCP 客户端的配置，统一解析成 record。
 *
 * 覆盖常见客户端（都是公开、固定的配置路径，不存在路径猜测）：
 *   - Claude Desktop  `~/Library/Application Support/Claude/claude_desktop_config.json`
 *   - Claude Code     `~/.claude.json`
 *   - Cursor          `~/.cursor/mcp.json`
 *   - Windsurf        `~/.codeium/windsurf/mcp_config.json`
 *   - VS Code         `<appData>/Code/User/mcp.json`（`servers` 字段）
 *   - Cline 扩展      `<appData>/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
 *   - Zed             `~/.config/zed/settings.json`（`context_servers`）
 *   - Continue        `~/.continue/config.json`（`experimental.modelContextProtocolServers`）
 *
 * 安全约定：扫描结果只返回「元信息」（客户端/文件/服务名/传输/端点预览/是否含凭据），
 * 不回显 env/headers 的值；真正导入时由同一进程重新读取文件并规范化。
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, endpointOf, ManagerError, errorText } from './util.js';
import { fromMcpServersJson } from './config.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 宽松 JSON 解析：先按标准 JSON 解析，失败再尝试 JSONC（去掉行注释/块注释与尾逗号）。
 * Zed 的 settings.json 等配置文件是 JSONC，直接 JSON.parse 会失败。
 *
 * @param {string} text - 文件内容。
 * @returns {unknown} 解析结果。
 */
export function parseJsonRelaxed(text) {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const stripped = stripJsonc(text);
    try {
      return JSON.parse(stripped);
    } catch {
      throw strictError;
    }
  }
}

/** 去掉 JSONC 注释与尾逗号（字符串内的内容原样保留）。 */
export function stripJsonc(text) {
  let output = '';
  let index = 0;
  let inString = false;
  let quote = '';
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) inString = false;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  // 去掉对象/数组末尾多余的逗号
  return output.replace(/,(\s*[}\]])/g, '$1');
}

function appDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(homedir(), '.config');
}

/**
 * 已知客户端及其配置文件。`extract(json)` 返回 `{ [serverName]: rawEntry }`。
 */
export const KNOWN_CLIENTS = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    files: () => [join(appDataDir(), 'Claude', 'claude_desktop_config.json')],
    extract: (json) => (isPlainObject(json?.mcpServers) ? json.mcpServers : {}),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    files: () => [join(homedir(), '.claude.json')],
    extract: (json) => (isPlainObject(json?.mcpServers) ? json.mcpServers : {}),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    files: () => [join(homedir(), '.cursor', 'mcp.json')],
    extract: (json) => (isPlainObject(json?.mcpServers) ? json.mcpServers : {}),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    files: () => [join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')],
    extract: (json) => (isPlainObject(json?.mcpServers) ? json.mcpServers : {}),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    files: () => [
      join(appDataDir(), 'Code', 'User', 'mcp.json'),
      join(appDataDir(), 'Code - Insiders', 'User', 'mcp.json'),
    ],
    extract: (json) => (isPlainObject(json?.servers) ? json.servers : {}),
  },
  {
    id: 'cline',
    name: 'Cline (VS Code 扩展)',
    files: () => [
      join(appDataDir(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    ],
    extract: (json) => (isPlainObject(json?.mcpServers) ? json.mcpServers : {}),
  },
  {
    id: 'zed',
    name: 'Zed',
    files: () => [join(homedir(), '.config', 'zed', 'settings.json')],
    extract: (json) => (isPlainObject(json?.context_servers) ? json.context_servers : {}),
  },
  {
    id: 'continue',
    name: 'Continue',
    files: () => [join(homedir(), '.continue', 'config.json')],
    extract: (json) => {
      const list = json?.experimental?.modelContextProtocolServers;
      if (!Array.isArray(list)) return {};
      const out = {};
      for (const item of list) {
        const name = item?.name ?? item?.transport?.name;
        const transport = item?.transport ?? {};
        if (typeof name !== 'string') continue;
        out[name] = {
          ...transport,
          command: transport.command,
          args: transport.args,
          env: transport.env,
          url: transport.url ?? transport.serverUrl,
        };
      }
      return out;
    },
  },
];

/**
 * 解析一段 `mcpServers` 风格 JSON 文本。
 *
 * 接受：`{ mcpServers: {...} }`、`{ servers: {...} }`、`{ context_servers: {...} }`、
 * 直接的 `{ name: {command/url...} }` 映射、以及 `[{ name, ... }]` 数组。
 *
 * @param {string} text - JSON 文本。
 * @returns {Record<string, object>} serverName → 规范化 record。
 * @throws {ManagerError} JSON 或条目非法时抛出。
 */
export function parseMcpServersText(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new ManagerError('invalid-json', '导入内容为空');
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ManagerError('invalid-json', `不是合法 JSON：${errorText(error)}`);
  }
  let entries;
  if (Array.isArray(json)) {
    entries = {};
    for (const item of json) {
      const name = item?.name ?? item?.serverName;
      if (typeof name !== 'string' || name === '') throw new ManagerError('invalid-json', '数组形式的条目需要 name 字段');
      entries[name] = item;
    }
  } else if (isPlainObject(json?.mcpServers)) {
    entries = json.mcpServers;
  } else if (isPlainObject(json?.servers)) {
    entries = json.servers;
  } else if (isPlainObject(json?.context_servers)) {
    entries = json.context_servers;
  } else if (isPlainObject(json)) {
    entries = json;
  } else {
    throw new ManagerError('invalid-json', '无法识别的 mcpServers JSON 结构');
  }
  if (Object.keys(entries).length === 0) throw new ManagerError('invalid-json', 'JSON 里没有任何 MCP server 条目');

  const records = {};
  const errors = [];
  for (const [serverName, entry] of Object.entries(entries)) {
    try {
      records[serverName] = fromMcpServersJson(serverName, entry);
    } catch (error) {
      errors.push(`${serverName}: ${errorText(error)}`);
    }
  }
  return { records, errors };
}

/**
 * 扫描本机已知客户端的配置文件。
 *
 * @param {object} [options]
 * @param {string[]} [options.onlyClients] - 只扫描指定客户端 id。
 * @returns {Promise<{sources: object[], candidates: object[]}>}
 */
export async function scanImports(options = {}) {
  const only = options.onlyClients === undefined ? undefined : new Set(options.onlyClients);
  const sources = [];
  const candidates = [];
  for (const client of KNOWN_CLIENTS) {
    if (only !== undefined && !only.has(client.id)) continue;
    for (const file of client.files()) {
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) continue;
      try {
        const text = await readFile(file, 'utf8');
        const json = parseJsonRelaxed(text);
        const entries = client.extract(json);
        const serverNames = Object.keys(entries);
        if (serverNames.length === 0) continue;
        sources.push({
          client: client.id,
          clientName: client.name,
          file,
          serverCount: serverNames.length,
          size: info.size,
          mtimeMs: Math.trunc(info.mtimeMs),
          format: text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? 'json' : 'unknown',
        });
        for (const serverName of serverNames) {
          let description = { transport: 'unknown', endpoint: '', hasSecrets: false };
          try {
            const record = fromMcpServersJson(serverName, entries[serverName]);
            description = {
              transport: record.transport,
              endpoint: endpointOf(record),
              hasSecrets: record.headers !== undefined || record.env !== undefined,
            };
          } catch (error) {
            description = { transport: 'unsupported', endpoint: '', hasSecrets: false, error: errorText(error) };
          }
          candidates.push({
            client: client.id,
            clientName: client.name,
            file,
            serverName,
            ...description,
          });
        }
      } catch (error) {
        sources.push({ client: client.id, clientName: client.name, file, error: errorText(error) });
      }
    }
  }
  return { sources, candidates };
}

/**
 * 从扫描结果或一段 JSON 文本导入。
 *
 * @param {object} input
 * @param {string} [input.json] - 直接粘贴的 JSON 文本。
 * @param {string} [input.file] - 扫描结果里的文件路径。
 * @param {string} [input.client] - 客户端 id（配合 file 校验）。
 * @param {string[]} [input.servers] - 只导入这些 serverName（缺省=全部）。
 * @returns {Promise<{records: Record<string, object>, errors: string[], skipped: string[]}>}
 */
export async function readImportSource(input) {
  if (typeof input?.json === 'string' && input.json.trim() !== '') {
    return withSelection(parseMcpServersText(input.json), input.servers);
  }
  if (typeof input?.file === 'string' && input.file !== '') {
    let info;
    try {
      info = await stat(input.file);
    } catch (error) {
      throw new ManagerError('import-file-missing', `配置文件不存在：${input.file}（${errorText(error)}）`);
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new ManagerError('import-file-invalid', '配置文件不是普通文件或过大');
    const text = await readFile(input.file, 'utf8');
    let parsed;
    try {
      parsed = parseMcpServersText(text);
    } catch (strictError) {
      // 有些客户端写 JSONC；宽松解析一次再试
      const relaxed = stripJsonc(text);
      if (relaxed === text) throw strictError;
      parsed = parseMcpServersText(relaxed);
    }
    return withSelection(parsed, input.servers);
  }
  throw new ManagerError('import-source-missing', '请提供 json（粘贴内容）或 file（扫描结果里的文件路径）');
}

function withSelection(parsed, servers) {
  if (!Array.isArray(servers) || servers.length === 0) return { ...parsed, skipped: [] };
  const wanted = new Set(servers);
  const records = {};
  const skipped = [];
  for (const [serverName, record] of Object.entries(parsed.records)) {
    if (wanted.has(serverName)) records[serverName] = record;
    else skipped.push(serverName);
  }
  return { records, errors: parsed.errors, skipped };
}
