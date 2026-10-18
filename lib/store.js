/**
 * 插件自管的连接存储。
 *
 * 为什么要自己的存储：Harness 的 profile 声明是"只读配置"，运行时启停会随重启丢失。
 * 本插件把「由管理器接入的服务」持久化到 profile 作用域的 JSON 文件：
 *
 *   <DSH_HOME>/mcp-manager/connections-<profile>.json   （mode 0600）
 *
 * 仍然不碰 profile 的 `cordis.patch.yml` 和 `package.json`：启动时由 `provision` 模块
 * 把这些记录动态创建成 `@deepseek-ai/dsh-mcp-client` 条目（与连接器插件的做法一致）。
 *
 * 文件可能含凭据（headers/env），因此：
 *   - 固定 0600 权限、原子写入（tmp + rename）；
 *   - 读失败/JSON 损坏时不覆盖原文件，只报错并保持空视图（防止丢数据）。
 */
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isPlainObject, ManagerError, slug } from './util.js';
import { normalizeRecord } from './config.js';

export const STORE_VERSION = 1;

/** DSH home（与 dsh-home-paths 的约定一致，可用 DSH_HOME 覆盖）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 当前 profile 名：优先 DSH_PROFILE，其次 DSH_PROFILE_DIR 的目录名。 */
export function currentProfileName() {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR.split(/[\\/]/).filter(Boolean).pop();
  return 'default';
}

/** 默认存储路径（按 profile 隔离，避免不同 profile 互相注入服务）。 */
export function defaultStorePath(config = {}) {
  if (typeof config.storePath === 'string' && config.storePath !== '') return config.storePath;
  return join(dshHome(), 'mcp-manager', `connections-${slug(currentProfileName())}.json`);
}

export function emptyStore() {
  return { version: STORE_VERSION, updatedAt: 0, servers: {} };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateShape(data, path) {
  if (!isPlainObject(data)) throw new ManagerError('store-invalid', `连接存储 ${path} 不是 JSON 对象`);
  const servers = data.servers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new ManagerError('store-invalid', `连接存储 ${path} 的 servers 字段必须是对象`);
  }
  return servers ?? {};
}

/**
 * profile 作用域的连接存储。所有写操作经 `mutate` 串行化，避免并发写坏文件。
 */
export class ConnectionStore {
  /**
   * @param {object} options
   * @param {string} options.path - 存储文件绝对路径。
   * @param {object} [options.logger] - 宿主 logger（可缺省）。
   */
  #path;

  constructor({ path, logger } = {}) {
    if (typeof path !== 'string' || path === '') throw new ManagerError('store-invalid', '连接存储路径不能为空');
    this.#path = path;
    this.logger = logger;
    this.data = emptyStore();
    this.loaded = false;
    this.loadError = undefined;
    this.queue = Promise.resolve();
  }

  /** 读取存储；不存在视为空。损坏时保留 loadError，但绝不覆盖原文件。 */
  async load() {
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      const text = await readFile(this.path, 'utf8');
      if (text.trim() === '') {
        this.data = emptyStore();
        return this.data;
      }
      const parsed = JSON.parse(text);
      const servers = validateShape(parsed, this.path);
      this.data = { version: STORE_VERSION, updatedAt: Number(parsed.updatedAt) || 0, servers: {} };
      const skipped = [];
      for (const [serverName, raw] of Object.entries(servers)) {
        try {
          const record = normalizeRecord({ ...raw, serverName }, { source: 'managed' });
          if (record.enabled === undefined) record.enabled = true;
          this.data.servers[serverName] = record;
        } catch (error) {
          skipped.push(`${serverName}: ${error.message}`);
        }
      }
      if (skipped.length > 0) {
        this.logger?.warn?.(`[mcp-manager] 连接存储中有 ${skipped.length} 条记录无效，已跳过：${skipped.join('；')}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.data = emptyStore();
        return this.data;
      }
      this.loadError = new ManagerError('store-read-failed', `读取连接存储失败（${this.path}）：${error.message}`);
      this.logger?.warn?.(`[mcp-manager] ${this.loadError.message}`);
      this.data = emptyStore();
    }
    return this.data;
  }

  /** 当前记录列表（含 enabled/source 字段）。 */
  list() {
    return Object.values(this.data.servers);
  }

  /** 按服务名取一条记录。 */
  get(serverName) {
    return this.data.servers[serverName];
  }

  /** 是否由本插件管理（而不是 profile 静态声明）。 */
  has(serverName) {
    return Object.hasOwn(this.data.servers, serverName);
  }

  /** 存储路径（给 UI/工具展示）。 */
  get path() {
    return this.#path;
  }

  /** 原子写入；覆盖前留一份 `.bak`（只保留最近一版，供误操作回滚）。 */
  async save(data) {
    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await copyFile(this.#path, `${this.#path}.bak`);
      await chmod(`${this.#path}.bak`, 0o600).catch(() => {});
    } catch {
      /* 首次写入没有旧文件；忽略 */
    }
    const body = `${JSON.stringify(data, null, 2)}\n`;
    const temp = join(dir, `.${this.#path.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, this.#path);
    try {
      await chmod(this.#path, 0o600);
    } catch {
      /* Windows 等平台可能不支持 chmod，忽略 */
    }
  }

  /**
   * 串行地读改写存储。回调拿到可修改的 draft（深拷贝），返回任意结果。
   *
   * @template T
   * @param {(draft: {version:number, updatedAt:number, servers:Record<string,object>}) => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      if (this.loadError) throw this.loadError;
      const draft = deepClone(this.data);
      draft.servers ??= {};
      const result = await fn(draft);
      draft.version = STORE_VERSION;
      draft.updatedAt = Date.now();
      await this.save(draft);
      this.data = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 删除整个存储文件（仅卸载/重置时用）。 */
  async destroy() {
    const { rm } = await import('node:fs/promises');
    await rm(this.#path, { force: true });
    this.data = emptyStore();
  }
}
