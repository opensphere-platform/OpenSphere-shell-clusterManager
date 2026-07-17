'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateProviderExport,
  planFor,
  storageClassManifest,
  snapshotClassManifest,
  parseMetadata,
  CHART_VERSION,
} = require('../ceph-manager');

function providerExport() {
  return [
    { name: 'external-cluster-user-command', kind: 'ConfigMap', data: { args: 'not imported' } },
    { name: 'rook-ceph-mon-endpoints', kind: 'ConfigMap', data: { data: 'a=10.0.0.11:6789,b=10.0.0.12:6789,c=10.0.0.13:6789', maxMonId: '2', mapping: '{}' } },
    { name: 'rook-ceph-mon', kind: 'Secret', data: { 'admin-secret': 'admin-secret', fsid: '12345678-1234-4234-9234-123456789abc', 'mon-secret': 'mon-secret' } },
    { name: 'rook-ceph-operator-creds', kind: 'Secret', data: { userID: 'client.healthchecker', userKey: 'AQD0123456789abcdefghijklmnop==' } },
    { name: 'rook-csi-rbd-node', kind: 'Secret', data: { userID: 'client.csi-rbd-node-opensphere-rbd', userKey: 'AQDnode0123456789abcdefghijkl==' } },
    { name: 'rook-csi-rbd-provisioner', kind: 'Secret', data: { userID: 'client.csi-rbd-provisioner-opensphere-rbd', userKey: 'AQDprovisioner0123456789abcdef==' } },
    {
      name: 'ceph-rbd', kind: 'StorageClass', data: {
        pool: 'kubernetes-rbd',
        'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
        'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-rbd-provisioner',
        'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node',
      },
    },
  ];
}

test('Rook external provider JSON is reduced to an allowlisted connection model', () => {
  const connection = validateProviderExport(JSON.stringify(providerExport()));
  assert.equal(connection.fsid, '12345678-1234-4234-9234-123456789abc');
  assert.equal(connection.monitorCount, 3);
  assert.deepEqual(connection.storageClasses.map((item) => item.name), ['ceph-rbd']);
  assert.deepEqual(connection.ignored, ['ConfigMap/external-cluster-user-command']);
  assert.equal(connection.secrets.length, 4);
});

test('plan exposes only Secret references and never provider credential values', () => {
  const connection = validateProviderExport(providerExport());
  const plan = planFor(connection, true);
  const text = JSON.stringify(plan);
  assert.equal(plan.charts[0].version, CHART_VERSION);
  assert.equal(plan.safety.rawCredentialsPersistedByConsole, false);
  assert.equal(plan.safety.remoteDataDeletedOnDisconnect, false);
  assert.ok(plan.secretRefs.includes('rook-ceph/rook-ceph-operator-creds'));
  assert.ok(!text.includes('AQD0123456789abcdefghijklmnop'));
});

test('administrator or monitor keyrings are rejected at the import boundary', () => {
  const input = providerExport();
  input.find((item) => item.name === 'rook-ceph-mon').data['admin-secret'] = 'real-admin-key';
  assert.throws(() => validateProviderExport(input), /관리자\/monitor keyring/);
  const next = providerExport();
  next.find((item) => item.name === 'rook-ceph-operator-creds').data.userID = 'client.admin';
  assert.throws(() => validateProviderExport(next), /제한된 CSI 사용자/);
});

test('unknown provider resources and dangling Secret references fail closed', () => {
  const unknown = providerExport();
  unknown.push({ name: 'dangerous-job', kind: 'Job', data: { command: 'anything' } });
  assert.throws(() => validateProviderExport(unknown), /허용되지 않습니다/);
  const dangling = providerExport();
  dangling.find((item) => item.kind === 'StorageClass').data['csi.storage.k8s.io/node-stage-secret-name'] = 'other-secret';
  assert.throws(() => validateProviderExport(dangling), /알 수 없는 Secret/);
});

test('consumer storage and snapshots use Retain safety policy', () => {
  const connection = validateProviderExport(providerExport());
  const storageClass = storageClassManifest(connection.storageClasses[0]);
  const snapshotClass = snapshotClassManifest(connection.storageClasses[0]);
  assert.equal(storageClass.reclaimPolicy, 'Retain');
  assert.equal(storageClass.volumeBindingMode, 'WaitForFirstConsumer');
  assert.equal(snapshotClass.deletionPolicy, 'Retain');
  assert.equal(storageClass.parameters['csi.storage.k8s.io/provisioner-secret-namespace'], 'rook-ceph');
});

test('connection metadata parser never requires Secret contents', () => {
  const metadata = parseMetadata({ data: { connection: JSON.stringify({ schemaVersion: 1, secretRefs: ['rook-ceph/rook-csi-rbd-node'] }) } });
  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.secretRefs, ['rook-ceph/rook-csi-rbd-node']);
  assert.equal(parseMetadata({ data: { connection: '{bad' } }), null);
});
