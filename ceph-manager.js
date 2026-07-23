'use strict';

const crypto = require('crypto');
const fs = require('fs');
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
const CHART_VERSION = 'v1.20.2';
const CLUSTER_CHART = process.env.ROOK_CLUSTER_CHART || `/app/ceph-charts/rook-ceph-cluster-${CHART_VERSION}.tgz`;
const activeOperations = new Set();
const OAA_CEPH_READ_PERMISSION = 'console.ceph.read';
const OAA_CEPH_MANAGE_PERMISSION = 'console.ceph.manage';
const IMPORT_SECRET_TYPE = 'opensphere.io/ceph-provider-export';
const IMPORT_TTL_MS = 60 * 60 * 1000;
const IMPORT_NAME_RE = /^opensphere-ceph-import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MANAGED_LABELS = Object.freeze({
  'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
  'opensphere.io/ceph-connection': 'external',
});

const SECRET_NAMES = new Set([
  'rook-ceph-mon',
  'rook-ceph-operator-creds',
  'rook-csi-rbd-node',
  'rook-csi-rbd-provisioner',
  'rook-csi-cephfs-node',
  'rook-csi-cephfs-provisioner',
]);
const IGNORED_EXPORTS = new Set([
  'ConfigMap/external-cluster-user-command',
  'Secret/rook-ceph-dashboard-link',
  'CephCluster/monitoring-endpoint',
]);

const PROVIDER_GUIDE = Object.freeze({
  schemaVersion: 1,
  rookVersion: CHART_VERSION,
  consumerNamespace: NAMESPACE,
  requiredInformation: [
    { id: 'fsid', label: 'Ceph FSID', description: '대상 Ceph 클러스터를 유일하게 식별하는 UUID', secret: false },
    { id: 'mon-endpoints', label: 'MON endpoint', description: '각 Monitor의 public-network 주소와 포트(msgr2 3300 권장, msgr1 6789 지원)', secret: false },
    { id: 'storage', label: 'RBD pool / CephFS', description: '사용할 RBD data pool 및/또는 CephFS filesystem·data pool 이름', secret: false },
    { id: 'cephx', label: '제한된 CephX 사용자', description: 'healthchecker와 선택한 CSI 유형의 node/provisioner 사용자 및 key', secret: true },
    { id: 'provider-export', label: 'Rook provider export JSON', description: '동일 Rook 버전의 공식 스크립트가 생성한 JSON resource 배열', secret: true },
  ],
  requiredPreparation: [
    { id: 'health', label: 'Ceph health', description: 'MON quorum과 OSD가 정상이며 연결 작업 시 HEALTH_OK 또는 승인된 경고 상태' },
    { id: 'storage', label: 'Storage 준비', description: 'RBD pool은 생성·초기화되어 있고, CephFS 사용 시 filesystem/MDS가 Active' },
    { id: 'network', label: 'Public network 경로', description: '모든 consumer node에서 MON과 OSD/MDS public 주소로 라우팅·방화벽 통신 가능' },
    { id: 'least-privilege', label: 'Consumer별 최소 권한', description: '--restricted-auth-permission과 고유 --k8s-cluster-name으로 전용 CSI 사용자를 생성' },
    { id: 'lifecycle', label: '운영 인계', description: 'export 생성 인자, Ceph/Rook 버전, key rotation·upgrade 절차와 담당자를 기록' },
  ],
  network: {
    monitorTcpPorts: [3300, 6789],
    cephDaemonTcpRange: '6800-7568',
    sourceScope: 'all-consumer-kubernetes-nodes',
  },
  export: {
    format: 'json',
    commandTemplate: `python3 create-external-cluster-resources.py --namespace ${NAMESPACE} --format json --k8s-cluster-name <consumer-cluster-name> --restricted-auth-permission true --rbd-data-pool-name <rbd-pool> [--cephfs-filesystem-name <cephfs-name>] [--v2-port-enable]`,
    requiredFlags: ['--namespace', '--format json', '--k8s-cluster-name', '--restricted-auth-permission true'],
  },
  unsupportedInputs: ['client.admin keyring', 'monitor keyring', 'RGW/object-store credentials', 'Ceph dashboard credentials'],
});

