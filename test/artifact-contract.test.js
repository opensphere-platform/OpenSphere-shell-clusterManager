const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');

test('production build closes the browser module graph before packaging', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  const verifier = readFileSync(resolve(root, 'tools/verify-artifacts.mjs'), 'utf8');

  assert.match(pkg.scripts.build, /tools\/bundle-app\.mjs/);
  assert.match(dockerfile, /COPY tools\/bundle-app\.mjs \.\/tools\/bundle-app\.mjs/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /ARG OS_RELEASE_TAG/);
  assert.match(dockerfile, /org\.opencontainers\.image\.version=\$OS_RELEASE_TAG/);
  assert.match(dockerfile, new RegExp(`io\\.opensphere\\.compatibility-version="${pkg.version}"`));
  assert.match(dockerfile, /ARG OS_MODULE_KEY_ID/);
  assert.match(dockerfile, /io\.opensphere\.module\.descriptor\.key-id=\$OS_MODULE_KEY_ID/);
  assert.match(verifier, /closed single-file ESM artifact/);
  assert.match(verifier, /undeclared browser chunks remain/);
});

test('package and runtime manifest agree on the global navigation band', () => {
  const pkg = readFileSync(resolve(root, 'uipluginpackage.yaml'), 'utf8');
  const manifest = JSON.parse(readFileSync(resolve(root, 'ui-shell/ui-shell.manifest.json'), 'utf8'));
  assert.match(pkg, /band:\s*["']?운영 Operate/);
  assert.equal(manifest.nav.band, '운영 Operate');
});
