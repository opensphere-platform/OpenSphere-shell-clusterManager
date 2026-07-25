import { build } from 'esbuild';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appRoot = resolve(root, 'dist/k8s-console-angular/browser');
const input = resolve(appRoot, 'main.js');
const output = resolve(appRoot, 'main.single.js');

await build({
  entryPoints: [input],
  outfile: output,
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
});

const bundled = await readFile(output, 'utf8');
const relativeModule = /\b(?:from\s*|import\s*\()\s*["']\.{1,2}\//;
if (relativeModule.test(bundled)) {
  throw new Error('single ESM bundle still contains a relative module dependency');
}

await rm(input);
await rename(output, input);
for (const name of await readdir(appRoot)) {
  if (/^chunk-[A-Z0-9_-]+\.js$/i.test(name)) await rm(resolve(appRoot, name));
}

console.log('bundled Cluster Manager browser application as one host-loadable ESM artifact');
