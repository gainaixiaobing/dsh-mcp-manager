/**
 * dsh-mcp-manager 主机半区离线测试（不依赖 dsh 运行时）。
 *
 * 覆盖：条目枚举与状态判定、服务解析、启停、新增/更新、移除、导出脱敏，
 * 以及注册到 ToolRuntime 的工具定义是否满足 Harness 的 JSON Schema 子集。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, createManager, normalizePluginConfig } from '../index.js';

// ─── 假运行时 ────────────────────────────────────────────────────────────────

class FakeTools {
  constructor() {
    this.defs = new Map();
  }

  register(definition) {
    if (!definition?.name) throw new Error('tool name required');
    if (this.defs.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
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

class FakeLoader {
  constructor() {
    this.store = new Map();
    this.counter = 0;
  }

  /** 注册一个 mcp-client 条目；enabled 时同步注册它的工具。 */
  addEntry({ id, config, enabled = true }) {
    const entry = {
      options: { id, name: '@deepseek-ai/dsh-mcp-client', config, disabled: !enabled },
      fiber: null,
      toolNames: [],
    };
    Object.defineProperty(entry, 'id', { get: () => entry.options.id });
    Object.defineProperty(entry, 'disabled', { get: () => Boolean(entry.options.disabled) });
    this.store.set(id, entry);
    if (enabled) {
      entry.fiber = { config };
      this.mountTools(entry);
    }
    return entry;
  }

  mountTools(entry) {
    const serverName = entry.options.config.serverName;
    const tools = {
      echo: `Echo tool for ${serverName}`,
      ping: `Ping tool for ${serverName}`,
    };
    entry.toolNames = [];
    for (const [raw, description] of Object.entries(tools)) {
      try {
        this.tools.register({
          name: `mcp__${serverName}__${raw}`,
          description,
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        });
        entry.toolNames.push(raw);
      } catch {
        // 真实注册表会拒绝同名工具：后注册的同名服务拿不到工具，仅记录一条告警。
      }
    }
  }

  unmountTools(entry) {
    const serverName = entry.options.config.serverName;
    for (const raw of entry.toolNames) this.tools.defs.delete(`mcp__${serverName}__${raw}`);
    entry.toolNames = [];
  }

  entries() {
    return this.store.values();
  }

  resolve(id) {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`cannot resolve entry ${id}`);
    return entry;
  }

  async create(options) {
    if (this.store.has(options.id)) throw new Error(`duplicate entry ${options.id}`);
    return this.addEntry({ id: options.id, config: options.config, enabled: options.disabled !== true });
  }

  async update(id, options) {
    const entry = this.resolve(id);
    const wasEnabled = !entry.disabled;
    Object.assign(entry.options, options);
    if (entry.disabled) {
      if (wasEnabled) this.unmountTools(entry);
      entry.fiber = null;
    } else {
      entry.fiber = { config: entry.options.config };
      if (!wasEnabled || !entry.toolNames?.length) this.mountTools(entry);
    }
  }

  remove(id) {
    const entry = this.resolve(id);
    if (!entry.disabled) this.unmountTools(entry);
    this.store.delete(id);
  }
}

function makeCtx({ entries = [], tools } = {}) {
  const loader = new FakeLoader();
  loader.tools = tools ?? new FakeTools();
  for (const spec of entries) loader.addEntry(spec);
  const ctx = {
    tools: loader.tools,
    loader,
    logger: { info() {}, warn() {} },
    effect() {},
    inject() {},
  };
  return { ctx, loader };
}

// ─── Harness JSON Schema 子集校验 ────────────────────────────────────────────

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
]);

function checkSchema(schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path} must be a schema object`);
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required)) {
      throw new Error(`${path}.required must be an array at object level (property-level required:true is not accepted by raw definitions)`);
    }
    const properties = schema.properties ?? {};
    for (const name of schema.required) {
      if (!Object.hasOwn(properties, name)) throw new Error(`${path}.required names undeclared property ${name}`);
    }
  }
  if (Object.hasOwn(schema, 'type')) {
    if (!SCHEMA_TYPES.has(schema.type)) throw new Error(`${path}.type invalid: ${schema.type}`);
    if (schema.type === 'object') {
      if (schema.properties !== undefined && typeof schema.properties !== 'object') {
        throw new Error(`${path}.properties must be an object`);
      }
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
        throw new Error(`${path}.additionalProperties must be boolean`);
      }
    }
    if (schema.type === 'array' && schema.items !== undefined) checkSchema(schema.items, `${path}.items`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    checkSchema(child, `${path}.properties.${name}`);
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`));
  }
}

