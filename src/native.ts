import type { NativeClient, NativeCrawl, NativePage, NativeProgress, NativeSession, NativeSessionFactory, NativeTool } from './native-contract.js';
import { VERSION } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_NATIVE_ENDPOINT = 'http://127.0.0.1:11435/mcp';
export const MAX_NATIVE_PAGE = 1_000;
export const MAX_NATIVE_TOOLS = 256;
export const MAX_NATIVE_TOOL_NAME = 128;
export const MAX_NATIVE_DISCOVERY_NAMES = 1_024;
export const MAX_NATIVE_DISCOVERY_NAME = 512;
export const MAX_NATIVE_CRAWL_ID = 512;
export const MAX_DISPLAY_CRAWL_NAME = 256;
export const MAX_DISPLAY_CRAWL_URL = 2_048;
export const MAX_DISPLAY_TIMESTAMP = 128;
export const MAX_DIAGNOSTIC_MESSAGE = 2_000;
export const TRUNCATION_MARKER = '… [truncated]';
/** Observed verbatim while a licensed 24.3 Spider transitions into a new crawl. */
export const NATIVE_BUSY_MESSAGE = 'Tool error: IllegalStateException: Tool cannot be called currently. Please check the state of the Spider';
const MAX_NATIVE_SCHEMA_LENGTH = 65_536;
export type NativeErrorCode = 'UNAVAILABLE' | 'UNSUPPORTED' | 'TOOL_ERROR' | 'INVALID_RESPONSE' | 'INVALID_ENDPOINT';

export class NativeError extends Error {
  constructor(public readonly code: NativeErrorCode, message: string, options?: ErrorOptions) {
    super(boundDisplayText(message, MAX_DIAGNOSTIC_MESSAGE), options);
    this.name = 'NativeError';
  }
}

