/**
 * dsh-mcp-manager Host 半区离线测试（不启动 Harness）。
 *
 * 覆盖：清单/解析、受管存储持久化、启停/增删/编辑、mcpServers 导入导出、
 * MCP 握手探针（stdio + streamable-http）、工具 schema 子集校验。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManager, normalizePluginConfig } from '../lib/index.js';
import { registerTools } from '../lib/tools.js';
import { normalizeRecord, toMcpServersJson, fromMcpServersJson } from '../lib/config.js';
import { scanImports, parseMcpServersText, parseJsonRelaxed, stripJsonc } from '../lib/importers.js';
import { sanitizeText, sanitizeUrl } from '../lib/sanitize.js';
import { probeRecord, probeStdio } from '../lib/probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'fixtures', 'stub-mcp.mjs');
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

// ─── 假运行时 ────────────────────────────────────────────────────────────────

class FakeTools {
  defs = new Map();
  register(definition) {
    if (!definition?.name) throw new Error('tool name required');
    this.defs.set(definition.name, definition);
    return () => this.defs.delete(definition.name);
  }
  schemas() {
    return [...this.defs.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
  }
}

function makeEntry({ id, config, disabled = false }, tools) {
  const entry = {
    options: { id, name: MCP_CLIENT, config, disabled },
    fiber: undefined,
    toolNames: [],
  };
  Object.defineProperty(entry, 'id', { get: () => entry.options.id });
  Object.defineProperty(entry, 'disabled', { get: () => Boolean(entry.options.disabled) });
  entry.mount = () => {
    const serverName = entry.options.config.serverName;
    const names = ['echo', 'ping'];
    entry.toolNames = [];
    for (const raw of names) {
      const name = `mcp__${serverName}__${raw}`;
      if (tools.defs.has(name)) continue;
      tools.register({ name, description: `${raw} for ${serverName}`, parameters: { type: 'object', additionalProperties: false, properties: {} } });
      entry.toolNames.push(raw);
    }
    entry.fiber = { config: entry.options.config };
  };
  entry.unmount = () => {
    const serverName = entry.options.config.serverName;
    for (const raw of entry.toolNames) tools.defs.delete(`mcp__${serverName}__${raw}`);
    entry.toolNames = [];
    entry.fiber = undefined;
  };
  return entry;
}

class FakeLoader {
  constructor(tools) {
    this.tools = tools;
    this.store = new Map();
  }
  entries() { return this.store.values(); }
  resolve(id) {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`cannot resolve entry ${id}`);
    return entry;
  }
  addEntry({ id, config, disabled = false }) {
    if (this.store.has(id)) throw new Error(`duplicate entry ${id}`);
    const entry = makeEntry({ id, config, disabled }, this.tools);
    this.store.set(id, entry);
    if (!disabled) entry.mount();
    return entry;
  }
  async create({ id, name, config, disabled = false }) {
    if (name !== MCP_CLIENT) throw new Error(`unexpected plugin ${name}`);
    return this.addEntry({ id, config, disabled });
  }
  async update(id, options) {
    const entry = this.resolve(id);
    const wasEnabled = !entry.disabled;
    if (options.config !== undefined) entry.options.config = options.config;
    if (options.disabled !== undefined) entry.options.disabled = options.disabled;
    if (entry.disabled) {
      if (wasEnabled) entry.unmount();
      entry.fiber = undefined;
    } else {
      entry.fiber = { config: entry.options.config };
      if (!wasEnabled || entry.toolNames.length === 0) entry.mount();
    }
  }
  remove(id) {
    const entry = this.resolve(id);
    if (!entry.disabled) entry.unmount();
    this.store.delete(id);
  }
}

function makeCtx(tools = new FakeTools()) {
  const loader = new FakeLoader(tools);
  const ctx = {
    tools,
    loader,
    logger: { info() {}, warn() {}, debug() {} },
    effect() {},
    inject() {},
  };
  return { ctx, loader, tools };
}

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'connections.json');
}

async function seedStore(storePath, records) {
  await mkdir(dirname(storePath), { recursive: true });
  const servers = {};
  for (const record of records) servers[record.serverName] = normalizeRecord(record, { source: 'managed' });
  await writeFile(storePath, JSON.stringify({ version: 1, updatedAt: Date.now(), servers }, null, 2));
}

// ─── Harness JSON Schema 子集校验 ────────────────────────────────────────────

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
]);

function checkSchema(schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${path} must be a schema object`);
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required)) throw new Error(`${path}.required must be an array`);
    const properties = schema.properties ?? {};
    for (const name of schema.required) {
      if (!Object.hasOwn(properties, name)) throw new Error(`${path}.required names undeclared property ${name}`);
    }
  }
  if (Object.hasOwn(schema, 'type')) {
    if (!SCHEMA_TYPES.has(schema.type)) throw new Error(`${path}.type invalid: ${schema.type}`);
    if (schema.type === 'array' && schema.items !== undefined) checkSchema(schema.items, `${path}.items`);
    if (schema.type === 'object' && schema.properties !== undefined && typeof schema.properties !== 'object') {
      throw new Error(`${path}.properties must be an object`);
    }
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) checkSchema(child, `${path}.properties.${name}`);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`));
}

// ─── 配置/导入解析 ──────────────────────────────────────────────────────────

test('normalizeRecord validates and normalizes connection records', () => {
  const http = normalizeRecord({ serverName: 'srv-1', transport: 'http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer x' } });
  assert.equal(http.transport, 'streamable-http');
  assert.equal(http.url, 'https://a.example/mcp');
  assert.equal(http.toolCallTimeoutMs, 180000);
  assert.equal(http.serverName, 'srv-1');

  const stdio = normalizeRecord({ serverName: 'srv-2', transport: 'stdio', command: 'node', args: ['x.mjs'], env: { A: '1' } });
  assert.deepEqual(stdio.args, ['x.mjs']);
  assert.deepEqual(stdio.env, { A: '1' });

  assert.throws(() => normalizeRecord({ serverName: 'bad name', transport: 'stdio', command: 'node' }), /serverName/);
  assert.throws(() => normalizeRecord({ serverName: 'x', transport: 'grpc' }), /transport/);
  assert.throws(() => normalizeRecord({ serverName: 'x', transport: 'streamable-http' }), /url/);
  assert.throws(() => normalizeRecord({ serverName: 'x', transport: 'stdio' }), /command/);
});

test('parseMcpServersText accepts the common mcpServers shapes and rejects SSE', () => {
  const a = parseMcpServersText(JSON.stringify({ mcpServers: { a: { command: 'node', args: ['a.js'] } } }));
  assert.equal(a.records.a.transport, 'stdio');

  const b = parseMcpServersText(JSON.stringify({ servers: { b: { type: 'http', url: 'https://b.example/mcp' } } }));
  assert.equal(b.records.b.transport, 'streamable-http');

  const c = parseMcpServersText(JSON.stringify([{ name: 'c', url: 'https://c.example/mcp' }]));
  assert.equal(c.records.c.transport, 'streamable-http');

  const d = parseMcpServersText(JSON.stringify({ context_servers: { zed: { command: 'zed-mcp' } } }));
  assert.equal(d.records.zed.command, 'zed-mcp');

  const sse = parseMcpServersText(JSON.stringify({ mcpServers: { s: { type: 'sse', url: 'https://s.example/sse' } } }));
  assert.equal(Object.keys(sse.records).length, 0);
  assert.match(sse.errors[0], /SSE/);

  assert.throws(() => parseMcpServersText('{oops'), /不是合法 JSON/);
});

test('fromMcpServersJson/toMcpServersJson round-trips stdio and http', () => {
  const stdio = fromMcpServersJson('t', { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
  assert.deepEqual(toMcpServersJson(stdio), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
  const http = fromMcpServersJson('h', { url: 'https://h.example/mcp', headers: { 'X-A': 'b' } });
  assert.deepEqual(toMcpServersJson(http), { type: 'streamable-http', url: 'https://h.example/mcp', headers: { 'X-A': 'b' } });
});

// ─── 清单 / 受管存储 ────────────────────────────────────────────────────────

test('managed records are provisioned on init and listed as managed', async (t) => {
  const storePath = await tempStore(t);
  await seedStore(storePath, [{ serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' }]);
  const { ctx, loader } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();

  assert.ok(loader.store.has('mcp-manager-alpha'));
  const { servers, summary } = manager.list();
  const alpha = servers.find((server) => server.serverName === 'alpha');
  assert.equal(alpha.origin, 'managed');
  assert.equal(alpha.status, 'connected');
  assert.equal(alpha.toolCount, 2);
  assert.equal(summary.managed, 1);
});

test('setEnabled persists for managed servers and reloads on a new manager', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'beta', transport: 'streamable-http', url: 'https://b.example/mcp' });
  assert.equal(manager.list().summary.connected, 1);

  const off = await manager.setEnabled('beta', false);
  assert.equal(off.persisted, true);
  assert.equal(loader.store.get('mcp-manager-beta').disabled, true);
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(store.servers.beta.enabled, false);

  // 新 manager 从同一存储恢复（停用状态保留）
  const { ctx: ctx2, loader: loader2 } = makeCtx();
  const manager2 = createManager(ctx2, { storePath });
  await manager2.init();
  assert.equal(loader2.store.get('mcp-manager-beta').disabled, true);
  assert.equal(manager2.list().servers.find((server) => server.serverName === 'beta').status, 'disabled');

  const on = await manager2.setEnabled('beta', true);
  assert.equal(on.persisted, true);
  assert.equal(manager2.list().servers.find((server) => server.serverName === 'beta').status, 'connected');
});

test('add/update/remove work for managed servers and touch the store', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();

  const added = await manager.add({ serverName: 'gamma', transport: 'stdio', command: process.execPath, args: [STUB] });
  assert.equal(added.updated, false);
  assert.equal(added.persisted, true);
  assert.equal(added.toolCount, 2);

  const updated = await manager.update('gamma', { env: { STUB_TOOLS: 'a,b,c' } });
  assert.equal(updated.persisted, true);
  let store = JSON.parse(await readFile(storePath, 'utf8'));
  assert.deepEqual(store.servers.gamma.env, { STUB_TOOLS: 'a,b,c' });

  const removed = await manager.remove('gamma');
  assert.equal(removed.persisted, true);
  store = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(store.servers.gamma, undefined);
  assert.equal(loader.store.has('mcp-manager-gamma'), false);
});

test('profile rows are runtime-only: toggle/update/remove warn about restart', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-p', config: { serverName: 'profile-srv', transport: 'streamable-http', url: 'https://p.example/mcp' } });
  const manager = createManager(ctx, { storePath });
  await manager.init();

  const listed = manager.list().servers.find((server) => server.serverName === 'profile-srv');
  assert.equal(listed.origin, 'profile');

  const off = await manager.setEnabled('profile-srv', false);
  assert.equal(off.persisted, false);
  assert.equal(off.server.status, 'disabled');

  const on = await manager.setEnabled('profile-srv', true);
  assert.equal(on.persisted, false);

  const updated = await manager.update('profile-srv', { url: 'https://p2.example/mcp' });
  assert.equal(updated.persisted, false);
  assert.match(updated.warning, /profile/);

  const removed = await manager.remove('profile-srv');
  assert.equal(removed.removed, true);
  assert.equal(removed.persisted, false);
  assert.match(removed.warning, /重启/);
});

test('add refuses a serverName already used by a profile row', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-p', config: { serverName: 'dup', transport: 'streamable-http', url: 'https://p.example/mcp' } });
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await assert.rejects(
    () => manager.add({ serverName: 'dup', transport: 'streamable-http', url: 'https://other.example/mcp' }),
    /已被 profile 条目/,
  );
});

// ─── 导入 ────────────────────────────────────────────────────────────────────

test('import previews and applies mcpServers JSON', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  const json = JSON.stringify({ mcpServers: { delta: { command: process.execPath, args: [STUB] } } });

  const preview = await manager.import({ json });
  assert.equal(preview.preview, true);
  assert.equal(preview.records.length, 1);
  assert.equal(preview.records[0].serverName, 'delta');

  const applied = await manager.import({ json }, { apply: true });
  assert.equal(applied.imported.length, 1);
  assert.equal(applied.imported[0].toolCount, 2);
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(store.servers.delta.transport, 'stdio');
});

test('scanImports returns empty sources when no known client config exists', async () => {
  const result = await scanImports({ onlyClients: ['definitely-not-installed'] });
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.candidates, []);
});

// ─── 探针 ────────────────────────────────────────────────────────────────────

test('stdio probe performs an initialize + tools/list handshake', async () => {
  const result = await probeRecord({
    serverName: 'stub',
    transport: 'stdio',
    command: process.execPath,
    args: [STUB],
    env: { STUB_TOOLS: 'a,b,c' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transport, 'stdio');
  assert.equal(result.toolCount, 3);
  assert.deepEqual(result.tools, ['a', 'b', 'c']);
  assert.ok(result.latencyMs >= 0);
});

test('stdio probe reports a clear error for a bad command', async () => {
  const result = await probeStdio({ serverName: 'nope', transport: 'stdio', command: '/definitely/not/a/binary', args: [] }, { timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('http probe performs an initialize + tools/list handshake', async (t) => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let message = {};
      try { message = JSON.parse(body); } catch { /* ignore */ }
      response.setHeader('content-type', 'application/json');
      if (message.method === 'initialize') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-stub', version: '1' } } }));
        return;
      }
      if (message.method === 'tools/list') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'x' }, { name: 'y' }] } }));
        return;
      }
      response.statusCode = 202;
      response.end('');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const result = await probeRecord({ serverName: 'http', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` });
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.toolCount, 2);
  assert.equal(result.serverInfo.name, 'http-stub');
});

// ─── 导出 ────────────────────────────────────────────────────────────────────

test('exportPatch redacts credentials and exportMcpServersJson uses ${ENV} placeholders', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({
    serverName: 'secret-srv',
    transport: 'streamable-http',
    url: 'https://s.example/mcp',
    headers: { Authorization: 'Bearer top-secret' },
  });
  const patch = await manager.export({ format: 'patch' });
  assert.match(patch.content, /serverName: secret-srv/);
  assert.match(patch.content, /!!js process\.env\.MCP_SECRET_SRV_AUTHORIZATION/);
  assert.doesNotMatch(patch.content, /top-secret/);

  const json = await manager.export({ format: 'json' });
  assert.match(json.content, /"mcpServers"/);
  assert.match(json.content, /\$\{MCP_SECRET_SRV_AUTHORIZATION\}/);
  assert.doesNotMatch(json.content, /top-secret/);

  const markdown = await manager.export({ format: 'markdown' });
  assert.match(markdown.content, /secret-srv/);
  assert.doesNotMatch(markdown.content, /top-secret/);
});

// ─── 脱敏 / JSONC / 探针诊断 ────────────────────────────────────────────────

test('sanitizeText strips credentials from free text', () => {
  const text = sanitizeText('Authorization: Bearer abcdef123456 got 401, url=https://u:p@h/mcp?token=secret123&x=1');
  assert.doesNotMatch(text, /abcdef123456/);
  assert.doesNotMatch(text, /secret123/);
  assert.doesNotMatch(text, /u:p@h/);
  assert.match(text, /\*\*\*/);
  assert.match(sanitizeText('x-api-key: sk-abcdefghijk'), /x-api-key=\*\*\*/);
  assert.match(sanitizeText('client_secret: "shhh"'), /client_secret[:=]\s*\*\*\*/);
  assert.equal(sanitizeText('plain text'), 'plain text');
  assert.ok(sanitizeText('a'.repeat(2000)).length <= 800);
});

test('sanitizeUrl hides userinfo and sensitive query params', () => {
  const url = sanitizeUrl('https://user:pass@example.com/mcp?token=abc&x=1');
  assert.doesNotMatch(url, /user:pass/);
  assert.doesNotMatch(url, /token=abc/);
  assert.match(url, /x=1/);
});

test('parseJsonRelaxed accepts JSONC and stripJsonc keeps strings intact', () => {
  const jsonc = `{
    // comment
    "mcpServers": {
      "a": { "url": "https://a.example/mcp?x=//not-a-comment", /* block */ "type": "http" },
    },
  }`;
  const parsed = parseJsonRelaxed(jsonc);
  assert.equal(parsed.mcpServers.a.url, 'https://a.example/mcp?x=//not-a-comment');
  assert.equal(parsed.mcpServers.a.type, 'http');
  const stripped = stripJsonc(jsonc);
  assert.doesNotMatch(stripped, /\/\/\s*comment/);
  assert.doesNotMatch(stripped, /\/\*\s*block\s*\*\//);
  assert.match(stripped, /x=\/\/not-a-comment/);
});

test('import plan supports skip / overwrite / rename for conflicts', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-p', config: { serverName: 'keep', transport: 'streamable-http', url: 'https://p.example/mcp' } });
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'managed-one', transport: 'streamable-http', url: 'https://m.example/mcp' });

  const json = JSON.stringify({
    mcpServers: {
      keep: { command: process.execPath, args: [STUB] },
      'managed-one': { command: process.execPath, args: [STUB] },
      fresh: { command: process.execPath, args: [STUB] },
    },
  });

  // 预览：标注冲突
  const preview = await manager.import({ json });
  const byName = Object.fromEntries(preview.records.map((record) => [record.serverName, record]));
  assert.equal(byName.keep.conflict, 'profile');
  assert.equal(byName['managed-one'].conflict, 'managed');
  assert.equal(byName.fresh.conflict, undefined);

  // 默认 skip：只导入 fresh，两个冲突进 skipped
  const skippedRun = await manager.import({ json }, { apply: true });
  assert.deepEqual(skippedRun.imported.map((item) => item.serverName), ['fresh']);
  assert.equal(skippedRun.skipped.filter((item) => item.includes('已存在')).length, 2);

  // overwrite：受管记录可覆盖，profile 行跳过
  const overwriteRun = await manager.import({ json }, { apply: true, onConflict: 'overwrite' });
  assert.ok(overwriteRun.imported.some((item) => item.serverName === 'managed-one' && item.updated === true));
  assert.ok(overwriteRun.skipped.some((item) => item.includes('profile 静态声明')));

  // rename：未存在过的名字变成 -2
  const renameRun = await manager.import({
    json: JSON.stringify({ mcpServers: { fresh: { command: process.execPath, args: [STUB] } } }),
  }, { apply: true, onConflict: 'rename' });
  assert.deepEqual(renameRun.imported.map((item) => item.serverName), ['fresh-2']);

  // enabled=false：导入但不启用
  const disabledRun = await manager.import({
    json: JSON.stringify({ mcpServers: { dormant: { command: process.execPath, args: [STUB] } } }),
  }, { apply: true, enabled: false });
  assert.equal(disabledRun.imported.length, 1);
  const dormant = manager.list().servers.find((server) => server.serverName === 'dormant');
  assert.equal(dormant.status, 'disabled');
});

test('probe reports structured error codes', async () => {
  const refused = await probeRecord({ serverName: 'x', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }, { timeoutMs: 3000 });
  assert.equal(refused.ok, false);
  assert.ok(['connection_refused', 'timeout', 'unknown', 'http_4xx', 'http_5xx'].includes(refused.errorCode));

  const missing = await probeStdio({ serverName: 'x', transport: 'stdio', command: '/definitely/not/a/binary', args: [] }, { timeoutMs: 2000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'command_not_found');
});

// ─── 工具定义 ────────────────────────────────────────────────────────────────

test('registered tools declare schemas accepted by the harness subset', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  registerTools(ctx, manager);
  const names = [...ctx.tools.defs.keys()].filter((name) => name.startsWith('mcp_manager_')).sort();
  assert.deepEqual(names, [
    'mcp_manager_add',
    'mcp_manager_export',
    'mcp_manager_import',
    'mcp_manager_inspect',
    'mcp_manager_list',
    'mcp_manager_probe',
    'mcp_manager_remove',
    'mcp_manager_scan',
    'mcp_manager_set_enabled',
    'mcp_manager_update',
  ]);
  for (const definition of ctx.tools.defs.values()) {
    if (!definition.name.startsWith('mcp_manager_')) continue;
    checkSchema(definition.parameters ?? { type: 'object' }, `${definition.name}.parameters`);
    checkSchema(definition.output.schema, `${definition.name}.output.schema`);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('tool round trip: add → list → probe → export → remove', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  registerTools(ctx, manager);
  const tool = (name) => ctx.tools.defs.get(name);

  const added = await tool('mcp_manager_add').execute({ serverName: 'rt', transport: 'stdio', command: process.execPath, args: [STUB] });
  assert.equal(added.ok, true);
  assert.equal(added.toolCount, 2);

  const listed = await tool('mcp_manager_list').execute({ verbose: true });
  assert.equal(listed.servers.length, 1);
  assert.deepEqual(listed.servers[0].tools, ['echo', 'ping']);

  const probed = await tool('mcp_manager_probe').execute({ server: 'rt' });
  assert.equal(probed.reachable, true);
  assert.equal(probed.toolCount, 2);

  const exported = await tool('mcp_manager_export').execute({ format: 'json' });
  assert.match(exported.content, /"rt"/);

  const removed = await tool('mcp_manager_remove').execute({ server: 'rt' });
  assert.equal(removed.removed, true);
  assert.equal((await tool('mcp_manager_list').execute({})).servers.length, 0);
});

test('plugin config normalization keeps defaults', () => {
  assert.deepEqual(normalizePluginConfig(undefined), { webApi: true, includeDescriptions: true, storePath: undefined });
  assert.deepEqual(normalizePluginConfig({ webApi: false, includeDescriptions: false, storePath: '/tmp/x.json' }), { webApi: false, includeDescriptions: false, storePath: '/tmp/x.json' });
});
