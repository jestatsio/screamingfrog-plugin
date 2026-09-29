import { describe, expect, it, vi } from 'vitest';
import { NativeError, ScreamingFrogNative, nativeFetch, normalizeProgress, parseNativeRows, validateNativeEndpoint,
  MAX_NATIVE_TOOLS, MAX_NATIVE_TOOL_NAME, MAX_NATIVE_CRAWL_ID, MAX_DISPLAY_CRAWL_NAME, MAX_DISPLAY_CRAWL_URL,
  MAX_DISPLAY_TIMESTAMP, MAX_DIAGNOSTIC_MESSAGE, TRUNCATION_MARKER, MAX_NATIVE_DISCOVERY_NAMES, MAX_NATIVE_DISCOVERY_NAME, NATIVE_BUSY_MESSAGE } from '../src/native.js';
import type { NativeSession, NativeTool } from '../src/native-contract.js';
import type { NativeClient, NativeProgress, NativeCrawl } from '../src/native-contract.js';
import { runControlledGate, type Evidence } from '../scripts/verify-native.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

function tool(name: string, properties: Record<string, unknown> = {}, required: string[] = []): NativeTool {
  return { name, inputSchema: { type: 'object', properties, required } };
}

const exportTool = tool('sf_export_seo_element_urls', {
  seo_element_name: { type: 'string' }, filter_name: { type: 'string' }, data_fields: { type: 'array' },
  start_index: { type: 'integer' }, max_rows: { type: 'integer' }, export_type: { type: 'string', enum: ['NDJSON', 'CSV'] },
}, ['seo_element_name', 'filter_name']);

function fixture(tools: NativeTool[], response: unknown = { content: [{ type: 'text', text: '{}' }] }) {
  const session: NativeSession = {
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async () => response),
    close: vi.fn(async () => undefined),
  };
  const factory = vi.fn(async () => session);
  return { native: new ScreamingFrogNative(undefined, factory), session, factory };
}

