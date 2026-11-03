/**
 * 应用归类：把 MCP 服务按「应用 / 产品」归组（高德地图、同花顺、企查查…）。
 *
 * 一个应用可以有多个 MCP 服务（例如同花顺的 a-share / fund / meta，企查查的 company / risk / ipr…），
 * 面板按应用聚合成一张卡片，比按 serverName 平铺更好认。
 *
 * 匹配优先级（先命中先用）：
 *   1. `prefs.servers[serverName].app` —— 用户手动改名/归类；
 *   2. 内置目录 `APP_CATALOG` —— 按 serverName / 前缀 / URL host / stdio 包名；
 *   3. URL 域名 —— 取可注册域名当应用名（如 `example.com`）；
 *   4. serverName 公共前缀 —— 多个服务共享 `xxx-` 前缀时归为一组；
 *   5. 独立服务 —— 自成一组（`singleton: true`，UI 可平铺显示）。
 *
 * 本模块只做纯计算，不读文件、不发请求。
 */

/** 已知应用目录（可继续补充；只用于归类展示，不影响连接配置）。 */
export const APP_CATALOG = Object.freeze([
  {
    id: 'amap',
    name: '高德地图',
    icon: '🗺️',
    vendor: '高德',
    serverNames: ['amap', 'gaode'],
    prefixes: ['amap-', 'gaode-'],
    hosts: ['amap.com'],
  },
  {
    id: 'fuyao',
    name: '同花顺',
    icon: '📈',
    vendor: '同花顺',
    serverNames: ['fuyao', 'ths', '10jqka'],
    prefixes: ['fuyao-', 'ths-'],
    hosts: ['fuyao.aicubes.cn', 'aicubes.cn', '10jqka.com.cn'],
    note: '同花顺行情/基金数据（THS）',
  },
  {
    id: 'qcc',
    name: '企查查',
    icon: '🏢',
    vendor: '企查查',
    serverNames: ['qcc'],
    prefixes: ['qcc-'],
    hosts: ['qcc.com'],
  },
  {
    id: 'pkulaw',
    name: '北大法宝',
    icon: '⚖️',
    vendor: '北大法宝',
    serverNames: ['pkulaw'],
    prefixes: ['pkulaw-'],
    hosts: ['pkulaw.com'],
  },
  {
    id: 'zhihu',
    name: '知乎',
    icon: '💬',
    vendor: '知乎',
    serverNames: ['zhihu'],
    prefixes: ['zhihu-'],
    hosts: ['zhihu.com'],
  },
  {
    id: 'feishu',
    name: '飞书',
    icon: '🐦',
    vendor: '飞书',
    serverNames: ['feishu', 'lark'],
    prefixes: ['feishu-', 'lark-'],
    hosts: ['feishu.cn', 'feishu.net', 'larksuite.com'],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    vendor: 'GitHub',
    serverNames: ['github'],
    prefixes: ['github-'],
    hosts: ['github.com'],
    packages: ['server-github', 'github-mcp'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🐋',
    vendor: 'DeepSeek',
    serverNames: ['deepseek'],
    prefixes: ['deepseek-'],
    hosts: ['deepseek.com'],
  },
  {
    id: 'filesystem',
    name: '本地文件',
    icon: '📁',
    vendor: 'Model Context Protocol',
    serverNames: ['filesystem'],
    prefixes: ['filesystem-'],
    packages: ['server-filesystem'],
  },
  {
    id: 'fetch',
    name: '网页抓取',
    icon: '🌐',
    vendor: 'Model Context Protocol',
    serverNames: ['fetch'],
    prefixes: ['fetch-'],
    packages: ['server-fetch'],
  },
  {
    id: 'memory',
    name: '记忆',
    icon: '🧠',
    vendor: 'Model Context Protocol',
    serverNames: ['memory'],
    prefixes: ['memory-'],
    packages: ['server-memory'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    icon: '🎭',
    vendor: 'Microsoft',
    serverNames: ['playwright'],
    prefixes: ['playwright-'],
    packages: ['server-playwright', 'playwright-mcp'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    icon: '🗄️',
    serverNames: ['sqlite'],
    prefixes: ['sqlite-'],
    packages: ['server-sqlite'],
  },
]);

/** 常见的二级公共后缀：取可注册域名时要多保留一段。 */
const SECOND_LEVEL_SUFFIXES = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'co.jp', 'com.hk', 'com.tw'];

/** 常见主机前缀，识别应用名时应剥掉。 */
const HOST_PREFIXES = ['www', 'api', 'mcp', 'mcps', 'agent', 'app', 'gateway', 'apim'];

/** 解析 URL 的 hostname（容错，失败返回 undefined）。 */
export function hostnameOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

/**
 * 取可注册域名（如 `mcp.amap.com` → `amap.com`，`a.b.com.cn` → `b.com.cn`）。
 *
 * @param {string} [host] - hostname。
 * @returns {string|undefined} 可注册域名。
 */
export function registrableDomain(host) {
  if (typeof host !== 'string' || host === '') return undefined;
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length === 0) return undefined;
  if (!Number.isNaN(Number(labels[labels.length - 1]))) return host; // IP
  let keep = 2;
  const tail2 = labels.slice(-2).join('.');
  if (SECOND_LEVEL_SUFFIXES.includes(tail2)) keep = 3;
  return labels.slice(-keep).join('.');
}

/** 从服务配置里取 URL（用于目录匹配）。 */
function urlOf(config, endpoint) {
  if (typeof config?.url === 'string') return config.url;
  if (typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint)) return endpoint;
  return undefined;
}

