import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '../src/lock.js';
import { applicationLockRoot, applicationKey, assertApplicationUnowned } from '../src/audit.js';
import { nativePhase } from '../src/extraction.js';
import { atomicJson } from '../src/storage.js';
import { DEFAULT_NATIVE_ENDPOINT, NATIVE_BUSY_MESSAGE, NativeError, ScreamingFrogNative, nativeFetch } from '../src/native.js';
import type { NativeClient, NativeProgress, NativeSessionFactory, NativeTool } from '../src/native-contract.js';
import { FIXTURE_ROUTES, startNativeTestSite } from './native-test-site.js';
import type { NativeTestSite } from './native-test-site.js';

type Verdict = 'passed' | 'failed' | 'unassessed';
interface Check { verdict: Verdict; evidence: string }
type Captured<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
interface Observation { phase: string; at: string; result: Captured<NativeProgress> }
const CHECK_NAMES = ['connection', 'newCrawl', 'identity', 'pagination', 'savedCrawlReload', 'reconnect', 'readiness', 'configuration', 'windows', 'interruptedStartRecovery'] as const;
export interface Evidence {
  runId: string; recordedAt: string; platform: string; architecture: string; nodeVersion: string;
  readOnly: boolean; integrationVerified: false; endpoint: string;
  note: string; checks: Record<string, Check>; tools?: NativeTool[]; observations: Observation[];
  [key: string]: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function stateName(progress: NativeProgress): string | null {
  const raw = object(progress.raw);
  return typeof raw?.stateName === 'string' ? raw.stateName : null;
}
function errorRecord(error: unknown) {
  return { code: error instanceof NativeError ? error.code : 'HARNESS_ERROR', message: error instanceof Error ? error.message : String(error) };
}
async function capture<T>(action: () => Promise<T>): Promise<Captured<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: errorRecord(error) }; }
}
function check(evidence: Evidence, name: string, verdict: Verdict, detail: string) { evidence.checks[name] = { verdict, evidence: detail }; }
function stableRows(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function knownReadiness(progress: NativeProgress): boolean {
  return progress.crawlComplete === true && progress.analysisComplete === true && progress.apisComplete === true;
}

/** Native calls time out within ten seconds; progress polling has an overall thirty-second deadline. */
const boundedSession: NativeSessionFactory = async endpoint => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'jestats-native-gate', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nativeFetch(endpoint) });
  try { await client.connect(transport, { timeout: 10_000 }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return {
    async listTools(cursor) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
      return { tools: result.tools as NativeTool[], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    callTool(name, args) { return client.callTool({ name, arguments: args }, { timeout: name === 'sf_crawl_progress' ? 3_000 : 10_000 }); },
    close() { return client.close(); },
  };
};

async function observe(native: NativeClient, evidence: Evidence, phase: string, persist: () => Promise<void>, tolerateBusy = false): Promise<NativeProgress | undefined> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const result = await capture(() => native.status());
    evidence.observations.push({ phase, at: new Date().toISOString(), result });
    await persist();
    if (result.ok) return result.value;
    if (result.error.code === 'TOOL_ERROR' && result.error.message === NATIVE_BUSY_MESSAGE) {
      if (tolerateBusy) return undefined;
      if (Date.now() < deadline) { await delay(100); continue; }
    }
    throw new Error(`Status unavailable during ${phase}: ${result.error.message}`);
  }
}

interface ControlledGateOptions {
  replaceOwnedTest?: boolean;
  /** Deterministic clock/wait injection for tests; live callers use real wall time. */
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function ownedLocalFixtureUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
}

