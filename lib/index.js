/**
 * dsh-mcp-manager —— 插件入口与业务编排。
 *
 * 设计目标：一个「轻量版 MCP 服务管理器」，只管理本机已接入/手头要接入的 MCP 服务，
 * 不做插件市场、不做远程目录。相比 0.1：
 *   - 新增**自管连接存储**（profile 作用域 JSON，0600，原子写），接入/编辑/启停可跨重启；
 *   - 新增 **mcpServers JSON 导入/导出** 与**本机其它客户端配置扫描**（Claude Desktop / Cursor / VS Code…）；
 *   - 新增 **MCP 握手探针**（initialize + tools/list，输出延迟/工具数/错误）；
 *   - 代码拆成 lib/* 模块，工具与 Web API 共用一套 manager 门面。
 *
 * 文件说明：
 *   lib/util.js       工具函数与错误类型
 *   lib/config.js     连接记录规范化、mcpServers JSON 互转
 *   lib/store.js      自管连接存储（profile 作用域、原子写）
 *   lib/prefs.js      面板偏好（收藏/标签/备注）与探针历史
 *   lib/inventory.js  loader 条目 + 工具注册表 → 服务清单
 *   lib/provision.js  记录 → dsh-mcp-client 条目（create/update/remove）
 *   lib/probe.js      MCP 握手探针（streamable-http / stdio）
 *   lib/invoke.js     工具 schema 查看与「试用」（走 ctx.tools.execute）
 *   lib/importers.js  扫描/解析其它客户端配置
 *   lib/export.js     导出 patch YAML / mcpServers JSON / Markdown / 诊断报告
 *   lib/tools.js      对话工具 mcp_manager_*
 *   lib/web.js        同源 HTTP API
 */
import { ConnectionStore, defaultStorePath } from './store.js';
import { PrefsStore, defaultPrefsPath, applyPrefsPatch } from './prefs.js';
import { groupServersByApp } from './apps.js';
import { normalizeRecord } from './config.js';
import { listServers, resolveServer, waitForEntryState, rawConfig, liveConfig, toolsOfServer, toolSchemas, serverNameOfTool } from './inventory.js';
import { provisionEntry, setEntryEnabled, removeEntry, entryIdFor, ENTRY_PREFIX } from './provision.js';
import { probeRecord } from './probe.js';
import { scanImports, readImportSource } from './importers.js';
import { collectExportRecords, exportPatchYaml, exportMcpServersJson, exportMarkdown, exportDiagnostics } from './export.js';
import { resolveTool, invokeTool as runTool, sampleArgumentsFromSchema } from './invoke.js';
import { ManagerError, errorText, isPlainObject, truncate, endpointOf, redactUrl, TOOL_DESC_LIMIT } from './util.js';
import { registerTools } from './tools.js';
import { mountWebApi } from './web.js';

/**
 * 创建管理器门面。所有方法只依赖 ctx 的公开服务（loader / tools），便于测试注入假 ctx。
 *
 * @param {object} ctx - Cordis 上下文（需 `loader`、`tools`）。
 * @param {object} [inputConfig] - 插件配置。
 * @returns {object} 管理器 API。
 */
