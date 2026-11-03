/**
 * dsh-mcp-manager Host 半区离线测试（不启动 Harness）。
 *
 * 覆盖：清单/解析、受管存储持久化、启停/增删/编辑、mcpServers 导入导出、
 * MCP 握手探针（stdio + streamable-http）、工具 schema 子集校验。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManager, normalizePluginConfig } from '../lib/index.js';
import { registerTools } from '../lib/tools.js';
import { normalizeRecord, toMcpServersJson, fromMcpServersJson } from '../lib/config.js';
import { scanImports, parseMcpServersText, parseJsonRelaxed, stripJsonc } from '../lib/importers.js';
import { sanitizeText, sanitizeUrl } from '../lib/sanitize.js';
import { probeRecord, probeStdio } from '../lib/probe.js';
import { PrefsStore } from '../lib/prefs.js';
import { detectApp } from '../lib/apps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'fixtures', 'stub-mcp.mjs');
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

// ─── 假运行时 ────────────────────────────────────────────────────────────────

class FakeTools {
  defs = new Map();
  calls = [];
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
  /** 模拟宿主执行管线：echo 回显参数、fail 返回错误、slow 等待 signal 中止。 */
  async execute(exec) {
    this.calls.push({ name: exec.name, arguments: exec.arguments });
    const serverName = exec.name.slice('mcp__'.length, exec.name.lastIndexOf('__'));
    const toolName = exec.name.slice(exec.name.lastIndexOf('__') + 2);
    if (toolName === 'fail') {
      return {
        isError: true,
        error: { message: 'stub failure', info: { code: 'STUB_FAIL' } },
        content: [{ type: 'text', text: 'stub failure' }],
      };
    }
    if (toolName === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { isError: false, value: { slow: true }, content: [{ type: 'text', text: 'slow done' }] };
    }
    return {
      isError: false,
      value: { serverName, toolName, arguments: exec.arguments },
      content: [{ type: 'text', text: `${serverName}:${toolName}:ok` }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    };
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
    'mcp_manager_apps',
    'mcp_manager_call_tool',
    'mcp_manager_export',
    'mcp_manager_import',
    'mcp_manager_inspect',
    'mcp_manager_list',
    'mcp_manager_prefs',
    'mcp_manager_probe',
    'mcp_manager_probe_many',
    'mcp_manager_remove',
    'mcp_manager_scan',
    'mcp_manager_set_enabled',
    'mcp_manager_store_repair',
    'mcp_manager_tools',
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
  assert.deepEqual(normalizePluginConfig(undefined), { webApi: true, includeDescriptions: true, storePath: undefined, prefsPath: undefined });
  assert.deepEqual(
    normalizePluginConfig({ webApi: false, includeDescriptions: false, storePath: '/tmp/x.json', prefsPath: '/tmp/p.json' }),
    { webApi: false, includeDescriptions: false, storePath: '/tmp/x.json', prefsPath: '/tmp/p.json' },
  );
});

// ─── v0.3：偏好存储 / 工具目录 / 工具试用 / 高级配置 / 诊断 ───────────────────

test('PrefsStore persists pins/tags/notes, bounds probe history and writes 0600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'prefs.json');
  const store = new PrefsStore({ path });
  await store.load();
  for (let index = 0; index < 25; index += 1) {
    await store.recordProbe('svc-a', {
      at: Date.now() + index,
      ok: index % 2 === 0,
      latencyMs: index,
      toolCount: 2,
      errorCode: index % 2 === 0 ? undefined : 'timeout',
    });
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.servers['svc-a'].history.length, 20);
  assert.equal(snapshot.servers['svc-a'].probe.latencyMs, 24);
  assert.equal(snapshot.servers['svc-a'].probe.ok, true);

  const next = await store.patchServer('svc-a', { pinned: true, tags: [' 办公 ', '办公', '法务'], note: '内网服务' });
  assert.equal(next.pinned, true);
  assert.deepEqual(next.tags, ['办公', '法务']);
  assert.equal(next.note, '内网服务');
  // null 清除
  const cleared = await store.patchServer('svc-a', { note: null, tags: null, pinned: null });
  assert.equal(cleared.pinned, undefined);
  assert.equal(cleared.tags, undefined);
  assert.equal(cleared.note, undefined);
  assert.equal(cleared.history.length, 20);

  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600);

  // 坏文件不覆盖、只报错
  await writeFile(path, '{ not json', 'utf8');
  const broken = new PrefsStore({ path });
  await broken.load();
  assert.ok(broken.loadError);
  await assert.rejects(() => broken.patchServer('x', { pinned: true }), /prefs/);
  assert.equal(await readFile(path, 'utf8'), '{ not json');
});

