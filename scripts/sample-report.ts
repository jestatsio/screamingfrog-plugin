import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sampleFixture } from '../sample/fixture.js';
import { renderReport } from '../src/report.js';

const directory = fileURLToPath(new URL('../sample/', import.meta.url));
const { result, pages } = sampleFixture();
const output = await renderReport(result, pages, {
  clientName: 'Example Client · Synthetic demonstration', siteName: 'Example & Co.',
  narrative: {
    executiveSummary: 'The sample illustrates how hundreds of affected pages can reduce to a few shared changes. Begin with the failing support link and canonical destination, then address redirect and sitemap consistency. The suspected template causes need confirmation.',
    findings: [{ findingId: 'metadata-duplicate-title', commentary: 'Review a few representative pages from each section before revising the title template. The shared wording is observed; a template cause is a hypothesis.' }],
  },
});
await mkdir(directory, { recursive: true });
await writeFile(new URL('../sample/report.html', import.meta.url), output.html);
await writeFile(new URL('../sample/findings.csv', import.meta.url), output.findingsCsv);
await writeFile(new URL('../sample/urls.csv', import.meta.url), output.urlsCsv);
process.stdout.write(JSON.stringify({ source: 'synthetic', html: `${directory}report.html`, pages: pages.length, findings: result.findings.length, htmlBytes: Buffer.byteLength(output.html) }) + '\n');
