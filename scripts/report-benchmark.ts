import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sampleFixture } from '../sample/fixture.js';
import { renderReport } from '../src/report.js';
import type { Finding, Priority, Category } from '../src/types.js';

const { result, pages } = sampleFixture(100_000);
const categories: Category[] = ['broken_links', 'redirects', 'canonicals', 'sitemaps', 'metadata'];
const priorities: Priority[] = ['high', 'medium', 'low', 'info'];
result.findings = Array.from({ length: 2_000 }, (_, group): Finding => ({
  id: `synthetic-benchmark-${group}`, rule: 'synthetic_benchmark', category: categories[group % categories.length]!, priority: priorities[group % priorities.length]!,
  kind: group % 3 === 0 ? 'opportunity' : 'failure', confidence: 'observed', title: `Synthetic shared fix ${group + 1}`, summary: 'Synthetic benchmark evidence only.', remediation: 'Review the bundled demonstration URLs.',
  section: `/section-${group % 12}/`, affectedIds: Array.from({ length: 50 }, (_, offset) => group * 50 + offset), affectedCount: 50,
  evidence: { synthetic: true, grouping: 'Benchmark group', pageReach: 50 }, priorityReason: 'Synthetic benchmark priority, not a live SEO recommendation.', inlinkTotal: null, searchClicks: null,
}));
const started = performance.now();
const output = await renderReport(result, pages, { siteName: '100,000 URL benchmark', clientName: 'Synthetic performance dataset' });
const renderMs = performance.now() - started;
const byId = new Map(pages.map(page => [page.id, page]));
const filterTimes: number[] = []; const pageTimes: number[] = [];
for (let run = 0; run < 100; run++) {
  const begin = performance.now();
  const filtered = result.findings.filter(finding => finding.priority === priorities[run % priorities.length] && finding.category === categories[run % categories.length]);
  const visible = filtered.slice(0, 20); filterTimes.push(performance.now() - begin);
  const startPage = performance.now();
  for (const finding of visible) finding.affectedIds.slice(0, 50).map(id => byId.get(id));
  pageTimes.push(performance.now() - startPage);
}
const percentile = (values: number[]): number => Number(values.slice().sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!.toFixed(3));
const directory = fileURLToPath(new URL('../artifacts/benchmarks/', import.meta.url));
await mkdir(directory, { recursive: true });
const stem = `report-100000-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
const reportPath = `${directory}${stem}.html`;
await writeFile(reportPath, output.html, { flag: 'wx' });
const metrics = { synthetic: true, urls: pages.length, findings: result.findings.length, htmlBytes: Buffer.byteLength(output.html), findingsCsvBytes: Buffer.byteLength(output.findingsCsv), urlsCsvBytes: Buffer.byteLength(output.urlsCsv), renderMs: Number(renderMs.toFixed(1)), filterP95Ms: percentile(filterTimes), selectedRowLookupP95Ms: percentile(pageTimes), maximumFindingRowsInDom: 20, maximumAffectedUrlRowsInDom: 50, rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)), reportPath, measurementScope: 'Node generation and in-memory filtering/indexed lookup; browser load and interaction require separate verification.' };
await writeFile(`${directory}${stem}.json`, JSON.stringify(metrics, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
