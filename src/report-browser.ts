import type { AuditResult, PageRow, ReportOptions } from './types.js';

export interface ReportPayload { result: AuditResult; pages: PageRow[]; options: ReportOptions }

/** Keep this function self-contained: its source is bundled into the offline report. */
export function reportBrowserMain(compressed: string): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing report element: ${id}`);
    return value as T;
  };
  const labels: Record<string, string> = { broken_links: 'Broken links', redirects: 'Redirects', canonicals: 'Canonicals & indexability', sitemaps: 'Sitemaps', metadata: 'Metadata' };
  const format = (value: number): string => value.toLocaleString('en-US');
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const chip = (text: string, className: string): HTMLElement => make('span', text, `chip ${className}`);
  const empty = (value: string | number | boolean | null | undefined): string => value === null || value === undefined ? 'Unknown' : value === '' ? '(empty)' : String(value);
  const csvCell = (value: unknown): string => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = (rows: unknown[][]): string => rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const urlHeaders = ['ID', 'URL', 'Section', 'Status code', 'Content type', 'Indexability', 'Indexability reason', 'Canonical', 'Canonical count', 'Title', 'Title count', 'Description', 'Description count', 'H1', 'H1 count', 'In sitemap', 'Redirect target', 'Unique inlinks', 'Search clicks'];
  const urlValues = (page: PageRow): unknown[] => [page.id, page.url, page.section, page.statusCode, page.contentType, page.indexability, page.indexabilityReason, page.canonical, page.canonicalCount, page.title, page.titleCount, page.description, page.descriptionCount, page.h1, page.h1Count, page.inSitemap, page.redirectTarget, page.uniqueInlinks, page.searchClicks];
  const findingHeaders = ['Finding ID', 'Priority', 'Category', 'Kind', 'Confidence', 'Title', 'Affected URLs', 'Section', 'Summary', 'Remediation', 'Priority rationale', 'Unique inlinks', 'Search clicks', 'Evidence'];
  const findingValues = (finding: AuditResult['findings'][number]): unknown[] => [finding.id, finding.priority, finding.category, finding.kind, finding.confidence, finding.title, finding.affectedCount, finding.section, finding.summary, finding.remediation, finding.priorityReason, finding.inlinkTotal, finding.searchClicks, JSON.stringify(finding.evidence)];
  const download = (name: string, content: string): void => {
    const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }));
    const anchor = make('a'); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'finding';
  const boot = async (): Promise<void> => {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decode the offline dataset. Open this report in a current version of Chrome, Edge, Firefox, or Safari.');
    const binary = atob(compressed); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const payload = JSON.parse(await new Response(stream).text()) as ReportPayload;
    const { result, pages, options } = payload;
    const byId = new Map(pages.map(page => [page.id, page]));
    // The analysis engine owns priority and ordering. Preserve that computed
    // order even when filtering or exporting subsets of the action plan.
    const findings = result.findings.slice();
    const byFindingId = new Map(findings.map(finding => [finding.id, finding]));
    const affectedSections = new Map(findings.map(finding => [finding.id, new Set([finding.section, ...finding.affectedIds.map(id => byId.get(id)!.section)])]));
    const commentary = new Map((options.narrative?.findings ?? []).map(item => [item.findingId, item.commentary]));
    let filtered = findings; let findingPage = 0; let selectedId: string | null = null; let detailPage = 0;
    const findingsPerPage = 20; const urlsPerPage = 50;
    const priority = element<HTMLSelectElement>('priority-filter');
    const category = element<HTMLSelectElement>('category-filter');
    const section = element<HTMLSelectElement>('section-filter');
    for (const value of [...new Set(findings.flatMap(finding => [...affectedSections.get(finding.id)!]))].sort()) {
      const option = make('option', value || 'Whole site'); option.value = value; section.append(option);
    }
    const detail = element('finding-detail');
    const updateDetail = (focus = false): void => {
      const finding = selectedId === null ? undefined : byFindingId.get(selectedId);
      if (!finding) { detail.hidden = true; element('detail-placeholder').hidden = false; return; }
      detail.hidden = false; element('detail-placeholder').hidden = true;
      element('detail-title').textContent = finding.title;
      element('detail-id').textContent = finding.id;
      element('detail-summary').textContent = finding.summary;
      element('detail-remediation').textContent = finding.remediation;
      element('detail-priority-reason').textContent = finding.priorityReason;
      element('detail-section').textContent = finding.section || 'Whole site';
      element('detail-count').textContent = format(finding.affectedCount);
      element('detail-inlinks').textContent = finding.inlinkTotal === null ? 'Unknown' : format(finding.inlinkTotal);
      element('detail-clicks').textContent = finding.searchClicks === null ? 'Unknown' : format(finding.searchClicks);
      element('detail-chips').replaceChildren(chip(finding.priority === 'info' ? 'Informational' : `${finding.priority} priority`, finding.priority), chip(finding.kind, 'neutral'), chip(finding.confidence === 'observed' ? 'Observed evidence' : 'Needs review', 'neutral'));
      const evidence = element('detail-evidence'); evidence.replaceChildren();
      for (const [key, value] of Object.entries(finding.evidence)) { evidence.append(make('dt', key), make('dd', empty(value))); }
      if (!Object.keys(finding.evidence).length) evidence.append(make('dt', 'Evidence'), make('dd', 'No additional fields supplied.'));
      const note = commentary.get(finding.id);
      element('detail-commentary-wrap').hidden = !note;
      element('detail-commentary').textContent = note ?? '';
      const affected = finding.affectedIds;
      const maxPage = Math.max(0, Math.ceil(affected.length / urlsPerPage) - 1); detailPage = Math.min(detailPage, maxPage);
      const start = detailPage * urlsPerPage; const body = element('url-body'); body.replaceChildren();
      const columns: Array<{ label: string; value: (page: PageRow) => string | number | boolean | null; className?: string }> = [
        { label: 'URL', value: page => page.url, className: 'url-cell' },
        { label: 'Section', value: page => page.section || '/', className: 'section-cell' },
        { label: 'Status', value: page => page.statusCode },
      ];
      if (finding.category === 'metadata') columns.push({ label: 'Title', value: page => page.title }, { label: 'Description', value: page => page.description }, { label: 'H1', value: page => page.h1 });
      else if (finding.category === 'canonicals') columns.push({ label: 'Canonical', value: page => page.canonical }, { label: 'Declarations', value: page => page.canonicalCount }, { label: 'Indexability', value: page => page.indexability });
      else if (finding.category === 'redirects') columns.push({ label: 'Redirect target', value: page => page.redirectTarget }, { label: 'Unique inlinks', value: page => page.uniqueInlinks });
      else if (finding.category === 'sitemaps') columns.push({ label: 'In sitemap', value: page => page.inSitemap }, { label: 'Indexability', value: page => page.indexability }, { label: 'Reason', value: page => page.indexabilityReason });
      else columns.push({ label: 'Indexability', value: page => page.indexability }, { label: 'Unique inlinks', value: page => page.uniqueInlinks });
      const header = element('url-header-row'); header.replaceChildren();
      for (const column of columns) { const cell = make('th', column.label); cell.scope = 'col'; header.append(cell); }
      for (const id of affected.slice(start, start + urlsPerPage)) {
        const page = byId.get(id)!; const row = make('tr');
        for (const column of columns) row.append(make('td', empty(column.value(page)), column.className));
        body.append(row);
      }
      element('url-count').textContent = affected.length ? `${format(start + 1)}–${format(Math.min(start + urlsPerPage, affected.length))} of ${format(affected.length)} URLs` : 'No affected URLs';
      element<HTMLButtonElement>('url-prev').disabled = detailPage === 0;
      element<HTMLButtonElement>('url-next').disabled = detailPage >= maxPage;
      element<HTMLButtonElement>('export-finding').onclick = () => download(`jestats-${safeName(finding.id)}-urls.csv`, csv([urlHeaders, ...affected.map(id => urlValues(byId.get(id)!))]));
      if (focus) { element('detail-title').focus({ preventScroll: true }); detail.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    };
    const renderFindings = (): void => {
      const body = element('finding-body'); body.replaceChildren();
      const maxPage = Math.max(0, Math.ceil(filtered.length / findingsPerPage) - 1); findingPage = Math.min(findingPage, maxPage);
      const start = findingPage * findingsPerPage;
      for (const finding of filtered.slice(start, start + findingsPerPage)) {
        const row = make('tr'); if (selectedId === finding.id) row.className = 'selected';
        const priorityCell = make('td'); priorityCell.append(chip(finding.priority === 'info' ? 'Info' : finding.priority, finding.priority));
        const titleCell = make('td'); const button = make('button', finding.title, 'finding-button');
        button.type = 'button'; button.setAttribute('aria-controls', 'finding-detail'); button.setAttribute('aria-expanded', String(selectedId === finding.id));
        button.onclick = () => { selectedId = finding.id; detailPage = 0; updateDetail(true); renderFindings(); };
        titleCell.append(button, make('span', `${finding.id} · ${finding.kind}${finding.confidence === 'review' ? ' · needs review' : ''}`, 'row-subtitle'));
        row.append(priorityCell, titleCell, make('td', labels[finding.category]!), make('td', format(finding.affectedCount), 'number-cell'), make('td', finding.section || 'Whole site', 'section-cell'));
        body.append(row);
      }
      element('no-findings').hidden = filtered.length !== 0;
      element('finding-count').textContent = filtered.length ? `${format(start + 1)}–${format(Math.min(start + findingsPerPage, filtered.length))} of ${format(filtered.length)} findings` : '0 findings match these filters';
      element<HTMLButtonElement>('finding-prev').disabled = findingPage === 0;
      element<HTMLButtonElement>('finding-next').disabled = findingPage >= maxPage;
    };
    const filter = (): void => {
      filtered = findings.filter(finding => (!priority.value || finding.priority === priority.value) && (!category.value || finding.category === category.value) && (section.value === '__all__' || affectedSections.get(finding.id)!.has(section.value)));
      if (selectedId !== null && !filtered.some(finding => finding.id === selectedId)) { selectedId = null; updateDetail(); }
      findingPage = 0; renderFindings();
    };
    priority.addEventListener('change', filter); category.addEventListener('change', filter); section.addEventListener('change', filter);
    element<HTMLButtonElement>('reset-filters').onclick = () => { priority.value = ''; category.value = ''; section.value = '__all__'; filter(); };
    element<HTMLButtonElement>('finding-prev').onclick = () => { findingPage--; renderFindings(); };
    element<HTMLButtonElement>('finding-next').onclick = () => { findingPage++; renderFindings(); };
    element<HTMLButtonElement>('url-prev').onclick = () => { detailPage--; updateDetail(); };
    element<HTMLButtonElement>('url-next').onclick = () => { detailPage++; updateDetail(); };
    element<HTMLButtonElement>('close-detail').onclick = () => { selectedId = null; updateDetail(); renderFindings(); element('findings-heading').focus({ preventScroll: true }); };
    element<HTMLButtonElement>('export-findings').onclick = () => download('jestats-findings.csv', csv([findingHeaders, ...findings.map(findingValues)]));
    element<HTMLButtonElement>('export-urls').onclick = () => download('jestats-urls.csv', csv([urlHeaders, ...pages.map(urlValues)]));
    element('loading').hidden = true; element('interactive-report').hidden = false;
    element('report-status').textContent = `${format(pages.length)} URLs and ${format(findings.length)} findings loaded. This report works offline.`;
    renderFindings(); updateDetail();
    document.documentElement.dataset.reportReady = 'true';
  };
  void boot().catch(error => {
    element('loading').textContent = error instanceof Error ? error.message : 'The offline dataset could not be loaded.';
    element('loading').className = 'notice error';
    element('report-status').textContent = 'Interactive report unavailable. The computed summary and supporting CSV exports remain available.';
    document.documentElement.dataset.reportReady = 'error';
  });
}
