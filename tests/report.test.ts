import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test, vi } from 'vitest';
import { assertReportDatasetBudget, renderReport } from '../src/report.js';
import { sampleFixture } from '../sample/fixture.js';
import type { ReportPayload } from '../src/report-browser.js';

function unpack(html: string): ReportPayload {
  const payload = html.match(/const dataset="([A-Za-z0-9+/=]+)";/)?.[1];
  if (!payload) throw new Error('Missing gzip dataset');
  return JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString('utf8')) as ReportPayload;
}
function scriptAndStyle(html: string): { script: string; style: string } {
  return { script: html.match(/<script id="report-script">([\s\S]*?)<\/script>/)![1]!, style: html.match(/<style>([\s\S]*?)<\/style>/)![1]! };
}
describe('offline evidence report', () => {
  test('embeds the complete dataset and preserves computed facts under commentary', async () => {
    const { result, pages } = sampleFixture(120);
    const narrative = { executiveSummary: 'My interpretation says 99,999 fixes. Computed facts remain independent.', findings: [{ findingId: result.findings[0]!.id, commentary: 'An assistant interpretation.' }] };
    const { html, findingsCsv, urlsCsv } = await renderReport(result, pages, { clientName: 'Example Client', siteName: 'Example site', narrative });
    const data = unpack(html); expect(data.result).toEqual(result); expect(data.pages).toEqual(pages); expect(data.options.narrative).toEqual(narrative);
    expect(html).toContain('id="summary-page-count">120</div>'); expect(html).toContain('id="summary-finding-count">6</div>');
    expect(html).toContain('Assistant commentary'); expect(html).toContain('SYNTHETIC SAMPLE');
    expect(findingsCsv.split('\r\n')).toHaveLength(result.findings.length + 2);
    expect(urlsCsv.split('\r\n')).toHaveLength(pages.length + 2);
    expect(findingsCsv).toContain('"Unique inlinks","Search clicks"');
  });
  test('rejects count, identity, and evidence reconciliation failures', async () => {
    const { result, pages } = sampleFixture(120);
    await expect(renderReport({ ...result, pageCount: 121 }, pages)).rejects.toThrow('reconcile');
    const duplicate = pages.slice(); duplicate[1] = { ...duplicate[1]!, id: 0 };
    await expect(renderReport(result, duplicate)).rejects.toThrow('unique');
    const countMismatch = structuredClone(result); countMismatch.findings[0]!.affectedCount++;
    await expect(renderReport(countMismatch, pages)).rejects.toThrow('reconcile');
    const unknown = structuredClone(result); unknown.findings[0]!.affectedIds[0] = 999;
    await expect(renderReport(unknown, pages)).rejects.toThrow('reconcile');
    const duplicateEvidence = structuredClone(result); duplicateEvidence.findings[0]!.affectedIds[0] = duplicateEvidence.findings[0]!.affectedIds[1]!;
    await expect(renderReport(duplicateEvidence, pages)).rejects.toThrow('reconcile');
    const duplicateFinding = structuredClone(result); duplicateFinding.findings.push(duplicateFinding.findings[0]!);
    await expect(renderReport(duplicateFinding, pages)).rejects.toThrow('unique');
  });
  test('rejects narrative references that cannot be tied to a computed finding', async () => {
    const { result, pages } = sampleFixture(120);
    await expect(renderReport(result, pages, { narrative: { findings: [{ findingId: 'made-up', commentary: 'Invented finding' }] } })).rejects.toThrow('unknown finding');
    const comment = { findingId: result.findings[0]!.id, commentary: 'Duplicate' };
    await expect(renderReport(result, pages, { narrative: { findings: [comment, comment] } })).rejects.toThrow('repeats');
  });
  test('preserves the engine priority order rather than re-ranking by affected count', async () => {
    const { result, pages } = sampleFixture(120);
    result.findings = [result.findings[2]!, result.findings[0]!];
    expect(result.findings[0]!.affectedCount).toBeLessThan(result.findings[1]!.affectedCount);
    const { html } = await renderReport(result, pages);
    expect(unpack(html).result.findings.map(finding => finding.id)).toEqual(result.findings.map(finding => finding.id));
    expect(scriptAndStyle(html).script).toMatch(/const findings\s*=\s*result\.findings\.slice\(\);/);
  });
  test('keeps malicious and unusual text out of executable HTML and URL attributes', async () => {
    const { result, pages } = sampleFixture(120);
    const hostile = '</script><img src=x onerror=alert(1)><svg onload=alert(2)>';
    pages[0]!.url = 'javascript:alert("日本語")'; pages[0]!.title = hostile;
    result.findings[0]!.title = hostile; result.findings[0]!.evidence['__proto__'] = hostile;
    const { html } = await renderReport(result, pages, { clientName: hostile, siteName: '日本語 & "unusual"', narrative: { executiveSummary: hostile } });
    expect(html).not.toContain(hostile); expect(html).not.toContain('href="javascript:'); expect(html).not.toMatch(/<img\s/i);
    expect(html).toContain('&lt;/script&gt;&lt;img'); expect(unpack(html).pages[0]!.url).toBe(pages[0]!.url);
    expect(unpack(html).result.findings[0]!.title).toBe(hostile);
    const { script } = scriptAndStyle(html); expect(script).not.toContain('innerHTML'); expect(script).not.toContain('insertAdjacentHTML');
  });
  test('contains only local assets with strict hashes and no outbound requests', async () => {
    const { result, pages } = sampleFixture(120); const { html } = await renderReport(result, pages);
    const { script, style } = scriptAndStyle(html);
    for (const value of [script, style]) expect(html).toContain(createHash('sha256').update(value).digest('base64'));
    expect(html).toContain("connect-src &#39;none&#39;"); expect(html).not.toContain("&#39;unsafe-inline&#39;");
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/i);
    expect(style).not.toMatch(/@import|url\(/i); expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
    expect(html).toContain('findingsPerPage = 20'); expect(html).toContain('urlsPerPage = 50');
  });
  test('quotes unusual CSV values and neutralizes formula injection', async () => {
    const { result, pages } = sampleFixture(120);
    pages[0]!.title = ' =HYPERLINK("https://evil.test","click")'; pages[1]!.url = '\t@malicious'; pages[2]!.title = 'two,"quoted"\nlines';
    result.findings[0]!.title = '+SUM(1,2)'; result.findings[0]!.evidence['test'] = '日本語';
    const { findingsCsv, urlsCsv } = await renderReport(result, pages);
    expect(findingsCsv).toContain('"\'+SUM(1,2)"'); expect(urlsCsv).toContain('"\' =HYPERLINK(""https://evil.test"",""click"")"');
    expect(urlsCsv).toContain('"\'\t@malicious"'); expect(urlsCsv).toContain('"two,""quoted""\nlines"'); expect(findingsCsv).toContain('日本語');
  });
  test('makes missing data visible without manufacturing zero traffic', async () => {
    const { result, pages } = sampleFixture(120); result.findings = [];
    const { html } = await renderReport(result, pages);
    expect(html).toContain('No findings were identified in the checks assessed'); expect(html).toContain('Check crawl coverage');
    expect(html).toContain('Sample sitemap membership is included'); expect(html).toContain('id="summary-gap-count">1</div>');
    expect(unpack(html).pages.every(page => page.searchClicks === null)).toBe(true);
  });
  test('rejects an oversized crawl rather than silently sampling', async () => {
    const { result, pages } = sampleFixture(120);
    await expect(renderReport({ ...result, pageCount: 100_001 }, pages)).rejects.toThrow('100,000');
  });
  test('counts exact UTF-8 payload bytes including narrative, coverage, provenance, commas, and escaping', () => {
    const { result, pages } = sampleFixture(120); pages[0]!.title = '日本語\n"quoted"\u0000';
    const payload: ReportPayload = { result, pages, options: { clientName: '日本語', narrative: { executiveSummary: 'Interpretation & \"quoted\" text', findings: [{ findingId: result.findings[0]!.id, commentary: 'Evidence commentary' }] } } };
    const actual = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    expect(assertReportDatasetBudget(payload, actual)).toBe(actual);
    expect(() => assertReportDatasetBudget(payload, actual - 1)).toThrow('uncompressed limit');
    expect(() => assertReportDatasetBudget(payload, actual - 1)).toThrow('no data was sampled');
  });
  test('rejects an aggregate overflow before reading subsequent rows or serializing the whole dataset', () => {
    const { result, pages } = sampleFixture(120); result.findings = []; result.coverage = [];
    const first = { ...pages[0]!, title: 'x'.repeat(2_048) }; const later = { ...pages[1]! };
    const readLater = vi.fn(() => { throw new Error('A later row should not be serialized.'); }); Object.defineProperty(later, 'title', { enumerable: true, get: readLater });
    const payload: ReportPayload = { result, pages: [first, later], options: {} };
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ result: { ...result, findings: [] }, pages: [], options: {} }), 'utf8');
    const limit = envelopeBytes + Buffer.byteLength(JSON.stringify(first), 'utf8') - 1;
    expect(() => assertReportDatasetBudget(payload, limit)).toThrow('uncompressed limit'); expect(readLater).not.toHaveBeenCalled();
  });
});
