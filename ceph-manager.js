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

const ADMIN_GROUP = 'opensphere-console-admins';
const NAMESPACE = 'rook-ceph';
const OPERATOR_RELEASE = 'rook-ceph';
const CLUSTER_RELEASE = 'rook-ceph-external';
const CONNECTION_CONFIGMAP = 'opensphere-ceph-connection';
const CHART_VERSION = 'v1.20.2';
const OPERATOR_CHART = process.env.ROOK_OPERATOR_CHART || `/app/ceph-charts/rook-ceph-${CHART_VERSION}.tgz`;
const CLUSTER_CHART = process.env.ROOK_CLUSTER_CHART || `/app/ceph-charts/rook-ceph-cluster-${CHART_VERSION}.tgz`;
const activeOperations = new Set();

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
  if (adminRequired && !groups.includes(ADMIN_GROUP)) throw error('Ceph 연결 변경은 Console 관리자만 수행할 수 있습니다.', 403);
  return actor;
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
    operatorOwned: true,
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

async function helmStatus(ctx, release, namespace) {
  try {
    const out = await withKubeconfig(ctx, (env) => command('helm', ['status', release, '--namespace', namespace, '--output', 'json'], { env, timeoutMs: 30000 }));
    const value = JSON.parse(out.stdout || '{}');
    return { installed: true, status: value.info?.status || 'unknown', chart: value.chart?.metadata?.version || '', revision: value.version || 0 };
  } catch (e) {
    if (/release: not found|not found/i.test(e.safeMessage || e.message || '')) return { installed: false, status: 'not-installed', chart: '', revision: 0 };
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
    return { state: 'Blocked', reason: 'KubernetesUnavailable', checkedAt: new Date().toISOString(), kubernetes: { ready: false }, connection: null, message: safeError(e) };
  }

  const [metadataConfig, cephCluster, storageClasses, csiDrivers, operator, cluster] = await Promise.all([
    optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`),
    optionalKube(ctx, `/apis/ceph.rook.io/v1/namespaces/${NAMESPACE}/cephclusters/${NAMESPACE}`),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/storageclasses'),
    kube(ctx, 'GET', '/apis/storage.k8s.io/v1/csidrivers'),
    helmStatus(ctx, OPERATOR_RELEASE, NAMESPACE),
    helmStatus(ctx, CLUSTER_RELEASE, NAMESPACE),
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
    state, reason, message, checkedAt: new Date().toISOString(), kubernetes,
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
    storage: connection.storageClasses.map((item) => ({ name: item.name, pool: item.data.pool, filesystem: item.data.fsName || '' })),
    secretRefs: connection.secrets.map((item) => `${NAMESPACE}/${item.name}`),
    charts: [
      { release: OPERATOR_RELEASE, chart: 'rook-ceph', version: CHART_VERSION },
      { release: CLUSTER_RELEASE, chart: 'rook-ceph-cluster', version: CHART_VERSION, valuesProfile: 'external' },
    ],
    resources,
    ignoredProviderResources: connection.ignored,
    snapshotSupported,
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

async function assertNoOperatorConflict(ctx) {
  const metadata = await optionalKube(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONNECTION_CONFIGMAP}`);
  if (metadata) return;
  const deployment = await optionalKube(ctx, `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/rook-ceph-operator`);
  if (deployment) throw error('기존 Rook operator가 외부에서 관리되고 있습니다. Cluster Manager가 소유권을 가져오지 않습니다.', 409);
}

async function installConnection(ctx, connection, actor) {
  await assertNoOperatorConflict(ctx);
  await ensureNamespace(ctx);
  // 소유권 marker를 credential보다 먼저 기록한다. 설치가 중단되어도 다음 시도는
  // 외부 Rook을 오인하지 않고 같은 OpenSphere 작업을 안전하게 재개할 수 있다.
  await upsert(ctx, `/api/v1/namespaces/${NAMESPACE}/configmaps`, CONNECTION_CONFIGMAP, metadataManifest(connection, [], actor));
  const operator = ['upgrade', '--install', OPERATOR_RELEASE, OPERATOR_CHART, '--namespace', NAMESPACE, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5'];
  await withKubeconfig(ctx, (env) => command('helm', operator, { env }));

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
  if (metadata.operatorOwned) {
    const clusters = await optionalKube(ctx, `/apis/ceph.rook.io/v1/namespaces/${NAMESPACE}/cephclusters`);
    if (!clusters || !(clusters.items || []).length) {
      const operator = await helmStatus(ctx, OPERATOR_RELEASE, NAMESPACE);
      if (operator.installed) await withKubeconfig(ctx, (env) => command('helm', ['uninstall', OPERATOR_RELEASE, '--namespace', NAMESPACE, '--wait', '--timeout', '10m'], { env }));
    }
  }
  return { ok: true, retained: ['remote Ceph pools', 'remote Ceph filesystems', 'remote Ceph data'], removed: ['consumer Rook external cluster', 'consumer CSI secrets', 'consumer StorageClasses', 'consumer VolumeSnapshotClasses'] };
}

function createCephManager(ctx) {
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/ceph/')) return false;
    try {
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
  CHART_VERSION,
};
