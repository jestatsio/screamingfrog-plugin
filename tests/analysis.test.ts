import { describe, expect, test } from 'vitest';
import { analyzeAudit } from '../src/analysis.js';
import { MAX_DATASET_BYTES, MAX_URLS, type LinkRow, type PageRow } from '../src/types.js';

function page(id: number, fields: Partial<PageRow> = {}): PageRow {
  return { id, url: `https://example.com/products/${id}`, section: '/products/', statusCode: 200, contentType: 'text/html', indexability: 'indexable', indexabilityReason: null, canonical: `https://example.com/products/${id}`, canonicalCount: 1, title: `Product ${id}`, titleCount: 1, description: `Description ${id}`, descriptionCount: 1, h1: `Heading ${id}`, h1Count: 1, uniqueInlinks: null, searchClicks: null, inSitemap: false, redirectTarget: null, ...fields };
}
const context = { id: 'audit', sourceCrawlId: 'crawl', createdAt: '2026-09-29T00:00:00Z', siteUrl: 'https://example.com/', preset: 'technical-audit-v1', snapshotHash: 'snapshot', source: 'fixture' as const, linksAvailable: true, analysisReady: true };

describe('deterministic evidence-backed audit analysis', () => {
  test('hundreds of broken links reduce to one shared destination fix with exact linking-page reach', () => {
    const pages = Array.from({ length: 201 }, (_, id) => page(id));
    pages[200] = page(200, { statusCode: 404, indexability: 'non-indexable', indexabilityReason: 'Client Error' });
    const links = pages.slice(0, 200).map(source => ({ source: source.url, target: pages[200]!.url }));
    const audit = analyzeAudit(pages, [...links, links[0]!], context);
    const finding = audit.findings.find(f => f.rule === 'broken_internal_destination')!;
    expect(finding.affectedIds).toEqual(Array.from({ length: 200 }, (_, id) => id));
    expect(finding.affectedCount).toBe(200);
    expect(finding.evidence.destination).toBe(pages[200]!.url);
    expect(finding.evidence.uniqueLinkingPages).toBe(200);
    expect(audit.findings.filter(f => f.rule === 'broken_internal_destination')).toHaveLength(1);
    expect(finding.priority).toBe('high');
    expect(finding.remediation).toMatch(/shared|destination/);
  });

  test('never invents linking-page reach or zero traffic when evidence is unavailable', () => {
    const audit = analyzeAudit([page(0, { statusCode: 404 })], [], { ...context, linksAvailable: false });
    expect(audit.coverage.find(c => c.category === 'broken_links')?.state).toBe('partial');
    expect(audit.coverage.find(c => c.category === 'broken_links')?.reason).toMatch(/linking|link evidence/);
    const finding = audit.findings.find(f => f.rule === 'failing_crawled_url')!;
    expect(finding.affectedIds).toEqual([0]);
    expect(finding.evidence.uniqueLinkingPages).toBeNull();
    expect(finding.inlinkTotal).toBeNull();
    expect(finding.searchClicks).toBeNull();
    expect(finding.priorityReason).toMatch(/unknown/);
  });

  test('native internal membership includes configured aliases, and absolute native URL matching stays exact', () => {
    const pages = [page(0), page(1, { url: 'https://alias.example.com/missing', statusCode: 404 })];
    const audit = analyzeAudit(pages, [{ source: pages[0]!.url, target: pages[1]!.url }, { source: pages[0]!.url, target: 'https://alias.example.com/a/../missing' }], context);
    expect(audit.findings.find(f => f.rule === 'broken_internal_destination')?.affectedIds).toEqual([0]);
    expect(audit.coverage.find(c => c.category === 'broken_links')?.state).toBe('partial');
    expect(audit.coverage.find(c => c.category === 'broken_links')?.reason).toMatch(/1 internal-link records have targets not in the snapshot/);
  });

  test('detects chains, loops, and lower-priority redirects with known incoming links', () => {
    const pages = [
      page(0, { statusCode: 301, redirectTarget: 'https://example.com/products/1', uniqueInlinks: 3 }),
      page(1, { statusCode: 302, redirectTarget: 'https://example.com/products/2', uniqueInlinks: 2 }),
      page(2),
      page(3, { statusCode: 301, redirectTarget: 'https://example.com/products/4' }),
      page(4, { statusCode: 301, redirectTarget: 'https://example.com/products/3' }),
    ];
    const audit = analyzeAudit(pages, [], context);
    expect(audit.findings.find(f => f.rule === 'redirect_chain')?.affectedIds).toEqual([0]);
    expect(audit.findings.find(f => f.rule === 'redirect_chain')?.evidence.maxHops).toBe(2);
    expect(audit.findings.find(f => f.rule === 'redirect_loop')?.affectedIds).toEqual([3, 4]);
    expect(audit.findings.find(f => f.rule === 'redirect_loop')?.priority).toBe('high');
    expect(audit.findings.find(f => f.rule === 'internal_redirect_opportunity')?.priority).toBe('low');
  });

  test('marks unknown fields and unfinished native analysis as visible gaps', () => {
    const audit = analyzeAudit([page(0, { statusCode: null, contentType: null, canonical: null, canonicalCount: null, title: null, description: null, h1: null, inSitemap: null, indexability: 'unknown' })], [], { ...context, analysisReady: false, linksAvailable: false });
    expect(audit.findings).toEqual([]);
    expect(audit.coverage.map(c => c.state)).toEqual(['unassessed', 'unassessed', 'unassessed', 'unassessed', 'unassessed']);
    expect(audit.coverage.find(c => c.category === 'metadata')?.reason).toMatch(/analysis|indexability/);
  });

  test('noindex alone is information and does not create metadata failures', () => {
    const audit = analyzeAudit([page(0, { indexability: 'non-indexable', indexabilityReason: 'Noindex', title: '', description: '', h1: '' })], [], context);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]).toMatchObject({ rule: 'noindex_information', kind: 'information', priority: 'info', affectedCount: 1 });
  });

  test('canonical targets use observed destination evidence and count alone does not assert distinct declarations', () => {
    const pages = [page(0, { canonical: 'https://example.com/products/2', canonicalCount: 2 }), page(1, { canonical: 'https://example.com/not-crawled' }), page(2, { statusCode: 404, indexability: 'non-indexable', indexabilityReason: 'Client Error' })];
    const audit = analyzeAudit(pages, [], context);
    expect(audit.findings.find(f => f.rule === 'canonical_target_failing')?.affectedIds).toEqual([0]);
    expect(audit.findings.find(f => f.rule === 'canonical_target_failing')?.evidence.targetStatus).toBe(404);
    expect(audit.findings.find(f => f.rule === 'multiple_canonical_declarations')?.confidence).toBe('review');
    expect(audit.findings.find(f => f.rule === 'multiple_canonical_declarations')?.kind).toBe('opportunity');
    expect(audit.findings.find(f => f.rule === 'multiple_canonical_declarations')?.summary).toMatch(/distinct|conflict/);
    expect(audit.coverage.find(c => c.category === 'canonicals')?.state).toBe('partial');
    expect(audit.coverage.find(c => c.category === 'canonicals')?.reason).toMatch(/not.*snapshot|not.*extracted/);
  });

  test('explicit native conflicting canonical evidence is a failure and does not depend on a guessed count', () => {
    const finding = analyzeAudit([page(0, { canonicalCount: null, canonicalConflict: true })], [], context).findings[0]!;
    expect(finding).toMatchObject({ rule: 'conflicting_canonical_declarations', confidence: 'observed', kind: 'failure', affectedIds: [0] });
    expect(finding.evidence.nativeConflictingCanonicalFilter).toBe(true);
  });

  test('unfinished native analysis does not suppress independently observed metadata or status checks', () => {
    const pages = [page(0, { title: '' }), page(1, { inSitemap: true, indexability: 'non-indexable', indexabilityReason: 'Noindex' }), page(2, { inSitemap: true, statusCode: 404 })];
    const audit = analyzeAudit(pages, [], { ...context, analysisReady: false });
    expect(audit.findings.find(f => f.rule === 'metadata_missing_title')?.affectedIds).toEqual([0]);
    expect(audit.findings.find(f => f.rule === 'sitemap_failing_url')?.affectedIds).toEqual([2]);
    expect(audit.findings.some(f => f.rule === 'sitemap_non_indexable_url')).toBe(false);
    expect(audit.coverage.find(c => c.category === 'sitemaps')?.reason).toMatch(/Finish native analysis/);
  });

  test('redirecting to a failing URL is a failure, and incomplete paths stay unassessed', () => {
    const pages = [page(0, { statusCode: 301, redirectTarget: 'https://example.com/products/1', uniqueInlinks: 5 }), page(1, { statusCode: 404 }), page(2, { statusCode: 302, redirectTarget: 'https://example.com/unseen' })];
    const audit = analyzeAudit(pages, [], context);
    expect(audit.findings.find(f => f.rule === 'redirect_target_failing')?.affectedIds).toEqual([0]);
    expect(audit.findings.some(f => f.rule === 'internal_redirect_opportunity')).toBe(false);
    expect(audit.coverage.find(c => c.category === 'redirects')?.state).toBe('partial');
    expect(audit.coverage.find(c => c.category === 'redirects')?.reason).toMatch(/missing targets/);
  });

  test('sitemap membership must be observed, and noindex in a sitemap is a signal conflict', () => {
    const pages = [page(0, { inSitemap: true, statusCode: 404 }), page(1, { inSitemap: true, indexability: 'non-indexable', indexabilityReason: 'Noindex' }), page(2, { inSitemap: null, statusCode: 404 })];
    const audit = analyzeAudit(pages, [], context);
    expect(audit.findings.find(f => f.rule === 'sitemap_failing_url')?.affectedIds).toEqual([0]);
    expect(audit.findings.find(f => f.rule === 'sitemap_non_indexable_url')?.affectedIds).toEqual([1]);
    expect(audit.findings.filter(f => f.category === 'sitemaps').flatMap(f => f.affectedIds)).not.toContain(2);
    expect(audit.coverage.find(c => c.category === 'sitemaps')?.state).toBe('partial');
  });

  test('groups observed missing and duplicate metadata as opportunities, excluding unknown or non-HTML fields', () => {
    const pages = [page(0, { title: '', description: 'Shared description' }), page(1, { description: 'Shared description', h1: '' }), page(2, { title: null, description: null, h1: null }), page(3, { contentType: 'application/pdf', title: '', description: '', h1: '' })];
    const audit = analyzeAudit(pages, [], context);
    expect(audit.findings.find(f => f.rule === 'metadata_missing_title')?.affectedIds).toEqual([0]);
    expect(audit.findings.find(f => f.rule === 'metadata_duplicate_description')?.affectedIds).toEqual([0, 1]);
    expect(audit.findings.filter(f => f.category === 'metadata').every(f => f.kind === 'opportunity')).toBe(true);
    expect(audit.findings.filter(f => f.category === 'metadata').flatMap(f => f.affectedIds)).not.toContain(2);
    expect(audit.findings.filter(f => f.category === 'metadata').flatMap(f => f.affectedIds)).not.toContain(3);
    expect(audit.coverage.find(c => c.category === 'metadata')?.state).toBe('partial');
  });

  test('metadata reach and traffic never turn an opportunity into a high-priority definite failure', () => {
    const pages = Array.from({ length: 100 }, (_, id) => page(id, { title: '', uniqueInlinks: 10_000, searchClicks: 10_000 }));
    const finding = analyzeAudit(pages, [], context).findings.find(f => f.rule === 'metadata_missing_title')!;
    expect(finding.priority).toBe('medium');
    expect(finding.kind).toBe('opportunity');
    expect(finding.inlinkTotal).toBe(1_000_000);
    expect(finding.searchClicks).toBe(1_000_000);
    const partial = analyzeAudit([page(0, { title: '', searchClicks: 8 }), page(1, { title: '', searchClicks: null })], [], context).findings.find(f => f.rule === 'metadata_missing_title')!;
    expect(partial.searchClicks).toBeNull();
    expect(partial.evidence.searchMetricPages).toBe(1);
  });

  test('finding IDs and ordering are stable across link order and repeated runs, and evidence remains bounded', () => {
    const longTitle = `Same ${'x'.repeat(10_000)}`;
    const pages = [page(0, { title: longTitle }), page(1, { title: longTitle }), page(2, { statusCode: 500 })];
    const links = [{ source: pages[0]!.url, target: pages[2]!.url }, { source: pages[1]!.url, target: pages[2]!.url }];
    const first = analyzeAudit(pages, links, context);
    expect(analyzeAudit(pages, [...links].reverse(), context)).toEqual(first);
    expect(analyzeAudit(pages, links, { ...context, id: 'another-audit', createdAt: 'later' }).findings.map(f => f.id)).toEqual(first.findings.map(f => f.id));
    expect(first.findings.every(f => Object.values(f.evidence).every(value => typeof value !== 'string' || value.length <= 2_000))).toBe(true);
    expect(first.findings.every(f => f.affectedCount === new Set(f.affectedIds).size)).toBe(true);
  });

  test('rejects oversize and inconsistent snapshots rather than sampling', () => {
    expect(() => analyzeAudit(Array.from({ length: MAX_URLS + 1 }, (_, id) => page(id)), [], context)).toThrow('100,000');
    expect(() => analyzeAudit([page(1)], [], context)).toThrow(/sequential/);
    expect(() => analyzeAudit([page(0), page(1, { url: page(0).url })], [], context)).toThrow(/unique/);
  });

  test('rejects candidate expansion from bounded long-URL evidence before retaining every shared fix', () => {
    const sources = Array.from({ length: 100 }, (_, id) => {
      const section = `/section-${id}-${'x'.repeat(4_000)}/`;
      return page(id, { url: `https://example.com${section}page`, section, canonical: null });
    });
    const targets = Array.from({ length: 200 }, (_, index) => page(sources.length + index, { statusCode: 404 }));
    const pages = [...sources, ...targets];
    const links = sources.flatMap(source => targets.map(target => ({ source: source.url, target: target.url })));
    const linkBytes = links.reduce((bytes, link, index) => bytes + Buffer.byteLength(JSON.stringify(link), 'utf8') + (index ? 1 : 0), 2);
    expect(Buffer.byteLength(JSON.stringify(pages), 'utf8')).toBeLessThan(MAX_DATASET_BYTES);
    expect(linkBytes).toBeLessThan(MAX_DATASET_BYTES);
    expect(() => analyzeAudit(pages, links, context)).toThrow(/candidate aggregation exceeds the 128 MiB dataset budget.*will not be sampled/);
  }, 15_000);

  test('rejects expanded finding output even when short-URL source datasets fit comfortably within the budget', () => {
    const sources = Array.from({ length: 500 }, (_, id) => page(id, { url: `https://e.test/s-${id}/page`, section: `/s-${id}/`, canonical: null }));
    const targets = Array.from({ length: 220 }, (_, index) => page(sources.length + index, { url: `https://e.test/missing/${index}`, statusCode: 404 }));
    const pages = [...sources, ...targets];
    const links: LinkRow[] = sources.flatMap(source => targets.map(target => ({ source: source.url, target: target.url })));
    const linkBytes = links.reduce((bytes, link, index) => bytes + Buffer.byteLength(JSON.stringify(link), 'utf8') + (index ? 1 : 0), 2);
    expect(Buffer.byteLength(JSON.stringify(pages), 'utf8')).toBeLessThan(1_000_000);
    expect(linkBytes).toBeLessThan(10_000_000);
    expect(() => analyzeAudit(pages, links, context)).toThrow(/finding aggregation exceeds the 128 MiB dataset budget.*will not be sampled/);
  }, 15_000);

  test('processes a 100,000-URL redirect loop without recursive traversal or truncated reach', () => {
    const pages = Array.from({ length: MAX_URLS }, (_, id) => page(id, { statusCode: 301, redirectTarget: `https://example.com/products/${(id + 1) % MAX_URLS}` }));
    const audit = analyzeAudit(pages, [], context);
    const finding = audit.findings.find(f => f.rule === 'redirect_loop')!;
    expect(audit.pageCount).toBe(MAX_URLS);
    expect(finding.affectedCount).toBe(MAX_URLS);
    expect(finding.affectedIds[0]).toBe(0);
    expect(finding.affectedIds[MAX_URLS - 1]).toBe(MAX_URLS - 1);
    expect(finding.evidence.maxHops).toBe(MAX_URLS);
  }, 15_000);
});
