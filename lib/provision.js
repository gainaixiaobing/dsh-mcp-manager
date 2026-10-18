/**
 * 把「自管连接记录」落成 `@deepseek-ai/dsh-mcp-client` 的 loader 条目。
 *
 * 与连接器插件相同的思路：不写 profile 文件，而是在启动时通过 `ctx.loader.create/update`
 * 动态插入条目；条目 id 固定为 `mcp-manager-<serverName>`，因此重复 provision 是幂等的，
 * serverName 不变则工具名不变（`mcp__<serverName>__<tool>`）。
 */
import { MCP_CLIENT, isPlainObject, ManagerError } from './util.js';
import { buildEntryConfig } from './config.js';
import { liveConfig } from './inventory.js';

export const ENTRY_PREFIX = 'mcp-manager-';

/** 自管条目的固定 id。 */
export function entryIdFor(serverName) {
  return `${ENTRY_PREFIX}${serverName}`;
}

function hasEntry(loader, id) {
  try {
    loader.resolve(id);
    return true;
  } catch {
    return false;
  }
}

/** 在 loader 树里找使用该 serverName 的 mcp-client 条目（包括非本插件创建的）。 */
export function findEntryByServerName(ctx, serverName) {
  for (const entry of ctx.loader.entries()) {
    if (entry?.options?.name !== MCP_CLIENT) continue;
    if (liveConfig(entry).serverName === serverName) return entry;
  }
  return undefined;
}

/**
 * 创建或更新一条自管条目（幂等）。
 *
 * @param {object} ctx - Cordis 上下文（需 loader）。
 * @param {object} record - 规范化连接记录。
 * @param {object} [options]
 * @param {boolean} [options.failOnStartupError] - 覆盖启动失败策略。
 * @returns {Promise<{id: string, created: boolean, disabled: boolean}>}
 */
export async function provisionEntry(ctx, record, options = {}) {
  const id = entryIdFor(record.serverName);
  const config = buildEntryConfig(record, { failOnStartupError: options.failOnStartupError });
  const disabled = record.enabled === false;

  const foreign = [...ctx.loader.entries()].find((entry) => {
    if (entry?.options?.name !== MCP_CLIENT) return false;
    const entryId = entry.id ?? entry.options?.id;
    if (entryId === id) return false;
    return liveConfig(entry).serverName === record.serverName;
  });
  if (foreign) {
    throw new ManagerError(
      'server-name-conflict',
      `serverName “${record.serverName}” 已被 profile 中的条目 ${foreign.id ?? foreign.options?.id} 使用；同名会共享工具命名空间，不能重复接入。请换一个 serverName，或先停用/移除该 profile 行。`,
    );
  }

  if (hasEntry(ctx.loader, id)) {
    const existing = ctx.loader.resolve(id);
    const previous = isPlainObject(existing?.options?.config) ? existing.options.config : {};
    // transport 变化时整体替换，否则合并（保留 profile 未声明的字段意义不大，但合并更平滑）
    const nextConfig = previous.transport !== undefined && previous.transport !== config.transport
      ? config
      : { ...previous, ...config };
    await ctx.loader.update(id, { config: nextConfig, disabled });
    return { id, created: false, disabled };
  }

  await ctx.loader.create({ id, name: MCP_CLIENT, config, disabled });
  return { id, created: true, disabled };
}

/** 停用/启用一条自管条目。 */
export async function setEntryEnabled(ctx, serverName, enabled) {
  await ctx.loader.update(entryIdFor(serverName), { disabled: !enabled });
}

/** 移除一条自管条目（不存在则忽略）。 */
export async function removeEntry(ctx, serverName) {
  const id = entryIdFor(serverName);
  if (!hasEntry(ctx.loader, id)) return { id, removed: false };
  await ctx.loader.remove(id);
  return { id, removed: true };
}
