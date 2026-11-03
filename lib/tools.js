/**
 * 对话工具：`mcp_manager_*`。
 *
 * 全部注册为原始 ToolRuntime definition（不 import @deepseek-ai/dsh-tools，保持零依赖）。
 * 输出 schema 使用 Harness 支持的 JSON Schema 子集：type / oneOf / properties /
 * required（对象级数组）/ additionalProperties / items / enum / const + 注解字段。
 */
const STATUS_LABEL = {
  connected: '已连接',
  disabled: '已停用',
  'no-tools': '无工具',
  failed: '加载失败',
  'not-provisioned': '未生效',
};

const STATUS_ENUM = ['connected', 'disabled', 'no-tools', 'failed', 'not-provisioned'];

function appItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'source'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      icon: { type: 'string' },
      vendor: { type: 'string' },
      source: { type: 'string', enum: ['manual', 'catalog', 'host', 'prefix', 'self'] },
      singleton: { type: 'boolean' },
    },
  };
}

function appGroupSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'total', 'connected', 'failed', 'disabled', 'toolCount', 'serverIds'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      icon: { type: 'string' },
      vendor: { type: 'string' },
      source: { type: 'string' },
      singleton: { type: 'boolean' },
      serverIds: { type: 'array', items: { type: 'string' } },
      serverNames: { type: 'array', items: { type: 'string' } },
      total: { type: 'integer' },
      connected: { type: 'integer' },
      failed: { type: 'integer' },
      disabled: { type: 'integer' },
      noTools: { type: 'integer' },
      notProvisioned: { type: 'integer' },
      toolCount: { type: 'integer' },
      pinnedCount: { type: 'integer' },
      duplicateCount: { type: 'integer' },
    },
  };
}

function serverItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'serverName', 'transport', 'enabled', 'status', 'toolCount', 'origin'],
    properties: {
      app: appItemSchema(),
      id: { type: 'string' },
      shortId: { type: 'string' },
      origin: { type: 'string', enum: ['profile', 'managed'] },
      serverName: { type: 'string' },
      transport: { type: 'string' },
      endpoint: { type: 'string' },
      enabled: { type: 'boolean' },
      loaded: { type: 'boolean' },
      status: { type: 'string', enum: STATUS_ENUM },
      toolCount: { type: 'integer' },
      duplicate: { type: 'boolean' },
      runtimeOnly: { type: 'boolean' },
      riskFlags: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
    },
  };
}

function summarySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['total', 'uniqueServers', 'duplicateServers', 'enabled', 'disabled', 'connected', 'failed', 'managed', 'toolCount'],
    properties: {
      total: { type: 'integer' },
      uniqueServers: { type: 'integer' },
      duplicateServers: { type: 'integer' },
      enabled: { type: 'integer' },
      disabled: { type: 'integer' },
      connected: { type: 'integer' },
      failed: { type: 'integer' },
      notProvisioned: { type: 'integer' },
      managed: { type: 'integer' },
      toolCount: { type: 'integer' },
      orphanToolCount: { type: 'integer' },
    },
  };
}

