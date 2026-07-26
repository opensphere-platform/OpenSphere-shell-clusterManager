'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const {
  readJson,
  reasonFrom,
  safeError,
  command,
  withKubeconfig,
} = require('./his-manager');

const ADMIN_GROUPS = new Set(
  String(process.env.CONSOLE_ADMIN_GROUPS || 'console-admins,opensphere-console-admins')
    .split(',').map((value) => value.trim()).filter(Boolean),
);
const NAMESPACE = 'rook-ceph';
const IMPORT_NAMESPACE = 'opensphere-ceph-imports';
const OPERATOR_RELEASE = 'rook-ceph';
const CLUSTER_RELEASE = 'rook-ceph-external';
const CONNECTION_CONFIGMAP = 'opensphere-ceph-connection';
const OPERATION_CONFIGMAP = 'opensphere-ceph-operation';
const OBSERVER_EGRESS_POLICY = 'opensphere-ceph-observer-egress';
// runtime-owner.yaml의 이름 한정 ConfigMap 권한과 1:1로 대응한다. 두 목록은 함께 변경해야 한다.
const MANAGED_CONFIGMAPS = Object.freeze([CONNECTION_CONFIGMAP, OPERATION_CONFIGMAP, 'rook-ceph-mon-endpoints']);
// Consumer StorageClass 이름의 소유 규칙(감사 H-01).
// cluster-scope 자원이라 이름을 통제하지 않으면 임의 StorageClass를 변조·삭제하거나
// 클러스터 기본 StorageClass를 탈취할 수 있다. 다중 filesystem/pool 운용을 유지하기 위해
// 닫힌 집합이 아니라 접두사 규칙을 쓴다: `ceph-rbd`, `cephfs` 또는 그 하위 `<base>-<suffix>`.
// RBAC의 resourceNames는 접두사를 표현할 수 없으므로 실제 경계는
// deploy/ceph-consumer-storage-admission.yaml의 ValidatingAdmissionPolicy가 강제한다.
// 두 곳의 규칙은 반드시 함께 변경해야 한다.
const MANAGED_STORAGE_CLASS_BASES = Object.freeze(['ceph-rbd', 'cephfs']);

function managedStorageClassName(value, fallback, label) {
  const name = safeName(value || fallback, label);
  if (name.length > 240) throw error(`${label}은 240자 이하여야 합니다.`);
  const owned = MANAGED_STORAGE_CLASS_BASES.some((base) => name === base || name.startsWith(`${base}-`));
  if (!owned) {
    throw error(`${label}은 ${MANAGED_STORAGE_CLASS_BASES.map((base) => `'${base}'`).join(' 또는 ')}로 시작해야 합니다(예: cephfs-shared). Cluster Manager는 이 접두사의 StorageClass만 소유합니다.`);
  }
  return name;
}
const CHART_VERSION = 'v1.20.2';
const CLUSTER_CHART = process.env.ROOK_CLUSTER_CHART || `/app/ceph-charts/rook-ceph-cluster-${CHART_VERSION}.tgz`;
const activeOperations = new Set();
const CSI_CRDS = Object.freeze([
  'cephconnections.csi.ceph.io',
  'clientprofiles.csi.ceph.io',
  'clientprofilemappings.csi.ceph.io',
  'drivers.csi.ceph.io',
  'operatorconfigs.csi.ceph.io',
]);
const OAA_CEPH_READ_PERMISSION = 'console.ceph.read';
const OAA_CEPH_MANAGE_PERMISSION = 'console.ceph.manage';
const IMPORT_SECRET_TYPE = 'opensphere.io/ceph-provider-export';
const IMPORT_TTL_MS = 60 * 60 * 1000;
const IMPORT_NAME_RE = /^opensphere-ceph-import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CEPH_OBSERVER_URL = String(
  process.env.CEPH_OBSERVER_URL || 'http://opensphere-ceph-observer.rook-ceph.svc.cluster.local:8080',
).replace(/\/+$/, '');
const CEPH_OBSERVER_MAX_BYTES = 4 * 1024 * 1024;
const OBSERVER_API_SECRET = 'opensphere-ceph-observer-api-auth';
const importCleanupHealth = {
  totalFailures: 0,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastError: null,
};

const MANAGED_LABELS = Object.freeze({
  'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
  'opensphere.io/ceph-connection': 'external',
});

// Rook provider export에서 수용하는 Secret 이름(외부에서 들어오는 값의 allowlist).
const SECRET_NAMES = new Set([
  'rook-ceph-mon',
  'rook-ceph-operator-creds',
  'rook-csi-rbd-node',
  'rook-csi-rbd-provisioner',
  'rook-csi-cephfs-node',
  'rook-csi-cephfs-provisioner',
]);
const OBSERVER_SECRET = 'opensphere-ceph-observer-creds';
// 연결 해제 시 Cluster Manager가 정리하는 Secret 집합. observer 전용 자격 증명은
// provider export로 들어오지 않고 Cluster Manager가 생성하므로 export allowlist와 분리한다.
const MANAGED_SECRETS = new Set([...SECRET_NAMES, OBSERVER_SECRET]);
const IGNORED_EXPORTS = new Set([
  'ConfigMap/external-cluster-user-command',
  'Secret/rook-ceph-dashboard-link',
  'CephCluster/monitoring-endpoint',
]);

const PROVIDER_GUIDE = Object.freeze({
  schemaVersion: 2,
  rookVersion: CHART_VERSION,
  consumerNamespace: NAMESPACE,
  requiredInformation: [
    { id: 'fsid', label: 'Cluster ID (FSID)', description: '대상 Ceph 클러스터를 유일하게 식별하는 UUID', secret: false },
    { id: 'mon-endpoints', label: 'MON endpoint', description: '각 Monitor의 public-network 주소와 포트(msgr2 3300 권장, msgr1 6789 지원)', secret: false },
    { id: 'user-id', label: 'CephX 사용자', description: 'Ceph 엔티티(client.<id>) 또는 ceph-csi userID(<id>). 시스템이 대상별 형식으로 변환', secret: false },
    { id: 'user-key', label: 'User key', description: 'CephX 사용자 인증 key. Kubernetes Secret에만 저장', secret: true },
    { id: 'pool', label: 'RBD pool', description: 'Kubernetes 볼륨에 사용할 기존 RBD pool 이름', secret: false },
  ],
  requiredPreparation: [],
  network: {
    monitorTcpPorts: [3300, 6789],
    cephDaemonTcpRange: '6800-7568',
    sourceScope: 'all-consumer-kubernetes-nodes',
  },
  unsupportedInputs: ['client.admin keyring', 'monitor keyring', 'RGW/object-store credentials', 'Ceph dashboard credentials'],
});

const CEPH_STORAGE_SERVICES = Object.freeze([
  {
    id: 'rbd',
    name: 'RBD 블록 스토리지',
    description: 'ReadWriteOnce PVC와 가상 디스크를 제공하는 Ceph RBD 서비스',
    driverSuffix: 'rbd.csi.ceph.com',
    providerRequirements: [
      { id: 'pool', label: 'RBD pool 이름', description: 'Kubernetes 볼륨을 저장할 기존 RBD pool', secret: false },
      { id: 'user-id', label: '제한된 CephX 사용자 ID', description: 'client.<id> 또는 <id>. RBD pool 범위의 node·provisioner 권한 필요', secret: false },
      { id: 'user-key', label: 'CephX user key', description: '해당 사용자의 인증 key. Kubernetes Secret에만 저장', secret: true },
    ],
  },
  {
    id: 'cephfs',
    name: 'CephFS 공유 파일 스토리지',
    description: 'ReadWriteMany PVC와 여러 Pod의 공유 파일시스템을 제공하는 CephFS 서비스',
    driverSuffix: 'cephfs.csi.ceph.com',
    providerRequirements: [
      { id: 'filesystem', label: 'CephFS filesystem 이름', description: 'ceph fs ls에 표시되는 파일시스템 이름', secret: false },
      { id: 'pool', label: 'CephFS data pool 이름', description: 'CSI subvolume을 생성할 CephFS data pool', secret: false },
      { id: 'provisioner-user-id', label: 'Provisioner CephX 사용자 ID', description: 'subvolume 생성·삭제용 제한 계정. client.<id> 또는 <id>', secret: false },
      { id: 'provisioner-user-key', label: 'Provisioner user key', description: 'Provisioner 계정의 인증 key. Kubernetes Secret에만 저장', secret: true },
      { id: 'node-user-id', label: 'Node CephX 사용자 ID', description: 'Kubernetes node의 CephFS mount용 제한 계정. client.<id> 또는 <id>', secret: false },
      { id: 'node-user-key', label: 'Node user key', description: 'Node 계정의 인증 key. Kubernetes Secret에만 저장', secret: true },
    ],
  },
]);

function providerGuide() {
  return structuredClone(PROVIDER_GUIDE);
}

function cephStorageServiceDiagnostics(csiDrivers, storageClasses, secretResources) {
  const driverNames = new Set((csiDrivers || []).map((item) => String(item?.metadata?.name || item || '')));
  const secrets = new Map((secretResources || []).map((item) => {
    if (typeof item === 'string') return [item, null];
    return [String(item?.metadata?.name || ''), new Set(Object.keys(item?.data || {}))];
  }).filter(([name]) => name));
  const classes = Array.isArray(storageClasses) ? storageClasses : [];
  const services = CEPH_STORAGE_SERVICES.map((profile) => {
    const driver = [...driverNames].find((name) => name.endsWith(profile.driverSuffix)) || `${NAMESPACE}.${profile.driverSuffix}`;
    const driverInstalled = driverNames.has(driver);
    const matchedClasses = classes.filter((item) => String(item?.provisioner || '') === driver);
    const storageClassDetails = matchedClasses.map((item) => {
      const parameters = item?.parameters || {};
      const requiredParameters = profile.id === 'cephfs' ? ['fsName', 'pool'] : ['pool'];
      const missingParameters = requiredParameters.filter((name) => !String(parameters[name] || '').trim());
      const secretRefs = [
        parameters['csi.storage.k8s.io/provisioner-secret-name'],
        parameters['csi.storage.k8s.io/node-stage-secret-name'],
      ].map((value) => String(value || '').trim()).filter(Boolean);
      const missingSecrets = secretRefs.filter((name) => !secrets.has(name));
      const missingSecretFields = secretRefs.flatMap((name) => {
        const fields = secrets.get(name);
        if (fields === null) return [];
        return ['userID', 'userKey']
          .filter((field) => !fields?.has(field))
          .map((field) => `${name}.${field}`);
      });
      const configurationReady = (
        missingParameters.length === 0
        && secretRefs.length >= 2
        && missingSecrets.length === 0
        && missingSecretFields.length === 0
      );
      return {
        name: String(item?.metadata?.name || ''),
        provisioner: String(item?.provisioner || ''),
        reclaimPolicy: String(item?.reclaimPolicy || ''),
        volumeBindingMode: String(item?.volumeBindingMode || ''),
        pool: String(parameters.pool || ''),
        filesystem: String(parameters.fsName || ''),
        missingParameters,
        missingSecrets,
        missingSecretFields,
        configurationReady,
        verified: false,
        verifiedAt: null,
        ready: false,
      };
    });
    const configuredClasses = storageClassDetails.filter((item) => item.configurationReady);
    const blockers = [];
    if (!driverInstalled) blockers.push('CSI 드라이버가 설치되지 않았습니다.');
    if (driverInstalled && !matchedClasses.length) blockers.push('이 드라이버를 사용하는 StorageClass가 없습니다.');
    for (const item of storageClassDetails) {
      if (item.missingParameters.length) blockers.push(`StorageClass/${item.name}: ${item.missingParameters.join(', ')} 값이 없습니다.`);
      if (item.missingSecrets.length) blockers.push(`StorageClass/${item.name}: Secret ${item.missingSecrets.join(', ')}을 찾지 못했습니다.`);
      if (item.missingSecretFields.length) blockers.push(`StorageClass/${item.name}: Secret 필드 ${item.missingSecretFields.join(', ')}을 찾지 못했습니다.`);
    }
    const configured = driverInstalled && configuredClasses.length > 0;
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      driver,
      driverInstalled,
      configured,
      verified: false,
      verifiedAt: null,
      ready: false,
      state: !driverInstalled ? 'NotInstalled' : configured ? 'ConfiguredUnverified' : 'NeedsConfiguration',
      storageClasses: storageClassDetails,
      blockers,
      providerRequirements: structuredClone(profile.providerRequirements),
      nextAction: !driverInstalled
        ? '서명된 플랫폼 변경으로 CSI 드라이버를 설치하십시오.'
        : configured
          ? '구성 참조는 확인되었습니다. 승인된 테스트 PVC 또는 업무 PVC의 실제 생성·마운트 결과로 데이터 경로를 별도 검증하십시오.'
          : profile.id === 'cephfs'
            ? 'Ceph 관리자에게 아래 정보를 요청한 뒤 CephFS 구성을 추가하십시오.'
            : '누락된 pool·CephX 자격 증명과 StorageClass 구성을 보완하십시오.',
    };
  });
  const installed = services.filter((item) => item.driverInstalled);
  const configured = installed.filter((item) => item.configured);
  const verified = installed.filter((item) => item.verified);
  return {
    scope: 'CSI persistent volume services',
    installed: installed.length,
    configured: configured.length,
    verified: verified.length,
    ready: verified.length,
    needsConfiguration: installed.length - configured.length,
    state: installed.length > 0 && installed.length === configured.length ? 'ConfiguredUnverified' : 'NeedsConfiguration',
    services,
  };
}