test('tool catalog, detail and invoke go through ctx.tools.execute', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'tools-one', transport: 'streamable-http', url: 'https://tools.example/mcp' });
  // 额外的假工具：一个返回错误、一个慢
  ctx.tools.register({ name: 'mcp__tools-one__fail', description: 'fail', parameters: { type: 'object', properties: {} } });
  ctx.tools.register({ name: 'mcp__tools-one__slow', description: 'slow', parameters: { type: 'object', properties: {} } });

  const catalog = manager.toolCatalog({});
  assert.ok(catalog.total >= 2);
  assert.ok(catalog.tools.every((tool) => tool.toolName !== 'mcp_manager_list'));
  const echo = catalog.tools.find((tool) => tool.toolName === 'echo');
  assert.equal(echo.serverName, 'tools-one');
  assert.equal(echo.parameters, undefined);

  const withSchema = manager.toolCatalog({ server: 'tools-one', includeSchema: true });
  assert.ok(withSchema.tools.every((tool) => tool.parameters !== undefined));
  assert.equal(manager.toolCatalog({ query: 'echo' }).total, 1);
  assert.equal(manager.toolCatalog({ limit: 1 }).returned, 1);

  const detail = manager.toolDetail('tools-one', 'echo');
  assert.equal(detail.publicName, 'mcp__tools-one__echo');
  assert.deepEqual(detail.sampleArguments, {});

  const ok = await manager.invokeTool({ server: 'tools-one', tool: 'echo', arguments: { a: 1 } });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /tools-one:echo:ok/);
  assert.match(ok.text, /\[image image\/png/);
  assert.equal(ctx.tools.calls.length, 1);
  assert.deepEqual(ctx.tools.calls[0].arguments, { a: 1 });

  const failed = await manager.invokeTool({ server: 'tools-one', tool: 'fail', arguments: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.isError, true);
  assert.equal(failed.error.code, 'STUB_FAIL');

  const timedOut = await manager.invokeTool({ server: 'tools-one', tool: 'slow', arguments: {}, timeoutMs: 1000 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'timeout');

  const missing = await manager.invokeTool({ server: 'tools-one', tool: 'nope', arguments: {} });
  assert.equal(missing.code, 'tool-not-found');
  assert.ok(missing.message.includes('echo'));

  const badArgs = await manager.invokeTool({ server: 'tools-one', tool: 'echo', arguments: [1, 2] });
  assert.equal(badArgs.code, 'invalid-arguments');

  const before = ctx.tools.calls.length;
  const dry = await manager.invokeTool({ server: 'tools-one', tool: 'echo', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(ctx.tools.calls.length, before);

  const foreign = await manager.invokeTool({ server: 'tools-one', tool: 'mcp_manager_list', args: {} });
  assert.equal(foreign.code, 'tool-not-found');
});

test('advanced dsh-mcp-client fields survive normalize → edit → export', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({
    serverName: 'adv-one',
    transport: 'streamable-http',
    url: 'https://adv.example/mcp',
    reconnect: { enabled: true, initialDelayMs: 500, maxAttempts: 5 },
    failOnStartupError: true,
    maxInstructionBytes: 65536,
  });
  const view = manager.configForEdit('adv-one');
  assert.equal(view.advanced.reconnect.maxAttempts, 5);
  assert.equal(view.advanced.failOnStartupError, true);
  assert.equal(view.advanced.maxInstructionBytes, 65536);

  const patched = await manager.update('adv-one', { reconnect: { maxAttempts: 7 } });
  assert.equal(patched.persisted, true);
  assert.equal(manager.configForEdit('adv-one').advanced.reconnect.maxAttempts, 7);
  assert.equal(manager.configForEdit('adv-one').advanced.reconnect.initialDelayMs, 500);

  const exported = await manager.export({ format: 'patch', server: 'adv-one' });
  assert.match(exported.content, /reconnect/);
  assert.match(exported.content, /maxInstructionBytes/);

  assert.throws(
    () => normalizeRecord({ serverName: 'bad', transport: 'streamable-http', url: 'https://x.example/mcp', reconnect: { maxAttempts: 1000 } }),
    /maxAttempts/,
  );
  assert.throws(
    () => normalizeRecord({ serverName: 'bad', transport: 'streamable-http', url: 'https://x.example/mcp', maxInstructionBytes: 1 }),
    /maxInstructionBytes/,
  );
});

test('probe records history and diagnostics export summarizes it', async (t) => {
  const storePath = await tempStore(t);
  const prefsPath = join(dirname(storePath), 'prefs.json');
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath, prefsPath });
  await manager.init();
  await manager.add({ serverName: 'diag-one', transport: 'stdio', command: process.execPath, args: [STUB] });
  const probed = await manager.probe('diag-one');
  assert.equal(probed.ok, true);
  assert.ok(Array.isArray(probed.history));
  assert.equal(probed.history.length, 1);
  assert.equal(probed.history[0].ok, true);

  await manager.patchPrefs('diag-one', { pinned: true, tags: ['测试'], note: '诊断用' });
  const state = manager.state();
  assert.equal(state.prefs.servers['diag-one'].pinned, true);
  assert.equal(state.prefsPath, prefsPath);

  const report = await manager.export({ format: 'diagnostics' });
  assert.match(report.content, /# MCP 诊断报告/);
  assert.match(report.content, /## 服务清单/);
  assert.match(report.content, /## 探针历史/);
  assert.match(report.content, /diag-one/);
  assert.match(report.content, /收藏的服务/);

  const many = await manager.probeMany({ servers: ['diag-one'], timeoutMs: 5000 });
  assert.equal(many.total, 1);
  assert.equal(many.ok, 1);
  assert.equal(many.results[0].serverName, 'diag-one');
});

test('export supports multi-server selection', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'exp-a', transport: 'streamable-http', url: 'https://a.example/mcp' });
  await manager.add({ serverName: 'exp-b', transport: 'streamable-http', url: 'https://b.example/mcp' });
  const json = await manager.export({ format: 'json', servers: ['exp-a'] });
  assert.match(json.content, /"exp-a"/);
  assert.doesNotMatch(json.content, /"exp-b"/);
});

