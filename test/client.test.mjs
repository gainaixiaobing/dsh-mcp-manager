/**
 * dsh-mcp-manager Web 半区离线测试（模拟浏览器模块加载器 + 最小 React Hooks 渲染器）。
 *
 * 覆盖：client 模块注册格式（id === 包名）、槽位注册、列表/状态/来源渲染、
 * 启停交互（按条目 id）、探针结果展示、筛选、新增表单与导入/导出面板、
 * v0.3 新增：token 请求头、工具中心搜索、工具抽屉 invoke、全部探测、
 * pinned 排序、同名条目按 id 操作、高级配置提交、掩码 URL 不回写。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// ─── 最小 React（createElement + 递归渲染 + 按路径持久化的 Hooks）────────────

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
  return { type, props: { ...(props ?? {}), children: flat.length > 1 ? flat : flat[0] } };
}

const hookStores = new Map();
let currentStore = null;
let scheduled = false;
let rootDraw = null;

function hookSlot(index) {
  if (!currentStore) throw new Error('hooks must run inside a component render');
  return (currentStore.hooks[index] ??= { value: undefined, deps: undefined });
}

const React = {
  createElement,
  useState(initial) {
    const index = currentStore.cursor++;
    const slot = hookSlot(index);
    if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial;
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        rootDraw?.();
      });
    }];
  },
  useRef(initial) {
    const index = currentStore.cursor++;
    const slot = hookSlot(index);
    if (slot.value === undefined) slot.value = { current: initial };
    return slot.value;
  },
  useCallback(fn, deps) {
    const index = currentStore.cursor++;
    const slot = hookSlot(index);
    const same = Array.isArray(slot.deps) && Array.isArray(deps)
      && slot.deps.length === deps.length && slot.deps.every((dep, i) => Object.is(dep, deps[i]));
    if (!same) {
      slot.value = fn;
      slot.deps = deps;
    }
    return slot.value;
  },
  useEffect(fn, deps) {
    const index = currentStore.cursor++;
    const slot = hookSlot(index);
    const same = Array.isArray(slot.deps) && Array.isArray(deps)
      && slot.deps.length === deps.length && slot.deps.every((dep, i) => Object.is(dep, deps[i]));
    if (same) return;
    slot.deps = deps;
    currentStore.effects.push(fn);
  },
};

/** 递归执行函数组件，返回"渲染后的元素树"（保留宿主标签及其 props）。 */
function renderNode(node, path) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) {
    return node.map((child, index) => {
      const key = child !== null && typeof child === 'object' && !Array.isArray(child) && child.props?.key !== undefined
        ? child.props.key
        : index;
      return renderNode(child, `${path}[${key}]`);
    });
  }
  if (typeof node === 'string' || typeof node === 'number') return node;
  const { type, props } = node;
  if (typeof type === 'function') {
    // 组件身份用「路径 + 组件名」区分，避免条件渲染导致兄弟索引变化时串用 hook 状态。
    const storeKey = `${path}/${type.name || 'component'}`;
    const store = hookStores.get(storeKey) ?? { hooks: [], cursor: 0, effects: [] };
    hookStores.set(storeKey, store);
    store.cursor = 0;
    store.effects = [];
    const previous = currentStore;
    currentStore = store;
    let output;
    try {
      output = type(props);
    } finally {
      currentStore = previous;
    }
    for (const effect of store.effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') store.cleanups = [...(store.cleanups ?? []), cleanup];
    }
    return renderNode(output, storeKey);
  }
  return { type, props: { ...props, children: renderNode(props?.children, `${path}#`) } };
}

function flatten(tree, out = []) {
  if (tree === null || tree === undefined || tree === false) return out;
  if (Array.isArray(tree)) {
    tree.forEach((item) => flatten(item, out));
    return out;
  }
  if (typeof tree === 'object') {
    out.push(tree);
    flatten(tree.props?.children, out);
  }
  return out;
}

function textOf(tree) {
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    walk(node?.props?.children);
  };
  walk(tree);
  return parts.join('');
}

function findNode(tree, predicate) {
  return flatten(tree).find(predicate);
}

function findAll(tree, predicate) {
  return flatten(tree).filter(predicate);
}

function buttonByText(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node) === label)[0];
}