function monitorProtocols(monitorData) {
  const text = String(monitorData || '').toLowerCase();
  const protocols = [];
  if (/v2:|:3300(?:\/|,|\]|$)/.test(text)) protocols.push('msgr2');
  if (/v1:|:6789(?:\/|,|\]|$)/.test(text)) protocols.push('msgr1');
  return protocols.length ? protocols : ['custom'];
}

function error(message, code = 400) {
  return Object.assign(new Error(message), { code });
}

function safeName(value, field = 'name') {
  const text = String(value || '').trim();
  if (!/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(text)) throw error(`${field} 값이 Kubernetes 이름 규칙에 맞지 않습니다.`);
  return text;
}

function stringMap(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(`${field} data가 객체가 아닙니다.`);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw error(`${field}.${key} 값은 문자열이어야 합니다.`);
    if (item.length > 16 * 1024) throw error(`${field}.${key} 값이 너무 큽니다.`);
    out[key] = item;
  }
  return out;
}

function onlyKeys(data, allowed, field) {
  for (const key of Object.keys(data)) if (!allowed.includes(key)) throw error(`${field}.${key} 는 허용되지 않은 필드입니다.`);
}

function parseProviderExport(input) {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > 192 * 1024) throw error('Rook provider export가 너무 큽니다.', 413);
    try { value = JSON.parse(input); } catch { throw error('Rook provider export JSON 형식이 올바르지 않습니다.'); }
  }
  if (!Array.isArray(value) || value.length < 4 || value.length > 24) {
    throw error('Rook provider export는 4~24개의 리소스 배열이어야 합니다.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw error(`provider export ${index + 1}번 항목이 객체가 아닙니다.`);
    const name = safeName(item.name, `provider export ${index + 1} name`);
    const kind = String(item.kind || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9]{1,63}$/.test(kind)) throw error(`provider export ${index + 1} kind가 올바르지 않습니다.`);
    return { name, kind, data: stringMap(item.data, `${kind}/${name}`) };
  });
}

function requiredItem(items, kind, name) {
  const found = items.find((item) => item.kind === kind && item.name === name);
  if (!found) throw error(`필수 Rook export 리소스 ${kind}/${name}가 없습니다.`);
  return found;
}

function normalizeCephClientIdentity(input, label = 'CephX 사용자') {
  const raw = String(input || '').trim();
  if (/^(?:mon|osd|mgr|mds)\./i.test(raw)) {
    throw error(`${label}는 Ceph client 엔티티여야 합니다. 예: opensphere-dev 또는 client.opensphere-dev`);
  }
  const csiUserID = raw.startsWith('client.') ? raw.slice('client.'.length) : raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(csiUserID)) {
    throw error(`${label} 형식이 올바르지 않습니다. Ceph 엔티티(client.<id>) 또는 CSI userID(<id>)를 입력하십시오.`);
  }
  if (csiUserID.toLowerCase() === 'admin') {
    throw error('client.admin은 사용할 수 없습니다. 선택한 pool에만 권한이 제한된 CephX 사용자를 입력하십시오.');
  }
  return { cephEntity: `client.${csiUserID}`, csiUserID };
}

function credential(item, expectedPrefix, target = 'entity') {
  onlyKeys(item.data, ['userID', 'userKey'], `${item.kind}/${item.name}`);
  const identity = normalizeCephClientIdentity(item.data.userID, `${item.name}의 userID`);
  if (!new RegExp(`^${expectedPrefix}(?:[-.][A-Za-z0-9.-]+)?$`).test(identity.csiUserID)) {
    throw error(`${item.name}의 userID가 예상한 ${expectedPrefix} 사용자 형식이 아닙니다.`);
  }
  const userKey = String(item.data.userKey || '');
  if (!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(userKey)) throw error(`${item.name}의 userKey 형식이 올바르지 않습니다.`);
  const userID = target === 'csi' ? identity.csiUserID : identity.cephEntity;
  return { ...identity, userID, userKey };
}

function storageClass(item, secretNames) {
  const allowed = [
    'pool', 'dataPool', 'fsName', 'mounter',
    'csi.storage.k8s.io/provisioner-secret-name',
    'csi.storage.k8s.io/controller-expand-secret-name',
    'csi.storage.k8s.io/node-stage-secret-name',
  ];
  onlyKeys(item.data, allowed, `StorageClass/${item.name}`);
  if (!/^(ceph-rbd|cephfs)$/.test(item.name)) throw error(`StorageClass/${item.name}은 현재 지원하지 않습니다.`);
  for (const key of ['pool', 'dataPool', 'fsName']) {
    if (item.data[key] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.data[key])) throw error(`StorageClass/${item.name}의 ${key} 값이 올바르지 않습니다.`);
  }
  if (!item.data.pool) throw error(`StorageClass/${item.name}에 pool이 없습니다.`);
  if (item.name === 'cephfs' && !item.data.fsName) throw error('CephFS StorageClass에 fsName이 없습니다.');
  const refs = Object.entries(item.data).filter(([key]) => key.startsWith('csi.storage.k8s.io/'));
  for (const [, name] of refs) if (!secretNames.has(name)) throw error(`StorageClass/${item.name}가 알 수 없는 Secret ${name}을 참조합니다.`);
  return item;
}