// ─── v0.3：安全与契约修复（对应审计 P0/P1） ───────────────────────────────────

test('patch export defaults to managed-only and profile rows become override fragments', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'mcp-profile-row', config: { serverName: 'profile-row', transport: 'streamable-http', url: 'https://p.example/mcp' } });
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'managed-row', transport: 'streamable-http', url: 'https://m.example/mcp' });

  const onlyManaged = await manager.export({ format: 'patch' });
  assert.match(onlyManaged.content, /serverName: managed-row/);
  assert.doesNotMatch(onlyManaged.content, /serverName: profile-row/);
  assert.ok(onlyManaged.warnings.some((warning) => warning.includes('profile')));

  const withProfile = await manager.export({ format: 'patch', includeProfile: true });
  assert.match(withProfile.content, /- insert:/);
  // profile 行必须是 override（顶层 - id），不能塞进 insert
  assert.match(withProfile.content, /^- id: mcp-profile-row$/m);
  assert.match(withProfile.content, /^- insert:$/m);
});

test('configForEdit masks credential URLs and empty url keeps the original', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'url-secret', transport: 'streamable-http', url: 'https://api.example/mcp?key=SECRET123' });

  const view = manager.configForEdit('url-secret');
  assert.equal(view.urlMasked, true);
  assert.doesNotMatch(view.url, /SECRET123/);
  assert.match(view.url, /key=\*\*\*/);

  await manager.update('url-secret', { url: '' });
  const after = manager.configForEdit('url-secret');
  assert.equal(after.urlMasked, true);
  const exported = await manager.export({ format: 'json', redact: false });
  assert.match(exported.content, /SECRET123/); // 空 url 没有覆盖掉原值
});

