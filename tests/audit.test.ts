import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditManager } from '../src/audit.js';
import { AuditStore } from '../src/storage.js';
import { NativeError } from '../src/native.js';
import type { NativeClient, NativeProgress } from '../src/native-contract.js';
import type { Job } from '../src/types.js';
import { MAX_DATASET_BYTES } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const page = (path: string, extra = {}) => ({ Address: `https://example.test${path}`, 'Status Code': 200,
  'Content Type': 'text/html', Indexability: 'Indexable', 'Title 1': 'Duplicate title', 'Meta Description 1': 'Description', 'H1-1': 'Heading', ...extra });

async function fixture(rows = [page('/'), page('/section/a'), page('/section/b')]) {
  const root = await mkdtemp(join(tmpdir(), 'jestats-audit-test-')); roots.push(root);
  const store = new AuditStore(join(root, 'store'));
  let id = 'saved-id'; let complete = true; let noData = false; let name = 'Saved'; let launched = false;
  const progress = (): NativeProgress => ({ crawlId: id, crawlComplete: complete, analysisComplete: null, apisComplete: null, paused: false, totalUrls: rows.length,
    raw: { databaseId: id, crawlComplete: complete, stateName: noData ? 'SpiderNoDataIdleState' : 'SpiderCrawlIdleState' } });
  const native = {
    endpoint: 'http://127.0.0.1:11435/mcp', connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    discoverTools: vi.fn(async () => []),
    status: vi.fn(async () => progress()), listCrawls: vi.fn(async () => [{ id, name, url: 'https://example.test/', startedAt: null, raw: {} }]),
    loadCrawl: vi.fn(async (selected: string) => { id = selected; }),
    startCrawl: vi.fn(async (_url: string, _config?: string, crawlName?: string) => { launched = true; name = crawlName!; noData = false; id = 'new-id'; }),
    control: vi.fn(async () => undefined), availableFilters: vi.fn(async (element: string) => element === 'Internal' ? ['All'] : []),
    availableFields: vi.fn(async () => Object.keys(rows[0]!)), availableReports: vi.fn(async () => []), availableBulkExports: vi.fn(async (): Promise<string[]> => []),
    exportPage: vi.fn(async (_element: string, _filter: string, _fields: string[], start: number, max: number) => ({ rows: rows.slice(start, start + max), startIndex: start, hasMore: rows.slice(start, start + max).length === max, raw: {} })),
    report: vi.fn(async () => []), bulkExport: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  } satisfies NativeClient;
  const manager = new AuditManager(native, store, join(root, 'application'));
  return { root, store, manager, native, rows, setId: (value: string) => { id = value; }, setComplete: (value: boolean) => { complete = value; }, setBlank: () => { noData = true; complete = false; }, launched: () => launched };
}
async function finish(manager: AuditManager, job: Job): Promise<Job> {
  for (let count = 0; count < 40 && !['ready', 'needs_user_action', 'failed', 'cancelled'].includes(job.stage); count++) job = await manager.advance(job.id);
  return job;
}

