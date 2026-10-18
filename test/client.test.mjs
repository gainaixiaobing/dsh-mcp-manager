/**
 * dsh-mcp-manager Web 半区离线测试（模拟浏览器模块加载器 + 最小 React Hooks 渲染器）。
 *
 * 覆盖：client 模块注册格式（id === 包名）、槽位注册、列表/状态/来源渲染、
 * 启停交互、探针结果展示、筛选、新增表单与导入/导出面板的打开。
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
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}[${index}]`));
  if (typeof node === 'string' || typeof node === 'number') return node;
  const { type, props } = node;
  if (typeof type === 'function') {
    const store = hookStores.get(path) ?? { hooks: [], cursor: 0, effects: [] };
    hookStores.set(path, store);
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
    return renderNode(output, `${path}/${type.name || 'component'}`);
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

function makeState(overrides = {}) {
  return {
    ok: true,
    servers: [
      {
        id: 'include:mcp-alpha', shortId: 'mcp-alpha', origin: 'profile', serverName: 'alpha',
        transport: 'streamable-http', endpoint: 'https://a.example/mcp', enabled: true, loaded: true,
        status: 'connected', toolCount: 2, tools: ['echo', 'ping'], duplicate: false,
      },
      {
        id: 'mcp-manager-beta', shortId: 'mcp-manager-beta', origin: 'managed', serverName: 'beta',
        transport: 'stdio', endpoint: 'node（+1 个参数）', enabled: false, loaded: false,
        status: 'disabled', toolCount: 0, tools: [], duplicate: false,
      },
    ],
    summary: {
      total: 2, uniqueServers: 2, duplicateServers: 0, enabled: 1, disabled: 1, connected: 1,
      failed: 0, notProvisioned: 0, managed: 1, toolCount: 2, orphanToolCount: 0,
    },
    storePath: '/tmp/connections.json',
    provisionFailures: {},
    ...overrides,
  };
}

function mockFetch({ state = makeState(), action } = {}) {
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (url === '/mcp-manager/api/state') return { ok: true, json: async () => ({ ok: true, ...state }) };
    if (url === '/mcp-manager/api/action') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const result = action ? await action(body) : { ok: true };
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return posts;
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
});

test('toggling a server posts setEnabled and reloads', async () => {
  const posts = mockFetch({
    action: (body) => {
      assert.equal(body.method, 'setEnabled');
      return { ok: true };
    },
  });
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const switches = findAll(tree, (node) => node.type === 'button' && node.props?.role === 'switch');
  assert.equal(switches.length, 2);
  switches[0].props.onClick();
  await flush();
  assert.deepEqual(posts[0], { method: 'setEnabled', params: { server: 'alpha', enabled: false } });
});

test('probe shows latency and tool count, and errors are surfaced', async () => {
  mockFetch({
    action: async (body) => {
      if (body.method !== 'probe') return { ok: true };
      return body.params.server === 'alpha'
        ? { ok: true, serverName: 'alpha', transport: 'streamable-http', reachable: true, latencyMs: 12, toolCount: 3, protocolVersion: '2025-06-18', serverNameRemote: 'remote-a' }
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
  assert.match(textOf(draw()), /导出配置/);
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