function validateProviderExport(input) {
  const items = parseProviderExport(input);
  const keys = new Set();
  for (const item of items) {
    const key = `${item.kind}/${item.name}`;
    if (keys.has(key)) throw error(`중복된 provider export 리소스 ${key}가 있습니다.`);
    keys.add(key);
  }

  const endpoints = requiredItem(items, 'ConfigMap', 'rook-ceph-mon-endpoints');
  onlyKeys(endpoints.data, ['data', 'maxMonId', 'mapping'], 'ConfigMap/rook-ceph-mon-endpoints');
  const monitorData = String(endpoints.data.data || '');
  if (!monitorData || monitorData.length > 8192 || /[\r\n;$`]/.test(monitorData)) throw error('MON endpoint data 형식이 올바르지 않습니다.');

  const mon = requiredItem(items, 'Secret', 'rook-ceph-mon');
  onlyKeys(mon.data, ['admin-secret', 'fsid', 'mon-secret'], 'Secret/rook-ceph-mon');
  const fsid = String(mon.data.fsid || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fsid)) throw error('Ceph FSID가 UUID 형식이 아닙니다.');
  if (mon.data['admin-secret'] !== 'admin-secret' || mon.data['mon-secret'] !== 'mon-secret') {
    throw error('관리자/monitor keyring이 포함된 export는 거부됩니다. 제한된 Rook external export를 생성하십시오.');
  }

  const operator = requiredItem(items, 'Secret', 'rook-ceph-operator-creds');
  const operatorCredential = credential(operator, 'healthchecker', 'entity');
  const secrets = [
    { ...operator, data: { userID: operatorCredential.cephEntity, userKey: operatorCredential.userKey } },
    mon,
  ];
  let csiUserID = '';
  const credentialSpecs = [
    ['rook-csi-rbd-node', 'csi-rbd-node'],
    ['rook-csi-rbd-provisioner', 'csi-rbd-provisioner'],
    ['rook-csi-cephfs-node', 'csi-cephfs-node'],
    ['rook-csi-cephfs-provisioner', 'csi-cephfs-provisioner'],
  ];
  for (const [name, prefix] of credentialSpecs) {
    const item = items.find((candidate) => candidate.kind === 'Secret' && candidate.name === name);
    if (item) {
      const csiCredential = credential(item, prefix, 'csi');
      if (!csiUserID) csiUserID = csiCredential.csiUserID;
      secrets.push({ ...item, data: { userID: csiCredential.csiUserID, userKey: csiCredential.userKey } });
    }
  }
  const secretNames = new Set(secrets.map((item) => item.name));
  const storageClasses = items.filter((item) => item.kind === 'StorageClass').map((item) => storageClass(item, secretNames));
  if (!storageClasses.length) throw error('RBD 또는 CephFS StorageClass export가 하나 이상 필요합니다.');

  const allowed = new Set([
    'ConfigMap/rook-ceph-mon-endpoints',
    ...Array.from(SECRET_NAMES, (name) => `Secret/${name}`),
    ...storageClasses.map((item) => `StorageClass/${item.name}`),
    ...IGNORED_EXPORTS,
  ]);
  for (const item of items) {
    const key = `${item.kind}/${item.name}`;
    if (!allowed.has(key)) throw error(`${key}는 OpenSphere의 제한된 Ceph 연결 필터에서 허용되지 않습니다.`);
  }

  return {
    fsid,
    fsidFingerprint: crypto.createHash('sha256').update(fsid).digest('hex').slice(0, 16),
    monitorData,
    monitorCount: monitorData.split(',').map((value) => value.trim()).filter(Boolean).length,
    monitorProtocols: monitorProtocols(monitorData),
    operatorUser: operatorCredential.cephEntity,
    cephEntity: operatorCredential.cephEntity,
    csiUserID,
    userID: csiUserID,
    configMaps: [endpoints],
    secrets,
    storageClasses,
    ignored: items.filter((item) => IGNORED_EXPORTS.has(`${item.kind}/${item.name}`)).map((item) => `${item.kind}/${item.name}`),
  };
}

/**
 * 역할별 CephX 자격 증명을 읽고 검증한다(감사 H-02).
 * 서로 다른 역할이 같은 key를 재사용하면 최소권한이 성립하지 않으므로 거부한다.
 * key 값 자체는 비교에만 사용하고 오류 메시지·로그에 남기지 않는다.
 */
function roleCredentials(value, specs) {
  const out = {};
  const seenKeys = new Map();
  const seenIdentities = new Map();
  for (const spec of specs) {
    const identity = normalizeCephClientIdentity(value[`${spec.id}UserID`], `${spec.label} CephX 사용자`);
    const userKey = String(value[`${spec.id}UserKey`] || '').trim();
    if (!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(userKey)) throw error(`${spec.label} user key 형식이 올바르지 않습니다.`);
    const previousKey = seenKeys.get(userKey);
    if (previousKey) {
      throw error(`${spec.label}와 ${previousKey}가 동일한 CephX key를 사용합니다. 역할별로 분리된 계정을 입력하십시오(최소권한).`);
    }
    const previousIdentity = seenIdentities.get(identity.csiUserID);
    if (previousIdentity) {
      throw error(`${spec.label}와 ${previousIdentity}가 동일한 CephX 사용자(${identity.csiUserID})입니다. 역할별로 분리된 계정을 입력하십시오(최소권한).`);
    }
    seenKeys.set(userKey, spec.label);
    seenIdentities.set(identity.csiUserID, spec.label);
    out[spec.id] = { identity, userKey };
  }
  return out;
}

function validateConnectionInput(input) {
  const value = requireClosedObject(input, [
    'clusterID',
    'monitors',
    // 감사 H-02: 역할별 CephX 자격 증명. 하나의 key를 operator·provisioner·node가
    // 공유하면 key 1건 유출로 control-plane 관측 권한과 data-plane 권한이 동시에 노출된다.
    // CephFS 구성(validateCephFsInput)이 이미 사용하는 분리 패턴과 동일하게 맞춘다.
    'operatorUserID',
    'operatorUserKey',
    'provisionerUserID',
    'provisionerUserKey',
    'nodeUserID',
    'nodeUserKey',
    // 읽기 전용 관측 전용 신원. 관측기가 operator 자격 증명을 재사용하지 않게 한다.
    'observerUserID',
    'observerUserKey',
    'pool',
    'storageClassName',
  ], 'Ceph 접속 정보');
  const fsid = String(value.clusterID || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fsid)) {
    throw error('Cluster ID(FSID)가 UUID 형식이 아닙니다.');
  }

  const monitorValues = Array.isArray(value.monitors)
    ? value.monitors
    : String(value.monitors || '').split(/[\r\n,]+/);
  const monitors = monitorValues.map((item) => String(item || '').trim()).filter(Boolean);
  if (monitors.length < 1 || monitors.length > 15) throw error('Monitor endpoint는 1~15개를 입력해야 합니다.');
  const endpointPattern = /^(?:(v1|v2):)?(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):(3300|6789)(?:\/0)?$/i;
  const normalized = monitors.map((endpoint) => {
    const match = endpoint.match(endpointPattern);
    if (!match) throw error(`Monitor endpoint '${endpoint}' 형식이 올바르지 않습니다. host:3300 또는 host:6789 형식을 사용하십시오.`);
    const protocol = String(match[1] || '').toLowerCase();
    const port = Number(match[3]);
    if ((protocol === 'v2' && port !== 3300) || (protocol === 'v1' && port !== 6789)) {
      throw error(`Monitor endpoint '${endpoint}'의 protocol과 port가 일치하지 않습니다.`);
    }
    return `${protocol ? `${protocol}:` : ''}${match[2].toLowerCase()}:${port}`;
  });
  if (new Set(normalized).size !== normalized.length) throw error('중복된 Monitor endpoint가 있습니다.');

  const roles = roleCredentials(value, [
    { id: 'operator', label: 'Rook operator/healthchecker' },
    { id: 'provisioner', label: 'RBD provisioner' },
    { id: 'node', label: 'RBD node' },
    { id: 'observer', label: '읽기 전용 관측기' },
  ]);
  const identity = roles.operator.identity;
  const pool = String(value.pool || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pool)) throw error('RBD pool 이름 형식이 올바르지 않습니다.');
  const storageClassName = managedStorageClassName(value.storageClassName, 'ceph-rbd', 'StorageClass 이름');
  // Rook operator는 정식 엔티티(client.<id>), ceph-csi는 접두어 없는 userID를 요구한다.
  const operatorCredentialData = { userID: roles.operator.identity.cephEntity, userKey: roles.operator.userKey };
  const provisionerCredentialData = { userID: roles.provisioner.identity.csiUserID, userKey: roles.provisioner.userKey };
  const nodeCredentialData = { userID: roles.node.identity.csiUserID, userKey: roles.node.userKey };
  const storageClass = {
    name: storageClassName,
    kind: 'StorageClass',
    data: {
      pool,
      mounter: 'rbd-nbd',
      'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-rbd-provisioner',
      'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node',
    },
  };
  const monitorData = normalized.map((endpoint, index) => `${String.fromCharCode(97 + index)}=${endpoint}`).join(',');
  return {
    fsid,
    fsidFingerprint: crypto.createHash('sha256').update(fsid).digest('hex').slice(0, 16),
    monitorData,
    monitorEndpoints: normalized,
    monitorCount: normalized.length,
    monitorProtocols: monitorProtocols(monitorData),
    operatorUser: identity.cephEntity,
    cephEntity: identity.cephEntity,
    // CSI userID projection은 provisioner 신원을 대표값으로 사용한다(node와 분리됨).
    csiUserID: roles.provisioner.identity.csiUserID,
    userID: roles.provisioner.identity.csiUserID,
    roleIdentities: {
      operator: roles.operator.identity.cephEntity,
      provisioner: roles.provisioner.identity.cephEntity,
      node: roles.node.identity.cephEntity,
      observer: roles.observer.identity.cephEntity,
    },
    configMaps: [{
      name: 'rook-ceph-mon-endpoints',
      kind: 'ConfigMap',
      data: { data: monitorData, maxMonId: String(normalized.length - 1), mapping: '{}' },
    }],
    secrets: [
      { name: 'rook-ceph-mon', kind: 'Secret', data: { 'admin-secret': 'admin-secret', fsid, 'mon-secret': 'mon-secret' } },
      { name: 'rook-ceph-operator-creds', kind: 'Secret', data: { ...operatorCredentialData } },
      { name: 'rook-csi-rbd-node', kind: 'Secret', data: { ...nodeCredentialData } },
      { name: 'rook-csi-rbd-provisioner', kind: 'Secret', data: { ...provisionerCredentialData } },
      // 관측기 전용 read-only 자격 증명. Rook/CSI가 아니라 opensphere-ceph-observer만 mount한다.
      { name: OBSERVER_SECRET, kind: 'Secret', data: { userID: roles.observer.identity.cephEntity, userKey: roles.observer.userKey } },
    ],
    storageClasses: [storageClass],
    ignored: [],
  };
}

function validateCephFsInput(input) {
  const value = requireClosedObject(input, [
    'filesystem',
    'pool',
    'provisionerUserID',
    'provisionerUserKey',
    'nodeUserID',
    'nodeUserKey',
    'storageClassName',
  ], 'CephFS 구성 정보');
  const filesystem = String(value.filesystem || '').trim();
  const pool = String(value.pool || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filesystem)) throw error('CephFS filesystem 이름 형식이 올바르지 않습니다.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pool)) throw error('CephFS data pool 이름 형식이 올바르지 않습니다.');
  const provisioner = normalizeCephClientIdentity(value.provisionerUserID);
  const node = normalizeCephClientIdentity(value.nodeUserID);
  const provisionerUserKey = String(value.provisionerUserKey || '').trim();
  const nodeUserKey = String(value.nodeUserKey || '').trim();
  if (!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(provisionerUserKey)) throw error('Provisioner user key 형식이 올바르지 않습니다.');
  if (!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(nodeUserKey)) throw error('Node user key 형식이 올바르지 않습니다.');
  const storageClassName = managedStorageClassName(value.storageClassName, 'cephfs', 'CephFS StorageClass 이름');
  return {
    storageClass: {
      name: storageClassName,
      kind: 'StorageClass',
      data: {
        fsName: filesystem,
        pool,
        'csi.storage.k8s.io/provisioner-secret-name': 'rook-csi-cephfs-provisioner',
        'csi.storage.k8s.io/controller-expand-secret-name': 'rook-csi-cephfs-provisioner',
        'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-cephfs-node',
      },
    },
    secrets: [
      {
        name: 'rook-csi-cephfs-provisioner',
        kind: 'Secret',
        data: { userID: provisioner.csiUserID, userKey: provisionerUserKey },
      },
      {
        name: 'rook-csi-cephfs-node',
        kind: 'Secret',
        data: { userID: node.csiUserID, userKey: nodeUserKey },
      },
    ],
    audit: {
      filesystem,
      pool,
      storageClassName,
      provisionerEntity: provisioner.cephEntity,
      nodeEntity: node.cephEntity,
    },
  };
}

async function actorFor(ctx, req, adminRequired) {
  const actor = await ctx.verifyToken(ctx.requestToken(req));
  const groups = Array.isArray(actor.groups) ? actor.groups : [];
  if (adminRequired && !groups.some((group) => ADMIN_GROUPS.has(group))) throw error('Ceph 연결 변경은 Console 관리자만 수행할 수 있습니다.', 403);
  return actor;
}

async function actorForOaaOwner(ctx, req, mutation) {
  const actor = await ctx.verifyToken(ctx.requestToken(req));
  const permissions = new Set(Array.isArray(actor.permissions) ? actor.permissions : []);
  const requiredPermission = mutation ? OAA_CEPH_MANAGE_PERMISSION : OAA_CEPH_READ_PERMISSION;
  if (!permissions.has(requiredPermission)) throw error(`Ceph OAA owner API에는 ${requiredPermission} 권한이 필요합니다.`, 403);
  if (mutation && String(actor.assurance || 'aal1').toLowerCase() !== 'aal2') throw error('Ceph OAA 변경은 AAL2 재인증이 필요합니다.', 403);
  return actor;
}

async function consoleChangeJson(ctx, req, method, apiPath, body) {
  const token = ctx.requestToken(req);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {}),
  };
  const correlationId = String(req.headers?.['x-os-correlation-id'] || '');
  const idempotencyKey = String(req.headers?.['x-os-idempotency-key'] || '');
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) headers['x-os-correlation-id'] = correlationId;
  if (method !== 'GET' && /^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) headers['x-os-idempotency-key'] = idempotencyKey;

  let response;
  try {
    response = await (ctx.consoleFetch || fetch)(`${ctx.consoleBackend}${apiPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw error('Console Change Control API에 연결할 수 없습니다.', 503);
  }
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
  if (!response.ok) {
    throw error(`Change Control 요청 실패(HTTP ${response.status}): ${value.error || response.statusText || '응답 오류'}`, response.status);
  }
  return value;
}

async function requestCephPrerequisiteChange(ctx, req, input) {
  await actorFor(ctx, req, true);
  const body = requireClosedObject(input, ['reason', 'source'], 'request');
  const reason = reasonFrom(body);
  const source = String(body.source || 'ceph-readiness').trim();
  if (!/^[a-z0-9-]{1,64}$/.test(source)) throw error('설치 요청 source 형식이 올바르지 않습니다.');

  const template = await consoleChangeJson(
    ctx,
    req,
    'GET',
    '/api/platform/change-templates/ceph-rook-prerequisite',
  );
  if (template.id !== 'ceph-rook-prerequisite'
    || !template.consumerId
    || !template.action
    || !template.target
    || !template.desiredState
    || Array.isArray(template.desiredState)
    || typeof template.desiredState !== 'object') {
    throw error('Console이 유효한 Ceph 선행요소 변경 템플릿을 반환하지 않았습니다.', 502);
  }
  const sourceSuffix = ` [source:${source}]`;
  return consoleChangeJson(ctx, req, 'POST', '/api/platform/changes', {
    templateId: template.id,
    consumerId: template.consumerId,
    action: template.action,
    target: template.target,
    desiredState: template.desiredState,
    reason: reason.length + sourceSuffix.length <= 500 ? `${reason}${sourceSuffix}` : reason,
  });
}

async function cephPrerequisiteRequestStatus(ctx, req) {
  try {
    const result = await consoleChangeJson(
      ctx,
      req,
      'GET',
      '/api/platform/change-templates/ceph-rook-prerequisite/status',
    );
    return result?.current || null;
  } catch (failure) {
    return {
      trackingAvailable: false,
      phase: 'Unavailable',
      status: 'unknown',
      message: safeError(failure),
      checkedAt: new Date().toISOString(),
    };
  }
}

function requireClosedObject(input, allowedKeys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(`${label} 값은 object여야 합니다.`);
  const extra = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (extra.length) throw error(`${label}에 허용되지 않은 필드가 있습니다: ${extra.join(', ')}`);
  return input;
}

function importNameFromRef(value) {
  const text = String(value || '').trim().toLowerCase();
  const [namespace, name, extra] = text.split('/');
  if (extra !== undefined || namespace !== IMPORT_NAMESPACE || !IMPORT_NAME_RE.test(name || '')) {
    throw error(`importRef는 ${IMPORT_NAMESPACE}/opensphere-ceph-import-<uuid> 형식이어야 합니다.`);
  }
  return name;
}

async function kube(ctx, method, apiPath, body) {
  const response = await fetch(`${ctx.apiServer}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token()}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text }; }
  if (!response.ok) {
    const failure = error(`Kubernetes API ${response.status}: ${value.message || apiPath}`, response.status);
    failure.apiStatus = response.status;
    throw failure;
  }
  return value;
}

async function optionalKube(ctx, apiPath) {
  try { return await kube(ctx, 'GET', apiPath); } catch (e) { if (e.apiStatus === 404) return null; throw e; }
}

async function selfCanI(ctx, verb, group, resource, namespace = '', name = '') {
  try {
    const review = await kube(ctx, 'POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          verb, group, resource,
          ...(namespace ? { namespace } : {}),
          ...(name ? { name } : {}),
        },
      },
    });
    return Boolean(review.status?.allowed);
  } catch { return false; }
}

async function cephOwnerPrerequisites(ctx) {
  const [rookNamespace, importNamespace, operator, cephCrd, snapshotCrd] = await Promise.all([
    optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}`),
    optionalKube(ctx, `/api/v1/namespaces/${IMPORT_NAMESPACE}`),
    optionalKube(ctx, `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/rook-ceph-operator`),
    optionalKube(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/cephclusters.ceph.rook.io'),
    optionalKube(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/volumesnapshotclasses.snapshot.storage.k8s.io'),
  ]);
  const permissionSpecs = [
    ['get', '', 'secrets', IMPORT_NAMESPACE], ['list', '', 'secrets', IMPORT_NAMESPACE], ['create', '', 'secrets', IMPORT_NAMESPACE], ['delete', '', 'secrets', IMPORT_NAMESPACE],
    ...['get', 'list', 'create', 'update', 'patch', 'delete'].flatMap((verb) => [
      [verb, '', 'secrets', NAMESPACE],
      [verb, 'ceph.rook.io', 'cephclusters', NAMESPACE],
    ]),
    // ConfigMap 권한은 관리 대상 이름으로만 부여되므로 이름을 지정해 검사한다.
    // create는 RBAC에서 이름 제한이 불가능하므로 이름 없이 검사한다.
    ['create', '', 'configmaps', NAMESPACE],
    ...['get', 'update', 'patch', 'delete'].flatMap((verb) => MANAGED_CONFIGMAPS.map((name) => [verb, '', 'configmaps', NAMESPACE, name])),
    // StorageClass/VolumeSnapshotClass는 접두사 규칙이라 RBAC resourceNames로 좁힐 수 없다.
    // 이름 경계는 ValidatingAdmissionPolicy가 CREATE/UPDATE/DELETE에서 강제한다.
    ...['get', 'list', 'create', 'update', 'patch', 'delete'].map((verb) => [verb, 'storage.k8s.io', 'storageclasses', '']),
    ...(snapshotCrd ? ['get', 'list', 'create', 'update', 'patch', 'delete'].map((verb) => [verb, 'snapshot.storage.k8s.io', 'volumesnapshotclasses', '']) : []),
  ];
  const permissions = await Promise.all(permissionSpecs.map(async ([verb, group, resource, namespace, name = '']) => ({
    verb, group, resource, namespace, name, allowed: await selfCanI(ctx, verb, group, resource, namespace, name),
  })));
  const missingPermissions = permissions.filter((item) => !item.allowed).map((item) => `${item.verb} ${item.group || 'core'}/${item.resource}${item.name ? `/${item.name}` : ''}${item.namespace ? ` namespace=${item.namespace}` : ''}`);
  const operatorReady = Boolean(operator && Number(operator.status?.readyReplicas || 0) >= 1 && Number(operator.status?.readyReplicas || 0) === Number(operator.status?.replicas || 0));
  const blockers = [];
  if (!rookNamespace) blockers.push(`Namespace/${NAMESPACE} is not preprovisioned`);
  if (!importNamespace) blockers.push(`Namespace/${IMPORT_NAMESPACE} is not preprovisioned`);
  if (!cephCrd) blockers.push('CephCluster CRD is not installed by the signed platform release');
  if (!operatorReady) blockers.push('signed platform-owned Rook operator is not Ready');
  if (missingPermissions.length) blockers.push(`Cluster Manager runtime RBAC is incomplete: ${missingPermissions.join('; ')}`);
  return {
    ready: blockers.length === 0,
    operatorReady,
    cephClusterCrdReady: Boolean(cephCrd),
    snapshotApiReady: Boolean(snapshotCrd),
    namespaces: { runtime: Boolean(rookNamespace), imports: Boolean(importNamespace) },
    missingPermissions,
    blockers,
    policy: { operatorOwner: 'signed-platform-release', runtimeOwner: 'cluster-manager', importTransport: 'SecretRefOnly' },
  };
}

async function ensureNamespace(ctx) {
  const current = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}`);
  if (current) return current;
  return kube(ctx, 'POST', '/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE, labels: MANAGED_LABELS } });
}

async function upsert(ctx, collection, name, manifest) {
  const current = await optionalKube(ctx, `${collection}/${encodeURIComponent(name)}`);
  if (!current) return kube(ctx, 'POST', collection, manifest);
  const next = structuredClone(manifest);
  next.metadata.resourceVersion = current.metadata.resourceVersion;
  return kube(ctx, 'PUT', `${collection}/${encodeURIComponent(name)}`, next);
}

async function remove(ctx, apiPath) {
  try { return await kube(ctx, 'DELETE', apiPath, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground' }); }
  catch (e) { if (e.apiStatus === 404) return null; throw e; }
}

function secretManifest(item) {
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/rook',
    metadata: { name: item.name, namespace: NAMESPACE, labels: MANAGED_LABELS },
    stringData: item.data,
  };
}

function configMapManifest(item) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: item.name, namespace: NAMESPACE, labels: MANAGED_LABELS }, data: item.data };
}

function crdEstablished(crd) {
  return Boolean(crd && (crd.status?.conditions || []).some((item) => item.type === 'Established' && item.status === 'True'));
}

async function stageConnectionImport(ctx, connectionInput, actor) {
  await pruneExpiredImports(ctx);
  const connection = validateConnectionInput(connectionInput);
  const name = `opensphere-ceph-import-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + IMPORT_TTL_MS).toISOString();
  await kube(ctx, 'POST', `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets`, {
    apiVersion: 'v1', kind: 'Secret', type: IMPORT_SECRET_TYPE,
    metadata: {
      name, namespace: IMPORT_NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', 'opensphere.io/ceph-import': 'staged' },
      annotations: {
        'opensphere.io/staged-by': actor.username,
        'opensphere.io/fsid-fingerprint': connection.fsidFingerprint,
        'opensphere.io/expires-at': expiresAt,
      },
    },
    stringData: { connectionInput: JSON.stringify(connectionInput) },
  });
  return {
    importRef: `${IMPORT_NAMESPACE}/${name}`,
    fsidFingerprint: connection.fsidFingerprint,
    monitorCount: connection.monitorCount,
    storageClasses: connection.storageClasses.map((item) => item.name),
    expiresAt,
    secretValuesReturned: false,
  };
}

