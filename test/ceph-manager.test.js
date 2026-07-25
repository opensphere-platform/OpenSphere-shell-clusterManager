'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateProviderExport,
  validateConnectionInput,
  planFor,
  storageClassManifest,
  snapshotClassManifest,
  parseMetadata,
  importNameFromRef,
  providerGuide,
  helmMetadataAccessDenied,
  requestCephPrerequisiteChange,
  cephPrerequisiteRequestStatus,
  normalizeCephInsights,
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
    { name: 'rook-csi-rbd-node', kind: 'Secret', data: { userID: 'csi-rbd-node-opensphere-rbd', userKey: 'AQDnode0123456789abcdefghijkl==' } },
    { name: 'rook-csi-rbd-provisioner', kind: 'Secret', data: { userID: 'csi-rbd-provisioner-opensphere-rbd', userKey: 'AQDprovisioner0123456789abcdef==' } },
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

function connectionInput() {
  return {
    clusterID: '12345678-1234-4234-9234-123456789abc',
    monitors: '10.0.0.11:3300\n10.0.0.12:3300\n10.0.0.13:3300',
    userID: 'opensphere',
    userKey: 'AQD0123456789abcdefghijklmnop==',
    pool: 'kubernetes-rbd',
    storageClassName: 'ceph-rbd',
  };
}

test('Rook external provider JSON is reduced to an allowlisted connection model', () => {
  const connection = validateProviderExport(JSON.stringify(providerExport()));
  assert.equal(connection.fsid, '12345678-1234-4234-9234-123456789abc');
  assert.equal(connection.monitorCount, 3);
  assert.deepEqual(connection.monitorProtocols, ['msgr1']);
  assert.deepEqual(connection.storageClasses.map((item) => item.name), ['ceph-rbd']);
  assert.deepEqual(connection.ignored, ['ConfigMap/external-cluster-user-command']);
  assert.equal(connection.secrets.length, 4);
  assert.equal(connection.secrets.find((item) => item.name === 'rook-ceph-operator-creds').data.userID, 'client.healthchecker');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-node').data.userID, 'csi-rbd-node-opensphere-rbd');
});

test('legacy prefixed CSI user IDs are normalized at the provider import boundary', () => {
  const input = providerExport();
  input.find((item) => item.name === 'rook-csi-rbd-node').data.userID = 'client.csi-rbd-node-opensphere-rbd';
  input.find((item) => item.name === 'rook-csi-rbd-provisioner').data.userID = 'client.csi-rbd-provisioner-opensphere-rbd';
  const connection = validateProviderExport(input);
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-node').data.userID, 'csi-rbd-node-opensphere-rbd');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-provisioner').data.userID, 'csi-rbd-provisioner-opensphere-rbd');
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
  assert.ok(plan.providerGuide.requiredInformation.some((item) => item.id === 'user-key' && item.secret));
  assert.deepEqual(plan.monitorProtocols, ['msgr1']);
});

test('provider guide describes connection values without asking for Ceph health attestation or JSON export', () => {
  const guide = providerGuide();
  const information = new Set(guide.requiredInformation.map((item) => item.id));
  assert.deepEqual(guide.network.monitorTcpPorts, [3300, 6789]);
  assert.equal(guide.network.cephDaemonTcpRange, '6800-7568');
  assert.ok(information.has('fsid'));
  assert.ok(information.has('mon-endpoints'));
  assert.ok(information.has('user-id'));
  assert.ok(information.has('user-key'));
  assert.ok(information.has('pool'));
  assert.ok(!information.has('provider-export'));
  assert.deepEqual(guide.requiredPreparation, []);
  assert.ok(guide.unsupportedInputs.includes('client.admin keyring'));
});

