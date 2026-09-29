import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeClient, NativeProgress } from './native-contract.js';
import { NativeError, boundDisplayText, requireBoundedCrawlId, MAX_DISPLAY_CRAWL_URL } from './native.js';
import { acquireLock, BusyError } from './lock.js';
import { AuditStore, atomicJson, validateId } from './storage.js';
import { AUDIT_FIELDS, nativePhase, normalizePage, rowAddress } from './extraction.js';
import type { Enrichment } from './extraction.js';
import { analyzeAudit } from './analysis.js';
import { MAX_URLS, MAX_DATASET_BYTES } from './types.js';
import type { ExtractionTask, Job, LinkRow, PageRow } from './types.js';

export interface StartAuditInput { crawlId?: string; url?: string; configPath?: string; useCurrentConfig?: boolean; clientName?: string; siteName?: string }
export const BUNDLED_AUDIT_PRESET = fileURLToPath(new URL('../presets/technical-audit-v1.seospiderconfig', import.meta.url));
interface Owner { auditId: string; storeRoot: string }
const terminal = new Set(['ready', 'failed', 'cancelled']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const BUSY_STATUS = 'Tool error: IllegalStateException: Tool cannot be called currently. Please check the state of the Spider';

/** Independent of snapshot directories and localhost aliases: one visible application per port/user. */
export function applicationLockRoot(): string { return join(tmpdir(), `jestats-screamingfrog-${createHash('sha256').update(userInfo().username).digest('hex').slice(0, 16)}`); }
export function applicationKey(endpoint: string): string { return `native-port:${new URL(endpoint).port || '80'}`; }
export function applicationOwnerPath(endpoint: string, root = applicationLockRoot()): string { return join(root, `${digest(applicationKey(endpoint))}.owner.json`); }
/** Caller holds the application lease; verification harnesses must honor durable jobs too. */
export async function assertApplicationUnowned(endpoint: string, root = applicationLockRoot()): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(applicationOwnerPath(endpoint, root), 'utf8')) as Owner;
    validateId(owner.auditId);
    if (typeof owner.storeRoot !== 'string' || !isAbsolute(owner.storeRoot)) throw new Error('Invalid application owner record.');
    const job = await new AuditStore(owner.storeRoot).readJob(owner.auditId);
    if (!terminal.has(job.stage)) throw new BusyError();
  } catch (error) { if (!absent(error)) throw error; }
}

