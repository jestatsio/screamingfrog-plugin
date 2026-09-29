import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { AuditStore } from '../src/storage.js';
import { acquireLock } from '../src/lock.js';
import { MAX_DATASET_BYTES, type LinkRow, type PageRow } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'jestats-test-')); roots.push(root); return new AuditStore(root); }
function row(id: number): PageRow {
  return { id, url: `https://example.com/日本語/${id}`, section: '/日本語/', statusCode: 200, contentType: 'text/html', indexability: 'indexable', indexabilityReason: null, canonical: null, canonicalCount: null, title: '', titleCount: 0, description: null, descriptionCount: null, h1: null, h1Count: null, uniqueInlinks: null, searchClicks: null, inSitemap: null, redirectTarget: null };
}
describe('immutable indexed snapshots', () => {
  test('indexes UTF-8 byte offsets and reads arbitrary bounded evidence pages', async () => {
    const store = await setup(); const id = randomUUID(); const writer = await store.beginSnapshot(id);
    for (let i = 0; i < 3; i++) await writer.append(row(i));
    const snapshot = await writer.commit();
    expect(snapshot.rows).toBe(3);
    expect(await store.pageRows(id, [2, 0])).toEqual([row(2), row(0)]);
    const pages: PageRow[] = []; for await (const page of store.pages(id)) pages.push(page);
    expect(pages).toEqual([row(0), row(1), row(2)]);
    await expect(store.beginSnapshot(id)).rejects.toThrow('immutable');
  });
  test('never exposes an unfinished snapshot and abort cleans staging data', async () => {
    const store = await setup(); const id = randomUUID(); const writer = await store.beginSnapshot(id);
    await writer.append(row(0)); expect(await store.hasSnapshot(id)).toBe(false);
    await expect(store.pageRows(id, [0])).rejects.toThrow();
    await writer.abort(); expect(await store.hasSnapshot(id)).toBe(false);
  });
  test('excludes concurrent snapshot writers and preserves the first publication', async () => {
    const store = await setup(); const id = randomUUID(); const first = await store.beginSnapshot(id);
    await expect(store.beginSnapshot(id)).rejects.toThrow('Another plugin');
    await first.append(row(0)); await first.commit();
    await expect(store.beginSnapshot(id)).rejects.toThrow('immutable');
    expect(await store.pageRows(id, [0])).toEqual([row(0)]);
  });
  test('rejects traversal and unbounded evidence reads', async () => {
    const store = await setup(); expect(() => store.directory('../../outside')).toThrow('Invalid audit');
    await expect(store.pageRows(randomUUID(), Array(201).fill(0))).rejects.toThrow('200');
  });
  test('locks exclude concurrent clients and release permits acquisition', async () => {
    const store = await setup(); const release = await acquireLock(store.root, 'native:endpoint');
    await expect(acquireLock(store.root, 'native:endpoint')).rejects.toThrow('Another plugin');
    await release(); await (await acquireLock(store.root, 'native:endpoint'))();
  });
  test('recovers an empty crash remnant and dead owner without stealing a replacement', async () => {
    const store = await setup(); const key = 'crash';
    const path = join(store.root, 'locks', `${createHash('sha256').update(key).digest('hex')}.lock`);
    await mkdir(path, { recursive: true });
    await (await acquireLock(store.root, key))();
    await mkdir(path, { recursive: true });
    const token = randomUUID();
    await writeFile(join(path, `owner-${token}.json`), JSON.stringify({ token, host: hostname(), pid: 2147483647 }));
    const attempts = await Promise.allSettled([acquireLock(store.root, key), acquireLock(store.root, key)]);
    const winners = attempts.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled');
    expect(winners).toHaveLength(1); await winners[0]!.value();
  });
  test('an old release callback cannot remove a new owner', async () => {
    const store = await setup(); const firstRelease = await acquireLock(store.root, 'again');
    await firstRelease(); const nextRelease = await acquireLock(store.root, 'again');
    await firstRelease(); await expect(acquireLock(store.root, 'again')).rejects.toThrow('Another plugin');
    await nextRelease();
  });
});

describe('bounded persisted link evidence', () => {
  test('preserves complete UTF-8 evidence and treats an absent export as unavailable', async () => {
    const store = await setup(); const id = randomUUID();
    expect(await store.readLinks(id)).toEqual([]);
    const links = [{ source: 'https://example.test/日本語/?q="quoted"', target: 'https://example.test/destination' }];
    await store.saveLinks(id, links);
    expect(await store.readLinks(id)).toEqual(links);
    expect(await readFile(join(store.directory(id), 'links.json'), 'utf8')).toBe(JSON.stringify(links));
  });
  test('rejects aggregate UTF-8 overflow before serializing later links or publishing a sampled export', async () => {
    const store = await setup(); const id = randomUUID();
    const link: LinkRow = { source: `https://example.test/${'日'.repeat(16_000)}`, target: `https://example.test/${'語'.repeat(16_000)}` };
    const linkBytes = Buffer.byteLength(JSON.stringify(link), 'utf8');
    const overflowingCount = Math.floor((MAX_DATASET_BYTES - 2) / (linkBytes + 1)) + 1;
    const later: LinkRow = { source: '', target: 'https://example.test/later' };
    const readLater = vi.fn(() => { throw new Error('Evidence after the overflow must not be serialized.'); });
    Object.defineProperty(later, 'source', { enumerable: true, get: readLater });
    await expect(store.saveLinks(id, [...Array<LinkRow>(overflowingCount).fill(link), later])).rejects.toThrow('128 MiB');
    expect(readLater).not.toHaveBeenCalled();
    await expect(readFile(join(store.directory(id), 'links.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('rejects an oversized persisted file before reading or parsing its contents', async () => {
    const store = await setup(); const id = randomUUID();
    const handle = await open(join(await store.ensure(id), 'links.json'), 'wx', 0o600);
    try { await handle.truncate(MAX_DATASET_BYTES + 1); } finally { await handle.close(); }
    await expect(store.readLinks(id)).rejects.toThrow('Persisted link evidence exceeds the 128 MiB data budget.');
  });
});