describe('durable audit workflow', () => {
  test('saved data reconciles immutable rows and computed findings, with visible unknown coverage', async () => {
    const f = await fixture(); const job = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(job.stage).toBe('ready'); expect(job.extractedRows).toBe(3);
    const result = await f.store.readResult(job.id); const index = await f.store.snapshotIndex(job.id);
    expect(result.pageCount).toBe(index.rows); expect(result.provenance.snapshotHash).toBe(index.sha256);
    expect(result.findings.some(item => item.rule === 'metadata_duplicate_title')).toBe(true);
    expect(result.coverage.some(item => item.state !== 'assessed')).toBe(true);
    expect(f.native.loadCrawl).not.toHaveBeenCalled();
    await expect(f.store.beginSnapshot(job.id)).rejects.toThrow('immutable');
  });
  test('uses the captured bundled preset by default and rejects unmatchable URLs before launch', async () => {
    const f = await fixture();
    const job = await f.manager.start({ url: 'https://example.test/' });
    expect(job.preset).toBe('technical-audit-v1:provisional-24.3-export');
    expect(f.native.startCrawl).toHaveBeenCalledTimes(1);
    expect(f.native.startCrawl.mock.calls[0]?.[1]).toContain('technical-audit-v1.seospiderconfig');
    await expect(f.manager.start({ url: `https://example.test/${'a'.repeat(2050)}`, useCurrentConfig: true })).rejects.toThrow('exact identity limit');
  });
  test('equivalent rows in a different native order produce the same immutable snapshot and findings', async () => {
    const f = await fixture();
    const first = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    f.rows.reverse();
    const second = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(first.stage).toBe('ready'); expect(second.stage).toBe('ready');
    expect((await f.store.snapshotIndex(first.id)).sha256).toBe((await f.store.snapshotIndex(second.id)).sha256);
    expect((await f.store.readResult(first.id)).findings).toEqual((await f.store.readResult(second.id)).findings);
  });
  test('broken hyperlink fixes exclude canonical and redirect relationships', async () => {
    const f = await fixture([page('/'), page('/linked'), page('/broken', { 'Status Code': 404 })]);
    f.native.availableBulkExports.mockResolvedValue(['Links:All Inlinks']);
    f.native.bulkExport.mockResolvedValue([
      { Source: 'https://example.test/', Destination: 'https://example.test/broken', Type: 'HTML Canonical' },
      { Source: 'https://example.test/', Destination: 'https://example.test/broken', Type: 'HTTP Redirect' },
      { Source: 'https://example.test/linked', Destination: 'https://example.test/broken', Type: 'Hyperlink' },
    ]);
    const job = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(job.stage).toBe('ready'); expect(job.linksAvailable).toBe(true);
    expect(await f.store.readLinks(job.id)).toEqual([{ source: 'https://example.test/linked', target: 'https://example.test/broken' }]);
    const finding = (await f.store.readResult(job.id)).findings.find(item => item.rule === 'broken_internal_destination');
    expect(finding?.affectedCount).toBe(1);
    expect((await f.store.pageRows(job.id, finding!.affectedIds)).map(row => row.url)).toEqual(['https://example.test/linked']);
  });
  test('missing link types leave a visible evidence gap instead of inferring hyperlinks', async () => {
    const f = await fixture();
    f.native.availableBulkExports.mockResolvedValue(['Links:All Inlinks']);
    f.native.bulkExport.mockResolvedValue([{ Source: 'https://example.test/', Destination: 'https://example.test/section/a' }]);
    const job = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(job.stage).toBe('ready'); expect(job.linksAvailable).toBe(false);
    expect(job.coverageWarnings?.join(' ')).toContain('link Type evidence');
    expect(await f.store.readLinks(job.id)).toEqual([]);
  });
  test('persists the launch before sending it and reconciles an ambiguous response without another start', async () => {
    const f = await fixture();
    f.native.startCrawl.mockImplementationOnce(async (_url, _config, name) => {
      const jobs = await f.store.listJobs();
      expect(jobs[0]?.launchAttemptedAt).toBeTruthy(); expect(jobs[0]?.crawlName).toBe(name);
      f.setId('new-id');
      f.native.listCrawls.mockResolvedValue([{ id: 'new-id', name: name!, url: 'https://example.test/', startedAt: null, raw: {} }]);
      throw new NativeError('UNAVAILABLE', 'Ambiguous start');
    });
    const started = await f.manager.start({ url: 'https://example.test/', useCurrentConfig: true });
    const reconnected = new AuditManager(f.native, f.store, f.manager.applicationRoot);
    const job = await finish(reconnected, started);
    expect(job.stage).toBe('ready'); expect(f.native.startCrawl).toHaveBeenCalledTimes(1);
  });
  test('an unresolved launch is never repeated across sessions', async () => {
    const f = await fixture(); f.native.startCrawl.mockRejectedValue(new NativeError('UNAVAILABLE', 'Ambiguous'));
    const job = await f.manager.start({ url: 'https://example.test/', useCurrentConfig: true });
    for (let count = 0; count < 3; count++) expect((await f.manager.advance(job.id)).stage).toBe('starting');
    expect(f.native.startCrawl).toHaveBeenCalledTimes(1);
    await expect(f.manager.start({ crawlId: 'saved-id' })).rejects.toThrow('Another plugin process');
    await f.manager.control(job.id, 'cancel');
  });
  test('rejects identity changes before publishing a mixed snapshot', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    f.native.exportPage.mockImplementationOnce(async (...args) => { f.setId('other-id'); return { rows: f.rows, startIndex: args[3], hasMore: false, raw: {} }; });
    const stopped = await f.manager.advance(job.id);
    expect(stopped.stage).toBe('needs_user_action'); expect(stopped.message).toContain('identity changed');
    expect(await f.store.hasSnapshot(job.id)).toBe(false);
  });
  test('reconnect continues from durable extraction checkpoints', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    f.native.exportPage.mockRejectedValueOnce(new NativeError('UNAVAILABLE', 'Disconnected'));
    const disconnected = await f.manager.advance(job.id); expect(disconnected.checkpoint).toBeTruthy();
    const reopened = new AuditManager(f.native, f.store, f.manager.applicationRoot);
    expect((await finish(reopened, disconnected)).stage).toBe('ready');
    expect(f.native.loadCrawl).not.toHaveBeenCalled();
  });
  test('second-pass verification rejects changed rows even when identity and counts match', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    let exports = 0;
    f.native.exportPage.mockImplementation(async (_element, _filter, _fields, start, max) => {
      exports++; const rows = f.rows.slice(start, start + max).map(row => exports > 1 ? { ...row, 'Title 1': 'Changed' } : row);
      return { rows, startIndex: start, hasMore: rows.length === max, raw: {} };
    });
    const stopped = await finish(f.manager, job);
    expect(stopped.stage).toBe('needs_user_action'); expect(stopped.message).toContain('changed during verification');
    expect(await f.store.hasSnapshot(job.id)).toBe(false);
  });
  test('verification rejects an optional filter that grows beyond its unchanged terminal prefix', async () => {
    const f = await fixture(); let missingReads = 0;
    f.native.availableFilters.mockImplementation(async element => element === 'Internal' ? ['All'] : element === 'Page Titles' ? ['Missing'] : []);
    f.native.exportPage.mockImplementation(async (element, _filter, _fields, start, max) => {
      const source = element === 'Page Titles' ? (++missingReads === 1 ? [f.rows[1]!] : [f.rows[1]!, f.rows[2]!]) : f.rows;
      const rows = source.slice(start, start + max);
      return { rows, startIndex: start, hasMore: rows.length === max, raw: {} };
    });
    const job = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(job.stage).toBe('needs_user_action');
    expect(job.message).toContain('terminal boundary changed');
    expect(await f.store.hasSnapshot(job.id)).toBe(false);
  });
  test('rejects a crawl over 100,000 URLs without exporting or sampling', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    const original = await f.native.status(); f.native.status.mockResolvedValue({ ...original, totalUrls: 100_001 });
    const stopped = await f.manager.advance(job.id);
    expect(stopped.stage).toBe('needs_user_action'); expect(stopped.message).toContain('100,000');
    expect(f.native.exportPage).not.toHaveBeenCalled();
  });
  test('pause and resume saved extraction never control the unrelated native crawl', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    expect((await f.manager.control(job.id, 'pause')).stage).toBe('paused');
    expect((await f.manager.advance(job.id)).stage).toBe('paused');
    expect((await f.manager.control(job.id, 'resume')).stage).toBe('starting');
    expect(f.native.control).not.toHaveBeenCalled();
    expect((await finish(f.manager, job)).stage).toBe('ready');
  });
  test.each(['status', 'pause'] as const)('cancels locally and releases ownership when native %s is unavailable', async failure => {
    const f = await fixture();
    const job = await f.manager.start({ url: 'https://example.test/', useCurrentConfig: true });
    job.nativeCrawlId = 'new-id'; job.stage = 'crawling';
    await f.store.saveJob(job); f.setComplete(false);
    if (failure === 'status') f.native.status.mockRejectedValueOnce(new NativeError('UNAVAILABLE', 'Disconnected'));
    else f.native.control.mockImplementationOnce(async () => {
      expect((await f.store.readJob(job.id)).stage).toBe('cancelled');
      throw new NativeError('UNAVAILABLE', 'Pause response interrupted');
    });
    const cancelled = await f.manager.control(job.id, 'cancel');
    expect(cancelled.stage).toBe('cancelled'); expect(cancelled.message).toContain('may still be running');
    expect((await f.store.readJob(job.id)).stage).toBe('cancelled');
    expect(cancelled.coverageWarnings?.join(' ')).toContain('could not be confirmed');
    // Native activity still prevents unsafe replacement, but the old local owner does not block a completed source.
    f.setComplete(true);
    expect((await f.manager.start({ crawlId: 'new-id' })).stage).toBe('starting');
    expect(f.native.startCrawl).toHaveBeenCalledTimes(1);
  });
  test('application ownership spans different snapshot directories and localhost aliases', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    const second = new AuditManager({ ...f.native, endpoint: 'http://localhost:11435/mcp' }, new AuditStore(join(f.root, 'second-store')), f.manager.applicationRoot);
    await expect(second.start({ crawlId: 'saved-id' })).rejects.toThrow('Another plugin process');
    await f.manager.control(job.id, 'cancel');
    expect((await second.start({ crawlId: 'saved-id' })).stage).toBe('starting');
  });
  test('unresolved launch controls stay local and never resume an unrelated native crawl', async () => {
    const f = await fixture();
    const job = await f.manager.start({ url: 'https://example.test/', useCurrentConfig: true });
    expect(job.nativeCrawlId).toBeNull();
    const paused = await f.manager.control(job.id, 'pause');
    expect(paused.message).toContain('No native pause');
    f.setId('unrelated');
    await f.manager.control(job.id, 'resume');
    expect(f.native.control).not.toHaveBeenCalled();
  });
  test('recovers a queued job that crashed before its first launch intent', async () => {
    const f = await fixture(); const job = await f.manager.start({ url: 'https://example.test/', useCurrentConfig: true });
    job.stage = 'queued'; job.nativeCrawlId = null; delete job.launchAttemptedAt;
    await f.store.saveJob(job); f.native.startCrawl.mockClear();
    expect((await finish(f.manager, job)).stage).toBe('ready');
    expect(f.native.startCrawl).toHaveBeenCalledTimes(1);
    expect((await f.store.readJob(job.id)).launchAttemptedAt).toBeTruthy();
  });
  test('unavailable optional export produces a gap while the core audit completes', async () => {
    const f = await fixture(); f.native.availableFilters.mockImplementation(async element => element === 'Internal' ? ['All'] : element === 'Page Titles' ? ['Missing'] : []);
    const originalExport = f.native.exportPage.getMockImplementation()!;
    f.native.exportPage.mockImplementation(async (...args) => {
      if (args[0] === 'Page Titles') throw new NativeError('TOOL_ERROR', 'Analysis unavailable');
      return originalExport(...args);
    });
    const job = await finish(f.manager, await f.manager.start({ crawlId: 'saved-id' }));
    expect(job.stage).toBe('ready');
    expect(job.coverageWarnings?.some(value => value.includes('Page Titles/Missing could not be extracted'))).toBe(true);
    expect((await f.store.readResult(job.id)).coverage.some(value => value.reason.includes('Analysis unavailable'))).toBe(true);
  });
  test('data budget rejects oversized checkpoint growth without publishing sampled rows', async () => {
    const f = await fixture(); const job = await f.manager.start({ crawlId: 'saved-id' });
    f.native.exportPage.mockRejectedValueOnce(new NativeError('UNAVAILABLE', 'Disconnected'));
    const checkpointed = await f.manager.advance(job.id);
    checkpointed.checkpoint!.datasetBytes = MAX_DATASET_BYTES;
    await f.store.saveJob(checkpointed);
    const stopped = await f.manager.advance(job.id);
    expect(stopped.stage).toBe('needs_user_action'); expect(stopped.message).toContain('128 MiB');
    expect(await f.store.hasSnapshot(job.id)).toBe(false);
  });
});