test('Ceph UI automatically reports Kubernetes readiness and collects only connection values', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const service = fs.readFileSync(path.resolve(__dirname, '../src/app/core/ceph.service.ts'), 'utf8');
  assert.match(component, /Kubernetes 연결 준비/);
  assert.match(component, /시스템이 자동으로 점검했습니다/);
  assert.match(component, /name="clusterID"/);
  assert.match(component, /name="monitors"/);
  assert.match(component, /name="userID"/);
  assert.match(component, /name="userKey"/);
  assert.match(component, /name="pool"/);
  assert.match(component, /clr-input-container class="wide-field"[^]*name="clusterID"/);
  assert.match(component, /monitor-input wide-field/);
  assert.match(component, /\.connection-form input\[clrInput\][^}]*width: 100%/);
  assert.match(component, /\.connection-form \.clr-input-group/);
  assert.doesNotMatch(component, /Provider Ceph 확인/);
  assert.doesNotMatch(component, /providerStorageConfirmed|providerNetworkConfirmed|providerExportConfirmed/);
  assert.doesNotMatch(component, /Provider export JSON/);
  assert.match(service, /CephConnectionInput/);
  assert.doesNotMatch(service, /CephProviderAttestation|providerAttestation/);
  assert.doesNotMatch(source, /PROVIDER_ATTESTATION_ANNOTATION|requireProviderAttestation/);
  assert.match(component, /disconnectConfirm !== 'disconnect Ceph external storage'/);
  assert.doesNotMatch(component, /disconnectConfirm !== 'DISCONNECT'/);
});

test('Ceph Wizard keeps validation and connection feedback inside the modal', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const validateBlock = component.slice(component.indexOf('validatePlan(): void'), component.indexOf('connect(): void'));
  assert.match(component, /connectError\(\)[^]*wizard-feedback[^]*role="alert"/);
  assert.match(component, /connectNotice\(\)[^]*wizard-feedback[^]*role="status"/);
  assert.match(component, /this\.connectError\.set\(this\.message\(failure\)\)/);
  assert.match(component, /this\.connectNotice\.set\('CephX 사용자를 Rook용 정식 엔티티/);
  assert.match(component, /this\.connectCompleted\.set\(true\)/);
  assert.match(component, /외부 Ceph 연결 완료/);
  assert.match(component, /opensphere-dev[^]*client\.opensphere-dev[^]*모두 허용/);
  assert.doesNotMatch(validateBlock, /this\.error\.set/);
});

test('direct Ceph user identity accepts both notations and targets Rook and ceph-csi correctly', () => {
  const connection = validateConnectionInput(connectionInput());
  assert.equal(connection.fsid, connectionInput().clusterID);
  assert.deepEqual(connection.monitorEndpoints, ['10.0.0.11:3300', '10.0.0.12:3300', '10.0.0.13:3300']);
  assert.deepEqual(connection.monitorProtocols, ['msgr2']);
  assert.equal(connection.cephEntity, 'client.opensphere');
  assert.equal(connection.csiUserID, 'opensphere');
  assert.equal(connection.userID, 'opensphere');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-ceph-operator-creds').data.userID, 'client.opensphere');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-node').data.userID, 'opensphere');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-provisioner').data.userID, 'opensphere');
  const qualified = validateConnectionInput({ ...connectionInput(), userID: 'client.opensphere' });
  assert.equal(qualified.cephEntity, connection.cephEntity);
  assert.equal(qualified.csiUserID, connection.csiUserID);
  assert.equal(connection.storageClasses[0].data.pool, 'kubernetes-rbd');
  assert.equal(connection.secrets.length, 4);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), clusterID: 'not-a-uuid' }), /UUID 형식/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), monitors: '10.0.0.11:443' }), /형식이 올바르지 않습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), userID: 'admin' }), /client\.admin은 사용할 수 없습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), userID: 'client.admin' }), /client\.admin은 사용할 수 없습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), userID: 'mon.opensphere' }), /Ceph client 엔티티/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), extra: 'rejected' }), /허용되지 않은 필드/);
});

test('direct connection plan never exposes the CephX key', () => {
  const input = connectionInput();
  const plan = planFor(validateConnectionInput(input), true);
  const text = JSON.stringify(plan);
  assert.equal(plan.clusterID, input.clusterID);
  assert.deepEqual(plan.monitors, ['10.0.0.11:3300', '10.0.0.12:3300', '10.0.0.13:3300']);
  assert.equal(plan.cephEntity, 'client.opensphere');
  assert.equal(plan.csiUserID, input.userID);
  assert.equal(plan.userID, input.userID);
  assert.ok(!text.includes(input.userKey));
  assert.match(source, /\['connection', 'confirm', 'reason'\]/);
  assert.match(source, /validateConnectionInput\(body\.connection\)/);
});

