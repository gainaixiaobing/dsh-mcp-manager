/**
 * 轻量 MCP 探针：不依赖 Harness 的 mcp-client，直接对目标服务做一次
 * `initialize` + `tools/list` 握手，用来回答「这个服务现在通不通、延迟多少、有多少工具」。
 *
 * 支持两种传输：
 *   - streamable-http：POST JSON-RPC，兼容 `application/json` 与 `text/event-stream` 两种响应；
 *   - stdio：spawn 子进程，按行收发 JSON-RPC，结束后强制 kill。
 *
 * 探针只读：不写入、不修改任何配置；stdio 会执行配置里的命令（与 mcp-client 本身一致），
 * 父进程环境会先做凭据名清洗（`@deepseek-ai/dsh-subprocess` 同款规则的最小版）。
 */
import { spawn } from 'node:child_process';
import { isPlainObject } from './util.js';
import { sanitizeText } from './sanitize.js';

const PROBE_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dsh-mcp-manager-probe', version: '0.2.0' };
const STDIO_SCRUB = /(KEY|PASSWORD|SECRET|TOKEN)/i;

/**
 * 把探针异常归到稳定错误码，便于 UI/模型区分「没连上 / 连上了但协议不对 / 超时」。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} timeout | connection_refused | dns_error | http_4xx | http_5xx |
 *   command_not_found | process_exit | protocol_mismatch | unknown
 */
export function classifyProbeError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? error?.cause?.code ?? '');
  if (error?.name === 'AbortError' || /超时|timeout/i.test(message)) return 'timeout';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|Connection refused/i.test(message)) return 'connection_refused';
  if (code === 'ENOTFOUND' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'dns_error';
  if (code === 'ENOENT' || /ENOENT|spawn .* ENOENT/i.test(message)) return 'command_not_found';
  if (/HTTP 4\d\d/.test(message)) return 'http_4xx';
  if (/HTTP 5\d\d/.test(message)) return 'http_5xx';
  if (/没有返回 result|protocol/i.test(message)) return 'protocol_mismatch';
  return 'unknown';
}

function initializeParams() {
  return {
    protocolVersion: PROBE_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  };
}

function parseSseEvents(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* 忽略无法解析的事件 */
    }
  }
  return events;
}

async function readResponsePayload(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) return parseSseEvents(text);
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

function pickResult(messages, id) {
  const found = messages.find((message) => message?.id === id);
  if (found?.error) {
    const error = found.error;
    throw new Error(`JSON-RPC 错误 ${error.code ?? ''}: ${error.message ?? JSON.stringify(error)}`.trim());
  }
  return found?.result;
}

/**
 * 探一次 streamable-http 服务。
 *
 * @param {object} record - 连接记录（transport=streamable-http）。
 * @param {object} options
 * @param {number} [options.timeoutMs] - 单次请求超时。
 * @returns {Promise<object>} 探针结果。
 */
