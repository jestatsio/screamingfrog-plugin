import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ScreamingFrogNative } from './native.js';
import { createServer, defaultAuditStore } from './server.js';
import { VERSION } from './types.js';
import { AuditManager } from './audit.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const native = new ScreamingFrogNative(process.env.SCREAMINGFROG_MCP_URL);
  const manager = new AuditManager(native, defaultAuditStore());
  const handle = serveStdio(() => createServer(native, manager));
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= (async () => {
      try { await handle.close(); } finally { await native.close(); }
    })();
    void closing.catch(error => { process.stderr.write(`JEStats shutdown: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    return closing;
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('close', () => { void shutdown(); });
  const exitAfterShutdown = () => { void shutdown().then(() => process.exit(process.exitCode ?? 0), () => process.exit(1)); };
  process.once('SIGINT', exitAfterShutdown);
  process.once('SIGTERM', exitAfterShutdown);
}
