/** The narrow native surface used by the audit engine. Never exposes script or file tools. */
export interface NativeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface NativeProgress {
  crawlId: string | null;
  crawlComplete: boolean | null;
  analysisComplete: boolean | null;
  apisComplete: boolean | null;
  paused: boolean | null;
  totalUrls: number | null;
  /** Internal evidence only. Public MCP responses must whitelist normalized fields and omit raw. */
  raw: unknown;
}

export interface NativeCrawl {
  id: string;
  name: string | null;
  url: string | null;
  startedAt: string | null;
  /** Internal evidence only. Public MCP responses must whitelist display fields and omit raw. */
  raw: unknown;
}

export interface NativePage {
  rows: Record<string, unknown>[];
  startIndex: number;
  /** A full page requires a further request, including when the total is exactly divisible. */
  hasMore: boolean;
  raw: unknown;
}

export interface NativeClient {
  readonly endpoint: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  discoverTools(): Promise<NativeTool[]>;
  status(): Promise<NativeProgress>;
  listCrawls(limit?: number): Promise<NativeCrawl[]>;
  loadCrawl(id: string): Promise<unknown>;
  startCrawl(url: string, configPath?: string, name?: string): Promise<unknown>;
  control(action: 'pause' | 'resume'): Promise<unknown>;
  exportPage(element: string, filter: string, fields: string[], start: number, max: number): Promise<NativePage>;
  availableFilters(element: string): Promise<string[]>;
  availableFields(element: string, filter: string): Promise<string[]>;
  availableReports(): Promise<string[]>;
  availableBulkExports(): Promise<string[]>;
  report(category: string, fields?: string[]): Promise<Record<string, unknown>[]>;
  bulkExport(category: string, fields?: string[]): Promise<Record<string, unknown>[]>;
}

/** Inject this boundary for deterministic tests without a running licensed application. */
export interface NativeSession {
  listTools(cursor?: string): Promise<{ tools: NativeTool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type NativeSessionFactory = (endpoint: URL) => Promise<NativeSession>;
