'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCephManager,
  validateProviderExport,
  validateConnectionInput,
  validateCephFsInput,
  cephStorageServiceDiagnostics,
  planFor,
  storageClassManifest,
  snapshotClassManifest,
  parseMetadata,
  statusConnectionProjection,
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
    // 감사 H-02: 역할별로 분리된 CephX 계정·key. 재사용은 서버가 거부한다.
    operatorUserID: 'opensphere-healthchecker',
    operatorUserKey: 'AQDoperator0123456789abcdefgh==',
    provisionerUserID: 'opensphere-rbd-provisioner',
    provisionerUserKey: 'AQDprovisioner0123456789abcd==',
    nodeUserID: 'opensphere-rbd-node',
    nodeUserKey: 'AQDnode0123456789abcdefghijk==',
    observerUserID: 'opensphere-observer',
    observerUserKey: 'AQDobserver0123456789abcdefg==',
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
  // 감사 H-02: 단일 userID/userKey 대신 역할별 자격 증명을 수집한다.
  assert.match(component, /role\.id \+ 'UserID'/);
  assert.match(component, /role\.id \+ 'UserKey'/);
  assert.doesNotMatch(component, /name="userID"/);
  assert.doesNotMatch(component, /name="userKey"/);
  for (const role of ['operator', 'provisioner', 'node', 'observer']) {
    assert.match(component, new RegExp(`id: '${role}'`), `${role} 역할 입력이 있어야 한다`);
  }
  assert.match(component, /duplicateRoleCredential/);
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

test('Ceph insights title bar is isolated from host header rules and remains responsive', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-insights.component.ts'), 'utf8');
  const styles = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-insights.component.css'), 'utf8');
  const hero = component.slice(component.indexOf('<div class="insights-hero">'), component.indexOf('<div *ngIf="error"'));
  assert.match(hero, /<div class="insights-hero">/);
  assert.match(hero, /class="insights-copy"/);
  assert.doesNotMatch(hero, /<header class="insights-hero">/);
  assert.match(styles, /\.insights-hero\s*\{[^}]*display: grid[^}]*grid-template-columns: minmax\(0, 1fr\) auto[^}]*height: auto[^}]*min-height: 108px[^}]*overflow: visible/s);
  assert.match(styles, /\.insights-identity\s*\{[^}]*grid-template-columns: 64px minmax\(0, 1fr\)/s);
  assert.match(styles, /@media \(max-width: 760px\)[^]*\.insights-hero\s*\{[^}]*grid-template-columns: 1fr[^}]*min-height: 0/s);
  assert.match(styles, /\.refresh-button\s*\{[^}]*align-self: center/s);
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
  // 역할별 신원이 각자의 Secret에 들어가고 서로 섞이지 않는다(감사 H-02).
  assert.equal(connection.cephEntity, 'client.opensphere-healthchecker');
  assert.equal(connection.csiUserID, 'opensphere-rbd-provisioner');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-ceph-operator-creds').data.userID, 'client.opensphere-healthchecker');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-provisioner').data.userID, 'opensphere-rbd-provisioner');
  assert.equal(connection.secrets.find((item) => item.name === 'rook-csi-rbd-node').data.userID, 'opensphere-rbd-node');
  assert.equal(connection.secrets.find((item) => item.name === 'opensphere-ceph-observer-creds').data.userID, 'client.opensphere-observer');
  // 역할별 key가 서로 달라야 한다 — 이것이 H-02의 핵심 불변식이다.
  const roleKeys = ['rook-ceph-operator-creds', 'rook-csi-rbd-provisioner', 'rook-csi-rbd-node', 'opensphere-ceph-observer-creds']
    .map((name) => connection.secrets.find((item) => item.name === name).data.userKey);
  assert.equal(new Set(roleKeys).size, roleKeys.length, '역할별 CephX key는 서로 달라야 한다');
  const qualified = validateConnectionInput({ ...connectionInput(), operatorUserID: 'client.opensphere-healthchecker' });
  assert.equal(qualified.cephEntity, connection.cephEntity);
  assert.equal(connection.storageClasses[0].data.pool, 'kubernetes-rbd');
  assert.equal(connection.secrets.length, 5);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), clusterID: 'not-a-uuid' }), /UUID 형식/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), monitors: '10.0.0.11:443' }), /형식이 올바르지 않습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), nodeUserID: 'admin' }), /client\.admin은 사용할 수 없습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), provisionerUserID: 'client.admin' }), /client\.admin은 사용할 수 없습니다/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), operatorUserID: 'mon.opensphere' }), /Ceph client 엔티티/);
  assert.throws(() => validateConnectionInput({ ...connectionInput(), extra: 'rejected' }), /허용되지 않은 필드/);
});

