'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const textExtension = /\.(?:html|js|json|md|mjs|scss|ts|yaml|yml)$/i;

test('Cluster Manager exposes OSAA only and retains no OAA compatibility path', () => {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file && textExtension.test(file) && file !== 'test/osaa-canonical-identity.test.js');
  const violations = files.filter((file) => /oaa/i.test(file) || /oaa/i.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(violations, [], `current OAA residue: ${violations.join(', ')}`);
});