// 禁止真实定时器（组件的自动刷新 interval），避免测试进程挂起
let intervals = 0;
globalThis.setInterval = () => ++intervals;
globalThis.clearInterval = () => {};

// ─── 假浏览器模块加载器 ──────────────────────────────────────────────────────

const loaded = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.set(id, factory);
    },
  },
};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });

// v0.4：视图模式记忆用 localStorage（Node 默认没有，这里补一个最小实现）
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => storage.clear(),
  },
  configurable: true,
  writable: true,
});

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
new Function('window', 'require', source)(globalThis.window, (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

const factory = loaded.get('dsh-mcp-manager');

// ─── 测试 ────────────────────────────────────────────────────────────────────

test('client module registers with id === package name', () => {
  assert.deepEqual([...loaded.keys()], ['dsh-mcp-manager']);
});

function makePlugin() {
  const registrations = [];
  const injections = [];
  const dictionaries = new Map();
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    locale: {
      register(namespace, dict) {
        dictionaries.set(namespace, dict);
        return () => {};
      },
      bind(namespace) {
        const dict = dictionaries.get(namespace)?.zh ?? {};
        return (key) => key.split('.').reduce((node, part) => node?.[part], dict) ?? key;
      },
    },
    slots: {
      inject(name, callback) {
        injections.push(name);
        return callback();
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
  };
  const plugin = factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  plugin.apply(ctx);
  return { plugin, ctx, registrations, injections, dictionaries };
}

function mountSection() {
  const env = makePlugin();
  hookStores.clear();
  storage.clear();
  const { Component } = env.registrations[0];
  const t = env.ctx.locale.bind('mcp-manager');
  const draw = () => {
    rootDraw = draw;
    return renderNode({ type: Component, props: { t } }, 'root');
  };
  return { ...env, draw };
}

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 模拟 host 的 state.apps 聚合（按 server.app 分组 + 健康计数）。 */
function appsFor(servers) {
  const groups = new Map();
  for (const server of servers) {
    const app = server.app ?? { id: `server:${server.serverName}`, name: server.serverName, source: 'self', singleton: true };
    const group = groups.get(app.id) ?? {
      id: app.id, name: app.name, ...(app.icon ? { icon: app.icon } : {}),
      ...(app.vendor ? { vendor: app.vendor } : {}), source: app.source, singleton: true,
      serverIds: [], serverNames: [], total: 0, connected: 0, failed: 0, disabled: 0,
      noTools: 0, notProvisioned: 0, toolCount: 0, pinnedCount: 0, duplicateCount: 0,
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
  return [...groups.values()].sort((left, right) => right.total - left.total || left.name.localeCompare(right.name));
}

function makeState(overrides = {}) {
  const servers = overrides.servers ?? [
    {
      id: 'include:mcp-alpha', shortId: 'mcp-alpha', origin: 'profile', serverName: 'alpha',
      transport: 'streamable-http', endpoint: 'https://a.example/mcp', enabled: true, loaded: true,
      status: 'connected', toolCount: 2, toolNames: ['echo', 'ping'], tools: [], duplicate: false,
      app: { id: 'amap', name: '高德地图', icon: '🗺️', vendor: '高德', source: 'catalog' },
    },
    {
      id: 'mcp-manager-beta', shortId: 'mcp-manager-beta', origin: 'managed', serverName: 'beta',
      transport: 'stdio', endpoint: 'node（+1 个参数）', enabled: false, loaded: false,
      status: 'disabled', toolCount: 0, toolNames: [], tools: [], duplicate: false,
      app: { id: 'server:beta', name: 'beta', source: 'self', singleton: true },
    },
  ];
  const summary = overrides.summary ?? {
    total: 2, uniqueServers: 2, duplicateServers: 0, enabled: 1, disabled: 1, connected: 1,
    failed: 0, notProvisioned: 0, managed: 1, toolCount: 2, orphanToolCount: 0,
  };
  return {
    ok: true,
    servers,
    apps: overrides.apps ?? appsFor(servers),
    summary,
    storePath: '/tmp/connections.json',
    prefsPath: '/tmp/prefs.json',
    prefs: { version: 1, updatedAt: 0, ui: { autoProbe: false }, servers: {} },
    provisionFailures: {},
    toolCount: 2,
    ...overrides,
  };
}

function mockFetch({ state = makeState(), action } = {}) {
  const posts = [];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init: init ?? {}, headers: init?.headers ?? {}, body: init?.body });
    if (url === '/mcp-manager/api/state') return { ok: true, json: async () => ({ ok: true, ...state }) };
    if (url === '/mcp-manager/api/action') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const result = action ? await action(body) : { ok: true };
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { posts, requests };
}

test('apply registers one settings.section entry with nav label and locale', () => {
  const { plugin, registrations, injections, dictionaries } = makePlugin();
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.deepEqual(injections, ['settings.section']);
  const [{ options }] = registrations;
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'mcp-manager');
  assert.equal(options.label(), 'MCP 服务');
  assert.ok(dictionaries.get('mcp-manager').zh.form.addTitle);
  assert.ok(dictionaries.get('mcp-manager').zh.tools.center);
});

test('renders the server table with source/status/tool counts and store path', async () => {
  mockFetch();
  const { draw } = mountSection();
  let tree = draw();
  assert.match(textOf(tree), /读取中/);
  await flush();
  tree = draw();
  const text = textOf(tree);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /已连接/);
  assert.match(text, /已停用/);
  assert.match(text, /profile/);
  assert.match(text, /受管/);
  assert.match(text, /2 个条目 · 唯一服务 2 个/);
  assert.match(text, /\/tmp\/connections\.json/);
  // v0.3：shortId 与偏好存储路径也要展示
  assert.match(text, /mcp-manager-beta/);
  assert.match(text, /\/tmp\/prefs\.json/);
});

test('toggling a server posts setEnabled with the entry id (not serverName)', async () => {
  const { posts } = mockFetch({ action: async () => ({ ok: true }) });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const switches = findAll(tree, (node) => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === '停用');
  assert.equal(switches.length, 1);
  switches[0].props.onClick();
  await flush();
  assert.deepEqual(posts[0], { method: 'setEnabled', params: { server: 'include:mcp-alpha', enabled: false } });
});

test('probe shows latency, tool count and remote server name', async () => {
  mockFetch({
    action: async (body) => {
      if (body.method !== 'probe') return { ok: true };
      return body.params.server === 'include:mcp-alpha'
        ? {
          ok: true, serverName: 'alpha', transport: 'streamable-http', reachable: true, latencyMs: 12,
          toolCount: 3, protocolVersion: '2025-06-18', serverNameRemote: 'remote-a',
        }
        : { ok: false, error: 'boom' };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const probeButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === '探针');
  assert.equal(probeButtons.length, 2);
  probeButtons[0].props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /12ms · 3 个工具/);
  assert.match(textOf(tree), /remote-a/);
});

test('search filters rows and the add/import/export panels open', async () => {
  mockFetch();
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();

  // 搜索
  const search = findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === '搜索服务名 / 端点 / 传输…')[0];
  assert.ok(search);
  search.props.onChange({ target: { value: 'beta' } });
  await flush();
  tree = draw();
  assert.match(textOf(tree), /beta/);
  assert.doesNotMatch(textOf(tree), /alpha/);

  // 清空搜索 + 打开新增表单
  const search2 = findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === '搜索服务名 / 端点 / 传输…')[0];
  search2.props.onChange({ target: { value: '' } });
  await flush();
  tree = draw();
  const addButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '新增')[0];
  addButton.props.onClick();
  await flush();
  assert.match(textOf(draw()), /接入新的 MCP 服务/);

  // 导入面板
  const importButton = findAll(draw(), (node) => node.type === 'button' && textOf(node) === '导入')[0];
  importButton.props.onClick();
  await flush();
  assert.match(textOf(draw()), /导入 MCP 配置/);

  // 导出面板
  const exportButton = findAll(draw(), (node) => node.type === 'button' && textOf(node) === '导出')[0];
  exportButton.props.onClick();
  await flush();
  const exportText = textOf(draw());
  assert.match(exportText, /导出配置/);
  assert.match(exportText, /diagnostics（排障报告）/);
  assert.match(exportText, /仅受管（默认）/);
});

