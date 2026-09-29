import { build } from 'esbuild';
import { mkdir, chmod } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', bundle: true,
  platform: 'node', target: 'node20', format: 'esm', sourcemap: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: 'linked',
});
await chmod('dist/cli.js', 0o755);
