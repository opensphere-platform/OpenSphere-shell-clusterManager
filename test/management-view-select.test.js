const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { resolve } = require('node:path');

const app = readFileSync(resolve(__dirname, '../src/app/app.component.ts'), 'utf8');

test('management view uses one full-width Clarity select container', () => {
  assert.equal((app.match(/<select id="cm-management-view"(?:\s|>)/g) || []).length, 1);
  assert.equal((app.match(/<clr-select-container class="cm-scope-control">/g) || []).length, 1);
  assert.doesNotMatch(
    app,
    /<div class="clr-select-wrapper">[\s\S]{0,240}<select id="cm-management-view"/,
    'clrSelect already creates the Clarity wrapper; a manual wrapper renders a duplicate chevron',
  );
  for (const selector of [
    '.cm-scope-control',
    '.cm-scope-control .clr-control-container',
    '.cm-scope-control .clr-select-wrapper',
    '.cm-scope-control .clr-select',
  ]) {
    assert.match(app, new RegExp(`${selector.replaceAll('.', '\\.')}[\\s\\S]{0,240}width:\\s*100%`));
  }
});
