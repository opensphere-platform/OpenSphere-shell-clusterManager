import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const angular = JSON.parse(readFileSync(resolve(root, 'angular.json'), 'utf8'));
const project = Object.values(angular.projects)[0];
const output = project.architect.build.options.outputPath;
const outputRoot = typeof output === 'string' ? output : output.base;
const appRoot = resolve(root, outputRoot, 'browser');
const manifest = JSON.parse(readFileSync(resolve(root, 'ui-shell/ui-shell.manifest.json'), 'utf8'));
const appSource = readFileSync(resolve(appRoot, 'main.js'), 'utf8');
const relativeModule = /\b(?:from\s*|import\s*\()\s*["']\.{1,2}\//;

if (hash(readFileSync(resolve(root, 'ui-shell/ui-shell.plugin.js'))) !== manifest.entrySha256) throw new Error('ui-shell.plugin.js does not match manifest.entrySha256');
if (relativeModule.test(appSource)) throw new Error('app/main.js is not a closed single-file ESM artifact');
const auxiliaryChunks = readdirSync(appRoot).filter((name) => /^chunk-[A-Z0-9_-]+\.js$/i.test(name));
if (auxiliaryChunks.length) throw new Error(`undeclared browser chunks remain: ${auxiliaryChunks.join(', ')}`);
const expected = new Map([
  ['app', { type: 'module', path: '../app/main.js', file: 'main.js' }],
  ['styles', { type: 'style', path: '../app/styles.css', file: 'styles.css' }],
]);
for (const [id, contract] of expected) {
  const asset = (manifest.assets || []).find((item) => item.id === id);
  if (!asset || asset.type !== contract.type || asset.path !== contract.path) throw new Error(`manifest asset '${id}' contract is missing or invalid`);
  if (hash(readFileSync(resolve(appRoot, contract.file))) !== asset.sha256) throw new Error(`manifest asset '${id}' digest drift`);
}
if ((manifest.assets || []).length !== expected.size) throw new Error('manifest contains undeclared auxiliary assets');
console.log(`verified ${manifest.id}: entry + ${expected.size} auxiliary assets`);
