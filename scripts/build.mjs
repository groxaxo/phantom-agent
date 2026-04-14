#!/usr/bin/env node
/**
 * esbuild bundler — compiles phantom-agent to a single JS file.
 */
import { build } from 'esbuild';
import { rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outdir = resolve(root, 'dist');

rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: {
    'phantom-agent': resolve(root, 'src/index.ts'),
    'phantom-agent-mcp': resolve(root, 'src/mcp/index.ts'),
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir,
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  packages: 'external',
  minify: false,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('✅ Built: dist/phantom-agent.mjs, dist/phantom-agent-mcp.mjs');