test('import rejects files that were not discovered by scan()', async (t) => {
  const storePath = await tempStore(t);
  const dir = dirname(storePath);
  const rogue = join(dir, 'rogue.json');
  await writeFile(rogue, JSON.stringify({ mcpServers: { rogue: { command: 'node' } } }), 'utf8');
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await assert.rejects(
    () => manager.import({ file: rogue }),
    (error) => error.code === 'import-file-untrusted',
  );
});

test('export redacts URL query values and stdio args placeholders', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({
    serverName: 'args-srv',
    transport: 'stdio',
    command: 'node',
    args: ['server.js', '--token', 'super-secret-token', '--api-key=another-secret-value'],
    env: { NORMAL: 'plain-value', TALL: 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm' },
  });
  const patch = await manager.export({ format: 'patch', server: 'args-srv' });
  assert.doesNotMatch(patch.content, /super-secret-token/);
  assert.doesNotMatch(patch.content, /another-secret-value/);
  assert.doesNotMatch(patch.content, /Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm/);
  assert.match(patch.content, /\$\{MCP_ARGS_SRV_ARG_1\}/);

  const json = await manager.export({ format: 'json', server: 'args-srv' });
  assert.doesNotMatch(json.content, /super-secret-token/);
});

test('YAML export quotes unsafe keys and uses block scalars for multiline values', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({
    serverName: 'yaml-srv',
    transport: 'stdio',
    command: 'node',
    args: ['x'],
    env: { 'X: INJECTED': 'v1', 'ATVAL': '@reserved', 'NUM': '123', 'MULTI': 'line1\nline2' },
  });
  const patch = await manager.export({ format: 'patch', server: 'yaml-srv', redact: false });
  assert.match(patch.content, /'X: INJECTED': v1/);
  assert.match(patch.content, /ATVAL: '@reserved'/);
  assert.match(patch.content, /NUM: '123'/);
  assert.match(patch.content, /MULTI: \|-/);
});

test('state strips tool descriptions, reports summary toolCount and keeps createdAt', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  await manager.add({ serverName: 'state-srv', transport: 'streamable-http', url: 'https://s.example/mcp' });
  const state = manager.state();
  const server = state.servers.find((item) => item.serverName === 'state-srv');
  assert.deepEqual(server.tools, []);
  assert.ok(Array.isArray(server.toolNames));
  assert.equal(state.toolCount, state.summary.toolCount);

  const createdAt = manager.store.get('state-srv').createdAt;
  assert.ok(Number.isFinite(createdAt));
  // 重新加载存储也要保住 createdAt
  const again = createManager(ctx, { storePath });
  await again.init();
  assert.equal(again.store.get('state-srv').createdAt, createdAt);
});

test('remove on a not-provisioned managed record reports removed and persisted', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  // 直接写入一条受管记录但不 provision（模拟启动失败）
  await manager.store.mutate((draft) => {
    draft.servers['ghost-srv'] = normalizeRecord(
      { serverName: 'ghost-srv', transport: 'streamable-http', url: 'https://ghost.example/mcp' },
      { source: 'managed' },
    );
    return null;
  });
  const result = await manager.remove('ghost-srv');
  assert.equal(result.removed, true);
  assert.equal(result.persisted, true);
  assert.equal(result.entryRemoved, false);
  assert.equal(manager.store.get('ghost-srv'), undefined);
});