test('H-02: reusing one CephX account or key across roles is rejected', () => {
  const base = connectionInput();
  // 같은 key를 두 역할이 공유하면 거부한다(감사 시점의 실제 구성이 이 형태였다).
  assert.throws(
    () => validateConnectionInput({ ...base, nodeUserKey: base.provisionerUserKey }),
    /동일한 CephX key/,
  );
  assert.throws(
    () => validateConnectionInput({ ...base, observerUserKey: base.operatorUserKey }),
    /동일한 CephX key/,
  );
  // 같은 사용자 신원을 두 역할이 공유해도 거부한다(client. 접두어 유무와 무관).
  assert.throws(
    () => validateConnectionInput({ ...base, nodeUserID: base.provisionerUserID }),
    /동일한 CephX 사용자/,
  );
  assert.throws(
    () => validateConnectionInput({ ...base, observerUserID: `client.${base.operatorUserID}` }),
    /동일한 CephX 사용자/,
  );
  // 오류 메시지에 key 값이 새지 않는다.
  try {
    validateConnectionInput({ ...base, nodeUserKey: base.provisionerUserKey });
  } catch (failure) {
    assert.ok(!String(failure.message).includes(base.provisionerUserKey));
  }
});

test('H-02: the read-only observer no longer mounts the Rook operator credential', () => {
  const manifest = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-chart/templates/observer.yaml'), 'utf8');
  assert.match(manifest, /secretName: opensphere-ceph-observer-creds/);
  assert.doesNotMatch(manifest, /secretName: rook-ceph-operator-creds/);
  // 연결 해제 시 관측기 자격 증명도 정리 대상이어야 한다.
  assert.match(source, /MANAGED_SECRETS = new Set\(\[\.\.\.SECRET_NAMES, OBSERVER_SECRET\]\)/);
  assert.match(source, /if \(MANAGED_SECRETS\.has\(name\)\)/);
});

test('direct connection plan never exposes the CephX key', () => {
  const input = connectionInput();
  const plan = planFor(validateConnectionInput(input), true);
  const text = JSON.stringify(plan);
  assert.equal(plan.clusterID, input.clusterID);
  assert.deepEqual(plan.monitors, ['10.0.0.11:3300', '10.0.0.12:3300', '10.0.0.13:3300']);
  assert.equal(plan.cephEntity, 'client.opensphere-healthchecker');
  assert.equal(plan.csiUserID, input.provisionerUserID);
  assert.equal(plan.userID, input.provisionerUserID);
  // 어떤 역할의 key도 계획에 노출되지 않아야 한다.
  for (const key of [input.operatorUserKey, input.provisionerUserKey, input.nodeUserKey, input.observerUserKey]) {
    assert.ok(!text.includes(key), '계획에 CephX key가 포함되면 안 된다');
  }
  assert.match(source, /\['connection', 'confirm', 'reason'\]/);
  assert.match(source, /validateConnectionInput\(body\.connection\)/);
});