async function pruneExpiredImports(ctx) {
  const list = await kube(ctx, 'GET', `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets?labelSelector=${encodeURIComponent('opensphere.io/ceph-import=staged')}`);
  const now = Date.now();
  const expired = (list.items || []).filter((item) => {
    const expiresAt = Date.parse(String(item.metadata?.annotations?.['opensphere.io/expires-at'] || ''));
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  });
  const results = await Promise.allSettled(expired.map((item) => deleteProviderImport(ctx, item.metadata?.name)));
  const failures = results.filter((item) => item.status === 'rejected');
  if (failures.length) {
    importCleanupHealth.totalFailures += failures.length;
    importCleanupHealth.consecutiveFailures += 1;
    importCleanupHealth.lastFailureAt = new Date().toISOString();
    importCleanupHealth.lastError = `만료된 staged Secret ${failures.length}건 정리에 실패했습니다.`;
    console.warn(`[ceph] ${importCleanupHealth.lastError}`);
  } else {
    importCleanupHealth.consecutiveFailures = 0;
    importCleanupHealth.lastSuccessAt = new Date().toISOString();
    importCleanupHealth.lastError = null;
  }
  return { expired: expired.length, deleted: expired.length - failures.length, failed: failures.length };
}

async function connectionFromImportRef(ctx, importRef) {
  const name = importNameFromRef(importRef);
  const secret = await optionalKube(ctx, `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets/${encodeURIComponent(name)}`);
  if (!secret || secret.type !== IMPORT_SECRET_TYPE || secret.metadata?.labels?.['opensphere.io/ceph-import'] !== 'staged') {
    throw error('유효한 staged Ceph 접속 정보를 찾지 못했습니다.', 404);
  }
  const expiresAt = Date.parse(String(secret.metadata?.annotations?.['opensphere.io/expires-at'] || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    try {
      await deleteProviderImport(ctx, name);
    } catch {
      importCleanupHealth.totalFailures += 1;
      importCleanupHealth.consecutiveFailures += 1;
      importCleanupHealth.lastFailureAt = new Date().toISOString();
      importCleanupHealth.lastError = '만료된 staged Secret 즉시 정리에 실패했습니다.';
      console.warn(`[ceph] ${importCleanupHealth.lastError}`);
    }
    throw error('staged Ceph 접속 정보가 만료되었습니다. 관리자 UI에서 다시 검증하십시오.', 410);
  }
  const encoded = String(secret.data?.connectionInput || '');
  if (!encoded || encoded.length > 32 * 1024) throw error('staged Ceph 접속 정보가 없거나 너무 큽니다.', 409);
  let connectionInput;
  try { connectionInput = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw error('staged Ceph 접속 정보가 손상되었습니다.', 409); }
  return { name, connection: validateConnectionInput(connectionInput) };
}

async function deleteProviderImport(ctx, name) {
  return remove(ctx, `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets/${encodeURIComponent(name)}`);
}

function storageClassManifest(item) {
  const cephfs = Boolean(item.data.fsName);
  const provisionerSecret = item.data['csi.storage.k8s.io/provisioner-secret-name'];
  const nodeSecret = item.data['csi.storage.k8s.io/node-stage-secret-name'];
  const parameters = {
    clusterID: NAMESPACE,
    pool: item.data.pool,
    'csi.storage.k8s.io/provisioner-secret-name': provisionerSecret,
    'csi.storage.k8s.io/provisioner-secret-namespace': NAMESPACE,
    'csi.storage.k8s.io/controller-expand-secret-name': item.data['csi.storage.k8s.io/controller-expand-secret-name'] || provisionerSecret,
    'csi.storage.k8s.io/controller-expand-secret-namespace': NAMESPACE,
    'csi.storage.k8s.io/controller-publish-secret-name': provisionerSecret,
    'csi.storage.k8s.io/controller-publish-secret-namespace': NAMESPACE,
    'csi.storage.k8s.io/node-stage-secret-name': nodeSecret,
    'csi.storage.k8s.io/node-stage-secret-namespace': NAMESPACE,
  };
  if (cephfs) parameters.fsName = item.data.fsName;
  else {
    parameters.imageFormat = '2';
    parameters.imageFeatures = 'layering';
    if (item.data.mounter) parameters.mounter = item.data.mounter;
    parameters['csi.storage.k8s.io/fstype'] = 'ext4';
    if (item.data.dataPool) parameters.dataPool = item.data.dataPool;
  }
  return {
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
    metadata: { name: item.name, labels: MANAGED_LABELS },
    provisioner: `${NAMESPACE}.${cephfs ? 'cephfs' : 'rbd'}.csi.ceph.com`,
    parameters,
    reclaimPolicy: 'Retain',
    allowVolumeExpansion: true,
    volumeBindingMode: 'WaitForFirstConsumer',
  };
}

function snapshotClassManifest(storageClass) {
  const cephfs = Boolean(storageClass.data.fsName);
  const secret = storageClass.data['csi.storage.k8s.io/provisioner-secret-name'];
  return {
    apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass',
    metadata: { name: `${storageClass.name}-snapshot`, labels: MANAGED_LABELS },
    driver: `${NAMESPACE}.${cephfs ? 'cephfs' : 'rbd'}.csi.ceph.com`,
    deletionPolicy: 'Retain',
    parameters: {
      clusterID: NAMESPACE,
      'csi.storage.k8s.io/snapshotter-secret-name': secret,
      'csi.storage.k8s.io/snapshotter-secret-namespace': NAMESPACE,
    },
  };
}

async function snapshotApiAvailable(ctx) {
  return Boolean(await optionalKube(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/volumesnapshotclasses.snapshot.storage.k8s.io'));
}

function metadataManifest(connection, snapshotClasses, actor) {
  const rbdStorageClass = connection.storageClasses.find((item) => !item.data.fsName);
  const payload = {
    schemaVersion: 2,
    mode: 'RookExternal',
    fsid: connection.fsid,
    fsidFingerprint: connection.fsidFingerprint,
    monitors: connection.monitorEndpoints || monitorEndpointsFromData(connection.monitorData),
    csiUserID: connection.csiUserID || connection.userID || '',
    rbdPool: rbdStorageClass?.data?.pool || '',
    storageClasses: connection.storageClasses.map((item) => item.name),
    snapshotClasses,
    secretRefs: connection.secrets.map((item) => `${NAMESPACE}/${item.name}`),
    operatorRelease: OPERATOR_RELEASE,
    clusterRelease: CLUSTER_RELEASE,
    chartVersion: CHART_VERSION,
    operatorOwned: false,
    connectedBy: actor.username,
    connectedAt: new Date().toISOString(),
  };
  return {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: CONNECTION_CONFIGMAP, namespace: NAMESPACE, labels: MANAGED_LABELS },
    data: { connection: JSON.stringify(payload) },
  };
}

function parseMetadata(configMap) {
  try { return JSON.parse(configMap?.data?.connection || ''); } catch { return null; }
}

function monitorEndpointsFromData(data) {
  return String(data || '').split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^[^=]+=/, ''));
}