const ALLOWED_TOOLS = new Set([
  'sf_list_crawls', 'sf_load_crawl', 'sf_crawl', 'sf_pause_crawl', 'sf_resume_crawl', 'sf_crawl_progress',
  'sf_export_seo_element_urls', 'sf_list_available_filters_for_seo_element',
  'sf_list_available_data_fields_for_seo_element_and_filter', 'sf_list_available_reports',
  'sf_list_available_bulk_exports', 'sf_generate_report', 'sf_generate_bulk_export',
]);
const TEXT_DISCOVERY_TOOLS = new Set([
  'sf_list_available_filters_for_seo_element', 'sf_list_available_data_fields_for_seo_element_and_filter',
  'sf_list_available_reports', 'sf_list_available_bulk_exports',
]);
const RETRYABLE_BUSY_QUERIES = new Set([
  ...TEXT_DISCOVERY_TOOLS, 'sf_list_crawls', 'sf_crawl_progress', 'sf_export_seo_element_urls',
  'sf_generate_report', 'sf_generate_bulk_export',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only explicit aliases are accepted. The native documentation does not promise a progress output schema.
 * A missing, contradictory, or differently typed field stays unknown, even when percentages equal 100.
 */
function explicitValue<T>(value: Record<string, unknown>, aliases: string[], accepts: (input: unknown) => input is T): T | null {
  const present = aliases.filter(alias => Object.hasOwn(value, alias)).map(alias => value[alias]);
  if (present.length === 0 || present.some(item => !accepts(item))) return null;
  return present.every(item => item === present[0]) ? present[0] as T : null;
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isNonemptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Optional display text may be shortened; operational identifiers must remain exact. */
export function boundDisplayText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

export function requireBoundedCrawlId(id: string): string {
  if (!isNonemptyString(id) || id.length > MAX_NATIVE_CRAWL_ID) throw new NativeError('INVALID_RESPONSE', `Native crawl ID must be a nonempty exact identifier of at most ${MAX_NATIVE_CRAWL_ID} characters. Oversized IDs are rejected rather than truncated.`);
  return id;
}

export function boundedToolNames(tools: NativeTool[]): string[] {
  if (!Array.isArray(tools) || tools.length > MAX_NATIVE_TOOLS) throw new NativeError('INVALID_RESPONSE', `Native discovery exceeds the ${MAX_NATIVE_TOOLS}-tool limit.`);
  return tools.map(tool => {
    if (!isNonemptyString(tool.name) || tool.name.length > MAX_NATIVE_TOOL_NAME) throw new NativeError('INVALID_RESPONSE', `Native tool names must be nonempty exact identifiers of at most ${MAX_NATIVE_TOOL_NAME} characters.`);
    return tool.name;
  });
}

function optionalDisplay(value: string | null, maxLength: number): string | null {
  return value === null ? null : boundDisplayText(value, maxLength);
}

export function normalizeProgress(raw: unknown): NativeProgress {
  const top = record(raw) ?? {};
  const source = record(top.progress) ?? top;
  const idAliases = ['crawl_id', 'crawlId', 'Crawl ID', 'databaseId', 'database_id'];
  for (const alias of idAliases) {
    if (typeof source[alias] === 'string' && source[alias].length > MAX_NATIVE_CRAWL_ID) requireBoundedCrawlId(source[alias]);
  }
  return {
    crawlId: explicitValue(source, idAliases, isNonemptyString),
    crawlComplete: explicitValue(source, ['crawl_complete', 'crawlComplete', 'crawl_finished', 'crawlFinished'], isBoolean),
    analysisComplete: explicitValue(source, ['analysis_complete', 'analysisComplete', 'crawl_analysis_complete', 'crawlAnalysisComplete'], isBoolean),
    apisComplete: explicitValue(source, ['apis_complete', 'apisComplete', 'api_complete', 'apiComplete'], isBoolean),
    paused: explicitValue(source, ['paused', 'is_paused', 'isPaused'], isBoolean),
    totalUrls: explicitValue(source, ['total_urls', 'totalUrls', 'url_count', 'urlCount'], isCount),
    raw,
  };
}

export function validateNativeEndpoint(input: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(input); } catch { throw new NativeError('INVALID_ENDPOINT', 'Native endpoint must be an HTTP loopback URL ending in /mcp.'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') {
    throw new NativeError('INVALID_ENDPOINT', 'Native endpoint must use http://localhost, http://127.0.0.1, or http://[::1], with /mcp and no credentials or query.');
  }
  // Resolve the documented localhost spelling to a literal address, avoiding a DNS lookup.
  if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  return endpoint;
}

/** Redirects, cookies, and URL credentials are forbidden on every transport request. */
export function nativeFetch(endpoint: URL, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (requested.href !== endpoint.href) throw new NativeError('INVALID_ENDPOINT', 'Native transport attempted to leave its configured loopback endpoint.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (headers.has('authorization') || headers.has('cookie')) throw new NativeError('INVALID_ENDPOINT', 'Native requests must not include credentials.');
    return fetcher(input, { ...init, headers, redirect: 'error', credentials: 'omit' });
  };
}

/** Decode only MCP text/structured output. No file path returned by a native tool is ever followed. */
function toolValue(raw: unknown, preserveDiscoveryNames = false): unknown {
  const result = record(raw);
  if (!result) return raw;
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content.map(block => record(block)?.text).filter(value => typeof value === 'string').join('\n') : 'Native tool returned an error.';
    throw new NativeError('TOOL_ERROR', String(text));
  }
  if (Object.hasOwn(result, 'structuredContent')) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const blocks = result.content.map(block => record(block));
    if (blocks.some(block => !block || block.type !== 'text' || typeof block.text !== 'string')) {
      throw new NativeError('INVALID_RESPONSE', 'Expected text data from the native tool.');
    }
    if (preserveDiscoveryNames) {
      if (blocks.length > MAX_NATIVE_DISCOVERY_NAMES) throw new NativeError('INVALID_RESPONSE', `Native discovery exceeds the ${MAX_NATIVE_DISCOVERY_NAMES}-name limit.`);
      const names = blocks.map(block => block!.text as string);
      if (names.length === 1) {
        const name = names[0]!;
        try { return JSON.parse(name) as unknown; }
        catch {
          if (['[', '{', '"'].includes(name.trimStart()[0] ?? '')) throw new NativeError('INVALID_RESPONSE', 'Native discovery returned malformed JSON rather than an exact operation name.');
        }
      }
      return names;
    }
    const text = blocks.map(block => block!.text as string).join('\n').trim();
    if (text === '') return '';
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }
  return raw;
}

function rejectPartialExport(input: unknown): void {
  const value = record(input);
  if (!value) return;
  // These are explicit envelope flags, not guesses based on output length.
  if (value.truncated === true || value.is_truncated === true || value.partial === true || value.incomplete === true) {
    throw new NativeError('INVALID_RESPONSE', 'Native export explicitly reports incomplete or truncated data; no snapshot was accepted.');
  }
  if (Object.hasOwn(value, 'error')) throw new NativeError('INVALID_RESPONSE', 'Native export returned an error envelope.');
}

function decodeNativeRows(input: unknown, keys = ['rows', 'data', 'result', 'ndjson']): { rows: Record<string, unknown>[]; envelopes: Record<string, unknown>[] } {
  let data = input;
  const envelopes: Record<string, unknown>[] = [];
  for (let depth = 0; ; depth++) {
    if (depth >= 12) throw new NativeError('INVALID_RESPONSE', 'Native export envelopes are nested too deeply.');
    rejectPartialExport(data);
    if (typeof data === 'string') {
      const text = data.trim();
      if (text === '') return { rows: [], envelopes };
      try { data = JSON.parse(text) as unknown; } catch {
        try { data = text.split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown); }
        catch { throw new NativeError('INVALID_RESPONSE', 'Native export is not valid JSON or NDJSON; no snapshot was accepted.'); }
      }
      continue;
    }
    const object = record(data);
    const key = object && keys.find(candidate => Object.hasOwn(object, candidate));
    if (object) envelopes.push(object);
    if (!key || !object) break;
    data = object[key];
  }
  const rows = Array.isArray(data) ? data : record(data) ? [data] : null;
  if (!rows || rows.some(row => !record(row))) throw new NativeError('INVALID_RESPONSE', 'Native export must contain JSON object rows.');
  return { rows: rows as Record<string, unknown>[], envelopes };
}

