'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateProviderExport,
  planFor,
  storageClassManifest,
  snapshotClassManifest,
  parseMetadata,
  importNameFromRef,
  providerGuide,
  helmMetadataAccessDenied,
  CHART_VERSION,
} = require('../ceph-manager');

const source = fs.readFileSync(path.resolve(__dirname, '../ceph-manager.js'), 'utf8');
const runtimeOwnerManifest = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-owner.yaml'), 'utf8');

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
  assert.deepEqual(connection.monitorProtocols, ['msgr1']);
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
  assert.equal(plan.providerGuide.rookVersion, CHART_VERSION);
  assert.match(plan.providerGuide.export.commandTemplate, /--restricted-auth-permission true/);
  assert.deepEqual(plan.monitorProtocols, ['msgr1']);
});

test('provider guide makes external Ceph ownership, network, storage, and credential prerequisites explicit', () => {
  const guide = providerGuide();
  const information = new Set(guide.requiredInformation.map((item) => item.id));
  const preparation = new Set(guide.requiredPreparation.map((item) => item.id));
  assert.deepEqual(guide.network.monitorTcpPorts, [3300, 6789]);
  assert.equal(guide.network.cephDaemonTcpRange, '6800-7568');
  assert.ok(information.has('fsid'));
  assert.ok(information.has('mon-endpoints'));
  assert.ok(information.has('storage'));
  assert.ok(information.has('cephx'));
  assert.ok(information.has('provider-export'));
  assert.ok(preparation.has('health'));
  assert.ok(preparation.has('network'));
  assert.ok(preparation.has('least-privilege'));
  assert.ok(guide.unsupportedInputs.includes('client.admin keyring'));
});

test('Ceph UI gates provider import on operator acknowledgement and uses one disconnect confirmation contract', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  assert.match(component, /providerPreparationConfirmed\(\)/);
  assert.match(component, /providerStorageConfirmed/);
  assert.match(component, /providerNetworkConfirmed/);
  assert.match(component, /providerExportConfirmed/);
  assert.match(component, /disconnectConfirm !== 'disconnect Ceph external storage'/);
  assert.doesNotMatch(component, /disconnectConfirm !== 'DISCONNECT'/);
});

test('Ceph consumer prerequisite gaps link to governed installation and recheck actions', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  assert.match(component, /href="\/manage\/change-control\?template=ceph-rook-prerequisite/);
  assert.match(component, /일괄 설치 요청/);
  assert.match(component, /CRD 설치 요청/);
  assert.match(component, /Operator 설치 요청/);
  assert.match(component, /RBAC 적용 요청/);
  assert.match(component, /설치 후 다시 검사/);
  assert.match(component, /help-center%2Fperspective-02-k8s-cluster-ceph/);
  assert.match(component, /서명된 플랫폼 변경으로 요청·승인·적용/);
});

test('read-only Ceph status recognizes missing Helm Secret metadata RBAC without weakening mutations', () => {
  assert.equal(helmMetadataAccessDenied(new Error('secrets is forbidden: cannot list resource "secrets"')), true);
  assert.equal(helmMetadataAccessDenied({ safeMessage: 'query: failed to query with labels: secrets is forbidden' }), true);
  assert.equal(helmMetadataAccessDenied(new Error('Kubernetes API 500')), false);
  assert.match(source, /helmStatus\(ctx, OPERATOR_RELEASE, NAMESPACE, true\)/);
  assert.match(source, /helmStatus\(ctx, CLUSTER_RELEASE, NAMESPACE, true\)/);
  assert.match(source, /const cluster = await helmStatus\(ctx, CLUSTER_RELEASE, NAMESPACE\);/);
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

test('OAA Ceph accepts only an owner-staged SecretRef and never a raw provider export', () => {
  const name = 'opensphere-ceph-import-12345678-1234-4234-9234-123456789abc';
  assert.equal(importNameFromRef(`opensphere-ceph-imports/${name}`), name);
  assert.throws(() => importNameFromRef(`rook-ceph/${name}`), /importRef/);
  assert.throws(() => importNameFromRef('opensphere-ceph-imports/arbitrary-secret'), /importRef/);
  assert.match(source, /\/api\/ceph\/oaa\/connect/);
  assert.match(source, /connectionFromImportRef/);
  assert.match(source, /secretInputPolicy: 'StagedSecretRefOnly'/);
  assert.match(source, /requireClosedObject\(await readJson\(req\), \['importRef', 'confirm', 'reason'\]/);
  assert.match(source, /IMPORT_TTL_MS = 60 \* 60 \* 1000/);
  assert.match(source, /pruneExpiredImports/);
  assert.match(source, /'opensphere\.io\/expires-at'/);
});

test('Ceph connection runtime cannot install or uninstall the platform-owned Rook operator', () => {
  const installBody = source.slice(source.indexOf('async function installConnection'), source.indexOf('async function usageFor'));
  const disconnectBody = source.slice(source.indexOf('async function disconnect'), source.indexOf('function createCephManager'));
  assert.doesNotMatch(installBody, /OPERATOR_CHART|helm[^\n]+OPERATOR_RELEASE/);
  assert.match(source, /operatorOwned: false/);
  assert.doesNotMatch(disconnectBody, /metadata\.operatorOwned|OPERATOR_RELEASE|helm[^\n]+rook-ceph[^\n]+uninstall/);
  assert.match(source, /owner: 'signed-platform-release', installedByAction: false/);
  const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
  assert.match(dockerfile, /helm pull rook-ceph --repo/);
  assert.match(dockerfile, /6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52/);
  assert.match(dockerfile, /ceph-prerequisite-reconciler\.js/);
  assert.match(dockerfile, /helm pull rook-ceph-cluster --repo/);
});

test('Ceph runtime RBAC is namespace-bounded and excludes Kubernetes RBAC mutation', () => {
  assert.match(runtimeOwnerManifest, /namespace: opensphere-ceph-imports/);
  assert.match(runtimeOwnerManifest, /resources: \[secrets, configmaps\]/);
  assert.match(runtimeOwnerManifest, /resources: \[cephclusters\]/);
  assert.match(runtimeOwnerManifest, /resources: \[storageclasses\]/);
  assert.doesNotMatch(runtimeOwnerManifest, /resources: \[.*clusterroles/i);
  assert.doesNotMatch(runtimeOwnerManifest, /verbs: \["?\*"?\]/);
});