/** This function calls sf_crawl exactly once. A thrown/ambiguous response is persisted and never retried. */
export async function runControlledGate(native: NativeClient, evidence: Evidence, persist: () => Promise<void>, startSite = startNativeTestSite, options: ControlledGateOptions = {}): Promise<void> {
  let site: NativeTestSite | undefined;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const baseline = await observe(native, evidence, 'before-start', persist);
  const crawlsBefore = await capture(() => native.listCrawls(100));
  evidence.crawlsBefore = crawlsBefore;
  await persist();
  if (!baseline) throw new Error('Baseline status was not established.');
  if (stateName(baseline) !== 'SpiderNoDataIdleState') {
    const owned = crawlsBefore.ok && baseline.crawlId !== null ? crawlsBefore.value.filter(crawl => crawl.id === baseline.crawlId) : [];
    const existing = owned.length === 1 ? owned[0]! : null;
    if (!options.replaceOwnedTest || stateName(baseline) !== 'SpiderCrawlIdleState' || !existing?.name?.startsWith('JEStats native verification ') || existing.name.length <= 'JEStats native verification '.length || !ownedLocalFixtureUrl(existing.url)) {
      throw new Error('Controlled launch requires blank SpiderNoDataIdleState, or --replace-owned-test with idle data exactly matched to one saved JEStats native verification crawl on 127.0.0.1. Unrelated or active crawl data will not be replaced.');
    }
    evidence.replacementIntent = { crawlId: existing.id, crawlName: existing.name, crawlUrl: existing.url, recordedAt: new Date().toISOString(), authorization: 'Explicit --replace-owned-test; only exact saved owned localhost fixture identity accepted.' };
    await persist();
  }
  try {
    site = await startSite();
    const crawlUrl = `${site.origin}/`;
    evidence.fixture = { origin: site.origin, expectedRoutes: site.expectedRoutes };
    const crawlName = `JEStats native verification ${evidence.runId}`;
    evidence.launchIntent = {
      crawlName, crawlUrl, recordedAt: new Date().toISOString(),
      launchAttempts: 1, configPath: null,
      configuration: 'Existing native application configuration; no exported technical-audit preset is installed or verified.',
      recovery: 'If the response is ambiguous, inspect native progress and saved crawls for this exact name/URL. Never repeat this launch.',
    };
    await persist(); // The unique intent must be durable BEFORE the single mutation.
    const launch = await capture(() => native.startCrawl(crawlUrl, undefined, crawlName));
    evidence.startResult = launch;
    await persist();
    if (!launch.ok) {
      check(evidence, 'newCrawl', 'unassessed', 'Launch response failed or was ambiguous. No second launch was attempted. Reconcile the persisted intent manually.');
      evidence.crawlsAfterAmbiguousLaunch = await capture(() => native.listCrawls(100));
      await capture(() => observe(native, evidence, 'ambiguous-start-reconciliation', persist));
      return;
    }
    check(evidence, 'newCrawl', 'unassessed', 'One sf_crawl call returned successfully; its exact saved identity has not yet been reconciled.');
    const deadline = now() + 30_000;
    let last: NativeProgress | undefined;
    do {
      // Do not issue another three-second native call too close to the overall deadline.
      if (now() > deadline - 3_000) break;
      const current = await observe(native, evidence, 'crawl-poll', persist, true);
      if (current) last = current;
      if (current && (knownReadiness(current) || nativePhase(current.raw).crawlComplete === true)) break;
      await wait(Math.min(1_000, Math.max(0, deadline - now() - 3_000)));
    } while (now() < deadline - 3_000);
    // Leave the HTTP fixture alive for the full deadline when no terminal readiness was observed.
    // The last three seconds are reserved because an additional native status call can take three seconds.
    if ((!last || (!knownReadiness(last) && nativePhase(last.raw).crawlComplete !== true)) && now() < deadline) await wait(deadline - now());
    evidence.polling = { deadlineSeconds: 30, readinessDerivedFromPercentages: false, lastStateName: last ? stateName(last) : null };
    if (last && knownReadiness(last)) check(evidence, 'readiness', 'passed', 'Native adapter returned explicit true crawl, analysis, and API readiness fields.');
    else check(evidence, 'readiness', 'unassessed', 'No explicit complete readiness contract is available. Exact stateName transitions and progress payloads are retained for native/UI verification; percentages do not establish readiness.');
    const crawlsAfter = await capture(() => native.listCrawls(100));
    evidence.crawlsAfter = crawlsAfter;
    await persist();
    if (!last?.crawlId) {
      check(evidence, 'identity', 'failed', 'An exact active database crawl ID was not established; no exports or saved-crawl load were attempted.');
      return;
    }
    const crawlId = last.crawlId;
    const launchedSavedCrawl = crawlsAfter.ok ? crawlsAfter.value.filter(crawl => crawl.id === crawlId && crawl.name === crawlName && crawl.url === crawlUrl) : [];
    if (launchedSavedCrawl.length !== 1) {
      check(evidence, 'newCrawl', 'unassessed', 'The active database ID could not be independently matched exactly once to the unique saved crawl name and fixture URL. No export or load was attempted.');
      return;
    }
    check(evidence, 'newCrawl', 'passed', 'Exactly one launch was accepted and the active database ID matched the unique saved crawl name and fixture URL. A blank application database ID may be reused.');
    evidence.observedCrawlId = crawlId;
    evidence.selectedElement = 'Internal';
    const filters = await native.availableFilters('Internal');
    evidence.availableFilters = filters;
    const filter = filters.find(value => value === 'All');
    if (!filter) { check(evidence, 'pagination', 'unassessed', 'The native Internal/All filter was not advertised; no guessed filter was used.'); return; }
    const advertisedFields = await native.availableFields('Internal', filter);
    evidence.availableFields = advertisedFields;
    const fields = ['Address', 'Status Code', 'Content Type', 'Indexability', 'Indexability Status', 'Title 1', 'Meta Description 1', 'H1-1', 'Canonical Link Element 1'].filter(field => advertisedFields.includes(field));
    if (!fields.includes('Address')) { check(evidence, 'pagination', 'unassessed', 'The expected exact Address field was not advertised; no guessed export schema was used.'); return; }
    evidence.selectedFilter = filter;
    evidence.selectedFields = fields;
    const exports: unknown[] = [];
    evidence.exports = exports;
    const before = await observe(native, evidence, 'before-export', persist);
    if (before?.crawlId !== crawlId) throw new Error('Crawl identity changed before extraction.');
    const full = await native.exportPage('Internal', filter, fields, 0, 16);
    exports.push({ phase: 'full-before-reconnect', page: full });
    await persist();
    if (full.rows.length > 15 || full.hasMore) {
      check(evidence, 'pagination', 'failed', 'Export exceeded the fifteen-route fixture bound; no further paginated extraction or reload was attempted.'); return;
    }
    const chunks: Record<string, unknown>[] = [];
    for (let start = 0; start <= full.rows.length; start += 3) {
      const beforePage = await observe(native, evidence, `before-page-${start}`, persist);
      if (beforePage?.crawlId !== crawlId) throw new Error('Crawl identity changed during paginated extraction.');
      const page = await native.exportPage('Internal', filter, fields, start, 3);
      exports.push({ phase: 'paginated-before-reconnect', page });
      chunks.push(...page.rows);
      await persist();
      if (!page.hasMore) break;
    }
    const empty = await native.exportPage('Internal', filter, fields, full.rows.length, 3);
    exports.push({ phase: 'empty-boundary', page: empty });
    const after = await observe(native, evidence, 'after-export', persist);
    const ids = evidence.observations.filter(observation => observation.phase.startsWith('before-page-') || ['before-export', 'after-export'].includes(observation.phase)).map(observation => observation.result.ok ? observation.result.value.crawlId : null);
    if (after?.crawlId !== crawlId || ids.some(id => id !== crawlId)) throw new Error('Crawl identity changed across extraction.');
    check(evidence, 'identity', 'passed', `Exact database crawl ID ${crawlId} remained unchanged before, between, and after exports. This alone does not establish analysis readiness.`);
    const paginationMatches = full.rows.length > 3 && stableRows(full.rows) === stableRows(chunks) && empty.rows.length === 0;
    check(evidence, 'pagination', paginationMatches ? 'passed' : 'failed', paginationMatches ? 'Three-row pages and the empty terminal boundary reconcile exactly with one bounded full export. Native UI reconciliation remains a manual gate.' : 'Export count/order/content did not reconcile, or too few rows existed to exercise pagination.');
    const unexpectedAddresses = full.rows.map(row => row.Address).filter(address => typeof address !== 'string' || !site!.expectedRoutes.some(route => address === `${site!.origin}${route}`));
    evidence.fixtureRouteChecks = {
      exportedRows: full.rows.length,
      uniqueAddresses: new Set(full.rows.map(row => row.Address)).size,
      unexpectedAddresses,
    };
    if (unexpectedAddresses.length) {
      check(evidence, 'identity', 'failed', 'Exported URLs include an address outside the known local fixture routes; no saved load was attempted.');
      return;
    }
    await persist();
    await native.close();
    await native.connect();
    const reconnected = await observe(native, evidence, 'after-reconnect', persist);
    check(evidence, 'reconnect', reconnected?.crawlId === crawlId ? 'passed' : 'failed', 'A deliberate completed-query disconnect/reconnect compared the exact active crawl ID. Interrupted start/extraction recovery was not exercised.');
    if (reconnected?.crawlId !== crawlId) return;
    const saved = await capture(() => native.listCrawls(100));
    evidence.crawlsAfterReconnect = saved;
    const matching = saved.ok ? saved.value.filter(crawl => crawl.id === crawlId) : [];
    if (matching.length !== 1) { check(evidence, 'savedCrawlReload', 'unassessed', 'The exact observed active database ID was not found once in the saved-crawl list; no guessed saved ID was loaded.'); return; }
    evidence.loadIntent = { crawlId, recordedAt: new Date().toISOString(), attempts: 1 };
    await persist();
    evidence.loadResult = await capture(() => native.loadCrawl(crawlId));
    await persist();
    const loadResult = evidence.loadResult as Captured<unknown>;
    if (!loadResult.ok && loadResult.error.code !== 'UNAVAILABLE') { check(evidence, 'savedCrawlReload', 'unassessed', 'Saved-crawl load was explicitly rejected; the load was not retried.'); return; }
    const afterLoad = await observe(native, evidence, 'after-saved-load', persist);
    if (afterLoad?.crawlId !== crawlId) { check(evidence, 'savedCrawlReload', 'failed', 'Saved load did not establish the requested database crawl ID.'); return; }
    const loaded = await native.exportPage('Internal', filter, fields, 0, 16);
    exports.push({ phase: 'full-after-saved-load', page: loaded });
    const afterLoadedExport = await observe(native, evidence, 'after-loaded-export', persist);
    const equivalent = !loaded.hasMore && stableRows(loaded.rows) === stableRows(full.rows) && afterLoadedExport?.crawlId === crawlId;
    check(evidence, 'savedCrawlReload', equivalent ? 'passed' : 'failed', equivalent ? `The requested saved ID was reconciled, identity remained stable, and the selected row set matched the new crawl exactly. ${loadResult.ok ? 'The load returned successfully.' : 'The load response was interrupted; reconnect reconciled the requested state without retrying the load.'}` : 'Saved-crawl identity or selected exports differed from the new-crawl evidence.');
  } finally {
    if (site) {
      evidence.fixtureRequests = site.requests;
      await site.close();
      await persist();
    }
  }
}

