'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'resources', 'overview.component.ts'), 'utf8');

test('core Kubernetes failures are visible instead of becoming a false empty cluster', () => {
  assert.doesNotMatch(source, /const safe = .*catchError/);
  assert.match(source, /nodes: this\.k8s\.list\('\/api\/v1\/nodes'\)/);
  assert.match(source, /pods: this\.k8s\.list\('\/api\/v1\/pods'\)/);
  assert.match(source, /error: e => \{ this\.error\.set\(this\.loadErrorMessage\(e\)\)/);
  assert.match(source, /Console 로그인 세션을 확인할 수 없습니다[\s\S]*HTTP 401/);
  assert.match(source, /현재 계정에는 Cluster Manager 조회 권한이 없습니다[\s\S]*HTTP 403/);
  assert.match(source, /<ng-container \*ngIf="!error\(\)">/);
});

test('metrics API remains optional without masking core API failures', () => {
  assert.match(
    source,
    /metrics: this\.k8s\.list\('\/apis\/metrics\.k8s\.io\/v1beta1\/nodes'\)\.pipe\(catchError\(\(\) => of\(null\)\)\)/,
  );
});