test('installed Ceph CSI services distinguish driver registration from usable StorageClass configuration', () => {
  const drivers = [
    { metadata: { name: 'rook-ceph.rbd.csi.ceph.com' } },
    { metadata: { name: 'rook-ceph.cephfs.csi.ceph.com' } },
  ];
  const storageClasses = [{
    metadata: { name: 'ceph-rbd' },
    provisioner: 'rook-ceph.rbd.csi.ceph.com',
    reclaimPolicy: 'Retain',
    volumeBindingMode: 'WaitForFirstConsumer',
    parameters: {
      pool: 'opensphere-dev',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node',
    },
  }];
  const coverage = cephStorageServiceDiagnostics(
    drivers,
    storageClasses,
    [
      { metadata: { name: 'rook-csi-rbd-provisioner' }, data: { userID: 'b3BlbnNwaGVyZQ==', userKey: 'a2V5' } },
      { metadata: { name: 'rook-csi-rbd-node' }, data: { userID: 'b3BlbnNwaGVyZQ==', userKey: 'a2V5' } },
    ],
  );
  assert.equal(coverage.installed, 2);
  assert.equal(coverage.configured, 1);
  assert.equal(coverage.verified, 0);
  assert.equal(coverage.ready, 0);
  assert.equal(coverage.needsConfiguration, 1);
  assert.equal(coverage.state, 'NeedsConfiguration');
  assert.equal(coverage.services.find((item) => item.id === 'rbd').state, 'ConfiguredUnverified');
  const cephfs = coverage.services.find((item) => item.id === 'cephfs');
  assert.equal(cephfs.state, 'NeedsConfiguration');
  assert.match(cephfs.blockers.join(' '), /StorageClass/);
  assert.ok(cephfs.providerRequirements.some((item) => item.id === 'filesystem'));
  assert.ok(cephfs.providerRequirements.some((item) => item.id === 'node-user-key' && item.secret));
});

test('CephFS service configuration creates separate restricted CSI credentials without exposing keys', () => {
  const input = {
    filesystem: 'shared-fs',
    pool: 'shared-fs-data0',
    provisionerUserID: 'client.opensphere-cephfs-provisioner',
    provisionerUserKey: 'AQDprovisioner0123456789abcdef==',
    nodeUserID: 'opensphere-cephfs-node',
    nodeUserKey: 'AQDnode0123456789abcdefghijkl==',
    storageClassName: 'cephfs-shared',
  };
  const configuration = validateCephFsInput(input);
  assert.equal(configuration.storageClass.name, 'cephfs-shared');
  assert.equal(configuration.storageClass.data.fsName, 'shared-fs');
  assert.equal(configuration.storageClass.data.pool, 'shared-fs-data0');
  assert.equal(configuration.secrets.find((item) => item.name === 'rook-csi-cephfs-provisioner').data.userID, 'opensphere-cephfs-provisioner');
  assert.equal(configuration.secrets.find((item) => item.name === 'rook-csi-cephfs-node').data.userID, 'opensphere-cephfs-node');
  assert.ok(!JSON.stringify(configuration.audit).includes(input.provisionerUserKey));
  assert.ok(!JSON.stringify(configuration.audit).includes(input.nodeUserKey));
  const manifest = storageClassManifest(configuration.storageClass);
  assert.equal(manifest.provisioner, 'rook-ceph.cephfs.csi.ceph.com');
  assert.equal(manifest.parameters.fsName, 'shared-fs');
  assert.throws(() => validateCephFsInput({ ...input, provisionerUserID: 'client.admin' }), /client\.admin/);
});