function textRender(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

function serverRow(server) {
  const label = STATUS_LABEL[server.status] ?? server.status;
  const origin = server.origin === 'managed' ? '受管' : 'profile';
  const name = server.duplicate ? `${server.serverName}（同名）` : server.serverName;
  return `| ${name} | ${origin} | ${label} | ${server.transport} | ${server.toolCount} | ${server.endpoint || '—'} |`;
}

function withStoreHint(lines, value) {
  if (typeof value?.storePath === 'string' && value.storePath !== '') {
    lines.push('', `受管连接存储：${value.storePath}`);
  }
  if (value?.provisionFailures && Object.keys(value.provisionFailures).length > 0) {
    lines.push('', '未生效的受管记录：');
    for (const [serverName, message] of Object.entries(value.provisionFailures)) {
      lines.push(`- ${serverName}: ${message}`);
    }
  }
  return lines;
}

/**
 * 注册全部对话工具。
 *
 * @param {object} ctx - Cordis 上下文（需 `tools`）。
 * @param {object} manager - `createManager()` 的返回值。
 */
export function registerTools(ctx, manager) {
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  // ── list ──────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_list',
    description:
      '列出本机 MCP 服务（profile 静态声明 + 本插件受管记录）：服务名、来源、状态、传输、端点（已脱敏）、当前可用工具数。'
      + '支持按关键词/状态过滤；verbose=true 时附带工具名。不读取、不回显任何凭据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选：按服务名/条目 id/传输/端点做子串过滤。' },
        status: { type: 'string', enum: STATUS_ENUM, description: '可选：只看某个状态。' },
        verbose: { type: 'boolean', description: '是否附带每个服务的工具名列表。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['servers', 'summary'],
        properties: {
          servers: { type: 'array', items: serverItemSchema() },
          apps: { type: 'array', items: appGroupSchema() },
          summary: summarySchema(),
          storePath: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const { servers, summary } = value;
        if (servers.length === 0) return textRender(['没有匹配的 MCP 服务。']);
        const lines = [
          `共 ${summary.total} 个条目（唯一服务 ${summary.uniqueServers} 个，受管 ${summary.managed} 条）：`
          + `${summary.enabled} 个启用（${summary.connected} 个已连接），${summary.disabled} 个停用；工具 ${summary.toolCount} 个。`,
          ...(summary.duplicateServers > 0
            ? [`注意：有 ${summary.duplicateServers} 个服务被多个条目重复声明，共享 mcp__<server>__ 命名空间；启停请用条目 id 精确指定。`]
            : []),
          ...(summary.failed > 0
            ? [`有 ${summary.failed} 个条目加载失败（无 fiber 或受管记录未生效）；用 mcp_manager_inspect 查看详情。`]
            : []),
          '',
          '| 服务 | 来源 | 状态 | 传输 | 工具数 | 端点 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...servers.map(serverRow),
        ];
        if (Array.isArray(value.apps) && value.apps.length > 0) {
          lines.push('', `按应用：${value.apps.map((app) => `${app.name}(${app.total})`).join('、')}`);
        }
        if (servers.some((server) => server.tools?.length)) {
          lines.push('', '工具明细：');
          for (const server of servers) {
            if (!server.tools?.length) continue;
            lines.push(`- ${server.serverName}：${server.tools.join('、')}`);
          }
        }
        withStoreHint(lines, value);
        return textRender(lines);
      },
    },
    async execute(args) {
      const { servers, summary, storePath } = manager.list(args ?? {});
      const verbose = args?.verbose === true;
      const { apps } = manager.apps();
      return {
        servers: servers.map((server) => ({
          id: server.id,
          shortId: server.shortId,
          origin: server.origin,
          serverName: server.serverName,
          ...(server.app !== undefined ? { app: server.app } : {}),
          transport: server.transport,
          endpoint: server.endpoint,
          enabled: server.enabled,
          loaded: server.loaded,
          status: server.status,
          toolCount: server.toolCount,
          duplicate: server.duplicate === true,
          ...(server.runtimeOnly === true ? { runtimeOnly: true } : {}),
          ...(Array.isArray(server.riskFlags) ? { riskFlags: server.riskFlags } : {}),
          ...(server.error !== undefined ? { error: server.error } : {}),
          ...(verbose ? { tools: server.toolNames } : {}),
        })),
        apps,
        summary,
        storePath,
      };
    },
  });

  // ── inspect ───────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_inspect',
    description: '查看单个 MCP 服务的详情：来源、状态、传输、端点、超时、工具清单及说明。服务名支持条目 id/唯一子串。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名、条目 id 或唯一子串。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['server', 'tools'],
        properties: {
          server: serverItemSchema(),
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'publicName'],
              properties: {
                name: { type: 'string' },
                publicName: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const server = value.server;
        const lines = [
          `服务：${server.serverName}（${server.id} · ${server.origin === 'managed' ? '本插件受管' : 'profile 静态声明'}）`,
          `状态：${STATUS_LABEL[server.status] ?? server.status} · 传输：${server.transport}`
          + `${server.endpoint ? ` · 端点：${server.endpoint}` : ''} · 工具：${server.toolCount} 个`,
        ];
        if (server.error) lines.push(`错误：${server.error}`);
        if (server.status === 'failed') lines.push('说明：条目已启用但没有 fiber（apply 抛错），通常是 serverName 与其它条目重复。');
        if (server.status === 'not-provisioned') lines.push('说明：受管记录存在但本次启动未成功创建条目；可尝试 mcp_manager_set_enabled 重试，或检查冲突。');
        for (const tool of value.tools ?? []) {
          lines.push(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`);
        }
        if (!value.tools?.length) lines.push('（当前没有已注册的工具）');
        return textRender(lines);
      },
    },
    async execute(args) {
      const { server, tools } = manager.inspect(args?.server);
      return {
        server: {
          id: server.id,
          shortId: server.shortId,
          origin: server.origin,
          serverName: server.serverName,
          transport: server.transport,
          endpoint: server.endpoint,
          enabled: server.enabled,
          loaded: server.loaded,
          status: server.status,
          toolCount: server.toolCount,
          duplicate: server.duplicate === true,
          ...(server.runtimeOnly === true ? { runtimeOnly: true } : {}),
          ...(Array.isArray(server.riskFlags) ? { riskFlags: server.riskFlags } : {}),
          ...(server.error !== undefined ? { error: server.error } : {}),
        },
        tools,
      };
    },
  });

  // ── set_enabled ───────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_set_enabled',
    description:
      '启用或停用一个 MCP 服务。受管服务：状态持久化到插件存储，重启后保持；profile 静态行：只改本次运行（重启恢复）。'
      + '会立即断开/重建连接并增删 mcp__<server>__* 工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server', 'enabled'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名、条目 id 或唯一子串（同名时用条目 id）。' },
        enabled: { type: 'boolean', description: 'true 启用，false 停用。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'changed', 'persisted', 'serverName', 'enabled', 'status', 'toolCount'],
        properties: {
          ok: { type: 'boolean' },
          changed: { type: 'boolean' },
          persisted: { type: 'boolean' },
          serverName: { type: 'string' },
          enabled: { type: 'boolean' },
          status: { type: 'string', enum: STATUS_ENUM },
          toolCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message ?? `${value.serverName} → ${STATUS_LABEL[value.status]}`]),
    },
    timeoutMs: 45_000,
    async execute(args) {
      const result = await manager.setEnabled(args?.server, args?.enabled === true);
      const server = result.server;
      const persisted = result.persisted ? '（已持久化）' : '（仅本次运行）';
      const message = result.retried
        ? `${server.serverName} 曾加载失败，已尝试重新加载${persisted}；当前状态：${STATUS_LABEL[server.status] ?? server.status}。`
        : result.changed
          ? `${server.serverName} 已${server.enabled ? '启用' : '停用'}${persisted}；当前状态：${STATUS_LABEL[server.status] ?? server.status}，工具 ${server.toolCount} 个。`
          : `${server.serverName} 本来就是${server.enabled ? '启用' : '停用'}状态，未做改动。`;
      return {
        ok: true,
        changed: result.changed,
        persisted: result.persisted === true,
        serverName: server.serverName,
        enabled: server.enabled,
        status: server.status,
        toolCount: server.toolCount,
        message,
      };
    },
  });

  // ── add ───────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_add',
    description:
      '接入一个新的 MCP 服务（streamable-http 或 stdio）。默认写入插件受管存储，重启后自动恢复；'
      + 'persist=false 时仅本次运行。凭据经 headers/env 传入、绝不回显。同名服务已存在时更新其配置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['serverName', 'transport'],
      properties: {
        serverName: { type: 'string', description: '1-32 位字母/数字/下划线/连字符，会成为 mcp__<serverName>__<tool> 命名空间。' },
        transport: { type: 'string', enum: ['streamable-http', 'stdio'], description: '传输方式。' },
        url: { type: 'string', description: 'streamable-http：MCP 端点 URL。' },
        headers: { type: 'object', additionalProperties: true, description: 'streamable-http：请求头（可放 Authorization，不会回显）。' },
        command: { type: 'string', description: 'stdio：可执行文件。' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：参数列表。' },
        env: { type: 'object', additionalProperties: true, description: 'stdio：子进程环境变量（可放凭据，不会回显）。' },
        cwd: { type: 'string', description: 'stdio：工作目录。' },
        failOnStartupError: { type: 'boolean', description: '启动失败时是否让插件激活失败（默认 false）。' },
        toolCallTimeoutMs: { type: 'integer', description: '单次工具调用超时（毫秒，默认 180000）。' },
        enabled: { type: 'boolean', description: '是否启用（默认 true）。' },
        persist: { type: 'boolean', description: '是否写入受管存储（默认 true）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'serverName', 'updated', 'persisted', 'toolCount'],
        properties: {
          ok: { type: 'boolean' },
          serverName: { type: 'string' },
          updated: { type: 'boolean' },
          persisted: { type: 'boolean' },
          toolCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message]),
    },
    timeoutMs: 60_000,
    async execute(args) {
      const result = await manager.add(args ?? {}, { persist: args?.persist !== false });
      const message = `${result.updated ? '已更新' : '已接入'} MCP 服务 ${result.server.serverName}`
        + `（${result.persisted ? '已持久化' : '仅本次运行'}），当前注册工具 ${result.toolCount} 个。`
        + (result.toolCount === 0 ? ' 若为 0，请检查端点/凭据，或稍后用 mcp_manager_probe 探测。' : '');
      return {
        ok: true,
        serverName: result.server.serverName,
        updated: result.updated,
        persisted: result.persisted,
        toolCount: result.toolCount,
        message,
      };
    },
  });

  // ── update ────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_update',
    description:
      '修改已有 MCP 服务的配置（url/headers/command/args/env/cwd/toolCallTimeoutMs/enabled）。'
      + '受管服务：持久化并重建条目；profile 静态行：只改本次运行，持久化需用 mcp_manager_export。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server', 'changes'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名、条目 id 或唯一子串。' },
        changes: {
          type: 'object',
          additionalProperties: true,
          description: '要覆盖的字段，例如 {"url":"https://..."}、{"headers":{"Authorization":"Bearer ..."}}、{"toolCallTimeoutMs":120000}。'
          + '密钥三态：字段缺省=保留；传 null 或 deleteHeaders/deleteEnv=true 表示删除。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'serverName', 'persisted'],
        properties: {
          ok: { type: 'boolean' },
          serverName: { type: 'string' },
          persisted: { type: 'boolean' },
          toolCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message]),
    },
    timeoutMs: 45_000,
    async execute(args) {
      const changes = args?.changes;
      const result = await manager.update(args?.server, changes ?? {});
      const message = `已更新 ${result.server.serverName}`
        + (result.persisted ? '（已持久化）。' : '（仅本次运行）。')
        + (result.warning ? ` ${result.warning}` : '');
      return {
        ok: true,
        serverName: result.server.serverName,
        persisted: result.persisted === true,
        ...(Number.isFinite(result.toolCount) ? { toolCount: result.toolCount } : {}),
        message,
      };
    },
  });

  // ── remove ────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_remove',
    description:
      '移除一个 MCP 服务。受管服务：删除记录与条目（持久）；profile 静态行：仅本次运行移除，重启恢复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名、条目 id 或唯一子串。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'removed', 'persisted', 'serverName'],
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'boolean' },
          persisted: { type: 'boolean' },
          serverName: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([value.message]),
    },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await manager.remove(args?.server);
      const message = result.removed
        ? `已移除 MCP 服务 ${result.serverName}`
          + (result.persisted ? '（受管记录已删除，重启后不再出现）。' : '（仅本次运行；重启后会恢复）。')
          + (result.warning ? ` ${result.warning}` : '')
        : `${result.serverName} 当前没有可移除的条目。`;
      return {
        ok: true,
        removed: result.removed,
        persisted: result.persisted === true,
        serverName: result.serverName,
        message,
      };
    },
  });

  // ── probe ─────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_probe',
    description:
      '对 MCP 服务做一次真实握手探测（initialize + tools/list），返回是否连通、延迟、协议版本、服务端信息、工具数与错误。'
      + '只读操作；stdio 服务会临时启动子进程并在探测后结束。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名、条目 id 或唯一子串。' },
        timeoutMs: { type: 'integer', description: '探测超时（1000-60000ms，默认按传输类型 8s/10s）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'serverName', 'transport', 'reachable', 'latencyMs'],
        properties: {
          ok: { type: 'boolean' },
          serverName: { type: 'string' },
          transport: { type: 'string' },
          reachable: { type: 'boolean' },
          latencyMs: { type: 'integer' },
          toolCount: { type: 'integer' },
          protocolVersion: { type: 'string' },
          serverNameRemote: { type: 'string' },
          error: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'integer' },
          errorCode: { type: 'string' },
          warning: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          history: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['at', 'ok'],
              properties: {
                at: { type: 'integer' },
                ok: { type: 'boolean' },
                latencyMs: { type: 'integer' },
                toolCount: { type: 'integer' },
                errorCode: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.reachable) {
          const code = value.errorCode ? ` [${value.errorCode}]` : '';
          const lines = [`${value.serverName}（${value.transport}）探测失败${code}：${value.error ?? '未知错误'}`];
          if (value.exitCode !== undefined) lines.push(`退出码：${value.exitCode}`);
          if (value.stderr) lines.push('stderr（已脱敏）：', '```', value.stderr, '```');
          if (Array.isArray(value.history) && value.history.length > 0) {
            lines.push('', `最近 ${value.history.length} 次探测：${value.history.filter((item) => item.ok).length} 次成功`);
          }
          return textRender(lines);
        }
        const info = value.serverNameRemote ? ` · 服务端 ${value.serverNameRemote}` : '';
        const warning = value.warning === 'zero_tools' ? '（连接正常但没有任何工具）' : '';
        const history = Array.isArray(value.history) && value.history.length > 0
          ? ` · 最近 ${value.history.length} 次探测 ${value.history.filter((item) => item.ok).length} 次成功`
          : '';
        return textRender([
          `${value.serverName}（${value.transport}）探测成功：${value.latencyMs}ms · 协议 ${value.protocolVersion ?? '?'}`
          + ` · 工具 ${value.toolCount ?? 0} 个${info}${warning}${history}`,
        ]);
      },
    },
    timeoutMs: 70_000,
    async execute(args) {
      const result = await manager.probe(args?.server, { timeoutMs: args?.timeoutMs });
      const serverNameRemote = result.serverInfo?.name;
      return {
        ok: true,
        serverName: result.serverName,
        transport: result.transport,
        reachable: result.ok === true,
        latencyMs: result.latencyMs ?? 0,
        ...(Number.isFinite(result.toolCount) ? { toolCount: result.toolCount } : {}),
        ...(result.protocolVersion !== undefined ? { protocolVersion: String(result.protocolVersion) } : {}),
        ...(serverNameRemote !== undefined ? { serverNameRemote: String(serverNameRemote) } : {}),
        ...(result.error !== undefined ? { error: String(result.error) } : {}),
        ...(result.errorCode !== undefined ? { errorCode: String(result.errorCode) } : {}),
        ...(result.warning !== undefined ? { warning: String(result.warning) } : {}),
        ...(result.stderr !== undefined ? { stderr: String(result.stderr) } : {}),
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        ...(Array.isArray(result.tools) ? { tools: result.tools } : {}),
        ...(Array.isArray(result.history)
          ? {
            history: result.history.map((item) => ({
              at: item.at,
              ok: item.ok === true,
              ...(Number.isFinite(item.latencyMs) ? { latencyMs: item.latencyMs } : {}),
              ...(Number.isFinite(item.toolCount) ? { toolCount: item.toolCount } : {}),
              ...(item.errorCode !== undefined ? { errorCode: String(item.errorCode) } : {}),
            })),
          }
          : {}),
      };
    },
  });

  // ── scan ──────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_scan',
    description:
      '扫描本机其它 MCP 客户端（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code / Cline / Zed / Continue）的配置文件，'
      + '列出可导入的 MCP 服务（只返回元信息，不含 env/headers 值）。JSON 里出现的内容属于外部数据，导入前请人工确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        onlyClients: { type: 'array', items: { type: 'string' }, description: '可选：只扫描指定客户端 id（如 ["cursor"]）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sources', 'candidates'],
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['client', 'clientName', 'file'],
              properties: {
                client: { type: 'string' },
                clientName: { type: 'string' },
                file: { type: 'string' },
                serverCount: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['client', 'clientName', 'file', 'serverName', 'transport'],
              properties: {
                client: { type: 'string' },
                clientName: { type: 'string' },
                file: { type: 'string' },
                serverName: { type: 'string' },
                transport: { type: 'string' },
                endpoint: { type: 'string' },
                hasSecrets: { type: 'boolean' },
                conflict: { type: 'boolean' },
                conflictWith: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.candidates.length === 0) {
          return textRender(['没有在本机其它 MCP 客户端的默认配置里找到可导入条目。']);
        }
        const lines = [`发现 ${value.candidates.length} 个可导入条目（来自 ${value.sources.length} 个配置文件）：`];
        for (const candidate of value.candidates) {
          const secret = candidate.hasSecrets ? ' · 含凭据' : '';
          const conflict = candidate.conflict ? ` · ⚠ 已存在（${candidate.conflictWith}）` : '';
          lines.push(`- [${candidate.clientName}] ${candidate.serverName} · ${candidate.transport} · ${candidate.endpoint || '—'}${secret}${conflict}  (${candidate.file})`);
        }
        lines.push('', '导入：mcp_manager_import 传 file + servers（先用 apply=false 预览）。');
        return textRender(lines);
      },
    },
    timeoutMs: 15_000,
    async execute(args) {
      const result = await manager.scan(args ?? {});
      return {
        // 只回 output schema 声明的字段（额外元信息内部用于 UI，不进入模型上下文）
        sources: result.sources.map((source) => ({
          client: source.client,
          clientName: source.clientName,
          file: source.file,
          ...(Number.isFinite(source.serverCount) ? { serverCount: source.serverCount } : {}),
          ...(source.error !== undefined ? { error: String(source.error) } : {}),
        })),
        candidates: result.candidates.map((candidate) => ({
          client: candidate.client,
          clientName: candidate.clientName,
          file: candidate.file,
          serverName: candidate.serverName,
          transport: candidate.transport,
          ...(candidate.endpoint !== undefined ? { endpoint: candidate.endpoint } : {}),
          ...(candidate.hasSecrets !== undefined ? { hasSecrets: candidate.hasSecrets } : {}),
          ...(candidate.conflict === true ? { conflict: true, ...(candidate.conflictWith !== undefined ? { conflictWith: candidate.conflictWith } : {}) } : {}),
          ...(candidate.error !== undefined ? { error: candidate.error } : {}),
        })),
      };
    },
  });

  // ── import ────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_import',
    description:
      '从 `mcpServers` JSON 导入 MCP 服务：可直接粘贴 JSON（json），或传 mcp_manager_scan 结果里的 file。'
      + 'apply=false（默认）只预览；apply=true 才会写入受管存储并接入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: { type: 'string', description: '要导入的 JSON 文本（mcpServers / servers / 直接映射均可）。' },
        file: { type: 'string', description: 'mcp_manager_scan 返回的配置文件路径。' },
        servers: { type: 'array', items: { type: 'string' }, description: '可选：只导入这些 serverName。' },
        apply: { type: 'boolean', description: '是否真正写入（默认 false，仅预览）。' },
        onConflict: { type: 'string', enum: ['skip', 'overwrite', 'rename'], description: '同名冲突处理（默认 skip）：跳过 / 覆盖受管记录 / 自动改名。' },
        enabled: { type: 'boolean', description: '导入后是否启用（默认 true；可先导入为停用以人工检查）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'preview'],
        properties: {
          ok: { type: 'boolean' },
          preview: { type: 'boolean' },
          imported: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['serverName', 'toolCount'],
              properties: {
                serverName: { type: 'string' },
                toolCount: { type: 'integer' },
                updated: { type: 'boolean' },
              },
            },
          },
          records: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['serverName', 'transport'],
              properties: {
                serverName: { type: 'string' },
                transport: { type: 'string' },
                endpoint: { type: 'string' },
                hasSecrets: { type: 'boolean' },
                conflict: { type: 'string' },
              },
            },
          },
          errors: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [value.message ?? ''];
        for (const record of value.records ?? []) {
          const conflict = record.conflict ? ` · ⚠ 已存在（${record.conflict}）` : '';
          lines.push(`- ${record.serverName} · ${record.transport}${record.endpoint ? ` · ${record.endpoint}` : ''}${record.hasSecrets ? ' · 含凭据' : ''}${conflict}`);
        }
        for (const imported of value.imported ?? []) {
          lines.push(`- ${imported.serverName} 已接入，工具 ${imported.toolCount} 个`);
        }
        if (value.errors?.length) lines.push('', '失败：', ...value.errors.map((error) => `- ${error}`));
        if (value.skipped?.length) lines.push('', `跳过：${value.skipped.join('、')}`);
        return textRender(lines);
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const result = await manager.import(args ?? {}, {
        apply: args?.apply === true,
        onConflict: args?.onConflict,
        enabled: args?.enabled,
      });
      if (result.preview) {
        return {
          ok: true,
          preview: true,
          records: result.records,
          errors: result.errors,
          skipped: result.skipped,
          message: `预览到 ${result.records.length} 个可导入服务（其中 ${result.records.filter((record) => record.conflict !== undefined).length} 个与现有服务同名）；确认后用 apply=true 真正导入。`,
        };
      }
      return {
        ok: result.errors.length === 0,
        preview: false,
        imported: result.imported,
        errors: result.errors,
        skipped: result.skipped,
        message: `已导入 ${result.imported.length} 个服务${result.errors.length > 0 ? `，${result.errors.length} 个失败` : ''}。`,
      };
    },
  });

  // ── export ────────────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_export',
    description:
      '导出当前 MCP 配置：format=patch（可并入 profile 的 cordis.patch.yml，凭据脱敏为 !!js process.env.*）、'
      + 'format=json（通用 mcpServers JSON，凭据脱敏为 ${ENV}）、format=markdown（不含凭据的清单）、'
      + 'format=diagnostics（排障诊断报告：状态汇总 + 问题清单 + 探针历史，不含凭据）。'
      + '可选 server 只导出单个服务，servers 选多个服务；都不传则导出全部。'
      + '对话工具导出时凭据一律脱敏（避免明文凭据进入模型上下文）；需要明文请到设置页导出。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['patch', 'json', 'markdown', 'diagnostics'], description: '导出格式（默认 patch）。' },
        server: { type: 'string', description: '可选：只导出某个服务（serverName 或唯一子串）。' },
        servers: { type: 'array', items: { type: 'string' }, description: '可选：只导出这些服务（serverName / 条目 id 列表）。' },
        redact: { type: 'boolean', description: '是否脱敏凭据；对话工具固定脱敏（即使传 false 也按 true 处理）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'format', 'content', 'recordCount'],
        properties: {
          ok: { type: 'boolean' },
          format: { type: 'string' },
          content: { type: 'string' },
          recordCount: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const fence = value.format === 'json' ? 'json' : value.format === 'markdown' || value.format === 'diagnostics' ? 'markdown' : 'yaml';
        const lines = [`导出 ${value.recordCount} 条记录（${value.format}）：`, '', `\`\`\`${fence}`, value.content.trimEnd(), '```'];
        if (value.warnings?.length) lines.push('', '提示：', ...value.warnings.map((warning) => `- ${warning}`));
        return textRender(lines);
      },
    },
    timeoutMs: 20_000,
    async execute(args) {
      // 对话工具拿到的内容会进入模型上下文：始终脱敏（设置页走 web API，可显式关）
      const result = await manager.export({ ...(args ?? {}), redact: true });
      return {
        ok: true,
        format: result.format,
        content: result.content,
        recordCount: result.recordCount,
        warnings: result.warnings,
      };
    },
  });

  // ── tools（工具目录）────────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_tools',
    description:
      '列出/搜索所有已接入 MCP 服务暴露出来的工具（跨服务）。回答「某个能力由哪个 MCP 工具提供」时先查这里；'
      + 'includeSchema=true 时附带参数 JSON Schema（字符串形式），用于构造调用参数。'
      + '本工具只读，不调用任何 MCP 工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '按工具名/服务名/描述做子串过滤。' },
        server: { type: 'string', description: '可选：只看某个服务（服务名 / 条目 id / 唯一子串）。' },
        includeSchema: { type: 'boolean', description: '是否附带参数 JSON Schema（默认 false）。' },
        limit: { type: 'integer', description: '最多返回多少条（默认 50，上限 500）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'returned', 'truncated', 'tools'],
        properties: {
          total: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['serverName', 'toolName', 'publicName', 'description'],
              properties: {
                serverName: { type: 'string' },
                toolName: { type: 'string' },
                publicName: { type: 'string' },
                description: { type: 'string' },
                parametersJson: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) return textRender(['没有匹配的 MCP 工具。']);
        const lines = [`共 ${value.total} 个工具${value.truncated ? `，这里显示前 ${value.returned} 个` : ''}：`, ''];
        let current = '';
        for (const tool of value.tools) {
          if (tool.serverName !== current) {
            current = tool.serverName;
            lines.push(`### ${current}`, '');
          }
          lines.push(`- \`${tool.toolName}\`${tool.description ? `：${tool.description}` : ''}`);
        }
        return textRender(lines);
      },
    },
    timeoutMs: 20_000,
    async execute(args) {
      const limit = Number.isFinite(args?.limit) ? Math.min(Math.max(Math.trunc(args.limit), 1), 500) : 50;
      const result = manager.toolCatalog({
        query: args?.query,
        server: args?.server,
        includeSchema: args?.includeSchema === true,
        limit,
      });
      return {
        total: result.total,
        returned: result.returned,
        truncated: result.truncated,
        tools: result.tools.map((tool) => ({
          serverName: tool.serverName,
          toolName: tool.toolName,
          publicName: tool.publicName,
          description: tool.description,
          ...(tool.parameters !== undefined ? { parametersJson: JSON.stringify(tool.parameters, null, 2) } : {}),
        })),
      };
    },
  });

  // ── call_tool（工具试用）────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_call_tool',
    description:
      '真实调用一次某个 MCP 工具（与模型调用走同一条执行管线，可能产生副作用）。'
      + '不确定参数时先传 dryRun=true：只校验工具存在并返回 JSON Schema，不执行。'
      + '结果过长会被截断（truncated=true），正文里会说明。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server', 'tool'],
      properties: {
        server: { type: 'string', description: 'MCP 服务名 / 条目 id / 唯一子串。' },
        tool: { type: 'string', description: '工具名（可省略 mcp__<server>__ 前缀）。' },
        arguments: { type: 'object', additionalProperties: true, description: '工具参数对象（必须是 JSON 对象）；先 dryRun 看 schema 更稳。' },
        timeoutMs: { type: 'integer', description: '超时（1000-120000ms，默认 30000）。' },
        dryRun: { type: 'boolean', description: '只校验不执行（默认 false）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'isError', 'durationMs'],
        properties: {
          ok: { type: 'boolean' },
          isError: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          serverName: { type: 'string' },
          toolName: { type: 'string' },
          publicName: { type: 'string' },
          description: { type: 'string' },
          parametersJson: { type: 'string' },
          durationMs: { type: 'integer' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          value: { type: 'string' },
          valueTruncated: { type: 'boolean' },
          meta: { type: 'string' },
          error: {
            type: 'object',
            additionalProperties: false,
            required: ['message'],
            properties: {
              message: { type: 'string' },
              code: { type: 'string' },
            },
          },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.dryRun === true) {
          const lines = [
            `工具：${value.serverName} / ${value.toolName}`,
            value.description ? `说明：${value.description}` : '',
            '参数 schema（JSON）预览：',
            '```json',
            (value.parametersJson ?? '{}').slice(0, 4000),
            '```',
          ].filter((line) => line !== '');
          return textRender(lines);
        }
        if (value.ok !== true) {
          const lines = [`调用失败${value.code ? ` [${value.code}]` : ''}：${value.error?.message ?? value.message ?? '未知错误'}`];
          if (value.text && value.text !== value.error?.message) lines.push('', value.text);
          return textRender(lines);
        }
        const lines = [
          `调用成功：${value.serverName} / ${value.toolName} · ${value.durationMs}ms`
          + `${value.truncated ? ' · 结果过长已截断' : ''}`,
          '',
          '```',
          value.text ?? '',
          '```',
        ];
        if (value.value !== undefined) lines.push('', '结构化结果（value）：', '```json', value.value, '```');
        return textRender(lines);
      },
    },
    timeoutMs: 130_000,
    async execute(args) {
      const result = await manager.invokeTool({
        server: args?.server,
        tool: args?.tool,
        arguments: args?.arguments,
        timeoutMs: args?.timeoutMs,
        dryRun: args?.dryRun === true,
      });
      if (result.dryRun === true) {
        return {
          ok: true,
          isError: false,
          dryRun: true,
          serverName: result.serverName,
          toolName: result.toolName,
          publicName: result.publicName,
          description: result.description,
          parametersJson: JSON.stringify(result.parameters ?? {}, null, 2),
          durationMs: result.durationMs,
        };
      }
      return {
        ok: result.ok === true,
        isError: result.isError === true,
        ...(result.serverName !== undefined ? { serverName: result.serverName } : {}),
        ...(result.toolName !== undefined ? { toolName: result.toolName } : {}),
        ...(result.publicName !== undefined ? { publicName: result.publicName } : {}),
        durationMs: result.durationMs ?? 0,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(typeof result.value === 'string' ? { value: result.value } : {}),
        ...(result.valueTruncated === true ? { valueTruncated: true } : {}),
        ...(typeof result.meta === 'string' ? { meta: result.meta } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    },
  });

  // ── probe_many（批量探针）────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_probe_many',
    description:
      '批量握手探测：默认探测所有已启用服务（按 serverName 去重），返回每个服务的连通性、延迟、工具数与错误；'
      + '结果会写入该服务的探针历史。只读，不修改配置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        servers: { type: 'array', items: { type: 'string' }, description: '可选：只探测这些服务（serverName / 条目 id）。' },
        includeDisabled: { type: 'boolean', description: '是否连停用服务也探（默认 false）。' },
        concurrency: { type: 'integer', description: '并发数（1-8，默认 3）。' },
        timeoutMs: { type: 'integer', description: '单个探针超时（1000-60000ms）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'ok', 'failed', 'results'],
        properties: {
          total: { type: 'integer' },
          ok: { type: 'integer' },
          failed: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['serverName', 'ok', 'latencyMs'],
              properties: {
                serverName: { type: 'string' },
                transport: { type: 'string' },
                ok: { type: 'boolean' },
                latencyMs: { type: 'integer' },
                toolCount: { type: 'integer' },
                protocolVersion: { type: 'string' },
                errorCode: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) return textRender(['没有可探测的服务。']);
        const lines = [`探测 ${value.total} 个服务：${value.ok} 个成功，${value.failed} 个失败。`, '', '| 服务 | 结果 | 延迟 | 工具数 | 错误 |', '| --- | --- | --- | --- | --- |'];
        for (const result of value.results) {
          lines.push(
            `| ${result.serverName} | ${result.ok ? '成功' : '失败'} | ${result.latencyMs}ms | ${result.toolCount ?? '—'} | ${result.error ? `${result.errorCode ? `${result.errorCode}: ` : ''}${result.error}` : '—'} |`,
          );
        }
        return textRender(lines);
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const result = await manager.probeMany({
        servers: args?.servers,
        includeDisabled: args?.includeDisabled === true,
        concurrency: args?.concurrency,
        timeoutMs: args?.timeoutMs,
      });
      return {
        total: result.total,
        ok: result.ok,
        failed: result.failed,
        results: result.results.map((item) => ({
          serverName: item.serverName,
          ok: item.ok === true,
          latencyMs: item.latencyMs ?? 0,
          ...(item.transport !== undefined ? { transport: String(item.transport) } : {}),
          ...(Number.isFinite(item.toolCount) ? { toolCount: item.toolCount } : {}),
          ...(item.protocolVersion !== undefined ? { protocolVersion: String(item.protocolVersion) } : {}),
          ...(item.errorCode !== undefined ? { errorCode: String(item.errorCode) } : {}),
          ...(item.error !== undefined ? { error: String(item.error) } : {}),
        })),
      };
    },
  });

  // ── apps（按应用归类）───────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_apps',
    description:
      '按「应用」聚合 MCP 服务（例如 高德地图 / 同花顺 / 企查查 / 北大法宝），返回每个应用下的服务数、健康计数与工具数。'
      + '回答「我有哪些应用的 MCP」「同花顺的 MCP 有几个服务」时用；可用 mcp_manager_prefs 改某个服务的应用归类。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选：按应用名过滤。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['apps'],
        properties: {
          apps: { type: 'array', items: appGroupSchema() },
          summary: summarySchema(),
        },
      },
      render: (_args, value) => {
        if (value.apps.length === 0) return textRender(['还没有可归类的 MCP 服务。']);
        const lines = [`共 ${value.apps.length} 个应用：`, ''];
        for (const app of value.apps) {
          const icon = app.icon !== undefined ? `${app.icon} ` : '';
          const health = `已连接 ${app.connected}`
            + `${app.failed > 0 ? ` / 失败 ${app.failed}` : ''}`
            + `${app.disabled > 0 ? ` / 停用 ${app.disabled}` : ''}`;
          lines.push(`- ${icon}${app.name}（${app.total} 个服务 · ${health} · 工具 ${app.toolCount}）`);
          if (app.serverNames.length > 1) lines.push(`  - ${app.serverNames.join('、')}`);
        }
        return textRender(lines);
      },
    },
    timeoutMs: 15_000,
    async execute(args) {
      const { apps, summary } = manager.apps();
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      return {
        apps: query === '' ? apps : apps.filter((app) => app.name.toLowerCase().includes(query)),
        summary,
      };
    },
  });

  // ── prefs（收藏/标签/备注）────────────────────────────────────────────────────
  register({
    name: 'mcp_manager_prefs',
    description:
      '读取或修改面板偏好：收藏（pinned）、标签（tags）、备注（note），以及 UI 级开关 autoProbe。'
      + 'action=get 读取全部；action=patch 需要 server + patch；action=ui 需要 ui。偏好在 profile 作用域持久化。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'patch', 'ui'], description: '操作类型（默认 get）。' },
        server: { type: 'string', description: 'action=patch 时必填：服务名 / 条目 id / 唯一子串。' },
        patch: {
          type: 'object',
          additionalProperties: false,
          description: '要合并的偏好；字段留空表示不改，传 null 表示清除。',
          properties: {
            pinned: { type: 'boolean', description: '是否收藏/置顶。' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签（最多 8 个，每个 ≤20 字）。' },
            note: { type: 'string', description: '备注（≤200 字）。' },
            app: { type: 'string', description: '应用归类名（≤40 字；传 null 恢复自动识别）。' },
          },
        },
        ui: {
          type: 'object',
          additionalProperties: false,
          properties: {
            autoProbe: { type: 'boolean', description: '打开面板时自动探测已连接服务。' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'path'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          ui: {
            type: 'object',
            additionalProperties: false,
            properties: { autoProbe: { type: 'boolean' } },
          },
          servers: {
            type: 'object',
            additionalProperties: true,
          },
          serverName: { type: 'string' },
          server: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pinned: { type: 'boolean' },
              tags: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
              app: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.serverName !== undefined) {
          const tags = value.server?.tags?.length ? ` · 标签：${value.server.tags.join('、')}` : '';
          const note = value.server?.note ? ` · 备注：${value.server.note}` : '';
          return textRender([`${value.serverName}${value.server?.pinned ? ' · 已收藏' : ''}${tags}${note}`]);
        }
        const entries = Object.entries(value.servers ?? {});
        if (entries.length === 0) return textRender([`偏好文件：${value.path}`, '还没有任何收藏/标签/备注。']);
        const lines = [`偏好文件：${value.path}`, ''];
        for (const [serverName, meta] of entries) {
          const bits = [];
          if (meta?.pinned === true) bits.push('收藏');
          if (meta?.tags?.length) bits.push(`标签 ${meta.tags.join('、')}`);
          if (meta?.note) bits.push(`备注 ${meta.note}`);
          if (bits.length > 0) lines.push(`- ${serverName}：${bits.join(' · ')}`);
        }
        lines.push('', `autoProbe：${value.ui?.autoProbe === true ? '开' : '关'}`);
        return textRender(lines);
      },
    },
    timeoutMs: 15_000,
    async execute(args) {
      const action = args?.action === 'patch' || args?.action === 'ui' ? args.action : 'get';
      if (action === 'patch') {
        const result = await manager.patchPrefs(args?.server, args?.patch ?? {});
        const view = manager.prefsView();
        return { ok: true, path: view.path, serverName: result.serverName, server: result.prefs ?? {}, ui: view.ui ?? {} };
      }
      if (action === 'ui') {
        const ui = await manager.setUiPrefs(args?.ui ?? {});
        const view = manager.prefsView();
        return { ok: true, path: view.path, ui, servers: view.servers ?? {} };
      }
      const view = manager.prefsView();
      return { ok: true, path: view.path, ui: view.ui ?? {}, servers: view.servers ?? {} };
    },
  });

  // ── store_repair（存储修复）────────────────────────────────────────────────
  register({
    name: 'mcp_manager_store_repair',
    description:
      '修复损坏的受管连接存储（store-read-failed 时 mutate 会一直失败）：把坏文件改名备份为 .corrupt-<时间戳>，'
      + '重置为空存储并写回。backup=false 时直接删除坏文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        backup: { type: 'boolean', description: '是否保留坏文件副本（默认 true）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'storePath', 'servers'],
        properties: {
          ok: { type: 'boolean' },
          storePath: { type: 'string' },
          servers: { type: 'integer' },
          backupPath: { type: 'string' },
        },
      },
      render: (_args, value) => textRender([
        value.backupPath !== undefined
          ? `已把损坏的存储备份到：${value.backupPath}`
          : '已删除损坏的存储文件（未保留备份）。',
        `已重置受管存储：${value.storePath}（当前 ${value.servers} 条记录）`,
        '提示：重启后受管服务列表会重建；profile 静态行不受影响。',
      ]),
    },
    timeoutMs: 15_000,
    async execute(args) {
      const result = await manager.repairStore({ backup: args?.backup !== false });
      return {
        ok: true,
        storePath: result.storePath,
        servers: result.servers,
        ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
      };
    },
  });

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 注册器可能已随宿主一起释放 */
      }
    }
  });
}