test('api errors render the error banner', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, message: 'API down' }) });
  const { draw } = mountSection();
  draw();
  await flush();
  const text = textOf(draw());
  assert.match(text, /管理 API 不可用/);
  assert.match(text, /API down/);
});

// ─── v0.3 新增覆盖 ──────────────────────────────────────────────────────────

test('all requests carry the x-mcp-manager-token header', async () => {
  const previous = globalThis.__MCP_MANAGER_TOKEN__;
  globalThis.__MCP_MANAGER_TOKEN__ = 'tok-123';
  try {
    const { requests } = mockFetch();
    const { draw } = mountSection();
    draw();
    await flush();
    const stateRequests = requests.filter((request) => request.url === '/mcp-manager/api/state');
    assert.ok(stateRequests.length >= 1);
    for (const request of requests) {
      assert.equal(request.headers['x-mcp-manager-token'], 'tok-123');
    }
  } finally {
    if (previous === undefined) delete globalThis.__MCP_MANAGER_TOKEN__;
    else globalThis.__MCP_MANAGER_TOKEN__ = previous;
  }
});

test('tool center searches the catalog and renders matching tools', async () => {
  const { posts } = mockFetch({
    action: async (body) => {
      if (body.method !== 'tools') return { ok: true };
      return {
        total: 1, returned: 1, truncated: false,
        tools: [{ serverName: 'alpha', toolName: 'echo', publicName: 'mcp__alpha__echo', description: 'Echo back the input' }],
        servers: [{ serverName: 'alpha', status: 'connected', enabled: true, toolCount: 2 }],
      };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const openButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('工具中心'))[0];
  assert.ok(openButton);
  openButton.props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /Echo back the input/);
  const firstToolsPost = posts.find((post) => post.method === 'tools');
  assert.ok(firstToolsPost);
  assert.equal(firstToolsPost.params.limit, 200);

  const search = findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === '搜索工具名 / 服务名 / 描述…')[0];
  assert.ok(search);
  search.props.onChange({ target: { value: 'echo' } });
  await flush();
  tree = draw();
  const searchButton = buttonByText(tree, '搜索');
  assert.ok(searchButton);
  searchButton.props.onClick();
  await flush();
  const lastToolsPost = posts.filter((post) => post.method === 'tools').at(-1);
  assert.equal(lastToolsPost.params.query, 'echo');
});