async function selfTest(): Promise<void> {
  const site = await startNativeTestSite();
  try {
    assert.equal(FIXTURE_ROUTES.length, 15);
    for (const path of FIXTURE_ROUTES) {
      const response = await fetch(`${site.origin}${path}`, { redirect: 'manual' });
      assert.equal(response.status, ['/gone', '/favicon.ico'].includes(path) ? 404 : ['/redirect-one', '/loop-one'].includes(path) ? 301 : ['/redirect-two', '/loop-two'].includes(path) ? 302 : 200);
      const text = await response.text();
      if (path === '/robots.txt') assert.ok(text.includes(`Sitemap: ${site.origin}/sitemap.xml`));
      if (path === '/canonical-bad') assert.ok(text.includes(`href="${site.origin}/gone"`));
      if (path === '/noindex') assert.ok(text.includes('noindex,follow'));
      if (path === '/missing-meta') assert.ok(!text.includes('<title>') && !text.includes('name="description"') && !text.includes('<h1>'));
    }
    const unavailable = { crawlId: 'test', crawlComplete: null, analysisComplete: null, apisComplete: null, paused: null, totalUrls: null, raw: { stateName: 'UnknownState', crawlProgress: { percentComplete: 100 }, postCrawlAnalysisProgress: { percentComplete: 100 }, apiProgress: { percentComplete: 100 } } } satisfies NativeProgress;
    assert.equal(knownReadiness(unavailable), false);
    assert.equal(stableRows([{ z: 1, a: 2 }]), stableRows([{ a: 2, z: 1 }]));
    let launchCount = 0;
    let intentPersisted = false;
    let fixtureClosed = false;
    const evidence: Evidence = {
      runId: 'self-test', recordedAt: new Date().toISOString(), platform: 'self-test', architecture: 'self-test', nodeVersion: process.version,
      readOnly: false, integrationVerified: false, endpoint: 'fake', note: 'No native calls.', checks: {}, observations: [],
    };
    const fake = {
      status: async () => ({ ...unavailable, raw: { stateName: 'SpiderNoDataIdleState' } }),
      listCrawls: async () => [],
      startCrawl: async () => { assert.ok(intentPersisted); launchCount++; throw new NativeError('UNAVAILABLE', 'Ambiguous simulated transport failure'); },
    } as unknown as NativeClient;
    await runControlledGate(fake, evidence, async () => { if (evidence.launchIntent) intentPersisted = true; }, async () => ({ origin: 'http://127.0.0.1:1', expectedRoutes: FIXTURE_ROUTES, requests: [], close: async () => { fixtureClosed = true; } }));
    assert.equal(launchCount, 1);
    assert.equal(fixtureClosed, true);
    assert.equal(evidence.checks.newCrawl?.verdict, 'unassessed');
    assert.ok(evidence.crawlsAfterAmbiguousLaunch);
    console.log('Local fixture self-test passed: fifteen bounded routes, redirect/status cases, sitemap, canonicals, metadata, conservative readiness, durable launch intent, and no retries after an ambiguous simulated start. No native endpoint was contacted.');
  } finally { await site.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { if (args.length !== 1) throw new Error('--self-test cannot be combined with native options.'); await selfTest(); return; }
  const allowed = new Set(['--run-local-test', '--replace-owned-test', '--endpoint', '--output-dir']);
  let endpoint = process.env.SCREAMINGFROG_MCP_URL ?? DEFAULT_NATIVE_ENDPOINT;
  let outputDir = resolve('artifacts/native');
  let runLocal = false;
  let replaceOwnedTest = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!allowed.has(arg)) throw new Error(`Unknown option ${arg}. Use --run-local-test only when a dedicated blank licensed native app is ready.`);
    if (arg === '--run-local-test') runLocal = true;
    else if (arg === '--replace-owned-test') replaceOwnedTest = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--endpoint') endpoint = value; else outputDir = resolve(value);
    }
  }
  if (replaceOwnedTest && !runLocal) throw new Error('--replace-owned-test requires --run-local-test.');
  const native = new ScreamingFrogNative(endpoint, boundedSession);
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(outputDir, `verification-${runId}.json`);
  const evidence: Evidence = {
    runId, recordedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, nodeVersion: process.version,
    readOnly: !runLocal, integrationVerified: false, endpoint: native.endpoint,
    note: 'This artifact records individual checks, never a complete release gate. A genuine native configuration, readiness semantics, interrupted-operation recovery, UI reconciliation, Windows, and host installation still require verification.',
    checks: Object.fromEntries(CHECK_NAMES.map(name => [name, { verdict: 'unassessed', evidence: 'Not exercised.' }])), observations: [],
  };
  const persist = () => atomicJson(artifactPath, evidence);
  let release: (() => Promise<void>) | undefined;
  try {
    await persist();
    // The lease and durable owner are shared across data directories and localhost aliases.
    const lockRoot = applicationLockRoot();
    release = await acquireLock(lockRoot, applicationKey(native.endpoint));
    if (runLocal) await assertApplicationUnowned(native.endpoint, lockRoot);
    await native.connect();
    evidence.tools = await native.discoverTools();
    check(evidence, 'connection', 'passed', 'Native connection and tool-schema discovery succeeded.');
    if (runLocal) await runControlledGate(native, evidence, persist, startNativeTestSite, { replaceOwnedTest });
    else {
      await observe(native, evidence, 'read-only-preflight', persist);
      evidence.recentCrawls = await capture(() => native.listCrawls(3));
      evidence.instructions = 'Read-only preflight completed. To start exactly one bounded localhost fixture crawl and load its exact saved ID, run: node --import tsx scripts/verify-native.ts --run-local-test. The native app must be blank and dedicated to this test.';
    }
  } catch (error) {
    evidence.error = errorRecord(error);
    process.exitCode = 1;
  } finally {
    await native.close().catch(error => { evidence.closeError = errorRecord(error); process.exitCode = 1; });
    if (release) await release().catch(error => { evidence.lockReleaseError = errorRecord(error); process.exitCode = 1; });
    if (Object.values(evidence.checks).some(value => value.verdict === 'failed')) process.exitCode = 1;
    await persist();
  }
  console.log(JSON.stringify({ artifactPath, readOnly: evidence.readOnly, integrationVerified: false, checks: evidence.checks, ...(evidence.error ? { error: evidence.error } : {}) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
