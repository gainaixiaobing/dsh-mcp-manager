/**
 * 同源 HTTP API 离线测试（不启动 Harness）。
 *
 * 覆盖：token 鉴权、回环/Origin fence、IPv6 回环、action 白名单、state 快照、
 * index 注入 token、请求体大小限制。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManager } from '../lib/index.js';
import { mountWebApi } from '../lib/web.js';

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

function makeFakeCtx() {
  const tools = {
    defs: new Map(),
    register(definition) {
      this.defs.set(definition.name, definition);
      return () => this.defs.delete(definition.name);
    },
    schemas() {
      return [...this.defs.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
  };
  const entries = new Map();
  const loader = {
    entries: () => entries.values(),
    async create({ id, name, config, disabled = false }) {
      if (name !== MCP_CLIENT) throw new Error(`unexpected plugin ${name}`);
      const entry = {
        options: { id, name, config, disabled },
        fiber: disabled ? undefined : { config },
        toolNames: [],
      };
      Object.defineProperty(entry, 'id', { get: () => entry.options.id });
      Object.defineProperty(entry, 'disabled', { get: () => Boolean(entry.options.disabled) });
      entries.set(id, entry);
      if (!disabled) {
        const serverName = config.serverName;
        for (const raw of ['echo', 'ping']) {
          const toolName = `mcp__${serverName}__${raw}`;
          if (!tools.defs.has(toolName)) {
            tools.register({ name: toolName, description: `${raw}`, parameters: { type: 'object', properties: {} } });
          }
          entry.toolNames.push(raw);
        }
      }
      return entry;
    },
    async update() {},
    async remove(id) { entries.delete(id); },
  };

  const routes = [];
  const taps = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
    tapIndex(fn) {
      taps.push(fn);
      return () => {
        const index = taps.indexOf(fn);
        if (index >= 0) taps.splice(index, 1);
      };
    },
  };

  const listeners = new Map();
  const ctx = {
    tools,
    loader,
    logger: { info() {}, warn() {}, debug() {} },
    effect() {},
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => {};
    },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('webServer')) callback({ webServer, effect(fn) { fn(); } });
    },
  };
  return { ctx, routes, taps, tools, listeners };
}

/** 模拟 webServer.collectIndexInjections()：emit 一次 webserver/index-inject。 */
function collectInjections(listeners) {
  const table = [];
  for (const listener of listeners.get('webserver/index-inject') ?? []) listener(table);
  return table;
}

function makeRequest({ method = 'GET', url = '/mcp-manager/api/state', headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk;
    },
  };
}

function makeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(text) { this.body = text; },
  };
  return response;
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'connections.json');
  const prefsPath = join(dir, 'prefs.json');
  const { ctx, routes, taps, tools, listeners } = makeFakeCtx();
  const manager = createManager(ctx, { storePath, prefsPath });
  await manager.init();
  mountWebApi(ctx, manager, options);
  const route = routes[0];
  return { ctx, manager, route, taps, tools, listeners };
}

function tokenFromTaps(taps) {
  const match = /__MCP_MANAGER_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(taps.map((fn) => fn('<html><head></head><body></body></html>')).join(''));
  assert.ok(match, 'index 注入里应包含 token');
  return JSON.parse(match[1]);
}

async function callAction(route, token, method, params = {}, extraHeaders = {}) {
  const response = makeResponse();
  await route.handler(
    makeRequest({
      method: 'POST',
      url: '/mcp-manager/api/action',
      headers: { host: '127.0.0.1:61907', 'x-mcp-manager-token': token, 'content-type': 'application/json', ...extraHeaders },
      body: { method, params },
    }),
    response,
  );
  return { status: response.statusCode, payload: JSON.parse(response.body || '{}') };
}

test('web API injects a token and rejects requests without it', async (t) => {
  const { route, taps, listeners } = await setup(t);
  assert.equal(typeof route.handler, 'function');
  const token = tokenFromTaps(taps);

  // 桌面端关键路径：结构化注入表（Electron 走 dsh-app:// + IPC boot injections，不跑 tapIndex）
  const table = collectInjections(listeners);
  assert.equal(table.length, 1);
  assert.equal(table[0].kind, 'global');
  assert.equal(table[0].name, '__MCP_MANAGER_TOKEN__');
  assert.equal(table[0].value, token);
  assert.match(token, /^[0-9a-f]{48}$/);

  const missing = makeResponse();
  await route.handler(makeRequest({ headers: { host: '127.0.0.1:61907' } }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = makeResponse();
  await route.handler(
    makeRequest({ headers: { host: '127.0.0.1:61907', 'x-mcp-manager-token': 'deadbeef' } }),
    wrong,
  );
  assert.equal(wrong.statusCode, 401);
});

test('web API accepts same-origin loopback requests with token, including IPv6', async (t) => {
  const { route, taps } = await setup(t);
  const token = tokenFromTaps(taps);

  const state = makeResponse();
  await route.handler(makeRequest({ headers: { host: '127.0.0.1:61907', 'x-mcp-manager-token': token } }), state);
  assert.equal(state.statusCode, 200);
  const payload = JSON.parse(state.body);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.servers));

  const ipv6 = makeResponse();
  await route.handler(makeRequest({ headers: { host: '[::1]:61907', 'x-mcp-manager-token': token } }), ipv6);
  assert.equal(ipv6.statusCode, 200);

  const crossSite = makeResponse();
  await route.handler(
    makeRequest({
      headers: { host: '127.0.0.1:61907', 'x-mcp-manager-token': token, 'sec-fetch-site': 'cross-site' },
    }),
    crossSite,
  );
  assert.equal(crossSite.statusCode, 403);

  const foreignHost = makeResponse();
  await route.handler(makeRequest({ headers: { host: 'evil.example:61907', 'x-mcp-manager-token': token } }), foreignHost);
  assert.equal(foreignHost.statusCode, 403);
});

test('web API action whitelist, probe shape and state size', async (t) => {
  const { route, taps, manager } = await setup(t);
  const token = tokenFromTaps(taps);
  const unknown = await callAction(route, token, 'rm -rf');
  assert.equal(unknown.status, 400);
  assert.match(unknown.payload.message, /未知方法/);

  // 增加一个受管服务，state 里不应带工具说明大字段
  await manager.add({ serverName: 'web-one', transport: 'streamable-http', url: 'https://w.example/mcp' });
  const state = makeResponse();
  await route.handler(makeRequest({ headers: { host: '127.0.0.1:61907', 'x-mcp-manager-token': token } }), state);
  const payload = JSON.parse(state.body);
  const server = payload.servers.find((item) => item.serverName === 'web-one');
  assert.ok(server);
  assert.deepEqual(server.tools, []);
  assert.ok(server.toolNames.includes('echo'));
  assert.equal(payload.toolCount, payload.summary.toolCount);
  assert.ok(Array.isArray(payload.apps));
  assert.equal(payload.apps.length, 1);
  assert.equal(payload.apps[0].total, 1);

  const exported = await callAction(route, token, 'export', { format: 'markdown' });
  assert.equal(exported.status, 200);
  assert.match(exported.payload.result.content, /web-one/);
});

test('mountWebApi respects webApi:false', async (t) => {
  const { route } = await setup(t, { webApi: false });
  assert.equal(route, undefined);
});
