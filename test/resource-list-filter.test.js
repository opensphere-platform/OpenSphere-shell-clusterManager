'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', 'shared', 'resource-list.component.ts'),
  'utf8',
);

test('resource facets use conditional Clarity dropdown menus', () => {
  assert.doesNotMatch(source, /<div\s+clrDropdownMenu/);

  const conditionalMenus = source.match(
    /<clr-dropdown-menu\b[^>]*\*clrIfOpen[^>]*>/g,
  ) ?? [];
  assert.equal(
    conditionalMenus.length,
    3,
    'namespace, resource facet, and row action menus must render only while open',
  );
});

test('resource facet dropdowns use a stable bottom-left Clarity position', () => {
  const facetMenus = source.match(
    /<clr-dropdown-menu\b[^>]*\*clrIfOpen[^>]*clrPosition="bottom-left"[^>]*>/g,
  ) ?? [];
  assert.equal(facetMenus.length, 2);
});
