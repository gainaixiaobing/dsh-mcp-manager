/**
 * dsh-mcp-manager Web 半区离线测试（模拟浏览器模块加载器 + 最小 React Hooks 渲染器）。
 *
 * 覆盖：client 模块注册格式（id === 包名）、apply 注册 settings.section 的选项、
 * 以及组件在 loading / ready / error 三种状态下的渲染与启停交互。
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

// ─── 假浏览器模块加载器 ──────────────────────────────────────────────────────

const loaded = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.set(id, factory);
    },
  },
};

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
  const effects = [];
  const dictionaries = new Map();
  const ctx = {
    effect(fn) {
      effects.push(fn);
      fn();
      return () => {};
    },
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
  return { plugin, ctx, registrations, injections, effects, dictionaries };
}

function mountSection() {
  const env = makePlugin();
  // 每次挂载都从干净的 hook 存储开始
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
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('apply registers one settings.section entry with nav label and locale', () => {
  const { plugin, registrations, injections, dictionaries } = makePlugin();
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.deepEqual(injections, ['settings.section']);
  assert.equal(registrations.length, 1);
  const [{ options }] = registrations;
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'mcp-manager');
  assert.equal(options.locale, 'mcp-manager');
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), 'MCP 服务');
  assert.ok(dictionaries.get('mcp-manager').zh.title);
  assert.ok(dictionaries.get('mcp-manager').en.title);
});

test('renders loading, then the server table with statuses and tool counts', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      servers: [
        {
          id: 'include:mcp-a', serverName: 'alpha', transport: 'streamable-http', endpoint: 'https://a.example/mcp',
          enabled: true, status: 'connected', toolCount: 2, tools: ['echo', 'ping'],
        },
        {
          id: 'include:mcp-b', serverName: 'beta', transport: 'stdio', endpoint: 'node（+1 个参数）',
          enabled: false, status: 'disabled', toolCount: 0, tools: [],
        },
      ],
      summary: { total: 2, enabled: 1, disabled: 1, connected: 1, toolCount: 2, orphanToolCount: 0 },
    }),
  });
  const { draw } = mountSection();
  let tree = draw();
  assert.match(textOf(tree), /读取中/, 'first paint shows the loading state');
  await flush();
  tree = draw();
  const text = textOf(tree);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /已连接/);
  assert.match(text, /已停用/);
  assert.match(text, /2 个服务 · 1 个启用 · 1 个已连接 · 2 个工具/);

  const showButton = findNode(tree, (node) => node.type === 'button' && textOf(node) === '查看工具');
  assert.ok(showButton, 'connected server exposes the tools toggle');
  showButton.props.onClick();
  await flush();
  const expanded = textOf(draw());
  assert.match(expanded, /echo/);
  assert.match(expanded, /ping/);
});

test('toggling a server posts setEnabled and refreshes state', async () => {
  const posts = [];
  let connected = true;
  globalThis.fetch = async (url, init) => {
    if (url === '/mcp-manager/api/state') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          servers: [{
            id: 'include:mcp-a', serverName: 'alpha', transport: 'streamable-http',
            enabled: connected, status: connected ? 'connected' : 'disabled', toolCount: connected ? 2 : 0,
            tools: connected ? ['echo'] : [],
          }],
          summary: { total: 1, enabled: connected ? 1 : 0, disabled: connected ? 0 : 1, connected: connected ? 1 : 0, toolCount: connected ? 2 : 0 },
        }),
      };
    }
    if (url === '/mcp-manager/api/action') {
      posts.push(JSON.parse(init.body));
      connected = false;
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { draw } = mountSection();
  draw();
  await flush();
  let tree = draw();
  const toggle = findNode(tree, (node) => node.type === 'button' && node.props.role === 'switch');
  assert.ok(toggle, 'each row has a switch');
  assert.equal(toggle.props['aria-checked'], true);
  toggle.props.onClick();
  await flush();
  assert.deepEqual(posts, [{ method: 'setEnabled', params: { server: 'alpha', enabled: false } }]);
  tree = draw();
  const text = textOf(tree);
  assert.match(text, /已停用/, 'the refreshed state shows the server as disabled');
});

test('surfaces an error state when the management API is unavailable', async () => {
  globalThis.fetch = async () => {
    throw new Error('HTTP 404');
  };
  const { draw } = mountSection();
  draw();
  await flush();
  const text = textOf(draw());
  assert.match(text, /管理 API 不可用/);
  assert.match(text, /HTTP 404/);
});