function observerEgressPolicy(connection) {
  const endpoints = connection.monitorEndpoints || monitorEndpointsFromData(connection.monitorData);
  const cidrs = [...new Set(endpoints.map((endpoint) => {
    const withoutProtocol = String(endpoint).trim().replace(/^v[12]:/i, '').replace(/\/0$/, '');
    const host = withoutProtocol.startsWith('[')
      ? withoutProtocol.slice(1, withoutProtocol.indexOf(']'))
      : withoutProtocol.slice(0, withoutProtocol.lastIndexOf(':'));
    const version = net.isIP(host);
    if (!version) {
      throw error(`Monitor endpoint '${endpoint}'는 관측기 egress를 고정할 수 있도록 IP 주소를 사용해야 합니다.`, 409);
    }
    return `${host}/${version === 6 ? 128 : 32}`;
  }))];
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: OBSERVER_EGRESS_POLICY, namespace: NAMESPACE, labels: MANAGED_LABELS },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'opensphere-ceph-observer' } },
      policyTypes: ['Egress'],
      egress: cidrs.map((cidr) => ({
        to: [{ ipBlock: { cidr } }],
        ports: [
          { protocol: 'TCP', port: 3300 },
          { protocol: 'TCP', port: 6789 },
        ],
      })),
    },
  };
}

function decodedSecretField(secret, field) {
  const encoded = String(secret?.data?.[field] || '');
  if (!encoded) return '';
  try { return Buffer.from(encoded, 'base64').toString('utf8').trim(); }
  catch { return ''; }
}

function statusConnectionProjection(metadata, monitorConfigMap, storageClasses, secrets) {
  if (!metadata) return null;
  const wantedClasses = new Set(metadata.storageClasses || []);
  const rbdClass = (storageClasses || []).find((item) => (
    wantedClasses.has(item.metadata?.name)
    && String(item.provisioner || '').endsWith('.rbd.csi.ceph.com')
  ));
  const csiSecretName = rbdClass?.parameters?.['csi.storage.k8s.io/provisioner-secret-name'];
  const csiSecret = (secrets || []).find((item) => item.metadata?.name === csiSecretName);
  const monitors = Array.isArray(metadata.monitors) && metadata.monitors.length
    ? metadata.monitors.map((item) => String(item))
    : monitorEndpointsFromData(monitorConfigMap?.data?.data);
  return {
    mode: metadata.mode,
    // CONSTITUTION-0004 규정 6.5: Console에는 원문 FSID가 아니라 fingerprint만 남긴다.
    // 원문 FSID는 외부 Ceph 클러스터 식별 정보이므로 status 응답으로 반환하지 않는다.
    // fingerprint는 provider가 제공한 값과 대조해 대상 클러스터를 확인하는 데 충분하다.
    fsidFingerprint: metadata.fsidFingerprint,
    monitors,
    userID: String(metadata.csiUserID || decodedSecretField(csiSecret, 'userID')).replace(/^client\./, ''),
    pool: String(metadata.rbdPool || rbdClass?.parameters?.pool || ''),
    secretRefs: metadata.secretRefs || [],
    connectedBy: metadata.connectedBy,
    connectedAt: metadata.connectedAt,
    chartVersion: metadata.chartVersion,
  };
}

