import { describe, expect, test } from 'vitest';
import { normalizePage, nativePhase, rowAddress } from '../src/extraction.js';

describe('verified native columns', () => {
  test('preserves unknown data and uses explicit missing-filter evidence', () => {
    const row = { Address: 'https://example.test/shop/a', 'Title 1': null, 'Status Code': 200, Indexability: 'Indexable' };
    expect(normalizePage(row, 0).title).toBeNull();
    const result = normalizePage(row, 0, { missingTitle: new Set([row.Address]) });
    expect(result.title).toBe(''); expect(result.titleCount).toBe(0);
    expect(result.description).toBeNull(); expect(result.inSitemap).toBeNull();
    expect(result.section).toBe('/shop/');
  });
  test('resolves relative destinations while retaining exact source URLs', () => {
    const result = normalizePage({ Address: 'https://example.test/a?q=1', 'Canonical Link Element 1': '../b', 'Redirect URL': '/c', 'Unique Inlinks': '12' }, 0);
    expect(result.url).toBe('https://example.test/a?q=1');
    expect(result.canonical).toBe('https://example.test/b'); expect(result.redirectTarget).toBe('https://example.test/c');
    expect(result.uniqueInlinks).toBe(12); expect(result.canonicalCount).toBeNull();
  });
  test('never establishes negative sitemap membership from an empty unverified export', () => {
    const row = { Address: 'https://example.test/' };
    expect(normalizePage(row, 0, { inSitemap: new Set() }).inSitemap).toBeNull();
    expect(normalizePage(row, 0, { inSitemap: new Set(), sitemapComplete: true }).inSitemap).toBe(false);
  });
  test('rejects malformed and contradictory source fields', () => {
    expect(() => rowAddress({ Address: 'https://a.test/', url: 'https://b.test/' })).toThrow('Conflicting');
    expect(() => normalizePage({ Address: 'https://a.test/', 'Status Code': 2.5 }, 0)).toThrow('integer');
    expect(() => rowAddress({ Address: 'javascript:alert(1)' })).toThrow('HTTP');
  });
  test('percentages alone do not declare completion', () => {
    expect(nativePhase({ crawlProgress: { percentComplete: 100 }, postCrawlAnalysisProgress: { percentComplete: 100 }, stateName: 'unverified' }).crawlComplete).toBeNull();
  });
  test('wrapped completion evidence and conflicting aliases stay consistent with native normalization', () => {
    expect(nativePhase({ progress: { crawlComplete: true, analysisComplete: true } })).toMatchObject({ crawlComplete: true, analysisReady: true });
    expect(nativePhase({ crawlComplete: true, crawl_complete: false, analysisComplete: true, analysis_complete: false })).toMatchObject({ crawlComplete: null, analysisReady: null });
    expect(nativePhase({ stateName: 'SpiderCrawlIdleState', crawlProgress: { active: 0, waiting: 0, completed: 13, percentComplete: 100 } })).toMatchObject({ crawlComplete: true, analysisReady: null });
    expect(nativePhase({ stateName: 'SpiderCrawlIdleState', crawlProgress: { active: 1, waiting: 0, completed: 13, percentComplete: 100 } }).crawlComplete).toBeNull();
  });
});
