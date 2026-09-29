import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const progressTool = { name: 'sf_crawl_progress', inputSchema: { type: 'object', properties: {} } };

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function within<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

interface Fixture {
  endpoint: string;
  streams: Set<ServerResponse>;
  methods: string[];
  streamCount: () => number;
}

async function withNativeFixture(toolResult: unknown, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const streams = new Set<ServerResponse>();
  const methods: string[] = [];
  let streamCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      streamCount++;
      streams.add(response);
      response.on('close', () => streams.delete(response));
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': native fixture stream\n\n');
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      methods.push(message.method);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      response.setHeader('Content-Type', 'application/json');
      if (message.method === 'server/discover') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
      } else if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 'licensed-app-fixture');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'native-lifecycle-fixture', version: '24.3-fixture' },
        } }));
      } else if (message.method === 'tools/list') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [progressTool] } }));
      } else if (message.method === 'tools/call' && message.params?.name === 'sf_crawl_progress') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: toolResult }));
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unexpected fixture method' } }));
      }
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP fixture address.');
  try {
    await run({ endpoint: `http://127.0.0.1:${address.port}/mcp`, streams, methods, streamCount: () => streamCount });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}

async function withBundledClient(endpoint: string, run: (client: Client, pid: number) => Promise<void>): Promise<void> {
  const client = new Client({ name: 'jestats-lifecycle-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/cli.js')],
    env: { PATH: process.env.PATH ?? '', SCREAMINGFROG_MCP_URL: endpoint }, stderr: 'pipe',
  });
  let pid: number | null = null;
  try {
    await client.connect(transport, { timeout: 5_000 });
    pid = transport.pid;
    if (pid === null) throw new Error('Expected the bundled server subprocess to be running.');
    await run(client, pid);
  } finally {
    await client.close();
    if (pid !== null && isRunning(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitFor(() => !isRunning(pid!), 'Fixture child did not terminate after forced cleanup.');
    }
  }
}

async function diagnostic(client: Client): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: 'connection_status', arguments: {} }, { timeout: 5_000 });
  const block = result.content.find(item => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Expected connection diagnostics.');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('bundled subprocess lifecycle with healthy native transport', () => {
  it('closes native SSE and exits promptly when its stdio client closes stdin', async () => {
    await withNativeFixture({ content: [{ type: 'text', text: '{"crawl_id":"fixture-crawl","crawl_complete":true,"analysis_complete":true}' }] }, async fixture => {
      await withBundledClient(fixture.endpoint, async (client, pid) => {
        expect(await diagnostic(client)).toMatchObject({ connected: true, progress: { crawlId: 'fixture-crawl' } });
        await waitFor(() => fixture.streams.size > 0, 'The native SSE connection was not established.');
        expect(fixture.methods).toContain('server/discover');
        expect(fixture.methods).toContain('initialize');
        // The SDK escalates to SIGTERM after two seconds. A shorter bound proves stdin EOF cleanup.
        await within(client.close(), 1_500, 'The bundle did not exit on stdin EOF before the SDK signal fallback.');
        await waitFor(() => !isRunning(pid), 'The bundled server child remains running after stdin EOF.');
        await waitFor(() => fixture.streams.size === 0, 'The native SSE connection remains open after plugin shutdown.');
        expect(fixture.streamCount()).toBeGreaterThan(0);
      });
    });
  }, 15_000);

  it('keeps a healthy native session connected when no crawl is loaded', async () => {
    await withNativeFixture({ isError: true, content: [{ type: 'text', text: 'No loaded crawl' }] }, async fixture => {
      await withBundledClient(fixture.endpoint, async client => {
        const result = await diagnostic(client);
        expect(result.connected).toBe(true);
        expect(result.progressError).toBeDefined();
        expect(JSON.stringify(result.progressError)).toContain('No loaded crawl');
        expect(result.nativeTools).toEqual(['sf_crawl_progress']);
      });
    });
  }, 15_000);
});