export function createManager(ctx, inputConfig = {}) {
  const config = normalizePluginConfig(inputConfig);
  const logger = ctx.logger ?? console;
  const store = new ConnectionStore({ path: defaultStorePath(config), logger });
  const prefs = new PrefsStore({ path: defaultPrefsPath(config), logger });
  /** serverName → 最近一次 provision 失败原因（只在本次运行有效）。 */
  const provisionFailures = new Map();
  let mutationQueue = Promise.resolve();
  let initialized = false;
  /** 本会话 scan() 发现过的配置文件路径：import({file}) 只接受这些路径，避免读任意文件。 */
  const trustedImportFiles = new Set();
  /** 探针并发上限与去重（同一服务重复探测复用同一个 promise）。 */
  const PROBE_CONCURRENCY = 4;
  const probeInFlight = new Map();
  let probeActive = 0;
  const probeWaiters = [];

  async function withProbeSlot(fn) {
    if (probeActive >= PROBE_CONCURRENCY) await new Promise((resolve) => probeWaiters.push(resolve));
    probeActive += 1;
    try {
      return await fn();
    } finally {
      probeActive -= 1;
      probeWaiters.shift()?.();
    }
  }

  /** 串行执行写操作，避免并发改 loader/store 打架。 */
  function enqueue(fn) {
    const run = mutationQueue.then(fn);
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function refreshProvisionFailure(record) {
    try {
      await provisionEntry(ctx, record);
      provisionFailures.delete(record.serverName);
    } catch (error) {
      provisionFailures.set(record.serverName, errorText(error));
      throw error;
    }
  }

  /** 启动时把存储里的记录全部落成 mcp-client 条目（失败不阻塞插件加载）。 */
  async function init() {
    if (initialized) return;
    initialized = true;
    await Promise.all([store.load(), prefs.load()]);
    if (store.loadError) logger.warn?.(`[mcp-manager] ${store.loadError.message}`);
    if (prefs.loadError) logger.warn?.(`[mcp-manager] ${prefs.loadError.message}`);
    for (const record of store.list()) {
      if (record.enabled === false) {
        // 停用的记录也创建成 disabled 条目，保证列表里可见
        try {
          await provisionEntry(ctx, record);
        } catch (error) {
          provisionFailures.set(record.serverName, errorText(error));
        }
        continue;
      }
      try {
        await provisionEntry(ctx, record);
      } catch (error) {
        provisionFailures.set(record.serverName, errorText(error));
        logger.warn?.(`[mcp-manager] 受管服务 ${record.serverName} 未能接入：${errorText(error)}`);
      }
    }
  }

  function snapshot() {
    const { servers, summary } = listServers(ctx, {
      store,
      includeDescriptions: config.includeDescriptions,
      failures: provisionFailures,
      prefsServers: prefs.snapshot().servers,
    });
    return { servers, summary };
  }

  function resolve(key) {
    const { servers } = snapshot();
    return resolveServer(servers, key);
  }

  /** 全局工具注册表里属于 MCP 命名空间的 schema。 */
  function mcpSchemas() {
    return toolSchemas(ctx).filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith('mcp__'));
  }

  /** 按 serverName 去重后的服务表（同名条目共享命名空间，取第一条）。 */
  function uniqueServers() {
    const { servers } = snapshot();
    const byName = new Map();
    for (const server of servers) {
      if (!byName.has(server.serverName)) byName.set(server.serverName, server);
    }
    return byName;
  }

  /** 把一次探针结果写进偏好存储（历史环形），失败不影响探针本身。 */
  async function recordProbeHistory(result) {
    try {
      const recorded = await prefs.recordProbe(result.serverName, {
        at: Date.now(),
        ok: result.ok === true,
        latencyMs: result.latencyMs,
        toolCount: result.toolCount,
        errorCode: result.errorCode,
        error: result.error,
      });
      return recorded;
    } catch (error) {
      logger.warn?.(`[mcp-manager] 探针历史写入失败（${result.serverName}）：${errorText(error)}`);
      return undefined;
    }
  }

  function entryOf(server) {
    for (const entry of ctx.loader.entries()) {
      const id = entry.id ?? entry.options?.id;
      if (id === server.id) return entry;
    }
    return undefined;
  }

  function isManaged(server) {
    // runtime-only 条目（persist:false 接入）不在 store 里，按 profile 行处理（只改运行时）。
    return server.origin === 'managed' && store.has(server.serverName);
  }

  /** 等条目真正进入期望状态，再回报工具数（避免「合法 0 工具」服务被误判为未连上）。 */
  async function settleEntry(serverName, enabled) {
    const id = entryIdFor(serverName);
    await waitForEntryState(ctx, id, (entry) => (enabled ? entry.fiber !== undefined : entry.disabled === true));
    return toolsOfServer(ctx, serverName, toolSchemas(ctx)).length;
  }

  function recordOf(server) {
    return store.get(server.serverName);
  }

  /** 从服务条目/记录构造探针输入。 */
  function probeTarget(server) {
    if (isManaged(server)) {
      const record = recordOf(server);
      if (record === undefined) throw new ManagerError('not-managed', `${server.serverName} 没有受管记录，无法探测`);
      return record;
    }
    const entry = entryOf(server);
    if (entry === undefined) throw new ManagerError('entry-missing', `${server.serverName} 的 loader 条目不存在`);
    const resolved = liveConfig(entry);
    if (typeof resolved.serverName !== 'string') throw new ManagerError('probe-unsupported', '无法读取该条目的运行配置');
    return resolved;
  }

  const manager = {
    config,
    store,
    /** 启动初始化（幂等）。 */
    init,
    /** 原始清单（含内部字段，供 Web UI / 测试使用）。 */
    snapshot,
    /** 面向工具的精简清单（过滤 query/status）。 */
    list(options = {}) {
      const { servers, summary } = snapshot();
      const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
      const status = typeof options.status === 'string' ? options.status : '';
      const filtered = servers.filter((server) => {
        if (status !== '' && server.status !== status) return false;
        if (query === '') return true;
        return server.serverName.toLowerCase().includes(query)
          || server.id.toLowerCase().includes(query)
          || server.transport.includes(query)
          || (server.endpoint ?? '').toLowerCase().includes(query);
      });
      return { servers: filtered, summary, storePath: store.path };
    },
    /** 按应用聚合的服务分组（含每组健康计数）。 */
    apps() {
      const { servers, summary } = snapshot();
      const apps = groupServersByApp(servers);
      return { apps, summary, appCount: apps.length };
    },
    inspect(key) {
      const server = resolve(key);
      return { server, tools: server.tools };
    },
    /**
     * 工具目录：跨服务搜索 MCP 工具（默认不含参数 schema，避免一次返回过大）。
     *
     * @param {object} [options]
     * @param {string} [options.query] - 按工具名/服务名/描述过滤。
     * @param {string} [options.server] - 只看某个服务（服务名/条目 id/唯一子串）。
     * @param {boolean} [options.includeSchema] - 是否带 parameters（JSON Schema）。
     * @param {number} [options.limit] - 最多返回多少条（默认 500，上限 2000）。
     * @returns {object} { total, returned, truncated, tools, servers }
     */
    toolCatalog(options = {}) {
      const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
      const onlyServer = typeof options.server === 'string' && options.server.trim() !== ''
        ? resolve(options.server).serverName
        : undefined;
      const includeSchema = options.includeSchema === true;
      const limit = Number.isFinite(options.limit)
        ? Math.min(Math.max(Math.trunc(options.limit), 1), 2000)
        : 500;
      const servers = uniqueServers();
      const tools = [];
      for (const schema of mcpSchemas()) {
        const serverName = serverNameOfTool(schema.name, servers.keys());
        if (onlyServer !== undefined && serverName !== onlyServer) continue;
        const toolName = schema.name.slice(`mcp__${serverName}__`.length);
        const description = truncate(schema.description, TOOL_DESC_LIMIT);
        if (query !== '') {
          const haystack = `${serverName} ${toolName} ${description}`.toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        tools.push({
          serverName,
          toolName,
          publicName: schema.name,
          description,
          ...(includeSchema ? { parameters: isPlainObject(schema.parameters) ? schema.parameters : {} } : {}),
        });
      }
      tools.sort((a, b) => a.serverName.localeCompare(b.serverName) || a.toolName.localeCompare(b.toolName));
      const sliced = tools.slice(0, limit);
      return {
        total: tools.length,
        returned: sliced.length,
        truncated: tools.length > sliced.length,
        tools: sliced,
        servers: [...servers.values()].map((server) => ({
          serverName: server.serverName,
          status: server.status,
          enabled: server.enabled,
          toolCount: server.toolCount,
        })),
      };
    },
    /** 单个工具的完整定义（含 JSON Schema 与示例参数）。 */
    toolDetail(serverKey, toolName) {
      const server = resolve(serverKey);
      const target = resolveTool(ctx, server.serverName, toolName);
      return {
        serverName: server.serverName,
        toolName: target.toolName,
        publicName: target.publicName,
        description: target.description,
        parameters: target.parameters,
        sampleArguments: sampleArgumentsFromSchema(target.parameters),
        status: server.status,
        enabled: server.enabled,
      };
    },
    /**
     * 试用一个 MCP 工具：走宿主 `ctx.tools.execute()`，不绕过任何 guard/审批。
     *
     * @param {object} input
     * @param {string} input.server - 服务名/条目 id/唯一子串。
     * @param {string} input.tool - 工具名。
     * @param {unknown} [input.arguments] - 参数对象。
     * @param {number} [input.timeoutMs] - 超时（默认 30s，上限 120s）。
     * @param {boolean} [input.dryRun] - 只校验不执行。
     * @returns {Promise<object>} 折叠后的调用结果。
     */
    async invokeTool(input = {}) {
      const server = resolve(input.server);
      return runTool(ctx, {
        serverName: server.serverName,
        toolName: input.tool,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        dryRun: input.dryRun === true,
      });
    },
    /**
     * 修复损坏的受管存储：坏文件改名备份 → 重置为空 → 写回。
     * 仅在 store.loadError 存在时有意义；正常时也可用于清空重建（backup=false 会直接删）。
     */
    async repairStore(options = {}) {
      return enqueue(async () => {
        const result = await store.repair({ backup: options.backup !== false });
        provisionFailures.clear();
        return { ...result, storePath: store.path, servers: store.list().length };
      });
    },
    /**
     * 重命名/归并一个应用分组：对该组内全部服务写入 prefs.app 覆盖。
     *
     * @param {string} appKey - 应用 id 或应用名（state.apps[].id / name）。
     * @param {string|null} name - 新应用名；null/空串表示清除覆盖、恢复自动识别。
     * @returns {Promise<object>} { appId, name, updated, apps }
     */
    async renameApp(appKey, name) {
      return enqueue(async () => {
        if (typeof appKey !== 'string' || appKey.trim() === '') {
          throw new ManagerError('invalid-app', '缺少应用 id 或名称');
        }
        const { apps } = manager.apps();
        const group = apps.find((app) => app.id === appKey.trim() || app.name === appKey.trim());
        if (group === undefined) throw new ManagerError('app-not-found', `找不到应用分组：${appKey}`);
        const nextName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
        const names = group.serverNames;
        const nameSet = new Set(names);
        await prefs.mutate((draft) => {
          for (const [serverName, meta] of Object.entries(draft.servers)) {
            if (!nameSet.has(serverName)) continue;
            const merged = applyPrefsPatch(meta, { app: nextName });
            if (Object.keys(merged).length === 0) delete draft.servers[serverName];
            else draft.servers[serverName] = merged;
          }
          // 还没有 prefs 记录的服务也要写入覆盖
          for (const serverName of names) {
            if (Object.hasOwn(draft.servers, serverName)) continue;
            const merged = applyPrefsPatch(undefined, { app: nextName });
            if (Object.keys(merged).length > 0) draft.servers[serverName] = merged;
          }
          return null;
        });
        const fresh = manager.apps();
        return {
          appId: group.id,
          name: nextName,
          updated: names.length,
          apps: fresh.apps,
        };
      });
    },
    /** 偏好与探针历史快照。 */
    prefsView() {
      return { path: prefs.path, ...prefs.snapshot() };
    },
    /** 合并式更新某服务的偏好（pinned / tags / note；null 清除）。 */
    async patchPrefs(serverKey, patch) {
      const server = resolve(serverKey);
      const next = await prefs.patchServer(server.serverName, patch);
      return { serverName: server.serverName, prefs: next ?? {} };
    },
    /** 更新 UI 级偏好（目前只有 autoProbe）。 */
    async setUiPrefs(patch) {
      return prefs.setUi(patch);
    },
    /** 启用/停用：受管记录持久化 + 重建条目；profile 行只改运行时。 */
    async setEnabled(key, enabled) {
      return enqueue(async () => {
        const server = resolve(key);
        const next = Boolean(enabled);
        if (isManaged(server)) {
          const record = recordOf(server);
          if (record === undefined) throw new ManagerError('not-managed', `${server.serverName} 没有受管记录`);
          const updated = { ...record, enabled: next };
          await store.mutate((draft) => {
            draft.servers[server.serverName] = { ...updated };
            return null;
          });
          try {
            await provisionEntry(ctx, updated);
            provisionFailures.delete(server.serverName);
          } catch (error) {
            provisionFailures.set(server.serverName, errorText(error));
            throw error;
          }
          const toolCount = await settleEntry(server.serverName, next);
          const fresh = resolve(server.serverName);
          return { changed: server.enabled !== next, persisted: true, toolCount, server: fresh };
        }

        const entry = entryOf(server);
        if (entry === undefined) throw new ManagerError('entry-missing', `${server.serverName} 的 loader 条目不存在`);
        const before = !entry.disabled;
        if (before === next) {
          if (next && server.loaded === false) {
            await ctx.loader.update(entry.id ?? entry.options?.id, { disabled: false });
            await waitForEntryState(ctx, entry.id ?? entry.options?.id, (candidate) => candidate.fiber !== undefined);
            return { changed: true, persisted: false, retried: true, server: resolve(server.serverName) };
          }
          return { changed: false, persisted: false, server };
        }
        await ctx.loader.update(entry.id ?? entry.options?.id, { disabled: !next });
        await waitForEntryState(ctx, entry.id ?? entry.options?.id, (candidate) => (next ? candidate.fiber !== undefined : candidate.disabled === true));
        const toolCount = toolsOfServer(ctx, server.serverName, toolSchemas(ctx)).length;
        return { changed: true, persisted: false, toolCount, server: resolve(server.serverName) };
      });
    },
    /** 新增受管连接（默认持久化）。 */
    async add(input, options = {}) {
      return enqueue(async () => {
        const record = normalizeRecord(input, { source: 'managed' });
        const persist = options.persist !== false;
        const existingProfile = snapshot().servers.find(
          (server) => server.serverName === record.serverName && server.origin === 'profile' && !server.id.startsWith(ENTRY_PREFIX),
        );
        if (existingProfile !== undefined) {
          throw new ManagerError(
            'server-name-conflict',
            `serverName “${record.serverName}” 已被 profile 条目 ${existingProfile.id} 使用；请换一个 serverName，或用 mcp_manager_update 只做运行时修改。`,
          );
        }
        const existingManaged = store.has(record.serverName);
        if (persist) {
          await store.mutate((draft) => {
            const now = Date.now();
            const previous = draft.servers[record.serverName];
            draft.servers[record.serverName] = {
              ...record,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
            return null;
          });
        }
        try {
          await provisionEntry(ctx, record);
          provisionFailures.delete(record.serverName);
        } catch (error) {
          provisionFailures.set(record.serverName, errorText(error));
          if (persist) {
            // 接入失败时保留记录（用户可在 UI 里改配置重试），但把错误抛给调用方
            throw error;
          }
          throw error;
        }
        const toolCount = record.enabled === false ? 0 : await settleEntry(record.serverName, true);
        return {
          updated: existingManaged,
          persisted: persist,
          toolCount,
          server: resolve(record.serverName),
          storePath: store.path,
        };
      });
    },
    /** 修改一条连接：受管记录持久化重建；profile 行只改运行时配置。 */
    async update(key, patch) {
      return enqueue(async () => {
        const server = resolve(key);
        if (!isPlainObject(patch)) throw new ManagerError('invalid-config', 'patch 必须是对象');
        if (isManaged(server)) {
          const record = recordOf(server);
          if (record === undefined) throw new ManagerError('not-managed', `${server.serverName} 没有受管记录`);
          const effectivePatch = isPlainObject(patch) ? { ...patch } : {};
          // 空字符串 url 表示「保持原值」（UI 在 urlMasked 时会留空提交）
          if (effectivePatch.url === '') delete effectivePatch.url;
          const merged = { ...record, ...effectivePatch, serverName: record.serverName };
          // reconnect 是嵌套对象：允许只改一个字段，做浅合并而不是整体覆盖
          if (isPlainObject(patch.reconnect) && isPlainObject(record.reconnect)) {
            merged.reconnect = { ...record.reconnect, ...patch.reconnect };
          }
          // 密钥三态：null / deleteHeaders / deleteEnv = 删除；缺省 = 保留；字符串对象 = 覆盖
          if (patch.headers === null || patch.deleteHeaders === true) delete merged.headers;
          if (patch.env === null || patch.deleteEnv === true) delete merged.env;
          delete merged.deleteHeaders;
          delete merged.deleteEnv;
          const normalized = normalizeRecord(merged, { source: 'managed' });
          await store.mutate((draft) => {
            draft.servers[server.serverName] = { ...normalized, createdAt: record.createdAt ?? Date.now(), updatedAt: Date.now() };
            return null;
          });
          try {
            await provisionEntry(ctx, normalized);
            provisionFailures.delete(server.serverName);
          } catch (error) {
            provisionFailures.set(server.serverName, errorText(error));
            throw error;
          }
          const toolCount = normalized.enabled === false ? 0 : await settleEntry(server.serverName, true);
          return { persisted: true, server: resolve(server.serverName), toolCount };
        }

        const entry = entryOf(server);
        if (entry === undefined) throw new ManagerError('entry-missing', `${server.serverName} 的 loader 条目不存在`);
        const previous = rawConfig(entry);
        const nextConfig = { ...previous };
        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined || field === 'serverName' || field === 'enabled' || field === 'persist') continue;
          if (field === 'deleteHeaders' || field === 'deleteEnv') continue;
          if (field === 'url' && value === '') continue; // 留空 = 保持原值
          if (value === null) {
            delete nextConfig[field];
            continue;
          }
          if (field === 'reconnect' && isPlainObject(value) && isPlainObject(nextConfig.reconnect)) {
            nextConfig.reconnect = { ...nextConfig.reconnect, ...value };
            continue;
          }
          nextConfig[field] = value;
        }
        if (patch.deleteHeaders === true) delete nextConfig.headers;
        if (patch.deleteEnv === true) delete nextConfig.env;
        await ctx.loader.update(entry.id ?? entry.options?.id, { config: nextConfig });
        return {
          persisted: false,
          warning: '这是 profile 静态声明的行：修改只在本次运行生效；需要持久化请用 mcp_manager_export 导出 patch。',
          server: resolve(server.serverName),
        };
      });
    },
    /** 移除：受管 → 删记录+条目；profile → 仅运行时移除。 */
    async remove(key) {
      return enqueue(async () => {
        const server = resolve(key);
        if (isManaged(server)) {
          await store.mutate((draft) => {
            delete draft.servers[server.serverName];
            return null;
          });
          const removed = await removeEntry(ctx, server.serverName);
          provisionFailures.delete(server.serverName);
          return {
            removed: true, // 受管记录已删除（条目可能本来就不存在）
            entryRemoved: removed.removed === true,
            persisted: true,
            serverName: server.serverName,
          };
        }
        const entry = entryOf(server);
        if (entry === undefined) return { removed: false, persisted: false, serverName: server.serverName };
        await ctx.loader.remove(entry.id ?? entry.options?.id);
        return {
          removed: true,
          persisted: false,
          warning: '这是 profile 静态声明的行：仅本次运行移除，重启后会恢复；需要持久删除请改 profile 的 cordis.patch.yml。',
          serverName: server.serverName,
        };
      });
    },
    /** MCP 握手探针（不修改任何东西）。 */
    probe(key, options = {}) {
      const server = resolve(key);
      const cacheKey = server.serverName;
      if (probeInFlight.has(cacheKey)) return probeInFlight.get(cacheKey);
      const promise = withProbeSlot(async () => {
        const target = probeTarget(server);
        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1000), 60000) : undefined;
        const result = await probeRecord(target, timeoutMs === undefined ? {} : { timeoutMs });
        const output = {
          serverName: server.serverName,
          transport: server.transport,
          ok: result.ok === true,
          reachable: result.ok === true,
          latencyMs: result.latencyMs ?? 0,
          ...(Number.isFinite(result.toolCount) ? { toolCount: result.toolCount } : {}),
          ...(result.protocolVersion !== undefined ? { protocolVersion: String(result.protocolVersion) } : {}),
          ...(result.serverInfo !== undefined ? { serverInfo: result.serverInfo } : {}),
          ...(result.serverInfo?.name !== undefined ? { serverNameRemote: String(result.serverInfo.name) } : {}),
          ...(Array.isArray(result.tools) ? { tools: result.tools } : {}),
          ...(result.error !== undefined ? { error: String(result.error) } : {}),
          ...(result.errorCode !== undefined ? { errorCode: String(result.errorCode) } : {}),
          ...(result.warning !== undefined ? { warning: String(result.warning) } : {}),
          ...(result.stderr !== undefined ? { stderr: String(result.stderr) } : {}),
          ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        };
        if (options.persist !== false) {
          const recorded = await recordProbeHistory(output);
          if (recorded !== undefined) output.history = recorded.history;
        }
        return output;
      }).finally(() => probeInFlight.delete(cacheKey));
      probeInFlight.set(cacheKey, promise);
      return promise;
    },
    /**
     * 批量探针：默认探测所有已启用的服务（按 serverName 去重）。
     *
     * @param {object} [options]
     * @param {string[]} [options.servers] - 指定服务/条目 key 列表。
     * @param {boolean} [options.includeDisabled] - 为 true 时连停用服务也探（默认跳过）。
     * @param {number} [options.concurrency] - 并发（默认 3，上限 8）。
     * @param {number} [options.timeoutMs] - 单个探针超时。
     * @returns {Promise<object>} { total, ok, failed, results }
     */
    async probeMany(options = {}) {
      let targets;
      if (Array.isArray(options.servers) && options.servers.length > 0) {
        const seen = new Set();
        targets = [];
        for (const key of options.servers) {
          const server = resolve(key);
          if (seen.has(server.serverName)) continue;
          seen.add(server.serverName);
          targets.push(server);
        }
      } else {
        targets = [...uniqueServers().values()].filter((server) => options.includeDisabled === true || server.enabled);
      }
      const concurrency = Number.isFinite(options.concurrency)
        ? Math.min(Math.max(Math.trunc(options.concurrency), 1), 8)
        : 3;
      const results = new Array(targets.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const index = cursor;
          cursor += 1;
          const server = targets[index];
          try {
            results[index] = await manager.probe(server.serverName, { timeoutMs: options.timeoutMs });
          } catch (error) {
            results[index] = {
              serverName: server.serverName,
              transport: server.transport,
              ok: false,
              reachable: false,
              latencyMs: 0,
              error: errorText(error),
              errorCode: 'probe-failed',
            };
            await recordProbeHistory(results[index]);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, worker));
      const ok = results.filter((result) => result?.ok === true).length;
      return { total: results.length, ok, failed: results.length - ok, results };
    },
    /** 扫描本机其它 MCP 客户端配置（只读，不回显凭据），并标注与现有服务的冲突。 */
    async scan(options = {}) {
      const result = await scanImports(options);
      for (const source of result.sources) {
        if (typeof source?.file === 'string' && source.file !== '') trustedImportFiles.add(source.file);
      }
      const known = new Map(snapshot().servers.map((server) => [server.serverName, server.origin]));
      return {
        ...result,
        candidates: result.candidates.map((candidate) => {
          const origin = known.get(candidate.serverName);
          return origin === undefined
            ? candidate
            : { ...candidate, conflict: true, conflictWith: origin };
        }),
      };
    },
    /**
     * 从 JSON/文件导入。先给出「计划」（新增 / 冲突），确认后再写。
     *
     * `options.onConflict`：
     *   - `skip`（默认）：跳过同名条目；
     *   - `overwrite`：覆盖受管记录（profile 静态行不允许覆盖，会跳过并说明）；
     *   - `rename`：自动改名为 `<name>-2`、`<name>-3`… 后导入。
     */
    async import(input, options = {}) {
      if (isPlainObject(input) && typeof input.file === 'string' && input.file !== '' && !trustedImportFiles.has(input.file)) {
        throw new ManagerError(
          'import-file-untrusted',
          '只允许导入本会话扫描到的客户端配置文件：请先调用 mcp_manager_scan（面板里点「扫描本机配置」），再传它返回的 file 路径。',
        );
      }
      const parsed = await readImportSource(input);
      const known = new Map(snapshot().servers.map((server) => [server.serverName, server.origin]));
      const records = Object.values(parsed.records);

      if (options.apply !== true) {
        return {
          preview: true,
          records: records.map((record) => {
            const conflict = known.get(record.serverName);
            return {
              serverName: record.serverName,
              transport: record.transport,
              endpoint: endpointOf(record) || undefined,
              hasSecrets: record.headers !== undefined || record.env !== undefined,
              ...(conflict !== undefined ? { conflict } : {}),
            };
          }),
          errors: parsed.errors,
          skipped: parsed.skipped,
        };
      }

      const onConflict = ['skip', 'overwrite', 'rename'].includes(options.onConflict) ? options.onConflict : 'skip';
      const enabled = options.enabled !== false;
      const imported = [];
      const skipped = [...parsed.skipped];
      const errors = [...parsed.errors];
      const uniqueName = (base) => {
        for (let index = 2; index < 100; index += 1) {
          const candidate = `${base}-${index}`.slice(0, 32);
          if (!known.has(candidate)) return candidate;
        }
        throw new ManagerError('rename-exhausted', `无法为 ${base} 生成不冲突的服务名`);
      };

      for (const record of records) {
        const conflict = known.get(record.serverName);
        try {
          if (conflict === undefined) {
            const added = await manager.add({ ...record, enabled }, { persist: true });
            imported.push({ serverName: record.serverName, toolCount: added.toolCount, updated: false });
            known.set(record.serverName, 'managed');
            continue;
          }
          if (onConflict === 'skip') {
            skipped.push(`${record.serverName}（已存在：${conflict}）`);
            continue;
          }
          if (onConflict === 'overwrite') {
            if (conflict !== 'managed') {
              skipped.push(`${record.serverName}（profile 静态声明不允许被导入覆盖）`);
              continue;
            }
            const updated = await manager.update(record.serverName, { ...record, enabled });
            imported.push({ serverName: record.serverName, toolCount: updated.toolCount ?? 0, updated: true });
            continue;
          }
          // rename
          const renamed = uniqueName(record.serverName);
          const added = await manager.add({ ...record, serverName: renamed, enabled }, { persist: true });
          imported.push({ serverName: renamed, toolCount: added.toolCount, updated: false });
          known.set(renamed, 'managed');
        } catch (error) {
          errors.push(`${record.serverName}: ${errorText(error)}`);
        }
      }
      return { preview: false, imported, errors, skipped };
    },
    /**
     * 导出：patch（cordis.patch.yml）/ json（mcpServers）/ markdown（清单）/ diagnostics（诊断报告）。
     *
     * 选择范围：`server` 单个服务；`servers` 多个服务（服务名/条目 id）；都不传则导出全部。
     */
    async export(input = {}) {
      const format = ['json', 'markdown', 'diagnostics'].includes(input.format) ? input.format : 'patch';
      const { servers, summary } = snapshot();
      const redact = input.redact !== false;

      if (format === 'diagnostics') {
        const text = exportDiagnostics({
          servers,
          summary,
          prefs: prefs.snapshot(),
          storePath: store.path,
          prefsPath: prefs.path,
          provisionFailures: Object.fromEntries(provisionFailures),
          generatedAt: new Date().toISOString(),
        });
        return { format, content: text, warnings: [], recordCount: servers.length };
      }

      let selected = servers;
      if (typeof input.server === 'string' && input.server !== '') {
        const only = resolve(input.server).serverName;
        selected = servers.filter((server) => server.serverName === only);
      }
      if (Array.isArray(input.servers) && input.servers.length > 0) {
        const wanted = new Set(input.servers.map((key) => resolve(key).serverName));
        selected = selected.filter((server) => wanted.has(server.serverName));
      }
      const selectionWarnings = [];
      if (format === 'patch' && input.includeProfile !== true) {
        const profileRows = selected.filter((server) => server.origin === 'profile');
        if (profileRows.length > 0) {
          selectionWarnings.push(
            `patch 导出默认只含受管记录：已跳过 ${profileRows.length} 个 profile 静态行`
            + '（它们已经在 cordis.patch.yml 里，再 insert 会产生重复 loader id）。需要覆盖式片段请传 includeProfile=true。',
          );
        }
        selected = selected.filter((server) => server.origin === 'managed');
      }
      const { records, warnings } = collectExportRecords(selected, {
        records: store.list(),
        entryOf,
      });
      if (format === 'json') {
        const out = exportMcpServersJson(records, { redact });
        return { format, content: out.json, warnings: [...selectionWarnings, ...warnings, ...out.warnings], recordCount: records.length };
      }
      if (format === 'markdown') {
        const out = exportMarkdown(selected, summary);
        return { format, content: out, warnings: [...selectionWarnings, ...warnings], recordCount: records.length };
      }
      const out = exportPatchYaml(records, { redact });
      return { format, content: out.yaml, warnings: [...selectionWarnings, ...warnings, ...out.warnings], recordCount: records.length };
    },
    /** 编辑表单用的配置视图：非敏感字段给原值，凭据只给 key 列表。 */
    configForEdit(key) {
      const server = resolve(key);
      const view = {
        id: server.id,
        serverName: server.serverName,
        origin: server.origin,
        transport: server.transport,
        enabled: server.enabled,
        toolCallTimeoutMs: undefined,
        hasHeaders: false,
        headerKeys: [],
        hasEnv: false,
        envKeys: [],
        advanced: {},
      };
      const record = isManaged(server) ? recordOf(server) : undefined;
      const source = record ?? (entryOf(server) ? liveConfig(entryOf(server)) : undefined);
      if (source !== undefined) {
        if (source.transport === 'streamable-http') {
          if (typeof source.url === 'string') {
            const display = redactUrl(source.url);
            view.url = display ?? source.url;
            view.urlMasked = display !== undefined && display !== source.url;
          }
          view.hasHeaders = isPlainObject(source.headers) && Object.keys(source.headers).length > 0;
          view.headerKeys = isPlainObject(source.headers) ? Object.keys(source.headers) : [];
        } else {
          view.command = typeof source.command === 'string' ? source.command : undefined;
          view.args = Array.isArray(source.args) ? source.args : [];
          view.cwd = typeof source.cwd === 'string' ? source.cwd : '';
          view.hasEnv = isPlainObject(source.env) && Object.keys(source.env).length > 0;
          view.envKeys = isPlainObject(source.env) ? Object.keys(source.env) : [];
        }
        if (Number.isFinite(source.toolCallTimeoutMs)) view.toolCallTimeoutMs = source.toolCallTimeoutMs;
        // 高级项：重连策略 / 启动失败策略 / 指令字节上限（dsh-mcp-client 支持的字段）
        const advanced = {};
        if (isPlainObject(source.reconnect)) advanced.reconnect = { ...source.reconnect };
        if (typeof source.failOnStartupError === 'boolean') advanced.failOnStartupError = source.failOnStartupError;
        if (Number.isFinite(source.maxInstructionBytes)) advanced.maxInstructionBytes = source.maxInstructionBytes;
        view.advanced = advanced;
      }
      return view;
    },
    /** Web UI 的状态快照。 */
    state() {
      const { servers, summary } = snapshot();
      const prefsSnapshot = prefs.snapshot();
      const prefsServers = isPlainObject(prefsSnapshot.servers) ? prefsSnapshot.servers : {};
      // 15s 轮询的 payload 要克制：历史只给最近 8 条（UI 色点数量），完整历史走 action=prefs。
      const trimmedPrefs = Object.fromEntries(Object.entries(prefsServers).map(([serverName, meta]) => [
        serverName,
        isPlainObject(meta) && Array.isArray(meta.history)
          ? { ...meta, history: meta.history.slice(-8) }
          : meta,
      ]));
      const mergedServers = servers.map((server) => {
          const meta = isPlainObject(prefsServers[server.serverName]) ? prefsServers[server.serverName] : undefined;
          return {
            ...server,
            tools: [],
            ...(meta?.pinned !== undefined ? { pinned: meta.pinned } : {}),
            ...(Array.isArray(meta?.tags) && meta.tags.length > 0 ? { tags: meta.tags } : {}),
            ...(typeof meta?.note === 'string' ? { note: meta.note } : {}),
            ...(isPlainObject(meta?.probe) ? { lastProbe: meta.probe } : {}),
          };
      });
      return {
        ok: true,
        // 面板轮询只需要 toolNames；工具说明体积大且可按需走 action=tools 取。
        // 收藏/标签/备注/最近探针按 serverName 合并进服务对象，UI 不必自己再拼一次。
        servers: mergedServers,
        apps: groupServersByApp(mergedServers),
        summary,
        storePath: store.path,
        prefsPath: prefs.path,
        prefs: { ...prefsSnapshot, servers: trimmedPrefs },
        storeError: store.loadError === undefined ? undefined : store.loadError.message,
        prefsError: prefs.loadError === undefined ? undefined : prefs.loadError.message,
        provisionFailures: Object.fromEntries(provisionFailures),
        toolCount: summary.toolCount,
      };
    },
  };
  return manager;
}

/** 插件配置归一化（不引入 schemastery，保持零依赖）。 */
export function normalizePluginConfig(input) {
  const config = isPlainObject(input) ? input : {};
  return {
    webApi: config.webApi !== false,
    includeDescriptions: config.includeDescriptions !== false,
    storePath: typeof config.storePath === 'string' && config.storePath !== '' ? config.storePath : undefined,
    prefsPath: typeof config.prefsPath === 'string' && config.prefsPath !== '' ? config.prefsPath : undefined,
  };
}

export const name = 'mcp-manager';
export const inject = ['tools', 'loader'];

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [input] - 插件行 config。
 */
export async function apply(ctx, input) {
  const config = normalizePluginConfig(input);
  const manager = createManager(ctx, config);
  await manager.init();
  registerTools(ctx, manager);
  mountWebApi(ctx, manager, config);
  const { summary } = manager.snapshot();
  ctx.logger?.info?.(
    `[mcp-manager] 已加载：${summary.total} 个条目 / ${summary.uniqueServers} 个服务；`
    + `受管存储 ${manager.store.path}（${summary.managed} 条受管记录）`,
  );
}
