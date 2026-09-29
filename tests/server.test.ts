import { describe, expect, test, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, MAX_PUBLIC_RESPONSE_BYTES } from '../src/server.js';
import type { AuditManager } from '../src/audit.js';
import { AuditStore } from '../src/storage.js';
import { sampleFixture } from '../sample/fixture.js';
import type { Job } from '../src/types.js';
import type { NativeClient, NativeCrawl, NativeProgress } from '../src/native-contract.js';
import { MAX_NATIVE_TOOLS, MAX_DISPLAY_CRAWL_NAME, MAX_DISPLAY_CRAWL_URL, MAX_DISPLAY_TIMESTAMP,
  MAX_DIAGNOSTIC_MESSAGE, TRUNCATION_MARKER } from '../src/native.js';

describe('bundled MCP preflight', () => {
  test('speaks stdio, lists tools and gives useful diagnostics when the native app is absent', async () => {
    const client = new Client({ name: 'jestats-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', resolve('src/cli.ts')],
      env: { PATH: process.env.PATH ?? '', SCREAMINGFROG_MCP_URL: 'http://127.0.0.1:1/mcp' }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(['audit_status', 'connection_status', 'control_audit', 'finding_details', 'list_audits', 'list_crawls', 'list_findings', 'render_report', 'start_audit']);
      const result = await client.callTool({ name: 'connection_status', arguments: {} });
      const block = result.content.find(item => item.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Expected structured diagnostics.');
      const diagnostic = JSON.parse(block.text);
      expect(diagnostic.connected).toBe(false);
      expect(diagnostic.verification).toBe('pending_licensed_windows_and_release_checks');
      expect(diagnostic.nextSteps).toHaveLength(4);
      const invalid = await client.callTool({ name: 'list_crawls', arguments: { limit: 1000 } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); }
  }, 20_000);
});

describe('bounded public MCP responses', () => {
  const oversized = 'x'.repeat(1_048_576);
  const progress: NativeProgress = { crawlId: 'exact-id', crawlComplete: true, analysisComplete: null,
    apisComplete: null, paused: false, totalUrls: 3, raw: { secretField: oversized } };

  function nativeFixture() {
    return {
      endpoint: 'http://127.0.0.1:11435/mcp', connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
      discoverTools: vi.fn(async () => [{ name: 'sf_crawl_progress', inputSchema: { type: 'object' } }]),
      status: vi.fn(async () => progress), listCrawls: vi.fn(async (): Promise<NativeCrawl[]> => []),
    } as unknown as NativeClient;
  }

  async function invoke(native: NativeClient, name: string, args: Record<string, unknown> = {}) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(native);
    const client = new Client({ name: 'bounded-response-test', version: '1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.find(block => block.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Expected JSON tool response.');
      return { result, text: text.text, value: JSON.parse(text.text) as Record<string, unknown> };
    } finally { await client.close(); await server.close(); }
  }

  test('marks optional display truncation and omits arbitrary raw and extra crawl fields', async () => {
    const native = nativeFixture();
    vi.mocked(native.listCrawls).mockResolvedValue([{ id: 'exact-id', name: oversized, url: oversized, startedAt: oversized,
      raw: { secretField: oversized }, secretField: oversized } as unknown as NativeCrawl]);
    const output = await invoke(native, 'list_crawls');
    const [crawl] = output.value.crawls as NativeCrawl[];
    expect(crawl?.id).toBe('exact-id');
    expect(crawl?.name).toHaveLength(MAX_DISPLAY_CRAWL_NAME);
    expect(crawl?.url).toHaveLength(MAX_DISPLAY_CRAWL_URL);
    expect(crawl?.startedAt).toHaveLength(MAX_DISPLAY_TIMESTAMP);
    expect(crawl?.name).toContain(TRUNCATION_MARKER);
    expect(output.text.length).toBeLessThan(3_000);
    expect(output.text).not.toContain('secretField');
    expect(output.text).not.toContain('"raw":');
  });

  test('rejects oversized exact identities from crawl and progress responses', async () => {
    const native = nativeFixture();
    vi.mocked(native.listCrawls).mockResolvedValue([{ id: oversized, name: null, url: null, startedAt: null, raw: {} }]);
    const crawls = await invoke(native, 'list_crawls');
    expect(crawls.result.isError).toBe(true);
    expect(crawls.text.length).toBeLessThan(1_000);
    vi.mocked(native.status).mockResolvedValue({ ...progress, crawlId: oversized });
    const status = await invoke(native, 'connection_status');
    expect(status.value.connected).toBe(true);
    expect(status.value.progress).toBeNull();
    expect(status.value.progressError).toContain('Oversized IDs are rejected rather than truncated');
    expect(status.text.length).toBeLessThan(1_000);
  });

  test('bounds connection and progress diagnostics with a truncation marker', async () => {
    const native = nativeFixture();
    vi.mocked(native.connect).mockRejectedValueOnce(new Error(oversized));
    const connection = await invoke(native, 'connection_status');
    expect(connection.value.connected).toBe(false);
    expect(connection.value.error).toHaveLength(MAX_DIAGNOSTIC_MESSAGE);
    expect(connection.value.error).toContain(TRUNCATION_MARKER);
    vi.mocked(native.status).mockRejectedValueOnce(new Error(oversized));
    const status = await invoke(native, 'connection_status');
    expect(status.value.connected).toBe(true);
    expect(status.value.progressError).toHaveLength(MAX_DIAGNOSTIC_MESSAGE);
    expect(status.value.progressError).toContain(TRUNCATION_MARKER);
    expect(status.text.length).toBeLessThan(3_000);
  });

  test('rejects oversized discovery metadata before publishing diagnostic tool names', async () => {
    const native = nativeFixture();
    vi.mocked(native.discoverTools).mockResolvedValueOnce([{ name: oversized, inputSchema: {} }]);
    const names = await invoke(native, 'connection_status');
    expect(names.value.connected).toBe(false);
    expect(names.value.nativeTools).toBeUndefined();
    expect(names.text.length).toBeLessThan(1_000);
    vi.mocked(native.discoverTools).mockResolvedValueOnce(Array.from({ length: MAX_NATIVE_TOOLS + 1 }, (_, index) => ({ name: `sf_fixture_${index}`, inputSchema: {} })));
    const count = await invoke(native, 'connection_status');
    expect(count.value.connected).toBe(false);
    expect(count.value.nativeTools).toBeUndefined();
  });

  test('whitelists progress fields instead of forwarding unknown native properties', async () => {
    const native = nativeFixture();
    vi.mocked(native.status).mockResolvedValue({ ...progress, secretField: oversized } as unknown as NativeProgress);
    const status = await invoke(native, 'connection_status');
    expect(status.value.connected).toBe(true);
    expect(status.value.progress).toEqual({ crawlId: 'exact-id', crawlComplete: true, analysisComplete: null, apisComplete: null, paused: false, totalUrls: 3 });
    expect(status.text).not.toContain('secretField');
    expect(status.text).not.toContain('"raw":');
  });

  test('rejects oversized aggregate JSON without sampling and accepts a reduced crawl limit', async () => {
    const native = nativeFixture();
    const crawls = Array.from({ length: 100 }, (_, index) => ({
      id: `exact-id-${index}`, name: '\u0000'.repeat(MAX_DISPLAY_CRAWL_NAME), url: '\u0000'.repeat(MAX_DISPLAY_CRAWL_URL),
      startedAt: '\u0000'.repeat(MAX_DISPLAY_TIMESTAMP), raw: {},
    }));
    vi.mocked(native.listCrawls).mockImplementation(async limit => crawls.slice(0, limit));
    const oversizedResponse = await invoke(native, 'list_crawls', { limit: 100 });
    expect(oversizedResponse.result.isError).toBe(true);
    expect(oversizedResponse.value.error).toContain('Reduce the list_crawls limit');
    expect(oversizedResponse.value.error).toContain('No rows were sampled');
    expect(oversizedResponse.value.crawls).toBeUndefined();
    expect(Buffer.byteLength(oversizedResponse.text, 'utf8')).toBeLessThan(MAX_PUBLIC_RESPONSE_BYTES);
    const reducedResponse = await invoke(native, 'list_crawls', { limit: 1 });
    expect(reducedResponse.result.isError).not.toBe(true);
    expect(reducedResponse.value.crawls).toHaveLength(1);
    expect((reducedResponse.value.crawls as NativeCrawl[])[0]?.id).toBe('exact-id-0');
    expect(Buffer.byteLength(reducedResponse.text, 'utf8')).toBeLessThan(MAX_PUBLIC_RESPONSE_BYTES);
    expect(native.listCrawls).toHaveBeenNthCalledWith(1, 100);
    expect(native.listCrawls).toHaveBeenNthCalledWith(2, 1);
  });

  test('keeps worst-case escaped connection diagnostics below the public byte budget', async () => {
    const native = nativeFixture();
    vi.mocked(native.discoverTools).mockResolvedValue(Array.from({ length: MAX_NATIVE_TOOLS }, (_, index) => ({
      name: `${index}`.padStart(128, '\u0000'), inputSchema: {},
    })));
    vi.mocked(native.status).mockRejectedValue(new Error('\u0000'.repeat(1_048_576)));
    const output = await invoke(native, 'connection_status');
    expect(output.value.connected).toBe(true);
    expect(output.value.nativeTools).toHaveLength(MAX_NATIVE_TOOLS);
    expect(output.value.progressError).toHaveLength(MAX_DIAGNOSTIC_MESSAGE);
    expect(output.value.progressError).toContain(TRUNCATION_MARKER);
    expect(Buffer.byteLength(output.text, 'utf8')).toBeLessThan(MAX_PUBLIC_RESPONSE_BYTES);
  });
});

describe('audit MCP tools over stdio', () => {
  async function withReadyAudit(run: (client: Client, fixture: { store: AuditStore; job: Job; root: string }) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'jestats-server-audit-')); const store = new AuditStore(root); const id = randomUUID();
    const { result, pages } = sampleFixture(120); result.id = id; result.sourceCrawlId = 'saved-fixture-crawl';
    Object.assign(pages[8]!, { rawPageHtml: '<script>untrusted raw page</script>', privateUnknownField: 'excluded-from-evidence' });
    const job: Job = { schemaVersion: 1, id, createdAt: result.createdAt, updatedAt: result.createdAt, stage: 'ready', source: { crawlId: result.sourceCrawlId, configPath: '/private/hidden/config.seospiderconfig' }, crawlName: 'Fixture audit', nativeCrawlId: result.sourceCrawlId, ownsCrawl: false, preset: result.provenance.preset, clientName: 'Persisted Client', extractedRows: pages.length, message: 'Audit ready.', configHash: 'private-hash', checkpoint: { crawlId: result.sourceCrawlId, sourceTotal: 120, taskIndex: 0, pageSize: 100, tasks: [], linksAttempted: true } };
    await store.saveJob(job); const writer = await store.beginSnapshot(id); for (const page of pages) await writer.append(page); await writer.commit(); await store.saveResult(result);
    const client = new Client({ name: 'jestats-audit-stdio-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/cli.ts')], env: { PATH: process.env.PATH ?? '', SCREAMINGFROG_MCP_URL: 'http://127.0.0.1:1/mcp', JESTATS_AUDIT_DATA_DIR: root }, stderr: 'pipe' });
    try { await client.connect(transport); await run(client, { store, job, root }); }
    finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }); const block = result.content.find(item => item.type === 'text');
    if (!block || block.type !== 'text') throw new Error('Expected JSON response.');
    return { response: result, text: block.text, value: JSON.parse(block.text) as Record<string, unknown> };
  }
  test('lists durable jobs without private configuration or checkpoint state', async () => {
    await withReadyAudit(async (client, { job }) => {
      const output = await call(client, 'list_audits', { limit: 1 });
      expect(output.value.audits).toHaveLength(1); expect(output.text).toContain(job.id);
      expect(output.text).not.toContain('checkpoint'); expect(output.text).not.toContain('configPath'); expect(output.text).not.toContain('private-hash'); expect(output.text).not.toContain('/private/hidden');
      const status = await call(client, 'audit_status', { auditId: job.id });
      expect(status.response.isError).not.toBe(true); expect(status.value.audit).toMatchObject({ stage: 'ready', extractedRows: 120, availableActions: [] });
    });
  }, 20_000);
  test('rejects ambiguous starts, missing configuration acknowledgement, traversal, and unbounded evidence before work', async () => {
    await withReadyAudit(async (client, { job, store }) => {
      for (const args of [{}, { crawlId: 'id', url: 'https://example.test/', useCurrentConfig: true }, { crawlId: 'id', useCurrentConfig: true }, { url: 'javascript:alert(1)', useCurrentConfig: true }, { url: 'https://user:secret@example.test/', useCurrentConfig: true }, { url: 'https://example.test/', configPath: '../../secret' }]) {
        const invalid = await client.callTool({ name: 'start_audit', arguments: args }); expect(invalid.isError).toBe(true);
      }
      expect(await store.listJobs()).toHaveLength(1);
      for (const args of [{ auditId: '../../outside' }, { auditId: job.id, limit: 101 }, { auditId: job.id, offset: -1 }, { auditId: job.id, outputPath: '/private/arbitrary' }]) {
        const invalid = await client.callTool({ name: 'list_findings', arguments: args }); expect(invalid.isError).toBe(true);
      }
      const invalidReport = await client.callTool({ name: 'render_report', arguments: { auditId: job.id, outputPath: '/private/arbitrary' } }); expect(invalidReport.isError).toBe(true);
    });
  }, 20_000);
  test('paginates computed findings and exact affected evidence while retaining null metrics', async () => {
    await withReadyAudit(async (client, { job, store }) => {
      const result = await store.readResult(job.id);
      const listed = await call(client, 'list_findings', { auditId: job.id, offset: 1, limit: 2 });
      expect(listed.value.total).toBe(6); expect(listed.value.nextOffset).toBe(3); expect(listed.value.findings).toEqual(result.findings.slice(1, 3).map(({ affectedIds: _ids, ...finding }) => finding));
      expect(listed.text).not.toContain('affectedIds'); expect(listed.value).not.toHaveProperty('pages');
      const beyondUrlLimit = await call(client, 'list_findings', { auditId: job.id, offset: 100_001, limit: 1 });
      expect(beyondUrlLimit.response.isError).not.toBe(true); expect(beyondUrlLimit.value.findings).toEqual([]);
      const finding = result.findings[0]!;
      const details = await call(client, 'finding_details', { auditId: job.id, findingId: finding.id, offset: 2, limit: 3 });
      expect(details.value.finding).toMatchObject({ id: finding.id, affectedCount: finding.affectedCount, searchClicks: null });
      expect((details.value.pages as Array<{ id: number }>).map(page => page.id)).toEqual(finding.affectedIds.slice(2, 5)); expect(details.value.nextOffset).toBe(5);
      expect(details.text).not.toContain('rawPageHtml'); expect(details.text).not.toContain('privateUnknownField');
      expect(Buffer.byteLength(details.text)).toBeLessThan(MAX_PUBLIC_RESPONSE_BYTES);
      const filtered = await call(client, 'list_findings', { auditId: job.id, priority: 'high', category: 'canonicals' }); expect(filtered.value.total).toBe(1);
      const missing = await call(client, 'finding_details', { auditId: job.id, findingId: 'invented' }); expect(missing.response.isError).toBe(true);
    });
  }, 20_000);
  test('rejects invented narrative before writing files and publishes unique private offline reports', async () => {
    await withReadyAudit(async (client, { job, store }) => {
      const invalid = await call(client, 'render_report', { auditId: job.id, narrative: { findings: [{ findingId: 'invented', commentary: 'A made-up fact.' }] } });
      expect(invalid.response.isError).toBe(true); expect(invalid.value.error).toContain('unknown finding');
      await expect(readdir(join(store.directory(job.id), 'reports'))).rejects.toMatchObject({ code: 'ENOENT' });
      const first = await call(client, 'render_report', { auditId: job.id, siteName: 'Client & Site' }); const second = await call(client, 'render_report', { auditId: job.id });
      expect(first.response.isError).not.toBe(true); expect(first.value).toMatchObject({ pageCount: 120, findingCount: 6, offline: true }); expect(first.value.htmlPath).not.toBe(second.value.htmlPath);
      const htmlPath = first.value.htmlPath as string; expect(htmlPath.startsWith(join(store.directory(job.id), 'reports'))).toBe(true);
      const html = await readFile(htmlPath, 'utf8'); expect(html).toContain('Client &amp; Site'); expect(html).toContain('Persisted Client'); expect(html).toContain('connect-src &#39;none&#39;');
      const reports = await readdir(join(store.directory(job.id), 'reports')); expect(reports).toHaveLength(2); expect(reports.some(name => name.endsWith('.partial'))).toBe(false);
      if (process.platform !== 'win32') expect((await stat(htmlPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(first.value.findingsCsvPath as string, 'utf8')).toContain('Finding ID'); expect(await readFile(first.value.urlsCsvPath as string, 'utf8')).toContain('Search clicks');
    });
  }, 20_000);
});

