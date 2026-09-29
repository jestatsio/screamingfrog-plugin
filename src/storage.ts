import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AuditResult, Job, LinkRow, PageRow } from './types.js';
import { MAX_DATASET_BYTES } from './types.js';

export function validateId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid audit ID.');
  return id;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) { await rm(temp, { force: true }); throw error; }
}

export interface SnapshotIndex { schemaVersion: 1; rows: number; offsets: number[]; bytes: number; sha256: string }

export class AuditStore {
  constructor(readonly root: string) {}
  directory(id: string): string { return join(this.root, 'audits', validateId(id)); }
  async ensure(id: string): Promise<string> {
    const path = this.directory(id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  async saveJob(job: Job): Promise<void> { await atomicJson(join(await this.ensure(job.id), 'job.json'), job); }
  async readJob(id: string): Promise<Job> {
    return JSON.parse(await readFile(join(this.directory(id), 'job.json'), 'utf8')) as Job;
  }
  async listJobs(limit = 20): Promise<Job[]> {
    const base = join(this.root, 'audits');
    let names: string[];
    try { names = await readdir(base); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const jobs: Job[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      try { jobs.push(await this.readJob(name)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async saveResult(result: AuditResult): Promise<void> {
    await atomicJson(join(await this.ensure(result.id), 'result.json'), result);
  }
  async readResult(id: string): Promise<AuditResult> {
    return JSON.parse(await readFile(join(this.directory(id), 'result.json'), 'utf8')) as AuditResult;
  }
  async hasSnapshot(id: string): Promise<boolean> {
    try { await stat(join(this.directory(id), 'snapshot.json')); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async snapshotIndex(id: string): Promise<SnapshotIndex> {
    return JSON.parse(await readFile(join(this.directory(id), 'snapshot.json'), 'utf8')) as SnapshotIndex;
  }
  async *pages(id: string): AsyncGenerator<PageRow> {
    await this.snapshotIndex(id); // A partial staging dataset is never readable as an audit.
    const input = createReadStream(join(this.directory(id), 'pages.ndjson'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) if (line) yield JSON.parse(line) as PageRow; }
    finally { lines.close(); input.destroy(); }
  }
  async pageRows(id: string, ids: readonly number[]): Promise<PageRow[]> {
    if (ids.length > 200) throw new Error('Evidence pages are limited to 200 URLs per request.');
    const index = await this.snapshotIndex(id);
    const handle = await open(join(this.directory(id), 'pages.ndjson'), 'r');
    const rows: PageRow[] = [];
    try {
      for (const rowId of ids) {
        if (!Number.isInteger(rowId) || rowId < 0 || rowId >= index.rows) throw new Error('Invalid evidence row.');
        const offset = index.offsets[rowId]!;
        const end = index.offsets[rowId + 1] ?? index.bytes;
        const bytes = Buffer.alloc(end - offset);
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(bytes, read, bytes.length - read, offset + read);
          if (result.bytesRead === 0) throw new Error('Snapshot data is truncated.');
          read += result.bytesRead;
        }
        rows.push(JSON.parse(bytes.toString('utf8')) as PageRow);
      }
    } finally { await handle.close(); }
    return rows;
  }
  async saveLinks(id: string, links: LinkRow[]): Promise<void> {
    let bytes = 2;
    for (const link of links) {
      bytes += Buffer.byteLength(JSON.stringify(link)) + 1;
      if (bytes > MAX_DATASET_BYTES) throw new Error('Link evidence exceeds the 128 MiB data budget; no links were sampled.');
    }
    await atomicJson(join(await this.ensure(id), 'links.json'), links);
  }
  async readLinks(id: string): Promise<LinkRow[]> {
    try {
      const path = join(this.directory(id), 'links.json');
      if ((await stat(path)).size > MAX_DATASET_BYTES) throw new Error('Persisted link evidence exceeds the 128 MiB data budget.');
      return JSON.parse(await readFile(path, 'utf8')) as LinkRow[];
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async beginSnapshot(id: string): Promise<SnapshotWriter> {
    const { acquireLock } = await import('./lock.js');
    const release = await acquireLock(this.root, `snapshot:${validateId(id)}`);
    try {
      if (await this.hasSnapshot(id)) throw new Error('Completed snapshots are immutable.');
      return await SnapshotWriter.create(await this.ensure(id), release);
    } catch (error) { await release(); throw error; }
  }
}

export class SnapshotWriter {
  private offsets: number[] = [];
  private bytes = 0;
  private hash = createHash('sha256');
  private closed = false;
  private constructor(private directory: string, private handle: Awaited<ReturnType<typeof open>>, private staging: string, private release: () => Promise<void>) {}
  static async create(directory: string, release: () => Promise<void>): Promise<SnapshotWriter> {
    const staging = join(directory, `pages.${randomUUID()}.partial`);
    return new SnapshotWriter(directory, await open(staging, 'wx', 0o600), staging, release);
  }
  async append(row: PageRow): Promise<void> {
    if (this.closed) throw new Error('Snapshot writer is closed.');
    if (row.id !== this.offsets.length) throw new Error('Snapshot row IDs must be sequential.');
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    if (this.bytes + bytes.length > MAX_DATASET_BYTES) throw new Error('Snapshot exceeds the 128 MiB data budget. No rows were sampled.');
    await this.handle.writeFile(bytes);
    this.offsets.push(this.bytes);
    this.bytes += bytes.length;
    this.hash.update(bytes);
  }
  async commit(): Promise<SnapshotIndex> {
    if (this.closed) throw new Error('Snapshot writer is closed.');
    this.closed = true;
    let published = false;
    try {
      try { await this.handle.sync(); } finally { await this.handle.close(); }
      const index: SnapshotIndex = { schemaVersion: 1, rows: this.offsets.length, offsets: this.offsets, bytes: this.bytes, sha256: this.hash.digest('hex') };
      await rename(this.staging, join(this.directory, 'pages.ndjson'));
      await atomicJson(join(this.directory, 'snapshot.json'), index);
      published = true;
      return index;
    } finally {
      try { if (!published) await rm(this.staging, { force: true }); }
      finally { await this.release(); }
    }
  }
  async abort(): Promise<void> {
    try {
      if (!this.closed) { this.closed = true; await this.handle.close(); }
      await rm(this.staging, { force: true });
    } finally { await this.release(); }
  }
}