function helmMetadataAccessDenied(failure) {
  const message = String(failure?.safeMessage || failure?.message || '');
  return /secrets is forbidden|cannot (?:get|list) resource ["']secrets["']|failed to query with labels/i.test(message);
}

async function helmStatus(ctx, release, namespace, tolerateMetadataAccessDenied = false) {
  try {
    // `helm status --output json` embeds the complete rendered manifest. Rook
    // CRDs can make that response exceed the bounded command-output buffer,
    // leaving a truncated document that cannot be parsed. `helm list` returns
    // only the release metadata required by this readiness projection.
    const filter = `^${release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const out = await withKubeconfig(ctx, (env) => command('helm', ['list', '--namespace', namespace, '--all', '--filter', filter, '--output', 'json'], { env, timeoutMs: 30000 }));
    const values = JSON.parse(out.stdout || '[]');
    const value = Array.isArray(values) ? values.find((item) => item?.name === release) : null;
    if (!value) return { installed: false, status: 'not-installed', chart: '', revision: 0 };
    const chart = String(value.chart || '');
    const version = chart.match(/-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1] || chart;
    return { installed: true, status: value.status || 'unknown', chart: version, revision: Number(value.revision || 0) || 0 };
  } catch (e) {
    if (tolerateMetadataAccessDenied && helmMetadataAccessDenied(e)) {
      return { installed: null, status: 'metadata-access-blocked', chart: '', revision: 0, reason: 'HelmMetadataAccessDenied' };
    }
    throw e;
  }
}

async function clusterIdentity(ctx) {
  const [version, namespace, nodes] = await Promise.all([
    kube(ctx, 'GET', '/version'),
    kube(ctx, 'GET', '/api/v1/namespaces/kube-system'),
    kube(ctx, 'GET', '/api/v1/nodes'),
  ]);
  const nodeItems = nodes.items || [];
  const readyNodes = nodeItems.filter((node) => (node.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True')).length;
  const uid = String(namespace.metadata?.uid || 'unknown');
  return {
    ready: nodeItems.length > 0 && readyNodes === nodeItems.length,
    id: crypto.createHash('sha256').update(uid).digest('hex').slice(0, 16),
    version: version.gitVersion || '',
    nodes: nodeItems.length,
    readyNodes,
  };
}

async function cephStatus(ctx) {
  let kubernetes;
  try { kubernetes = await clusterIdentity(ctx); }
  catch (e) {
    return { state: 'Blocked', reason: 'KubernetesUnavailable', checkedAt: new Date().toISOString(), kubernetes: { ready: false }, connection: null, providerGuide: providerGuide(), message: safeError(e) };
  }

  const [metadataConfig, monitorConfig, cephCluster, storageClasses, csiDrivers, cephSecrets, operator, cluster] = await Promise.all([
    optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`),
    optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/rook-ceph-mon-endpoints`),
    optionalKube(ctx, `/apis/ceph.rook.io/v1/namespaces/${NAMESPACE}/cephclusters/${NAMESPACE}`),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/storageclasses'),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/csidrivers'),
    kube(ctx, 'GET', `/api/v1/namespaces/${NAMESPACE}/secrets`),
    helmStatus(ctx, OPERATOR_RELEASE, NAMESPACE, true),
    helmStatus(ctx, CLUSTER_RELEASE, NAMESPACE, true),
  ]);
  const metadata = parseMetadata(metadataConfig);
  const wantedClasses = new Set(metadata?.storageClasses || []);
  const allClasses = storageClasses.items || [];
  const classes = allClasses.filter((item) => wantedClasses.has(item.metadata?.name)).map((item) => ({ name: item.metadata.name, provisioner: item.provisioner, reclaimPolicy: item.reclaimPolicy }));
  const driverItems = (csiDrivers.items || []).filter((item) => String(item.metadata?.name || '').startsWith(`${NAMESPACE}.`));
  const drivers = driverItems.map((item) => item.metadata.name);
  const serviceCoverage = cephStorageServiceDiagnostics(
    driverItems,
    allClasses,
    cephSecrets.items || [],
  );
  const conditionReady = (cephCluster?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
  const connected = conditionReady || cephCluster?.status?.state === 'Connected' || cephCluster?.status?.phase === 'Connected';
  let state = 'NotConfigured';
  let reason = 'NoExternalCephConnection';
  let message = '선택한 Kubernetes 클러스터에 연결된 외부 Ceph이 없습니다.';
  if (!kubernetes.ready) {
    state = 'Blocked'; reason = 'KubernetesNotReady'; message = `Kubernetes 노드 ${kubernetes.readyNodes}/${kubernetes.nodes} Ready`;
  } else if (metadata) {
    if (connected && drivers.length && classes.length === wantedClasses.size) {
      state = 'Ready'; reason = 'ExternalCephConnected';
      message = serviceCoverage.needsConfiguration === 0
        ? `외부 Ceph 연결은 정상이며 CSI 스토리지 ${serviceCoverage.configured}/${serviceCoverage.installed}종의 구성 참조가 확인되었습니다. 실제 PVC 데이터 경로 검증은 별도 기록이 필요합니다.`
        : `외부 Ceph 연결은 정상이며 CSI 스토리지 ${serviceCoverage.configured}/${serviceCoverage.installed}종이 구성되었습니다. 미구성 서비스를 확인하십시오.`;
    } else {
      state = 'Degraded'; reason = 'ExternalCephNotReady'; message = '외부 Ceph 연결 리소스가 존재하지만 CephCluster/CSI가 아직 Ready가 아닙니다.';
    }
  }
  return {
    state, reason, message, checkedAt: new Date().toISOString(), kubernetes, providerGuide: providerGuide(),
    connection: statusConnectionProjection(metadata, monitorConfig, allClasses, cephSecrets.items || []),
    rook: { operator, cluster, cephCluster: cephCluster ? { state: cephCluster.status?.state || cephCluster.status?.phase || 'Unknown', health: cephCluster.status?.ceph?.health || 'Unknown' } : null },
    csi: { drivers, storageClasses: classes, serviceCoverage },
    importCleanup: { ...importCleanupHealth },
  };
}

function planFor(connection, snapshotSupported) {
  const snapshotClasses = snapshotSupported ? connection.storageClasses.map((item) => `${item.name}-snapshot`) : [];
  const cephEntity = connection.cephEntity || connection.operatorUser || '';
  const csiUserID = connection.csiUserID || connection.userID || cephEntity.replace(/^client\./, '');
  const resources = [
    ...connection.configMaps.map((item) => ({ kind: 'ConfigMap', namespace: NAMESPACE, name: item.name })),
    ...connection.secrets.map((item) => ({ kind: 'Secret', namespace: NAMESPACE, name: item.name, secretRefOnly: true })),
    ...connection.storageClasses.map((item) => ({ kind: 'StorageClass', namespace: '', name: item.name, reclaimPolicy: 'Retain' })),
    ...snapshotClasses.map((name) => ({ kind: 'VolumeSnapshotClass', namespace: '', name, deletionPolicy: 'Retain' })),
  ];
  return {
    mode: 'RookExternal', namespace: NAMESPACE,
    parent: 'Kubernetes',
    clusterID: connection.fsid,
    fsidFingerprint: connection.fsidFingerprint,
    monitors: connection.monitorEndpoints || String(connection.monitorData || '').split(',').map((item) => item.replace(/^[^=]+=/, '')),
    monitorCount: connection.monitorCount,
    monitorProtocols: connection.monitorProtocols,
    cephEntity,
    csiUserID,
    userID: csiUserID,
    storage: connection.storageClasses.map((item) => ({ name: item.name, pool: item.data.pool, filesystem: item.data.fsName || '' })),
    secretRefs: connection.secrets.map((item) => `${NAMESPACE}/${item.name}`),
    charts: [
      { release: OPERATOR_RELEASE, chart: 'rook-ceph', version: CHART_VERSION, owner: 'signed-platform-release', installedByAction: false },
      { release: CLUSTER_RELEASE, chart: 'rook-ceph-cluster', version: CHART_VERSION, valuesProfile: 'external' },
    ],
    resources,
    ignoredProviderResources: connection.ignored,
    snapshotSupported,
    providerGuide: providerGuide(),
    safety: {
      rawCredentialsPersistedByConsole: false,
      remotePoolsModified: false,
      remoteDataDeletedOnDisconnect: false,
      reclaimPolicy: 'Retain',
    },
  };
}

/**
 * 요청 헤더의 correlation ID를 채택하거나 새로 생성한다.
 * 하나의 변경은 requested → succeeded|failed 감사 이벤트를 동일 ID로 묶어야 추적이 가능하다.
 */
function correlationFrom(req) {
  const value = String(req?.headers?.['x-os-correlation-id'] || '');
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : crypto.randomUUID();
}

async function auditEvent(ctx, actor, action, result, reason, metadata, correlationId) {
  return fetch(`${ctx.controller}/api/admin/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token()}`,
      'content-type': 'application/json',
      'x-opensphere-source': 'cluster-manager',
      'x-os-correlation-id': correlationId,
    },
    body: JSON.stringify({
      source: 'cluster-manager',
      userActor: actor.username,
      action,
      target: 'CephExternal/rook-ceph',
      result,
      reason,
      correlationId,
      metadata: { ...metadata, correlationId },
    }),
  });
}

/** 변경 전 fail-closed 감사. 저장 실패 시 변경을 차단한다. */
async function auditRequired(ctx, actor, action, reason, metadata = {}, correlationId = '') {
  const response = await auditEvent(ctx, actor, action, 'requested', reason, metadata, correlationId);
  if (!response.ok) throw error(`내구 감사 저장소를 사용할 수 없습니다(HTTP ${response.status}). Ceph 변경을 차단했습니다.`, 503);
}

function auditRecordKey(correlationId) {
  return `event-${crypto.createHash('sha256').update(String(correlationId)).digest('hex').slice(0, 32)}`;
}

function redactedAuditMetadata(metadata) {
  return JSON.parse(JSON.stringify(metadata || {}, (key, value) => (
    /(?:key|secret|token|password|credential)/i.test(key) ? '[REDACTED]' : value
  )));
}

/**
 * 중앙 감사 저장소와 별도로 Kubernetes에 작업의 최신 상태를 남긴다.
 * requested 기록이 없으면 변경을 시작하지 않으며, terminal 기록은 API 응답보다 먼저 저장한다.
 * 같은 correlation ID는 한 항목을 갱신하므로 중간 상태가 무한히 증가하지 않는다.
 */
async function recordDurableOperation(ctx, actor, action, result, reason, metadata, correlationId) {
  const collection = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
  const key = auditRecordKey(correlationId);
  const record = JSON.stringify({
    schemaVersion: 1,
    correlationId,
    actor: actor.username,
    action,
    result,
    reason: String(reason || '').slice(0, 2048),
    metadata: redactedAuditMetadata(metadata),
    recordedAt: new Date().toISOString(),
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const current = await optionalKube(ctx, `${collection}/${OPERATION_CONFIGMAP}`);
      const data = { ...(current?.data || {}), [key]: record };
      // ConfigMap 크기와 장기 노출을 제한한다. 최신 50건만 보존하고 중앙 감사가 장기 보존을 담당한다.
      const retained = Object.entries(data)
        .sort(([, left], [, right]) => {
          const leftAt = (() => { try { return JSON.parse(left).recordedAt || ''; } catch { return ''; } })();
          const rightAt = (() => { try { return JSON.parse(right).recordedAt || ''; } catch { return ''; } })();
          return rightAt.localeCompare(leftAt);
        })
        .slice(0, 50);
      const manifest = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: OPERATION_CONFIGMAP, namespace: NAMESPACE, labels: MANAGED_LABELS },
        data: Object.fromEntries(retained),
      };
      if (current) {
        manifest.metadata.resourceVersion = current.metadata.resourceVersion;
        await kube(ctx, 'PUT', `${collection}/${OPERATION_CONFIGMAP}`, manifest);
      } else {
        await kube(ctx, 'POST', collection, manifest);
      }
      return;
    } catch (failure) {
      if (failure.apiStatus !== 409 || attempt === 3) throw failure;
    }
  }
}

/**
 * 종결 감사(succeeded|failed). 변경은 이미 수행되었으므로 여기서 예외를 던져
 * 응답을 뒤집지 않는다. 대신 저장 실패를 경고로 남겨 누락을 관측할 수 있게 한다.
 */
async function auditTerminal(ctx, actor, action, result, reason, metadata, correlationId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await auditEvent(ctx, actor, action, result, reason, metadata, correlationId);
      if (response.ok) return true;
      if (attempt === 3) {
        console.warn(`[ceph] terminal audit not stored action=${action} result=${result} correlationId=${correlationId} http=${response.status}`);
        return false;
      }
    } catch (failure) {
      if (attempt === 3) {
        console.warn(`[ceph] terminal audit failed action=${action} result=${result} correlationId=${correlationId}: ${safeError(failure)}`);
        return false;
      }
    }
  }
  return false;
}

/**
 * 변경 작업을 requested → succeeded|failed 감사로 감싼다.
 * resultOf는 반환값에서 최종 결과 문자열을 도출한다(예: Ready 여부).
 */
async function auditedChange(ctx, actor, action, reason, metadata, correlationId, run, resultOf = () => 'succeeded') {
  await auditRequired(ctx, actor, action, reason, metadata, correlationId);
  try {
    await recordDurableOperation(ctx, actor, action, 'requested', reason, metadata, correlationId);
  } catch (failure) {
    await auditTerminal(ctx, actor, action, 'failed', reason, {
      ...metadata,
      error: `Kubernetes durable audit mirror unavailable: ${safeError(failure)}`,
    }, correlationId);
    throw error(`작업 상태 기록을 저장할 수 없어 Ceph 변경을 차단했습니다: ${safeError(failure)}`, 503);
  }
  let value;
  try {
    value = await run();
  } catch (failure) {
    try {
      await recordDurableOperation(ctx, actor, action, 'failed', reason, { ...metadata, error: safeError(failure) }, correlationId);
    } catch (auditFailure) {
      console.warn(`[ceph] durable failed-operation audit unavailable action=${action} correlationId=${correlationId}: ${safeError(auditFailure)}`);
    }
    await auditTerminal(ctx, actor, action, 'failed', reason, { ...metadata, error: safeError(failure) }, correlationId);
    throw failure;
  }
  const terminalResult = resultOf(value);
  try {
    await recordDurableOperation(ctx, actor, action, terminalResult, reason, metadata, correlationId);
  } catch (failure) {
    await auditTerminal(ctx, actor, action, terminalResult, reason, {
      ...metadata,
      durableMirrorError: safeError(failure),
    }, correlationId);
    throw error(`Ceph 변경은 수행되었으나 최종 작업 상태 기록에 실패했습니다. correlationId=${correlationId}; 상태를 새로고침해 확인하십시오.`, 503);
  }
  await auditTerminal(ctx, actor, action, terminalResult, reason, metadata, correlationId);
  return value;
}

async function installConnection(ctx, connection, actor) {
  const prerequisites = await cephOwnerPrerequisites(ctx);
  if (!prerequisites.ready) throw error(`Ceph runtime prerequisites are not ready: ${prerequisites.blockers.join(' ')}`, 409);
  // 소유권 marker를 credential보다 먼저 기록한다. 설치가 중단되어도 다음 시도는
  // 외부 Rook을 오인하지 않고 같은 OpenSphere 작업을 안전하게 재개할 수 있다.
  await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, CONNECTION_CONFIGMAP, metadataManifest(connection, [], actor));

  for (const item of connection.configMaps) await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, item.name, configMapManifest(item));
  for (const item of connection.secrets) await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets`, item.name, secretManifest(item));
  await upsert(
    ctx,
    `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies`,
    OBSERVER_EGRESS_POLICY,
    observerEgressPolicy(connection),
  );

  const valuesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-ceph-values-'));
  const valuesPath = path.join(valuesDir, 'values.yaml');
  const values = {
    operatorNamespace: NAMESPACE,
    clusterName: NAMESPACE,
    cephClusterMetadata: { labels: MANAGED_LABELS },
    monitoring: { enabled: false },
    cephClusterSpec: {
      external: { enable: true },
      crashCollector: { disable: true },
      healthCheck: { daemonHealth: { mon: { disabled: false, interval: '45s' } } },
    },
    cephBlockPools: {}, cephFileSystems: {}, cephObjectStores: {},
  };
  fs.writeFileSync(valuesPath, yaml.dump(values, { noRefs: true, lineWidth: 120 }), { mode: 0o600 });
  try {
    const cluster = ['upgrade', '--install', CLUSTER_RELEASE, CLUSTER_CHART, '--namespace', NAMESPACE, '--values', valuesPath, '--atomic', '--wait', '--timeout', '10m', '--history-max', '5'];
    await withKubeconfig(ctx, (env) => command('helm', cluster, { env }));
  } finally { fs.rmSync(valuesDir, { recursive: true, force: true }); }

  for (const item of connection.storageClasses) {
    await upsert(ctx, '/apis/storage.k8s.io/v1/storageclasses', item.name, storageClassManifest(item));
  }
  const snapshotSupported = await snapshotApiAvailable(ctx);
  const snapshotClasses = [];
  if (snapshotSupported) {
    for (const item of connection.storageClasses) {
      const manifest = snapshotClassManifest(item);
      await upsert(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses', manifest.metadata.name, manifest);
      snapshotClasses.push(manifest.metadata.name);
    }
  }
  await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, CONNECTION_CONFIGMAP, metadataManifest(connection, snapshotClasses, actor));
  const deadline = Date.now() + 3 * 60 * 1000;
  let status = await cephStatus(ctx);
  while (status.state !== 'Ready' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    status = await cephStatus(ctx);
  }
  return status;
}