export function parseNativeRows(input: unknown): Record<string, unknown>[] {
  return decodeNativeRows(input).rows;
}

function discoveryItems(input: unknown, keys: string[]): unknown[] {
  let data = input;
  for (let depth = 0; depth < 12; depth++) {
    rejectPartialExport(data);
    if (Array.isArray(data)) {
      if (data.length > MAX_NATIVE_DISCOVERY_NAMES) throw new NativeError('INVALID_RESPONSE', `Native discovery exceeds the ${MAX_NATIVE_DISCOVERY_NAMES}-name limit.`);
      return data;
    }
    if (typeof data === 'string') {
      try { data = JSON.parse(data) as unknown; } catch { throw new NativeError('INVALID_RESPONSE', 'Native discovery must return exact text blocks or a JSON list.'); }
      continue;
    }
    const object = record(data);
    const key = object && keys.find(candidate => Object.hasOwn(object, candidate));
    if (!object || !key) break;
    data = object[key];
  }
  throw new NativeError('INVALID_RESPONSE', 'Native discovery did not return a bounded list.');
}

function exactDiscoveryName(value: unknown): string {
  if (!isNonemptyString(value) || value.length > MAX_NATIVE_DISCOVERY_NAME) throw new NativeError('INVALID_RESPONSE', `Native discovery names must be nonempty exact operation names of at most ${MAX_NATIVE_DISCOVERY_NAME} characters.`);
  return value;
}

function stringList(input: unknown, keys: string[]): string[] {
  const names = discoveryItems(input, keys).map(item => exactDiscoveryName(typeof item === 'string'
    ? item : explicitValue(record(item) ?? {}, ['name', 'categoryName'], isNonemptyString)));
  return [...new Set(names as string[])];
}