test('tool drawer loads detail, invokes with arguments and renders the result', async () => {
  const detailView = {
    serverName: 'alpha', toolName: 'echo', publicName: 'mcp__alpha__echo',
    description: 'Echo back the input',
    parameters: { type: 'object', properties: { message: { type: 'string' } } },
    sampleArguments: { message: 'hi' }, status: 'connected', enabled: true,
  };
  const { posts } = mockFetch({
    action: async (body) => {
      if (body.method === 'toolDetail') return detailView;
      if (body.method === 'invoke') {
        return {
          ok: true, isError: false, serverName: 'alpha', toolName: 'echo',
          publicName: 'mcp__alpha__echo', durationMs: 5, text: 'echo result', blocks: [], truncated: false,
        };
      }
      return { ok: true };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();

  const showTools = findAll(tree, (node) => node.type === 'button' && textOf(node) === '查看工具')[0];
  assert.ok(showTools);
  showTools.props.onClick();
  await flush();
  tree = draw();
  const toolChip = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'echo')[0];
  assert.ok(toolChip);
  toolChip.props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /试用工具：echo/);
  assert.match(textOf(tree), /Echo back the input/);
  const detailPost = posts.find((post) => post.method === 'toolDetail');
  assert.equal(detailPost.params.server, 'include:mcp-alpha');

  const argsInput = findAll(tree, (node) => node.type === 'textarea' && node.props?.['aria-label'] === '调用参数（JSON）')[0];
  assert.ok(argsInput);
  assert.match(String(argsInput.props.value), /hi/);
  argsInput.props.onChange({ target: { value: '{"message":"hello"}' } });
  await flush();
  tree = draw();

  const execute = buttonByText(tree, '执行');
  assert.ok(execute);
  execute.props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /确认执行/);
  const confirm = buttonByText(tree, '确认执行（可能产生副作用）');
  assert.ok(confirm);
  confirm.props.onClick();
  await flush();
  tree = draw();

  const invokePost = posts.find((post) => post.method === 'invoke');
  assert.deepEqual(invokePost.params, {
    server: 'include:mcp-alpha', tool: 'echo', arguments: { message: 'hello' },
  });
  assert.match(textOf(tree), /echo result/);
  assert.match(textOf(tree), /成功 · 5ms/);
});

