/**
 * 面板偏好与探针历史存储。
 *
 * 连接配置属于「受管记录」，只能覆盖插件自己接入的服务；但**收藏、标签、备注、探针历史**
 * 需要同时作用于 profile 静态行，因此单独存一份「按 serverName 的元数据」：
 *
 *   <DSH_HOME>/mcp-manager/prefs-<profile>.json   （mode 0600）
 *
 * 与 connections-*.json 同样的安全约定：0600、目录 0700、原子写、覆盖前留 `.bak`、
 * 写串行化、损坏时不覆盖原文件。这里的数据不含凭据，但仍按敏感文件对待。
 *
 * 结构（所有字段都可缺省，读取时逐项校验并截断，坏数据直接丢弃而不是整文件报错）：
 *
 *   {
 *     version: 1,
 *     updatedAt: 0,
 *     ui: { autoProbe: false },
 *     servers: {
 *       "<serverName>": {
 *         pinned: true,
 *         tags: ["办公", "法务"],
 *         note: "只有内网能连",
 *         probe: { at, ok, latencyMs, toolCount, errorCode, error },
 *         history: [{ at, ok, latencyMs, toolCount, errorCode }]
 *       }
 *     }
 *   }
 */
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPlainObject, ManagerError } from './util.js';
import { currentProfileName, dshHome } from './store.js';
import { sanitizeText } from './sanitize.js';

export const PREFS_VERSION = 1;

/** 单个服务的元数据上限（防止用户输入把文件撑大）。 */
export const PREFS_LIMITS = Object.freeze({
  tags: 8,
  tagLength: 20,
  noteLength: 200,
  history: 20,
  probeErrorLength: 400,
});

/** 默认偏好文件路径（按 profile 隔离）。 */
export function defaultPrefsPath(config = {}) {
  if (typeof config.prefsPath === 'string' && config.prefsPath !== '') return config.prefsPath;
  return join(dshHome(), 'mcp-manager', `prefs-${currentProfileName().replace(/[^A-Za-z0-9_-]+/g, '-') || 'default'}.json`);
}

export function emptyPrefs() {
  return { version: PREFS_VERSION, updatedAt: 0, ui: { autoProbe: false }, servers: {} };
}

function clampString(value, limit) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = clampString(item, PREFS_LIMITS.tagLength);
    if (tag === undefined) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= PREFS_LIMITS.tags) break;
  }
  return tags;
}

function normalizeProbe(value) {
  if (!isPlainObject(value)) return undefined;
  const at = Number(value.at);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  const probe = {
    at: Math.trunc(at),
    ok: value.ok === true,
  };
  const latencyMs = Number(value.latencyMs);
  if (Number.isFinite(latencyMs) && latencyMs >= 0) probe.latencyMs = Math.min(Math.trunc(latencyMs), 3_600_000);
  const toolCount = Number(value.toolCount);
  if (Number.isFinite(toolCount) && toolCount >= 0) probe.toolCount = Math.trunc(toolCount);
  const errorCode = clampString(value.errorCode, 40);
  if (errorCode !== undefined) probe.errorCode = errorCode;
  const error = clampString(value.error, PREFS_LIMITS.probeErrorLength);
  if (error !== undefined) probe.error = sanitizeText(error, PREFS_LIMITS.probeErrorLength);
  return probe;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return undefined;
  const history = value.map(normalizeProbe).filter((item) => item !== undefined);
  return history.slice(-PREFS_LIMITS.history);
}

/** 校验并收敛一条服务元数据；全部字段无效时返回 undefined。 */
export function normalizeServerPrefs(raw) {
  if (!isPlainObject(raw)) return undefined;
  const out = {};
  if (typeof raw.pinned === 'boolean') out.pinned = raw.pinned;
  const tags = normalizeTags(raw.tags);
  if (tags !== undefined && tags.length > 0) out.tags = tags;
  const note = clampString(raw.note, PREFS_LIMITS.noteLength);
  if (note !== undefined) out.note = note;
  const app = clampString(raw.app, PREFS_LIMITS.appLength);
  if (app !== undefined) out.app = app;
  const probe = normalizeProbe(raw.probe);
  if (probe !== undefined) out.probe = probe;
  const history = normalizeHistory(raw.history);
  if (history !== undefined && history.length > 0) out.history = history;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 把外部传入的「设置偏好」补丁合并进一条元数据（null 表示清除该字段）。 */
export function applyPrefsPatch(current, patch) {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const field of ['pinned', 'tags', 'note', 'app']) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value === null) {
      delete base[field];
      continue;
    }
    base[field] = value;
  }
  return normalizeServerPrefs(base) ?? {};
}

function validateShape(data, path) {
  if (!isPlainObject(data)) throw new ManagerError('prefs-invalid', `偏好文件 ${path} 不是 JSON 对象`);
  if (data.servers !== undefined && !isPlainObject(data.servers)) {
    throw new ManagerError('prefs-invalid', `偏好文件 ${path} 的 servers 字段必须是对象`);
  }
  return data.servers ?? {};
}

/**
 * profile 作用域的偏好存储。所有写操作经 `mutate` 串行化。
 */