describe('audit control routing', () => {
  test('forwards valid commands to the manager and excludes mutable private state', async () => {
    const job: Job = { schemaVersion: 1, id: randomUUID(), createdAt: '2026-09-29T12:00:00Z', updatedAt: '2026-09-29T12:00:00Z', stage: 'paused', source: { crawlId: 'exact-crawl', configPath: '/private/settings' }, crawlName: 'Controlled fixture', nativeCrawlId: 'exact-crawl', ownsCrawl: true, preset: 'technical-audit-v1', extractedRows: 14, message: 'Paused', configHash: 'private-config-hash' };
    const manager = { control: vi.fn(async () => job), start: vi.fn(async () => job) } as unknown as AuditManager;
    const native = { endpoint: 'http://127.0.0.1:1/mcp' } as NativeClient;
    const server = createServer(native, manager); const client = new Client({ name: 'control-routing', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: 'control_audit', arguments: { auditId: job.id, action: 'resume' } });
      expect(manager.control).toHaveBeenCalledWith(job.id, 'resume'); expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain('private-config-hash'); expect(JSON.stringify(result)).not.toContain('/private/settings');
      const start = await client.callTool({ name: 'start_audit', arguments: { url: 'https://example.test/', useCurrentConfig: true } });
      expect(manager.start).toHaveBeenCalledWith({ url: 'https://example.test/', useCurrentConfig: true }); expect(start.isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