/** Calls advance on demand. No background worker outlives the assistant session. */
export class AuditManager {
  private ownerPath: string;
  constructor(readonly native: NativeClient, readonly store: AuditStore, readonly applicationRoot = applicationLockRoot()) {
    this.ownerPath = applicationOwnerPath(native.endpoint, applicationRoot);
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.applicationRoot, applicationKey(this.native.endpoint));
    try { return await action(); } finally { await release(); }
  }
  private async owner(): Promise<Owner | null> {
    try {
      const value = JSON.parse(await readFile(this.ownerPath, 'utf8')) as Owner;
      validateId(value.auditId);
      if (typeof value.storeRoot !== 'string' || !isAbsolute(value.storeRoot)) throw new Error('Invalid application owner record.');
      return value;
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  private async claim(job: Job): Promise<void> {
    const owner = await this.owner();
    if (owner && (owner.auditId !== job.id || owner.storeRoot !== this.store.root)) {
      const other = await new AuditStore(owner.storeRoot).readJob(owner.auditId);
      if (!terminal.has(other.stage)) throw new BusyError();
    }
    await atomicJson(this.ownerPath, { auditId: job.id, storeRoot: this.store.root });
  }
  private async releaseOwner(job: Job): Promise<void> {
    const owner = await this.owner();
    if (owner?.auditId === job.id && owner.storeRoot === this.store.root) await rm(this.ownerPath, { force: true });
  }
  private async save(job: Job): Promise<Job> { job.updatedAt = new Date().toISOString(); await this.store.saveJob(job); return job; }
  private warning(job: Job, message: string): void {
    job.coverageWarnings ??= [];
    if (!job.coverageWarnings.includes(message)) job.coverageWarnings.push(boundDisplayText(message, 2000));
  }
  private async read<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 5 || !(error instanceof NativeError) || error.code !== 'TOOL_ERROR' || error.message !== BUSY_STATUS) throw error;
        await delay(100);
      }
    }
  }
  async start(input: StartAuditInput): Promise<Job> {
    if (Boolean(input.crawlId) === Boolean(input.url)) throw new Error('Supply exactly one saved crawlId or new crawl url.');
    if (input.crawlId) requireBoundedCrawlId(input.crawlId);
    let url: string | undefined;
    if (input.url) {
      const parsed = new URL(input.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Crawl URL must use HTTP or HTTPS without credentials.');
      url = parsed.href;
      if (url.length > MAX_DISPLAY_CRAWL_URL) throw new Error('Normalized crawl URL exceeds the 2,048-character exact identity limit. No crawl was launched.');
      if (!input.configPath && input.useCurrentConfig !== true) {
        try { await stat(BUNDLED_AUDIT_PRESET); }
        catch { throw new Error('The bundled native preset is missing. Supply an absolute configPath or explicitly set useCurrentConfig=true; coverage gaps will be disclosed.'); }
        input = { ...input, configPath: BUNDLED_AUDIT_PRESET };
      }
    }
    let configHash: string | null = null;
    if (input.configPath) {
      if (!url || !isAbsolute(input.configPath) || !input.configPath.endsWith('.seospiderconfig')) throw new Error('A native configuration must be an absolute .seospiderconfig path for a new crawl.');
      const info = await stat(input.configPath);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Native configuration must be a file no larger than 10 MiB.');
      configHash = createHash('sha256').update(await readFile(input.configPath)).digest('hex');
    }
    return this.exclusive(async () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const job: Job = { schemaVersion: 1, id, createdAt: now, updatedAt: now, stage: 'queued',
        source: input.crawlId ? { crawlId: input.crawlId } : { url, ...(input.configPath ? { configPath: input.configPath } : {}) },
        crawlName: `JEStats audit ${id}`, nativeCrawlId: null, ownsCrawl: Boolean(url),
        preset: input.crawlId ? 'saved-crawl:configuration-unknown' : input.configPath === BUNDLED_AUDIT_PRESET ? 'technical-audit-v1:provisional-24.3-export' : configHash ? `advanced-config:observed-sha256:${configHash}` : 'current-native-settings:unverified',
        configHash, ...(input.clientName ? { clientName: input.clientName } : {}), ...(input.siteName ? { siteName: input.siteName } : {}),
        extractedRows: 0, message: 'Audit queued.', coverageWarnings: [], linksAvailable: false };
      // Check before creating a second job so repeated starts cannot replace an active native crawl.
      const owner = await this.owner();
      if (owner) {
        const other = await new AuditStore(owner.storeRoot).readJob(owner.auditId);
        if (!terminal.has(other.stage)) throw new BusyError();
      }
      const progress = await this.read(() => this.native.status());
      const phase = nativePhase(progress.raw);
      if (phase.crawlComplete !== true && phase.state !== 'SpiderNoDataIdleState') throw new Error('The native application has active or unknown crawl state. Finish or pause it and select a saved crawl; no new crawl was started.');
      job.previousCrawlId = progress.crawlId;
      await this.save(job);
      await this.claim(job);
      try {
        if (input.crawlId) {
          job.stage = 'starting'; job.nativeCrawlId = input.crawlId; job.launchAttemptedAt = now;
          job.message = 'Loading the selected saved database crawl once.';
          await this.save(job);
          if (progress.crawlId !== input.crawlId) await this.native.loadCrawl(input.crawlId);
        } else {
          job.stage = 'starting'; job.launchAttemptedAt = now;
          job.message = 'New crawl launch recorded. Reconciliation will use this unique crawl name.';
          this.warning(job, 'Native configuration coverage has not been verified. Missing extraction fields and dependent analysis remain visible gaps.');
          if (configHash) this.warning(job, 'The configuration hash records the local file observed before launch. Applied native configuration is unverified and a mutable file may subsequently change.');
          await this.save(job); // A durable intent precedes the only launch attempt.
          await this.native.startCrawl(url!, input.configPath, job.crawlName);
        }
        job.message = 'Native operation accepted; call audit_status to reconcile identity and continue.';
      } catch (error) {
        job.message = 'Native operation response was interrupted or rejected. Call audit_status to reconcile; this launch/load will not be retried.';
        job.error = boundDisplayText(error instanceof Error ? error.message : String(error), 2000);
      }
      return this.save(job);
    });
  }
  private phase(progress: NativeProgress) {
    const mapped = nativePhase(progress.raw);
    return { complete: progress.crawlComplete ?? mapped.crawlComplete, analysis: progress.analysisComplete ?? mapped.analysisReady };
  }
  private sourceTotal(progress: NativeProgress): number | null {
    if (progress.totalUrls !== null) return progress.totalUrls;
    const raw = progress.raw as { crawlProgress?: { completed?: unknown } } | null;
    const value = raw?.crawlProgress?.completed;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  private async consistent(job: Job): Promise<NativeProgress> {
    const progress = await this.read(() => this.native.status());
    if (!progress.crawlId || progress.crawlId !== job.nativeCrawlId) throw new Error('Crawl identity changed. This snapshot is rejected; restore the exact selected database crawl and resume, or cancel.');
    if (this.phase(progress).complete !== true) throw new Error('Crawl is no longer complete. Extraction was interrupted; the snapshot is rejected until the exact complete crawl is restored.');
    const total = this.sourceTotal(progress);
    if (total !== null && total > MAX_URLS) throw new Error(`Crawl exceeds the ${MAX_URLS.toLocaleString('en-US')}-URL limit. No snapshot was sampled.`);
    if (job.checkpoint?.sourceTotal !== null && job.checkpoint?.sourceTotal !== undefined && total !== job.checkpoint.sourceTotal) throw new Error('Native crawl URL count changed during extraction. Snapshot rejected.');
    return progress;
  }
  private async tasks(job: Job, progress: NativeProgress): Promise<void> {
    const filters = await this.read(() => this.native.availableFilters('Internal'));
    if (!filters.includes('All')) throw new Error('The native Internal/All dataset is unavailable.');
    const available = await this.read(() => this.native.availableFields('Internal', 'All'));
    if (!available.includes('Address')) throw new Error('The native dataset lacks exact Address evidence.');
    const fields = AUDIT_FIELDS.filter(field => available.includes(field));
    const tasks: ExtractionTask[] = [{ element: 'Internal', filter: 'All', fields, nextRow: 0, rows: 0, done: false }];
    const extras = [['Page Titles', 'Missing'], ['Meta Description', 'Missing'], ['H1', 'Missing'], ['Canonicals', 'Multiple Conflicting'], ['Sitemaps', 'URLs in Sitemap']];
    for (const [element, filter] of extras) {
      try {
        if ((await this.read(() => this.native.availableFilters(element!))).includes(filter!) && (await this.read(() => this.native.availableFields(element!, filter!))).includes('Address')) tasks.push({ element: element!, filter: filter!, fields: ['Address'], nextRow: 0, rows: 0, done: false });
        else this.warning(job, `${element}/${filter} evidence is unavailable.`);
      } catch (error) {
        if (error instanceof NativeError && error.code === 'UNAVAILABLE') throw error;
        this.warning(job, `${element}/${filter} discovery failed; dependent evidence remains unknown.`);
      }
    }
    job.analysisReady = this.phase(progress).analysis;
    job.checkpoint = { crawlId: job.nativeCrawlId!, sourceTotal: this.sourceTotal(progress), taskIndex: 0, pageSize: 100, tasks, linksAttempted: false, chunks: [], verificationIndex: 0, datasetBytes: 0 };
    job.stage = 'extracting';
    job.message = 'Extracting selected fields into resumable local chunks.';
    await this.save(job);
  }
  private chunkPath(job: Job, task: number, start: number): string { return join(this.store.directory(job.id), 'chunks', `${task}-${start}.json`); }
  private async extract(job: Job): Promise<void> {
    const checkpoint = job.checkpoint!;
    const task = checkpoint.tasks[checkpoint.taskIndex];
    if (!task) { await this.verifyChunk(job); return; }
    await this.consistent(job);
    let page;
    try { page = await this.read(() => this.native.exportPage(task.element, task.filter, task.fields, task.nextRow, checkpoint.pageSize)); }
    catch (error) {
      // Only a verified response-size error permits a smaller read-only retry.
      if (checkpoint.pageSize > 1 && error instanceof NativeError && error.code === 'TOOL_ERROR' && /(?:response|output).*(?:size|bytes|limit|large)/i.test(error.message)) {
        checkpoint.pageSize = Math.max(1, Math.floor(checkpoint.pageSize / 2));
        job.message = `Native response limit reached; next read will use ${checkpoint.pageSize} rows.`;
        await this.save(job); return;
      }
      if (checkpoint.taskIndex > 0 && error instanceof NativeError && ['TOOL_ERROR', 'UNSUPPORTED'].includes(error.code) && error.message !== BUSY_STATUS) {
        await this.consistent(job);
        this.warning(job, `${task.element}/${task.filter} could not be extracted: ${error.message}. Dependent checks remain unassessed.`);
        checkpoint.chunks = checkpoint.chunks!.filter(chunk => chunk.task !== checkpoint.taskIndex);
        task.done = true; task.skipped = true; task.rows = 0; checkpoint.taskIndex++;
        await this.save(job); return;
      }
      throw error;
    }
    await this.consistent(job);
    for (const row of page.rows) rowAddress(row);
    if (task.rows + page.rows.length > MAX_URLS) throw new Error('Extracted dataset exceeds 100,000 URLs; no rows were sampled.');
    const path = this.chunkPath(job, checkpoint.taskIndex, task.nextRow);
    await mkdir(join(this.store.directory(job.id), 'chunks'), { recursive: true, mode: 0o700 });
    const hash = digest(page.rows);
    const bytes = Buffer.byteLength(JSON.stringify(page.rows));
    if ((checkpoint.datasetBytes ?? 0) + bytes > MAX_DATASET_BYTES) throw new Error('Extraction exceeds the 128 MiB data budget. No rows were sampled.');
    try {
      const existing = JSON.parse(await readFile(path, 'utf8'));
      if (digest(existing) !== hash) throw new Error('A checkpoint replay returned different source rows. Snapshot rejected.');
    } catch (error) { if (absent(error)) await atomicJson(path, page.rows); else throw error; }
    checkpoint.chunks!.push({ task: checkpoint.taskIndex, start: task.nextRow, count: page.rows.length, sha256: hash });
    checkpoint.datasetBytes = (checkpoint.datasetBytes ?? 0) + bytes;
    task.nextRow += page.rows.length; task.rows += page.rows.length;
    if (checkpoint.taskIndex === 0) job.extractedRows = task.rows;
    if (!page.hasMore) { task.done = true; checkpoint.taskIndex++; }
    await this.save(job);
  }
  private async verifyChunk(job: Job): Promise<void> {
    const checkpoint = job.checkpoint!;
    const chunk = checkpoint.chunks![checkpoint.verificationIndex!];
    if (chunk) {
      await this.consistent(job);
      const task = checkpoint.tasks[chunk.task]!;
      const rows = await this.read(() => this.native.exportPage(task.element, task.filter, task.fields, chunk.start, Math.max(1, chunk.count)));
      await this.consistent(job);
      if (rows.rows.length !== chunk.count || digest(rows.rows) !== chunk.sha256) throw new Error('Source rows changed during verification. The snapshot is rejected.');
      if (chunk.count > 0 && chunk.start + chunk.count === task.rows) {
        // An unchanged prefix cannot prove that a terminal filter has not gained more rows.
        const boundary = await this.read(() => this.native.exportPage(task.element, task.filter, task.fields, task.rows, 1));
        await this.consistent(job);
        if (boundary.rows.length !== 0 || boundary.hasMore) throw new Error('Source terminal boundary changed during verification. The snapshot is rejected.');
      }
      checkpoint.verificationIndex!++;
      job.message = 'Verifying extracted source rows before publishing an immutable snapshot.';
      await this.save(job); return;
    }
    if (!checkpoint.linksAttempted) {
      await this.consistent(job);
      try {
        const categories = await this.native.availableBulkExports();
        const category = categories.find(name => name === 'Links:All Inlinks');
        if (!category) throw new Error('Internal inlink export is unavailable.');
        const rows = await this.native.bulkExport(category, ['Source', 'Destination', 'Type']);
        if (rows.length > 2_000_000) throw new Error('Link evidence exceeds the two-million-link memory limit.');
        if (rows.some(row => typeof row.Type !== 'string')) throw new Error('Native link export lacks explicit link Type evidence.');
        // Canonical and redirect relationships require their own remediation, not hyperlink replacement.
        const links: LinkRow[] = rows.filter(row => row.Type === 'Hyperlink').map(row => {
          if (typeof row.Source !== 'string' || typeof row.Destination !== 'string') throw new Error('Native hyperlink export lacks Source/Destination evidence.');
          return { source: rowAddress({ Address: row.Source }), target: rowAddress({ Address: row.Destination }) };
        });
        await this.consistent(job);
        await this.store.saveLinks(job.id, links); job.linksAvailable = true;
      } catch (error) {
        if (error instanceof NativeError && error.code === 'UNAVAILABLE') throw error;
        // Recheck before accepting an optional-data gap; identity changes are never optional.
        await this.consistent(job);
        job.linksAvailable = false;
        this.warning(job, `Internal inlinks were not available: ${error instanceof Error ? error.message : 'unknown error'}. Shared linking-page reach is unassessed.`);
      }
      checkpoint.linksAttempted = true; await this.save(job); return;
    }
    await this.finish(job);
  }
  private async finish(job: Job): Promise<void> {
    await this.consistent(job);
    const checkpoint = job.checkpoint!;
    const enrichment: Enrichment = {};
    const main: Record<string, unknown>[] = [];
    for (let taskIndex = 0; taskIndex < checkpoint.tasks.length; taskIndex++) {
      const task = checkpoint.tasks[taskIndex]!;
      if (task.skipped) continue;
      const addresses = new Set<string>();
      for (const chunk of checkpoint.chunks!.filter(item => item.task === taskIndex)) {
        const rows = JSON.parse(await readFile(this.chunkPath(job, taskIndex, chunk.start), 'utf8')) as Record<string, unknown>[];
        if (digest(rows) !== chunk.sha256 || rows.length !== chunk.count) throw new Error('A persisted extraction chunk is corrupt.');
        for (const row of rows) {
          const address = rowAddress(row);
          if (addresses.has(address)) throw new Error('Native pagination returned duplicate Addresses; snapshot count cannot reconcile.');
          addresses.add(address); if (taskIndex === 0) main.push(row);
        }
      }
      if (addresses.size !== task.rows) throw new Error('Snapshot counts do not reconcile with extracted rows.');
      if (task.element === 'Page Titles') enrichment.missingTitle = addresses;
      if (task.element === 'Meta Description') enrichment.missingDescription = addresses;
      if (task.element === 'H1') enrichment.missingH1 = addresses;
      if (task.element === 'Canonicals') enrichment.conflictingCanonical = addresses;
      if (task.element === 'Sitemaps') enrichment.inSitemap = addresses;
    }
    const pages = main.map((row, id) => normalizePage(row, id, enrichment)).sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
    for (let id = 0; id < pages.length; id++) pages[id]!.id = id;
    let normalizedBytes = 0;
    for (const page of pages) {
      normalizedBytes += Buffer.byteLength(JSON.stringify(page)) + 1;
      if (normalizedBytes > MAX_DATASET_BYTES) throw new Error('Normalized snapshot exceeds the 128 MiB data budget. No rows were sampled.');
    }
    if (pages.length !== job.extractedRows) throw new Error('Normalized snapshot count mismatch.');
    if (!pages.length) throw new Error('The selected crawl has no internal URLs to audit.');
    job.stage = 'analyzing'; job.message = 'Computing deterministic grouped findings and priority rationale.'; await this.save(job);
    if (!(await this.store.hasSnapshot(job.id))) {
      const writer = await this.store.beginSnapshot(job.id);
      try { for (const page of pages) await writer.append(page); await writer.commit(); }
      catch (error) { await writer.abort(); throw error; }
    } else {
      // A previous process may have committed before persisting the next job step.
      let index = 0;
      for await (const page of this.store.pages(job.id)) {
        if (JSON.stringify(page) !== JSON.stringify(pages[index++])) throw new Error('Published snapshot differs from checkpoint data.');
      }
      if (index !== pages.length) throw new Error('Published snapshot count mismatch.');
    }
    const snapshot = await this.store.snapshotIndex(job.id);
    const links = await this.store.readLinks(job.id);
    const result = analyzeAudit(pages, links, { id: job.id, sourceCrawlId: job.nativeCrawlId!, createdAt: job.createdAt,
      siteUrl: job.source.url ?? pages[0]!.url, preset: job.preset, snapshotHash: snapshot.sha256, source: 'native', linksAvailable: job.linksAvailable, analysisReady: job.analysisReady });
    if (job.coverageWarnings?.length) for (const coverage of result.coverage) {
      if (coverage.state === 'assessed') coverage.state = 'partial';
      coverage.reason = boundDisplayText(`${coverage.reason} Acquisition notes: ${job.coverageWarnings.join(' ')}`, 8000);
    }
    await this.store.saveResult(result);
    await atomicJson(join(this.store.directory(job.id), 'finding-index.json'), Object.fromEntries(result.findings.map((finding, index) => [finding.id, index])));
    job.stage = 'ready'; job.message = `Audit ready: ${pages.length} URLs, ${result.findings.length} grouped findings. Coverage gaps are disclosed.`;
    delete job.error;
    await this.save(job); await this.releaseOwner(job);
  }
  async advance(id: string): Promise<Job> {
    validateId(id);
    return this.exclusive(async () => {
      const job = await this.store.readJob(id);
      if (terminal.has(job.stage) || job.stage === 'paused' || job.stage === 'needs_user_action') return job;
      await this.claim(job);
      try {
        if (job.stage === 'queued' && !job.launchAttemptedAt) {
          const before = await this.read(() => this.native.status());
          const phase = nativePhase(before.raw);
          if (this.phase(before).complete !== true && phase.state !== 'SpiderNoDataIdleState') throw new Error('The unattempted queued job cannot launch while native crawl state is active or unknown.');
          job.stage = 'starting'; job.launchAttemptedAt = new Date().toISOString();
          job.message = 'Recovering the first, previously unattempted native operation.';
          await this.save(job);
          if (job.source.crawlId) {
            job.nativeCrawlId = job.source.crawlId; await this.save(job);
            if (before.crawlId !== job.source.crawlId) await this.native.loadCrawl(job.source.crawlId);
          } else if (job.source.url) await this.native.startCrawl(job.source.url, job.source.configPath, job.crawlName);
          else throw new Error('Queued job has no saved source or crawl URL.');
        }
        if (!job.checkpoint) {
          const progress = await this.read(() => this.native.status());
          if (job.source.crawlId) {
            if (progress.crawlId !== job.source.crawlId) throw new Error('The selected saved crawl is not active. Restore that exact database crawl ID, then resume. The load will not be retried automatically.');
            job.nativeCrawlId = job.source.crawlId;
          } else if (!job.nativeCrawlId) {
            const matches = (await this.read(() => this.native.listCrawls(100))).filter(crawl => crawl.name === job.crawlName && crawl.url === job.source.url);
            if (matches.length !== 1 || matches[0]!.id !== progress.crawlId) {
              job.stage = 'starting'; job.message = 'Launch identity is still unresolved. No duplicate crawl will be launched. Check the native application and call audit_status again, or cancel.'; return this.save(job);
            }
            job.nativeCrawlId = matches[0]!.id;
          }
          if (progress.crawlId !== job.nativeCrawlId) throw new Error('Native crawl identity changed. Restore the selected crawl and resume.');
          const phases = this.phase(progress);
          if (phases.complete !== true) { job.stage = 'crawling'; job.message = 'Waiting for a complete native crawl; unknown readiness does not permit extraction.'; return this.save(job); }
          if (phases.analysis === false || progress.apisComplete === false) { job.stage = 'native_analysis'; job.message = 'Waiting for the native analysis/API collection to finish.'; return this.save(job); }
          await this.consistent(job);
          await this.tasks(job, progress);
        }
        // Bound each status request by work units; checkpoints are durable after every page.
        const deadline = Date.now() + 1500;
        for (let steps = 0; steps < 4 && Date.now() < deadline && job.stage !== 'ready'; steps++) await this.extract(job);
      } catch (error) {
        const message = boundDisplayText(error instanceof Error ? error.message : String(error), 2000);
        job.error = message;
        if (error instanceof NativeError && (error.code === 'UNAVAILABLE' || message === BUSY_STATUS)) {
          if (job.checkpoint) job.checkpoint.verificationIndex = 0;
          job.message = 'Native connection is interrupted or busy. Resume on the next audit_status request; the launch and saved load will not be repeated.';
        } else {
          job.stage = 'needs_user_action'; job.message = message;
        }
        await this.save(job);
      }
      return job;
    });
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<Job> {
    validateId(id);
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Unknown audit control action.');
    return this.exclusive(async () => {
      const job = await this.store.readJob(id);
      if (terminal.has(job.stage)) return job;
      await this.claim(job);
      if (action === 'cancel') {
        // Closing the local job must survive a native disconnect or a crash during best-effort pause.
        job.stage = 'cancelled';
        job.message = 'Audit cancelled locally; checkpoints are retained. Native pause has not been confirmed; check the application.';
        delete job.error;
        await this.save(job);
        let pauseSent = false;
        if (job.ownsCrawl && job.nativeCrawlId) {
          try {
            const progress = await this.read(() => this.native.status());
            if (progress.crawlId === job.nativeCrawlId && this.phase(progress).complete !== true) { await this.native.control('pause'); pauseSent = true; }
          } catch (error) {
            job.error = boundDisplayText(error instanceof Error ? error.message : String(error), 2000);
            this.warning(job, 'Native pause could not be confirmed during cancellation. The native crawl may still be running; check the application.');
          }
        }
        job.message = `Audit cancelled; local checkpoints are retained. ${pauseSent ? 'A pause was sent to the exact owned crawl.' : 'A native pause was not confirmed; the crawl may still be running. Check the application.'}`;
        await this.save(job); await this.releaseOwner(job); return job;
      }
      if (action === 'pause') {
        let pauseSent = false;
        if (job.ownsCrawl && job.nativeCrawlId) {
          const progress = await this.read(() => this.native.status());
          if (progress.crawlId !== job.nativeCrawlId) throw new Error('Crawl identity changed; no pause was sent.');
          if (this.phase(progress).complete !== true) { await this.native.control('pause'); pauseSent = true; }
        }
        job.stage = 'paused'; job.message = `Local audit paused with durable checkpoints. ${pauseSent ? 'A pause was sent to the exact owned crawl.' : 'No native pause was sent.'}`;
      } else {
        if (job.stage !== 'paused' && job.stage !== 'needs_user_action') return job;
        const progress = await this.read(() => this.native.status());
        if (job.nativeCrawlId && progress.crawlId !== job.nativeCrawlId) throw new Error('Restore the exact selected database crawl before resuming.');
        if (job.ownsCrawl && job.nativeCrawlId && !job.checkpoint && job.stage === 'paused' && this.phase(progress).complete !== true) await this.native.control('resume');
        if (job.checkpoint) job.checkpoint.verificationIndex = 0;
        job.stage = job.checkpoint ? 'extracting' : 'starting'; job.message = 'Resumed; audit_status will reconcile and advance from the checkpoint.'; delete job.error;
      }
      return this.save(job);
    });
  }
}