test('new conversation tools round trip: tools / call_tool / prefs / probe_many', async (t) => {
  const storePath = await tempStore(t);
  const { ctx } = makeCtx();
  const manager = createManager(ctx, { storePath });
  await manager.init();
  registerTools(ctx, manager);
  const tool = (name) => ctx.tools.defs.get(name);
  await manager.add({ serverName: 'conv-srv', transport: 'streamable-http', url: 'https://c.example/mcp' });

  const catalog = await tool('mcp_manager_tools').execute({ query: 'echo' });
  assert.equal(catalog.total, 1);
  assert.equal(catalog.tools[0].serverName, 'conv-srv');

  const dry = await tool('mcp_manager_call_tool').execute({ server: 'conv-srv', tool: 'echo', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.parametersJson.includes('properties'));

  const called = await tool('mcp_manager_call_tool').execute({ server: 'conv-srv', tool: 'echo', arguments: { q: 1 } });
  assert.equal(called.ok, true);
  assert.match(called.text, /conv-srv:echo:ok/);

  const patched = await tool('mcp_manager_prefs').execute({ action: 'patch', server: 'conv-srv', patch: { pinned: true, tags: ['x'] } });
  assert.equal(patched.server.pinned, true);
  const listed = await tool('mcp_manager_prefs').execute({ action: 'get' });
  assert.equal(listed.servers['conv-srv'].tags[0], 'x');

  const probed = await tool('mcp_manager_probe_many').execute({ servers: ['conv-srv'] });
  assert.equal(probed.total, 1);
});

// ─── v0.4：按应用归类 ────────────────────────────────────────────────────────

test('detectApp matches catalog, host, prefix, manual override and singleton fallback', () => {
  const siblings = ['fuyao-a-share', 'fuyao-fund', 'amap', 'qcc-company', 'custom-svc'];
  assert.deepEqual(
    (({ id, name }) => ({ id, name }))(detectApp({ serverName: 'fuyao-a-share', siblings })),
    { id: 'fuyao', name: '同花顺' },
  );
  assert.equal(detectApp({ serverName: 'amap', endpoint: 'https://mcp.amap.com/mcp?key=***' }).id, 'amap');
  assert.equal(detectApp({ serverName: 'qcc-risk', config: { transport: 'streamable-http', url: 'https://agent.qcc.com/mcp/risk/stream' } }).id, 'qcc');
  assert.equal(detectApp({ serverName: 'gh', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } }).id, 'github');
  const hostApp = detectApp({ serverName: 'custom-svc', endpoint: 'https://api.example.com/mcp' });
  assert.equal(hostApp.id, 'host:example.com');
  assert.equal(hostApp.name, 'example.com');
  assert.equal(detectApp({ serverName: 'mystery-svc', siblings: ['other-svc'] }).source, 'self');
  assert.equal(detectApp({ serverName: 'x', manual: '同花顺' }).id, 'fuyao');
  assert.equal(detectApp({ serverName: 'x', manual: '我的内网工具' }).id, 'manual:我的内网工具');
});

