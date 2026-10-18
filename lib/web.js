/**
 * 同源 HTTP API：给设置页 UI 用（也可被外部脚本 curl）。
 *
 *   GET  /mcp-manager/api/state              → 服务清单 + 汇总 + 存储路径
 *   POST /mcp-manager/api/action {method,...} → 白名单动作
 *
 * 安全：只接受回环 Host，且（若带 Origin）必须与 Host 同源；不返回任何凭据值。
 * `webApi: false` 或宿主没有 webServer 时静默跳过。
 */
import { errorText } from './util.js';

const ACTION_WHITELIST = new Set(['list', 'inspect', 'config', 'setEnabled', 'add', 'update', 'remove', 'probe', 'scan', 'import', 'export']);

function headerValue(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isTrustedRequest(request) {
  const host = headerValue(request, 'host');
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname;
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || hostname.endsWith('.localhost');
  if (!loopback) return false;
  if (headerValue(request, 'sec-fetch-site') === 'cross-site') return false;
  const origin = headerValue(request, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** POST 动作分发：只暴露白名单方法。 */
async function dispatch(manager, method, params) {
  if (!ACTION_WHITELIST.has(method)) throw new Error(`未知方法 "${method}"（可用：${[...ACTION_WHITELIST].join('、')}）`);
  switch (method) {
    case 'list': return manager.list(params ?? {});
    case 'inspect': return manager.inspect(params?.server);
    case 'config': return manager.configForEdit(params?.server);
    case 'setEnabled': return manager.setEnabled(params?.server, params?.enabled === true);
    case 'add': return manager.add(params ?? {}, { persist: params?.persist !== false });
    case 'update': return manager.update(params?.server, params?.changes ?? {});
    case 'remove': return manager.remove(params?.server);
    case 'probe': return manager.probe(params?.server, { timeoutMs: params?.timeoutMs });
    case 'scan': return manager.scan(params ?? {});
    case 'import': return manager.import(params ?? {}, {
      apply: params?.apply === true,
      onConflict: params?.onConflict,
      enabled: params?.enabled,
    });
    case 'export': return manager.export(params ?? {});
    default: throw new Error(`未实现的方法：${method}`);
  }
}

/**
 * 挂载同源管理 API。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} manager - `createManager()` 的返回值。
 * @param {object} [config] - 插件配置（webApi 开关）。
 */
export function mountWebApi(ctx, manager, config = {}) {
  if (config.webApi === false) return;
  if (typeof ctx.inject !== 'function') return;
  const logger = ctx.logger ?? console;
  try {
    ctx.inject(['webServer'], (wctx) => {
      wctx.effect(() => {
        const apiDisposer = wctx.webServer.register({
          kind: 'prefix',
          path: '/mcp-manager/api',
          handler: async (request, response) => {
            if (!isTrustedRequest(request)) {
              writeJson(response, 403, { ok: false, message: 'forbidden' });
              return;
            }
            const url = new URL(request.url ?? '/', 'http://localhost');
            const pathname = url.pathname.replace(/^\/mcp-manager\/api/, '') || '/';

            if (pathname === '/state' && request.method === 'GET') {
              try {
                writeJson(response, 200, manager.state());
              } catch (error) {
                writeJson(response, 500, { ok: false, message: errorText(error) });
              }
              return;
            }

            if (pathname === '/action' && request.method === 'POST') {
              try {
                const body = await readJsonBody(request);
                const result = await dispatch(manager, body?.method, body?.params ?? {});
                writeJson(response, 200, { ok: true, result });
              } catch (error) {
                writeJson(response, 400, { ok: false, message: errorText(error) });
              }
              return;
            }

            writeJson(response, 404, { ok: false, message: 'not found' });
          },
        });
        logger.info?.('[mcp-manager] 管理 API 已挂载：/mcp-manager/api');
        return () => apiDisposer?.();
      });
    });
  } catch (error) {
    logger.warn?.(`[mcp-manager] 管理 API 未挂载：${errorText(error)}`);
  }
}
