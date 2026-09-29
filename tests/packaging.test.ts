import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';

interface PackagedFile { kind: string; filename: string; sha256: string }
interface ReleaseMetadata {
  base: string; version: string; sourceRevision: string; files: PackagedFile[];
  checksumsFile: string; marketplaceDirectory: string;
}

const runFile = promisify(execFile);
const root = resolve('.');
const outputDirectory = join(root, 'artifacts', 'plugins');
const pluginName = 'jestats-screamingfrog-audit';
const pluginPrefix = `plugins/${pluginName}/`;
const expectedTools = ['audit_status', 'connection_status', 'control_audit', 'finding_details', 'list_audits',
  'list_crawls', 'list_findings', 'render_report', 'start_audit'];
// Archive extraction touches thousands of files; allow for Windows runner disk latency.
const packagingTimeout = 120_000;
const cleanupOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

describe('prebuilt installable plugin packages', () => {
  let metadata: ReleaseMetadata;
  let releasePath: string;
  let isolatedRoot: string;
  const archives = new Map<string, Record<string, Uint8Array>>();

  beforeAll(async () => {
    isolatedRoot = await mkdtemp(join(tmpdir(), 'jestats-package-test-'));
    const { stdout } = await runFile(process.execPath, ['scripts/package-plugins.mjs'], {
      cwd: root, encoding: 'utf8', maxBuffer: 1_048_576,
    });
    const publishedMetadata = stdout.trim().split(/\r?\n/).find(line => line.endsWith('-RELEASE.json'));
    if (!publishedMetadata) throw new Error('Packaging did not produce release metadata.');
    releasePath = publishedMetadata;
    metadata = JSON.parse(await readFile(releasePath, 'utf8')) as ReleaseMetadata;
    for (const file of metadata.files) {
      archives.set(file.kind, unzipSync(new Uint8Array(await readFile(join(outputDirectory, file.filename)))));
    }
  }, packagingTimeout);

  afterAll(async () => {
    if (metadata) {
      await Promise.all([
        ...metadata.files.map(file => rm(join(outputDirectory, file.filename), { force: true })),
        rm(join(outputDirectory, metadata.checksumsFile), { force: true }),
        rm(metadata.marketplaceDirectory, cleanupOptions),
      ]);
    }
    if (releasePath) await rm(releasePath, { force: true });
    if (isolatedRoot) await rm(isolatedRoot, cleanupOptions);
  }, 60_000);

  test('publishes four uniquely named archives with matching release metadata and checksums', async () => {
    expect(metadata.files.map(file => file.kind)).toEqual(['claude-desktop', 'claude-code', 'codex', 'marketplace']);
    expect(new Set(metadata.files.map(file => file.filename)).size).toBe(4);
    const prefix = `jestats-screamingfrog-audit-${metadata.version}-`;
    expect(metadata.base.startsWith(prefix)).toBe(true);
    expect(metadata.base.slice(prefix.length)).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}$/);
    expect(metadata.version).toBe(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
    expect(metadata.sourceRevision).toMatch(/^(?:[a-f0-9]{40,64}|unknown)$/);
    const checksums = await readFile(join(outputDirectory, metadata.checksumsFile), 'utf8');
    for (const file of metadata.files) {
      expect(file.filename.startsWith(`${metadata.base}-`)).toBe(true);
      const bytes = await readFile(join(outputDirectory, file.filename));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      expect(checksums).toContain(`${file.sha256}  ${file.filename}\n`);
    }
    expect(checksums.trim().split('\n')).toHaveLength(4);
  }, 30_000);

  test('resolves both marketplace catalogs to a complete prebuilt plugin without nested catalogs', async () => {
    const marketplace = archives.get('marketplace')!;
    const codexCatalog = JSON.parse(strFromU8(marketplace['.agents/plugins/marketplace.json']!));
    expect(codexCatalog).toEqual({ name: 'jestats-plugins', interface: { displayName: 'JEStats Plugins' }, plugins: [{
      name: pluginName, source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
    }] });
    const claudeCatalog = JSON.parse(strFromU8(marketplace['.claude-plugin/marketplace.json']!));
    expect(claudeCatalog).toEqual({ name: 'jestats-plugins',
      description: 'Prebuilt JEStats plugins for local technical SEO audits and offline reports.', owner: { name: 'JEStats' },
      plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }] });
    const preset = await readFile(join(root, 'presets', 'technical-audit-v1.seospiderconfig'));
    for (const [kind, entries] of archives) {
      const prefix = kind === 'marketplace' ? pluginPrefix : '';
      expect(Buffer.from(entries[`${prefix}presets/technical-audit-v1.seospiderconfig`]!)).toEqual(preset);
      expect(entries[`${prefix}dist/cli.js`]).toBeDefined();
      expect(Object.keys(entries).some(name => name.startsWith(`${prefix}node_modules/`))).toBe(true);
      expect(entries[`${prefix}.claude-plugin/marketplace.json`]).toBeUndefined();
      expect(entries[`${prefix}.agents/plugins/marketplace.json`]).toBeUndefined();
      const manifest = kind === 'claude-desktop' ? 'manifest.json' : kind === 'claude-code' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json';
      const hostManifest = JSON.parse(strFromU8(entries[`${prefix}${manifest}`]!));
      expect(hostManifest.version).toBe(metadata.version);
      if (kind === 'claude-desktop') {
        expect(hostManifest.user_config.data_dir).toMatchObject({ type: 'directory', default: '', required: false });
        expect(hostManifest.server.mcp_config.env.JESTATS_AUDIT_DATA_DIR).toBe('${user_config.data_dir}');
      }
      const packageManifest = JSON.parse(strFromU8(entries[`${prefix}package.json`]!));
      expect(packageManifest.scripts).toBeUndefined();
      expect(packageManifest.devDependencies).toBeUndefined();
      const validation = JSON.parse(strFromU8(entries[`${prefix}VALIDATION.json`]!));
      expect(validation.nativeWindows).toContain('pending');
      expect(validation.validatedReleaseAndOfficialDirectories).toContain('pending');
    }
    for (const [name, bytes] of Object.entries(marketplace)) {
      const unpacked = await readFile(join(metadata.marketplaceDirectory, ...name.split('/')));
      expect(createHash('sha256').update(unpacked).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  }, 60_000);

  test('starts every extracted runtime without installing dependencies or contacting a native app', async () => {
    for (const [kind, entries] of archives) {
      const extractionRoot = join(isolatedRoot, kind);
      for (const [name, bytes] of Object.entries(entries)) {
        const destination = resolve(extractionRoot, ...name.split('/'));
        const relativePath = relative(extractionRoot, destination);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`Unsafe archive path: ${name}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: 'wx' });
      }
      const pluginRoot = kind === 'marketplace' ? join(extractionRoot, 'plugins', pluginName) : extractionRoot;
      const client = new Client({ name: 'jestats-package-test', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginRoot, 'dist', 'cli.js')],
        cwd: pluginRoot, env: { PATH: process.env.PATH ?? '', SCREAMINGFROG_MCP_URL: 'http://127.0.0.1:1/mcp',
          JESTATS_AUDIT_DATA_DIR: join(isolatedRoot, `${kind}-audit-data`) }, stderr: 'pipe' });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(expectedTools);
        const result = await client.callTool({ name: 'connection_status', arguments: {} });
        const block = result.content.find(item => item.type === 'text');
        if (!block || block.type !== 'text') throw new Error('Expected native connection diagnostics.');
        expect(JSON.parse(block.text).connected).toBe(false);
      } finally { await client.close(); }
    }
  }, packagingTimeout);
});