test('state groups servers by app and prefs can override the app name', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-amap', config: { serverName: 'amap', transport: 'streamable-http', url: 'https://mcp.amap.com/mcp' } });
  loader.addEntry({ id: 'include:mcp-fuyao-1', config: { serverName: 'fuyao-a-share', transport: 'streamable-http', url: 'https://fuyao.aicubes.cn/mcp/a-share' } });
  loader.addEntry({ id: 'include:mcp-fuyao-2', config: { serverName: 'fuyao-fund', transport: 'streamable-http', url: 'https://fuyao.aicubes.cn/mcp/fund' } });
  loader.addEntry({ id: 'include:mcp-custom', config: { serverName: 'custom-svc', transport: 'streamable-http', url: 'https://api.example.com/mcp' } });
  const manager = createManager(ctx, { storePath, prefsPath: join(dirname(storePath), 'prefs.json') });
  await manager.init();

  const state = manager.state();
  const byName = Object.fromEntries(state.apps.map((app) => [app.name, app]));
  assert.equal(byName['高德地图'].total, 1);
  assert.equal(byName['同花顺'].total, 2);
  assert.ok(byName['同花顺'].serverNames.includes('fuyao-a-share'));
  assert.equal(byName['example.com'].total, 1);
  assert.ok(byName['高德地图'].icon);

  // 手动归类：把 custom-svc 改名为「内部小工具」
  await manager.patchPrefs('custom-svc', { app: '内部小工具' });
  const renamed = manager.state();
  const custom = renamed.servers.find((server) => server.serverName === 'custom-svc');
  assert.equal(custom.app.name, '内部小工具');
  assert.equal(custom.app.source, 'manual');
  assert.ok(renamed.apps.some((app) => app.name === '内部小工具' && app.total === 1));
  assert.ok(!renamed.apps.some((app) => app.name === 'example.com'));

  // 清空覆盖 → 回到自动识别
  await manager.patchPrefs('custom-svc', { app: null });
  assert.equal(manager.state().servers.find((server) => server.serverName === 'custom-svc').app.source, 'host');

  const markdown = await manager.export({ format: 'markdown' });
  assert.match(markdown.content, /\| 应用 \|/);
  assert.match(markdown.content, /同花顺/);
});

test('mcp_manager_apps lists grouped apps', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-amap', config: { serverName: 'amap', transport: 'streamable-http', url: 'https://mcp.amap.com/mcp' } });
  loader.addEntry({ id: 'include:mcp-qcc', config: { serverName: 'qcc-company', transport: 'streamable-http', url: 'https://agent.qcc.com/mcp/company/stream' } });
  const manager = createManager(ctx, { storePath });
  await manager.init();
  registerTools(ctx, manager);
  const tool = ctx.tools.defs.get('mcp_manager_apps');
  const result = await tool.execute({});
  assert.equal(result.apps.length, 2);
  assert.ok(result.apps.some((app) => app.name === '高德地图' && app.total === 1));
  assert.ok(result.apps.some((app) => app.name === '企查查' && app.serverIds.length === 1));
  const filtered = await tool.execute({ query: '高德' });
  assert.equal(filtered.apps.length, 1);
});

test('renameApp overrides a whole app group and can be reset', async (t) => {
  const storePath = await tempStore(t);
  const { ctx, loader } = makeCtx();
  loader.addEntry({ id: 'include:mcp-fuyao-1', config: { serverName: 'fuyao-a-share', transport: 'streamable-http', url: 'https://fuyao.aicubes.cn/mcp/a-share' } });
  loader.addEntry({ id: 'include:mcp-fuyao-2', config: { serverName: 'fuyao-fund', transport: 'streamable-http', url: 'https://fuyao.aicubes.cn/mcp/fund' } });
  const manager = createManager(ctx, { storePath, prefsPath: join(dirname(storePath), 'prefs.json') });
  await manager.init();

  const renamed = await manager.renameApp('fuyao', '同花顺行情');
  assert.equal(renamed.updated, 2);
  const state = manager.state();
  const group = state.apps.find((app) => app.name === '同花顺行情');
  assert.ok(group);
  assert.equal(group.total, 2);
  assert.ok(group.serverNames.includes('fuyao-a-share') && group.serverNames.includes('fuyao-fund'));

  // 改回已知目录名：id 会并回 fuyao
  const back = await manager.renameApp('同花顺行情', '同花顺');
  assert.equal(back.name, '同花顺');
  const after = manager.state();
  assert.equal(after.servers.find((server) => server.serverName === 'fuyao-fund').app.id, 'fuyao');
  assert.equal(after.servers.find((server) => server.serverName === 'fuyao-fund').app.source, 'manual');

  // 清除覆盖 → 自动识别（catalog）
  await manager.renameApp('fuyao', null);
  const reset = manager.state();
  assert.equal(reset.servers.find((server) => server.serverName === 'fuyao-fund').app.source, 'catalog');
  await assert.rejects(() => manager.renameApp('不存在的应用', 'x'), /找不到应用分组/);
});