describe('native endpoint boundary', () => {
  it.each(['http://127.0.0.1:11435/mcp', 'http://localhost:11435/mcp', 'http://[::1]:11435/mcp'])('accepts a literal loopback endpoint %s', endpoint => {
    expect(validateNativeEndpoint(endpoint).pathname).toBe('/mcp');
  });
  it('uses a literal address for localhost', () => expect(validateNativeEndpoint('http://localhost:11435/mcp').hostname).toBe('127.0.0.1'));
  it.each(['https://127.0.0.1/mcp', 'http://example.com/mcp', 'http://localhost.evil.com/mcp', 'http://user:secret@127.0.0.1/mcp', 'http://127.0.0.1/mcp?token=x', 'http://127.0.0.1/mcp#x', 'http://127.0.0.1/files', 'garbage'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => validateNativeEndpoint(endpoint)).toThrow(NativeError);
  });
  it('forbids redirects and credentials on transport calls', async () => {
    const endpoint = validateNativeEndpoint('http://127.0.0.1:11435/mcp');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    await nativeFetch(endpoint, fetcher)(endpoint, { method: 'POST', redirect: 'follow', credentials: 'include' });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    await expect(nativeFetch(endpoint, fetcher)('http://example.com/mcp')).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    await expect(nativeFetch(endpoint, fetcher)(endpoint, { headers: { Authorization: 'secret' } })).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('conservative native progress', () => {
  it('keeps absent phases and crawl identity unknown', () => {
    expect(normalizeProgress({ progress: 100, status: 'completed', id: 'unproven' })).toEqual({
      crawlId: null, crawlComplete: null, analysisComplete: null, apisComplete: null, paused: null, totalUrls: null,
      raw: { progress: 100, status: 'completed', id: 'unproven' },
    });
  });
  it('accepts explicit booleans and identity', () => {
    expect(normalizeProgress({ progress: { crawl_id: 'crawl-1', crawl_complete: true, analysis_complete: false, apis_complete: true, paused: false, total_urls: 44 } }))
      .toMatchObject({ crawlId: 'crawl-1', crawlComplete: true, analysisComplete: false, apisComplete: true, paused: false, totalUrls: 44 });
  });
  it('rejects conflicting aliases and wrong types', () => {
    expect(normalizeProgress({ crawl_id: 'a', crawlId: 'b', crawlComplete: 'true', paused: 'false', totalUrls: -1 }))
      .toMatchObject({ crawlId: null, crawlComplete: null, paused: null, totalUrls: null });
  });
  it('never infers analysis completion from crawl completion', () => {
    expect(normalizeProgress({ crawl_id: 'a', crawl_complete: true })).toMatchObject({ analysisComplete: null, apisComplete: null });
  });
});

describe('native export decoding', () => {
  it('recognizes only an exact native terminal boundary and rejects an overshoot', async () => {
    const { native } = fixture([exportTool], { isError: true, content: [{ type: 'text', text: 'Tool error: IllegalArgumentException: start_index is greater than the total number of URLs of 13' }] });
    expect(await native.exportPage('Internal', 'All', ['Address'], 13, 3)).toMatchObject({ rows: [], startIndex: 13, hasMore: false });
    await expect(native.exportPage('Internal', 'All', ['Address'], 14, 3)).rejects.toMatchObject({ code: 'TOOL_ERROR' });
  });
  it('retries the exact busy query without replaying mutating tools', async () => {
    const { native, session } = fixture([exportTool, tool('sf_pause_crawl')]);
    vi.mocked(session.callTool).mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: NATIVE_BUSY_MESSAGE }] })
      .mockResolvedValueOnce({ structuredContent: [{ Address: 'https://example.test/' }] });
    expect((await native.exportPage('Internal', 'All', ['Address'], 0, 3)).rows).toHaveLength(1);
    expect(session.callTool).toHaveBeenCalledTimes(2);
    vi.mocked(session.callTool).mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: NATIVE_BUSY_MESSAGE }] });
    await expect(native.control('pause')).rejects.toMatchObject({ code: 'TOOL_ERROR' });
    expect(session.callTool).toHaveBeenCalledTimes(3);
  });
  it.each([
    { input: [{ Address: 'https://example.com/' }], count: 1 },
    { input: '{"Address":"https://example.com/"}\r\n{"Address":null}\n', count: 2 },
    { input: { data: { rows: [{ Address: null }] } }, count: 1 },
    { input: '', count: 0 },
    { input: '[]', count: 0 },
  ])('decodes JSON/NDJSON without guessing null fields', ({ input, count }) => expect(parseNativeRows(input)).toHaveLength(count));
  it.each(['broken\njson', '[null]', '[1]', null, { rows: [], truncated: true }, { rows: [], partial: true }, { error: 'failed' }, { data: { rows: [], truncated: true } }, '{"data":{"rows":[],"incomplete":true}}'])('rejects invalid or incomplete data', input => {
    expect(() => parseNativeRows(input)).toThrow(NativeError);
  });
  it('calls only the discovered bounded export schema and never writes native files', async () => {
    const { native, session } = fixture([exportTool], { content: [{ type: 'text', text: '{"Address":"https://example.com/a"}\n{"Address":"https://example.com/b"}' }] });
    expect(await native.exportPage('Internal', 'HTML', ['Address'], 12, 2)).toMatchObject({ startIndex: 12, hasMore: true, rows: [{ Address: 'https://example.com/a' }, { Address: 'https://example.com/b' }] });
    expect(session.callTool).toHaveBeenCalledWith('sf_export_seo_element_urls', { seo_element_name: 'Internal', filter_name: 'HTML', data_fields: ['Address'], start_index: 12, max_rows: 2, export_type: 'NDJSON' });
  });
  it('rejects unbounded schema before calling the export', async () => {
    const { native, session } = fixture([tool('sf_export_seo_element_urls', { seo_element_name: { type: 'string' }, filter_name: { type: 'string' }, data_fields: { type: 'array' } })]);
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
  it('refuses undocumented required page content arguments', async () => {
    const { native, session } = fixture([{ ...exportTool, inputSchema: { ...exportTool.inputSchema, required: ['seo_element_name', 'filter_name', 'page_content_type'] } }]);
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
  it('rejects an oversized native page', async () => {
    const { native } = fixture([exportTool], { structuredContent: [{ Address: 'a' }, { Address: 'b' }] });
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects a shortened page that explicitly reports more results', async () => {
    const { native } = fixture([exportTool], { structuredContent: { rows: [{ Address: 'a' }], hasMore: true } });
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects shortened pages with nested or string encoded hasMore envelopes', async () => {
    const { native, session } = fixture([exportTool], { structuredContent: { data: { rows: [{ Address: 'a' }], hasMore: true } } });
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    vi.mocked(session.callTool).mockResolvedValueOnce({ content: [{ type: 'text', text: '{"data":{"rows":[{"Address":"a"}],"has_more":true}}' }] });
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects messages masquerading as data rows', async () => {
    const { native } = fixture([exportTool], { content: [{ type: 'text', text: '{"file_path":"unsafe.json"}' }] });
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([-1, 0, 1_001, Infinity])('rejects invalid page size %s', async max => {
    const { native, session } = fixture([exportTool]);
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, max)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
});

describe('native discovery and actions', () => {
  it('normalizes structured progress and bounded recent crawl data', async () => {
    const { native, session } = fixture([tool('sf_crawl_progress'), tool('sf_list_crawls', { limit: { type: 'integer' } })]);
    vi.mocked(session.callTool).mockResolvedValueOnce({ content: [{ type: 'text', text: '{"crawl_id":"id-1","crawl_complete":true}' }] })
      .mockResolvedValueOnce({ structuredContent: { crawls: [{ crawl_id: 'id-1', crawl_name: 'Audit', crawl_url: 'https://example.com/' }] } });
    expect(await native.status()).toMatchObject({ crawlId: 'id-1', crawlComplete: true });
    expect(await native.listCrawls(3)).toMatchObject([{ id: 'id-1', name: 'Audit', url: 'https://example.com/' }]);
  });
  it('requires explicit crawl identity in listing', async () => {
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], { structuredContent: [{ name: 'Only a name' }] });
    await expect(native.listCrawls()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects incomplete crawl listing before unwrapping', async () => {
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], { structuredContent: { crawls: [{ id: 'id-1' }], partial: true } });
    await expect(native.listCrawls()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('preserves unknown required parameters as a capability error', async () => {
    const { native, session } = fixture([tool('sf_crawl_progress', { api_key: { type: 'string' } }, ['api_key'])]);
    await expect(native.status()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
  it('discovers filters and fields without unbounded URL exports', async () => {
    const { native, session } = fixture([
      tool('sf_list_available_filters_for_seo_element', { seo_element_name: { type: 'string' } }),
      tool('sf_list_available_data_fields_for_seo_element_and_filter', { seo_element_name: { type: 'string' }, filter_name: { type: 'string' } }),
    ]);
    vi.mocked(session.callTool).mockResolvedValueOnce({ structuredContent: { filters: ['All', 'HTML'] } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"fields":[{"name":"Address"},"Status Code"]}' }] });
    expect(await native.availableFilters('Internal')).toEqual(['All', 'HTML']);
    expect(await native.availableFields('Internal', 'HTML')).toEqual(['Address', 'Status Code']);
  });
  it('does not retry an interrupted launch', async () => {
    const { native, session } = fixture([tool('sf_crawl', { crawl_url: { type: 'string' }, crawl_name: { type: 'string' }, config_path: { type: 'string' } }, ['crawl_url'])]);
    vi.mocked(session.callTool).mockRejectedValueOnce(new Error('socket reset'));
    await expect(native.startCrawl('https://example.com', 'config.seospiderconfig', 'audit-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(session.callTool).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });
  it('returns native tool errors and safely allows a later request', async () => {
    const { native, session } = fixture([tool('sf_crawl_progress')]);
    vi.mocked(session.callTool).mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'No loaded crawl.' }] })
      .mockResolvedValueOnce({ structuredContent: { crawl_id: 'id-1' } });
    await expect(native.status()).rejects.toMatchObject({ code: 'TOOL_ERROR', message: 'No loaded crawl.' });
    expect(await native.status()).toMatchObject({ crawlId: 'id-1' });
  });
  it('rejects native tools absent from discovery', async () => {
    const { native, session } = fixture([tool('sf_run_node_js_script')]);
    await expect(native.status()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
  it('advances through tool discovery pages', async () => {
    const { native, session } = fixture([]);
    vi.mocked(session.listTools).mockResolvedValueOnce({ tools: [tool('sf_crawl_progress')], nextCursor: 'next' })
      .mockResolvedValueOnce({ tools: [exportTool] });
    expect(await native.discoverTools()).toHaveLength(2);
    expect(session.listTools).toHaveBeenNthCalledWith(2, 'next');
  });
  it('rejects repeating tool cursors', async () => {
    const { native, session } = fixture([]);
    vi.mocked(session.listTools).mockResolvedValue({ tools: [], nextCursor: 'same' });
    await expect(native.discoverTools()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('serializes access to the application within a process', async () => {
    const { native, session } = fixture([tool('sf_crawl_progress')]);
    let active = 0;
    let peak = 0;
    vi.mocked(session.callTool).mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { structuredContent: { crawl_id: 'id-1' } };
    });
    await Promise.all([native.status(), native.status(), native.status()]);
    expect(peak).toBe(1);
  });
  it('only exposes pause and resume controls', async () => {
    const { native, session } = fixture([tool('sf_pause_crawl'), tool('sf_resume_crawl')]);
    await native.control('pause');
    await native.control('resume');
    expect(session.callTool).toHaveBeenNthCalledWith(1, 'sf_pause_crawl', {});
    expect(session.callTool).toHaveBeenNthCalledWith(2, 'sf_resume_crawl', {});
  });
});

describe('installed SDK HTTP negotiation', () => {
  async function withEndpoint(handler: (request: IncomingMessage, response: ServerResponse) => void, test: (endpoint: string) => Promise<void>): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP endpoint.');
    try { await test(`http://127.0.0.1:${address.port}/mcp`); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }

  it('negotiates a legacy native HTTP server with the stable v2 SDK', async () => {
    const methods: string[] = [];
    await withEndpoint((request, response) => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        methods.push(message.method);
        if (message.id === undefined) { response.writeHead(202); response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (message.method === 'server/discover') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
        } else if (message.method === 'initialize') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture-spider', version: '24.3-fixture' } } }));
        } else if (message.method === 'tools/list') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('sf_crawl_progress')] } }));
        } else {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"crawl_id":"fixture-id","crawl_complete":true}' }] } }));
        }
      });
    }, async endpoint => {
      const native = new ScreamingFrogNative(endpoint);
      try { expect(await native.status()).toMatchObject({ crawlId: 'fixture-id', crawlComplete: true }); }
      finally { await native.close(); }
    });
    expect(methods).toContain('server/discover');
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/call');
  });

  it('reports an HTTP outage without falling back or issuing tool calls', async () => {
    const methods: string[] = [];
    await withEndpoint((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        if (body) methods.push((JSON.parse(body) as { method: string }).method);
        response.writeHead(503);
        response.end('Unavailable');
      });
    }, async endpoint => {
      const native = new ScreamingFrogNative(endpoint);
      await expect(native.connect()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await native.close();
    });
    expect(methods).toEqual(['server/discover']);
  });
});

describe('bounded native metadata', () => {
  const oversized = 'x'.repeat(1_048_576);

  it('rejects oversized crawl IDs instead of changing their identity', async () => {
    expect(() => normalizeProgress({ crawl_id: oversized })).toThrow(/Oversized IDs are rejected rather than truncated/);
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], { structuredContent: [{ crawl_id: oversized }] });
    await expect(native.listCrawls()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('preserves exact IDs at the supported size boundary', () => {
    const id = 'x'.repeat(MAX_NATIVE_CRAWL_ID);
    expect(normalizeProgress({ crawl_id: id }).crawlId).toBe(id);
  });
  it('does not send oversized crawl IDs to load operations', async () => {
    const { native, session } = fixture([tool('sf_load_crawl', { crawl_id: { type: 'string' } })]);
    await expect(native.loadCrawl(oversized)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
  it('explicitly marks shortened optional crawl display metadata', async () => {
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], {
      structuredContent: [{ crawl_id: 'exact-id', crawl_name: oversized, crawl_url: oversized, started_at: oversized }],
    });
    const [crawl] = await native.listCrawls();
    expect(crawl?.id).toBe('exact-id');
    expect(crawl?.name).toHaveLength(MAX_DISPLAY_CRAWL_NAME);
    expect(crawl?.url).toHaveLength(MAX_DISPLAY_CRAWL_URL);
    expect(crawl?.startedAt).toHaveLength(MAX_DISPLAY_TIMESTAMP);
    expect(crawl?.name).toContain(TRUNCATION_MARKER);
    expect(crawl?.url).toContain(TRUNCATION_MARKER);
    expect(crawl?.startedAt).toContain(TRUNCATION_MARKER);
  });
  it('rejects oversized native tool names without including them in the error', async () => {
    const { native } = fixture([tool(oversized)]);
    await expect(native.discoverTools()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: `Native tool names must be nonempty exact identifiers of at most ${MAX_NATIVE_TOOL_NAME} characters.` });
  });
  it('caps native tool count across discovery pages', async () => {
    const { native, session } = fixture([]);
    vi.mocked(session.listTools).mockResolvedValueOnce({ tools: Array.from({ length: MAX_NATIVE_TOOLS }, (_, index) => tool(`sf_fixture_${index}`)), nextCursor: 'next' })
      .mockResolvedValueOnce({ tools: [tool('sf_one_too_many')] });
    await expect(native.discoverTools()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(session.close).toHaveBeenCalledTimes(1);
  });
  it('bounds tool descriptions and rejects oversized schemas', async () => {
    const { native } = fixture([{ ...tool('sf_crawl_progress'), description: oversized }]);
    const [discovered] = await native.discoverTools();
    expect(discovered?.description).toHaveLength(MAX_DISPLAY_CRAWL_NAME);
    expect(discovered?.description).toContain(TRUNCATION_MARKER);
    const invalid = fixture([tool('sf_crawl_progress', { large: { type: 'string', description: oversized } })]);
    await expect(invalid.native.discoverTools()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('clearly marks bounded native tool errors', async () => {
    const { native } = fixture([tool('sf_crawl_progress')], { isError: true, content: [{ type: 'text', text: oversized }] });
    try { await native.status(); throw new Error('Expected a native tool error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(NativeError);
      expect((error as NativeError).message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE);
      expect((error as NativeError).message).toContain(TRUNCATION_MARKER);
    }
  });
});

describe('SEO Spider 24.3 nullable parameter schemas', () => {
  // Shape verified from licensed 24.3 tool discovery; these tests never access the application.
  const nullableExport = tool('sf_export_seo_element_urls', {
    seo_element_name: { type: 'string' }, filter_name: { type: 'string' },
    file_path: { type: ['string', 'null'] }, segment_name: { type: ['string', 'null'] },
    data_fields: { type: ['array', 'null'], items: { type: 'string' } },
    start_index: { type: ['integer', 'null'] }, max_rows: { type: ['integer', 'null'] },
  }, ['seo_element_name', 'filter_name']);

  it('accepts valid bounded pagination integers in the real nullable export shape', async () => {
    const { native, session } = fixture([nullableExport], { content: [{ type: 'text', text: '{"Address":"https://example.com/"}' }] });
    expect(await native.exportPage('Internal', 'HTML', ['Address'], 100, 2)).toMatchObject({ startIndex: 100, hasMore: false });
    expect(session.callTool).toHaveBeenCalledWith('sf_export_seo_element_urls', {
      seo_element_name: 'Internal', filter_name: 'HTML', data_fields: ['Address'], start_index: 100, max_rows: 2,
    });
  });

  it('accepts nullable optional strings while preserving scalar required URL validation', async () => {
    const { native, session } = fixture([tool('sf_crawl', {
      crawl_url: { type: 'string' }, config_path: { type: ['string', 'null'] }, crawl_name: { type: ['string', 'null'] },
    }, ['crawl_url'])]);
    await native.startCrawl('https://example.com/', 'audit.seospiderconfig', 'fixture-audit');
    expect(session.callTool).toHaveBeenCalledWith('sf_crawl', { crawl_url: 'https://example.com/', config_path: 'audit.seospiderconfig', crawl_name: 'fixture-audit' });
  });

  it('rejects a nullable union that does not accept the supplied integer', async () => {
    const properties = nullableExport.inputSchema.properties as Record<string, unknown>;
    const { native, session } = fixture([tool('sf_export_seo_element_urls', { ...properties, max_rows: { type: ['string', 'null'] } })]);
    await expect(native.exportPage('Internal', 'HTML', ['Address'], 0, 2)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it.each([{ types: [] }, { types: ['integer', 7] }, { types: ['integer', 'unsupported'] }])('rejects malformed or unknown type unions %j', async ({ types }) => {
    const { native, session } = fixture([tool('sf_list_crawls', { limit: { type: types } })]);
    await expect(native.listCrawls(2)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it.each([
    { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    { type: 'integer', anyOf: [{ type: 'string' }] },
    { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    { $ref: '#/$defs/limit' },
    {},
  ])('rejects unsupported schemas rather than skipping parameter validation', async property => {
    const { native, session } = fixture([tool('sf_list_crawls', { limit: property })]);
    await expect(native.listCrawls(2)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it('also refuses unvalidated input-level composition', async () => {
    const { native, session } = fixture([{ ...tool('sf_crawl_progress'), inputSchema: {
      type: 'object', properties: {}, anyOf: [{ required: ['unknown_condition'] }],
    } }]);
    await expect(native.status()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).not.toHaveBeenCalled();
  });
});

describe('licensed SEO Spider 24.3 idle identity and empty crawl history', () => {
  const databaseId = '61c353dd-8067-4865-812d-24e025a88cf8';
  // Verified raw shape from probe-20260929T195602200Z-ec99c261.json. Percentages do not prove readiness.
  const idle = { databaseId, stateName: 'SpiderNoDataIdleState',
    crawlProgress: { active: 0, completed: 0, percentComplete: 0, waiting: 0 },
    apiProgress: { message: '', percentComplete: 100 }, postCrawlAnalysisProgress: { message: '', percentComplete: 100 },
  };

  it('retains verified database identity while idle phase readiness remains unknown', () => {
    expect(normalizeProgress(idle)).toEqual({
      crawlId: databaseId, crawlComplete: null, analysisComplete: null, apisComplete: null, paused: null, totalUrls: null, raw: idle,
    });
    expect(normalizeProgress({ ...idle, crawlProgress: { ...idle.crawlProgress, percentComplete: 100 } }))
      .toMatchObject({ crawlId: databaseId, crawlComplete: null, analysisComplete: null, apisComplete: null });
  });

  it('accepts the database_id alias and preserves contradiction rules', () => {
    expect(normalizeProgress({ database_id: databaseId })).toMatchObject({ crawlId: databaseId });
    expect(normalizeProgress({ databaseId, database_id: 'another-id' }).crawlId).toBeNull();
    expect(normalizeProgress({ databaseId, crawl_id: 'another-id' }).crawlId).toBeNull();
    expect(normalizeProgress({ databaseId, crawl_id: databaseId }).crawlId).toBe(databaseId);
  });

  it.each(['databaseId', 'database_id'])('rejects oversized verified identity alias %s', alias => {
    expect(() => normalizeProgress({ [alias]: 'x'.repeat(MAX_NATIVE_CRAWL_ID + 1) })).toThrow(NativeError);
  });

  it('maps only the exact observed no-crawls tool error to an empty history', async () => {
    const { native, session } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], {
      isError: true, content: [{ type: 'text', text: 'Tool error: IOException: No crawls are available on the SEO Spider' }],
    });
    expect(await native.listCrawls(3)).toEqual([]);
    expect(session.callTool).toHaveBeenCalledWith('sf_list_crawls', { limit: 3 });
    expect(session.close).not.toHaveBeenCalled();
  });

  it('accepts the verified exact instanceDirName saved-crawl identity and local display time', async () => {
    const saved = { instanceDirName: databaseId, url: 'http://127.0.0.1:57043/', spiderMode: 'Spider', crawlName: 'JEStats native verification 20260929T200616978Z-b7b32119', urlsCrawled: 1, percentageComplete: 100.0, time: 'Sep 29, 2026, 1:06:18 PM', projectVersion: '24.3' };
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], { content: [{ type: 'text', text: JSON.stringify([saved]) }] });
    expect(await native.listCrawls()).toEqual([{ id: databaseId, name: saved.crawlName, url: saved.url, startedAt: saved.time, raw: saved }]);
  });

  it.each([
    { instanceDirName: databaseId, crawl_id: 'different-id' },
    { instanceDirName: databaseId, databaseId: 'different-id' },
    { instanceDirName: databaseId, time: 'first-time', startedAt: 'different-time' },
  ])('rejects contradictory saved-crawl identity or time aliases %j', async row => {
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], { structuredContent: [row] });
    await expect(native.listCrawls()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    'No crawls are available on the SEO Spider',
    'Tool error: IOException: No crawls are available on the SEO Spider\n',
    'Tool error: IOException: No crawls are available on the SEO Spider; database inaccessible',
    'Tool error: IOException: Crawl database is locked',
  ])('preserves other tool errors: %s', message => {
    const { native } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })], {
      isError: true, content: [{ type: 'text', text: message }],
    });
    return expect(native.listCrawls()).rejects.toMatchObject({ code: 'TOOL_ERROR', message });
  });

  it('does not treat a transport failure as an empty crawl history', async () => {
    const { native, session } = fixture([tool('sf_list_crawls', { limit: { type: 'integer' } })]);
    vi.mocked(session.callTool).mockRejectedValueOnce(new Error('Tool error: IOException: No crawls are available on the SEO Spider'));
    await expect(native.listCrawls()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('licensed SEO Spider 24.3 discovery response shapes', () => {
  const filterTool = tool('sf_list_available_filters_for_seo_element', { seo_element_name: { type: 'string' } });
  const fieldTool = tool('sf_list_available_data_fields_for_seo_element_and_filter', { seo_element_name: { type: 'string' }, filter_name: { type: 'string' } });
  const reportTool = tool('sf_list_available_reports');
  const bulkListTool = tool('sf_list_available_bulk_exports');
  const bulkGenerateTool = tool('sf_generate_bulk_export', { category: { type: 'string' }, data_fields: { type: ['array', 'null'] }, export_type: { type: ['string', 'null'], enum: ['NDJSON', 'CSV', null] } }, ['category']);
  const textNames = (...names: string[]) => ({ content: names.map(text => ({ type: 'text', text })), isError: false });
  // Exact response excerpts from discovery-20260929T200024490Z-d35a0d48.json.
  const bulkMetadata = [{ categoryName: 'Links:All Inlinks', type: 'SINGLE_FILE' },
    { categoryName: 'Web:All Page Source', type: 'MULTI_FILE' }, { categoryName: 'Issues:All', type: 'MULTI_FILE' }];

  it('retains one exact native name per text block for filters, fields, and reports', async () => {
    const { native, session } = fixture([filterTool, fieldTool, reportTool]);
    vi.mocked(session.callTool).mockResolvedValueOnce(textNames('All', 'HTML', 'JavaScript'))
      .mockResolvedValueOnce(textNames('Address', 'Content Type', 'Status Code', 'Canonical Link Element 1'))
      .mockResolvedValueOnce(textNames('Redirects:Redirect Chains', 'Crawl Overview'));
    expect(await native.availableFilters('Internal')).toEqual(['All', 'HTML', 'JavaScript']);
    expect(await native.availableFields('Internal', 'All')).toEqual(['Address', 'Content Type', 'Status Code', 'Canonical Link Element 1']);
    expect(await native.availableReports()).toEqual(['Redirects:Redirect Chains', 'Crawl Overview']);
  });

  it('supports a single exact name, empty lists, and prior JSON list/envelope forms', async () => {
    const { native, session } = fixture([filterTool]);
    vi.mocked(session.callTool).mockResolvedValueOnce(textNames('HTML'))
      .mockResolvedValueOnce(textNames())
      .mockResolvedValueOnce(textNames('["All","HTML"]'))
      .mockResolvedValueOnce(textNames('{"filters":["All","HTML"]}'))
      .mockResolvedValueOnce({ structuredContent: { filters: [{ name: 'All' }, { categoryName: 'HTML' }] } });
    expect(await native.availableFilters('Internal')).toEqual(['HTML']);
    expect(await native.availableFilters('Internal')).toEqual([]);
    expect(await native.availableFilters('Internal')).toEqual(['All', 'HTML']);
    expect(await native.availableFilters('Internal')).toEqual(['All', 'HTML']);
    expect(await native.availableFilters('Internal')).toEqual(['All', 'HTML']);
  });

  it.each(['["All"', '{"filters":', '"unterminated', '[null]', '{"unexpected":"All"}'])('rejects malformed single JSON discovery instead of treating it as a name: %s', text => {
    const { native } = fixture([filterTool], textNames(text));
    return expect(native.availableFilters('Internal')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('bounds plain text-block and structured discovery counts and exact name lengths', async () => {
    const { native, session } = fixture([filterTool]);
    vi.mocked(session.callTool).mockResolvedValueOnce(textNames(...Array.from({ length: MAX_NATIVE_DISCOVERY_NAMES + 1 }, (_, index) => `field-${index}`)))
      .mockResolvedValueOnce({ structuredContent: { filters: Array.from({ length: MAX_NATIVE_DISCOVERY_NAMES + 1 }, (_, index) => `field-${index}`) } })
      .mockResolvedValueOnce(textNames('x'.repeat(MAX_NATIVE_DISCOVERY_NAME + 1)));
    await expect(native.availableFilters('Internal')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(native.availableFilters('Internal')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(native.availableFilters('Internal')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('parses categoryName metadata and exposes only SINGLE_FILE bulk categories', async () => {
    const { native } = fixture([bulkListTool], textNames(JSON.stringify(bulkMetadata)));
    expect(await native.availableBulkExports()).toEqual(['Links:All Inlinks']);
  });

  it('refuses MULTI_FILE generation even when the caller names an advertised category', async () => {
    const { native, session } = fixture([bulkListTool, bulkGenerateTool], textNames(JSON.stringify(bulkMetadata)));
    await expect(native.bulkExport('Web:All Page Source')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(session.callTool).toHaveBeenCalledTimes(1);
    expect(session.callTool).toHaveBeenCalledWith('sf_list_available_bulk_exports', {});
  });

  it('generates a discovered SINGLE_FILE bulk export in NDJSON without native file_path', async () => {
    const { native, session } = fixture([bulkListTool, bulkGenerateTool]);
    vi.mocked(session.callTool).mockResolvedValueOnce(textNames(JSON.stringify(bulkMetadata)))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"Source":"https://example.com/","Destination":"https://example.com/broken"}' }] });
    expect(await native.bulkExport('Links:All Inlinks', ['Source', 'Destination'])).toEqual([{ Source: 'https://example.com/', Destination: 'https://example.com/broken' }]);
    expect(session.callTool).toHaveBeenNthCalledWith(2, 'sf_generate_bulk_export', { category: 'Links:All Inlinks', data_fields: ['Source', 'Destination'], export_type: 'NDJSON' });
  });

  it.each([
    ['Links:All Inlinks'],
    [{ categoryName: 'Links:All Inlinks' }],
    [{ categoryName: 'Links:All Inlinks', type: 'UNKNOWN' }],
    [{ categoryName: 'Links:All Inlinks', type: 'SINGLE_FILE' }, { categoryName: 'Links:All Inlinks', type: 'MULTI_FILE' }],
  ])('rejects bulk category discovery lacking unambiguous file behavior', async (...entries) => {
    const { native, session } = fixture([bulkListTool, bulkGenerateTool], textNames(JSON.stringify(entries)));
    await expect(native.bulkExport('Links:All Inlinks')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(session.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('controlled native verification harness ownership and busy polling', () => {
  const progress = (state: string, crawlId: string | null = null, ready = false): NativeProgress => ({ crawlId, crawlComplete: ready ? true : null, analysisComplete: ready ? true : null, apisComplete: ready ? true : null, paused: null, totalUrls: null, raw: { stateName: state } });
  const owned: NativeCrawl = { id: 'owned-id', name: 'JEStats native verification prior-run', url: 'http://127.0.0.1:57043/', startedAt: null, raw: {} };
  function harness() {
    let time = 0;
    let closed = false;
    const evidence: Evidence = { runId: 'unit-test', recordedAt: '', platform: 'fixture', architecture: 'fixture', nodeVersion: '', readOnly: false, integrationVerified: false, endpoint: 'fixture', note: 'No native calls.', checks: {}, observations: [] };
    const status = vi.fn<NativeClient['status']>().mockResolvedValue(progress('SpiderNoDataIdleState'));
    const start = vi.fn<NativeClient['startCrawl']>().mockResolvedValue('Started');
    const list = vi.fn<NativeClient['listCrawls']>().mockResolvedValue([]);
    const native = { status, startCrawl: start, listCrawls: list } as unknown as NativeClient;
    const startSite = vi.fn(async () => ({ origin: 'http://127.0.0.1:12345', expectedRoutes: [], requests: [], close: async () => { closed = true; } }));
    const persist = vi.fn(async () => undefined);
    const wait = vi.fn(async (milliseconds: number) => { expect(closed).toBe(false); time += milliseconds; });
    return { native, status, start, list, evidence, persist, startSite, wait, clock: () => time, isClosed: () => closed };
  }

  it('persists exact busy observations, keeps the HTTP fixture alive, and never retries the launch', async () => {
    const h = harness();
    h.status.mockResolvedValueOnce(progress('SpiderNoDataIdleState'))
      .mockRejectedValueOnce(new NativeError('TOOL_ERROR', NATIVE_BUSY_MESSAGE))
      .mockResolvedValueOnce(progress('SpiderCrawlIdleState', null, true));
    await runControlledGate(h.native, h.evidence, h.persist, h.startSite, { now: h.clock, wait: h.wait });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.evidence.observations.filter(observation => !observation.result.ok)).toHaveLength(1);
    expect(h.evidence.checks.readiness?.verdict).toBe('passed');
    expect(h.wait).toHaveBeenCalledTimes(1);
    expect(h.isClosed()).toBe(true);
  });

  it('keeps the fixture alive for the whole deadline when exact busy transitions persist', async () => {
    const h = harness();
    h.status.mockResolvedValueOnce(progress('SpiderNoDataIdleState')).mockRejectedValue(new NativeError('TOOL_ERROR', NATIVE_BUSY_MESSAGE));
    await runControlledGate(h.native, h.evidence, h.persist, h.startSite, { now: h.clock, wait: h.wait });
    expect(h.clock()).toBe(30_000);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.evidence.checks.readiness?.verdict).toBe('unassessed');
    expect(h.evidence.checks.identity?.verdict).toBe('failed');
    expect(h.isClosed()).toBe(true);
  });

  it.each([
    ['TOOL_ERROR', `${NATIVE_BUSY_MESSAGE}\n`],
    ['TOOL_ERROR', 'Tool error: IllegalStateException: Different app state'],
    ['UNAVAILABLE', NATIVE_BUSY_MESSAGE],
  ] as const)('does not suppress other failures %s %s', async (code, message) => {
    const h = harness();
    h.status.mockResolvedValueOnce(progress('SpiderNoDataIdleState')).mockRejectedValueOnce(new NativeError(code, message));
    await expect(runControlledGate(h.native, h.evidence, h.persist, h.startSite, { now: h.clock, wait: h.wait })).rejects.toThrow(message);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.isClosed()).toBe(true);
  });

  it('allows explicit replacement of only the exactly matched idle saved localhost test', async () => {
    const h = harness();
    h.status.mockResolvedValue(progress('SpiderCrawlIdleState', owned.id));
    h.list.mockResolvedValue([owned]);
    h.start.mockImplementation(async () => {
      expect(h.evidence.replacementIntent).toMatchObject({ crawlId: owned.id, crawlName: owned.name, crawlUrl: owned.url });
      expect(h.evidence.launchIntent).toBeTruthy();
      throw new NativeError('UNAVAILABLE', 'Simulated ambiguous start');
    });
    await runControlledGate(h.native, h.evidence, h.persist, h.startSite, { replaceOwnedTest: true, now: h.clock, wait: h.wait });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.startSite).toHaveBeenCalledTimes(1);
    expect(h.evidence.checks.newCrawl?.verdict).toBe('unassessed');
    expect(h.isClosed()).toBe(true);
  });

  it.each([
    { flag: false, state: 'SpiderCrawlIdleState', rows: [owned] },
    { flag: true, state: 'SpiderCrawlingState', rows: [owned] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [{ ...owned, id: 'unrelated-id' }] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [{ ...owned, name: 'Client audit' }] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [{ ...owned, url: 'https://example.com/' }] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [{ ...owned, url: 'http://localhost:57043/' }] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [{ ...owned, url: 'http://user:secret@127.0.0.1:57043/' }] },
    { flag: true, state: 'SpiderCrawlIdleState', rows: [owned, owned] },
  ])('rejects non-owned, active, ambiguous, or unauthorized replacement %j', async ({ flag, state, rows }) => {
    const h = harness();
    h.status.mockResolvedValue(progress(state, owned.id)); h.list.mockResolvedValue(rows);
    await expect(runControlledGate(h.native, h.evidence, h.persist, h.startSite, { replaceOwnedTest: flag, now: h.clock, wait: h.wait })).rejects.toThrow(/Unrelated or active crawl data/);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.startSite).not.toHaveBeenCalled();
  });
});