test('Ceph consumer prerequisite gaps create a governed installation request in place', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const service = fs.readFileSync(path.resolve(__dirname, '../src/app/core/ceph.service.ts'), 'utf8');
  assert.match(component, /openPrerequisiteInstall\('readiness'\)/);
  assert.match(component, /requestPrerequisiteInstall\(\)/);
  assert.match(component, /이 페이지에서 설치 요청/);
  assert.match(component, /다른 운영자의 MFA 승인 후 자동 설치/);
  assert.match(component, /prerequisiteOpen[^]*clrModalSize\]="'xl'"/);
  assert.match(component, /textarea\[name='prerequisiteReason'\][^}]*width: 100%/);
  assert.match(service, /this\.url\('prerequisites\/request'\)/);
  assert.doesNotMatch(service, /\/api\/platform\//);
  assert.match(component, /prerequisiteError\(\)/);
  assert.match(component, /설치 요청 실패:/);
  assert.match(component, /this\.prerequisiteError\.set\(this\.message\(failure\)\)/);
  assert.match(component, /일괄 설치 요청/);
  assert.match(component, /CRD 설치 요청/);
  assert.match(component, /Operator 설치 요청/);
  assert.match(component, /RBAC 적용 요청/);
  assert.match(component, /설치 후 다시 검사/);
  assert.match(component, /help-center%2Fperspective-02-k8s-cluster-ceph/);
  assert.match(component, /서명된 플랫폼 변경으로 요청·승인·적용/);
  assert.match(component, /installationRequest/);
  assert.match(component, /승인 대기/);
  assert.match(component, /설치·검증 중/);
  assert.match(component, /setInterval[\s\S]*10_000/);
  assert.match(component, /변경 요청 열기/);
});

test('Ceph prerequisite request uses the fixed Console Change Control contract without a nested plugin URL', async () => {
  const calls = [];
  const template = {
    id: 'ceph-rook-prerequisite',
    consumerId: 'ceph-prerequisites',
    action: 'apply',
    target: 'rook-ceph/v1.20.2',
    desiredState: { contract: 'opensphere.ceph.rook-prerequisite/v1' },
  };
  const ctx = {
    requestToken: () => 'user-token',
    verifyToken: async () => ({ username: 'operator', groups: ['console-admins'], assurance: 'aal2' }),
    consoleBackend: 'http://console-backend:8080',
    consoleFetch: async (url, init) => {
      calls.push({ url, init });
      const body = calls.length === 1 ? template : { accepted: true, requestId: '00000000-0000-4000-8000-000000000001' };
      return { ok: true, status: calls.length === 1 ? 200 : 202, text: async () => JSON.stringify(body) };
    },
  };
  const req = { headers: { 'x-os-correlation-id': 'corr-1', 'x-os-idempotency-key': 'idempotency-1' } };
  const result = await requestCephPrerequisiteChange(ctx, req, { reason: '외부 Ceph 연결 준비 설치', source: 'crd' });

  assert.equal(result.accepted, true);
  assert.deepEqual(calls.map((call) => call.url), [
    'http://console-backend:8080/api/platform/change-templates/ceph-rook-prerequisite',
    'http://console-backend:8080/api/platform/changes',
  ]);
  assert.equal(calls[0].init.headers.authorization, 'Bearer user-token');
  assert.equal(calls[1].init.headers['x-os-idempotency-key'], 'idempotency-1');
  const submitted = JSON.parse(calls[1].init.body);
  assert.equal(submitted.templateId, template.id);
  assert.equal(submitted.reason, '외부 Ceph 연결 준비 설치 [source:crd]');
});