function singleFileBulkExports(input: unknown): string[] {
  const items = discoveryItems(input, ['bulk_exports', 'exports', 'data', 'result']);
  const categories = new Map<string, 'SINGLE_FILE' | 'MULTI_FILE'>();
  for (const item of items) {
    const metadata = record(item);
    if (!metadata || metadata.type !== 'SINGLE_FILE' && metadata.type !== 'MULTI_FILE') throw new NativeError('INVALID_RESPONSE', 'Native bulk export discovery must provide an explicit SINGLE_FILE or MULTI_FILE category type.');
    const name = exactDiscoveryName(explicitValue(metadata, ['name', 'categoryName'], isNonemptyString));
    if (categories.has(name) && categories.get(name) !== metadata.type) throw new NativeError('INVALID_RESPONSE', 'Native bulk export discovery contains conflicting category types.');
    categories.set(name, metadata.type);
  }
  return [...categories].filter(([, type]) => type === 'SINGLE_FILE').map(([name]) => name);
}

const COMPOSED_SCHEMA_KEYS = ['anyOf', 'oneOf', 'allOf', 'not', '$ref', 'if', 'then', 'else'];
const JSON_SCHEMA_TYPES = new Set(['string', 'integer', 'number', 'array', 'boolean', 'object', 'null']);

function rejectComposedSchema(schema: Record<string, unknown>, label: string): void {
  if (COMPOSED_SCHEMA_KEYS.some(key => Object.hasOwn(schema, key))) {
    throw new NativeError('UNSUPPORTED', `Native ${label} advertises a composed schema that this adapter cannot safely validate. Run the compatibility probe for this application version.`);
  }
}

function matchesNativeType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'array': return Array.isArray(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return record(value) !== null;
    case 'null': return value === null;
    default: return false;
  }
}

