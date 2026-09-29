export const MAX_URLS = 100_000;
export const MAX_DATASET_BYTES = 128 * 1024 * 1024;
export const VERSION = '0.1.1';
export type Category = 'broken_links' | 'redirects' | 'canonicals' | 'sitemaps' | 'metadata';
export type Priority = 'high' | 'medium' | 'low' | 'info';
export type CoverageState = 'assessed' | 'partial' | 'unassessed';
export interface Coverage {
  category: Category;
  state: CoverageState;
  reason: string;
}
/** Null means unavailable. Empty strings are observed missing elements. */
export interface PageRow {
  id: number;
  url: string;
  section: string;
  statusCode: number | null;
  contentType: string | null;
  indexability: 'indexable' | 'non-indexable' | 'unknown';
  indexabilityReason: string | null;
  canonical: string | null;
  canonicalCount: number | null;
  /** Explicit conflicting-declarations evidence, when the native filter supplied it. */
  canonicalConflict?: boolean | null;
  title: string | null;
  titleCount: number | null;
  description: string | null;
  descriptionCount: number | null;
  h1: string | null;
  h1Count: number | null;
  uniqueInlinks: number | null;
  searchClicks: number | null;
  inSitemap: boolean | null;
  redirectTarget: string | null;
}
export interface LinkRow { source: string; target: string }
export interface Finding {
  id: string;
  rule: string;
  category: Category;
  priority: Priority;
  kind: 'failure' | 'opportunity' | 'information';
  confidence: 'observed' | 'review';
  title: string;
  summary: string;
  remediation: string;
  section: string;
  affectedIds: number[];
  affectedCount: number;
  evidence: Record<string, string | number | boolean | null>;
  priorityReason: string;
  inlinkTotal: number | null;
  searchClicks: number | null;
}
export interface AuditResult {
  schemaVersion: 1;
  id: string;
  sourceCrawlId: string;
  createdAt: string;
  siteUrl: string;
  pageCount: number;
  findings: Finding[];
  coverage: Coverage[];
  provenance: { preset: string; pluginVersion: string; snapshotHash: string; source: 'native' | 'fixture' };
}
export interface Narrative {
  executiveSummary?: string;
  findings?: Array<{ findingId: string; commentary: string }>;
}
export interface ReportOptions { clientName?: string; siteName?: string; narrative?: Narrative }
export type JobStage = 'queued' | 'starting' | 'crawling' | 'native_analysis' | 'extracting' | 'analyzing' | 'ready' | 'paused' | 'needs_user_action' | 'failed' | 'cancelled';
export interface Job {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: JobStage;
  source: { crawlId?: string; url?: string; configPath?: string };
  crawlName: string;
  nativeCrawlId: string | null;
  ownsCrawl: boolean;
  preset: string;
  clientName?: string;
  siteName?: string;
  extractedRows: number;
  message: string;
  error?: string;
  launchAttemptedAt?: string;
  previousCrawlId?: string | null;
  configHash?: string | null;
  analysisReady?: boolean | null;
  linksAvailable?: boolean;
  coverageWarnings?: string[];
  checkpoint?: ExtractionCheckpoint;
}

export interface ExtractionTask {
  element: string;
  filter: string;
  fields: string[];
  nextRow: number;
  rows: number;
  done: boolean;
  skipped?: boolean;
}
export interface ExtractionCheckpoint {
  crawlId: string;
  sourceTotal: number | null;
  taskIndex: number;
  pageSize: number;
  tasks: ExtractionTask[];
  linksAttempted: boolean;
  chunks?: Array<{ task: number; start: number; count: number; sha256: string }>;
  verificationIndex?: number;
  datasetBytes?: number;
}