test('Ceph UI reports every installed storage service and provides actionable provider requirements', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const service = fs.readFileSync(path.resolve(__dirname, '../src/app/core/ceph.service.ts'), 'utf8');
  assert.match(component, /Ceph 스토리지 서비스 준비도/);
  assert.match(component, /activeTab\(\) === 'services'/);
  assert.match(component, /스토리지 서비스/);
  assert.match(component, /align-items: stretch/);
  assert.match(component, /--ceph-body-font-size: 0\.72rem/);
  assert.match(component, /\.cm-ceph-summary \{[^}]*font-size: var\(--ceph-body-font-size\)/);
  assert.match(component, /\.dependency, \.connection-card, \.empty-state, \.readiness-board, \.service-coverage \{[^}]*font-size: var\(--ceph-body-font-size\)/);
  assert.match(component, /storage-service-header/);
  assert.doesNotMatch(component, /class="service-card-head"/);
  assert.doesNotMatch(component, /class="coverage-badge"/);
  assert.match(component, /<details class="provider-request-details">/);
  assert.match(component, /요청 정보와 권한 조건 보기/);
  assert.match(component, /\.provider-request \{[^}]*background: transparent/);
  assert.match(component, /\.service-blockers \{[^}]*#f1c21b/);
  assert.match(component, /구성 완료만으로 실사용 검증 완료로 계산하지 않습니다/);
  assert.match(component, /구성 완료 · 미검증/);
  assert.match(component, /Ceph 관리자에게 요청할 정보/);
  assert.match(component, /요청 문구 복사/);
  assert.match(component, /CephFS 구성 추가/);
  assert.match(component, /CephFS 공유 파일 스토리지 구성/);
  assert.match(component, /Provisioner User ID/);
  assert.match(component, /Node User ID/);
  assert.match(component, /실제 읽기·쓰기 mount 검증/);
  assert.match(service, /CephServiceCoverage/);
  assert.match(service, /configureCephFs/);
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
  assert.match(component, /scheduleStatusPoll\(10_000\)/);
  assert.match(component, /statusPollWarning/);
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

test('status exposes current non-secret Ceph connection values and never the user key', () => {
  const metadata = {
    schemaVersion: 1,
    mode: 'RookExternal',
    fsid: '12345678-1234-4234-9234-123456789abc',
    fsidFingerprint: 'fingerprint',
    storageClasses: ['ceph-rbd'],
    secretRefs: ['rook-ceph/rook-csi-rbd-provisioner'],
  };
  const monitorConfig = { data: { data: 'a=10.0.0.11:3300,b=10.0.0.12:3300,c=10.0.0.13:3300' } };
  const classes = [{
    metadata: { name: 'ceph-rbd' },
    provisioner: 'rook-ceph.rbd.csi.ceph.com',
    parameters: {
      pool: 'kubernetes-rbd',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
    },
  }];
  const secrets = [{
    metadata: { name: 'rook-csi-rbd-provisioner' },
    data: {
      userID: Buffer.from('opensphere').toString('base64'),
      userKey: Buffer.from('AQD-secret-value').toString('base64'),
    },
  }];
  const projection = statusConnectionProjection(metadata, monitorConfig, classes, secrets);
  // 감사 H-03 / CONSTITUTION-0004 규정 6.5: 원문 FSID는 Console에 남기지 않고 fingerprint만 노출한다.
  assert.ok(!Object.hasOwn(projection, 'clusterID'), 'status 응답에 원문 FSID 필드가 없어야 한다');
  assert.ok(!JSON.stringify(projection).includes(metadata.fsid), '원문 FSID 값이 응답에 포함되면 안 된다');
  assert.equal(projection.fsidFingerprint, 'fingerprint');
  assert.deepEqual(projection.monitors, ['10.0.0.11:3300', '10.0.0.12:3300', '10.0.0.13:3300']);
  assert.equal(projection.userID, 'opensphere');
  assert.equal(projection.pool, 'kubernetes-rbd');
  assert.ok(!JSON.stringify(projection).includes('AQD-secret-value'));
  assert.ok(!Object.hasOwn(projection, 'userKey'));
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
  // secrets와 configmaps는 더 이상 하나의 무제한 규칙을 공유하지 않는다(감사 C-02).
  // configmaps는 이름 한정, secrets는 Helm 릴리스 저장 때문에 이름 한정이 불가하다.
  assert.match(runtimeOwnerManifest, /resources: \[configmaps\]/);
  assert.match(runtimeOwnerManifest, /resources: \[secrets\]/);
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

test('Ceph insights tolerates transient proxy authorization failures without retrying permission denials', () => {
  const service = fs.readFileSync(path.resolve(__dirname, '../src/app/core/ceph.service.ts'), 'utf8');
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const insights = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-insights.component.ts'), 'utf8');
  assert.match(service, /retry\(\{[^]*count: 2[^]*\[0, 500, 502, 503, 504\]\.includes\(status\)/);
  assert.doesNotMatch(service, /\[0, 401, 403,/);
  assert.match(component, /scheduleInsightsPoll\(60_000\)/);
  assert.match(component, /15_000 \* \(2 \*\* Math\.min\(this\.insightsPollFailures - 1, 4\)\)/);
  assert.match(component, /Console 권한 확인 또는 Ceph 관측 경로가 일시적으로 응답하지 않습니다/);
  assert.match(insights, /마지막으로 확인된 관측값을 계속 표시합니다/);
});

test('Ceph insights keeps legacy runtime observable while reporting the missing application-auth boundary', () => {
  assert.match(source, /const authenticated = observerToken\.length >= 32/);
  assert.match(source, /mode: 'LegacyUnauthenticated'/);
  assert.match(source, /authenticated \? \{ 'x-opensphere-observer-token': observerToken \} : \{\}/);
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-insights.component.ts'), 'utf8');
  assert.match(component, /관측 보안 전환 대기/);
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

/* ── 감사 시정 회귀 테스트 (2026-07-26 외부 기술감사 C-01·C-02·C-03) ───────────── */

test('C-03: legacy direct API cannot bypass the AAL2 + console.ceph.manage gate', async () => {
  // 저권한 actor: 관리자 group 소속이지만 console.ceph.manage 없음, AAL2 미인증.
  const actor = { username: 'probe', groups: ['console-admins'], permissions: [], assurance: 'aal1' };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, statusText: 'stub', text: async () => '{}' });
  const handle = createCephManager({
    verifyToken: async () => actor,
    requestToken: () => 'stub',
    token: () => 'stub',
    apiServer: 'https://kubernetes.invalid',
    controller: 'https://controller.invalid',
    consoleBackend: 'https://console.invalid',
    publishNotify: async () => {},
    jsonRes: (res, code, body) => { res.code = code; res.body = body; },
  });
  const request = (method, body) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = { method, url: '/', headers: {}, destroy() {}, on(event, cb) { if (event === 'data') cb(payload); if (event === 'end') cb(); return req; } };
    return req;
  };
  try {
    // 변경을 수행하던 legacy 경로는 제거되어 410을 반환해야 한다.
    for (const pathname of ['/api/ceph/connect', '/api/ceph/disconnect']) {
      const res = {};
      await handle(request('POST', { connection: {}, reason: 'audit regression probe' }), res, pathname);
      assert.equal(res.code, 410, `${pathname}는 제거되어야 한다`);
    }
    // 남은 legacy 경로는 OAA 읽기 권한을 강제해야 한다(403).
    for (const [method, pathname] of [['POST', '/api/ceph/plan'], ['GET', '/api/ceph/status']]) {
      const res = {};
      await handle(request(method, { connection: {} }), res, pathname);
      assert.equal(res.code, 403, `${pathname}는 console.ceph.read를 요구해야 한다`);
    }
  } finally { global.fetch = originalFetch; }
});

test('C-03: mutating legacy connect/disconnect handlers are removed from the source', () => {
  // legacy 경로는 410을 반환하는 단일 분기로만 남아야 한다.
  assert.match(source, /pathname === '\/api\/ceph\/connect' \|\| pathname === '\/api\/ceph\/disconnect'\)[^]*?410/);
  // legacy 변경 핸들러가 사용하던 audit action이 남아 있으면 핸들러도 남아 있는 것이다.
  // (OAA 경로는 OAACephExternal* 접두사를 사용하므로 이 검사와 충돌하지 않는다.)
  assert.doesNotMatch(source, /auditRequired\([^)]*'CephExternalConnectRequested'/);
  assert.doesNotMatch(source, /auditRequired\([^)]*'CephExternalDisconnectRequested'/);
  // legacy 경로에서 installConnection/disconnect를 직접 호출하지 않는다.
  assert.doesNotMatch(source, /String\(body\.confirm \|\| ''\) !== 'DISCONNECT'/);
  // 남은 legacy 경로는 group 검사(actorFor)가 아니라 OAA 인가를 사용해야 한다.
  assert.match(source, /pathname === '\/api\/ceph\/status'\) \{\s*await actorForOaaOwner\(ctx, req, false\)/);
  assert.match(source, /pathname === '\/api\/ceph\/plan'\) \{\s*await actorForOaaOwner\(ctx, req, false\)/);
});

test('C-02: runtime RBAC limits ConfigMap mutation to the managed names', () => {
  // 이름 제한이 없으면 rook-csi-operator-image-set-configmap patch로 전 노드 privileged 실행이 가능하다.
  assert.match(runtimeOwnerManifest, /resources: \[configmaps\][^]*resourceNames:/);
  for (const name of ['opensphere-ceph-connection', 'opensphere-ceph-operation', 'rook-ceph-mon-endpoints']) {
    assert.match(runtimeOwnerManifest, new RegExp(`resourceNames:[^]*- ${name}`));
  }
  // secrets와 configmaps를 하나의 무제한 규칙으로 합치면 안 된다.
  assert.doesNotMatch(runtimeOwnerManifest, /resources: \[secrets, configmaps\]/);
  // 이름 한정 권한과 selfCanI 검사 대상이 어긋나면 선행요소 점검이 오탐한다.
  assert.match(source, /MANAGED_CONFIGMAPS = Object\.freeze\(\[CONNECTION_CONFIGMAP, OPERATION_CONFIGMAP, 'rook-ceph-mon-endpoints'\]\)/);
  assert.match(source, /MANAGED_CONFIGMAPS\.map\(\(name\) => \[verb, '', 'configmaps', NAMESPACE, name\]\)/);
});

test('C-01: node prerequisite DaemonSet drops privileged and is disclosed before approval', () => {
  const daemonSet = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-chart/templates/nbd-device-preparer.yaml'), 'utf8');
  const ui = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  const reconciler = fs.readFileSync(path.resolve(__dirname, '../ceph-prerequisite-reconciler.js'), 'utf8');
  // privileged 대신 필요한 capability만 부여한다.
  assert.match(daemonSet, /privileged: false/);
  assert.doesNotMatch(daemonSet, /privileged: true/);
  assert.match(daemonSet, /allowPrivilegeEscalation: false/);
  assert.match(daemonSet, /add: \[SYS_MODULE, MKNOD\]/);
  assert.match(daemonSet, /drop: \[ALL\]/);
  // 모든 taint를 무시하지 않으며 control-plane에는 배치하지 않는다.
  assert.doesNotMatch(daemonSet, /tolerations:/);
  assert.doesNotMatch(daemonSet, /priorityClassName: system-node-critical/);
  assert.match(daemonSet, /kubernetes\.io\/os: linux/);
  assert.match(daemonSet, /key: node-role\.kubernetes\.io\/control-plane\s*\n\s*operator: DoesNotExist/);
  // 전용 SA + 토큰 미마운트.
  assert.match(daemonSet, /serviceAccountName: opensphere-ceph-nbd-preparer/);
  assert.match(daemonSet, /automountServiceAccountToken: false/);
  // 승인 화면이 상승 권한을 고지하고 명시적 동의를 요구한다.
  assert.match(ui, /opensphere-ceph-nbd-preparer/);
  assert.match(ui, /elevatedScopeAcknowledged/);
  assert.match(ui, /!elevatedScopeAcknowledged" \(click\)="requestPrerequisiteInstall\(\)"/);
  // 거버넌스 계약이 실제 설치물을 기술한다.
  assert.match(reconciler, /'runtime-rbac', 'nbd-preparer'/);
  assert.match(reconciler, /elevatedPrivileges/);
});

test('H-01: StorageClass admission policy uses API-server-valid DELETE object selection', () => {
  const admission = fs.readFileSync(path.resolve(__dirname, '../deploy/ceph-runtime-chart/templates/consumer-storage-admission.yaml'), 'utf8');
  assert.match(admission, /expression: "object != null \? object : oldObject"/);
  assert.doesNotMatch(admission, /has\(object\)/);
});

test('H-02: role guidance requires official restricted export and forbids unscoped OSD read', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph.component.ts'), 'utf8');
  assert.match(ui, /Rook v1\.20 restricted export/);
  assert.match(ui, /pool 제한 없는 osd allow r 권한은 발급하지 않습니다/);
  assert.doesNotMatch(ui, /osd 'allow r'/);
});

test('H-04: each mutation has a bounded durable Kubernetes terminal audit mirror', () => {
  assert.match(source, /async function recordDurableOperation/);
  assert.match(source, /slice\(0, 50\)/);
  assert.match(source, /await recordDurableOperation\(ctx, actor, action, 'requested'/);
  assert.match(source, /await recordDurableOperation\(ctx, actor, action, terminalResult/);
  assert.match(source, /Ceph 변경은 수행되었으나 최종 작업 상태 기록에 실패했습니다/);
  assert.match(source, /redactedAuditMetadata/);
});

test('Ceph Monitoring dashboards live in the second-level navigation tree with a fixed Grafana allowlist', () => {
  const nav = fs.readFileSync(path.resolve(__dirname, '../src/app/nav.ts'), 'utf8');
  const app = fs.readFileSync(path.resolve(__dirname, '../src/app/app.component.ts'), 'utf8');
  const catalog = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-monitoring.catalog.ts'), 'utf8');
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-monitoring.component.ts'), 'utf8');

  assert.match(nav, /id: 'ceph-monitoring',\s*label: 'Ceph Monitoring'/);
  assert.match(nav, /tree: CEPH_DASHBOARD_GROUPS\.map/);
  assert.match(nav, /id: `ceph-monitoring-\$\{dashboard\.uid\}`/);
  assert.match(app, /class="cm-tree-root"/);
  assert.match(app, /class="cm-tree-section"/);
  assert.match(app, /\[ngComponentOutletInputs\]="activeInputs\(\)"/);
  assert.match(app, /findNavLocation/);
  assert.match(catalog, /CEPH_GRAFANA_ORIGIN = 'https:\/\/ceph\.triangles\.com'/);
  assert.match(catalog, /CEPH_GRAFANA_BASE_PATH = '\/grafana'/);
  assert.match(catalog, /uid: 'edtb0oxdq'/);
  assert.match(catalog, /uid: '718Bruins'/);
  assert.match(catalog, /uid: '41FrpeUiz'/);
  assert.match(catalog, /uid: 'WAkugZpiz'/);
  assert.match(component, /readonly dashboardUid = input/);
  assert.match(component, /CEPH_DASHBOARDS\.find\(dashboard => dashboard\.uid === this\.dashboardUid\(\)\)/);
  assert.match(component, /\[selected\]="item\.value === range\(\)"/);
  assert.match(component, /\[selected\]="item\.value === refresh\(\)"/);
  assert.doesNotMatch(component, /dashboard-menu|dashboard-groups|Dashboard 검색/);
  assert.doesNotMatch(component, /searchParams|get\('url'\)|location\.search/);
});

test('Ceph Monitoring embeds read-only Grafana with explicit browser security boundaries', () => {
  const component = fs.readFileSync(path.resolve(__dirname, '../src/app/resources/ceph-monitoring.component.ts'), 'utf8');

  assert.doesNotMatch(component, /sandbox=/);
  assert.match(component, /referrerpolicy="no-referrer"/);
  assert.match(component, /rel="noopener noreferrer"/);
  assert.match(component, /anonymous Viewer/);
  assert.match(component, /조직 Root CA를 신뢰 저장소에 등록/);
  assert.match(component, /params\.append\('kiosk', ''\)/);
  assert.match(component, /refresh: this\.refresh\(\)/);
});
