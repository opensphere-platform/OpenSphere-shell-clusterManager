const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');

test('Ceph tabs have stable addressable URLs and follow browser history', () => {
  assert.match(component, /searchParams\.set\('tab', tab\)/);
  assert.match(component, /window\.history\.pushState/);
  assert.match(component, /window\.history\.replaceState/);
  assert.match(component, /window\.addEventListener\('popstate'/);
  for (const tab of ['connection', 'insights', 'services']) {
    assert.match(component, new RegExp(`tabHref\\('${tab}'\\)`));
  }
});

test('Ceph identity uses the raw logo without a decorative circle', () => {
  const rule = component.match(/\.cm-ceph-title__logo \{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(rule, /border|border-radius|background|box-shadow/);
});

test('storage service verification and request tracking failures are explicit', () => {
  assert.match(component, /구성 완료와 사용 검증은 다릅니다/);
  assert.match(component, /미검증은 정상 완료가 아니며 운영 Ready로 판정하지 않습니다/);
  assert.match(component, /변경 이력 조회 실패/);
  assert.match(component, /이 오류는 Ceph 연결 실패가 아닙니다/);
  assert.doesNotMatch(component, /'실제 검증 없음'/);
});