// ─── 测试 ────────────────────────────────────────────────────────────────────

test('plugin exports a Cordis plugin shape', () => {
  assert.equal(typeof apply, 'function');
  const config = normalizePluginConfig({ webApi: false, unknown: 1 });
  assert.deepEqual(config, { webApi: false, includeDescriptions: true });
});

test('list reports enabled/disabled servers and per-server tool counts', () => {
  const { ctx } = makeCtx({
    entries: [
      { id: 'mcp-a', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://example.com/mcp?token=secret' } },
      { id: 'mcp-b', config: { serverName: 'beta', transport: 'stdio', command: '/usr/bin/node', args: ['x'] }, enabled: false },
    ],
  });
  const manager = createManager(ctx);
  const { servers, summary } = manager.list();
  assert.equal(servers.length, 2);
  const alpha = servers.find((server) => server.serverName === 'alpha');
  assert.equal(alpha.status, 'connected');
  assert.equal(alpha.toolCount, 2);
  assert.equal(alpha.endpoint, 'https://example.com/mcp', 'query string must be redacted');
  const beta = servers.find((server) => server.serverName === 'beta');
  assert.equal(beta.status, 'disabled');
  assert.equal(beta.toolCount, 0);
  assert.equal(beta.endpoint, 'node（+1 个参数）');
  assert.equal(summary.total, 2);
  assert.equal(summary.enabled, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.connected, 1);
  assert.equal(summary.toolCount, 2);
});

test('resolve accepts exact name, entry id, and unique substring', () => {
  const { ctx } = makeCtx({
    entries: [
      { id: 'mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } },
      { id: 'mcp-beta', config: { serverName: 'beta', transport: 'streamable-http', url: 'https://b.example/mcp' } },
    ],
  });
  const manager = createManager(ctx);
  assert.equal(manager.inspect('alpha').serverName, 'alpha');
  assert.equal(manager.inspect('mcp-beta').serverName, 'beta');
  assert.equal(manager.inspect('alph').serverName, 'alpha');
  assert.throws(() => manager.inspect('zzz'), /找不到 MCP 服务/);
  assert.throws(() => manager.inspect(''), /缺少 server 参数/);
});

test('duplicate serverName entries are flagged instead of silently double-counted', () => {
  const { ctx } = makeCtx({
    entries: [
      { id: 'include:mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } },
      { id: 'mcp-alpha-alpha', config: { serverName: 'alpha', transport: 'stdio', command: 'node', args: ['x'] } },
      { id: 'include:mcp-beta', config: { serverName: 'beta', transport: 'streamable-http', url: 'https://b.example/mcp' } },
    ],
  });
  const manager = createManager(ctx);
  const { servers, summary } = manager.list();
  assert.equal(summary.total, 3);
  assert.equal(summary.uniqueServers, 2);
  assert.equal(summary.duplicateServers, 1);
  assert.equal(summary.toolCount, 4, 'tools are counted once per shared namespace');
  const alpha = servers.filter((server) => server.serverName === 'alpha');
  assert.equal(alpha.length, 2);
  assert.ok(alpha.every((server) => server.duplicate === true));
  assert.equal(alpha.find((server) => server.origin === 'profile').id, 'include:mcp-alpha');
  assert.equal(alpha.find((server) => server.origin === 'plugin').id, 'mcp-alpha-alpha');

  // 同名时不能靠服务名猜：必须用条目 id
  assert.throws(() => manager.inspect('alpha'), /2 个同名条目/);
  assert.equal(manager.inspect('include:mcp-alpha').id, 'include:mcp-alpha');
  assert.equal(manager.inspect('mcp-alpha-alpha').id, 'mcp-alpha-alpha');
  // 宿主合成树里条目 id 带 include: 前缀，允许省略前缀传短 id
  assert.equal(manager.inspect('mcp-alpha').id, 'include:mcp-alpha');
});

test('re-enabling a failed entry retries apply and can recover', async () => {
  const { ctx, loader } = makeCtx();
  const entry = loader.addEntry({
    id: 'mcp-broken',
    config: { serverName: 'broken', transport: 'streamable-http', url: 'https://broken.example/mcp' },
  });
  entry.fiber = undefined; // 模拟 apply 抛错
  entry.toolNames = [];
  for (const name of [...loader.tools.defs.keys()]) loader.tools.defs.delete(name);
  const manager = createManager(ctx);
  assert.equal(manager.list().servers[0].status, 'failed');

  const retried = await manager.setEnabled('mcp-broken', true);
  assert.equal(retried.retried, true);
  assert.equal(retried.server.status, 'connected');
  assert.equal(retried.server.toolCount, 2);
});

test('an enabled entry without a fiber is reported as failed, not connected', () => {
  const { ctx, loader } = makeCtx();
  const entry = loader.addEntry({
    id: 'mcp-broken',
    config: { serverName: 'broken', transport: 'streamable-http', url: 'https://broken.example/mcp' },
  });
  entry.fiber = undefined; // 模拟 apply 抛错：条目保留但从未启动
  const manager = createManager(ctx);
  const { servers, summary } = manager.list();
  assert.equal(servers[0].status, 'failed');
  assert.equal(servers[0].loaded, false);
  assert.equal(servers[0].toolCount, 0, 'a failed entry must not claim namespace tools');
  assert.equal(summary.failed, 1);
  assert.equal(summary.connected, 0);
  assert.equal(summary.toolCount, 0);

  // 同名时若只有一条真正加载，另一条标记 failed 且只统计一份工具
  const healthy = loader.addEntry({
    id: 'mcp-ok',
    config: { serverName: 'broken', transport: 'streamable-http', url: 'https://ok.example/mcp' },
  });
  assert.ok(healthy.fiber);
  const after = manager.list();
  assert.equal(after.summary.failed, 1);
  assert.equal(after.summary.connected, 1);
  assert.equal(after.summary.toolCount, 2);
  const statuses = Object.fromEntries(after.servers.map((server) => [server.id, server.status]));
  assert.equal(statuses['mcp-broken'], 'failed');
  assert.equal(statuses['mcp-ok'], 'connected');
});

test('set_enabled stops and restarts a server, and is idempotent', async () => {
  const { ctx, loader } = makeCtx({
    entries: [{ id: 'mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } }],
  });
  const manager = createManager(ctx);
  const off = await manager.setEnabled('alpha', false);
  assert.equal(off.changed, true);
  assert.equal(off.server.status, 'disabled');
  assert.equal(loader.tools.defs.size, 0, 'tools must be unregistered on disable');

  const again = await manager.setEnabled('alpha', false);
  assert.equal(again.changed, false);

  const on = await manager.setEnabled('alpha', true);
  assert.equal(on.changed, true);
  assert.equal(on.server.status, 'connected');
  assert.equal(on.server.toolCount, 2);
  assert.equal(loader.tools.defs.size, 2);
});

test('add creates a new runtime entry and updates an existing one', async () => {
  const { ctx, loader } = makeCtx();
  const manager = createManager(ctx);
  const created = await manager.add({
    serverName: 'fresh',
    transport: 'streamable-http',
    url: 'https://fresh.example/mcp',
    headers: { Authorization: 'Bearer secret-token' },
  });
  assert.equal(created.updated, false);
  assert.equal(created.id, 'mcp-manager-fresh');
  assert.ok(loader.store.has('mcp-manager-fresh'));
  assert.equal(loader.store.get('mcp-manager-fresh').options.config.headers.Authorization, 'Bearer secret-token');

  const updated = await manager.add({
    serverName: 'fresh',
    transport: 'streamable-http',
    url: 'https://fresh.example/mcp/v2',
  });
  assert.equal(updated.updated, true);
  assert.equal(loader.store.get('mcp-manager-fresh').options.config.url, 'https://fresh.example/mcp/v2');
  assert.equal(loader.store.get('mcp-manager-fresh').options.config.headers, undefined, 'updated config replaces the old one');
});

test('add validates input', async () => {
  const { ctx } = makeCtx();
  const manager = createManager(ctx);
  await assert.rejects(() => manager.add({ serverName: 'bad name', transport: 'stdio', command: 'node' }), /serverName/);
  await assert.rejects(() => manager.add({ serverName: 'x', transport: 'grpc' }), /transport/);
  await assert.rejects(() => manager.add({ serverName: 'x', transport: 'streamable-http' }), /url/);
  await assert.rejects(() => manager.add({ serverName: 'x', transport: 'stdio' }), /command/);
});

test('remove drops the runtime entry and its tools', async () => {
  const { ctx, loader } = makeCtx({
    entries: [{ id: 'mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } }],
  });
  const manager = createManager(ctx);
  const result = await manager.remove('alpha');
  assert.equal(result.removed, true);
  assert.equal(loader.store.size, 0);
  assert.equal(loader.tools.defs.size, 0);
});

test('exportPatch produces an installable patch and redacts credentials', async () => {
  const { ctx } = makeCtx({
    entries: [
      {
        id: 'mcp-alpha',
        config: {
          serverName: 'alpha',
          transport: 'streamable-http',
          url: 'https://a.example/mcp',
          headers: { Authorization: 'Bearer leaking', 'X-Trace': 'on' },
          toolCallTimeoutMs: 180000,
        },
      },
      {
        id: 'mcp-beta',
        config: { serverName: 'beta', transport: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'leak' } },
        enabled: false,
      },
    ],
  });
  const manager = createManager(ctx);
  const { yaml, warnings } = manager.exportPatch();
  assert.match(yaml, /^- insert:/m);
  assert.match(yaml, /id: mcp-alpha/);
  assert.match(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(yaml, /transport: streamable-http/);
  assert.match(yaml, /url: https:\/\/a\.example\/mcp/);
  assert.match(yaml, /!!js process\.env\.MCP_ALPHA_AUTHORIZATION/);
  assert.doesNotMatch(yaml, /leaking/);
  assert.doesNotMatch(yaml, /leak\b/);
  assert.match(yaml, /disabled: true/);
  assert.ok(warnings.length >= 2);

  // 只导出单个服务
  const single = manager.exportPatch('beta');
  assert.match(single.yaml, /id: mcp-beta/);
  assert.doesNotMatch(single.yaml, /id: mcp-alpha/);
});

test('registered tools declare schemas accepted by the harness subset', () => {
  const tools = new FakeTools();
  const { ctx } = makeCtx({
    tools,
    entries: [{ id: 'mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } }],
  });
  apply(ctx, { webApi: false });
  const names = [...tools.defs.keys()].filter((name) => name.startsWith('mcp_manager_')).sort();
  assert.deepEqual(names, [
    'mcp_manager_add',
    'mcp_manager_export',
    'mcp_manager_inspect',
    'mcp_manager_list',
    'mcp_manager_remove',
    'mcp_manager_set_enabled',
  ]);
  for (const definition of tools.defs.values()) {
    if (!definition.name.startsWith('mcp_manager_')) continue;
    checkSchema(definition.parameters ?? { type: 'object' }, `${definition.name}.parameters`);
    assert.ok(definition.output, `${definition.name} needs output`);
    checkSchema(definition.output.schema, `${definition.name}.output.schema`);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('tool round trip: list → inspect → set_enabled → export', async () => {
  const tools = new FakeTools();
  const { ctx } = makeCtx({
    tools,
    entries: [{ id: 'mcp-alpha', config: { serverName: 'alpha', transport: 'streamable-http', url: 'https://a.example/mcp' } }],
  });
  apply(ctx, { webApi: false });

  const listed = await tools.defs.get('mcp_manager_list').execute({ verbose: true });
  assert.equal(listed.servers.length, 1);
  assert.deepEqual(listed.servers[0].tools, ['echo', 'ping']);

  const inspected = await tools.defs.get('mcp_manager_inspect').execute({ server: 'alph' });
  assert.equal(inspected.server.serverName, 'alpha');
  assert.equal(inspected.tools.length, 2);

  const disabled = await tools.defs.get('mcp_manager_set_enabled').execute({ server: 'alpha', enabled: false });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.status, 'disabled');

  const exported = await tools.defs.get('mcp_manager_export').execute({});
  assert.match(exported.yaml, /serverName: alpha/);
});