async function configureCephFsService(ctx, configuration, actor) {
  const metadataConfig = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
  const metadata = parseMetadata(metadataConfig);
  if (!metadata) throw error('먼저 외부 Ceph 연결을 완료해야 CephFS 서비스를 추가할 수 있습니다.', 409);
  const driverName = `${NAMESPACE}.cephfs.csi.ceph.com`;
  if (!await optionalKube(ctx, `/apis/storage.k8s.io/v1/csidrivers/${encodeURIComponent(driverName)}`)) {
    throw error(`CSIDriver/${driverName}가 설치되어 있지 않습니다.`, 409);
  }
  const validated = validateCephFsInput(configuration);
  const existingClass = await optionalKube(ctx, `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(validated.storageClass.name)}`);
  if (existingClass && existingClass.provisioner !== driverName) {
    throw error(`StorageClass/${validated.storageClass.name}가 다른 provisioner에서 사용 중입니다.`, 409);
  }
  for (const item of validated.secrets) {
    await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets`, item.name, secretManifest(item));
  }
  await upsert(
    ctx,
    '/apis/storage.k8s.io/v1/storageclasses',
    validated.storageClass.name,
    storageClassManifest(validated.storageClass),
  );
  const snapshotClasses = new Set(metadata.snapshotClasses || []);
  if (await snapshotApiAvailable(ctx)) {
    const snapshot = snapshotClassManifest(validated.storageClass);
    await upsert(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses', snapshot.metadata.name, snapshot);
    snapshotClasses.add(snapshot.metadata.name);
  }
  const nextMetadata = {
    ...metadata,
    storageClasses: [...new Set([...(metadata.storageClasses || []), validated.storageClass.name])],
    snapshotClasses: [...snapshotClasses],
    secretRefs: [...new Set([
      ...(metadata.secretRefs || []),
      ...validated.secrets.map((item) => `${NAMESPACE}/${item.name}`),
    ])],
    updatedBy: actor.username,
    updatedAt: new Date().toISOString(),
  };
  await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, CONNECTION_CONFIGMAP, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: CONNECTION_CONFIGMAP, namespace: NAMESPACE, labels: MANAGED_LABELS },
    data: { connection: JSON.stringify(nextMetadata) },
  });
  return { status: await cephStatus(ctx), configuration: validated.audit };
}

async function usageFor(ctx, storageClassNames) {
  const wanted = new Set(storageClassNames);
  const [pvs, pvcs] = await Promise.all([
    kube(ctx, 'GET', '/api/v1/persistentvolumes'),
    kube(ctx, 'GET', '/api/v1/persistentvolumeclaims'),
  ]);
  return {
    persistentVolumes: (pvs.items || []).filter((item) => (
      wanted.has(item.spec?.storageClassName)
      || String(item.spec?.csi?.driver || '').startsWith(`${NAMESPACE}.`)
    )).map((item) => item.metadata?.name),
    persistentVolumeClaims: (pvcs.items || []).filter((item) => wanted.has(item.spec?.storageClassName)).map((item) => `${item.metadata?.namespace}/${item.metadata?.name}`),
  };
}

async function disconnect(ctx, metadata) {
  const usage = await usageFor(ctx, metadata.storageClasses || []);
  if (usage.persistentVolumes.length || usage.persistentVolumeClaims.length) {
    const failure = error('Ceph StorageClass를 사용하는 PV/PVC가 있어 연결 해제를 차단했습니다.', 409);
    failure.safeMessage = `${failure.message} PV=${usage.persistentVolumes.join(',') || 'none'} PVC=${usage.persistentVolumeClaims.join(',') || 'none'}`;
    throw failure;
  }
  const cluster = await helmStatus(ctx, CLUSTER_RELEASE, NAMESPACE);
  if (cluster.installed) await withKubeconfig(ctx, (env) => command('helm', ['uninstall', CLUSTER_RELEASE, '--namespace', NAMESPACE, '--wait', '--timeout', '10m'], { env }));
  for (const name of metadata.snapshotClasses || []) await remove(ctx, `/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses/${encodeURIComponent(name)}`);
  for (const name of metadata.storageClasses || []) await remove(ctx, `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`);
  for (const ref of metadata.secretRefs || []) {
    const name = String(ref).split('/').pop();
    if (MANAGED_SECRETS.has(name)) await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets/${encodeURIComponent(name)}`);
  }
  await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/rook-ceph-mon-endpoints`);
  await remove(ctx, `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies/${OBSERVER_EGRESS_POLICY}`);
  await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
  return { ok: true, retained: ['remote Ceph pools', 'remote Ceph filesystems', 'remote Ceph data'], removed: ['consumer Rook external cluster', 'consumer CSI secrets', 'consumer StorageClasses', 'consumer VolumeSnapshotClasses'] };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedText(value, fallback = '', limit = 512) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, limit);
}

function observerSectionError(section, result) {
  const reason = boundedText(result.reason, 'Unavailable', 64);
  const messages = {
    PermissionDenied: '연결된 CephX 계정에 이 정보를 조회할 권한이 없습니다.',
    Unsupported: '대상 Ceph 클러스터가 이 관측 기능을 제공하지 않습니다.',
    Timeout: 'Ceph가 관측 제한 시간 안에 응답하지 않았습니다.',
    NotConfigured: 'Ceph 연결 정보가 아직 관측기에 준비되지 않았습니다.',
    ObserverUnavailable: 'Ceph 관측 명령을 실행할 수 없습니다.',
    ResponseTooLarge: 'Ceph 응답이 안전한 처리 크기를 초과했습니다.',
    InvalidResponse: 'Ceph가 해석할 수 없는 응답을 반환했습니다.',
    CommandFailed: 'Ceph가 이 관측 요청을 처리하지 못했습니다.',
  };
  return {
    section,
    reason,
    message: messages[reason] || 'Ceph 관측 정보를 사용할 수 없습니다.',
  };
}

function fingerprint(value) {
  const text = boundedText(value, '', 256);
  return text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}

function normalizeCephInsights(snapshot) {
  const source = record(snapshot);
  if (finiteNumber(source.schemaVersion, -1) !== 1) throw error('Ceph 관측 응답 계약을 인식할 수 없습니다.', 502);
  const results = record(source.results);
  const sectionNames = ['status', 'health', 'capacity', 'osds', 'pgs', 'hosts', 'services', 'versions'];
  const available = (name) => record(results[name]).available === true;
  const data = (name) => available(name) ? record(results[name]).data : {};
  const dataList = (name) => available(name) ? list(results[name].data) : [];
  const sectionErrors = sectionNames
    .filter((name) => !available(name))
    .map((name) => observerSectionError(name, record(results[name])));

  const status = data('status');
  const health = data('health');
  const capacity = data('capacity');
  const osdTree = data('osds');
  const pgStats = data('pgs');
  const pgSummary = record(pgStats.pg_summary);
  const versions = data('versions');
  const statusOdsMap = record(record(status.osdmap).osdmap || status.osdmap);
  const statusPgMap = record(status.pgmap);

  const capacityStats = record(capacity.stats);
  const totalBytes = finiteNumber(capacityStats.total_bytes);
  const usedBytes = finiteNumber(capacityStats.total_used_bytes);
  const availableBytes = finiteNumber(capacityStats.total_avail_bytes, Math.max(0, totalBytes - usedBytes));
  const pools = list(capacity.pools).map((value) => {
    const pool = record(value);
    const stats = record(pool.stats);
    const bytesUsed = finiteNumber(stats.bytes_used, finiteNumber(stats.stored));
    const maxAvailableBytes = finiteNumber(stats.max_avail);
    return {
      id: finiteNumber(pool.id, -1),
      name: boundedText(pool.name, '이름 없음', 253),
      bytesUsed,
      storedBytes: finiteNumber(stats.stored),
      maxAvailableBytes,
      objects: finiteNumber(stats.objects),
      percentUsed: finiteNumber(stats.percent_used, maxAvailableBytes + bytesUsed > 0
        ? (bytesUsed / (maxAvailableBytes + bytesUsed)) * 100
        : 0),
    };
  }).sort((a, b) => b.bytesUsed - a.bytesUsed || a.name.localeCompare(b.name));

  const osdNodes = list(osdTree.nodes).map(record);
  const hostNodes = osdNodes.filter((node) => node.type === 'host');
  const osdToHost = new Map();
  for (const host of hostNodes) {
    for (const child of list(host.children)) osdToHost.set(finiteNumber(child, -1), boundedText(host.name, 'unknown', 253));
  }
  const osdItems = osdNodes
    .filter((node) => node.type === 'osd')
    .map((node) => ({
      id: finiteNumber(node.id, -1),
      name: boundedText(node.name, `osd.${finiteNumber(node.id, -1)}`, 253),
      host: osdToHost.get(finiteNumber(node.id, -1)) || boundedText(node.host, 'unknown', 253),
      status: boundedText(node.status, 'unknown', 32).toLowerCase(),
      in: finiteNumber(node.reweight, 0) > 0,
      deviceClass: boundedText(node.device_class, 'unknown', 64),
      utilization: finiteNumber(node.utilization),
      totalBytes: finiteNumber(node.kb) * 1024,
      usedBytes: finiteNumber(node.kb_used) * 1024,
      availableBytes: finiteNumber(node.kb_avail) * 1024,
    }))
    .sort((a, b) => a.id - b.id);
  const osdTotal = finiteNumber(statusOdsMap.num_osds, osdItems.length);
  const osdUp = finiteNumber(statusOdsMap.num_up_osds, osdItems.filter((item) => item.status === 'up').length);
  const osdIn = finiteNumber(statusOdsMap.num_in_osds, osdItems.filter((item) => item.in).length);
  const osdUtilizations = osdItems.map((item) => item.utilization).filter(Number.isFinite);
  const byHost = hostNodes.map((host) => {
    const hostName = boundedText(host.name, 'unknown', 253);
    const hostOsds = osdItems.filter((item) => item.host === hostName);
    const total = hostOsds.reduce((sum, item) => sum + item.totalBytes, 0);
    const used = hostOsds.reduce((sum, item) => sum + item.usedBytes, 0);
    return {
      name: hostName,
      osds: hostOsds.length,
      up: hostOsds.filter((item) => item.status === 'up').length,
      in: hostOsds.filter((item) => item.in).length,
      totalBytes: total,
      usedBytes: used,
      utilization: total > 0 ? (used / total) * 100 : 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const pgStates = list(pgStats.pgs_by_state || pgStats.num_pg_by_state || pgSummary.num_pg_by_state || statusPgMap.pgs_by_state).map((value) => {
    const state = record(value);
    return {
      state: boundedText(state.state_name || state.name, 'unknown', 128),
      count: finiteNumber(state.count, finiteNumber(state.num)),
    };
  }).sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
  const pgTotal = finiteNumber(pgStats.num_pgs, finiteNumber(pgSummary.num_pgs,
    finiteNumber(statusPgMap.num_pgs, pgStates.reduce((sum, state) => sum + state.count, 0))));
  const healthyPgCount = pgStates
    .filter((state) => state.state.split('+').every((part) => part === 'active' || part === 'clean'))
    .reduce((sum, state) => sum + state.count, 0);

  const hosts = dataList('hosts').map((value) => {
    const host = record(value);
    return {
      hostname: boundedText(host.hostname, 'unknown', 253),
      address: boundedText(host.addr, '확인 불가', 256),
      labels: list(host.labels).map((label) => boundedText(label, '', 64)).filter(Boolean).slice(0, 64),
      status: boundedText(host.status, 'online', 64) || 'online',
    };
  }).sort((a, b) => a.hostname.localeCompare(b.hostname));

  const services = dataList('services').map((value) => {
    const service = record(value);
    return {
      type: boundedText(service.daemon_type, 'unknown', 64),
      id: boundedText(service.daemon_id, '', 253),
      hostname: boundedText(service.hostname, 'unknown', 253),
      status: finiteNumber(service.status, 0),
      statusDescription: boundedText(service.status_desc, 'unknown', 128),
      version: boundedText(service.version, '', 256),
      lastRefresh: boundedText(service.last_refresh, '', 64),
    };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));

  const versionCounts = [];
  for (const [daemonType, value] of Object.entries(versions)) {
    for (const [version, count] of Object.entries(record(value))) {
      versionCounts.push({
        daemonType: boundedText(daemonType, 'unknown', 64),
        version: boundedText(version, 'unknown', 256),
        count: finiteNumber(count),
      });
    }
  }

  const healthStatus = boundedText(record(status.health).status || health.status || health.overall_status, 'UNKNOWN', 64);
  const fsid = boundedText(status.fsid, '', 256);
  return {
    schemaVersion: 1,
    observedAt: boundedText(source.observedAt, new Date().toISOString(), 64),
    durationMs: finiteNumber(source.durationMs),
    cached: source.cached === true,
    cacheAgeSeconds: finiteNumber(source.cacheAgeSeconds),
    partial: sectionErrors.length > 0,
    capabilities: sectionNames.filter(available),
    cluster: {
      health: healthStatus,
      fsidFingerprint: fingerprint(fsid),
      monitors: finiteNumber(record(status.monmap).num_mons, list(record(status.monmap).mons).length),
      managers: {
        active: boundedText(record(status.mgrmap).active_name, '', 253),
        standbys: list(record(status.mgrmap).standbys).length,
      },
      versions: versionCounts,
    },
    capacity: {
      totalBytes,
      usedBytes,
      availableBytes,
      percentUsed: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    },
    pools,
    osds: {
      total: osdTotal,
      up: osdUp,
      down: Math.max(0, osdTotal - osdUp),
      in: osdIn,
      out: Math.max(0, osdTotal - osdIn),
      averageUtilization: osdUtilizations.length ? osdUtilizations.reduce((sum, value) => sum + value, 0) / osdUtilizations.length : 0,
      maxUtilization: osdUtilizations.length ? Math.max(...osdUtilizations) : 0,
      items: osdItems,
      byHost,
    },
    pgs: {
      total: pgTotal,
      healthy: healthyPgCount,
      unhealthy: Math.max(0, pgTotal - healthyPgCount),
      states: pgStates,
    },
    hosts,
    services,
    sectionErrors,
  };
}

async function cephInsights(ctx, forceRefresh = false) {
  const authSecret = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets/${OBSERVER_API_SECRET}`);
  const observerToken = decodedSecretField(authSecret, 'token');
  const authenticated = observerToken.length >= 32;
  let response;
  try {
    response = await (ctx.cephObserverFetch || fetch)(
      `${CEPH_OBSERVER_URL}/snapshot${forceRefresh ? '?refresh=1' : ''}`,
      {
        headers: {
          accept: 'application/json',
          ...(authenticated ? { 'x-opensphere-observer-token': observerToken } : {}),
        },
        signal: AbortSignal.timeout(25_000),
      },
    );
  } catch {
    throw error('Ceph 관측 서비스에 연결할 수 없습니다.', 503);
  }
  if (!response.ok) throw error(`Ceph 관측 서비스가 HTTP ${response.status}를 반환했습니다.`, 502);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > CEPH_OBSERVER_MAX_BYTES) throw error('Ceph 관측 응답이 허용 크기를 초과했습니다.', 502);
  let snapshot;
  try { snapshot = JSON.parse(text); } catch { throw error('Ceph 관측 서비스가 올바른 JSON을 반환하지 않았습니다.', 502); }
  return {
    ...normalizeCephInsights(snapshot),
    observerSecurity: authenticated
      ? {
          mode: 'Authenticated',
          message: 'Cluster Manager와 Ceph 관측 서비스 사이의 애플리케이션 인증이 적용되었습니다.',
        }
      : {
          mode: 'LegacyUnauthenticated',
          message: '기존 runtime 호환 관측입니다. 전용 observer CephX 계정과 보안 runtime chart 적용 전까지 애플리케이션 인증이 강제되지 않습니다.',
        },
  };
}

