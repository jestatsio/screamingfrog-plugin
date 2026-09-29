import { createHash } from 'node:crypto';
import { MAX_DATASET_BYTES, MAX_URLS, VERSION, type AuditResult, type Category, type Coverage, type Finding, type LinkRow, type PageRow, type Priority } from './types.js';

export interface AnalysisContext {
  id: string;
  sourceCrawlId: string;
  createdAt: string;
  siteUrl: string;
  preset: string;
  snapshotHash: string;
  source: 'native' | 'fixture';
  linksAvailable?: boolean;
  analysisReady?: boolean | null;
}

interface Candidate {
  rule: string;
  category: Category;
  signature: string;
  section: string;
  ids: Set<number>;
  kind: Finding['kind'];
  confidence: Finding['confidence'];
  title: string;
  summary: string;
  remediation: string;
  severity: number;
  cap?: 'medium' | 'low';
  evidence: Finding['evidence'];
}

const MAX_EVIDENCE_TEXT = 2_000;
const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2, info: 3 };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bounded = (text: string): string => text.length <= MAX_EVIDENCE_TEXT ? text : `${text.slice(0, MAX_EVIDENCE_TEXT - 1)}…`;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 20);
const html = (page: PageRow): boolean => page.contentType !== null && /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(page.contentType);
const success = (page: PageRow): boolean => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 300;
const failed = (page: PageRow): boolean => page.statusCode === 0 || (page.statusCode !== null && page.statusCode >= 400);
const redirect = (page: PageRow): boolean => page.statusCode !== null && page.statusCode >= 300 && page.statusCode < 400 && page.statusCode !== 304;
const metric = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;