test('Ceph readiness restores the authoritative prerequisite request lifecycle after reload', async () => {
  const current = {
    trackingAvailable: true,
    requestId: '00000000-0000-4000-8000-000000000001',
    phase: 'AwaitingApproval',
    status: 'authorized',
    requestedAt: '2026-07-24T10:00:00.000Z',
    pullRequest: { number: 17, url: 'https://gitea.example/pulls/17' },
    reconcilerStatus: 'NotScheduled',
  };
  const calls = [];
  const ctx = {
    requestToken: () => 'user-token',
    consoleBackend: 'http://console-backend:8080',
    consoleFetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ templateId: 'ceph-rook-prerequisite', current }) };
    },
  };
  const request = { headers: {} };
  assert.deepEqual(await cephPrerequisiteRequestStatus(ctx, request), current);
  assert.equal(calls[0].url, 'http://console-backend:8080/api/platform/change-templates/ceph-rook-prerequisite/status');
  assert.equal(calls[0].init.headers.authorization, 'Bearer user-token');
});

test('Ceph readiness exposes request tracking outages instead of inviting a duplicate request', async () => {
  const status = await cephPrerequisiteRequestStatus({
    requestToken: () => 'user-token',
    consoleBackend: 'http://console-backend:8080',
    consoleFetch: async () => { throw new Error('offline'); },
  }, { headers: {} });
  assert.equal(status.trackingAvailable, false);
  assert.equal(status.phase, 'Unavailable');
  assert.match(status.message, /연결할 수 없습니다/);
});