function createCephManager(ctx) {
  const importCleanupTimer = setInterval(() => {
    void pruneExpiredImports(ctx).catch((failure) => {
      importCleanupHealth.totalFailures += 1;
      importCleanupHealth.consecutiveFailures += 1;
      importCleanupHealth.lastFailureAt = new Date().toISOString();
      importCleanupHealth.lastError = `staged Secret 정리 작업을 실행하지 못했습니다: ${safeError(failure)}`;
      console.warn(`[ceph] ${importCleanupHealth.lastError}`);
    });
  }, 15 * 60 * 1000);
  importCleanupTimer.unref?.();
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/ceph/')) return false;
    try {
      if (req.method === 'GET' && pathname === '/api/ceph/oaa/capabilities') {
        await actorForOaaOwner(ctx, req, false);
        const prerequisites = await cephOwnerPrerequisites(ctx);
        const capabilities = ['status-read'];
        if (prerequisites.ready) capabilities.push('import-stage', 'plan-from-import', 'connect-from-import', 'disconnect');
        ctx.jsonRes(res, 200, {
          apiVersion: 'opensphere.io/oaa-ceph-owner/v1', capabilities,
          secretInputPolicy: 'StagedSecretRefOnly', mutationAssurance: 'aal2', prerequisites,
        });
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/ceph/oaa/status') {
        await actorForOaaOwner(ctx, req, false);
        const [status, prerequisites, installationRequest] = await Promise.all([
          cephStatus(ctx),
          cephOwnerPrerequisites(ctx),
          cephPrerequisiteRequestStatus(ctx, req),
        ]);
        ctx.jsonRes(res, 200, { ...status, ownerPrerequisites: { ...prerequisites, installationRequest } });
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/ceph/oaa/insights') {
        await actorForOaaOwner(ctx, req, false);
        const requestUrl = new URL(req.url || pathname, 'http://cluster-manager.local');
        const refresh = requestUrl.searchParams.get('refresh') === '1';
        ctx.jsonRes(res, 200, await cephInsights(ctx, refresh));
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/ceph/prerequisites/request') {
        const result = await requestCephPrerequisiteChange(ctx, req, await readJson(req));
        ctx.jsonRes(res, 202, result);
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/ceph/imports') {
        const actor = await actorForOaaOwner(ctx, req, true);
        const body = requireClosedObject(await readJson(req), ['connection', 'confirm', 'reason'], 'request');
        if (String(body.confirm || '') !== 'stage Ceph connection') throw error("Ceph 접속 정보 staging 확인 값으로 'stage Ceph connection'을 입력해야 합니다.");
        const reason = reasonFrom(body);
        const prerequisites = await cephOwnerPrerequisites(ctx);
        if (!prerequisites.ready) throw error(`Ceph runtime prerequisites are not ready: ${prerequisites.blockers.join(' ')}`, 409);
        const connection = validateConnectionInput(body.connection);
        const correlationId = correlationFrom(req);
        const staged = await auditedChange(ctx, actor, 'CephConnectionStaged', reason, {
          fsidFingerprint: connection.fsidFingerprint,
          monitorCount: connection.monitorCount,
          userID: connection.userID,
          cephEntity: connection.cephEntity,
          csiUserID: connection.csiUserID,
          storageClasses: connection.storageClasses.map((item) => item.name),
        }, correlationId, () => stageConnectionImport(ctx, body.connection, actor));
        ctx.jsonRes(res, 201, { ...staged, correlationId });
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/ceph/oaa/plan') {
        await actorForOaaOwner(ctx, req, false);
        const body = requireClosedObject(await readJson(req), ['importRef'], 'request');
        const staged = await connectionFromImportRef(ctx, body.importRef);
        const [snapshotSupported, prerequisites] = await Promise.all([snapshotApiAvailable(ctx), cephOwnerPrerequisites(ctx)]);
        ctx.jsonRes(res, 200, { ...planFor(staged.connection, snapshotSupported), importRef: `${IMPORT_NAMESPACE}/${staged.name}`, prerequisites });
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/ceph/oaa/connect') {
        const actor = await actorForOaaOwner(ctx, req, true);
        const body = requireClosedObject(await readJson(req), ['importRef', 'confirm', 'reason'], 'request');
        const importName = importNameFromRef(body.importRef);
        const importRef = `${IMPORT_NAMESPACE}/${importName}`;
        if (String(body.confirm || '') !== `connect Ceph external storage using ${importRef}`) throw error(`Ceph 연결 확인 값으로 'connect Ceph external storage using ${importRef}'를 입력해야 합니다.`);
        const reason = reasonFrom(body);
        if (activeOperations.has('external')) throw error('Ceph 연결 작업이 이미 진행 중입니다.', 409);
        activeOperations.add('external');
        try {
          const staged = await connectionFromImportRef(ctx, importRef);
          const correlationId = correlationFrom(req);
          const status = await auditedChange(
            ctx, actor, 'OAACephExternalConnectRequested', reason,
            { importRef, fsidFingerprint: staged.connection.fsidFingerprint, chartVersion: CHART_VERSION, storageClasses: staged.connection.storageClasses.map((item) => item.name) },
            correlationId,
            async () => {
              const result = await installConnection(ctx, staged.connection, actor);
              if (result.state === 'Ready') await deleteProviderImport(ctx, staged.name);
              return result;
            },
            // Ready에 도달하지 못한 설치는 성공으로 기록하지 않는다.
            (result) => (result.state === 'Ready' ? 'succeeded' : 'failed'),
          );
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalConnected', target: 'CephExternal/rook-ceph', result: status.state, reason: `${reason} · ${status.message}` });
          ctx.jsonRes(res, status.state === 'Ready' ? 200 : 502, { ok: status.state === 'Ready', status, importConsumed: status.state === 'Ready', correlationId });
          return true;
        } finally { activeOperations.delete('external'); }
      }
      if (req.method === 'POST' && pathname === '/api/ceph/services/cephfs') {
        const actor = await actorForOaaOwner(ctx, req, true);
        const body = requireClosedObject(await readJson(req), ['configuration', 'confirm', 'reason'], 'request');
        if (String(body.confirm || '') !== 'configure CephFS storage service') {
          throw error("CephFS 구성 확인 값으로 'configure CephFS storage service'를 입력해야 합니다.");
        }
        const reason = reasonFrom(body);
        const validated = validateCephFsInput(body.configuration);
        if (activeOperations.has('cephfs')) throw error('CephFS 구성 작업이 이미 진행 중입니다.', 409);
        activeOperations.add('cephfs');
        try {
          const correlationId = correlationFrom(req);
          const result = await auditedChange(
            ctx, actor, 'CephFsServiceConfigurationRequested', reason, validated.audit, correlationId,
            () => configureCephFsService(ctx, body.configuration, actor),
            (value) => (value.status.csi?.serviceCoverage?.services?.find((item) => item.id === 'cephfs')?.ready === true ? 'succeeded' : 'failed'),
          );
          const service = result.status.csi?.serviceCoverage?.services?.find((item) => item.id === 'cephfs');
          const ready = service?.ready === true;
          await ctx.publishNotify({
            userActor: actor.username,
            action: 'CephFsServiceConfigured',
            target: `StorageClass/${validated.audit.storageClassName}`,
            result: ready ? 'Ready' : 'NeedsConfiguration',
            reason: `${reason} · filesystem=${validated.audit.filesystem} pool=${validated.audit.pool}`,
          });
          ctx.jsonRes(res, ready ? 200 : 502, { ok: ready, ...result, correlationId });
          return true;
        } finally { activeOperations.delete('cephfs'); }
      }
      if (req.method === 'POST' && pathname === '/api/ceph/oaa/disconnect') {
        const actor = await actorForOaaOwner(ctx, req, true);
        const body = requireClosedObject(await readJson(req), ['confirm', 'reason'], 'request');
        if (String(body.confirm || '') !== 'disconnect Ceph external storage') throw error("Ceph 연결 해제 확인 값으로 'disconnect Ceph external storage'를 입력해야 합니다.");
        const reason = reasonFrom(body);
        if (activeOperations.has('external')) throw error('Ceph 연결 작업이 이미 진행 중입니다.', 409);
        activeOperations.add('external');
        try {
          const configMap = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
          const metadata = parseMetadata(configMap);
          if (!metadata) throw error('Cluster Manager가 관리하는 Ceph 연결이 없습니다.', 409);
          const correlationId = correlationFrom(req);
          const result = await auditedChange(
            ctx, actor, 'OAACephExternalDisconnectRequested', reason,
            { fsidFingerprint: metadata.fsidFingerprint, storageClasses: metadata.storageClasses },
            correlationId,
            () => disconnect(ctx, metadata),
          );
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalDisconnected', target: 'CephExternal/rook-ceph', result: 'success', reason: `${reason} · remote data retained` });
          ctx.jsonRes(res, 200, { ...result, correlationId });
          return true;
        } finally { activeOperations.delete('external'); }
      }
      // 읽기 전용 상태 조회도 OAA 읽기 권한(console.ceph.read)을 요구한다.
      // 이전에는 임의 인증 사용자에게 제공되어 /api/ceph/oaa/status와 인가 기준이 어긋났다.
      if (req.method === 'GET' && pathname === '/api/ceph/status') {
        await actorForOaaOwner(ctx, req, false);
        ctx.jsonRes(res, 200, await cephStatus(ctx));
        return true;
      }
      if (req.method !== 'POST') throw error('method not allowed', 405);
      const body = await readJson(req);
      // 변경 계획 수립은 비변경 작업이므로 /api/ceph/oaa/plan과 동일하게 읽기 권한을 요구한다.
      // 변경을 수행하는 legacy 경로(/api/ceph/connect·/api/ceph/disconnect)는 staged Secret과
      // AAL2 게이트를 우회할 수 있어 제거했다. 연결·해제는 /api/ceph/oaa/* 만 사용한다.
      if (pathname === '/api/ceph/plan') {
        await actorForOaaOwner(ctx, req, false);
        const request = requireClosedObject(body, ['connection'], 'request');
        const connection = validateConnectionInput(request.connection);
        const snapshotSupported = await snapshotApiAvailable(ctx);
        ctx.jsonRes(res, 200, planFor(connection, snapshotSupported));
        return true;
      }
      if (pathname === '/api/ceph/connect' || pathname === '/api/ceph/disconnect') {
        throw error('이 경로는 제거되었습니다. AAL2와 console.ceph.manage를 강제하는 /api/ceph/oaa/connect 또는 /api/ceph/oaa/disconnect를 사용하십시오.', 410);
      }
      throw error('not found', 404);
    } catch (e) {
      ctx.jsonRes(res, Number(e.code) >= 400 ? Number(e.code) : 500, { error: safeError(e) });
      return true;
    }
  };
}

module.exports = {
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
  usageFor,
  importNameFromRef,
  cephOwnerPrerequisites,
  providerGuide,
  helmMetadataAccessDenied,
  requestCephPrerequisiteChange,
  cephPrerequisiteRequestStatus,
  normalizeCephInsights,
  cephInsights,
  CHART_VERSION,
};
