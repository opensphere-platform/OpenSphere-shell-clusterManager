const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/volumesnapshots.component.ts'), 'utf8');
const resourceList = fs.readFileSync(path.resolve(__dirname, '../src/app/shared/resource-list.component.ts'), 'utf8');
const observer = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-data-protection-observer.yaml'), 'utf8');

test('Volume Snapshots correlates Ceph RBD data protection and PostgreSQL HA evidence', () => {
  assert.match(resourceList, /<ng-content><\/ng-content>/);
  assert.match(component, /데이터 보호와 Ceph RBD 복구 상태/);
  assert.match(component, /HA Degraded/);
  assert.match(component, /rbd image .* is still being used/i);
  assert.match(component, /SnapshotClass 없음/);
  assert.match(component, /Backup.*ScheduledBackup.*restore 검증/s);
  assert.match(component, /jobstatus_pkey/);
  assert.match(component, /PostgreSQL 기동 전 storage mount/);
  assert.match(component, /Primary 접속 경로/);
  assert.match(component, /replicationMode/);
  assert.match(component, /orphan mapping 자동 감지·정리 증거 없음/);
  assert.match(component, /권장 처리 순서/);
  assert.match(component, /id: 'snapshotClass', label: 'Snapshot Class'/);
  assert.match(component, /id: 'storageClass', label: 'StorageClass'/);
});

test('data protection observer is fixed-namespace and read-only', () => {
  const docs = observer.split(/^---$/m).map((item) => yaml.load(item));
  const role = docs.find((item) => item.kind === 'Role');
  const binding = docs.find((item) => item.kind === 'RoleBinding');
  assert.equal(role.metadata.namespace, 'opensphere-foundation');
  assert.equal(binding.metadata.namespace, 'opensphere-foundation');
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'opensphere-cluster-manager', namespace: 'opensphere-console' }]);
  for (const rule of role.rules) assert.deepEqual(rule.verbs, ['get', 'list', 'watch']);
  assert.ok(role.rules.some((rule) => rule.apiGroups.includes('postgresql.cnpg.io') && rule.resources.includes('scheduledbackups')));
  assert.ok(role.rules.some((rule) => rule.apiGroups.includes('monitoring.coreos.com') && rule.resources.includes('podmonitors')));
  assert.ok(role.rules.some((rule) => rule.apiGroups.includes('discovery.k8s.io') && rule.resources.includes('endpointslices')));
});
