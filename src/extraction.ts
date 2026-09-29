import type { PageRow } from './types.js';
import { normalizeProgress } from './native.js';

/** Exact, verified 24.3 column names. Raw HTML/page-content fields are never selected. */
export const AUDIT_FIELDS = ['Address', 'Content Type', 'Status Code', 'Indexability', 'Indexability Status',
  'Title 1', 'Title 2', 'Meta Description 1', 'Meta Description 2', 'H1-1', 'H1-2',
  'Canonical Link Element 1', 'Canonical Link Element 2', 'Unique Inlinks', 'Redirect URL',
  'Clicks', 'Search Console Clicks'] as const;

function value(row: Record<string, unknown>, names: string[]): unknown {
  const present = names.filter(name => Object.hasOwn(row, name));
  if (present.length === 0) return null;
  const values = present.map(name => row[name]);
  if (values.some(item => item !== values[0])) throw new Error(`Conflicting native values for ${names[0]}.`);
  return values[0];
}
function text(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new Error('Native text field has an unexpected type.');
  if (input.length > 32_768) throw new Error('Native text field exceeds the 32 KiB field limit; no data was sampled.');
  return input;
}
function count(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  const number = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Native numeric field is not a nonnegative integer.');
  return number;
}
export function rowAddress(row: Record<string, unknown>): string {
  const address = text(value(row, ['Address', 'address', 'url']));
  if (!address) throw new Error('Native export did not provide an exact Address field.');
  let parsed: URL;
  try { parsed = new URL(address); } catch { throw new Error('Native Address is not an absolute URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Native Address must use HTTP or HTTPS.');
  return address;
}
export function siteSection(url: string): string {
  const segment = new URL(url).pathname.split('/').find(Boolean);
  return segment ? `/${segment}/` : '/';
}
function target(input: unknown, source: string): string | null {
  const raw = text(input);
  if (raw === null || raw === '') return raw;
  try { return new URL(raw, source).href; } catch { return raw; }
}

export interface Enrichment {
  missingTitle?: Set<string>;
  missingDescription?: Set<string>;
  missingH1?: Set<string>;
  conflictingCanonical?: Set<string>;
  inSitemap?: Set<string>;
  /** Only a verified native preset plus completed sitemap analysis can establish negative membership. */
  sitemapComplete?: boolean;
}
export function normalizePage(row: Record<string, unknown>, id: number, extra: Enrichment = {}): PageRow {
  const url = rowAddress(row);
  const title = text(value(row, ['Title 1', 'title', 'title1']));
  const description = text(value(row, ['Meta Description 1', 'description', 'metaDescription1']));
  const h1 = text(value(row, ['H1-1', 'h1', 'h11']));
  const canonical = target(value(row, ['Canonical Link Element 1', 'canonical', 'canonicalLinkElement1']), url);
  const secondCanonical = text(value(row, ['Canonical Link Element 2', 'canonicalLinkElement2']));
  const indexability = text(value(row, ['Indexability', 'indexability']))?.toLowerCase();
  const declarations = (first: string | null, second: unknown): number | null => {
    if (first === null) return null;
    if (second === null || second === undefined) return first === '' ? 0 : null;
    const other = text(second);
    return Number(first !== '') + Number(other !== null && other !== '');
  };
  const missingTitle = extra.missingTitle?.has(url) === true;
  const missingDescription = extra.missingDescription?.has(url) === true;
  const missingH1 = extra.missingH1?.has(url) === true;
  return {
    id, url, section: siteSection(url),
    statusCode: count(value(row, ['Status Code', 'statusCode', 'status_code'])),
    contentType: text(value(row, ['Content Type', 'contentType', 'content_type'])),
    indexability: indexability === 'indexable' ? 'indexable' : indexability === 'non-indexable' ? 'non-indexable' : 'unknown',
    indexabilityReason: text(value(row, ['Indexability Status', 'indexabilityReason', 'indexabilityStatus'])),
    canonical, canonicalCount: extra.conflictingCanonical?.has(url) ? 2 : declarations(canonical, secondCanonical),
    canonicalConflict: extra.conflictingCanonical ? extra.conflictingCanonical.has(url) : null,
    title: missingTitle ? '' : title, titleCount: missingTitle ? 0 : declarations(title, value(row, ['Title 2', 'title2'])),
    description: missingDescription ? '' : description,
    descriptionCount: missingDescription ? 0 : declarations(description, value(row, ['Meta Description 2', 'metaDescription2'])),
    h1: missingH1 ? '' : h1, h1Count: missingH1 ? 0 : declarations(h1, value(row, ['H1-2', 'h12'])),
    uniqueInlinks: count(value(row, ['Unique Inlinks', 'uniqueInlinks'])),
    searchClicks: count(value(row, ['Clicks', 'Search Console Clicks', 'searchClicks'])),
    inSitemap: extra.inSitemap?.has(url) ? true : extra.sitemapComplete ? false : null,
    redirectTarget: target(value(row, ['Redirect URL', 'redirectTarget', 'redirectUrl']), url),
  };
}

/** State names remain explicit evidence. Only states witnessed in the live gate may be mapped. */
export function nativePhase(raw: unknown): { state: string | null; crawlComplete: boolean | null; paused: boolean | null; analysisReady: boolean | null } {
  const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const source = envelope.progress && typeof envelope.progress === 'object' && !Array.isArray(envelope.progress) ? envelope.progress as Record<string, unknown> : envelope;
  const state = typeof source.stateName === 'string' ? source.stateName : null;
  const explicit = normalizeProgress(raw);
  const progress = source.crawlProgress && typeof source.crawlProgress === 'object' ? source.crawlProgress as Record<string, unknown> : {};
  // Witnessed against the licensed 24.3 UI. An idle state alone could also follow a pause.
  const terminal = state === 'SpiderCrawlIdleState' && progress.active === 0 && progress.waiting === 0
    && progress.percentComplete === 100 && typeof progress.completed === 'number' && progress.completed > 0;
  const completionAliases = ['crawl_complete', 'crawlComplete', 'crawl_finished', 'crawlFinished'];
  const hasExplicitCompletion = completionAliases.some(key => Object.hasOwn(source, key));
  return { state, crawlComplete: hasExplicitCompletion ? explicit.crawlComplete : terminal ? true : state === 'SpiderNoDataIdleState' ? false : null,
    paused: explicit.paused, analysisReady: explicit.analysisComplete };
}