/** Resolve relative declarations; absolute native addresses stay exact lookup keys. */
function reference(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Bound aggregation before retaining each group or finding, without repeatedly serializing growing sets. */
function aggregationBudget(dataset: 'candidate' | 'finding', initialBytes = 0): (bytes: number) => void {
  let retainedBytes = initialBytes;
  return (bytes: number): void => {
    if (bytes > MAX_DATASET_BYTES - retainedBytes) {
      throw new Error(`Analysis ${dataset} aggregation exceeds the 128 MiB dataset budget; the audit will not be sampled.`);
    }
    retainedBytes += bytes;
  };
}

/** Pure, deterministic analysis of one verified immutable snapshot. */
export function analyzeAudit(pages: PageRow[], links: LinkRow[], context: AnalysisContext): AuditResult {
  if (pages.length > MAX_URLS) throw new Error('Audit limit is 100,000 URLs; the snapshot will not be sampled.');
  const exact = new Map<string, PageRow>();
  for (let id = 0; id < pages.length; id++) {
    const page = pages[id]!;
    if (page.id !== id) throw new Error('Snapshot page IDs must be sequential, starting at zero.');
    if (!page.url || exact.has(page.url)) throw new Error('Snapshot URLs must be nonempty and unique.');
    exact.set(page.url, page);
  }
  const lookup = (url: string, base = context.siteUrl): PageRow | undefined => exact.get(url) ?? (!/^https?:/i.test(url) ? exact.get(reference(url, base) ?? '') : undefined);
  const linksAvailable = context.linksAvailable === true;
  const analysisReady = context.analysisReady === true;
  const candidates = new Map<string, Candidate>();
  // Include map keys as well as serialized candidate fields: long signatures and sections
  // can multiply across otherwise small, valid link datasets. Account for each new ID once.
  const reserveCandidateBytes = aggregationBudget('candidate');
  const add = (candidate: Omit<Candidate, 'ids'>, pageIds: number[]): void => {
    const key = JSON.stringify([candidate.rule, candidate.signature, candidate.section]);
    const existing = candidates.get(key);
    if (existing) {
      for (const id of pageIds) if (!existing.ids.has(id)) {
        reserveCandidateBytes(String(id).length + (existing.ids.size ? 1 : 0));
        existing.ids.add(id);
      }
    } else {
      const ids = new Set(pageIds);
      let bytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(JSON.stringify({ ...candidate, ids: [] }), 'utf8');
      let first = true;
      for (const id of ids) { bytes += String(id).length + (first ? 0 : 1); first = false; }
      reserveCandidateBytes(bytes);
      candidates.set(key, { ...candidate, ids });
    }
  };
  const scoped = (page: PageRow) => page.section || '/';
  const knownStatuses = pages.filter(page => page.statusCode !== null).length;
  const htmlPages = pages.filter(page => html(page) && success(page));
  const canonicalPages = pages.filter(page => success(page) && (html(page) || page.canonical !== null || page.canonicalCount !== null || page.canonicalConflict === true || page.canonicalConflict === false));
  const unknownContent = pages.filter(page => page.statusCode === null || (success(page) && page.contentType === null)).length;
  const knownIncoming = new Map<number, Set<number>>();
  let missingLinkSource = 0;
  let missingLinkTarget = 0;
  const uniqueEdges = new Set<string>();

  if (linksAvailable) for (const link of links) {
    const source = lookup(link.source);
    const targetUrl = reference(link.target, source?.url ?? link.source);
    if (targetUrl === null) continue;
    if (!source) { missingLinkSource++; continue; }
    const target = lookup(link.target, source.url);
    if (!target) { missingLinkTarget++; continue; }
    const edge = `${source.id}:${target.id}`;
    if (uniqueEdges.has(edge)) continue;
    uniqueEdges.add(edge);
    let sources = knownIncoming.get(target.id);
    if (!sources) { sources = new Set(); knownIncoming.set(target.id, sources); }
    sources.add(source.id);
    if (!failed(target)) continue;
    add({ rule: 'broken_internal_destination', category: 'broken_links', signature: target.url, section: scoped(source), kind: 'failure', confidence: target.statusCode === 403 || target.statusCode === 429 ? 'review' : 'observed', severity: 4,
      title: 'Fix internal links to a failing destination',
      summary: `Observed internal links lead to ${bounded(target.url)} with ${target.statusCode === 0 ? 'no HTTP response' : `HTTP ${target.statusCode}`}. Linking-page counts describe this section only.`,
      remediation: 'Restore the destination if it should exist, or update the shared link to the correct successful URL. Review a shared navigation or template cause as a hypothesis; validate the affected pages after the fix.',
      evidence: { destination: bounded(target.url), destinationPageId: target.id, statusCode: target.statusCode, uniqueLinkingPages: 0, templateCause: 'Hypothesis only; grouping does not prove a shared template.' } }, [source.id]);
  }
  if (!linksAvailable) for (const page of pages) if (failed(page)) {
    add({ rule: 'failing_crawled_url', category: 'broken_links', signature: `${page.statusCode}`, section: scoped(page), kind: 'failure', confidence: page.statusCode === 403 || page.statusCode === 429 ? 'review' : 'observed', severity: 4,
      title: 'Review failing crawled URLs', summary: 'The crawler observed failing URLs. Internal linking-page reach is unknown because link evidence was not extracted.',
      remediation: 'Verify the response, restore URLs that should exist, and extract internal inlinks before deciding which shared links need changing.',
      evidence: { statusCode: page.statusCode, uniqueLinkingPages: null, affectedCountMeaning: 'Failing destination URLs, not linking pages.' } }, [page.id]);
  }

  const redirects = pages.filter(redirect);
  type RedirectOutcome = { kind: 'resolved' | 'loop' | 'unknown'; signature: string; hops: number; destination: string; cycle?: string };
  const outcomes = new Map<number, RedirectOutcome>();
  const evaluateRedirect = (start: PageRow): RedirectOutcome => {
    const prior = outcomes.get(start.id);
    if (prior) return prior;
    const path: PageRow[] = [];
    const positions = new Map<number, number>();
    let current: PageRow = start;
    let outcome: RedirectOutcome;
    while (true) {
      const memo = outcomes.get(current.id);
      if (memo) { outcome = memo; break; }
      const cycleStart = positions.get(current.id);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const signature = `cycle:${digest(cycle.map(page => page.url).sort(compare).join('\n'))}`;
        outcome = { kind: 'loop', signature, hops: cycle.length, destination: current.url, cycle: bounded(cycle.slice(0, 8).map(page => page.url).join(' → ')) };
        for (const page of cycle) outcomes.set(page.id, outcome);
        path.length = cycleStart;
        break;
      }
      if (!redirect(current)) { outcome = { kind: 'resolved', signature: current.url, hops: 0, destination: current.url }; break; }
      positions.set(current.id, path.length);
      path.push(current);
      const targetUrl = current.redirectTarget ? reference(current.redirectTarget, current.url) : null;
      const target = targetUrl === null ? undefined : lookup(current.redirectTarget!, current.url);
      if (!target || target.statusCode === null) { outcome = { kind: 'unknown', signature: targetUrl ?? current.url, hops: 0, destination: targetUrl ?? current.url }; break; }
      current = target;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      outcome = { ...outcome, hops: outcome.hops + 1 };
      outcomes.set(path[index]!.id, outcome);
    }
    return outcomes.get(start.id)!;
  };
  let unknownRedirects = 0;
  for (const page of redirects) {
    const outcome = evaluateRedirect(page);
    if (outcome.kind === 'unknown') { unknownRedirects++; continue; }
    const finalPage = outcome.kind === 'resolved' ? lookup(outcome.destination) : undefined;
    if (finalPage && failed(finalPage)) {
      add({ rule: 'redirect_target_failing', category: 'redirects', signature: finalPage.url, section: scoped(page), kind: 'failure', confidence: finalPage.statusCode === 403 || finalPage.statusCode === 429 ? 'review' : 'observed', severity: 4,
        title: 'Restore a failing redirect destination', summary: 'The observed redirect path ends at a failing HTTP response.',
        remediation: 'Restore the intended final destination or update the redirect rules to a correct successful URL, then re-crawl the path.', evidence: { destination: bounded(finalPage.url), targetStatus: finalPage.statusCode, maxHops: outcome.hops } }, [page.id]);
    }
    if (outcome.kind === 'loop') {
      add({ rule: 'redirect_loop', category: 'redirects', signature: outcome.signature, section: scoped(page), kind: 'failure', confidence: 'observed', severity: 6,
        title: 'Remove a redirect loop', summary: 'Observed redirect targets return to an earlier redirect instead of reaching a final page.',
        remediation: 'Change the shared redirect rules so each affected URL reaches one intended final destination, then re-crawl the loop and any URLs leading into it.',
        evidence: { cycle: outcome.cycle ?? '', maxHops: outcome.hops } }, [page.id]);
    } else if (outcome.hops >= 2) {
      add({ rule: 'redirect_chain', category: 'redirects', signature: outcome.signature, section: scoped(page), kind: 'failure', confidence: 'observed', severity: 3,
        title: 'Shorten a redirect chain', summary: 'Observed redirects require at least two hops to reach the reported destination.',
        remediation: 'Redirect directly to the intended final URL and update known internal links to it. Review shared redirect rules as a possible common cause.',
        evidence: { destination: bounded(outcome.destination), maxHops: outcome.hops } }, [page.id]);
    } else if (finalPage && success(finalPage) && ((knownIncoming.get(page.id)?.size ?? 0) > 0 || (metric(page.uniqueInlinks) && page.uniqueInlinks > 0))) {
      add({ rule: 'internal_redirect_opportunity', category: 'redirects', signature: outcome.signature, section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: 1, cap: 'low',
        title: 'Link directly to a final destination', summary: 'A single-hop redirect has observed incoming internal links or a nonzero native internal-inlink metric.',
        remediation: 'When practical, update internal links to the final destination while keeping useful redirects for external links and old bookmarks.',
        evidence: { destination: bounded(outcome.destination), maxHops: 1, uniqueLinkingPages: knownIncoming.get(page.id)?.size ?? null } }, [page.id]);
    }
  }
  // A group may contain different chain lengths; expose the maximum, not the first row's length.
  for (const candidate of candidates.values()) if (candidate.category === 'redirects') {
    let maxHops = 0;
    for (const id of candidate.ids) maxHops = Math.max(maxHops, outcomes.get(id)?.hops ?? 0);
    reserveCandidateBytes(Math.max(0, String(maxHops).length - String(candidate.evidence.maxHops).length));
    candidate.evidence.maxHops = maxHops;
  }

  let missingCanonicalTargets = 0;
  let unknownCanonicalTargetData = 0;
  for (const page of canonicalPages) {
    if (page.canonicalConflict === true) {
      add({ rule: 'conflicting_canonical_declarations', category: 'canonicals', signature: 'conflicting', section: scoped(page), kind: 'failure', confidence: 'observed', severity: 4,
        title: 'Resolve conflicting canonical declarations', summary: 'The native multiple-conflicting-canonical filter explicitly identifies this page. The extracted single target value does not contain every declaration.',
        remediation: 'Inspect the HTML declarations and HTTP headers, choose the intended canonical URL, and ensure all declarations agree.',
        evidence: { nativeConflictingCanonicalFilter: true, completeDeclarationsExtracted: false } }, [page.id]);
    } else if (page.canonicalCount !== null && page.canonicalCount > 1) {
      add({ rule: 'multiple_canonical_declarations', category: 'canonicals', signature: 'multiple', section: scoped(page), kind: 'opportunity', confidence: 'review', severity: 2, cap: 'medium',
        title: 'Review multiple canonical declarations', summary: 'The observed canonical count exceeds one. The count alone does not establish whether the declarations contain distinct or conflicting targets.',
        remediation: 'Inspect the declarations and HTTP headers. Remove redundant declarations and ensure any distinct targets agree on the intended canonical URL.',
        evidence: { minimumCanonicalCount: 2, distinctTargetsKnown: false, templateCause: 'A shared template cause is a hypothesis.' } }, [page.id]);
    }
    if (page.indexability === 'non-indexable' && /\bnoindex\b/i.test(page.indexabilityReason ?? '')) {
      add({ rule: 'noindex_information', category: 'canonicals', signature: 'noindex', section: scoped(page), kind: 'information', confidence: 'observed', severity: 0,
        title: 'Observed noindex pages', summary: 'Noindex alone is informational. Whether exclusion is intended requires knowledge of the site’s purpose.',
        remediation: 'Confirm these pages are intended to stay out of search results. Keep intentional exclusions; change the directive only when the pages should be eligible for indexing.',
        evidence: { directive: 'noindex', intentKnown: false } }, [page.id]);
    }
    if (page.canonical === null || page.canonical.trim() === '') continue;
    const targetUrl = reference(page.canonical, page.url);
    if (targetUrl === null) {
      add({ rule: 'invalid_canonical_target', category: 'canonicals', signature: page.canonical, section: scoped(page), kind: 'failure', confidence: 'observed', severity: 3,
        title: 'Correct an invalid canonical target', summary: 'The extracted canonical target cannot be resolved as an HTTP or HTTPS URL.',
        remediation: 'Replace the declaration with the intended valid canonical URL and verify the rendered declaration and any HTTP header agree.', evidence: { canonical: bounded(page.canonical) } }, [page.id]);
      continue;
    }
    const target = lookup(page.canonical, page.url);
    if (!target) { missingCanonicalTargets++; continue; }
    if (target.statusCode === null || target.indexability === 'unknown') unknownCanonicalTargetData++;
    if (failed(target)) {
      add({ rule: 'canonical_target_failing', category: 'canonicals', signature: target.url, section: scoped(page), kind: 'failure', confidence: target.statusCode === 403 || target.statusCode === 429 ? 'review' : 'observed', severity: 4,
        title: 'Point canonicals to a successful target', summary: 'Observed canonical declarations reference a target with a failing HTTP response.',
        remediation: 'Restore the intended target or change the shared declaration to the correct successful canonical URL, then verify all affected declarations.', evidence: { destination: bounded(target.url), targetPageId: target.id, targetStatus: target.statusCode } }, [page.id]);
    } else if (redirect(target)) {
      add({ rule: 'canonical_target_redirect', category: 'canonicals', signature: target.url, section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: 3, cap: 'medium',
        title: 'Use the final canonical destination', summary: 'Observed canonical declarations point to a redirecting target.',
        remediation: 'Confirm the intended final canonical URL and point declarations directly to that successful destination.', evidence: { destination: bounded(target.url), targetPageId: target.id, targetStatus: target.statusCode } }, [page.id]);
    } else if (analysisReady && target.id !== page.id && target.indexability === 'non-indexable') {
      add({ rule: 'canonical_target_non_indexable', category: 'canonicals', signature: target.url, section: scoped(page), kind: 'failure', confidence: 'observed', severity: 4,
        title: 'Review a non-indexable canonical target', summary: 'The completed native analysis classifies the observed canonical target as non-indexable.',
        remediation: 'Confirm the preferred page should be indexable. Resolve the target’s exclusion or change declarations to the intended indexable canonical URL.', evidence: { destination: bounded(target.url), targetPageId: target.id, targetIndexability: target.indexability, targetReason: bounded(target.indexabilityReason ?? 'Native reason unavailable') } }, [page.id]);
    }
  }

  const members = pages.filter(page => page.inSitemap === true);
  for (const page of members) {
    if (failed(page)) {
      add({ rule: 'sitemap_failing_url', category: 'sitemaps', signature: `${page.statusCode}`, section: scoped(page), kind: 'failure', confidence: page.statusCode === 403 || page.statusCode === 429 ? 'review' : 'observed', severity: 4,
        title: 'Remove failing URLs from the sitemap', summary: 'Observed sitemap members return a failing HTTP response.',
        remediation: 'Restore URLs that belong in search, or remove obsolete entries from the sitemap generator and publish a current sitemap.', evidence: { sitemapMembershipObserved: true, statusCode: page.statusCode } }, [page.id]);
    } else if (redirect(page)) {
      add({ rule: 'sitemap_redirect_url', category: 'sitemaps', signature: 'redirect', section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: 3, cap: 'medium',
        title: 'List final URLs in the sitemap', summary: 'Observed sitemap members redirect to another URL.',
        remediation: 'Update the sitemap generator to emit the intended successful canonical URL directly.', evidence: { sitemapMembershipObserved: true } }, [page.id]);
    } else if (analysisReady && success(page) && page.indexability === 'non-indexable') {
      add({ rule: 'sitemap_non_indexable_url', category: 'sitemaps', signature: page.indexabilityReason ?? 'unknown-reason', section: scoped(page), kind: 'failure', confidence: 'observed', severity: 4,
        title: 'Resolve non-indexable sitemap entries', summary: 'Observed sitemap membership conflicts with the completed native non-indexable classification.',
        remediation: 'Remove intentionally excluded pages from the sitemap. If a page should be indexed, fix its exclusion and ensure the sitemap points to its preferred URL.', evidence: { sitemapMembershipObserved: true, indexabilityReason: bounded(page.indexabilityReason ?? 'Native reason unavailable') } }, [page.id]);
    }
  }

  const eligible = htmlPages.filter(page => page.indexability === 'indexable');
  const metadataFields = [
    { field: 'title', count: 'titleCount', label: 'title', severity: 2 },
    { field: 'description', count: 'descriptionCount', label: 'meta description', severity: 1 },
    { field: 'h1', count: 'h1Count', label: 'H1 heading', severity: 1 },
  ] as const;
  for (const metadata of metadataFields) {
    const duplicateGroups = new Map<string, PageRow[]>();
    for (const page of eligible) {
      const value = page[metadata.field];
      if (value === null) continue;
      const signature = value.trim().replace(/\s+/gu, ' ');
      if (signature === '') {
        add({ rule: `metadata_missing_${metadata.field}`, category: 'metadata', signature: 'missing', section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: metadata.severity, cap: 'medium',
          title: `Add a missing ${metadata.label}`, summary: `An eligible successful indexable HTML page has an observed empty ${metadata.label}. This is an optimization opportunity, not proof of an indexing failure.`,
          remediation: `Add a useful ${metadata.label} that describes the page. Review a shared template as a possible cause and verify the content fits each affected page.`, evidence: { field: metadata.field, observedValue: '', templateCause: 'A shared template cause is a hypothesis.' } }, [page.id]);
      } else {
        const group = duplicateGroups.get(signature);
        if (group) group.push(page); else duplicateGroups.set(signature, [page]);
      }
      const count = page[metadata.count];
      if (count !== null && count > 1) {
        add({ rule: `metadata_multiple_${metadata.field}`, category: 'metadata', signature: 'multiple', section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: metadata.severity, cap: 'medium',
          title: `Review multiple ${metadata.label} elements`, summary: `The observed ${metadata.label} element count exceeds one. Multiple headings can be intentional; review the page structure before changing it.`,
          remediation: metadata.field === 'h1' ? 'Review whether the heading structure clearly identifies the page topic; keep intentional headings that serve the content.' : `Review the output and use the intended ${metadata.label} consistently in the page’s head.`, evidence: { field: metadata.field, minimumElementCount: 2 } }, [page.id]);
      }
    }
    for (const [signature, group] of duplicateGroups) if (group.length > 1) for (const page of group) {
      add({ rule: `metadata_duplicate_${metadata.field}`, category: 'metadata', signature, section: scoped(page), kind: 'opportunity', confidence: 'observed', severity: metadata.severity, cap: 'medium',
        title: `Review repeated ${metadata.label} text`, summary: `Multiple eligible pages share the same whitespace-normalized ${metadata.label}. Repetition can be intentional; confirm the pages’ purposes before editing.`,
        remediation: `Use page-specific ${metadata.label} text when the pages serve distinct purposes. For intentionally equivalent pages, review the preferred canonical strategy. Shared template causes remain hypotheses.`, evidence: { field: metadata.field, duplicateValue: bounded(signature), duplicatePagesAcrossSections: group.length, templateCause: 'A shared template cause is a hypothesis.' } }, [page.id]);
    }
  }

  const coverage: Coverage[] = [];
  const recordCoverage = (category: Category, observed: boolean, gaps: string[], scopedReason: string): void => {
    coverage.push({ category, state: !observed ? 'unassessed' : gaps.length ? 'partial' : 'assessed', reason: bounded(`${scopedReason}${gaps.length ? ` Gaps: ${gaps.join(' ')}` : ''}`) });
  };
  recordCoverage('broken_links', knownStatuses > 0 || pages.length === 0, [
    ...(knownStatuses < pages.length ? [`${pages.length - knownStatuses} URL response statuses are unknown.`] : []),
    ...(!linksAvailable ? ['Internal link evidence was not extracted; linking-page reach is unknown. Extract internal inlinks to assess shared link fixes.'] : []),
    ...(missingLinkSource ? [`${missingLinkSource} internal-link records have sources not in the snapshot.`] : []),
    ...(missingLinkTarget ? [`${missingLinkTarget} internal-link records have targets not in the snapshot; destination status is unknown.`] : []),
  ], 'HTTP failures are assessed only for extracted Internal-tab URLs; broken links require observed source and destination evidence. Native Internal-tab membership includes configured aliases and subdomains.');
  recordCoverage('redirects', knownStatuses > 0 || pages.length === 0, [
    ...(knownStatuses < pages.length ? ['Some response statuses are unknown.'] : []),
    ...(unknownRedirects ? [`${unknownRedirects} redirect paths have missing targets or unknown target statuses; extract the complete chain to assess them.`] : []),
    ...(!linksAvailable && redirects.some(page => !metric(page.uniqueInlinks)) ? ['Internal redirect-link opportunities are incomplete because internal links and some inlink metrics are unavailable.'] : []),
  ], 'Chains and loops use observed redirect targets; redirects without an observed complete path remain unassessed.');
  recordCoverage('canonicals', canonicalPages.some(page => page.canonical !== null || page.canonicalCount !== null || page.canonicalConflict === true || page.canonicalConflict === false) || (pages.length > 0 && unknownContent === 0 && canonicalPages.length === 0), [
    ...(unknownContent ? ['Some successful HTML eligibility or response data is unknown.'] : []),
    ...(canonicalPages.some(page => page.canonical === null || page.canonicalCount === null) ? ['Some canonical values or declaration counts were not extracted.'] : []),
    ...(missingCanonicalTargets ? [`${missingCanonicalTargets} canonical targets are not in the extracted snapshot; their response and indexability cannot be assessed.`] : []),
    ...(unknownCanonicalTargetData ? [`${unknownCanonicalTargetData} referenced targets have unknown response or indexability data.`] : []),
    ...(canonicalPages.some(page => page.canonicalCount !== null && page.canonicalCount > 1 && page.canonicalConflict !== true && page.canonicalConflict !== false) ? ['Some pages have multiple declarations but explicit conflicting-target evidence is unavailable; review their full declarations.'] : []),
    ...(!analysisReady ? ['Native post-crawl analysis is not confirmed complete; target-indexability checks are unassessed. Run or finish native analysis.'] : []),
    ...(canonicalPages.some(page => page.indexability === 'unknown') ? ['Some indexability values are unknown.'] : []),
  ], 'Canonical declarations are assessed on successful observed HTML pages and other successful URLs with observed canonical fields. Multiple declarations require review because count alone cannot establish distinct conflicting targets.');
  recordCoverage('sitemaps', pages.some(page => page.inSitemap !== null), [
    ...(pages.some(page => page.inSitemap === null) ? ['Sitemap membership is unknown for some extracted URLs. Enable sitemap crawling and extract membership; absence of data is not absence from a sitemap.'] : []),
    ...(members.some(page => page.statusCode === null) ? ['Some observed sitemap members have unknown response status.'] : []),
    ...(!analysisReady ? ['Native analysis is not confirmed complete; non-indexable sitemap checks are unassessed. Finish native analysis.'] : []),
    ...(members.some(page => page.indexability === 'unknown') ? ['Some observed sitemap members have unknown indexability.'] : []),
  ], 'Sitemap checks cover observed membership among extracted URLs; URLs outside the snapshot and sitemap discovery completeness are not inferred.');
  recordCoverage('metadata', eligible.some(page => metadataFields.some(metadata => page[metadata.field] !== null)) || (pages.length > 0 && eligible.length === 0 && unknownContent === 0 && htmlPages.every(page => page.indexability !== 'unknown')), [
    ...(!analysisReady && htmlPages.some(page => page.indexability === 'unknown') ? ['Native analysis is not confirmed complete and some indexability eligibility is unknown. Finish native analysis.'] : []),
    ...(unknownContent || htmlPages.some(page => page.indexability === 'unknown') ? ['Some HTML or indexability eligibility is unknown.'] : []),
    ...(eligible.some(page => metadataFields.some(metadata => page[metadata.field] === null || page[metadata.count] === null)) ? ['Some title, description, H1 values or element counts are unavailable; null values are not treated as missing elements.'] : []),
  ], 'Metadata opportunities cover successful, indexable, observed HTML pages. Empty strings are observed missing values; repetition and multiple H1 headings require editorial review.');

  const result: AuditResult = { schemaVersion: 1, id: context.id, sourceCrawlId: context.sourceCrawlId, createdAt: context.createdAt, siteUrl: context.siteUrl, pageCount: pages.length, findings: [], coverage, provenance: { preset: context.preset, pluginVersion: VERSION, snapshotHash: context.snapshotHash, source: context.source } };
  const reserveFindingBytes = aggregationBudget('finding');
  reserveFindingBytes(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  const findings = result.findings;
  for (const candidate of candidates.values()) {
    const ids = [...candidate.ids].sort((a, b) => a - b);
    const affected = ids.map(id => pages[id]!);
    const inlinkPages = affected.filter(page => metric(page.uniqueInlinks));
    const trafficPages = affected.filter(page => metric(page.searchClicks));
    const inlinkTotal = inlinkPages.length === affected.length ? inlinkPages.reduce((sum, page) => sum + page.uniqueInlinks!, 0) : null;
    const searchClicks = trafficPages.length === affected.length ? trafficPages.reduce((sum, page) => sum + page.searchClicks!, 0) : null;
    const confidence = candidate.confidence === 'observed' ? 1 : 0.75;
    const reach = Math.min(2, Math.log10(ids.length + 1));
    const importance = inlinkTotal === null ? 0 : Math.min(2, Math.log10(inlinkTotal + 1) / 2);
    const traffic = searchClicks === null ? 0 : Math.min(1, Math.log10(searchClicks + 1) / 3);
    const score = Number((candidate.severity * confidence + reach + importance + traffic).toFixed(3));
    let priority: Priority = candidate.kind === 'information' ? 'info' : score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
    if (candidate.cap === 'low' && priority !== 'info') priority = 'low';
    if (candidate.cap === 'medium' && priority === 'high') priority = 'medium';
    const evidence: Finding['evidence'] = { ...candidate.evidence, severity: candidate.severity, confidenceMultiplier: confidence, affectedPageReach: ids.length, inlinkMetricPages: inlinkPages.length, searchMetricPages: trafficPages.length, priorityScore: score };
    if (candidate.rule === 'broken_internal_destination') evidence.uniqueLinkingPages = ids.length;
    const finding: Finding = { id: `finding_${digest(JSON.stringify([candidate.rule, candidate.signature, candidate.section]))}`, rule: candidate.rule, category: candidate.category, priority, kind: candidate.kind, confidence: candidate.confidence, title: candidate.title, summary: bounded(candidate.summary), remediation: bounded(candidate.remediation), section: candidate.section, affectedIds: ids, affectedCount: ids.length, evidence,
      priorityReason: bounded(`Severity ${candidate.severity}; ${candidate.confidence} evidence multiplier ${confidence}; ${ids.length} affected ${candidate.rule === 'broken_internal_destination' ? 'linking pages' : 'URLs'}; reach contribution ${reach.toFixed(3)}. Internal-inlink importance ${inlinkTotal === null ? 'unknown (no boost)' : `${inlinkTotal} total, contribution ${importance.toFixed(3)}`}. Search Console clicks ${searchClicks === null ? 'unknown (no boost)' : `${searchClicks} total, contribution ${traffic.toFixed(3)}`}. Score ${score}; priority ${priority}${candidate.cap ? ` capped at ${candidate.cap} for this opportunity` : ''}. Counts and priorities are computed; cause hypotheses require review.`), inlinkTotal, searchClicks };
    reserveFindingBytes(Buffer.byteLength(JSON.stringify(finding), 'utf8') + (findings.length ? 1 : 0));
    findings.push(finding);
  }
  findings.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || Number(b.evidence.priorityScore) - Number(a.evidence.priorityScore) || compare(a.rule, b.rule) || compare(a.section, b.section) || compare(a.id, b.id));
  return result;
}
