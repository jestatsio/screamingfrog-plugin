import { ScreamingFrogNative, NativeError, DEFAULT_NATIVE_ENDPOINT } from '../src/native.js';

/** This probe never loads, starts, pauses, resumes, exports, or alters a crawl. */
const endpoint = process.argv[2] ?? process.env.SCREAMINGFROG_MCP_URL ?? DEFAULT_NATIVE_ENDPOINT;
const output: Record<string, unknown> = {
  recordedAt: new Date().toISOString(), platform: process.platform, nodeVersion: process.version,
  readOnly: true, integrationVerified: false,
  note: 'Read-only discovery cannot verify crawl creation, loading, export pagination, analysis readiness, or recovery. Complete the licensed macOS and Windows checklist before release.',
};

try {
  const native = new ScreamingFrogNative(endpoint);
  output.endpoint = native.endpoint;
  try {
    await native.connect();
    const tools = await native.discoverTools();
    output.connected = true;
    output.tools = tools;
    const progress = await native.status().then(value => ({ ok: true, value }), error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    const crawls = await native.listCrawls(3).then(value => ({ ok: true, value }), error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    output.progress = progress;
    output.recentCrawls = crawls;
    const exportSchema = tools.find(tool => tool.name === 'sf_export_seo_element_urls')?.inputSchema;
    const properties = exportSchema?.properties as Record<string, unknown> | undefined;
    const required = Array.isArray(exportSchema?.required) ? exportSchema.required : [];
    output.schemaChecks = {
      boundedExportsAdvertised: !!properties?.start_index && !!properties?.max_rows && !!properties?.data_fields,
      unexpectedRequiredExportParameters: required.filter(key => !['seo_element_name', 'filter_name', 'data_fields', 'start_index', 'max_rows', 'export_type'].includes(String(key))),
      identityReadable: progress.ok && 'value' in progress && progress.value.crawlId !== null,
      crawlCompletionReadable: progress.ok && 'value' in progress && progress.value.crawlComplete !== null,
      analysisCompletionReadable: progress.ok && 'value' in progress && progress.value.analysisComplete !== null,
    };
  } finally {
    await native.close().catch(() => undefined);
  }
} catch (error) {
  output.connected = false;
  output.error = { code: error instanceof NativeError ? error.code : 'PROBE_ERROR', message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