test('Ceph readiness reads bounded Helm release metadata without embedding the Rook CRD manifest', () => {
  assert.match(source, /command\('helm', \['list', '--namespace', namespace, '--all', '--filter', filter, '--output', 'json'\]/);
  const helmStatusSource = source.slice(source.indexOf('async function helmStatus'), source.indexOf('async function clusterIdentity'));
  assert.doesNotMatch(helmStatusSource, /command\('helm', \['status'/);
  assert.match(helmStatusSource, /installed: false, status: 'not-installed'/);
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
  assert.throws(() => validateProviderExport(next), /client\.admin은 사용할 수 없습니다/);
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

test('OAA Ceph accepts only an owner-staged SecretRef and never raw connection credentials', () => {
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

test('Ceph observer snapshot is reduced to a stable UI contract without exposing the raw FSID', () => {
  const fsid = '12345678-1234-4234-9234-123456789abc';
  const snapshot = {
    schemaVersion: 1,
    observedAt: '2026-07-26T12:00:00Z',
    durationMs: 240,
    cached: false,
    results: {
      status: {
        available: true,
        data: {
          fsid,
          health: { status: 'HEALTH_OK' },
          monmap: { num_mons: 3 },
          mgrmap: { active_name: 'mgr-a', standbys: [{ name: 'mgr-b' }] },
          osdmap: { osdmap: { num_osds: 3, num_up_osds: 2, num_in_osds: 3 } },
          pgmap: { num_pgs: 64 },
        },
      },
      health: { available: true, data: { status: 'HEALTH_OK', checks: {} } },
      capacity: {
        available: true,
        data: {
          stats: { total_bytes: 1000, total_used_bytes: 250, total_avail_bytes: 750 },
          pools: [{ id: 7, name: 'opensphere', stats: { bytes_used: 100, stored: 80, max_avail: 900, objects: 12, percent_used: 10 } }],
        },
      },
      osds: {
        available: true,
        data: {
          nodes: [
            { id: -3, name: 'ceph-a', type: 'host', children: [0, 1] },
            { id: 0, name: 'osd.0', type: 'osd', status: 'up', reweight: 1, utilization: 10, kb: 100, kb_used: 10, kb_avail: 90, device_class: 'ssd' },
            { id: 1, name: 'osd.1', type: 'osd', status: 'down', reweight: 1, utilization: 20, kb: 100, kb_used: 20, kb_avail: 80, device_class: 'ssd' },
          ],
        },
      },
      pgs: {
        available: true,
        data: {
          pg_ready: true,
          pg_summary: {
            num_pgs: 64,
            num_pg_by_state: [
              { name: 'active+clean', num: 63 },
              { name: 'active+degraded', num: 1 },
            ],
          },
        },
      },
      hosts: { available: true, data: [{ hostname: 'ceph-a', addr: '10.0.0.11', labels: ['mon'], status: '' }] },
      services: { available: true, data: [{ daemon_type: 'mon', daemon_id: 'a', hostname: 'ceph-a', status: 1, status_desc: 'running', version: 'ceph version 20.2.1' }] },
      versions: { available: true, data: { mon: { 'ceph version 20.2.1': 3 } } },
    },
  };

  const insights = normalizeCephInsights(snapshot);
  const encoded = JSON.stringify(insights);
  assert.equal(insights.cluster.health, 'HEALTH_OK');
  assert.equal(insights.cluster.monitors, 3);
  assert.equal(insights.capacity.percentUsed, 25);
  assert.equal(insights.osds.total, 3);
  assert.equal(insights.osds.up, 2);
  assert.equal(insights.osds.down, 1);
  assert.equal(insights.osds.items[0].host, 'ceph-a');
  assert.equal(insights.pgs.healthy, 63);
  assert.equal(insights.pgs.unhealthy, 1);
  assert.equal(insights.hosts[0].address, '10.0.0.11');
  assert.equal(insights.services[0].type, 'mon');
  assert.equal(insights.partial, false);
  assert.equal(insights.cluster.fsidFingerprint.length, 16);
  assert.ok(!encoded.includes(fsid));
});

test('Ceph insights preserve available sections and explain permission-limited sections', () => {
  const unavailable = { available: false, reason: 'PermissionDenied', message: 'raw observer text' };
  const snapshot = {
    schemaVersion: 1,
    observedAt: '2026-07-26T12:00:00Z',
    results: {
      status: { available: true, data: { health: { status: 'HEALTH_WARN' } } },
      health: { available: true, data: { status: 'HEALTH_WARN' } },
      capacity: { available: true, data: { stats: { total_bytes: 100, total_used_bytes: 10, total_avail_bytes: 90 }, pools: [] } },
      osds: { available: true, data: { nodes: [] } },
      pgs: { available: true, data: { num_pgs: 0, pgs_by_state: [] } },
      hosts: unavailable,
      services: unavailable,
      versions: unavailable,
    },
  };
  const insights = normalizeCephInsights(snapshot);
  assert.equal(insights.partial, true);
  assert.equal(insights.capacity.percentUsed, 10);
  assert.deepEqual(insights.hosts, []);
  assert.deepEqual(insights.services, []);
  assert.ok(insights.sectionErrors.some((item) => item.section === 'hosts' && item.reason === 'PermissionDenied'));
  assert.ok(!JSON.stringify(insights).includes('raw observer text'));
});

test('Ceph insights endpoint is fixed, read-only, bounded, and accepts no command input', () => {
  assert.match(source, /pathname === '\/api\/ceph\/oaa\/insights'/);
  assert.match(source, /CEPH_OBSERVER_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(source, /AbortSignal\.timeout\(25_000\)/);
  assert.match(source, /searchParams\.get\('refresh'\) === '1'/);
  assert.doesNotMatch(source, /CEPH_OBSERVER_URL[^]*searchParams\.get\('command'\)/);
});

test('Ceph observer is digest-pinned, fixed-command, keyfile-only, and network bounded', () => {
  const observer = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-chart/files/ceph-observer.py'), 'utf8');
  const manifest = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-chart/templates/observer.yaml'), 'utf8');
  const prerequisite = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-prerequisite-reconciler.yaml'), 'utf8');
  assert.match(observer, /"status": \["status"\]/);
  assert.match(observer, /"capacity": \["df", "detail"\]/);
  assert.match(observer, /"hosts": \["orch", "host", "ls"\]/);
  assert.match(observer, /"services": \["orch", "ps"\]/);
  assert.match(observer, /"--conf",\s*"\/dev\/null"/);
  assert.match(observer, /"--keyfile",\s*USER_KEY_FILE/);
  assert.doesNotMatch(observer, /shell\s*=\s*True/);
  assert.doesNotMatch(observer, /parse_qs\(parsed\.query\)\.get\(["']command["']/);
  assert.match(manifest, /quay\.io\/cephcsi\/cephcsi@sha256:886e6d2416d62dd7c8fbe659b6306b6c9451d6918e35ad5d1ac774520e11ef87/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /checksum\/observer-script/);
  assert.match(manifest, /kind: NetworkPolicy[^]*kubernetes\.io\/metadata\.name: opensphere-console[^]*app: cluster-manager/);
  assert.match(prerequisite, /resources: \[serviceaccounts, services, configmaps, secrets, pods\]/);
  assert.match(prerequisite, /resources: \[networkpolicies\]/);
});