function providerGuide() {
  return structuredClone(PROVIDER_GUIDE);
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

function credential(item, expectedPrefix) {
  onlyKeys(item.data, ['userID', 'userKey'], `${item.kind}/${item.name}`);
  const userID = String(item.data.userID || '');
  if (!new RegExp(`^client\\.${expectedPrefix}(?:[-.][A-Za-z0-9.-]+)?$`).test(userID)) {
    throw error(`${item.name}의 userID가 제한된 CSI 사용자 형식이 아닙니다.`);
  }
  const userKey = String(item.data.userKey || '');
  if (!/^[A-Za-z0-9+/_=-]{16,1024}$/.test(userKey)) throw error(`${item.name}의 userKey 형식이 올바르지 않습니다.`);
  return { userID, userKey };
}

function storageClass(item, secretNames) {
  const allowed = [
    'pool', 'dataPool', 'fsName',
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
  const operatorCredential = credential(operator, 'healthchecker');
  const secrets = [operator, mon];
  const credentialSpecs = [
    ['rook-csi-rbd-node', 'csi-rbd-node'],
    ['rook-csi-rbd-provisioner', 'csi-rbd-provisioner'],
    ['rook-csi-cephfs-node', 'csi-cephfs-node'],
    ['rook-csi-cephfs-provisioner', 'csi-cephfs-provisioner'],
  ];
  for (const [name, prefix] of credentialSpecs) {
    const item = items.find((candidate) => candidate.kind === 'Secret' && candidate.name === name);
    if (item) { credential(item, prefix); secrets.push(item); }
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
    operatorUser: operatorCredential.userID,
    configMaps: [endpoints],
    secrets,
    storageClasses,
    ignored: items.filter((item) => IGNORED_EXPORTS.has(`${item.kind}/${item.name}`)).map((item) => `${item.kind}/${item.name}`),
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

async function selfCanI(ctx, verb, group, resource, namespace = '') {
  try {
    const review = await kube(ctx, 'POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { verb, group, resource, ...(namespace ? { namespace } : {}) } },
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
      [verb, '', 'secrets', NAMESPACE], [verb, '', 'configmaps', NAMESPACE],
      [verb, 'ceph.rook.io', 'cephclusters', NAMESPACE],
    ]),
    ...['get', 'list', 'create', 'update', 'patch', 'delete'].map((verb) => [verb, 'storage.k8s.io', 'storageclasses', '']),
    ...(snapshotCrd ? ['get', 'list', 'create', 'update', 'patch', 'delete'].map((verb) => [verb, 'snapshot.storage.k8s.io', 'volumesnapshotclasses', '']) : []),
  ];
  const permissions = await Promise.all(permissionSpecs.map(async ([verb, group, resource, namespace]) => ({
    verb, group, resource, namespace, allowed: await selfCanI(ctx, verb, group, resource, namespace),
  })));
  const missingPermissions = permissions.filter((item) => !item.allowed).map((item) => `${item.verb} ${item.group || 'core'}/${item.resource}${item.namespace ? ` namespace=${item.namespace}` : ''}`);
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

async function stageProviderImport(ctx, providerExport, actor) {
  await pruneExpiredImports(ctx);
  const connection = validateProviderExport(providerExport);
  const name = `opensphere-ceph-import-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + IMPORT_TTL_MS).toISOString();
  await kube(ctx, 'POST', `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets`, {
    apiVersion: 'v1', kind: 'Secret', type: IMPORT_SECRET_TYPE,
    metadata: {
      name, namespace: IMPORT_NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', 'opensphere.io/ceph-import': 'staged' },
      annotations: { 'opensphere.io/staged-by': actor.username, 'opensphere.io/fsid-fingerprint': connection.fsidFingerprint, 'opensphere.io/expires-at': expiresAt },
    },
    stringData: { providerExport: JSON.stringify(providerExport) },
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
  await Promise.all(expired.map((item) => deleteProviderImport(ctx, item.metadata?.name).catch(() => undefined)));
  return expired.length;
}

async function connectionFromImportRef(ctx, importRef) {
  const name = importNameFromRef(importRef);
  const secret = await optionalKube(ctx, `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets/${encodeURIComponent(name)}`);
  if (!secret || secret.type !== IMPORT_SECRET_TYPE || secret.metadata?.labels?.['opensphere.io/ceph-import'] !== 'staged') {
    throw error('유효한 staged Ceph provider import를 찾지 못했습니다.', 404);
  }
  const expiresAt = Date.parse(String(secret.metadata?.annotations?.['opensphere.io/expires-at'] || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteProviderImport(ctx, name).catch(() => undefined);
    throw error('staged Ceph provider import가 만료되었습니다. 관리자 UI에서 다시 staging하십시오.', 410);
  }
  const encoded = String(secret.data?.providerExport || '');
  if (!encoded || encoded.length > 256 * 1024) throw error('staged Ceph provider import payload가 없거나 너무 큽니다.', 409);
  let providerExport;
  try { providerExport = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw error('staged Ceph provider import payload가 손상되었습니다.', 409); }
  return { name, connection: validateProviderExport(providerExport) };
}

async function deleteProviderImport(ctx, name) {
  return remove(ctx, `/api/v1/namespaces/${IMPORT_NAMESPACE}/secrets/${encodeURIComponent(name)}`);
}

function storageClassManifest(item) {
  const cephfs = item.name === 'cephfs';
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
  const cephfs = storageClass.name === 'cephfs';
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
  const payload = {
    schemaVersion: 1,
    mode: 'RookExternal',
    fsid: connection.fsid,
    fsidFingerprint: connection.fsidFingerprint,
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

function helmMetadataAccessDenied(failure) {
  const message = String(failure?.safeMessage || failure?.message || '');
  return /secrets is forbidden|cannot (?:get|list) resource ["']secrets["']|failed to query with labels/i.test(message);
}

async function helmStatus(ctx, release, namespace, tolerateMetadataAccessDenied = false) {
  try {
    const out = await withKubeconfig(ctx, (env) => command('helm', ['status', release, '--namespace', namespace, '--output', 'json'], { env, timeoutMs: 30000 }));
    const value = JSON.parse(out.stdout || '{}');
    return { installed: true, status: value.info?.status || 'unknown', chart: value.chart?.metadata?.version || '', revision: value.version || 0 };
  } catch (e) {
    if (/release: not found|not found/i.test(e.safeMessage || e.message || '')) return { installed: false, status: 'not-installed', chart: '', revision: 0 };
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

  const [metadataConfig, cephCluster, storageClasses, csiDrivers, operator, cluster] = await Promise.all([
    optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`),
    optionalKube(ctx, `/apis/ceph.rook.io/v1/namespaces/${NAMESPACE}/cephclusters/${NAMESPACE}`),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/storageclasses'),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/csidrivers'),
    helmStatus(ctx, OPERATOR_RELEASE, NAMESPACE, true),
    helmStatus(ctx, CLUSTER_RELEASE, NAMESPACE, true),
  ]);
  const metadata = parseMetadata(metadataConfig);
  const wantedClasses = new Set(metadata?.storageClasses || []);
  const classes = (storageClasses.items || []).filter((item) => wantedClasses.has(item.metadata?.name)).map((item) => ({ name: item.metadata.name, provisioner: item.provisioner, reclaimPolicy: item.reclaimPolicy }));
  const drivers = (csiDrivers.items || []).filter((item) => String(item.metadata?.name || '').startsWith(`${NAMESPACE}.`)).map((item) => item.metadata.name);
  const conditionReady = (cephCluster?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
  const connected = conditionReady || cephCluster?.status?.state === 'Connected' || cephCluster?.status?.phase === 'Connected';
  let state = 'NotConfigured';
  let reason = 'NoExternalCephConnection';
  let message = '선택한 Kubernetes 클러스터에 연결된 외부 Ceph이 없습니다.';
  if (!kubernetes.ready) {
    state = 'Blocked'; reason = 'KubernetesNotReady'; message = `Kubernetes 노드 ${kubernetes.readyNodes}/${kubernetes.nodes} Ready`;
  } else if (metadata) {
    if (connected && drivers.length && classes.length === wantedClasses.size) {
      state = 'Ready'; reason = 'ExternalCephConnected'; message = `외부 Ceph과 CSI StorageClass ${classes.length}개가 Ready입니다.`;
    } else {
      state = 'Degraded'; reason = 'ExternalCephNotReady'; message = '외부 Ceph 연결 리소스가 존재하지만 CephCluster/CSI가 아직 Ready가 아닙니다.';
    }
  }
  return {
    state, reason, message, checkedAt: new Date().toISOString(), kubernetes, providerGuide: providerGuide(),
    connection: metadata ? {
      mode: metadata.mode,
      fsidFingerprint: metadata.fsidFingerprint,
      secretRefs: metadata.secretRefs || [],
      connectedBy: metadata.connectedBy,
      connectedAt: metadata.connectedAt,
      chartVersion: metadata.chartVersion,
    } : null,
    rook: { operator, cluster, cephCluster: cephCluster ? { state: cephCluster.status?.state || cephCluster.status?.phase || 'Unknown', health: cephCluster.status?.ceph?.health || 'Unknown' } : null },
    csi: { drivers, storageClasses: classes },
  };
}

function planFor(connection, snapshotSupported) {
  const snapshotClasses = snapshotSupported ? connection.storageClasses.map((item) => `${item.name}-snapshot`) : [];
  const resources = [
    ...connection.configMaps.map((item) => ({ kind: 'ConfigMap', namespace: NAMESPACE, name: item.name })),
    ...connection.secrets.map((item) => ({ kind: 'Secret', namespace: NAMESPACE, name: item.name, secretRefOnly: true })),
    ...connection.storageClasses.map((item) => ({ kind: 'StorageClass', namespace: '', name: item.name, reclaimPolicy: 'Retain' })),
    ...snapshotClasses.map((name) => ({ kind: 'VolumeSnapshotClass', namespace: '', name, deletionPolicy: 'Retain' })),
  ];
  return {
    mode: 'RookExternal', namespace: NAMESPACE,
    parent: 'Kubernetes',
    fsidFingerprint: connection.fsidFingerprint,
    monitorCount: connection.monitorCount,
    monitorProtocols: connection.monitorProtocols,
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

async function auditRequired(ctx, actor, action, reason, metadata = {}) {
  const response = await fetch(`${ctx.controller}/api/admin/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.token()}`, 'content-type': 'application/json', 'x-opensphere-source': 'cluster-manager' },
    body: JSON.stringify({ source: 'cluster-manager', userActor: actor.username, action, target: 'CephExternal/rook-ceph', result: 'requested', reason, metadata }),
  });
  if (!response.ok) throw error(`내구 감사 저장소를 사용할 수 없습니다(HTTP ${response.status}). Ceph 변경을 차단했습니다.`, 503);
}

async function installConnection(ctx, connection, actor) {
  const prerequisites = await cephOwnerPrerequisites(ctx);
  if (!prerequisites.ready) throw error(`Ceph runtime prerequisites are not ready: ${prerequisites.blockers.join(' ')}`, 409);
  // 소유권 marker를 credential보다 먼저 기록한다. 설치가 중단되어도 다음 시도는
  // 외부 Rook을 오인하지 않고 같은 OpenSphere 작업을 안전하게 재개할 수 있다.
  await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, CONNECTION_CONFIGMAP, metadataManifest(connection, [], actor));

  for (const item of connection.configMaps) await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, item.name, configMapManifest(item));
  for (const item of connection.secrets) await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets`, item.name, secretManifest(item));

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

async function usageFor(ctx, storageClassNames) {
  const wanted = new Set(storageClassNames);
  const [pvs, pvcs] = await Promise.all([
    kube(ctx, 'GET', '/api/v1/persistentvolumes'),
    kube(ctx, 'GET', '/api/v1/persistentvolumeclaims'),
  ]);
  return {
    persistentVolumes: (pvs.items || []).filter((item) => wanted.has(item.spec?.storageClassName)).map((item) => item.metadata?.name),
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
    if (SECRET_NAMES.has(name)) await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/secrets/${encodeURIComponent(name)}`);
  }
  await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/rook-ceph-mon-endpoints`);
  await remove(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
  return { ok: true, retained: ['remote Ceph pools', 'remote Ceph filesystems', 'remote Ceph data'], removed: ['consumer Rook external cluster', 'consumer CSI secrets', 'consumer StorageClasses', 'consumer VolumeSnapshotClasses'] };
}

function createCephManager(ctx) {
  const importCleanupTimer = setInterval(() => {
    void pruneExpiredImports(ctx).catch(() => undefined);
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
        const [status, prerequisites] = await Promise.all([cephStatus(ctx), cephOwnerPrerequisites(ctx)]);
        ctx.jsonRes(res, 200, { ...status, ownerPrerequisites: prerequisites });
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/ceph/imports') {
        const actor = await actorForOaaOwner(ctx, req, true);
        const body = requireClosedObject(await readJson(req), ['providerExport', 'confirm', 'reason'], 'request');
        if (String(body.confirm || '') !== 'stage Ceph provider export') throw error("Ceph provider export staging 확인 값으로 'stage Ceph provider export'를 입력해야 합니다.");
        const reason = reasonFrom(body);
        const prerequisites = await cephOwnerPrerequisites(ctx);
        if (!prerequisites.ready) throw error(`Ceph runtime prerequisites are not ready: ${prerequisites.blockers.join(' ')}`, 409);
        const connection = validateProviderExport(body.providerExport);
        await auditRequired(ctx, actor, 'CephProviderImportStaged', reason, { fsidFingerprint: connection.fsidFingerprint, storageClasses: connection.storageClasses.map((item) => item.name) });
        ctx.jsonRes(res, 201, await stageProviderImport(ctx, body.providerExport, actor));
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
          await auditRequired(ctx, actor, 'OAACephExternalConnectRequested', reason, { importRef, fsidFingerprint: staged.connection.fsidFingerprint, chartVersion: CHART_VERSION, storageClasses: staged.connection.storageClasses.map((item) => item.name) });
          const status = await installConnection(ctx, staged.connection, actor);
          if (status.state === 'Ready') await deleteProviderImport(ctx, staged.name);
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalConnected', target: 'CephExternal/rook-ceph', result: status.state, reason: `${reason} · ${status.message}` });
          ctx.jsonRes(res, status.state === 'Ready' ? 200 : 502, { ok: status.state === 'Ready', status, importConsumed: status.state === 'Ready' });
          return true;
        } finally { activeOperations.delete('external'); }
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
          await auditRequired(ctx, actor, 'OAACephExternalDisconnectRequested', reason, { fsidFingerprint: metadata.fsidFingerprint, storageClasses: metadata.storageClasses });
          const result = await disconnect(ctx, metadata);
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalDisconnected', target: 'CephExternal/rook-ceph', result: 'success', reason: `${reason} · remote data retained` });
          ctx.jsonRes(res, 200, result);
          return true;
        } finally { activeOperations.delete('external'); }
      }
      if (req.method === 'GET' && pathname === '/api/ceph/status') {
        await actorFor(ctx, req, false);
        ctx.jsonRes(res, 200, await cephStatus(ctx));
        return true;
      }
      if (req.method !== 'POST') throw error('method not allowed', 405);
      const body = await readJson(req);
      const actor = await actorFor(ctx, req, true);
      if (pathname === '/api/ceph/plan') {
        const connection = validateProviderExport(body.providerExport);
        const snapshotSupported = await snapshotApiAvailable(ctx);
        ctx.jsonRes(res, 200, planFor(connection, snapshotSupported));
        return true;
      }
      const reason = reasonFrom(body);
      if (activeOperations.has('external')) throw error('Ceph 연결 작업이 이미 진행 중입니다.', 409);
      activeOperations.add('external');
      try {
        if (pathname === '/api/ceph/connect') {
          const connection = validateProviderExport(body.providerExport);
          await auditRequired(ctx, actor, 'CephExternalConnectRequested', reason, { fsidFingerprint: connection.fsidFingerprint, chartVersion: CHART_VERSION, storageClasses: connection.storageClasses.map((item) => item.name) });
          const status = await installConnection(ctx, connection, actor);
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalConnected', target: 'CephExternal/rook-ceph', result: status.state, reason: `${reason} · ${status.message}` });
          ctx.jsonRes(res, status.state === 'Ready' ? 200 : 502, { ok: status.state === 'Ready', status });
          return true;
        }
        if (pathname === '/api/ceph/disconnect') {
          if (String(body.confirm || '') !== 'DISCONNECT') throw error("연결 해제 확인 값으로 'DISCONNECT'를 입력해야 합니다.");
          const configMap = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
          const metadata = parseMetadata(configMap);
          if (!metadata) throw error('Cluster Manager가 관리하는 Ceph 연결이 없습니다.', 409);
          await auditRequired(ctx, actor, 'CephExternalDisconnectRequested', reason, { fsidFingerprint: metadata.fsidFingerprint, storageClasses: metadata.storageClasses });
          const result = await disconnect(ctx, metadata);
          await ctx.publishNotify({ userActor: actor.username, action: 'CephExternalDisconnected', target: 'CephExternal/rook-ceph', result: 'success', reason: `${reason} · remote data retained` });
          ctx.jsonRes(res, 200, result);
          return true;
        }
      } finally { activeOperations.delete('external'); }
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
  planFor,
  storageClassManifest,
  snapshotClassManifest,
  parseMetadata,
  usageFor,
  importNameFromRef,
  cephOwnerPrerequisites,
  providerGuide,
  helmMetadataAccessDenied,
  CHART_VERSION,
};
