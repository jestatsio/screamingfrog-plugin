import { afterEach, describe, expect, test, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditManager } from '../src/audit.js';
import type { NativeClient } from '../src/native-contract.js';
import { createServer, defaultAuditStore } from '../src/server.js';

const legacyDesktopDefault = '${HOME}/.jestats/screamingfrog';

afterEach(() => vi.unstubAllEnvs());

describe('audit storage directory configuration', () => {
  test('uses the real Node home directory when the setting is absent', () => {
    vi.stubEnv('JESTATS_AUDIT_DATA_DIR', undefined);
    expect(defaultAuditStore().root).toBe(resolve(homedir(), '.jestats', 'screamingfrog'));
  });

  test.each(['', legacyDesktopDefault])('uses the home directory for a blank or previously shipped default: %s', configured => {
    const userHome = join(tmpdir(), 'fixture home 🐸');
    expect(defaultAuditStore(configured, userHome).root).toBe(resolve(userHome, '.jestats', 'screamingfrog'));
  });

  test('reads the environment setting and repairs the previously shipped literal default', () => {
    vi.stubEnv('JESTATS_AUDIT_DATA_DIR', legacyDesktopDefault);
    expect(defaultAuditStore().root).toBe(resolve(homedir(), '.jestats', 'screamingfrog'));
  });

  test.each([
    join(tmpdir(), 'custom data 🐸 with spaces'),
    'relative data folder',
    '${HOME}/custom-audits',
    '$HOME/.jestats/screamingfrog',
    '~/custom-audits',
    join(tmpdir(), 'literal-${HOME}', 'audits'),
  ])('preserves a custom path without shell or environment expansion: %s', configured => {
    expect(defaultAuditStore(configured, join(tmpdir(), 'unused-home')).root).toBe(resolve(configured));
  });

  test.each(['', legacyDesktopDefault])('persists start_audit and lists its durable job using the default path: %s', async configured => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), 'jestats-home-path-test-'));
    const userHome = join(isolatedRoot, 'user home 🐸');
    const store = defaultAuditStore(configured, userHome);
    const expectedRoot = join(userHome, '.jestats', 'screamingfrog');
    const native = {
      endpoint: 'http://127.0.0.1:1/mcp', connect: vi.fn(), loadCrawl: vi.fn(),
      status: vi.fn(async () => ({ crawlId: 'saved-fixture', crawlComplete: true, analysisComplete: null,
        apisComplete: null, paused: false, totalUrls: 0, raw: { databaseId: 'saved-fixture', crawlComplete: true } })),
    } as unknown as NativeClient;
    const manager = new AuditManager(native, store, join(isolatedRoot, 'application'));
    const server = createServer(native, manager);
    const client = new Client({ name: 'audit-storage-regression', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      // Keep persistence inside the fixture even when a path-selection regression occurs.
      expect(store.root).toBe(expectedRoot);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({ name: 'start_audit', arguments: { crawlId: 'saved-fixture' } });
      expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
      const block = started.content.find(item => item.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Expected a durable audit job response.');
      const audit = JSON.parse(block.text).audit as { id: string; stage: string };
      expect(audit.stage).toBe('starting');
      const persisted = JSON.parse(await readFile(join(expectedRoot, 'audits', audit.id, 'job.json'), 'utf8'));
      expect(persisted).toMatchObject({ id: audit.id, stage: 'starting', source: { crawlId: 'saved-fixture' } });
      const listed = await client.callTool({ name: 'list_audits', arguments: {} });
      expect(listed.isError).not.toBe(true);
      const listBlock = listed.content.find(item => item.type === 'text');
      if (!listBlock || listBlock.type !== 'text') throw new Error('Expected persisted audit jobs.');
      expect(JSON.parse(listBlock.text).audits).toEqual([expect.objectContaining({ id: audit.id, stage: 'starting' })]);
      expect((await readdir(isolatedRoot)).sort()).toEqual(['application', 'user home 🐸']);
      expect(vi.mocked(native.connect)).not.toHaveBeenCalled();
      expect(vi.mocked(native.loadCrawl)).not.toHaveBeenCalled();
      expect(vi.mocked(native.status)).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