export async function probeHttp(record, { timeoutMs = 8000 } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(isPlainObject(record.headers) ? record.headers : {}),
  };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let sessionId;
    const post = async (payload) => {
      const response = await fetch(record.url, {
        method: 'POST',
        headers: { ...headers, ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'follow',
      });
      const nextSession = response.headers.get('mcp-session-id');
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status}${body ? `: ${sanitizeText(body, 200)}` : ''}`);
        error.status = response.status;
        throw error;
      }
      const messages = await readResponsePayload(response);
      if (nextSession !== null) sessionId = nextSession;
      return { messages };
    };

    const first = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams() });
    const init = pickResult(first.messages, 1);
    if (init === undefined) throw new Error('initialize 没有返回 result（对端可能不是 MCP streamable-http 端点）');

    // notifications/initialized（无 id，失败不影响探测结论）
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});

    let tools = [];
    try {
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const result = pickResult(list.messages, 2);
      tools = Array.isArray(result?.tools) ? result.tools : [];
    } catch {
      /* 有些服务不支持 tools/list：仍算连通 */
    }

    return {
      ok: true,
      transport: 'streamable-http',
      latencyMs: Date.now() - started,
      protocolVersion: init?.protocolVersion,
      serverInfo: init?.serverInfo,
      toolCount: tools.length,
      tools: tools.map((tool) => tool?.name).filter(Boolean),
      ...(tools.length === 0 ? { warning: 'zero_tools' } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      transport: 'streamable-http',
      latencyMs: Date.now() - started,
      error: error?.name === 'AbortError' ? `探测超时（>${timeoutMs}ms）` : sanitizeText(error?.message ?? error, 400),
      errorCode: error?.name === 'AbortError' ? 'timeout' : classifyProbeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 清洗父进程环境里的凭据名，再合并记录里的 env。 */
export function buildStdioEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STDIO_SCRUB.test(key) && !key.startsWith('DSH_')) continue;
    if (key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  return { ...env, ...(isPlainObject(extra) ? extra : {}) };
}

/**
 * 探一次 stdio 服务。
 *
 * @param {object} record - 连接记录（transport=stdio）。
 * @param {object} options
 * @param {number} [options.timeoutMs] - 握手超时。
 * @returns {Promise<object>} 探针结果。
 */
export function probeStdio(record, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buffer = '';
    let stderrTail = '';
    const pending = new Map();
    let seq = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        transport: 'stdio',
        latencyMs: Date.now() - started,
        error: `探测超时（>${timeoutMs}ms；进程可能未按 MCP 协议响应）`,
        errorCode: 'timeout',
        stderr: stderrTail.length > 0 ? sanitizeText(stderrTail.slice(-1200), 500) : undefined,
      });
    }, timeoutMs);

    try {
      child = spawn(record.command, record.args ?? [], {
        cwd: record.cwd || process.cwd(),
        env: buildStdioEnv(record.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, transport: 'stdio', latencyMs: Date.now() - started, error: sanitizeText(error?.message ?? error, 400), errorCode: classifyProbeError(error) });
      return;
    }

    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        finish({ ok: false, transport: 'stdio', latencyMs: Date.now() - started, error: `无法写入子进程：${error?.message ?? error}` });
      }
    };

    const call = (method, params) => new Promise((resolveCall, rejectCall) => {
      const id = ++seq;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rejectCall(new Error(`${method} 无响应`));
      }, Math.max(1000, timeoutMs - (Date.now() - started)));
      send({ jsonrpc: '2.0', id, method, params });
    });

    child.on('error', (error) => {
      finish({ ok: false, transport: 'stdio', latencyMs: Date.now() - started, error: `启动失败：${sanitizeText(error?.message ?? error, 300)}`, errorCode: classifyProbeError(error) });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({
        ok: false,
        transport: 'stdio',
        latencyMs: Date.now() - started,
        error: `子进程提前退出（code=${code}, signal=${signal ?? 'none'}）`,
        errorCode: 'process_exit',
        exitCode: typeof code === 'number' ? code : undefined,
        stderr: stderrTail.length > 0 ? sanitizeText(stderrTail.slice(-1200), 500) : undefined,
      });
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail += String(chunk);
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = message?.id;
        if (id === undefined) continue;
        const waiter = pending.get(id);
        if (!waiter) continue;
        pending.delete(id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'JSON-RPC 错误'));
        else waiter.resolve(message.result);
      }
    });

    (async () => {
      try {
        const init = await call('initialize', initializeParams());
        // notifications/initialized（无响应，不要 await 结果）
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        let tools = [];
        try {
          const list = await call('tools/list', {});
          tools = Array.isArray(list?.tools) ? list.tools : [];
        } catch {
          /* 不支持 tools/list 仍算连通 */
        }
        finish({
          ok: true,
          transport: 'stdio',
          latencyMs: Date.now() - started,
          protocolVersion: init?.protocolVersion,
          serverInfo: init?.serverInfo,
          toolCount: tools.length,
          tools: tools.map((tool) => tool?.name).filter(Boolean),
          ...(tools.length === 0 ? { warning: 'zero_tools' } : {}),
        });
      } catch (error) {
        finish({
          ok: false,
          transport: 'stdio',
          latencyMs: Date.now() - started,
          error: sanitizeText(error?.message ?? error, 400),
          errorCode: classifyProbeError(error),
          stderr: stderrTail.length > 0 ? sanitizeText(stderrTail.slice(-1200), 500) : undefined,
        });
      }
    })();
  });
}

/**
 * 探测一条连接（按 transport 分派）。
 *
 * @param {object} record - 规范化连接记录。
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<object>} 探针结果。
 */
export function probeRecord(record, options = {}) {
  if (record.transport === 'streamable-http') return probeHttp(record, options);
  if (record.transport === 'stdio') return probeStdio(record, options);
  return Promise.resolve({
    ok: false,
    transport: record.transport,
    latencyMs: 0,
    error: `不支持的 transport：${record.transport}`,
  });
}