function checkArgs(tool: NativeTool, args: Record<string, unknown>): void {
  const schema = tool.inputSchema;
  rejectComposedSchema(schema, tool.name);
  const properties = record(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string' || !Object.hasOwn(args, key)) {
      throw new NativeError('UNSUPPORTED', `Native ${tool.name} requires an unsupported parameter: ${String(key)}. Run the compatibility probe for this application version.`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = record(properties[key]);
    if (!property) throw new NativeError('UNSUPPORTED', `Native ${tool.name} does not advertise parameter ${key}.`);
    rejectComposedSchema(property, `${tool.name} parameter ${key}`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new NativeError('UNSUPPORTED', `Native ${tool.name} does not support the requested ${key}.`);
    const types = Array.isArray(property.type) ? property.type : [property.type];
    if (types.length === 0 || types.some(type => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type))) {
      throw new NativeError('UNSUPPORTED', `Native ${tool.name} advertises an unsupported type schema for ${key}.`);
    }
    const valid = types.some(type => matchesNativeType(type as string, value));
    if (!valid) throw new NativeError('UNSUPPORTED', `Native ${tool.name} advertises an incompatible type for ${key}.`);
  }
}

export class ScreamingFrogNative implements NativeClient {
  readonly endpoint: string;
  private readonly url: URL;
  private session: NativeSession | null = null;
  private tools: Map<string, NativeTool> = new Map();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(endpoint = DEFAULT_NATIVE_ENDPOINT, private readonly sessionFactory: NativeSessionFactory = createSdkSession) {
    this.url = validateNativeEndpoint(endpoint);
    this.endpoint = this.url.href;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  connect(): Promise<void> {
    return this.serialize(async () => { await this.ensureSession(); });
  }

  private async ensureSession(): Promise<NativeSession> {
    if (!this.session) {
      try { this.session = await this.sessionFactory(this.url); }
      catch (error) { throw new NativeError('UNAVAILABLE', 'Cannot connect to Screaming Frog. Open the licensed SEO Spider in database storage mode and start its MCP server under File > Settings > MCP Server.', { cause: error }); }
      try { await this.readTools(); } catch (error) { await this.session.close().catch(() => undefined); this.session = null; throw error; }
    }
    return this.session;
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      const session = this.session;
      this.session = null;
      this.tools.clear();
      await session?.close();
    });
  }

  private async readTools(): Promise<NativeTool[]> {
    if (!this.session) throw new NativeError('UNAVAILABLE', 'Native session is not connected.');
    const tools: NativeTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.session.listTools(cursor);
      if (!Array.isArray(page.tools)) throw new NativeError('INVALID_RESPONSE', 'Native tools/list did not return tool schemas.');
      if (tools.length + page.tools.length > MAX_NATIVE_TOOLS) throw new NativeError('INVALID_RESPONSE', `Native discovery exceeds the ${MAX_NATIVE_TOOLS}-tool limit.`);
      boundedToolNames(page.tools);
      for (const tool of page.tools) {
        if (!isNonemptyString(tool.name) || !record(tool.inputSchema)) throw new NativeError('INVALID_RESPONSE', 'Native tools/list contained an invalid schema.');
        if (tools.some(existing => existing.name === tool.name)) throw new NativeError('INVALID_RESPONSE', 'Native tools/list returned duplicate tool names.');
        let serializedSchema: string;
        try { serializedSchema = JSON.stringify(tool.inputSchema); }
        catch { throw new NativeError('INVALID_RESPONSE', 'Native tool schema is not serializable JSON.'); }
        if (serializedSchema.length > MAX_NATIVE_SCHEMA_LENGTH) throw new NativeError('INVALID_RESPONSE', `Native tool schema exceeds the ${MAX_NATIVE_SCHEMA_LENGTH}-character compatibility limit.`);
        tools.push({ name: tool.name, inputSchema: tool.inputSchema,
          ...(typeof tool.description === 'string' ? { description: boundDisplayText(tool.description, MAX_DISPLAY_CRAWL_NAME) } : {}),
        });
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (!isNonemptyString(cursor) || cursor.length > MAX_NATIVE_CRAWL_ID || cursors.has(cursor) || cursors.size >= 100) throw new NativeError('INVALID_RESPONSE', 'Native tools/list pagination did not advance within supported bounds.');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    return tools;
  }

  discoverTools(): Promise<NativeTool[]> {
    return this.serialize(async () => { await this.ensureSession(); return [...this.tools.values()]; });
  }

  private invoke(name: string, args: Record<string, unknown>, requireParameters: string[] = []): Promise<unknown> {
    return this.serialize(async () => {
      if (!ALLOWED_TOOLS.has(name)) throw new NativeError('UNSUPPORTED', 'This native tool is outside the audit interface.');
      const session = await this.ensureSession();
      const tool = this.tools.get(name);
      if (!tool) throw new NativeError('UNSUPPORTED', `Native ${name} is unavailable. Run the compatibility probe and check the installed SEO Spider version.`);
      const properties = record(tool.inputSchema.properties) ?? {};
      for (const parameter of requireParameters) {
        if (!record(properties[parameter])) throw new NativeError('UNSUPPORTED', `Native ${name} must support ${parameter} for safe bounded extraction.`);
      }
      const requested = { ...args };
      if (Object.hasOwn(properties, 'export_type')) requested.export_type = 'NDJSON';
      checkArgs(tool, requested);
      try {
        for (let attempt = 0; ; attempt++) {
          try { return toolValue(await session.callTool(name, requested), TEXT_DISCOVERY_TOOLS.has(name)); }
          catch (error) {
            if (attempt >= 5 || !RETRYABLE_BUSY_QUERIES.has(name) || !(error instanceof NativeError) || error.code !== 'TOOL_ERROR' || error.message !== NATIVE_BUSY_MESSAGE) throw error;
            await delay(100);
          }
        }
      }
      catch (error) {
        if (error instanceof NativeError) throw error;
        // Transport failures can have occurred after a mutation was accepted. Callers reconcile before retrying.
        await this.session?.close().catch(() => undefined);
        this.session = null;
        this.tools.clear();
        throw new NativeError('UNAVAILABLE', `Native ${name} was interrupted. Reconcile crawl identity before retrying any launch or load.`, { cause: error });
      }
    });
  }

  async status(): Promise<NativeProgress> {
    return normalizeProgress(await this.invoke('sf_crawl_progress', {}));
  }

  async listCrawls(limit = 10): Promise<NativeCrawl[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new NativeError('UNSUPPORTED', 'Crawl list limit must be between 1 and 100.');
    let raw: unknown;
    try { raw = await this.invoke('sf_list_crawls', { limit }); }
    catch (error) {
      // Observed verbatim on a fresh licensed 24.3 installation. Other tool/transport failures remain errors.
      if (error instanceof NativeError && error.code === 'TOOL_ERROR'
        && error.message === 'Tool error: IOException: No crawls are available on the SEO Spider') return [];
      throw error;
    }
    const rows = decodeNativeRows(raw, ['crawls', 'jobs', 'rows', 'data', 'result']).rows;
    if (rows.length > limit) throw new NativeError('INVALID_RESPONSE', 'Native crawl list exceeded its requested limit.');
    return rows.map(row => {
      const id = explicitValue(row, ['crawl_id', 'crawlId', 'id', 'Crawl ID', 'instanceDirName', 'databaseId', 'database_id'], isNonemptyString);
      if (id === null) throw new NativeError('INVALID_RESPONSE', 'Native crawl list lacks an unambiguous database crawl ID.');
      const timeAliases = ['started_at', 'startedAt', 'created_at', 'createdAt', 'time'];
      const timeValues = timeAliases.filter(alias => Object.hasOwn(row, alias)).map(alias => row[alias]);
      if (timeValues.length > 1 && timeValues.some(value => value !== timeValues[0])) throw new NativeError('INVALID_RESPONSE', 'Native crawl list contains contradictory timestamp aliases.');
      return {
        id: requireBoundedCrawlId(id),
        name: optionalDisplay(explicitValue(row, ['crawl_name', 'crawlName', 'name'], isNonemptyString), MAX_DISPLAY_CRAWL_NAME),
        url: optionalDisplay(explicitValue(row, ['crawl_url', 'crawlUrl', 'url', 'start_url', 'startUrl'], isNonemptyString), MAX_DISPLAY_CRAWL_URL),
        startedAt: optionalDisplay(explicitValue(row, timeAliases, isNonemptyString), MAX_DISPLAY_TIMESTAMP),
        raw: row,
      };
    });
  }

  loadCrawl(id: string): Promise<unknown> {
    if (!isNonemptyString(id) || id.length > MAX_NATIVE_CRAWL_ID) return Promise.reject(new NativeError('UNSUPPORTED', `A nonempty database crawl ID of at most ${MAX_NATIVE_CRAWL_ID} characters is required.`));
    return this.invoke('sf_load_crawl', { crawl_id: id });
  }

  startCrawl(url: string, configPath?: string, name?: string): Promise<unknown> {
    let target: URL;
    try { target = new URL(url); } catch { return Promise.reject(new NativeError('UNSUPPORTED', 'Crawl URL must be an absolute HTTP or HTTPS URL.')); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return Promise.reject(new NativeError('UNSUPPORTED', 'Crawl URL must be HTTP or HTTPS without credentials.'));
    const args: Record<string, unknown> = { crawl_url: target.href };
    if (configPath !== undefined) {
      if (!isNonemptyString(configPath)) return Promise.reject(new NativeError('UNSUPPORTED', 'Configuration path must not be empty.'));
      args.config_path = configPath;
    }
    if (name !== undefined) {
      if (!isNonemptyString(name)) return Promise.reject(new NativeError('UNSUPPORTED', 'Crawl name must not be empty.'));
      args.crawl_name = name;
    }
    return this.invoke('sf_crawl', args);
  }

  control(action: 'pause' | 'resume'): Promise<unknown> {
    if (!['pause', 'resume'].includes(action)) return Promise.reject(new NativeError('UNSUPPORTED', 'Only pause and resume are supported.'));
    return this.invoke(action === 'pause' ? 'sf_pause_crawl' : 'sf_resume_crawl', {});
  }

  async exportPage(element: string, filter: string, fields: string[], start: number, max: number): Promise<NativePage> {
    if (!isNonemptyString(element) || !isNonemptyString(filter) || fields.length === 0 || fields.some(field => !isNonemptyString(field))) throw new NativeError('UNSUPPORTED', 'Explicit element, filter, and selected fields are required.');
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(max) || max < 1 || max > MAX_NATIVE_PAGE) throw new NativeError('UNSUPPORTED', `Native export pages must contain 1 to ${MAX_NATIVE_PAGE} rows with a nonnegative start index.`);
    let raw: unknown;
    try {
      raw = await this.invoke('sf_export_seo_element_urls', {
        seo_element_name: element, filter_name: filter, data_fields: fields, start_index: start, max_rows: max,
      }, ['data_fields', 'start_index', 'max_rows']);
    } catch (error) {
      // Licensed 24.3 rejects the exact empty terminal boundary instead of returning zero rows.
      const boundary = error instanceof NativeError && error.code === 'TOOL_ERROR'
        ? /^Tool error: IllegalArgumentException: start_index is greater than the total number of URLs of (0|[1-9]\d*)$/.exec(error.message) : null;
      if (boundary && Number(boundary[1]) === start) return { rows: [], startIndex: start, hasMore: false, raw: { terminalBoundary: true, totalRows: start } };
      throw error;
    }
    const { rows, envelopes } = decodeNativeRows(raw);
    if (rows.length > max) throw new NativeError('INVALID_RESPONSE', 'Native export exceeded its requested page size; no snapshot was accepted.');
    if (rows.some(row => !fields.some(field => Object.hasOwn(row, field)))) throw new NativeError('INVALID_RESPONSE', 'Native export rows do not contain the selected fields; no snapshot was accepted.');
    if (rows.length < max && envelopes.some(envelope => envelope.has_more === true || envelope.hasMore === true)) throw new NativeError('INVALID_RESPONSE', 'Native export returned a shortened page with more data remaining; no snapshot was accepted.');
    return { rows, startIndex: start, hasMore: rows.length === max, raw };
  }

  async availableFilters(element: string): Promise<string[]> {
    return stringList(await this.invoke('sf_list_available_filters_for_seo_element', { seo_element_name: element }), ['filters', 'data', 'result']);
  }

  async availableFields(element: string, filter: string): Promise<string[]> {
    return stringList(await this.invoke('sf_list_available_data_fields_for_seo_element_and_filter', { seo_element_name: element, filter_name: filter }), ['data_fields', 'fields', 'data', 'result']);
  }

  async availableReports(): Promise<string[]> {
    return stringList(await this.invoke('sf_list_available_reports', {}), ['reports', 'data', 'result']);
  }

  async availableBulkExports(): Promise<string[]> {
    return singleFileBulkExports(await this.invoke('sf_list_available_bulk_exports', {}));
  }

  async report(category: string, fields?: string[]): Promise<Record<string, unknown>[]> {
    return parseNativeRows(await this.invoke('sf_generate_report', { category, ...(fields ? { data_fields: fields } : {}) }));
  }

  async bulkExport(category: string, fields?: string[]): Promise<Record<string, unknown>[]> {
    exactDiscoveryName(category);
    if (!(await this.availableBulkExports()).includes(category)) throw new NativeError('UNSUPPORTED', 'Only an explicitly discovered SINGLE_FILE bulk export may be generated without native filesystem writes.');
    return parseNativeRows(await this.invoke('sf_generate_bulk_export', { category, ...(fields ? { data_fields: fields } : {}) }));
  }
}

// Defined through the installed, stable SDK below; transport initialization never launches the Spider.
async function createSdkSession(endpoint: URL): Promise<NativeSession> {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'jestats-screamingfrog-audit', version: VERSION }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nativeFetch(endpoint) });
  try { await client.connect(transport, { timeout: 10_000 }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return {
    async listTools(cursor) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
      return { tools: result.tools as NativeTool[], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    callTool(name, args) { return client.callTool({ name, arguments: args }, { timeout: 10_000 }); },
    close() { return client.close(); },
  };
}