/** stdio 命令 + 参数拼成的可匹配文本（用于识别 npx 包名）。 */
function packageTextOf(config) {
  if (!config || config.transport !== 'stdio') return '';
  const parts = [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter((item) => typeof item === 'string');
  return parts.join(' ').toLowerCase();
}

/** 在目录里按 name / 前缀 / host / 包名匹配。 */
function catalogMatch({ serverName, host, packageText }) {
  const lowerName = String(serverName ?? '').toLowerCase();
  const domain = registrableDomain(host);
  for (const app of APP_CATALOG) {
    if (Array.isArray(app.serverNames) && app.serverNames.some((name) => lowerName === name.toLowerCase())) return app;
    if (Array.isArray(app.prefixes) && app.prefixes.some((prefix) => lowerName.startsWith(prefix.toLowerCase()))) return app;
    if (host !== undefined && Array.isArray(app.hosts)) {
      if (app.hosts.some((suffix) => host === suffix.toLowerCase() || host.endsWith(`.${suffix.toLowerCase()}`))) return app;
      if (domain !== undefined && app.hosts.some((suffix) => domain === suffix.toLowerCase())) return app;
    }
    if (packageText !== '' && Array.isArray(app.packages) && app.packages.some((pkg) => packageText.includes(pkg))) return app;
  }
  return undefined;
}

/** 目录里按应用名反查（用于把用户手填的名字并到已知应用）。 */
function catalogByName(name) {
  const lower = String(name ?? '').trim().toLowerCase();
  if (lower === '') return undefined;
  return APP_CATALOG.find((app) => app.name.toLowerCase() === lower || app.id === lower);
}

/** 简易 slug（应用 id 用）。 */
function slugApp(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

/**
 * 判断一组 serverName 的公共前缀（`fuyao-a-share` / `fuyao-fund` → `fuyao`）。
 *
 * @param {string} serverName - 当前服务名。
 * @param {Iterable<string>} siblings - 全部服务名。
 * @returns {string|undefined} 至少两个服务共享的前缀。
 */
function sharedPrefix(serverName, siblings) {
  const name = String(serverName ?? '');
  const match = /^([A-Za-z0-9]+)[-_]/.exec(name);
  if (match === null) return undefined;
  const prefix = match[1].toLowerCase();
  let count = 0;
  for (const sibling of siblings) {
    const other = String(sibling ?? '').toLowerCase();
    if (other === prefix || other.startsWith(`${prefix}-`) || other.startsWith(`${prefix}_`)) count += 1;
  }
  return count >= 2 ? prefix : undefined;
}

/**
 * 推断一个服务所属的应用。
 *
 * @param {object} input
 * @param {string} input.serverName - 服务名。
 * @param {string} [input.endpoint] - 已脱敏端点（用于 URL host 匹配）。
 * @param {object} [input.config] - 生效/原始配置（取 url / command / args）。
 * @param {string} [input.manual] - 用户手动指定的应用名（优先）。
 * @param {Iterable<string>} [input.siblings] - 全部服务名（用于公共前缀）。
 * @returns {{id: string, name: string, icon?: string, vendor?: string, source: 'manual'|'catalog'|'host'|'prefix'|'self', singleton?: boolean}} 应用描述。
 */
export function detectApp(input = {}) {
  const serverName = String(input.serverName ?? '').trim() || 'unknown';
  const manual = typeof input.manual === 'string' ? input.manual.trim() : '';
  if (manual !== '') {
    const known = catalogByName(manual);
    if (known !== undefined) {
      return { id: known.id, name: known.name, ...(known.icon ? { icon: known.icon } : {}), ...(known.vendor ? { vendor: known.vendor } : {}), source: 'manual' };
    }
    return { id: `manual:${slugApp(manual)}`, name: manual, icon: '🏷️', source: 'manual' };
  }

  const host = hostnameOf(urlOf(input.config, input.endpoint));
  const packageText = packageTextOf(input.config);
  const known = catalogMatch({ serverName, host, packageText });
  if (known !== undefined) {
    return { id: known.id, name: known.name, ...(known.icon ? { icon: known.icon } : {}), ...(known.vendor ? { vendor: known.vendor } : {}), source: 'catalog' };
  }

  const domain = registrableDomain(host);
  if (domain !== undefined) {
    return { id: `host:${domain}`, name: domain, icon: '🧩', source: 'host' };
  }

  const siblings = input.siblings instanceof Set || Array.isArray(input.siblings) ? input.siblings : [];
  const prefix = sharedPrefix(serverName, siblings);
  if (prefix !== undefined) {
    return { id: `prefix:${prefix}`, name: prefix, icon: '🧩', source: 'prefix' };
  }

  return { id: `server:${serverName}`, name: serverName, icon: '🧩', source: 'self', singleton: true };
}

/**
 * 把服务列表按应用聚合。
 *
 * @param {object[]} servers - inventory 服务列表（每个需带 `app`）。
 * @returns {object[]} 应用列表（按「服务数降序、名称升序」排序）。
 */
export function groupServersByApp(servers) {
  const groups = new Map();
  for (const server of Array.isArray(servers) ? servers : []) {
    const app = server?.app;
    if (app === undefined) continue;
    const group = groups.get(app.id) ?? {
      id: app.id,
      name: app.name,
      ...(app.icon ? { icon: app.icon } : {}),
      ...(app.vendor ? { vendor: app.vendor } : {}),
      source: app.source,
      singleton: true,
      serverIds: [],
      serverNames: [],
      total: 0,
      connected: 0,
      failed: 0,
      disabled: 0,
      noTools: 0,
      notProvisioned: 0,
      toolCount: 0,
      pinnedCount: 0,
      duplicateCount: 0,
    };
    group.serverIds.push(server.id);
    group.serverNames.push(server.serverName);
    group.total += 1;
    group.singleton = group.total <= 1;
    if (server.status === 'connected') group.connected += 1;
    else if (server.status === 'failed') group.failed += 1;
    else if (server.status === 'disabled') group.disabled += 1;
    else if (server.status === 'no-tools') group.noTools += 1;
    else if (server.status === 'not-provisioned') group.notProvisioned += 1;
    if (Number.isFinite(server.toolCount)) group.toolCount += server.toolCount;
    if (server.pinned === true) group.pinnedCount += 1;
    if (server.duplicate === true) group.duplicateCount += 1;
    groups.set(app.id, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
}
