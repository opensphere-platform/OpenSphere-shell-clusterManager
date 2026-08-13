const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { relative, resolve } = require('node:path');
const test = require('node:test');

const root = resolve(__dirname, '..');
const appRoot = resolve(root, 'src/app');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(appRoot);
const sources = files.map((path) => ({
  path,
  name: relative(root, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

function locations(pattern, predicate = () => true) {
  return sources.flatMap(({ name, text }) => text.split(/\r?\n/).flatMap((line, index) => {
    pattern.lastIndex = 0;
    return pattern.test(line) && predicate(name, line)
      ? [`${name}:${index + 1}`]
      : [];
  }));
}

function assertNoMatches(label, pattern, predicate) {
  const matches = locations(pattern, predicate);
  assert.deepEqual(matches, [], `${label}: ${matches.join(', ')}`);
}

test('Cluster Manager screens use the OpenSphere and Clarity visual contracts', () => {
  assertNoMatches('inline style attributes are forbidden', /\bstyle\s*=/i);
  assertNoMatches('component-level Clarity overrides are forbidden', /::ng-deep/);
  assertNoMatches('raw alert markup is forbidden', /class\s*=\s*["'][^"']*(?:^|\s)alert(?:\s|["'])/i);
  assertNoMatches('native progress elements are forbidden', /<progress(?:\s|>)/i);
  assertNoMatches('raw tables are forbidden', /<table(?:\s|>)/i);
  assertNoMatches(
    'semantic header elements conflict with the shell layout',
    /<header(?:\s|>)/i,
    (_name, line) => !line.trimStart().startsWith('*'),
  );
  assertNoMatches(
    'hard-coded colors belong only in the token SSOT',
    /(?:#[0-9a-f]{3,8}\b|rgba?\s*\()/i,
    (name) => name !== 'src/app/app.component.css',
  );
  assertNoMatches(
    'hand-authored SVG is reserved for data visualizations',
    /<svg(?:\s|>)/i,
    (name) => ![
      'src/app/resources/overview.component.ts',
      'src/app/resources/vm-overview.component.ts',
    ].includes(name),
  );
});

test('interactive form controls are wired to Clarity directives', () => {
  assertNoMatches(
    'native inputs need a Clarity directive',
    /<input(?![^>]*\bclr(?:Input|Checkbox|Radio|Toggle|Password)\b)[^>]*>/i,
  );
  assertNoMatches(
    'native selects need clrSelect',
    /<select(?![^>]*\bclrSelect\b)[^>]*>/i,
  );
  assertNoMatches(
    'native textareas need clrTextarea',
    /<textarea(?![^>]*\bclrTextarea\b)[^>]*>/i,
  );
});

test('shared operational surfaces keep the standard state and layout primitives', () => {
  const resourceList = readFileSync(resolve(appRoot, 'shared/resource-list.component.ts'), 'utf8');
  const his = readFileSync(resolve(appRoot, 'resources/his.component.ts'), 'utf8');
  const ceph = readFileSync(resolve(appRoot, 'resources/ceph.component.ts'), 'utf8');
  const tokens = readFileSync(resolve(appRoot, 'app.component.css'), 'utf8');

  for (const primitive of ['clr-dropdown', 'clr-side-panel', 'clr-datagrid', 'clr-alert']) {
    assert.match(resourceList, new RegExp(`<${primitive}\\b`), `resource list must use ${primitive}`);
  }
  for (const source of [his, ceph]) {
    assert.match(source, /\bos-page-header\b/);
    assert.match(source, /<clr-alert\b/);
    assert.match(source, /<clr-modal\b/);
    assert.match(source, /<clr-datagrid\b/);
  }
  assert.match(ceph, /<clr-tabs\b/);
  assert.match(tokens, /--os-brand-500:/);
  assert.match(tokens, /--os-bg:/);
  assert.match(tokens, /--os-focus-ring:/);
});

test('Shared Observability keeps essential install choices visible and moves only expert controls on demand', () => {
  const his = readFileSync(resolve(appRoot, 'resources/his.component.ts'), 'utf8');

  assert.match(his, /logos\/prometheus-2\.svg/);
  assert.match(his, /logos\/grafana-2\.svg/);
  assert.match(his, /class="observability-logo-pair"/);
  assert.match(his, /class="observability-quick-card"/);
  assert.match(his, /권장 설정으로 한 번에 설치/);
  assert.match(his, /빠른 설치 요청/);
  assert.match(his, /name="quickChartVersion"/);
  assert.match(his, /name="quickStorageClass"/);
  assert.match(his, /Shared Observability의 고정 관리 namespace/);
  assert.match(his, /observabilityAdvancedOpen/);
  assert.match(his, /observabilityInstallReady\(item: HisItem\)[\s\S]*this\.observabilityInstallCandidate\(item\)[\s\S]*Boolean\(plan\?\.canApply\)/);
  assert.match(his, /shape="success-standard"/);
  assert.doesNotMatch(his, /shape="check-circle"/);
  assert.match(his, /class="modal-footer observability-modal-footer"/);
  assert.match(his, /class="observability-footer-view"/);
  assert.match(his, /class="observability-footer-actions"/);
  assert.match(his, /\.quick-install-options\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(his, /\.quick-install-options clr-control-helper\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(his, /기술 계획 보기/);
  assert.doesNotMatch(his, /class="observability-work-model"/);
  assert.doesNotMatch(his, /<clr-timeline\b/);
  assert.match(his, /\.lifecycle-workspace\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(his, /\.observability-quick-card\s*\{[^}]*grid-template-columns:/s);
  assert.match(his, /\.storage-form-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
});

test('HIS action column exposes one primary action and moves secondary work into a standard menu', () => {
  const his = readFileSync(resolve(appRoot, 'resources/his.component.ts'), 'utf8');

  assert.equal((his.match(/class="btn btn-sm action-primary"/g) || []).length, 1);
  assert.match(his, /\{\{ primaryActionLabel\(item\) \}\}/);
  assert.match(his, /primaryActionLabel\(item: HisItem\)[\s\S]*기능 검증[\s\S]*상세 진단[\s\S]*관측 서비스 관리/);
  assert.match(his, /shape="ellipsis-vertical"/);
  assert.match(his, /clrPosition="bottom-right"/);
  assert.match(his, />계획 검토<\/button>/);
  assert.match(his, /요구조건 해제/);
  assert.doesNotMatch(his, /<span class="muted">호스트 제공 · 진단만<\/span>/);
  assert.doesNotMatch(his, /profile 해제/);
  assert.match(his, /\.action-buttons\s*\{[^}]*display:\s*flex;[^}]*white-space:\s*nowrap;/s);
});

test('HIS aggregate polling is single-flight and schedules only after completion', () => {
  const his = readFileSync(resolve(appRoot, 'resources/his.component.ts'), 'utf8');
  assert.match(his, /private loadInFlight = false/);
  assert.match(his, /if \(this\.loadInFlight\) return/);
  assert.match(his, /private finishLoad\(\): void/);
  assert.match(his, /setTimeout\(\(\) => this\.load\(false\), 15000\)/);
  assert.doesNotMatch(his, /setInterval\(\(\) => this\.load\(false\), 3000\)/);
});

test('HIS status aggregation shares one server computation and keeps profile reads on the same critical path', () => {
  const source = readFileSync(resolve(__dirname, '../his-manager.js'), 'utf8');
  assert.match(source, /const \[items, explicitProfiles\] = await Promise\.all\(\[/);
  assert.match(source, /if \(hisStatusInFlight\) return hisStatusInFlight/);
  assert.match(source, /HIS_STATUS_CACHE_TTL_MS = 10 \* 1000/);
  assert.match(source, /\.finally\(\(\) => \{ hisStatusInFlight = null; \}\)/);
});

test('Platform readiness reads HIS status through the ServiceAccount-only internal contract', () => {
  const source = readFileSync(resolve(__dirname, '../his-manager.js'), 'utf8');
  assert.match(source, /pathname === '\/api\/his\/internal\/status'/);
  assert.match(source, /internalServiceAccountRequest\(ctx, req\)/);
  assert.match(source, /authentication\.k8s\.io\/v1\/tokenreviews/);
  assert.match(source, /review\?\.status\?\.user\?\.username === INTERNAL_STATUS_CALLER/);
  assert.match(source, /HIS internal status requires the Cluster Manager ServiceAccount token/);
});
