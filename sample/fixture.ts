import type { AuditResult, Finding, PageRow } from '../src/types.js';

/** Demonstration data with no network access or claims about an actual site. */
export function sampleFixture(count = 1_600): { result: AuditResult; pages: PageRow[] } {
  if (!Number.isSafeInteger(count) || count < 120 || count > 100_000) throw new Error('Sample size must be between 120 and 100,000 URLs.');
  const pages: PageRow[] = Array.from({ length: count }, (_, id) => ({
    id, url: `https://example.test/${id % 3 === 0 ? 'guides' : id % 3 === 1 ? 'products' : 'support'}/page-${id}`,
    section: id % 3 === 0 ? '/guides/' : id % 3 === 1 ? '/products/' : '/support/',
    statusCode: 200, contentType: 'text/html', indexability: 'indexable', indexabilityReason: null,
    canonical: `https://example.test/page-${id}`, canonicalCount: 1,
    title: id < Math.floor(count / 2) ? 'Example help & guidance' : `Example page ${id}`, titleCount: 1,
    description: id % 5 === 0 ? '' : `A synthetic page ${id} for this sample report.`, descriptionCount: id % 5 === 0 ? 0 : 1,
    h1: `Example page ${id}`, h1Count: 1, uniqueInlinks: id % 40, searchClicks: null, inSitemap: id % 2 === 0, redirectTarget: null,
  }));
  const ids = (predicate: (id: number) => boolean): number[] => pages.filter(page => predicate(page.id)).map(page => page.id);
  const findings: Finding[] = [
    {
      id: 'broken-links-shared-support', rule: 'internal_broken_destination', category: 'broken_links', priority: 'high', kind: 'failure', confidence: 'observed',
      title: 'Repair the shared link to the retired support page', summary: 'Many pages link to the same failing destination. One shared navigation or content update could resolve the affected links; the template cause still needs confirmation.',
      remediation: 'Choose the correct replacement support destination, update all affected links, and confirm the replacement returns a successful response. Check whether a shared navigation component is responsible.',
      section: '/support/', affectedIds: ids(id => id % 3 === 2), affectedCount: 0,
      evidence: { destination: 'https://example.test/support/retired-guide', destinationStatus: 404, grouping: 'Exact destination URL', suspectedCause: 'Shared support navigation (hypothesis)' },
      priorityReason: 'Observed failing destination with broad page reach and many internal references. A shared fix can remove the failure from hundreds of pages.', inlinkTotal: null, searchClicks: null,
    },
    {
      id: 'redirects-product-chain', rule: 'redirect_chain', category: 'redirects', priority: 'medium', kind: 'failure', confidence: 'observed',
      title: 'Link directly to the final product destination', summary: 'Product links pass through a two-hop redirect chain before reaching the final destination.',
      remediation: 'Update affected internal links to the final successful URL. Preserve redirects needed for old external links, then recrawl to confirm the chain is gone.', section: '/products/',
      affectedIds: ids(id => id % 3 === 1 && id % 2 === 0), affectedCount: 0,
      evidence: { firstHop: 'https://example.test/products/old-range', secondHop: 'https://example.test/products/range', finalDestination: 'https://example.test/shop/range', redirectHops: 2 },
      priorityReason: 'Observed extra redirect hops across a substantial set of product pages. The final destination succeeds, so this follows the broken-link repair.', inlinkTotal: 240, searchClicks: null,
    },
    {
      id: 'canonical-target-failure', rule: 'canonical_target_status', category: 'canonicals', priority: 'high', kind: 'failure', confidence: 'observed',
      title: 'Replace a canonical target that returns 404', summary: 'A set of guide pages declares the same canonical destination, which returns a failing response.',
      remediation: 'Confirm the preferred indexable URL for each affected guide. Correct the canonical declarations and confirm each target resolves successfully without conflicting indexability signals.', section: '/guides/',
      affectedIds: ids(id => id % 3 === 0 && id < count / 5), affectedCount: 0,
      evidence: { canonicalTarget: 'https://example.test/guides/retired-overview', targetStatus: 404, grouping: 'Exact canonical destination' },
      priorityReason: 'Observed conflicting canonical target with a definite failing response. Confirm the preferred URLs before changing a shared canonical configuration.', inlinkTotal: 180, searchClicks: null,
    },
    {
      id: 'sitemap-nonindexable-pages', rule: 'sitemap_non_indexable', category: 'sitemaps', priority: 'medium', kind: 'failure', confidence: 'observed',
      title: 'Remove non-indexable support pages from the sitemap', summary: 'The sitemap includes support pages that are intentionally excluded from indexing. The inconsistency is in the sitemap inclusion.',
      remediation: 'Confirm the intended indexing policy, then remove intentionally non-indexable URLs from the sitemap. Keep the noindex directive if that is the intended policy.', section: '/support/',
      affectedIds: ids(id => id % 3 === 2 && id % 10 === 0), affectedCount: 0,
      evidence: { inSitemap: true, indexabilityReason: 'Noindex directive', policy: 'Noindex alone is informational; sitemap inclusion is the inconsistency' },
      priorityReason: 'Observed sitemap and indexability conflict with limited page reach. This does not imply that the noindex policy itself is wrong.', inlinkTotal: null, searchClicks: null,
    },
    {
      id: 'metadata-duplicate-title', rule: 'duplicate_title', category: 'metadata', priority: 'low', kind: 'opportunity', confidence: 'observed',
      title: 'Make the repeated help-page title more specific', summary: 'Several pages use the same title. Differentiate titles where pages serve distinct search intents; intentional duplication can be appropriate.',
      remediation: 'Review the affected pages and generate distinctive titles from meaningful page attributes. Confirm whether the shared title comes from a template before applying a site-wide change.', section: '/',
      affectedIds: ids(id => id < count / 2), affectedCount: 0,
      evidence: { title: 'Example help & guidance', grouping: 'Exact title signature', suspectedCause: 'Shared title template (hypothesis)' },
      priorityReason: 'A metadata opportunity with wide reach. It is lower priority than definite link and canonical failures; missing traffic data remains unknown.', inlinkTotal: null, searchClicks: null,
    },
    {
      id: 'metadata-missing-description', rule: 'missing_description', category: 'metadata', priority: 'low', kind: 'opportunity', confidence: 'observed',
      title: 'Add descriptions to pages where they would help users', summary: 'Some HTML pages have no meta description. This is a presentation opportunity rather than a definite indexing failure.',
      remediation: 'Prioritize pages with meaningful search intent and write concise, accurate descriptions. Avoid generic descriptions repeated across unrelated pages.', section: '/',
      affectedIds: ids(id => id % 5 === 0), affectedCount: 0, evidence: { observedDescription: 'Empty', grouping: 'Missing description signature' },
      priorityReason: 'Observed missing metadata, labeled as an opportunity. Traffic metrics are not supplied and have not been treated as zero.', inlinkTotal: null, searchClicks: null,
    },
  ];
  for (const finding of findings) finding.affectedCount = finding.affectedIds.length;
  for (const id of findings[3]!.affectedIds) {
    const page = pages[id]!; page.indexability = 'non-indexable'; page.indexabilityReason = 'Noindex'; page.inSitemap = true;
  }
  const result: AuditResult = {
    schemaVersion: 1, id: 'synthetic-demonstration', sourceCrawlId: 'synthetic-crawl', createdAt: '2026-09-29T12:00:00.000Z', siteUrl: 'https://example.test/', pageCount: pages.length, findings,
    coverage: [
      { category: 'broken_links', state: 'assessed', reason: 'Synthetic internal-link and destination evidence is included.' },
      { category: 'redirects', state: 'assessed', reason: 'Synthetic redirect chains and targets are included.' },
      { category: 'canonicals', state: 'assessed', reason: 'Synthetic canonical declarations and target statuses are included.' },
      { category: 'sitemaps', state: 'partial', reason: 'Sample sitemap membership is included; complete sitemap coverage is not represented.' },
      { category: 'metadata', state: 'assessed', reason: 'Synthetic title, description, and heading fields are included.' },
    ],
    provenance: { preset: 'technical-audit-v1', pluginVersion: '0.1.0', snapshotHash: 'synthetic-sample-not-a-native-snapshot', source: 'fixture' },
  };
  return { result, pages };
}
