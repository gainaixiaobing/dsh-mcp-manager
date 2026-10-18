#!/usr/bin/env node
/**
 * 最小 MCP stdio 服务器（仅测试用）：initialize / tools/list / tools/call / ping。
 * 通过环境变量 STUB_TOOLS（逗号分隔）可改工具名，便于测试区分实例。
 */
const toolNames = (process.env.STUB_TOOLS ?? 'echo,ping').split(',').map((name) => name.trim()).filter(Boolean);
const TOOLS = toolNames.map((name) => ({
  name,
  description: `${name} from stub-mcp`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}));
let buffer = '';

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) return;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'stub-mcp', version: '0.0.1' },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      reply(id, { content: [{ type: 'text', text: `${name}:ok` }] });
      return;
    }
    default:
      if (id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })}\n`);
      }
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`stub-mcp: ${error.message}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
