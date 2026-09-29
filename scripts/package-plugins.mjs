import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await readFile(path.join(root, 'dist', 'cli.js')); // Fail before creating artifacts when unbuilt.

for (const manifestPath of ['manifest.json', 'plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
  if (manifest.version !== metadata.version) {
    throw new Error(`${manifestPath} version differs from package.json; update all manifests before packaging.`);
  }
}

// Only installed production dependencies are copied, including transitive packages and licences.
// npm_execpath avoids a Windows .cmd shell when invoked through the documented npm script.
const npmArgs = ['ls', '--omit=dev', '--all', '--parseable'];
const npmPath = process.env.npm_execpath;
const dependencyOutput = npmPath
  ? execFileSync(process.execPath, [npmPath, ...npmArgs], { cwd: root, encoding: 'utf8' })
  : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
  });

async function collect(relativePath, entries, { excludeNodeModules = false } = {}) {
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('Package path escapes repository.');
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${relativePath}`);
  if (stat.isDirectory()) {
    for (const child of (await readdir(absolute)).sort()) {
      if (child === '.git' || (excludeNodeModules && child === 'node_modules')) continue;
      await collect(path.join(relativePath, child), entries, { excludeNodeModules });
    }
  } else if (stat.isFile()) {
    entries[relativePath.split(path.sep).join('/')] = new Uint8Array(await readFile(absolute));
  }
}

const shared = {};
for (const item of ['dist', 'README.md', 'LICENSE', 'docs', 'presets', 'skills', 'assets', 'sample']) await collect(item, shared);
// Keep the development bundle map in source builds, outside assistant install payloads.
delete shared['dist/cli.js.map'];
const presetMetadata = JSON.parse(Buffer.from(shared['presets/technical-audit-v1.metadata.json']).toString('utf8'));
const presetBytes = shared['presets/technical-audit-v1.seospiderconfig'];
const presetHash = createHash('sha256').update(presetBytes).digest('hex');
if (presetHash !== presetMetadata.sha256 || presetBytes.length !== presetMetadata.bytes) {
  throw new Error('Captured native preset differs from its metadata; verify and update the recorded size/hash before packaging.');
}
for (const dependencyPath of dependencyOutput.trim().split(/\r?\n/)) {
  if (path.resolve(dependencyPath) === root) continue;
  const relative = path.relative(root, dependencyPath);
  if (!relative.startsWith(`node_modules${path.sep}`)) throw new Error(`Production dependency is outside node_modules: ${relative}`);
  await collect(relative, shared, { excludeNodeModules: true });
}
shared['package.json'] = strToU8(`${JSON.stringify({
  name: metadata.name, version: metadata.version, type: 'module', license: metadata.license,
  private: true, engines: metadata.engines, dependencies: metadata.dependencies,
}, null, 2)}\n`);
shared['VALIDATION.json'] = strToU8(`${JSON.stringify({
  version: metadata.version,
  implementation: 'provisional nine-tool local audit and report workflow',
  nativeMacOS: 'SEO Spider 24.3 controlled connection/new crawl/exact identity/pagination/reconnect/saved reload passed; same-source new/saved audits produced identical 13-URL snapshots and 14 findings with 19 hyperlink rows',
  validationEvidence: 'docs/validation-2026-09-29.json; selected local observations, not host installation validation',
  newSavedFindingsEquivalence: 'passed; identical snapshots and deterministic findings from equivalent source data',
  realMCPReport: 'passed actual stdio discovery/finding queries/HTML+two CSVs',
  compiledMCPWorkflow: 'passed saved workflow with matching snapshot/findings and report generation',
  nativeAnalysisReadiness: 'unassessed where native output supplies only percentages',
  nativeWindows: 'pending release gate',
  assistantInstallationAndUsability: 'all six Claude Desktop/Claude Code/Codex and macOS/Windows journeys pending',
  nativePreset: 'genuine macOS SEO Spider 24.3 capture candidate; native path accepted and privacy review passed; applied settings/Windows validation pending',
  nativePresetProvenance: presetMetadata.provenance,
  nativePresetCapturedSHA256: presetHash,
  nativePresetPrivacyReview: presetMetadata.verification.privacyReview,
  configurationHashMeaning: 'file bytes observed before launch; applied configuration unverified',
  bundledSample: 'synthetic demonstration; not licensed-app validation',
  offlineBrowserInteraction: 'manual local-file verification pending',
  localChecks: 'typecheck/build/fixture suite have passed; rerun npm run check for final revision; npm audit reported zero vulnerabilities on 2026-09-29',
  syntheticBenchmark: '100,000 URLs/2,000 findings; 2,738,382 HTML bytes; 459.3 ms generation; Node measurements only',
  syntheticBenchmarkEvidence: 'docs/validation-2026-09-29.json',
  limits: '100,000 URLs; 128 MiB each for selected extraction, link-evidence store, normalized snapshot, analysis candidate/finding data, and report payload; explicit failure without sampling',
  validatedReleaseAndOfficialDirectories: 'pending; development preview distribution does not complete native Windows or assistant installation gates',
}, null, 2)}\n`);

const outputs = path.join(root, 'artifacts', 'plugins');
await mkdir(outputs, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const suffix = randomUUID().slice(0, 8);
const base = `jestats-screamingfrog-audit-${metadata.version}-${stamp}-${suffix}`;
const files = [];

async function writeArchive(kind, extension, entries) {
  const archive = zipSync(entries, { level: 6 });
  const filename = `${base}-${kind}.${extension}`;
  await writeFile(path.join(outputs, filename), archive, { flag: 'wx' });
  files.push({ kind, filename, sha256: createHash('sha256').update(archive).digest('hex') });
  process.stdout.write(`${path.join(outputs, filename)}\n`);
}

for (const [kind, extension, components] of [
  ['claude-desktop', 'mcpb', ['manifest.json']],
  ['claude-code', 'zip', ['.claude-plugin/plugin.json', '.mcp.json']],
  ['codex', 'zip', ['plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json']],
]) {
  const entries = { ...shared };
  for (const component of components) await collect(component, entries);
  await writeArchive(kind, extension, entries);
}

// Both hosts install the same prebuilt plugin directory, without a build or npm install hook.
const pluginName = 'jestats-screamingfrog-audit';
const pluginSource = `./plugins/${pluginName}`;
const pluginEntries = { ...shared };
for (const component of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.mcp.json', 'plugin.json', 'mcp.json']) {
  await collect(component, pluginEntries);
}
const marketplaceEntries = {
  '.agents/plugins/marketplace.json': strToU8(`${JSON.stringify({
    name: 'jestats-plugins',
    interface: { displayName: 'JEStats Plugins' },
    plugins: [{ name: pluginName, source: { source: 'local', path: pluginSource },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2)}\n`),
  '.claude-plugin/marketplace.json': strToU8(`${JSON.stringify({
    name: 'jestats-plugins', description: 'Prebuilt JEStats plugins for local technical SEO audits and offline reports.',
    owner: { name: 'JEStats' },
    plugins: [{ name: pluginName, source: pluginSource }],
  }, null, 2)}\n`),
};
for (const [name, bytes] of Object.entries(pluginEntries)) marketplaceEntries[`plugins/${pluginName}/${name}`] = bytes;

const marketplaceParent = path.join(root, 'artifacts', 'marketplaces');
await mkdir(marketplaceParent, { recursive: true });
const marketplaceDirectory = path.join(marketplaceParent, base);
await mkdir(marketplaceDirectory);
for (const [name, bytes] of Object.entries(marketplaceEntries)) {
  const destination = path.join(marketplaceDirectory, ...name.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
}
await writeArchive('marketplace', 'zip', marketplaceEntries);

let sourceRevision = 'unknown';
try {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (/^[a-f0-9]{40,64}$/.test(revision)) sourceRevision = revision;
} catch { /* Packaging also works in source archives and CI environments without Git. */ }
const checksumsFile = `${base}-SHA256SUMS.txt`;
await writeFile(path.join(outputs, checksumsFile), `${files.map(file => `${file.sha256}  ${file.filename}`).join('\n')}\n`, { flag: 'wx' });
const releaseMetadata = `${base}-RELEASE.json`;
await writeFile(path.join(outputs, releaseMetadata), `${JSON.stringify({
  base, version: metadata.version, sourceRevision, files, checksumsFile, marketplaceDirectory,
}, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${path.join(outputs, releaseMetadata)}\n`);
