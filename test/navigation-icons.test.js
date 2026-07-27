'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const navSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'nav-icons.ts'), 'utf8');
const registrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'register-icons.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');

function quotedValues(source) {
  return [...source.matchAll(/:\s*'([^']+)'/g)].map((match) => match[1]);
}

test('every navigation shape is explicitly registered before the Angular element starts', () => {
  const navShapes = new Set(quotedValues(navSource));
  const registryBlock = registrySource.match(/REGISTERED_NAV_ICON_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(registryBlock, 'registered navigation icon list is missing');
  const registered = new Set([...registryBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));

  for (const shape of navShapes) {
    assert.ok(registered.has(shape), `navigation icon '${shape}' is not registered`);
  }
  assert.match(mainSource, /registerClusterManagerIcons\(\);\s*const app = await createApplication/);
});

test('navigation does not rely on Clarity unknown three-dot fallback', () => {
  assert.doesNotMatch(navSource, /virtual-machine/);
  assert.doesNotMatch(navSource, /['"]unknown['"]/);
  assert.match(navSource, /'sec:Virtualization': 'vm'/);
});