test('probe all calls probeMany and reports progress', async () => {
  const { posts } = mockFetch({
    action: async (body) => {
      if (body.method !== 'probeMany') return { ok: true };
      return {
        total: 1, ok: 1, failed: 0,
        results: [{
          serverName: 'alpha', transport: 'streamable-http', ok: true, reachable: true,
          latencyMs: 7, toolCount: 2, serverNameRemote: 'remote-a',
        }],
      };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const probeAllButton = buttonByText(tree, '全部探测');
  assert.ok(probeAllButton);
  probeAllButton.props.onClick();
  await flush();
  tree = draw();
  const probeManyPost = posts.find((post) => post.method === 'probeMany');
  assert.deepEqual(probeManyPost.params, { includeDisabled: false });
  assert.match(textOf(tree), /已探测 1\/1/);
  assert.match(textOf(tree), /成功 1 个/);
  assert.match(textOf(tree), /remote-a/);
});

test('pinned servers sort first and pin updates use server id', async () => {
  const state = makeState({
    prefs: {
      version: 1,
      updatedAt: 0,
      ui: { autoProbe: false },
      servers: {
        beta: {
          pinned: true,
          tags: ['法务'],
          history: [{ at: 1700000000000, ok: true, latencyMs: 10, toolCount: 0 }],
        },
      },
    },
  });
  const { posts } = mockFetch({ state, action: async () => ({ ok: true }) });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const text = textOf(tree);
  assert.ok(text.indexOf('beta') < text.indexOf('alpha'), 'pinned beta should render before alpha');
  // 标签与探针历史色点
  assert.match(text, /#法务/);
  const dots = findAll(tree, (node) => node.type === 'span'
    && typeof node.props?.title === 'string'
    && node.props.title.startsWith('2023-11-14'));
  assert.ok(dots.length >= 1, 'probe history dot should carry an ISO timestamp title');

  const pinButtons = findAll(tree, (node) => node.type === 'button'
    && (node.props?.title === '收藏' || node.props?.title === '取消收藏'));
  assert.equal(pinButtons.length, 2);
  const alphaPin = pinButtons.find((node) => node.props.title === '收藏');
  alphaPin.props.onClick();
  await flush();
  const pinPost = posts.find((post) => post.method === 'patchPrefs');
  assert.deepEqual(pinPost.params, { server: 'include:mcp-alpha', patch: { pinned: true } });
});

test('same-name entries operate by entry id and show shortId', async () => {
  const servers = [
    {
      id: 'entry-a', shortId: 'twin-a', origin: 'profile', serverName: 'twin', transport: 'streamable-http',
      endpoint: 'https://a.example/mcp', enabled: true, loaded: true, status: 'connected',
      toolCount: 0, toolNames: [], tools: [], duplicate: true,
    },
    {
      id: 'entry-b', shortId: 'twin-b', origin: 'managed', serverName: 'twin', transport: 'streamable-http',
      endpoint: 'https://b.example/mcp', enabled: true, loaded: true, status: 'connected',
      toolCount: 0, toolNames: [], tools: [], duplicate: true,
    },
  ];
  const state = makeState({
    servers,
    summary: {
      total: 2, uniqueServers: 1, duplicateServers: 1, enabled: 2, disabled: 0, connected: 2,
      failed: 0, notProvisioned: 0, managed: 1, toolCount: 0, orphanToolCount: 0,
    },
  });
  const { posts } = mockFetch({ state, action: async () => ({ ok: true }) });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const text = textOf(tree);
  assert.match(text, /twin-a/);
  assert.match(text, /twin-b/);

  const rowSwitches = findAll(tree, (node) => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === '停用');
  assert.equal(rowSwitches.length, 2);
  rowSwitches[1].props.onClick();
  await flush();
  assert.deepEqual(posts[0], { method: 'setEnabled', params: { server: 'entry-b', enabled: false } });

  const probeButtons = findAll(draw(), (node) => node.type === 'button' && textOf(node) === '探针');
  probeButtons[1].props.onClick();
  await flush();
  const probePost = posts.find((post) => post.method === 'probe');
  assert.equal(probePost.params.server, 'entry-b');
});

test('edit advanced config submits reconnect fields and never writes the masked url back', async () => {
  const configView = {
    id: 'include:mcp-alpha', serverName: 'alpha', origin: 'profile', transport: 'streamable-http',
    enabled: true, url: 'https://a.example/mcp/***', urlMasked: true,
    hasHeaders: false, headerKeys: [], hasEnv: false, envKeys: [], toolCallTimeoutMs: 180000,
    advanced: {
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      failOnStartupError: false,
      maxInstructionBytes: 32768,
    },
  };
  const { posts } = mockFetch({
    action: async (body) => {
      if (body.method === 'config') return configView;
      if (body.method === 'update') return { persisted: false, server: { id: 'include:mcp-alpha' } };
      return { ok: true };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();

  const editButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === '编辑');
  assert.equal(editButtons.length, 2);
  editButtons[0].props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /编辑 MCP 服务：alpha/);
  const configPost = posts.find((post) => post.method === 'config');
  assert.equal(configPost.params.server, 'include:mcp-alpha');

  const urlInput = findAll(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === 'MCP 端点 URL')[0];
  assert.ok(urlInput);
  assert.equal(urlInput.props.value, '');
  assert.match(textOf(tree), /留空表示保持原值/);

  const advancedButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('高级配置'))[0];
  assert.ok(advancedButton);
  advancedButton.props.onClick();
  await flush();
  tree = draw();

  const attemptsInput = findAll(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '最大重试次数')[0];
  assert.ok(attemptsInput);
  attemptsInput.props.onChange({ target: { value: '7' } });
  await flush();
  tree = draw();

  const saveButton = buttonByText(tree, '保存');
  assert.ok(saveButton);
  saveButton.props.onClick();
  await flush();

  const updatePost = posts.find((post) => post.method === 'update');
  assert.ok(updatePost);
  assert.equal(updatePost.params.server, 'include:mcp-alpha');
  assert.deepEqual(updatePost.params.changes.reconnect, {
    enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 7,
  });
  assert.equal(updatePost.params.changes.failOnStartupError, false);
  assert.equal(updatePost.params.changes.maxInstructionBytes, 32768);
  assert.equal(updatePost.params.changes.url, undefined);
});

test('zh and en dictionaries share the same key set', () => {
  const { dictionaries } = makePlugin();
  const dict = dictionaries.get('mcp-manager');
  const keysOf = (value, prefix = '') => Object.entries(value ?? {}).flatMap(([key, child]) => (
    child !== null && typeof child === 'object' ? keysOf(child, `${prefix}${key}.`) : [`${prefix}${key}`]
  ));
  assert.deepEqual(keysOf(dict.zh).sort(), keysOf(dict.en).sort());
});

test('auto probe runs probeMany once when enabled in prefs', async () => {
  const state = makeState({
    prefs: { version: 1, updatedAt: 0, ui: { autoProbe: true }, servers: {} },
  });
  const { posts } = mockFetch({
    state,
    action: async (body) => {
      if (body.method !== 'probeMany') return { ok: true };
      return { total: 1, ok: 1, failed: 0, results: [] };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  const probeManyPosts = posts.filter((post) => post.method === 'probeMany');
  assert.equal(probeManyPosts.length, 1);
  assert.deepEqual(probeManyPosts[0].params, { includeDisabled: false });
});

test('auto probe toggle persists ui prefs via setUiPrefs', async () => {
  const { posts } = mockFetch({ action: async () => ({ autoProbe: true }) });
  const { draw } = mountSection();
  draw();
  await flush();
  const tree = draw();
  const autoProbeSwitch = findAll(tree, (node) => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === '自动探测')[0];
  assert.ok(autoProbeSwitch);
  autoProbeSwitch.props.onClick();
  await flush();
  const uiPost = posts.find((post) => post.method === 'setUiPrefs');
  assert.deepEqual(uiPost.params, { patch: { autoProbe: true } });
});

// ─── v0.4 按应用归类 ────────────────────────────────────────────────────────

function fuyaoServers() {
  const app = { id: 'fuyao', name: '同花顺', icon: '📈', vendor: '同花顺', source: 'catalog' };
  return [
    {
      id: 'mcp-fuyao-a-share', shortId: 'fuyao-a-share', origin: 'managed', serverName: 'fuyao-a-share',
      transport: 'streamable-http', endpoint: 'https://fuyao.aicubes.cn/a-share/stream', enabled: true,
      loaded: true, status: 'connected', toolCount: 20, toolNames: ['a_share_quote'], tools: [], duplicate: false, app,
    },
    {
      id: 'mcp-fuyao-fund', shortId: 'fuyao-fund', origin: 'managed', serverName: 'fuyao-fund',
      transport: 'streamable-http', endpoint: 'https://fuyao.aicubes.cn/fund/stream', enabled: false,
      loaded: false, status: 'disabled', toolCount: 0, toolNames: [], tools: [], duplicate: false, app,
    },
  ];
}

function amapServer() {
  return {
    id: 'include:mcp-amap', shortId: 'mcp-amap', origin: 'profile', serverName: 'amap-only',
    transport: 'streamable-http', endpoint: 'https://maps.example/mcp', enabled: true, loaded: true,
    status: 'connected', toolCount: 5, toolNames: ['geo'], tools: [], duplicate: false,
    app: { id: 'amap', name: '高德地图', icon: '🗺️', vendor: '高德', source: 'catalog' },
  };
}

function manualAppServers() {
  const app = { id: 'manual:研究平台', name: '研究平台', icon: '🏷️', source: 'manual' };
  return ['research-a', 'research-b'].map((name, index) => ({
    id: `mcp-manager-${name}`, shortId: name, origin: 'managed', serverName: name,
    transport: 'streamable-http', endpoint: `https://research.example/${index}`, enabled: true,
    loaded: true, status: 'connected', toolCount: 3 + index, toolNames: [], tools: [], duplicate: false, app,
  }));
}

function configViewFor(overrides = {}) {
  return {
    id: 'include:mcp-alpha', serverName: 'alpha', origin: 'profile', transport: 'streamable-http',
    enabled: true, url: 'https://a.example/mcp', urlMasked: false,
    hasHeaders: false, headerKeys: [], hasEnv: false, envKeys: [], toolCallTimeoutMs: 180000,
    advanced: {
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      failOnStartupError: false,
      maxInstructionBytes: 32768,
    },
    ...overrides,
  };
}

test('two services of the same app render inside one group card', async () => {
  const state = makeState({ servers: fuyaoServers() });
  mockFetch({ state });
  const { draw } = mountSection();
  draw();
  await flush();
  const text = textOf(draw());
  assert.match(text, /同花顺/);
  assert.match(text, /📈/);
  assert.match(text, /2 个服务/);
  assert.match(text, /1 已连接 · 0 失败 · 1 停用/);
  assert.match(text, /fuyao-a-share/);
  assert.match(text, /fuyao-fund/);
  assert.doesNotMatch(text, /独立服务/);
});

test('app group collapses/expands and the flat view is remembered', async () => {
  const state = makeState({ servers: fuyaoServers() });
  mockFetch({ state });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const findToggle = (current) => findAll(
    current,
    (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined && textOf(node).includes('同花顺'),
  )[0];

  const toggle = findToggle(tree);
  assert.ok(toggle);
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  await flush();
  tree = draw();
  assert.doesNotMatch(textOf(tree), /fuyao-a-share/);
  assert.equal(findToggle(tree).props['aria-expanded'], false);

  findToggle(tree).props.onClick();
  await flush();
  assert.match(textOf(draw()), /fuyao-a-share/);

  const flatButton = buttonByText(draw(), '平铺');
  assert.ok(flatButton);
  flatButton.props.onClick();
  await flush();
  const flatText = textOf(draw());
  assert.match(flatText, /fuyao-a-share/);
  assert.doesNotMatch(flatText, /2 个服务/);
  assert.equal(storage.get('dsh-mcp-manager:view'), 'flat');
});

test('app filter chips narrow visible groups and stack with search', async () => {
  const state = makeState({ servers: [...fuyaoServers(), amapServer()] });
  mockFetch({ state });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const appChip = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.['aria-pressed'] !== undefined && textOf(node).includes('同花顺'),
  )[0];
  assert.ok(appChip);
  assert.equal(appChip.props['aria-pressed'], false);
  appChip.props.onClick();
  await flush();
  tree = draw();
  assert.match(textOf(tree), /fuyao-a-share/);
  assert.doesNotMatch(textOf(tree), /amap-only/);
  assert.equal(
    findAll(tree, (node) => node.type === 'button' && node.props?.['aria-pressed'] !== undefined && textOf(node).includes('同花顺'))[0].props['aria-pressed'],
    true,
  );

  // 叠加搜索：应用内再搜 fund
  const search = findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === '搜索服务名 / 端点 / 传输…')[0];
  search.props.onChange({ target: { value: 'fund' } });
  await flush();
  tree = draw();
  assert.match(textOf(tree), /fuyao-fund/);
  assert.doesNotMatch(textOf(tree), /fuyao-a-share/);

  // 清空搜索 + 全部应用
  findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === '搜索服务名 / 端点 / 传输…')[0]
    .props.onChange({ target: { value: '' } });
  await flush();
  tree = draw();
  buttonByText(tree, '全部应用').props.onClick();
  await flush();
  assert.match(textOf(draw()), /amap-only/);
});

test('renaming and restoring an app calls renameApp and reloads state', async () => {
  const state = makeState({ servers: manualAppServers() });
  const { posts, requests } = mockFetch({
    state,
    action: async (body) => {
      if (body.method === 'renameApp') return { appId: body.params.app, name: body.params.name, updated: 2, apps: [] };
      return { ok: true };
    },
  });
  const stateCount = () => requests.filter((request) => request.url === '/mcp-manager/api/state').length;
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  assert.match(textOf(tree), /研究平台/);

  const before = stateCount();
  const restoreButton = buttonByText(tree, '恢复自动识别');
  assert.ok(restoreButton);
  restoreButton.props.onClick();
  await flush();
  assert.deepEqual(posts.find((post) => post.method === 'renameApp').params, { app: 'manual:研究平台', name: null });
  assert.ok(stateCount() > before, 'renameApp should reload state');

  tree = draw();
  const renameButton = buttonByText(tree, '重命名');
  assert.ok(renameButton);
  renameButton.props.onClick();
  await flush();
  tree = draw();
  const input = findAll(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '应用名称')[0];
  assert.ok(input);
  input.props.onChange({ target: { value: '研究平台2' } });
  await flush();
  tree = draw();
  findAll(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '应用名称')[0]
    .props.onKeyDown({ key: 'Enter' });
  await flush();
  const renamePosts = posts.filter((post) => post.method === 'renameApp');
  assert.equal(renamePosts.length, 2);
  assert.deepEqual(renamePosts[1].params, { app: 'manual:研究平台', name: '研究平台2' });
});

test('single-service apps render in the standalone servers section with an app badge', async () => {
  const state = makeState({ servers: [...fuyaoServers(), amapServer()] });
  mockFetch({ state });
  const { draw } = mountSection();
  draw();
  await flush();
  const text = textOf(draw());
  assert.match(text, /独立服务/);
  assert.match(text, /amap-only/);
  assert.match(text, /🗺️ 高德地图/);
  assert.ok(text.indexOf('独立服务') < text.indexOf('amap-only'), 'standalone section should be after group cards');
});

test('edit panel submits app grouping via patchPrefs after update', async () => {
  const state = makeState({
    prefs: { version: 1, updatedAt: 0, ui: { autoProbe: false }, servers: { alpha: { app: '我的高德' } } },
  });
  const { posts } = mockFetch({
    state,
    action: async (body) => {
      if (body.method === 'config') return configViewFor();
      if (body.method === 'update') return { persisted: false };
      if (body.method === 'patchPrefs') return { serverName: 'alpha', prefs: {} };
      return { ok: true };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const editButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === '编辑');
  assert.equal(editButtons.length, 2);
  editButtons[0].props.onClick();
  await flush();
  tree = draw();

  const appInput = findAll(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '应用归类')[0];
  assert.ok(appInput);
  assert.equal(appInput.props.value, '我的高德');
  appInput.props.onChange({ target: { value: '我的应用' } });
  await flush();
  tree = draw();
  const saveButton = buttonByText(tree, '保存');
  assert.ok(saveButton);
  saveButton.props.onClick();
  await flush();

  const methods = posts.map((post) => post.method);
  const updateIndex = methods.indexOf('update');
  const patchIndex = methods.indexOf('patchPrefs');
  assert.ok(updateIndex >= 0, 'update should be called');
  assert.ok(patchIndex > updateIndex, 'patchPrefs(app) should run after update');
  assert.deepEqual(posts[patchIndex].params, { server: 'include:mcp-alpha', patch: { app: '我的应用' } });
});