export class PrefsStore {
  #path;

  /**
   * @param {object} options
   * @param {string} options.path - 文件绝对路径。
   * @param {object} [options.logger] - 宿主 logger（可缺省）。
   */
  constructor({ path, logger } = {}) {
    if (typeof path !== 'string' || path === '') throw new ManagerError('prefs-invalid', '偏好存储路径不能为空');
    this.#path = path;
    this.logger = logger;
    this.data = emptyPrefs();
    this.loaded = false;
    this.loadError = undefined;
    this.queue = Promise.resolve();
  }

  get path() {
    return this.#path;
  }

  /** 读取偏好；不存在视为空，损坏时保留 loadError 且绝不覆盖原文件。 */
  async load() {
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      const text = await readFile(this.path, 'utf8');
      if (text.trim() === '') return this.data;
      const parsed = JSON.parse(text);
      const servers = validateShape(parsed, this.path);
      const data = emptyPrefs();
      data.updatedAt = Number(parsed.updatedAt) || 0;
      if (isPlainObject(parsed.ui) && typeof parsed.ui.autoProbe === 'boolean') {
        data.ui.autoProbe = parsed.ui.autoProbe;
      }
      let skipped = 0;
      for (const [serverName, raw] of Object.entries(servers)) {
        const normalized = normalizeServerPrefs(raw);
        if (normalized === undefined) {
          skipped += 1;
          continue;
        }
        data.servers[serverName] = normalized;
      }
      this.data = data;
      if (skipped > 0) this.logger?.warn?.(`[mcp-manager] 偏好文件中有 ${skipped} 条服务元数据无效，已跳过`);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.loadError = new ManagerError('prefs-read-failed', `读取偏好文件失败（${this.path}）：${error.message}`);
        this.logger?.warn?.(`[mcp-manager] ${this.loadError.message}`);
      }
    }
    return this.data;
  }

  /** 某服务的元数据（不存在返回 undefined）。 */
  server(serverName) {
    return Object.hasOwn(this.data.servers, serverName) ? this.data.servers[serverName] : undefined;
  }

  /** 全部元数据快照。 */
  snapshot() {
    return { ...this.data, servers: { ...this.data.servers } };
  }

  /** 全量覆盖某个服务的偏好（内部用，调用方负责校验）。 */
  async setServer(serverName, next) {
    return this.mutate((draft) => {
      if (next === undefined || (isPlainObject(next) && Object.keys(next).length === 0)) delete draft.servers[serverName];
      else draft.servers[serverName] = next;
      return draft.servers[serverName];
    });
  }

  /** 合并式更新：pinned/tags/note，null 表示清除。 */
  async patchServer(serverName, patch) {
    return this.mutate((draft) => {
      const merged = applyPrefsPatch(draft.servers[serverName], patch);
      if (Object.keys(merged).length === 0) delete draft.servers[serverName];
      else draft.servers[serverName] = merged;
      return draft.servers[serverName];
    });
  }

  /** 记录一次探针结果：更新 last probe 并入环形历史。 */
  async recordProbe(serverName, probe, { limit = PREFS_LIMITS.history } = {}) {
    const normalized = normalizeProbe(probe);
    if (normalized === undefined) return undefined;
    return this.mutate((draft) => {
      const current = draft.servers[serverName] ?? {};
      const history = [...(current.history ?? []), { ...normalized }].slice(-limit);
      draft.servers[serverName] = { ...current, probe: normalized, history };
      return { probe: normalized, history };
    });
  }

  /** 更新 UI 级偏好（目前只有 autoProbe）。 */
  async setUi(patch) {
    return this.mutate((draft) => {
      const ui = { ...draft.ui };
      if (isPlainObject(patch) && typeof patch.autoProbe === 'boolean') ui.autoProbe = patch.autoProbe;
      draft.ui = ui;
      return ui;
    });
  }

  /**
   * 串行地读改写文件；回调拿到 draft。
   *
   * @template T
   * @param {(draft: object) => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      if (this.loadError) throw this.loadError;
      const draft = JSON.parse(JSON.stringify(this.data));
      draft.servers ??= {};
      draft.ui ??= { autoProbe: false };
      const result = await fn(draft);
      draft.version = PREFS_VERSION;
      draft.updatedAt = Date.now();
      await this.save(draft);
      this.data = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 原子写入；覆盖前留一份 `.bak`。 */
  async save(data) {
    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await copyFile(this.#path, `${this.#path}.bak`);
      await chmod(`${this.#path}.bak`, 0o600).catch(() => {});
    } catch {
      /* 首次写入没有旧文件 */
    }
    const body = `${JSON.stringify(data, null, 2)}\n`;
    const temp = join(dir, `.${this.#path.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, this.#path);
    try {
      await chmod(this.#path, 0o600);
    } catch {
      /* 忽略不支持 chmod 的平台 */
    }
  }

  /** 删除偏好文件（仅重置时用）。 */
  async destroy() {
    const { rm } = await import('node:fs/promises');
    await rm(this.#path, { force: true });
    this.data = emptyPrefs();
  }
}
