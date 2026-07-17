'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const { HIS_CATALOG, catalogItem } = require('./his-catalog');

const ADMIN_GROUP = 'opensphere-console-admins';
const MAX_BODY = 256 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const HELM_TIMEOUT_MS = 12 * 60 * 1000;
const OPERATION_NAMESPACE = process.env.HIS_OPERATION_NAMESPACE || process.env.POD_NAMESPACE || 'opensphere-console';
const OPERATION_STALE_MS = 60 * 1000;
const ACTIVE_OPERATION_PHASES = new Set(['Queued', 'Recovering', 'Installing', 'Upgrading', 'RollingBack', 'Configuring', 'Migrating', 'Validating', 'Uninstalling']);
const OBSERVABILITY_ITEM_ID = 'kube-prometheus-stack';
const OBSERVABILITY_CONFIG_NAME = 'opensphere-his-config-kube-prometheus-stack';
const PROFILE_SELECTION_CONFIG_NAME = 'opensphere-his-profile-selection';
const OBSERVABILITY_RESET_CONFIRMATION = 'RESET OBSERVABILITY DATA';
const OBSERVABILITY_PUBLIC_CONFIRMATION = 'ENABLE PUBLIC GRAFANA';
const OIDC_SECRET_KEYS = Object.freeze([
  'GF_AUTH_GENERIC_OAUTH_CLIENT_ID',
  'GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET',
  'GF_AUTH_GENERIC_OAUTH_AUTH_URL',
  'GF_AUTH_GENERIC_OAUTH_TOKEN_URL',
  'GF_AUTH_GENERIC_OAUTH_API_URL',
]);
const DEFAULT_OBSERVABILITY_CONFIG = Object.freeze({
  schemaVersion: 1,
  prometheus: Object.freeze({
    retention: '7d',
    storageClassName: '',
    storageSize: '20Gi',
    remoteWrite: Object.freeze({ enabled: false, url: '', secretName: '', secretKey: 'token' }),
  }),
  alertmanager: Object.freeze({ retention: '120h', storageClassName: '', storageSize: '2Gi' }),
  grafana: Object.freeze({
    storageClassName: '',
    storageSize: '5Gi',
    exposureMode: 'ClusterInternal',
    hostname: '',
    ingressClassName: 'nginx',
    ingressNamespace: 'ingress-nginx',
    tlsSecretName: '',
    oidcSecretName: '',
    allowedCidrs: Object.freeze([]),
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function k8sName(value, field, allowEmpty = false) {
  const text = String(value || '').trim();
  if (allowEmpty && !text) return '';
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(text) || text.length > 253) {
    throw Object.assign(new Error(`${field} 값이 올바른 Kubernetes/DNS 이름이 아닙니다.`), { code: 400 });
  }
  return text;
}

function storageQuantity(value, field) {
  const text = String(value || '').trim();
  const match = /^([1-9][0-9]*)(Mi|Gi|Ti)$/.exec(text);
  if (!match) throw Object.assign(new Error(`${field} 용량은 1Gi, 500Mi와 같은 이진 단위로 입력해야 합니다.`), { code: 400 });
  const units = { Mi: 1024n ** 2n, Gi: 1024n ** 3n, Ti: 1024n ** 4n };
  return { text, bytes: BigInt(match[1]) * units[match[2]] };
}

function durationValue(value, field) {
  const text = String(value || '').trim();
  const match = /^([1-9][0-9]*)(m|h|d|w|y)$/.exec(text);
  if (!match) throw Object.assign(new Error(`${field} 보존기간은 30d, 120h와 같이 입력해야 합니다.`), { code: 400 });
  const units = { m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  const seconds = Number(match[1]) * units[match[2]];
  if (seconds < 3600 || seconds > 5 * 31536000) {
    throw Object.assign(new Error(`${field} 보존기간은 1시간 이상 5년 이하만 허용합니다.`), { code: 400 });
  }
  return text;
}

function cidrValue(value) {
  const text = String(value || '').trim();
  const [address, rawPrefix, extra] = text.split('/');
  const family = net.isIP(address);
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw Object.assign(new Error(`허용 CIDR '${text}' 형식이 올바르지 않습니다.`), { code: 400 });
  }
  return `${address}/${prefix}`;
}

function remoteWriteUrl(value) {
  const text = String(value || '').trim();
  let parsed;
  try { parsed = new URL(text); } catch { throw Object.assign(new Error('Remote write URL이 올바르지 않습니다.'), { code: 400 }); }
  const clusterLocal = parsed.hostname.endsWith('.svc') || parsed.hostname.endsWith('.svc.cluster.local');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && clusterLocal)) {
    throw Object.assign(new Error('Remote write는 HTTPS 또는 cluster-local HTTP 주소만 허용합니다.'), { code: 400 });
  }
  return parsed.toString();
}

function validateObservabilityConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const prometheus = source.prometheus || {};
  const alertmanager = source.alertmanager || {};
  const grafana = source.grafana || {};
  const remoteWrite = prometheus.remoteWrite || {};
  const exposureMode = String(grafana.exposureMode || DEFAULT_OBSERVABILITY_CONFIG.grafana.exposureMode);
  if (!['ClusterInternal', 'PrivateIngress', 'PublicIngress'].includes(exposureMode)) {
    throw Object.assign(new Error('Grafana 공개 정책이 올바르지 않습니다.'), { code: 400 });
  }
  const remoteWriteEnabled = Boolean(remoteWrite.enabled);
  const external = exposureMode !== 'ClusterInternal';
  const config = {
    schemaVersion: 1,
    prometheus: {
      retention: durationValue(prometheus.retention || DEFAULT_OBSERVABILITY_CONFIG.prometheus.retention, 'Prometheus'),
      storageClassName: k8sName(prometheus.storageClassName, 'Prometheus StorageClass', true),
      storageSize: storageQuantity(prometheus.storageSize || DEFAULT_OBSERVABILITY_CONFIG.prometheus.storageSize, 'Prometheus').text,
      remoteWrite: {
        enabled: remoteWriteEnabled,
        url: remoteWriteEnabled ? remoteWriteUrl(remoteWrite.url) : '',
        secretName: remoteWriteEnabled ? k8sName(remoteWrite.secretName, 'Remote write Secret') : '',
        secretKey: remoteWriteEnabled ? k8sName(remoteWrite.secretKey || 'token', 'Remote write Secret key') : 'token',
      },
    },
    alertmanager: {
      retention: durationValue(alertmanager.retention || DEFAULT_OBSERVABILITY_CONFIG.alertmanager.retention, 'Alertmanager'),
      storageClassName: k8sName(alertmanager.storageClassName, 'Alertmanager StorageClass', true),
      storageSize: storageQuantity(alertmanager.storageSize || DEFAULT_OBSERVABILITY_CONFIG.alertmanager.storageSize, 'Alertmanager').text,
    },
    grafana: {
      storageClassName: k8sName(grafana.storageClassName, 'Grafana StorageClass', true),
      storageSize: storageQuantity(grafana.storageSize || DEFAULT_OBSERVABILITY_CONFIG.grafana.storageSize, 'Grafana').text,
      exposureMode,
      hostname: external ? k8sName(grafana.hostname, 'Grafana hostname') : '',
      ingressClassName: external ? k8sName(grafana.ingressClassName || 'nginx', 'IngressClass') : String(grafana.ingressClassName || 'nginx'),
      ingressNamespace: external ? k8sName(grafana.ingressNamespace || 'ingress-nginx', 'Ingress controller namespace') : String(grafana.ingressNamespace || 'ingress-nginx'),
      tlsSecretName: external ? k8sName(grafana.tlsSecretName, 'Grafana TLS Secret') : '',
      oidcSecretName: external ? k8sName(grafana.oidcSecretName, 'Grafana OIDC Secret') : '',
      allowedCidrs: exposureMode === 'PrivateIngress'
        ? [...new Set((Array.isArray(grafana.allowedCidrs) ? grafana.allowedCidrs : []).map(cidrValue))]
        : [],
    },
  };
  if (exposureMode === 'PrivateIngress' && !config.grafana.allowedCidrs.length) {
    throw Object.assign(new Error('Private Ingress에는 하나 이상의 허용 CIDR이 필요합니다.'), { code: 400 });
  }
  return config;
}

function observabilityValues(rawConfig) {
  const config = validateObservabilityConfig(rawConfig);
  const namespaceNames = ['monitoring', 'opensphere-console'];
  if (config.grafana.exposureMode !== 'ClusterInternal') namespaceNames.push(config.grafana.ingressNamespace);
  const fromNamespaces = [...new Set(namespaceNames)];
  const namespaceSelector = {
    namespaceSelector: {
      matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: fromNamespaces }],
    },
  };
  const pvcSpec = (storageClassName, storageSize) => ({
    ...(storageClassName ? { storageClassName } : {}),
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: storageSize } },
  });
  const external = config.grafana.exposureMode !== 'ClusterInternal';
  const ingressAnnotations = external ? {
    'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
    'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
    'nginx.ingress.kubernetes.io/limit-rps': '20',
    'nginx.ingress.kubernetes.io/limit-burst-multiplier': '3',
    ...(config.grafana.exposureMode === 'PrivateIngress'
      ? { 'nginx.ingress.kubernetes.io/whitelist-source-range': config.grafana.allowedCidrs.join(',') }
      : {}),
  } : {};
  const networkPolicy = (name, appName, ports) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `opensphere-${name}-access`,
      namespace: 'monitoring',
      labels: { 'app.kubernetes.io/managed-by': 'OpenSphere', 'opensphere.io/policy': 'observability-access' },
    },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': appName } },
      policyTypes: ['Ingress'],
      ingress: [{ from: [namespaceSelector], ports }],
    },
  });
  return {
    grafana: {
      deploymentStrategy: { type: 'Recreate' },
      initChownData: { enabled: false },
      service: { type: 'ClusterIP' },
      ingress: {
        enabled: external,
        ingressClassName: external ? config.grafana.ingressClassName : '',
        annotations: ingressAnnotations,
        labels: { 'opensphere.io/exposure-mode': config.grafana.exposureMode },
        hosts: external ? [config.grafana.hostname] : [],
        path: '/',
        tls: external ? [{ secretName: config.grafana.tlsSecretName, hosts: [config.grafana.hostname] }] : [],
      },
      persistence: {
        enabled: true,
        lookupVolumeName: true,
        size: config.grafana.storageSize,
        ...(config.grafana.storageClassName ? { storageClassName: config.grafana.storageClassName } : {}),
        annotations: { 'helm.sh/resource-policy': 'keep', 'opensphere.io/data-class': 'observability' },
      },
      envFromSecret: external ? config.grafana.oidcSecretName : '',
      'grafana.ini': {
        server: external ? { domain: config.grafana.hostname, root_url: `https://${config.grafana.hostname}` } : {},
        'auth.anonymous': { enabled: false },
        'auth.generic_oauth': { enabled: external, allow_sign_up: true, scopes: 'openid profile email groups' },
      },
    },
    alertmanager: {
      ingress: { enabled: false },
      service: { type: 'ClusterIP' },
      alertmanagerSpec: {
        retention: config.alertmanager.retention,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
        storage: { volumeClaimTemplate: { spec: pvcSpec(config.alertmanager.storageClassName, config.alertmanager.storageSize) } },
      },
    },
    prometheus: {
      ingress: { enabled: false },
      service: { type: 'ClusterIP' },
      prometheusSpec: {
        retention: config.prometheus.retention,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
        remoteWrite: config.prometheus.remoteWrite.enabled ? [{
          name: 'opensphere-managed',
          url: config.prometheus.remoteWrite.url,
          authorization: { credentials: { name: config.prometheus.remoteWrite.secretName, key: config.prometheus.remoteWrite.secretKey } },
        }] : [],
        storageSpec: { volumeClaimTemplate: { spec: pvcSpec(config.prometheus.storageClassName, config.prometheus.storageSize) } },
      },
    },
    extraManifests: [
      networkPolicy('grafana', 'grafana', [{ protocol: 'TCP', port: 3000 }]),
      networkPolicy('prometheus', 'prometheus', [{ protocol: 'TCP', port: 9090 }]),
      networkPolicy('alertmanager', 'alertmanager', [
        { protocol: 'TCP', port: 9093 }, { protocol: 'TCP', port: 9094 }, { protocol: 'UDP', port: 9094 },
      ]),
    ],
  };
}

function safeError(error) {
  const message = error && (error.safeMessage || error.message || error.msg || String(error));
  return String(message || 'operation failed').replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 1200);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

function reasonFrom(body) {
  const reason = String(body && body.reason || '').trim();
  if (reason.length < 8 || reason.length > 500) {
    throw Object.assign(new Error('변경 사유는 8자 이상 500자 이하로 입력해야 합니다.'), { code: 400 });
  }
  return reason;
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || HELM_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ code, stdout, stderr });
      const error = new Error(killed ? 'Helm 작업 시간이 초과되었습니다.' : `Helm 명령 실패(exit ${code}): ${stderr || stdout}`);
      error.code = killed ? 504 : 502;
      error.safeMessage = safeError(error);
      reject(error);
    });
  });
}

function kubeconfigText(token, caPath, server) {
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: in-cluster',
    '  cluster:',
    `    certificate-authority: ${caPath}`,
    `    server: ${server}`,
    'contexts:',
    '- name: in-cluster',
    '  context:',
    '    cluster: in-cluster',
    '    user: service-account',
    'current-context: in-cluster',
    'users:',
    '- name: service-account',
    '  user:',
    `    token: ${token}`,
    '',
  ].join('\n');
}

async function withKubeconfig(ctx, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-his-'));
  const kubeconfig = path.join(dir, 'kubeconfig');
  fs.writeFileSync(kubeconfig, kubeconfigText(ctx.token(), ctx.caPath, ctx.apiServer), { mode: 0o600 });
  const env = {
    ...process.env,
    KUBECONFIG: kubeconfig,
    HELM_CACHE_HOME: path.join(dir, 'cache'),
    HELM_CONFIG_HOME: path.join(dir, 'config'),
    HELM_DATA_HOME: path.join(dir, 'data'),
  };
  try { return await callback(env, dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function k8sRequest(ctx, apiPath, options = {}) {
  const response = await fetch(`${ctx.apiServer}${apiPath}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${ctx.token()}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': options.contentType || 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const error = new Error(`Kubernetes API ${response.status}: ${body.message || apiPath}`);
    error.code = response.status;
    throw error;
  }
  return body;
}

async function k8s(ctx, apiPath) {
  return k8sRequest(ctx, apiPath);
}

async function k8sListOrEmpty(ctx, apiPath) {
  try { return await k8s(ctx, apiPath); }
  catch (error) { if (error.code === 404) return { items: [] }; throw error; }
}

function availableDeployment(deployment) {
  const desired = Number(deployment && deployment.spec && deployment.spec.replicas || 1);
  return Number(deployment && deployment.status && deployment.status.availableReplicas || 0) >= desired;
}

function readyDaemonSet(ds) {
  const desired = Number(ds && ds.status && ds.status.desiredNumberScheduled || 0);
  return desired > 0 && Number(ds && ds.status && ds.status.numberReady || 0) >= desired;
}

function readyStatefulSet(sts) {
  const desired = Number(sts && sts.spec && sts.spec.replicas || 1);
  return Number(sts && sts.status && sts.status.readyReplicas || 0) >= desired;
}

function result(state, reason, message, observedVersion = '', details = undefined) {
  return {
    state,
    reason,
    message,
    observedVersion,
    retryable: state !== 'Ready',
    lastCheckedAt: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
}

function parseKubernetesVersion(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseKubernetesVersion(left);
  const b = Array.isArray(right) ? right : parseKubernetesVersion(right);
  if (!a || !b) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function kubernetesVersionSupported(value, minimum = '1.30.0', maximumExclusive = '1.37.0') {
  return compareVersions(value, minimum) >= 0 && compareVersions(value, maximumExclusive) < 0;
}

function diagnosticDetails({ facts = [], tables = [], warnings = [], security = [], canaries = [], evidence = [] } = {}) {
  return { facts, tables, warnings, security, canaries, evidence };
}

function evaluateStorageContract(storageClasses = [], csiDrivers = [], pvcs = []) {
  const driverNames = new Set(csiDrivers.map((item) => item.metadata?.name).filter(Boolean));
  const defaults = storageClasses.filter((item) => item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
  const pendingPvcs = pvcs.filter((pvc) => pvc.status?.phase !== 'Bound');
  const defaultClass = defaults.length === 1 ? defaults[0] : null;
  const defaultCsiBacked = Boolean(defaultClass?.provisioner && driverNames.has(defaultClass.provisioner));
  const rows = storageClasses.map((item) => ({
    name: item.metadata?.name || '',
    default: defaults.includes(item) ? 'Yes' : 'No',
    provisioner: item.provisioner || '',
    csiBacked: driverNames.has(item.provisioner) ? 'Yes' : 'No',
    binding: item.volumeBindingMode || 'Immediate',
    expansion: item.allowVolumeExpansion ? 'Yes' : 'No',
    reclaim: item.reclaimPolicy || 'Delete',
    parameters: Object.entries(item.parameters || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'None',
  }));
  if (!storageClasses.length) return { state: 'Blocked', reason: 'StorageClassMissing', defaults, defaultClass, defaultCsiBacked, pendingPvcs, rows };
  if (defaults.length !== 1) return { state: 'Degraded', reason: 'DefaultStorageClassMissing', defaults, defaultClass, defaultCsiBacked, pendingPvcs, rows };
  if (!defaultCsiBacked) return { state: 'Degraded', reason: 'DefaultStorageClassNotCsi', defaults, defaultClass, defaultCsiBacked, pendingPvcs, rows };
  if (pendingPvcs.length) return { state: 'Degraded', reason: 'StorageContractDegraded', defaults, defaultClass, defaultCsiBacked, pendingPvcs, rows };
  return { state: 'Ready', reason: 'CsiStorageReady', defaults, defaultClass, defaultCsiBacked, pendingPvcs, rows };
}

function validationCanaryName(itemId) {
  return itemId === 'cluster-network' ? 'Cross-node / egress traffic'
    : itemId === 'cluster-dns' ? 'Node-wide DNS resolution'
      : itemId === OBSERVABILITY_ITEM_ID ? 'Scrape/alert delivery'
        : itemId === 'storage' ? 'Dynamic provision/bind'
          : itemId === 'csi-snapshot' ? 'Snapshot → restore' : '';
}

function runtimeContractFingerprint(kind, resources = [], facts = []) {
  const normalized = resources.filter(Boolean).map((resource) => ({
    kind: resource.kind || '',
    namespace: resource.metadata?.namespace || '',
    name: resource.metadata?.name || '',
    uid: resource.metadata?.uid || '',
    generation: Number(resource.metadata?.generation || 0),
    images: containerImages(resource),
  })).sort((left, right) => `${left.kind}/${left.namespace}/${left.name}`.localeCompare(`${right.kind}/${right.namespace}/${right.name}`));
  return JSON.stringify([kind, normalized, facts]);
}

function storageContractFingerprint(storageClass) {
  if (!storageClass) return '';
  return JSON.stringify([
    storageClass.metadata?.uid || '', storageClass.metadata?.name || '', storageClass.provisioner || '',
    storageClass.volumeBindingMode || 'Immediate', Boolean(storageClass.allowVolumeExpansion), storageClass.reclaimPolicy || 'Delete',
    Object.entries(storageClass.parameters || {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function snapshotContractFingerprint(storageClass, snapshotClass) {
  if (!storageClass || !snapshotClass) return '';
  return JSON.stringify([
    storageContractFingerprint(storageClass), snapshotClass.metadata?.uid || '', snapshotClass.metadata?.name || '',
    snapshotClass.driver || '', snapshotClass.deletionPolicy || '', Object.entries(snapshotClass.parameters || {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function applyValidationOperation(check, operation, itemId) {
  const canaryName = validationCanaryName(itemId);
  if (!canaryName || operation?.action !== 'validate' || !check?.details?.canaries) return check;
  const matches = Boolean(operation.validationFingerprint && operation.validationFingerprint === check.details.validationFingerprint);
  const state = operation.phase === 'Ready' && matches ? 'Passed' : operation.phase === 'Failed' ? 'Failed' : 'NotRun';
  const message = operation.phase === 'Ready' && matches
    ? `${operation.message} (${operation.finishedAt || operation.updatedAt})`
    : operation.phase === 'Ready' ? '검증 후 HIS 기능 계약이 변경되어 재검증이 필요합니다.'
      : operation.phase === 'Failed' ? operation.error || operation.message : `${operation.message} · 작업 ${operation.id}`;
  return {
    ...check,
    details: {
      ...check.details,
      canaries: check.details.canaries.map((canary) => canary.name === canaryName ? { ...canary, state, message } : canary),
    },
  };
}

function gateValidationReadiness(check, operation, itemId) {
  const eligibleReasons = {
    'cluster-network': 'CniReady',
    'cluster-dns': 'DnsResolutionReady',
    [OBSERVABILITY_ITEM_ID]: 'ObservabilityReady',
    storage: 'CsiStorageReady',
    'csi-snapshot': 'SnapshotReady',
  };
  const eligible = eligibleReasons[itemId] === check.reason;
  const enriched = applyValidationOperation(check, operation, itemId);
  if (!eligible) return enriched;
  const matches = operation?.action === 'validate'
    && operation.phase === 'Ready'
    && operation.validationFingerprint
    && operation.validationFingerprint === check.details?.validationFingerprint;
  if (matches) return enriched;
  const running = operation?.action === 'validate' && operationActive(operation);
  const failed = operation?.action === 'validate' && operation.phase === 'Failed';
  const domain = itemId === 'cluster-network' ? 'Network'
    : itemId === 'cluster-dns' ? 'Dns'
      : itemId === OBSERVABILITY_ITEM_ID ? 'Observability'
        : itemId === 'storage' ? 'Storage' : 'DataProtection';
  return {
    ...enriched,
    state: 'Degraded',
    reason: `${domain}Canary${running ? 'Running' : failed ? 'Failed' : 'Required'}`,
    message: running ? '승인된 실제 기능 경로 검증이 진행 중입니다.'
      : failed ? `실제 기능 경로 검증에 실패했습니다: ${operation.error || operation.message}`
        : '객체 계약은 준비되었지만 현재 계약에 대한 실제 기능 경로 검증이 필요합니다.',
  };
}

function condition(resource, type) {
  return (resource?.status?.conditions || []).find((item) => item.type === type);
}

function containerImages(resource) {
  return (resource?.spec?.template?.spec?.containers || []).map((item) => item.image).filter(Boolean).join(', ');
}

function ingressDefaultCertificateRef(resource) {
  const containers = resource?.spec?.template?.spec?.containers || [];
  const args = containers.flatMap((container) => container.args || []);
  const prefix = '--default-ssl-certificate=';
  const value = String(args.find((arg) => String(arg).startsWith(prefix)) || '').slice(prefix.length);
  const match = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?)\/([a-z0-9]([-a-z0-9.]*[a-z0-9])?)$/.exec(value);
  return match ? { namespace: match[1], name: match[3] } : null;
}

async function tlsSecretReady(ctx, ref) {
  if (!ref) return false;
  try {
    const secret = await k8s(ctx, `/api/v1/namespaces/${encodeURIComponent(ref.namespace)}/secrets/${encodeURIComponent(ref.name)}`);
    return secret.type === 'kubernetes.io/tls' && Boolean(secret.data?.['tls.crt']) && Boolean(secret.data?.['tls.key']);
  } catch (error) {
    if (error.code === 404) return false;
    throw error;
  }
}

function addressOfService(service) {
  const ingress = service?.status?.loadBalancer?.ingress || [];
  return ingress.map((item) => item.ip || item.hostname).filter(Boolean).join(', ') || service?.spec?.externalIPs?.join(', ') || '';
}

function timedDnsLookup(hostname) {
  const startedAt = Date.now();
  return Promise.race([
    dns.lookup(hostname).then((answer) => ({ state: 'Passed', message: `${answer.address} · ${Date.now() - startedAt}ms` })),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'Failed', message: '3초 안에 응답하지 않았습니다.' }), 3000)),
  ]).catch((error) => ({ state: 'Failed', message: safeError(error) }));
}

async function probe(ctx, name) {
  if (name === 'kubernetesApi') {
    const [version, groups, apiServices, validatingWebhooks, mutatingWebhooks] = await Promise.all([
      k8s(ctx, '/version'),
      k8s(ctx, '/apis'),
      k8sListOrEmpty(ctx, '/apis/apiregistration.k8s.io/v1/apiservices'),
      k8sListOrEmpty(ctx, '/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations'),
      k8sListOrEmpty(ctx, '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations'),
    ]);
    let accessReview = null;
    try {
      accessReview = await k8sRequest(ctx, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        method: 'POST',
        body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { verb: 'list', resource: 'nodes' } } },
      });
    } catch (error) { accessReview = { status: { allowed: false, reason: safeError(error) } }; }
    const gitVersion = version.gitVersion || '';
    const supported = kubernetesVersionSupported(gitVersion);
    const unavailable = (apiServices.items || []).filter((item) => condition(item, 'Available')?.status === 'False');
    const details = diagnosticDetails({
      facts: [
        { label: 'Kubernetes version', value: gitVersion, state: supported ? 'Passed' : 'Failed' },
        { label: '지원 범위', value: '>=1.30.0 <1.37.0', state: supported ? 'Passed' : 'Failed' },
        { label: 'API groups', value: String((groups.groups || []).length), state: 'Info' },
        { label: 'RBAC node list', value: accessReview?.status?.allowed ? 'Allowed' : accessReview?.status?.reason || 'Denied', state: accessReview?.status?.allowed ? 'Passed' : 'Failed' },
      ],
      tables: [{
        title: 'Unavailable APIService',
        columns: [{ key: 'name', label: 'APIService' }, { key: 'reason', label: 'Reason' }, { key: 'message', label: 'Message' }],
        rows: unavailable.map((item) => ({ name: item.metadata?.name || '', reason: condition(item, 'Available')?.reason || '', message: condition(item, 'Available')?.message || '' })),
      }],
      warnings: supported ? [] : [`${gitVersion}은 OpenSphere 지원 범위 밖입니다.`],
      security: [`ValidatingWebhook ${validatingWebhooks.items?.length || 0}개 · MutatingWebhook ${mutatingWebhooks.items?.length || 0}개`],
      canaries: [
        { name: 'API discovery', state: (groups.groups || []).length ? 'Passed' : 'Failed', message: `${(groups.groups || []).length}개 API group 발견` },
        { name: 'RBAC self-check', state: accessReview?.status?.allowed ? 'Passed' : 'Failed', message: accessReview?.status?.reason || 'nodes list 권한 검증' },
      ],
      evidence: unavailable.slice(0, 10).map((item) => ({ name: item.metadata?.name || '', state: 'Failed', message: condition(item, 'Available')?.message || '' })),
    });
    if (!supported) return result('Blocked', 'UnsupportedKubernetesVersion', `${gitVersion}은 지원 범위 >=1.30.0 <1.37.0에 포함되지 않습니다.`, gitVersion, details);
    if (!accessReview?.status?.allowed || unavailable.length) return result('Degraded', 'ApiControlDegraded', `API는 응답하지만 RBAC 또는 APIService ${unavailable.length}개가 준비되지 않았습니다.`, gitVersion, details);
    return result('Ready', 'ApiCompatible', `Kubernetes ${gitVersion} API discovery와 RBAC self-check가 정상입니다.`, gitVersion, details);
  }
  if (name === 'nodes') {
    const list = await k8s(ctx, '/api/v1/nodes');
    const nodes = list.items || [];
    const ready = nodes.filter((node) => (node.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'));
    const rows = nodes.map((node) => {
      const pressures = ['MemoryPressure', 'DiskPressure', 'PIDPressure'].filter((type) => condition(node, type)?.status === 'True');
      return {
        name: node.metadata?.name || '',
        ready: condition(node, 'Ready')?.status || 'Unknown',
        pressure: pressures.join(', ') || 'None',
        schedulable: node.spec?.unschedulable ? 'No' : 'Yes',
        taints: (node.spec?.taints || []).map((taint) => `${taint.key}:${taint.effect}`).join(', ') || 'None',
        kubelet: node.status?.nodeInfo?.kubeletVersion || '',
        runtime: node.status?.nodeInfo?.containerRuntimeVersion || '',
        cpu: node.status?.allocatable?.cpu || '',
        memory: node.status?.allocatable?.memory || '',
      };
    });
    const pressured = rows.filter((row) => row.pressure !== 'None');
    const details = diagnosticDetails({
      facts: [
        { label: 'Ready nodes', value: `${ready.length}/${nodes.length}`, state: ready.length === nodes.length && nodes.length ? 'Passed' : 'Failed' },
        { label: 'Pressure-free', value: `${nodes.length - pressured.length}/${nodes.length}`, state: pressured.length ? 'Failed' : 'Passed' },
        { label: 'Kubelet versions', value: [...new Set(rows.map((row) => row.kubelet))].join(', '), state: 'Info' },
        { label: 'Container runtimes', value: [...new Set(rows.map((row) => row.runtime))].join(', '), state: 'Info' },
      ],
      tables: [{ title: 'Node conditions and capacity', columns: [
        { key: 'name', label: 'Node' }, { key: 'ready', label: 'Ready' }, { key: 'pressure', label: 'Pressure' }, { key: 'schedulable', label: 'Schedulable' },
        { key: 'kubelet', label: 'Kubelet' }, { key: 'runtime', label: 'Runtime' }, { key: 'cpu', label: 'CPU' }, { key: 'memory', label: 'Memory' }, { key: 'taints', label: 'Taints' },
      ], rows }],
      warnings: pressured.map((row) => `${row.name}: ${row.pressure}`),
      canaries: [{ name: 'Node readiness', state: ready.length === nodes.length && nodes.length ? 'Passed' : 'Failed', message: `${ready.length}/${nodes.length} Ready` }],
    });
    if (!nodes.length || ready.length !== nodes.length) return result('Blocked', 'NodeNotReady', `${ready.length}/${nodes.length}개 노드만 Ready입니다.`, rows[0]?.kubelet || '', details);
    if (pressured.length) return result('Degraded', 'NodePressure', `${pressured.length}개 노드에 resource pressure가 있습니다.`, rows[0]?.kubelet || '', details);
    return result('Ready', 'NodesHealthy', `${ready.length}/${nodes.length}개 노드가 Ready이며 pressure가 없습니다.`, rows[0]?.kubelet || '', details);
  }
  if (name === 'cni') {
    const [list, nodeList, networkingApi] = await Promise.all([
      k8s(ctx, '/apis/apps/v1/namespaces/kube-system/daemonsets'),
      k8s(ctx, '/api/v1/nodes'),
      k8s(ctx, '/apis/networking.k8s.io/v1'),
    ]);
    const candidates = (list.items || []).filter((ds) => /kindnet|calico|cilium|weave|flannel|canal|antrea/i.test(ds.metadata?.name || ''));
    const ready = candidates.find(readyDaemonSet);
    const nodes = nodeList.items || [];
    const withoutPodCidr = nodes.filter((node) => !node.spec?.podCIDR && !(node.spec?.podCIDRs || []).length);
    const rows = candidates.map((ds) => ({
      name: ds.metadata?.name || '', desired: String(ds.status?.desiredNumberScheduled || 0), ready: String(ds.status?.numberReady || 0),
      image: containerImages(ds), selector: Object.entries(ds.spec?.selector?.matchLabels || {}).map(([key, value]) => `${key}=${value}`).join(','),
    }));
    const families = [...new Set(nodes.flatMap((node) => node.spec?.podCIDRs || (node.spec?.podCIDR ? [node.spec.podCIDR] : [])).map((cidr) => cidr.includes(':') ? 'IPv6' : 'IPv4'))];
    const networkPolicy = (networkingApi.resources || []).some((resource) => resource.name === 'networkpolicies');
    const details = diagnosticDetails({
      facts: [
        { label: 'Primary CNI', value: ready?.metadata?.name || 'Not ready', state: ready ? 'Passed' : 'Failed' },
        { label: 'PodCIDR assignment', value: `${nodes.length - withoutPodCidr.length}/${nodes.length}`, state: withoutPodCidr.length ? 'Failed' : 'Passed' },
        { label: 'IP families', value: families.join(', ') || 'Unknown', state: 'Info' },
        { label: 'NetworkPolicy API', value: networkPolicy ? 'Supported' : 'Missing', state: networkPolicy ? 'Passed' : 'Failed' },
        { label: 'MTU', value: 'CNI runtime configuration에서 확인 필요', state: 'NotRun' },
      ],
      tables: [{ title: 'CNI daemon coverage', columns: [{ key: 'name', label: 'DaemonSet' }, { key: 'desired', label: 'Desired' }, { key: 'ready', label: 'Ready' }, { key: 'image', label: 'Image' }, { key: 'selector', label: 'Selector' }], rows }],
      warnings: withoutPodCidr.map((node) => `${node.metadata?.name}: PodCIDR 없음`),
      canaries: [
        { name: 'Daemon coverage', state: ready ? 'Passed' : 'Failed', message: ready ? `${ready.status?.numberReady}/${ready.status?.desiredNumberScheduled}` : 'Ready CNI 없음' },
        { name: 'Cross-node / egress traffic', state: 'NotRun', message: '쓰기 없는 정기 검사에서는 실행하지 않음; 승인된 synthetic canary 필요' },
      ],
    });
    details.validationFingerprint = runtimeContractFingerprint('cluster-network', candidates, nodes.map((node) => [
      node.metadata?.uid || '', node.metadata?.name || '', node.spec?.podCIDR || '', node.spec?.podCIDRs || [], Boolean(node.spec?.unschedulable),
    ]));
    if (!ready) return result('Blocked', 'CniMissing', 'Ready 상태의 CNI DaemonSet을 찾지 못했습니다.', '', details);
    if (withoutPodCidr.length || !networkPolicy) return result('Degraded', 'CniContractPartial', `${ready.metadata.name}은 Ready지만 PodCIDR 또는 NetworkPolicy 계약이 불완전합니다.`, containerImages(ready), details);
    return result('Ready', 'CniReady', `${ready.metadata.name} CNI가 모든 대상 노드에서 Ready이며 PodCIDR이 할당되었습니다.`, containerImages(ready), details);
  }
  if (name === 'dns') {
    const [deployments, services, configMaps, internalLookup, externalLookup] = await Promise.all([
      k8s(ctx, '/apis/apps/v1/namespaces/kube-system/deployments'),
      k8s(ctx, '/api/v1/namespaces/kube-system/services'),
      k8s(ctx, '/api/v1/namespaces/kube-system/configmaps'),
      timedDnsLookup('kubernetes.default.svc.cluster.local'),
      timedDnsLookup('registry.k8s.io'),
    ]);
    const dns = (deployments.items || []).find((d) => /coredns|kube-dns/i.test(d.metadata?.name || ''));
    const svc = (services.items || []).find((s) => /kube-dns|coredns/i.test(s.metadata?.name || ''));
    const config = (configMaps.items || []).find((item) => /coredns|kube-dns/i.test(item.metadata?.name || ''));
    const corefile = config?.data?.Corefile || '';
    const details = diagnosticDetails({
      facts: [
        { label: 'DNS deployment', value: dns ? `${dns.status?.availableReplicas || 0}/${dns.spec?.replicas || 1}` : 'Missing', state: dns && availableDeployment(dns) ? 'Passed' : 'Failed' },
        { label: 'DNS service', value: svc ? `${svc.metadata?.name} · ${svc.spec?.clusterIP}` : 'Missing', state: svc ? 'Passed' : 'Failed' },
        { label: 'Forwarder', value: /forward\s+\.\s+([^\n]+)/.exec(corefile)?.[1]?.trim() || 'Not detected', state: corefile ? 'Info' : 'Failed' },
        { label: 'Cache', value: /\bcache\b/.test(corefile) ? 'Enabled' : 'Not detected', state: /\bcache\b/.test(corefile) ? 'Passed' : 'Info' },
      ],
      tables: [{ title: 'DNS endpoints', columns: [{ key: 'name', label: 'Service' }, { key: 'clusterIP', label: 'Cluster IP' }, { key: 'ports', label: 'Ports' }], rows: svc ? [{ name: svc.metadata?.name || '', clusterIP: svc.spec?.clusterIP || '', ports: (svc.spec?.ports || []).map((port) => `${port.protocol}/${port.port}`).join(', ') }] : [] }],
      warnings: !corefile ? ['CoreDNS Corefile을 찾지 못했습니다.'] : [],
      canaries: [
        { name: 'Internal service resolution', ...internalLookup },
        { name: 'External upstream resolution', ...externalLookup },
        { name: 'Node-wide DNS resolution', state: 'NotRun', message: '모든 Ready 노드에서 승인된 synthetic DNS canary가 필요합니다.' },
      ],
    });
    details.validationFingerprint = runtimeContractFingerprint('cluster-dns', [dns, svc], [
      corefile,
      ...((await k8s(ctx, '/api/v1/nodes')).items || []).map((node) => [node.metadata?.uid || '', node.metadata?.name || '', Boolean(node.spec?.unschedulable)]),
    ]);
    if (!dns || !svc || !availableDeployment(dns) || internalLookup.state !== 'Passed') return result('Blocked', 'DnsResolutionFailed', 'Cluster DNS 구성 또는 kubernetes.default 실제 질의가 실패했습니다.', containerImages(dns), details);
    if (externalLookup.state !== 'Passed') return result('Degraded', 'DnsUpstreamFailed', '내부 DNS는 정상이나 외부 upstream 질의가 실패했습니다.', containerImages(dns), details);
    return result('Ready', 'DnsResolutionReady', `${dns.metadata.name} ${dns.status?.availableReplicas || 0}/${dns.spec?.replicas || 1}와 내부·외부 실제 질의가 정상입니다.`, containerImages(dns), details);
  }
  if (name === 'ingress') {
    const [classes, deployments, services, endpointSlices, ingresses] = await Promise.all([
      k8s(ctx, '/apis/networking.k8s.io/v1/ingressclasses'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/ingress-nginx/deployments'),
      k8sListOrEmpty(ctx, '/api/v1/namespaces/ingress-nginx/services'),
      k8sListOrEmpty(ctx, '/apis/discovery.k8s.io/v1/namespaces/ingress-nginx/endpointslices'),
      k8sListOrEmpty(ctx, '/apis/networking.k8s.io/v1/ingresses'),
    ]);
    const classItems = classes.items || [];
    const controller = (deployments.items || []).find((item) => /ingress.*controller/i.test(item.metadata?.name || ''));
    const controllerServices = (services.items || []).filter((item) => /ingress.*controller/i.test(item.metadata?.name || ''));
    const readyEndpoints = (endpointSlices.items || []).flatMap((slice) => slice.endpoints || []).filter((endpoint) => endpoint.conditions?.ready !== false).length;
    const tlsIngresses = (ingresses.items || []).filter((item) => (item.spec?.tls || []).length).length;
    const defaultCertificate = ingressDefaultCertificateRef(controller);
    const defaultCertificateReady = await tlsSecretReady(ctx, defaultCertificate);
    const tlsPolicyReady = tlsIngresses > 0 || defaultCertificateReady;
    const rows = controllerServices.map((service) => ({ name: service.metadata?.name || '', type: service.spec?.type || 'ClusterIP', clusterIP: service.spec?.clusterIP || '', external: addressOfService(service) || 'None', listeners: (service.spec?.ports || []).map((port) => `${port.name || ''}:${port.port}->${port.targetPort}`).join(', ') }));
    const externallyExposed = rows.some((row) => ['LoadBalancer', 'NodePort'].includes(row.type));
    const details = diagnosticDetails({
      facts: [
        { label: 'IngressClass', value: classItems.map((item) => `${item.metadata?.name} (${item.spec?.controller})`).join(', ') || 'Missing', state: classItems.length ? 'Passed' : 'Failed' },
        { label: 'Controller', value: controller ? `${controller.status?.availableReplicas || 0}/${controller.spec?.replicas || 1}` : 'Missing', state: controller && availableDeployment(controller) ? 'Passed' : 'Failed' },
        { label: 'Ready endpoints', value: String(readyEndpoints), state: readyEndpoints ? 'Passed' : 'Failed' },
        { label: 'TLS Ingress references', value: `${tlsIngresses}/${ingresses.items?.length || 0}`, state: 'Info' },
        { label: 'Default TLS certificate', value: defaultCertificate ? `${defaultCertificate.namespace}/${defaultCertificate.name}` : 'Not configured', state: defaultCertificateReady ? 'Passed' : 'Failed' },
      ],
      tables: [{ title: 'Ingress service exposure', columns: [{ key: 'name', label: 'Service' }, { key: 'type', label: 'Type' }, { key: 'clusterIP', label: 'Cluster IP' }, { key: 'external', label: 'External address' }, { key: 'listeners', label: 'Listeners' }], rows }],
      warnings: externallyExposed && !tlsPolicyReady ? ['외부 listener가 있으나 Ready 상태의 기본 인증서 또는 TLS Ingress 참조가 없습니다.'] : [],
      security: [externallyExposed ? '외부 진입 경로 존재: TLS·OIDC·allowlist 정책을 서비스별로 검증하십시오.' : 'ClusterIP 내부 경로만 발견'],
      canaries: [{ name: 'Controller endpoint', state: readyEndpoints ? 'Passed' : 'Failed', message: `${readyEndpoints}개 ready endpoint` }, { name: 'TLS policy', state: tlsPolicyReady ? 'Passed' : 'Failed', message: defaultCertificateReady ? `default ${defaultCertificate.namespace}/${defaultCertificate.name}` : `${tlsIngresses} TLS Ingress references` }],
    });
    if (!classItems.length || !controller || !availableDeployment(controller) || !readyEndpoints) return result('Blocked', 'IngressControlMissing', 'IngressClass·controller·endpoint 계약이 준비되지 않았습니다.', containerImages(controller), details);
    if (externallyExposed && !tlsPolicyReady) return result('Degraded', 'IngressTlsPolicyMissing', 'Controller는 Ready이나 외부 listener에 유효한 TLS 정책이 없습니다.', containerImages(controller), details);
    return result('Ready', 'IngressPathReady', `IngressClass ${classItems.map((item) => item.metadata?.name).join(', ')}와 ${readyEndpoints}개 endpoint가 준비되었습니다.`, containerImages(controller), details);
  }
  if (name === 'certManager') {
    const [crdList, deploymentList, issuers, clusterIssuers, certificates, challenges, orders] = await Promise.all([
      k8sListOrEmpty(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/cert-manager/deployments'),
      k8sListOrEmpty(ctx, '/apis/cert-manager.io/v1/issuers'),
      k8sListOrEmpty(ctx, '/apis/cert-manager.io/v1/clusterissuers'),
      k8sListOrEmpty(ctx, '/apis/cert-manager.io/v1/certificates'),
      k8sListOrEmpty(ctx, '/apis/acme.cert-manager.io/v1/challenges'),
      k8sListOrEmpty(ctx, '/apis/acme.cert-manager.io/v1/orders'),
    ]);
    const certCrds = (crdList.items || []).filter((item) => /cert-manager\.io$/.test(item.spec?.group || ''));
    const crd = certCrds.some((item) => item.metadata?.name === 'certificates.cert-manager.io');
    const deployments = deploymentList.items || [];
    const allReady = deployments.length >= 3 && deployments.every(availableDeployment);
    const issuerItems = [...(issuers.items || []), ...(clusterIssuers.items || [])];
    const readyIssuers = issuerItems.filter((item) => condition(item, 'Ready')?.status === 'True');
    const certItems = certificates.items || [];
    const unreadyCerts = certItems.filter((item) => condition(item, 'Ready')?.status !== 'True');
    const rows = certItems.map((item) => ({ namespace: item.metadata?.namespace || 'cluster', name: item.metadata?.name || '', ready: condition(item, 'Ready')?.status || 'Unknown', notAfter: item.status?.notAfter || '', renewalTime: item.status?.renewalTime || '', secret: item.spec?.secretName || '', issuer: `${item.spec?.issuerRef?.kind || 'Issuer'}/${item.spec?.issuerRef?.name || ''}` }));
    const details = diagnosticDetails({
      facts: [
        { label: 'Controllers', value: `${deployments.filter(availableDeployment).length}/${deployments.length}`, state: allReady ? 'Passed' : 'Failed' },
        { label: 'cert-manager CRDs', value: String(certCrds.length), state: crd ? 'Passed' : 'Failed' },
        { label: 'Ready issuers', value: `${readyIssuers.length}/${issuerItems.length}`, state: readyIssuers.length ? 'Passed' : 'Failed' },
        { label: 'Ready certificates', value: `${certItems.length - unreadyCerts.length}/${certItems.length}`, state: unreadyCerts.length ? 'Failed' : 'Passed' },
        { label: 'ACME failures', value: `Challenge ${(challenges.items || []).filter((item) => item.status?.state === 'invalid').length} · Order ${(orders.items || []).filter((item) => item.status?.state === 'invalid').length}`, state: 'Info' },
      ],
      tables: [{ title: 'Certificate lifecycle', columns: [{ key: 'namespace', label: 'Namespace' }, { key: 'name', label: 'Certificate' }, { key: 'ready', label: 'Ready' }, { key: 'notAfter', label: 'Expires' }, { key: 'renewalTime', label: 'Renewal' }, { key: 'secret', label: 'Secret' }, { key: 'issuer', label: 'Issuer' }], rows }],
      warnings: !issuerItems.length ? ['Issuer/ClusterIssuer가 없어 인증서를 발급할 수 없습니다.'] : unreadyCerts.map((item) => `${item.metadata?.namespace}/${item.metadata?.name}: ${condition(item, 'Ready')?.message || 'Not Ready'}`),
      security: ['Certificate Secret은 애플리케이션 namespace에 유지하며 Cluster Manager가 비밀 값을 읽거나 표시하지 않습니다.'],
      canaries: [{ name: 'Webhook and controllers', state: allReady ? 'Passed' : 'Failed', message: `${deployments.filter(availableDeployment).length}/${deployments.length}` }, { name: 'Issuer readiness', state: readyIssuers.length ? 'Passed' : 'Failed', message: `${readyIssuers.length}/${issuerItems.length}` }],
    });
    const observed = deployments.map(containerImages).filter(Boolean).join(', ');
    if (!crd || !allReady) return result(crd || deployments.length ? 'Degraded' : 'Blocked', crd || deployments.length ? 'CertManagerPartial' : 'CertManagerMissing', crd || deployments.length ? 'cert-manager 일부 리소스만 준비되었습니다.' : 'cert-manager capability가 없습니다.', observed, details);
    if (!readyIssuers.length || unreadyCerts.length) return result('Degraded', !readyIssuers.length ? 'IssuerMissing' : 'CertificateNotReady', `제어기는 Ready이나 Issuer ${readyIssuers.length}/${issuerItems.length}, Certificate ${certItems.length - unreadyCerts.length}/${certItems.length}입니다.`, observed, details);
    return result('Ready', 'CertificateLifecycleReady', `cert-manager 제어기와 Issuer ${readyIssuers.length}/${issuerItems.length}가 Ready입니다.`, observed, details);
  }
  if (name === 'metrics') {
    try {
      const [api, nodes, metrics, deployments, hpas] = await Promise.all([
        k8s(ctx, '/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io'),
        k8s(ctx, '/api/v1/nodes'),
        k8sListOrEmpty(ctx, '/apis/metrics.k8s.io/v1beta1/nodes'),
        k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/kube-system/deployments'),
        k8sListOrEmpty(ctx, '/apis/autoscaling/v2/horizontalpodautoscalers'),
      ]);
      const ready = (api.status?.conditions || []).some((c) => c.type === 'Available' && c.status === 'True');
      const readyNodes = (nodes.items || []).filter((node) => condition(node, 'Ready')?.status === 'True');
      const metricsItems = metrics.items || [];
      const deployment = (deployments.items || []).find((item) => /metrics-server/i.test(item.metadata?.name || ''));
      const oldestAge = metricsItems.length ? Math.max(...metricsItems.map((item) => Math.max(0, Date.now() - Date.parse(item.timestamp || new Date(0).toISOString())))) : Number.POSITIVE_INFINITY;
      const coverage = readyNodes.length ? metricsItems.length / readyNodes.length : 0;
      const rows = metricsItems.map((item) => ({ node: item.metadata?.name || '', cpu: item.usage?.cpu || '', memory: item.usage?.memory || '', timestamp: item.timestamp || '', window: item.window || '' }));
      const details = diagnosticDetails({
        facts: [
          { label: 'APIService', value: condition(api, 'Available')?.status || 'Unknown', state: ready ? 'Passed' : 'Failed' },
          { label: 'Node coverage', value: `${metricsItems.length}/${readyNodes.length}`, state: coverage >= 1 ? 'Passed' : 'Failed' },
          { label: 'Oldest sample', value: Number.isFinite(oldestAge) ? `${Math.round(oldestAge / 1000)}s` : 'No samples', state: oldestAge <= 180000 ? 'Passed' : 'Failed' },
          { label: 'HPA objects', value: String(hpas.items?.length || 0), state: 'Info' },
        ],
        tables: [{ title: 'Node resource metrics', columns: [{ key: 'node', label: 'Node' }, { key: 'cpu', label: 'CPU' }, { key: 'memory', label: 'Memory' }, { key: 'timestamp', label: 'Timestamp' }, { key: 'window', label: 'Window' }], rows }],
        warnings: coverage < 1 ? [`Ready 노드 중 ${readyNodes.length - metricsItems.length}개가 metrics에 없습니다.`] : [],
        security: [containerImages(deployment) || 'metrics-server image unavailable'],
        canaries: [{ name: 'kubectl top equivalent', state: ready && coverage >= 1 && oldestAge <= 180000 ? 'Passed' : 'Failed', message: `${metricsItems.length}/${readyNodes.length} nodes · oldest ${Number.isFinite(oldestAge) ? Math.round(oldestAge / 1000) : '∞'}s` }, { name: 'HPA read path', state: ready ? 'Passed' : 'Failed', message: `${hpas.items?.length || 0} HPA inventory readable` }],
      });
      if (!ready) return result('Degraded', 'MetricsApiUnavailable', 'metrics.k8s.io APIService가 존재하지만 Available이 아닙니다.', api.spec?.version || '', details);
      if (coverage < 1 || oldestAge > 180000) return result('Degraded', 'MetricsCoverageIncomplete', `Metrics API는 Available이나 노드 coverage/freshness가 부족합니다.`, api.spec?.version || '', details);
      return result('Ready', 'MetricsCoverageReady', `metrics.k8s.io가 Ready 노드 ${metricsItems.length}/${readyNodes.length}개를 최신 상태로 제공합니다.`, api.spec?.version || '', details);
    } catch (e) {
      if (e.code === 404) return result('Blocked', 'MetricsApiMissing', 'metrics.k8s.io APIService가 없습니다.');
      throw e;
    }
  }
  if (name === 'kubePrometheusStack') {
    const crdNames = [
      'alertmanagerconfigs.monitoring.coreos.com',
      'alertmanagers.monitoring.coreos.com',
      'podmonitors.monitoring.coreos.com',
      'probes.monitoring.coreos.com',
      'prometheusagents.monitoring.coreos.com',
      'prometheuses.monitoring.coreos.com',
      'prometheusrules.monitoring.coreos.com',
      'scrapeconfigs.monitoring.coreos.com',
      'servicemonitors.monitoring.coreos.com',
      'thanosrulers.monitoring.coreos.com',
    ];
    const crdChecks = await Promise.all(crdNames.map(async (crdName) => {
      try { await k8s(ctx, `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crdName}`); return true; }
      catch (e) { if (e.code === 404) return false; throw e; }
    }));
    const [deployments, statefulsets, daemonsets, pvcList, serviceList] = await Promise.all([
      k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/monitoring/deployments'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/monitoring/statefulsets'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/namespaces/monitoring/daemonsets'),
      k8sListOrEmpty(ctx, '/api/v1/namespaces/monitoring/persistentvolumeclaims'),
      k8sListOrEmpty(ctx, '/api/v1/namespaces/monitoring/services'),
    ]);
    const deploymentItems = deployments.items || [];
    const statefulSetItems = statefulsets.items || [];
    const daemonSetItems = daemonsets.items || [];
    const find = (items, pattern) => items.find((item) => pattern.test(item.metadata?.name || ''));
    const components = [
      { name: 'Prometheus Operator', kind: 'Deployment', item: find(deploymentItems, /prometheus.*operator|kube-prometheus-stack-operator/i), ready: availableDeployment },
      { name: 'Grafana', kind: 'Deployment', item: find(deploymentItems, /grafana/i), ready: availableDeployment },
      { name: 'kube-state-metrics', kind: 'Deployment', item: find(deploymentItems, /kube-state-metrics/i), ready: availableDeployment },
      { name: 'Prometheus', kind: 'StatefulSet', item: find(statefulSetItems, /^prometheus-/i), ready: readyStatefulSet },
      { name: 'Alertmanager', kind: 'StatefulSet', item: find(statefulSetItems, /^alertmanager-/i), ready: readyStatefulSet },
      { name: 'node-exporter', kind: 'DaemonSet', item: find(daemonSetItems, /node-exporter/i), ready: readyDaemonSet },
    ];
    const present = components.filter((component) => component.item);
    const ready = components.filter((component) => component.item && component.ready(component.item));
    const crdsReady = crdChecks.every(Boolean);
    const operator = components[0].item;
    const observedVersion = operator?.spec?.template?.spec?.containers?.[0]?.image || '';
    const componentDetails = components.map((component) => {
      const resource = component.item;
      let desired = 0;
      let readyCount = 0;
      if (component.kind === 'DaemonSet') {
        desired = Number(resource?.status?.desiredNumberScheduled || 0);
        readyCount = Number(resource?.status?.numberReady || 0);
      } else if (component.kind === 'StatefulSet') {
        desired = Number(resource?.spec?.replicas || 1);
        readyCount = Number(resource?.status?.readyReplicas || 0);
      } else {
        desired = Number(resource?.spec?.replicas || 1);
        readyCount = Number(resource?.status?.availableReplicas || 0);
      }
      return {
        name: component.name,
        kind: component.kind,
        resourceName: resource?.metadata?.name || '',
        namespace: resource?.metadata?.namespace || 'monitoring',
        state: !resource ? 'Missing' : component.ready(resource) ? 'Ready' : 'Pending',
        desired,
        ready: readyCount,
        image: resource?.spec?.template?.spec?.containers?.[0]?.image || '',
      };
    });
    const details = {
      components: componentDetails,
      crds: {
        ready: crdChecks.filter(Boolean).length,
        total: crdNames.length,
        items: crdNames.map((crdName, index) => ({ name: crdName, ready: crdChecks[index] })),
      },
      pvcs: (pvcList.items || []).map((pvc) => ({
        name: pvc.metadata?.name || '',
        phase: pvc.status?.phase || 'Pending',
        requested: pvc.spec?.resources?.requests?.storage || '',
        capacity: pvc.status?.capacity?.storage || '',
        storageClass: pvc.spec?.storageClassName || '',
      })),
      services: (serviceList.items || []).filter((service) => /kube-prometheus-stack|prometheus|alertmanager|grafana/i.test(service.metadata?.name || '')).map((service) => ({
        name: service.metadata?.name || '',
        type: service.spec?.type || 'ClusterIP',
        clusterIP: service.spec?.clusterIP || '',
        ports: (service.spec?.ports || []).map((port) => `${port.name || port.port}:${port.port}`).join(', '),
      })),
      facts: [
        { label: 'Ready components', value: `${ready.length}/${components.length}`, state: ready.length === components.length ? 'Passed' : 'Failed' },
        { label: 'Ready CRDs', value: `${crdChecks.filter(Boolean).length}/${crdNames.length}`, state: crdsReady ? 'Passed' : 'Failed' },
        { label: 'Persistent volumes', value: `${pvcList.items?.length || 0}`, state: pvcList.items?.length ? 'Passed' : 'Failed' },
        { label: 'External exposure', value: (serviceList.items || []).some((service) => ['LoadBalancer', 'NodePort'].includes(service.spec?.type)) ? 'Detected' : 'ClusterIP only', state: (serviceList.items || []).some((service) => ['LoadBalancer', 'NodePort'].includes(service.spec?.type)) ? 'Failed' : 'Passed' },
      ],
      warnings: (pvcList.items || []).filter((pvc) => pvc.status?.phase !== 'Bound').map((pvc) => `${pvc.metadata?.name}: ${pvc.status?.phase || 'Pending'}`),
      security: ['Prometheus와 Alertmanager 직접 외부 공개 금지 · Grafana만 승인된 TLS/OIDC Ingress 허용'],
      canaries: [
        { name: 'Component readiness', state: ready.length === components.length ? 'Passed' : 'Failed', message: `${ready.length}/${components.length}` },
        { name: 'Scrape/alert delivery', state: 'NotRun', message: 'on-demand synthetic alert canary가 필요합니다.' },
      ],
      tables: [],
    };
    details.validationFingerprint = runtimeContractFingerprint('observability', components.map((component) => component.item), [
      ...crdNames.map((name, index) => [name, crdChecks[index]]),
      ...(serviceList.items || []).map((service) => [service.metadata?.uid || '', service.metadata?.name || '', service.spec?.clusterIP || '', (service.spec?.ports || []).map((port) => port.port)]),
    ]);
    if (crdsReady && ready.length === components.length) {
      const namespaces = [...new Set(components.map((component) => component.item?.metadata?.namespace).filter(Boolean))];
      return result('Ready', 'ObservabilityReady', `공유 관측 스택 ${ready.length}/${components.length}개 구성요소가 Ready입니다. (${namespaces.join(', ')})`, observedVersion, details);
    }
    if (crdChecks.some(Boolean) || present.length) {
      const missing = components.filter((component) => !component.item || !component.ready(component.item)).map((component) => component.name);
      return result('Degraded', 'ObservabilityPartial', `관측 스택 일부만 준비되었습니다. 미준비: ${missing.join(', ') || 'CRD'}`, observedVersion, details);
    }
    return result('Blocked', 'ObservabilityMissing', '공유 kube-prometheus-stack이 없습니다. Observability profile에서 선택 설치할 수 있습니다.', '', details);
  }
  if (name === 'storage') {
    const [list, drivers, pvcs, pvs] = await Promise.all([
      k8s(ctx, '/apis/storage.k8s.io/v1/storageclasses'),
      k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/csidrivers'),
      k8sListOrEmpty(ctx, '/api/v1/persistentvolumeclaims'),
      k8sListOrEmpty(ctx, '/api/v1/persistentvolumes'),
    ]);
    const items = list.items || [];
    const driverItems = drivers.items || [];
    const contract = evaluateStorageContract(items, driverItems, pvcs.items || []);
    const localDelete = contract.rows.filter((row) => /local-path|hostpath/i.test(row.provisioner) && row.reclaim === 'Delete');
    const details = diagnosticDetails({
      facts: [
        { label: 'StorageClasses', value: String(items.length), state: items.length ? 'Passed' : 'Failed' },
        { label: 'Default class', value: contract.defaults.map((item) => item.metadata?.name).join(', ') || 'Missing', state: contract.defaults.length === 1 ? 'Passed' : 'Failed' },
        { label: 'Registered CSI drivers', value: driverItems.map((item) => item.metadata?.name).join(', ') || 'None', state: driverItems.length ? 'Passed' : 'Failed' },
        { label: 'Default CSI binding', value: contract.defaultCsiBacked ? contract.defaultClass.provisioner : 'Not backed by CSIDriver', state: contract.defaultCsiBacked ? 'Passed' : 'Failed' },
        { label: 'PVC Bound', value: `${(pvcs.items?.length || 0) - contract.pendingPvcs.length}/${pvcs.items?.length || 0}`, state: contract.pendingPvcs.length ? 'Failed' : 'Passed' },
        { label: 'PersistentVolumes', value: String(pvs.items?.length || 0), state: 'Info' },
      ],
      tables: [{ title: 'StorageClass capability matrix', columns: [{ key: 'name', label: 'StorageClass' }, { key: 'default', label: 'Default' }, { key: 'provisioner', label: 'Provisioner' }, { key: 'csiBacked', label: 'CSI-backed' }, { key: 'binding', label: 'Binding' }, { key: 'expansion', label: 'Expansion' }, { key: 'reclaim', label: 'Reclaim' }, { key: 'parameters', label: 'Parameters' }], rows: contract.rows }],
      warnings: [
        ...(!contract.defaultCsiBacked && contract.defaultClass ? [`${contract.defaultClass.metadata?.name}: 기본 provisioner ${contract.defaultClass.provisioner || 'unknown'}와 일치하는 CSIDriver가 없습니다.`] : []),
        ...localDelete.map((row) => `${row.name}: 노드 로컬 저장소 + reclaim Delete는 운영 내구 저장소로 권장하지 않습니다.`),
        ...contract.pendingPvcs.map((pvc) => `${pvc.metadata?.namespace}/${pvc.metadata?.name}: ${pvc.status?.phase || 'Pending'}`),
      ],
      security: ['StorageClass 변경은 기존 PVC spec을 변경하지 않습니다. class migration은 명시적 데이터 재배치가 필요합니다.', '샘플 CSI 또는 provisioner 이름 추정만으로 Ready 처리하지 않습니다. StorageClass.provisioner와 CSIDriver 등록을 정확히 대조합니다.'],
      canaries: [{ name: 'CSI registration contract', state: contract.defaultCsiBacked ? 'Passed' : 'Failed', message: contract.defaultCsiBacked ? `${contract.defaultClass.metadata?.name} → ${contract.defaultClass.provisioner}` : '기본 StorageClass가 등록된 CSIDriver에 연결되지 않았습니다.' }, { name: 'PVC inventory', state: contract.pendingPvcs.length ? 'Failed' : 'Passed', message: `${contract.pendingPvcs.length}개 unbound PVC` }, { name: 'Dynamic provision/bind', state: 'NotRun', message: '승인된 on-demand PVC canary가 필요합니다.' }],
    });
    details.validationFingerprint = storageContractFingerprint(contract.defaultClass);
    if (contract.state === 'Blocked') return result('Blocked', contract.reason, 'StorageClass가 없습니다.', '', details);
    if (contract.reason === 'DefaultStorageClassNotCsi') return result('Degraded', contract.reason, `기본 StorageClass ${contract.defaultClass.metadata.name}의 provisioner ${contract.defaultClass.provisioner}는 등록된 CSI 드라이버가 아닙니다. 승인된 호스트 스토리지 공급자 또는 Ceph CSI를 먼저 연결하십시오.`, contract.defaultClass.provisioner || '', details);
    if (contract.state === 'Degraded') return result('Degraded', contract.reason, `StorageClass ${items.length}개, 기본값 ${contract.defaults.length}개, unbound PVC ${contract.pendingPvcs.length}개입니다.`, contract.defaultClass?.provisioner || items[0]?.provisioner || '', details);
    return result('Ready', contract.reason, `CSI-backed 기본 StorageClass ${contract.defaultClass.metadata.name}와 PVC ${(pvcs.items?.length || 0) - contract.pendingPvcs.length}/${pvcs.items?.length || 0}개가 준비되었습니다.`, contract.defaultClass.provisioner || '', details);
  }
  if (name === 'snapshot') {
    const [drivers, classes, crds, deployments, snapshots, storageClasses] = await Promise.all([
      k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/csidrivers'),
      k8sListOrEmpty(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses'),
      k8sListOrEmpty(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/deployments'),
      k8sListOrEmpty(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshots'),
      k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/storageclasses'),
    ]);
    const driverItems = drivers.items || [];
    const classItems = classes.items || [];
    const snapshotCrds = (crds.items || []).filter((item) => item.spec?.group === 'snapshot.storage.k8s.io');
    const controllers = (deployments.items || []).filter((item) => /snapshot-controller|csi.*controller/i.test(item.metadata?.name || ''));
    const defaultStorageClasses = (storageClasses.items || []).filter((item) => item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
    const defaultStorageClass = defaultStorageClasses.length === 1 ? defaultStorageClasses[0] : null;
    const mappedClasses = defaultStorageClass ? classItems.filter((item) => item.driver === defaultStorageClass.provisioner) : [];
    const validationClass = mappedClasses.find((item) => item.deletionPolicy === 'Delete') || mappedClasses[0] || null;
    const rows = driverItems.map((item) => ({ name: item.metadata?.name || '', attachRequired: String(item.spec?.attachRequired ?? true), podInfo: String(item.spec?.podInfoOnMount ?? false), fsGroupPolicy: item.spec?.fsGroupPolicy || '', modes: (item.spec?.volumeLifecycleModes || []).join(', '), tokenRequests: String(item.spec?.tokenRequests?.length || 0) }));
    const details = diagnosticDetails({
      facts: [
        { label: 'CSI drivers', value: String(driverItems.length), state: driverItems.length ? 'Passed' : 'Failed' },
        { label: 'Snapshot CRDs', value: `${snapshotCrds.length}/3`, state: snapshotCrds.length >= 3 ? 'Passed' : 'Failed' },
        { label: 'Snapshot classes', value: String(classItems.length), state: classItems.length ? 'Passed' : 'Failed' },
        { label: 'Default StorageClass mapping', value: defaultStorageClass && mappedClasses.length ? `${defaultStorageClass.metadata?.name} → ${mappedClasses.map((item) => item.metadata?.name).join(', ')}` : 'Missing', state: defaultStorageClass && mappedClasses.length ? 'Passed' : 'Failed' },
        { label: 'Controller deployments', value: `${controllers.filter(availableDeployment).length}/${controllers.length}`, state: controllers.length && controllers.every(availableDeployment) ? 'Passed' : 'Failed' },
        { label: 'VolumeSnapshots', value: String(snapshots.items?.length || 0), state: 'Info' },
      ],
      tables: [
        { title: 'CSI driver capabilities', columns: [{ key: 'name', label: 'Driver' }, { key: 'attachRequired', label: 'Attach' }, { key: 'podInfo', label: 'Pod info' }, { key: 'fsGroupPolicy', label: 'FSGroup' }, { key: 'modes', label: 'Lifecycle modes' }, { key: 'tokenRequests', label: 'Token requests' }], rows },
        { title: 'VolumeSnapshotClass mapping', columns: [{ key: 'name', label: 'Class' }, { key: 'driver', label: 'Driver' }, { key: 'deletionPolicy', label: 'Deletion policy' }], rows: classItems.map((item) => ({ name: item.metadata?.name || '', driver: item.driver || '', deletionPolicy: item.deletionPolicy || '' })) },
      ],
      warnings: !driverItems.length ? ['호스트가 CSI driver를 제공하지 않습니다. local-path provisioner만으로 snapshot을 제공할 수 없습니다.'] : !classItems.length ? ['CSI driver는 있으나 VolumeSnapshotClass가 없습니다.'] : !mappedClasses.length ? ['기본 StorageClass provisioner와 연결된 VolumeSnapshotClass가 없습니다.'] : [],
      security: ['Snapshot deletionPolicy와 restore 대상 StorageClass는 데이터 보존·암호화 정책과 함께 승인해야 합니다.'],
      canaries: [{ name: 'Snapshot API contract', state: driverItems.length && classItems.length && snapshotCrds.length >= 3 ? 'Passed' : 'Failed', message: `${driverItems.length} drivers · ${classItems.length} classes · ${snapshotCrds.length} CRDs` }, { name: 'Snapshot → restore', state: 'NotRun', message: '승인된 on-demand 데이터 보호 canary가 필요합니다.' }],
    });
    details.validationFingerprint = snapshotContractFingerprint(defaultStorageClass, validationClass);
    const complete = driverItems.length && mappedClasses.length && snapshotCrds.length >= 3 && controllers.length && controllers.every(availableDeployment);
    if (complete) return result('Ready', 'SnapshotReady', 'CSI driver·snapshot controller·CRD·VolumeSnapshotClass가 준비되었습니다.', driverItems.map((item) => item.metadata?.name).join(', '), details);
    return result('Degraded', driverItems.length ? 'SnapshotContractPartial' : 'CsiDriverMissing', `CSI ${driverItems.length}개, SnapshotClass ${classItems.length}개, CRD ${snapshotCrds.length}/3, controller ${controllers.filter(availableDeployment).length}/${controllers.length}입니다.`, driverItems.map((item) => item.metadata?.name).join(', '), details);
  }
  throw new Error(`unknown probe: ${name}`);
}

async function clusterVariant(ctx) {
  const nodes = await k8s(ctx, '/api/v1/nodes');
  const names = (nodes.items || []).map((n) => n.metadata?.name || '');
  if (names.some((name) => /^desktop-|^kind-/i.test(name))) return 'kind';
  return 'standard';
}

function helmArgs(item, variant) {
  return [...(item.values || []), ...(variant === 'kind' ? item.kindValues || [] : [])];
}

async function managedValuesForItem(ctx, item) {
  if (item.id !== OBSERVABILITY_ITEM_ID) return null;
  const [live, stored] = await Promise.all([observabilityLiveState(ctx), readObservabilityConfig(ctx)]);
  return inferObservabilityConfig(live, stored);
}

function writeManagedValues(item, config, dir) {
  if (item.id !== OBSERVABILITY_ITEM_ID || !config) return [];
  const valuesPath = path.join(dir, 'opensphere-managed-values.yaml');
  fs.writeFileSync(valuesPath, yaml.dump(observabilityValues(config), { noRefs: true, lineWidth: 140 }), { mode: 0o600 });
  return ['--values', valuesPath];
}

async function helmStatus(ctx, item) {
  if (item.mode !== 'HelmManaged') return null;
  try {
    const out = await withKubeconfig(ctx, (env) => command('helm', ['status', item.release, '--namespace', item.namespace, '--output', 'json'], { env, timeoutMs: 30000 }));
    const status = JSON.parse(out.stdout || '{}');
    return { managed: true, status: status.info?.status || 'unknown', revision: status.version || 0 };
  } catch (e) {
    if (/release: not found|not found/i.test(e.safeMessage || e.message || '')) return { managed: false, status: 'not-installed', revision: 0 };
    throw e;
  }
}

async function helmHistory(ctx, item) {
  if (item.mode !== 'HelmManaged') return [];
  try {
    const out = await withKubeconfig(ctx, (env) => command('helm', ['history', item.release, '--namespace', item.namespace, '--output', 'json', '--max', '10'], { env, timeoutMs: 30000 }));
    return JSON.parse(out.stdout || '[]').map((entry) => ({
      revision: Number(entry.revision || 0),
      updated: entry.updated || '',
      status: entry.status || 'unknown',
      chart: entry.chart || '',
      appVersion: entry.app_version || '',
      description: entry.description || '',
    })).sort((left, right) => right.revision - left.revision);
  } catch (error) {
    if (/release: not found|not found/i.test(error.safeMessage || error.message || '')) return [];
    throw error;
  }
}

function operationResourceName(itemId) {
  return `opensphere-his-operation-${String(itemId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)}`;
}

function operationActive(operation) {
  if (!operation || !ACTIVE_OPERATION_PHASES.has(operation.phase)) return false;
  const updated = Date.parse(operation.updatedAt || operation.startedAt || '');
  return Number.isFinite(updated) && Date.now() - updated < OPERATION_STALE_MS;
}

async function readOperation(ctx, itemId) {
  try {
    const cm = await k8s(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${operationResourceName(itemId)}`);
    return cm.data?.operation ? JSON.parse(cm.data.operation) : null;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

async function writeOperation(ctx, item, operation) {
  const name = operationResourceName(item.id);
  let existing = null;
  try { existing = await k8s(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${name}`); }
  catch (error) { if (error.code !== 404) throw error; }
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace: OPERATION_NAMESPACE,
      ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {}),
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
        'opensphere.io/his-operation': item.id,
      },
    },
    data: { operation: JSON.stringify(operation) },
  };
  const apiPath = existing
    ? `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${name}`
    : `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps`;
  await k8sRequest(ctx, apiPath, { method: existing ? 'PUT' : 'POST', body });
  return operation;
}

async function k8sOrNull(ctx, apiPath) {
  try { return await k8s(ctx, apiPath); }
  catch (error) { if (error.code === 404) return null; throw error; }
}

async function readObservabilityConfig(ctx) {
  const cm = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${OBSERVABILITY_CONFIG_NAME}`);
  if (!cm?.data?.config) return null;
  try { return validateObservabilityConfig(JSON.parse(cm.data.config)); }
  catch (error) { throw Object.assign(new Error(`저장된 Observability 구성이 손상되었습니다: ${safeError(error)}`), { code: 500 }); }
}

function knownProfileNames() {
  return [...new Set(HIS_CATALOG.map((item) => item.profile).filter(Boolean))].sort();
}

async function readProfileSelection(ctx) {
  const cm = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${PROFILE_SELECTION_CONFIG_NAME}`);
  if (!cm?.data?.profiles) return new Set();
  try {
    const stored = JSON.parse(cm.data.profiles);
    if (!Array.isArray(stored) || stored.some((entry) => typeof entry !== 'string')) throw new Error('profiles must be a string array');
    const known = new Set(knownProfileNames());
    return new Set(stored.filter((profile) => known.has(profile)));
  } catch (error) {
    throw Object.assign(new Error(`저장된 HIS profile 선택 구성이 손상되었습니다: ${safeError(error)}`), { code: 500 });
  }
}

async function writeProfileSelection(ctx, actor, selectedProfiles, reason) {
  const existing = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${PROFILE_SELECTION_CONFIG_NAME}`);
  const known = new Set(knownProfileNames());
  const profiles = [...new Set([...selectedProfiles].filter((profile) => known.has(profile)))].sort();
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: PROFILE_SELECTION_CONFIG_NAME,
      namespace: OPERATION_NAMESPACE,
      ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {}),
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
        'opensphere.io/his-configuration': 'profile-selection',
      },
    },
    data: {
      profiles: JSON.stringify(profiles),
      updatedAt: new Date().toISOString(),
      updatedBy: actor.username,
      reason,
    },
  };
  const apiPath = existing
    ? `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${PROFILE_SELECTION_CONFIG_NAME}`
    : `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps`;
  await k8sRequest(ctx, apiPath, { method: existing ? 'PUT' : 'POST', body });
  return new Set(profiles);
}

async function writeObservabilityConfig(ctx, actor, config, reason) {
  const existing = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${OBSERVABILITY_CONFIG_NAME}`);
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: OBSERVABILITY_CONFIG_NAME,
      namespace: OPERATION_NAMESPACE,
      ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {}),
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
        'opensphere.io/his-configuration': OBSERVABILITY_ITEM_ID,
      },
    },
    data: {
      config: JSON.stringify(validateObservabilityConfig(config)),
      updatedAt: new Date().toISOString(),
      updatedBy: actor.username,
      reason,
    },
  };
  const apiPath = existing
    ? `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps/${OBSERVABILITY_CONFIG_NAME}`
    : `/api/v1/namespaces/${OPERATION_NAMESPACE}/configmaps`;
  await k8sRequest(ctx, apiPath, { method: existing ? 'PUT' : 'POST', body });
  return body;
}

function observabilityPvcComponent(name) {
  if (name === 'kube-prometheus-stack-grafana') return 'grafana';
  if (/^prometheus-.*-prometheus-0$/.test(name)) return 'prometheus';
  if (/^alertmanager-.*-alertmanager-0$/.test(name)) return 'alertmanager';
  return '';
}

async function observabilityLiveState(ctx) {
  const [storageClassList, ingressClassList, pvcList, serviceList, ingressList, policyList, prometheusList, alertmanagerList] = await Promise.all([
    k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/storageclasses'),
    k8sListOrEmpty(ctx, '/apis/networking.k8s.io/v1/ingressclasses'),
    k8sListOrEmpty(ctx, '/api/v1/namespaces/monitoring/persistentvolumeclaims'),
    k8sListOrEmpty(ctx, '/api/v1/namespaces/monitoring/services'),
    k8sListOrEmpty(ctx, '/apis/networking.k8s.io/v1/namespaces/monitoring/ingresses'),
    k8sListOrEmpty(ctx, '/apis/networking.k8s.io/v1/namespaces/monitoring/networkpolicies'),
    k8sListOrEmpty(ctx, '/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheuses'),
    k8sListOrEmpty(ctx, '/apis/monitoring.coreos.com/v1/namespaces/monitoring/alertmanagers'),
  ]);
  const storageClasses = (storageClassList.items || []).map((storageClass) => ({
    name: storageClass.metadata?.name || '',
    provisioner: storageClass.provisioner || '',
    isDefault: storageClass.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
    allowVolumeExpansion: storageClass.allowVolumeExpansion === true,
    reclaimPolicy: storageClass.reclaimPolicy || 'Delete',
    volumeBindingMode: storageClass.volumeBindingMode || 'Immediate',
  }));
  const pvcs = {};
  for (const pvc of pvcList.items || []) {
    const component = observabilityPvcComponent(pvc.metadata?.name || '');
    if (!component) continue;
    pvcs[component] = {
      name: pvc.metadata?.name || '',
      phase: pvc.status?.phase || 'Pending',
      storageClassName: pvc.spec?.storageClassName || '',
      requested: pvc.spec?.resources?.requests?.storage || '',
      capacity: pvc.status?.capacity?.storage || '',
      volumeName: pvc.spec?.volumeName || '',
      selectedNode: pvc.metadata?.annotations?.['volume.kubernetes.io/selected-node'] || '',
    };
  }
  const grafanaIngress = (ingressList.items || []).find((ingress) => /grafana/i.test(ingress.metadata?.name || '')) || null;
  const directExternalServices = (serviceList.items || []).filter((service) => {
    const name = service.metadata?.name || '';
    return /prometheus|alertmanager/i.test(name) && !/operated/.test(name)
      && !['ClusterIP', ''].includes(service.spec?.type || 'ClusterIP');
  }).map((service) => service.metadata?.name || '');
  const prometheus = (prometheusList.items || []).find((item) => item.metadata?.name === 'kube-prometheus-stack-prometheus') || prometheusList.items?.[0] || null;
  const alertmanager = (alertmanagerList.items || []).find((item) => item.metadata?.name === 'kube-prometheus-stack-alertmanager') || alertmanagerList.items?.[0] || null;
  return {
    installed: Boolean(prometheus || alertmanager || pvcs.grafana),
    storageClasses,
    ingressClasses: (ingressClassList.items || []).map((item) => ({ name: item.metadata?.name || '', controller: item.spec?.controller || '' })),
    pvcs,
    prometheus: prometheus ? {
      retention: prometheus.spec?.retention || '',
      remoteWrite: (prometheus.spec?.remoteWrite || []).map((item) => ({
        name: item.name || '',
        url: item.url || '',
        secretName: item.authorization?.credentials?.name || '',
        secretKey: item.authorization?.credentials?.key || '',
      })),
    } : null,
    alertmanager: alertmanager ? { retention: alertmanager.spec?.retention || '' } : null,
    grafana: {
      serviceType: (serviceList.items || []).find((service) => /grafana/i.test(service.metadata?.name || ''))?.spec?.type || 'NotInstalled',
      ingress: grafanaIngress ? {
        name: grafanaIngress.metadata?.name || '',
        hostname: grafanaIngress.spec?.rules?.[0]?.host || '',
        ingressClassName: grafanaIngress.spec?.ingressClassName || '',
        tlsSecretName: grafanaIngress.spec?.tls?.[0]?.secretName || '',
        exposureMode: grafanaIngress.metadata?.labels?.['opensphere.io/exposure-mode'] || 'PrivateIngress',
      } : null,
    },
    networkPolicies: (policyList.items || []).filter((policy) => policy.metadata?.labels?.['opensphere.io/policy'] === 'observability-access').map((policy) => policy.metadata?.name || ''),
    directExternalServices,
  };
}

function inferObservabilityConfig(live, stored) {
  if (stored) return validateObservabilityConfig(stored);
  const config = clone(DEFAULT_OBSERVABILITY_CONFIG);
  for (const component of ['prometheus', 'alertmanager', 'grafana']) {
    if (live.pvcs[component]) {
      config[component].storageClassName = live.pvcs[component].storageClassName;
      config[component].storageSize = live.pvcs[component].requested || live.pvcs[component].capacity || config[component].storageSize;
    }
  }
  if (live.prometheus?.retention) config.prometheus.retention = live.prometheus.retention;
  if (live.alertmanager?.retention) config.alertmanager.retention = live.alertmanager.retention;
  if (live.prometheus?.remoteWrite?.length) {
    const remote = live.prometheus.remoteWrite[0];
    config.prometheus.remoteWrite = { enabled: true, url: remote.url, secretName: remote.secretName, secretKey: remote.secretKey || 'token' };
  }
  if (live.grafana.ingress) {
    config.grafana.exposureMode = live.grafana.ingress.exposureMode;
    config.grafana.hostname = live.grafana.ingress.hostname;
    config.grafana.ingressClassName = live.grafana.ingress.ingressClassName || 'nginx';
    config.grafana.tlsSecretName = live.grafana.ingress.tlsSecretName;
  }
  return validateObservabilityConfig(config);
}

function flattenConfiguration(config) {
  return {
    'prometheus.retention': config.prometheus.retention,
    'prometheus.storageClassName': config.prometheus.storageClassName || '(cluster default)',
    'prometheus.storageSize': config.prometheus.storageSize,
    'prometheus.remoteWrite.enabled': String(config.prometheus.remoteWrite.enabled),
    'prometheus.remoteWrite.url': config.prometheus.remoteWrite.url || '—',
    'prometheus.remoteWrite.secretRef': config.prometheus.remoteWrite.enabled ? `${config.prometheus.remoteWrite.secretName}/${config.prometheus.remoteWrite.secretKey}` : '—',
    'alertmanager.retention': config.alertmanager.retention,
    'alertmanager.storageClassName': config.alertmanager.storageClassName || '(cluster default)',
    'alertmanager.storageSize': config.alertmanager.storageSize,
    'grafana.storageClassName': config.grafana.storageClassName || '(cluster default)',
    'grafana.storageSize': config.grafana.storageSize,
    'grafana.exposureMode': config.grafana.exposureMode,
    'grafana.hostname': config.grafana.hostname || '—',
    'grafana.ingressClassName': config.grafana.exposureMode === 'ClusterInternal' ? '—' : config.grafana.ingressClassName,
    'grafana.tlsSecretName': config.grafana.tlsSecretName || '—',
    'grafana.oidcSecretName': config.grafana.oidcSecretName || '—',
    'grafana.allowedCidrs': config.grafana.allowedCidrs.join(', ') || '—',
  };
}

async function secretCheck(ctx, namespace, name, requiredKeys, label) {
  const secret = await k8sOrNull(ctx, `/api/v1/namespaces/${namespace}/secrets/${encodeURIComponent(name)}`);
  if (!secret) return { ok: false, message: `${label} '${name}'을 ${namespace} namespace에서 찾지 못했습니다.` };
  const missing = requiredKeys.filter((key) => !secret.data?.[key]);
  return missing.length
    ? { ok: false, message: `${label} '${name}'에 필수 key가 없습니다: ${missing.join(', ')}` }
    : { ok: true, type: secret.type || 'Opaque' };
}

async function observabilityConfigurationPlan(ctx, rawConfig) {
  const desired = validateObservabilityConfig(rawConfig);
  const [live, stored] = await Promise.all([observabilityLiveState(ctx), readObservabilityConfig(ctx)]);
  const current = inferObservabilityConfig(live, stored);
  const blockers = [];
  const warnings = [];
  const resetTargets = [];
  const resizeTargets = [];
  const defaultStorageClass = live.storageClasses.find((item) => item.isDefault);
  const classByName = new Map(live.storageClasses.map((item) => [item.name, item]));

  for (const component of ['prometheus', 'alertmanager', 'grafana']) {
    const desiredClassName = desired[component].storageClassName || defaultStorageClass?.name || '';
    const storageClass = classByName.get(desiredClassName);
    if (!desiredClassName) blockers.push(`${component}: 기본 StorageClass가 없으므로 명시적으로 선택해야 합니다.`);
    else if (!storageClass) blockers.push(`${component}: StorageClass '${desiredClassName}'이 존재하지 않습니다.`);
    else if (/local-path|hostpath/i.test(storageClass.provisioner)) warnings.push(`${component}: '${desiredClassName}'은 노드 로컬 provisioner이므로 운영 내구성 저장소로 권장하지 않습니다.`);
    const pvc = live.pvcs[component];
    if (!pvc) continue;
    const desiredSize = storageQuantity(desired[component].storageSize, component);
    const currentSize = storageQuantity(pvc.requested || pvc.capacity, component);
    if (desiredClassName !== pvc.storageClassName) resetTargets.push(`${component}: StorageClass ${pvc.storageClassName} → ${desiredClassName}`);
    if (desiredSize.bytes < currentSize.bytes) resetTargets.push(`${component}: 용량 축소 ${pvc.requested} → ${desired[component].storageSize}`);
    if (desiredSize.bytes > currentSize.bytes) {
      if (storageClass?.allowVolumeExpansion) resizeTargets.push({ component, pvcName: pvc.name, from: pvc.requested, to: desired[component].storageSize });
      else resetTargets.push(`${component}: '${desiredClassName}'이 온라인 확장을 지원하지 않아 ${pvc.requested} → ${desired[component].storageSize} 재배치 필요`);
    }
  }

  if (desired.prometheus.remoteWrite.enabled) {
    const remoteSecret = await secretCheck(ctx, 'monitoring', desired.prometheus.remoteWrite.secretName, [desired.prometheus.remoteWrite.secretKey], 'Remote write Secret');
    if (!remoteSecret.ok) blockers.push(remoteSecret.message);
  }

  const external = desired.grafana.exposureMode !== 'ClusterInternal';
  const prerequisites = { tlsSecretReady: !external, oidcSecretReady: !external, ingressClassReady: !external };
  if (external) {
    prerequisites.ingressClassReady = live.ingressClasses.some((item) => item.name === desired.grafana.ingressClassName);
    if (!prerequisites.ingressClassReady) blockers.push(`IngressClass '${desired.grafana.ingressClassName}'이 존재하지 않습니다.`);
    const tls = await secretCheck(ctx, 'monitoring', desired.grafana.tlsSecretName, ['tls.crt', 'tls.key'], 'TLS Secret');
    prerequisites.tlsSecretReady = tls.ok && tls.type === 'kubernetes.io/tls';
    if (!tls.ok) blockers.push(tls.message);
    else if (tls.type !== 'kubernetes.io/tls') blockers.push(`TLS Secret '${desired.grafana.tlsSecretName}' type은 kubernetes.io/tls여야 합니다.`);
    const oidc = await secretCheck(ctx, 'monitoring', desired.grafana.oidcSecretName, OIDC_SECRET_KEYS, 'Grafana OIDC Secret');
    prerequisites.oidcSecretReady = oidc.ok;
    if (!oidc.ok) blockers.push(oidc.message);
    if (desired.grafana.exposureMode === 'PublicIngress') warnings.push('Public Ingress는 인터넷 노출입니다. TLS, OIDC/MFA 정책, rate limit, 감사로그를 운영자가 지속 검증해야 합니다.');
  }
  if (live.directExternalServices.length) warnings.push(`Prometheus/Alertmanager 직접 외부 Service가 감지되었습니다. 적용 시 ClusterIP로 복구합니다: ${live.directExternalServices.join(', ')}`);
  if (resetTargets.length) warnings.push('StorageClass 변경·축소 또는 확장 불가 StorageClass의 증설은 관측 데이터를 삭제한 뒤 새 PVC로 재배치해야 합니다.');

  const currentFlat = flattenConfiguration(current);
  const desiredFlat = flattenConfiguration(desired);
  const changes = Object.keys(desiredFlat).filter((field) => currentFlat[field] !== desiredFlat[field]).map((field) => ({
    field,
    from: currentFlat[field],
    to: desiredFlat[field],
    impact: field.includes('storageClassName') || field.includes('storageSize') ? 'Storage' : field.includes('exposure') || field.includes('grafana.') ? 'Access' : 'Runtime',
  }));
  return {
    config: desired,
    currentConfig: current,
    changes,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    requiresDataReset: resetTargets.length > 0,
    resetTargets: [...new Set(resetTargets)],
    resizeTargets,
    canApply: blockers.length === 0,
    prerequisites,
    live,
    policy: {
      prometheusExternalExposure: 'Prohibited',
      alertmanagerExternalExposure: 'Prohibited',
      grafanaServiceType: 'ClusterIP',
      publicConfirmation: OBSERVABILITY_PUBLIC_CONFIRMATION,
    },
  };
}

async function observabilityConfiguration(ctx) {
  const [live, stored] = await Promise.all([observabilityLiveState(ctx), readObservabilityConfig(ctx)]);
  const config = inferObservabilityConfig(live, stored);
  return {
    config,
    source: stored ? 'ManagedConfig' : live.installed ? 'InferredFromCluster' : 'Defaults',
    storageClasses: live.storageClasses,
    ingressClasses: live.ingressClasses,
    live,
    policy: {
      prometheusExternalExposure: 'Prohibited',
      alertmanagerExternalExposure: 'Prohibited',
      grafanaModes: ['ClusterInternal', 'PrivateIngress', 'PublicIngress'],
      requiredOidcSecretKeys: OIDC_SECRET_KEYS,
      resetConfirmation: OBSERVABILITY_RESET_CONFIRMATION,
      publicConfirmation: OBSERVABILITY_PUBLIC_CONFIRMATION,
    },
  };
}

async function createOperation(ctx, item, actor, action, reason, extra = {}) {
  const existing = await readOperation(ctx, item.id);
  if (operationActive(existing)) {
    throw Object.assign(new Error(`동일 HIS 항목 작업이 이미 진행 중입니다. 작업 ID: ${existing.id}`), { code: 409 });
  }
  const now = new Date().toISOString();
  const operation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`,
    itemId: item.id,
    displayName: item.displayName,
    action,
    phase: 'Queued',
    progress: 5,
    message: action === 'install'
      ? '설치 작업이 대기열에 등록되었습니다.'
      : action === 'upgrade' ? '업그레이드 작업이 대기열에 등록되었습니다.'
        : action === 'recover' ? '중단된 Helm release 복구 작업이 대기열에 등록되었습니다.'
          : action === 'rollback' ? `revision ${extra.targetRevision || ''} 롤백 작업이 대기열에 등록되었습니다.`
            : action === 'configure' ? '운영 구성 변경이 대기열에 등록되었습니다.'
              : action === 'validate' ? '실제 데이터 경로 검증 작업이 대기열에 등록되었습니다.' : '삭제 작업이 대기열에 등록되었습니다.',
    error: '',
    actor: actor.username,
    reason,
    worker: process.env.HOSTNAME || 'cluster-manager',
    startedAt: now,
    updatedAt: now,
    finishedAt: '',
    ...extra,
  };
  await writeOperation(ctx, item, operation);
  return operation;
}

async function patchOperation(ctx, item, operation, patch) {
  const next = { ...operation, ...patch, updatedAt: new Date().toISOString() };
  if (!ACTIVE_OPERATION_PHASES.has(next.phase) && !next.finishedAt) next.finishedAt = next.updatedAt;
  console.log(`[his-operation] id=${next.id} item=${item.id} action=${next.action} phase=${next.phase} progress=${next.progress} message=${String(next.message || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  await writeOperation(ctx, item, next);
  return next;
}

async function deleteIfPresent(ctx, apiPath) {
  try { await k8sRequest(ctx, apiPath, { method: 'DELETE' }); return true; }
  catch (error) { if (error.code === 404) return false; throw error; }
}

function recoverableHelmCleanupError(releaseStatus, message) {
  const text = String(message || '');
  return /has no deployed releases|release: not found|not found/i.test(text)
    || (releaseStatus === 'uninstalling' && /failed to delete release/i.test(text));
}

function stuckReleaseRecoveryStrategy(releaseStatus, workloadPresent) {
  if (releaseStatus === 'failed' && workloadPresent) return 'repair-in-place';
  return 'replace';
}

const RECOVERABLE_RELEASE_STATUSES = new Set([
  'failed',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'uninstalling',
]);

function releaseLifecycleAction(release) {
  if (!release?.managed) return 'install';
  const status = String(release.status || '').toLowerCase();
  if (status === 'deployed') return 'upgrade';
  if (RECOVERABLE_RELEASE_STATUSES.has(status)) return 'recover';
  return 'blocked';
}

async function recoverStuckRelease(ctx, actor, item, operation, release, observedCheck) {
  if (!release?.managed || !['uninstalling', 'failed', 'pending-install', 'pending-upgrade', 'pending-rollback'].includes(release.status)) {
    return operation;
  }
  operation = await patchOperation(ctx, item, operation, {
    phase: 'Recovering',
    progress: 15,
    message: `중단된 Helm release(${release.status})를 정리하고 있습니다.`,
  });
  await auditRequired(ctx, actor, 'HISRecoveryStarted', item, operation.reason, release.status);
  const observedWorkloadPresent = (observedCheck?.details?.components || []).some((component) => component.resourceName);
  if (stuckReleaseRecoveryStrategy(release.status, observedWorkloadPresent) === 'repair-in-place') {
    await auditRequired(ctx, actor, 'HISRecoveryCompleted', item, operation.reason, 'repair-in-place');
    return patchOperation(ctx, item, operation, {
      progress: 25,
      message: '실패한 Helm revision을 보존하고 현재 워크로드 위에서 안전하게 재조정합니다.',
    });
  }
  try {
    await withKubeconfig(ctx, (env) => command('helm', ['uninstall', item.release, '--namespace', item.namespace, '--no-hooks', '--wait', '--timeout', '2m'], { env, timeoutMs: 150000 }));
  } catch (error) {
    if (!recoverableHelmCleanupError(release.status, error.safeMessage || error.message || '')) throw error;
  }
  const check = await probe(ctx, item.probe);
  const workloadPresent = (check.details?.components || []).some((component) => component.resourceName);
  if (workloadPresent) {
    throw Object.assign(new Error('중단된 release의 워크로드가 남아 있어 자동 복구를 중단했습니다. 세부 운영 상태를 확인하십시오.'), { code: 409 });
  }
  const selector = encodeURIComponent(`owner=helm,name=${item.release}`);
  const secrets = await k8s(ctx, `/api/v1/namespaces/${item.namespace}/secrets?labelSelector=${selector}`);
  for (const secret of secrets.items || []) {
    await deleteIfPresent(ctx, `/api/v1/namespaces/${item.namespace}/secrets/${encodeURIComponent(secret.metadata.name)}`);
  }
  if (item.id === 'kube-prometheus-stack') {
    await deleteIfPresent(ctx, `/api/v1/namespaces/${item.namespace}/secrets/kube-prometheus-stack-admission`);
  }
  await auditRequired(ctx, actor, 'HISRecoveryCompleted', item, operation.reason, 'success');
  return patchOperation(ctx, item, operation, { progress: 25, message: '중단된 release 정리가 완료되었습니다.' });
}

async function itemStatus(ctx, item) {
  try {
    const [check, release, operation] = await Promise.all([probe(ctx, item.probe), helmStatus(ctx, item), readOperation(ctx, item.id)]);
    const ownership = release?.managed ? 'ClusterManager' : check.state === 'Ready' ? 'External' : 'Unmanaged';
    const validatedCheck = gateValidationReadiness(check, operation, item.id);
    const enrichedCheck = {
      ...validatedCheck,
      details: {
        ...(validatedCheck.details || {}),
        compatibility: item.compatibility || null,
        remediation: item.remediation || null,
      },
    };
    return { ...item, check: enrichedCheck, release, operation, ownership, chart: undefined, values: undefined, kindValues: undefined };
  } catch (e) {
    return {
      ...item,
      chart: undefined,
      values: undefined,
      kindValues: undefined,
      ownership: 'Unknown',
      release: null,
      operation: null,
      check: result('Blocked', 'ProbeFailed', safeError(e)),
    };
  }
}

function evaluateProfiles(items, explicitProfiles = new Set()) {
  return knownProfileNames().map((name) => {
    const profileItems = items.filter((item) => item.profile === name);
    const managedRelease = profileItems.some((item) => item.release?.managed);
    const explicit = explicitProfiles.has(name);
    const selected = explicit || managedRelease;
    const state = !selected
      ? 'NotSelected'
      : profileItems.some((item) => item.check.state === 'Blocked')
        ? 'Blocked'
        : profileItems.some((item) => item.check.state === 'Degraded') ? 'Degraded' : 'Ready';
    return {
      name,
      selected,
      selectionSource: explicit ? 'Explicit' : managedRelease ? 'ManagedRelease' : 'None',
      state,
      ready: profileItems.filter((item) => item.check.state === 'Ready').length,
      total: profileItems.length,
      itemIds: profileItems.map((item) => item.id),
    };
  });
}

function evaluateStackStatus(items, profiles) {
  const profileMap = new Map(profiles.map((profile) => [profile.name, profile]));
  const enrichedItems = items.map((item) => {
    const profileSelected = Boolean(item.profile && profileMap.get(item.profile)?.selected);
    return { ...item, profileSelected, effectiveRequired: item.required || profileSelected };
  });
  const required = enrichedItems.filter((item) => item.effectiveRequired);
  const state = required.some((item) => item.check.state === 'Blocked')
    ? 'Blocked'
    : required.some((item) => item.check.state === 'Degraded') ? 'Degraded' : 'Ready';
  const core = enrichedItems.filter((item) => item.required);
  const selectedProfiles = profiles.filter((profile) => profile.selected);
  return {
    state,
    items: enrichedItems,
    summary: {
      coreReady: core.filter((item) => item.check.state === 'Ready').length,
      coreTotal: core.length,
      selectedProfilesReady: selectedProfiles.filter((profile) => profile.state === 'Ready').length,
      selectedProfilesTotal: selectedProfiles.length,
    },
  };
}

async function allStatus(ctx) {
  const items = [];
  for (const item of HIS_CATALOG) items.push(await itemStatus(ctx, item));
  const explicitProfiles = await readProfileSelection(ctx);
  const profiles = evaluateProfiles(items, explicitProfiles);
  const evaluated = evaluateStackStatus(items, profiles);
  return {
    stack: 'HIS',
    state: evaluated.state,
    checkedAt: new Date().toISOString(),
    items: evaluated.items,
    profiles,
    summary: evaluated.summary,
  };
}

async function setProfileSelection(ctx, actor, body) {
  const profile = String(body?.profile || '').trim();
  const selected = body?.selected;
  if (!knownProfileNames().includes(profile)) throw Object.assign(new Error('승인되지 않은 HIS profile입니다.'), { code: 404 });
  if (typeof selected !== 'boolean') throw Object.assign(new Error('profile selected 값은 boolean이어야 합니다.'), { code: 400 });
  const reason = reasonFrom(body);
  const profileItems = HIS_CATALOG.filter((item) => item.profile === profile);
  if (!selected) {
    const releases = await Promise.all(profileItems.filter((item) => item.mode === 'HelmManaged').map((item) => helmStatus(ctx, item)));
    if (releases.some((release) => release?.managed)) {
      throw Object.assign(new Error('설치된 profile은 먼저 해당 HelmManaged 항목을 삭제해야 선택 해제할 수 있습니다.'), { code: 409 });
    }
  }
  const previous = await readProfileSelection(ctx);
  const next = new Set(previous);
  if (selected) next.add(profile); else next.delete(profile);
  const auditItem = { id: `profile/${profile.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, displayName: profile };
  await auditRequired(ctx, actor, 'HISProfileSelectionRequested', auditItem, reason, selected ? 'selected' : 'deselected');
  await writeProfileSelection(ctx, actor, next, reason);
  try {
    await auditRequired(ctx, actor, 'HISProfileSelectionChanged', auditItem, reason, selected ? 'selected' : 'deselected');
  } catch (error) {
    await writeProfileSelection(ctx, actor, previous, `rollback: ${reason}`);
    throw error;
  }
  await ctx.publishNotify({
    userActor: actor.username,
    action: 'HISProfileSelectionChanged',
    target: `HIS/Profile/${profile}`,
    result: selected ? 'selected' : 'deselected',
    reason,
  });
  return allStatus(ctx);
}

async function auditRequired(ctx, actor, action, item, reason, resultValue) {
  const response = await fetch(`${ctx.controller}/api/admin/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token()}`,
      'content-type': 'application/json',
      'x-opensphere-source': 'cluster-manager',
    },
    body: JSON.stringify({
      source: 'cluster-manager',
      userActor: actor.username,
      action,
      target: `HIS/${item.id}`,
      result: resultValue,
      reason,
      metadata: { chart: item.chartName, chartVersion: item.chartVersion, release: item.release, namespace: item.namespace },
    }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`내구 감사 저장소를 사용할 수 없습니다(HTTP ${response.status}). HIS 변경을 차단했습니다.`), { code: 503 });
  }
}

function assertManagedItem(body) {
  const item = catalogItem(String(body && body.id || ''));
  if (!item) throw Object.assign(new Error('승인되지 않은 HIS 항목입니다.'), { code: 404 });
  if (item.mode !== 'HelmManaged') throw Object.assign(new Error('이 항목은 호스트 제공 DetectOnly capability입니다.'), { code: 409 });
  return item;
}

async function actorFor(ctx, req, adminRequired) {
  const actor = await ctx.verifyToken(ctx.requestToken(req));
  const groups = Array.isArray(actor.groups) ? actor.groups : [];
  if (adminRequired && !groups.includes(ADMIN_GROUP)) {
    throw Object.assign(new Error('HIS 변경은 Console 관리자만 수행할 수 있습니다.'), { code: 403 });
  }
  return actor;
}

function renderedResources(rendered, defaultNamespace) {
  const clusterScopedKinds = new Set(['CustomResourceDefinition', 'ClusterRole', 'ClusterRoleBinding', 'Namespace', 'APIService', 'IngressClass', 'StorageClass', 'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration']);
  const resources = [];
  for (const document of String(rendered || '').split(/^---\s*$/m)) {
    // Helm appends chart NOTES to `helm template` output. NOTES are human text,
    // not Kubernetes YAML, and must never block the executable manifest plan.
    if (!/(^|\n)apiVersion:\s*\S+/m.test(document) || !/(^|\n)kind:\s*\S+/m.test(document)) continue;
    const parsed = yaml.load(document);
    const documents = Array.isArray(parsed?.items) && parsed.kind === 'List' ? parsed.items : [parsed];
    for (const doc of documents) {
      if (!doc || typeof doc !== 'object' || !doc.kind) continue;
      resources.push({
        apiVersion: doc.apiVersion || '',
        kind: doc.kind,
        namespace: doc.metadata?.namespace || (clusterScopedKinds.has(doc.kind) ? 'cluster-scoped' : defaultNamespace),
        name: doc.metadata?.name || '',
      });
    }
  }
  return resources;
}

async function plan(ctx, item) {
  const variant = await clusterVariant(ctx);
  const managedValues = await managedValuesForItem(ctx, item);
  const out = await withKubeconfig(ctx, (env, dir) => {
    const args = ['template', item.release, item.chart, '--namespace', item.namespace, '--include-crds', ...helmArgs(item, variant), ...writeManagedValues(item, managedValues, dir)];
    return command('helm', args, { env, timeoutMs: 120000 });
  });
  const resources = renderedResources(out.stdout, item.namespace);
  const byKind = resources.reduce((summary, resource) => {
    summary[resource.kind] = (summary[resource.kind] || 0) + 1;
    return summary;
  }, {});
  const history = await helmHistory(ctx, item);
  return {
    id: item.id,
    displayName: item.displayName,
    chart: item.chartName,
    chartVersion: item.chartVersion,
    namespace: item.namespace,
    release: item.release,
    clusterVariant: variant,
    resources,
    summary: {
      workloads: (byKind.Deployment || 0) + (byKind.StatefulSet || 0) + (byKind.DaemonSet || 0) + (byKind.Job || 0),
      services: byKind.Service || 0,
      persistentVolumeClaims: byKind.PersistentVolumeClaim || 0,
      customResourceDefinitions: byKind.CustomResourceDefinition || 0,
      byKind,
    },
    operationalProfile: item.operationalProfile || null,
    retainedOnDelete: item.retainedOnDelete || [],
    history,
  };
}

async function waitForProbe(ctx, item, wanted, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe(ctx, item.probe);
    if (wanted(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return last || result('Blocked', 'ProbeTimeout', '검증 시간이 초과되었습니다.');
}

async function commandWithHeartbeat(ctx, item, operation, args, managedValues = null) {
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const current = await readOperation(ctx, item.id);
      if (current?.id === operation.id && operationActive(current)) {
        await writeOperation(ctx, item, { ...current, updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      console.error(`[his-operation] heartbeat failed id=${operation.id}: ${safeError(error)}`);
    } finally {
      heartbeatBusy = false;
    }
  }, 5000);
  try {
    return await withKubeconfig(ctx, (env, dir) => command('helm', [...args, ...writeManagedValues(item, managedValues, dir)], { env }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function resizeObservabilityPvcs(ctx, targets) {
  for (const target of targets) {
    await k8sRequest(ctx, `/api/v1/namespaces/monitoring/persistentvolumeclaims/${encodeURIComponent(target.pvcName)}`, {
      method: 'PATCH',
      contentType: 'application/merge-patch+json',
      body: { spec: { resources: { requests: { storage: target.to } } } },
    });
  }
}

async function waitForObservabilityPvcsRemoved(ctx, names, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = [];
    for (const name of names) {
      if (await k8sOrNull(ctx, `/api/v1/namespaces/monitoring/persistentvolumeclaims/${encodeURIComponent(name)}`)) remaining.push(name);
    }
    if (!remaining.length) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Object.assign(new Error('기존 Observability PVC 삭제 대기 시간이 초과되었습니다.'), { code: 504 });
}

async function resetObservabilityData(ctx, item, operation, live) {
  const names = Object.values(live.pvcs || {}).map((pvc) => pvc.name).filter(Boolean);
  const release = await helmStatus(ctx, item);
  if (release?.managed) {
    await commandWithHeartbeat(ctx, item, operation, ['uninstall', item.release, '--namespace', item.namespace, '--wait', '--timeout', '10m']);
  }
  for (const name of names) {
    await deleteIfPresent(ctx, `/api/v1/namespaces/monitoring/persistentvolumeclaims/${encodeURIComponent(name)}`);
  }
  await waitForObservabilityPvcsRemoved(ctx, names);
  return names;
}

function canaryResourceName(prefix) {
  return `opensphere-his-${prefix}-${Date.now().toString(36)}`.slice(0, 63);
}

async function currentRuntimeImage(ctx) {
  const podName = process.env.HOSTNAME;
  if (!podName) throw Object.assign(new Error('검증 Pod에 사용할 현재 Cluster Manager image를 확인할 수 없습니다.'), { code: 500 });
  const pod = await k8s(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(podName)}`);
  const image = (pod.spec?.containers || []).find((container) => container.name === 'cluster-manager')?.image || pod.spec?.containers?.[0]?.image;
  if (!image) throw Object.assign(new Error('현재 Cluster Manager image 참조가 없습니다.'), { code: 500 });
  return image;
}

function syntheticPod(name, image, script, options = {}) {
  const labels = {
    'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
    'opensphere.io/his-canary': options.domain || 'runtime',
    ...(options.labels || {}),
  };
  const container = {
    name: 'probe', image, imagePullPolicy: 'IfNotPresent', command: ['node', '-e'], args: [script],
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 1000, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '5m', memory: '12Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
    ...(options.ports?.length ? { ports: options.ports } : {}),
    ...(options.readinessPath ? { readinessProbe: { httpGet: { path: options.readinessPath, port: options.ports?.[0]?.name || options.ports?.[0]?.containerPort }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 20 } } : {}),
  };
  return {
    apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: OPERATION_NAMESPACE, labels },
    spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      ...(options.nodeName ? { nodeSelector: { 'kubernetes.io/hostname': options.nodeName } } : {}),
      ...(options.nodeName ? { tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }, { operator: 'Exists', effect: 'NoExecute' }] } : {}),
      containers: [container],
    },
  };
}

function syntheticService(name, labels) {
  return {
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: OPERATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', ...labels } },
    spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'metrics', protocol: 'TCP', port: 8080, targetPort: 'metrics' }] },
  };
}

function syntheticDenyPolicy(name, labels) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace: OPERATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager' } },
    spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress'], ingress: [] },
  };
}

async function waitForCanaryPodReady(ctx, name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(name)}`);
    if (pod?.status?.phase === 'Failed') throw Object.assign(new Error(`검증 서버 Pod ${name}가 실패했습니다: ${pod.status?.message || pod.status?.reason || 'unknown'}`), { code: 502 });
    if (pod?.status?.phase === 'Running' && condition(pod, 'Ready')?.status === 'True') return pod;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Object.assign(new Error(`검증 서버 Pod ${name} Ready 대기 시간이 초과되었습니다.`), { code: 504 });
}

async function readySchedulableNodes(ctx) {
  const list = await k8s(ctx, '/api/v1/nodes');
  return (list.items || []).filter((node) => !node.spec?.unschedulable && condition(node, 'Ready')?.status === 'True');
}

async function runtimeCanaryPrerequisites(ctx, item) {
  const check = await probe(ctx, item.probe);
  const eligibleReasons = {
    'cluster-network': 'CniReady',
    'cluster-dns': 'DnsResolutionReady',
    [OBSERVABILITY_ITEM_ID]: 'ObservabilityReady',
  };
  if (check.reason !== eligibleReasons[item.id] || !check.details?.validationFingerprint) {
    throw Object.assign(new Error(`${item.displayName} 객체 계약이 준비되지 않아 실제 기능 검증을 실행할 수 없습니다: ${check.message}`), { code: 409 });
  }
  const nodes = item.id === OBSERVABILITY_ITEM_ID ? [] : await readySchedulableNodes(ctx);
  if (item.id === 'cluster-network' && nodes.length < 2) throw Object.assign(new Error('cross-node 검증에는 서로 다른 Ready·schedulable 노드가 2개 이상 필요합니다.'), { code: 409 });
  if (item.id === 'cluster-dns' && !nodes.length) throw Object.assign(new Error('DNS 검증을 실행할 Ready·schedulable 노드가 없습니다.'), { code: 409 });
  return { fingerprint: check.details.validationFingerprint, nodes };
}

async function runNetworkCanary(ctx, prerequisites) {
  const image = await currentRuntimeImage(ctx);
  const base = canaryResourceName('network');
  const serverName = `${base}-server`.slice(0, 63);
  const serviceName = `${base}-service`.slice(0, 63);
  const clientName = `${base}-client`.slice(0, 63);
  const deniedName = `${base}-denied`.slice(0, 63);
  const policyName = `${base}-deny`.slice(0, 63);
  const instanceLabels = { 'opensphere.io/canary-instance': base };
  const serviceHost = `${serviceName}.${OPERATION_NAMESPACE}.svc.cluster.local`;
  const serverScript = "require('http').createServer((request,response)=>{response.writeHead(200,{'content-type':'text/plain'});response.end('opensphere-his-network-canary');}).listen(8080,'0.0.0.0');";
  const positiveScript = `const dns=require('dns').promises; (async()=>{const internal=await fetch(${JSON.stringify(`http://${serviceHost}:8080`)},{signal:AbortSignal.timeout(10000)});if((await internal.text()).trim()!=='opensphere-his-network-canary')throw new Error('cross-node payload mismatch');await dns.lookup('registry.k8s.io');const external=await fetch('https://registry.k8s.io/v2/',{signal:AbortSignal.timeout(15000)});if(external.status>=500)throw new Error('egress status '+external.status);})().catch(error=>{console.error(error);process.exit(1)});`;
  const deniedScript = `(async()=>{try{await fetch(${JSON.stringify(`http://${serviceHost}:8080`)},{signal:AbortSignal.timeout(5000)});throw new Error('NetworkPolicy deny가 적용되지 않았습니다.');}catch(error){if(String(error.message).includes('적용되지'))throw error;}})().catch(error=>{console.error(error);process.exit(1)});`;
  try {
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: syntheticPod(serverName, image, serverScript, { domain: 'network', labels: instanceLabels, nodeName: prerequisites.nodes[0].metadata.name, ports: [{ name: 'metrics', containerPort: 8080 }], readinessPath: '/' }) });
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/services`, { method: 'POST', body: syntheticService(serviceName, instanceLabels) });
    await waitForCanaryPodReady(ctx, serverName);
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: syntheticPod(clientName, image, positiveScript, { domain: 'network', nodeName: prerequisites.nodes[1].metadata.name }) });
    await waitForCanaryPod(ctx, clientName, 90000);
    await k8sRequest(ctx, `/apis/networking.k8s.io/v1/namespaces/${OPERATION_NAMESPACE}/networkpolicies`, { method: 'POST', body: syntheticDenyPolicy(policyName, instanceLabels) });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: syntheticPod(deniedName, image, deniedScript, { domain: 'network', nodeName: prerequisites.nodes[1].metadata.name }) });
    await waitForCanaryPod(ctx, deniedName, 60000);
    return { message: `서로 다른 노드 ${prerequisites.nodes[0].metadata.name}→${prerequisites.nodes[1].metadata.name} Service 통신, 외부 egress와 NetworkPolicy deny를 검증했습니다.` };
  } finally {
    for (const name of [deniedName, clientName, serverName]) await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(name)}`).catch(() => false);
    await deleteIfPresent(ctx, `/apis/networking.k8s.io/v1/namespaces/${OPERATION_NAMESPACE}/networkpolicies/${encodeURIComponent(policyName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/services/${encodeURIComponent(serviceName)}`).catch(() => false);
  }
}

async function runDnsCanary(ctx, prerequisites) {
  const image = await currentRuntimeImage(ctx);
  const base = canaryResourceName('dns');
  const names = prerequisites.nodes.map((node, index) => `${base}-${index}`.slice(0, 63));
  const script = "const dns=require('dns').promises;(async()=>{for(const host of ['kubernetes.default.svc.cluster.local','registry.k8s.io']){for(let i=0;i<3;i+=1){await Promise.race([dns.lookup(host),new Promise((_,reject)=>setTimeout(()=>reject(new Error(host+' timeout')),5000))]);}}})().catch(error=>{console.error(error);process.exit(1)});";
  try {
    await Promise.all(prerequisites.nodes.map((node, index) => k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, {
      method: 'POST', body: syntheticPod(names[index], image, script, { domain: 'dns', nodeName: node.metadata.name }),
    })));
    await Promise.all(names.map((name) => waitForCanaryPod(ctx, name, 90000)));
    return { message: `${prerequisites.nodes.length}개 Ready 노드 모두에서 cluster.local과 외부 upstream DNS 질의를 각각 3회 통과했습니다.` };
  } finally {
    for (const name of names) await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(name)}`).catch(() => false);
  }
}

async function waitForHttpJson(url, accepted, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (accepted(value)) return value;
      last = JSON.stringify(value).slice(0, 500);
    } catch (error) { last = safeError(error); }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw Object.assign(new Error(`관측 canary 응답 대기 시간이 초과되었습니다: ${last}`), { code: 504 });
}

async function runObservabilityCanary(ctx) {
  const image = await currentRuntimeImage(ctx);
  const base = canaryResourceName('observe');
  const podName = `${base}-metrics`.slice(0, 63);
  const serviceName = `${base}-metrics`.slice(0, 63);
  const monitorName = `${base}-monitor`.slice(0, 63);
  const ruleName = `${base}-rule`.slice(0, 63);
  const instanceLabels = { 'opensphere.io/canary-instance': base };
  const metricScript = `require('http').createServer((request,response)=>{response.writeHead(200,{'content-type':request.url==='/metrics'?'text/plain; version=0.0.4':'text/plain'});response.end(request.url==='/metrics'?${JSON.stringify(`# HELP opensphere_his_canary OpenSphere HIS synthetic metric\n# TYPE opensphere_his_canary gauge\nopensphere_his_canary{instance_id="${base}"} 1\n`)}:'ok');}).listen(8080,'0.0.0.0');`;
  try {
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: syntheticPod(podName, image, metricScript, { domain: 'observability', labels: instanceLabels, ports: [{ name: 'metrics', containerPort: 8080 }], readinessPath: '/' }) });
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/services`, { method: 'POST', body: syntheticService(serviceName, instanceLabels) });
    await waitForCanaryPodReady(ctx, podName);
    await k8sRequest(ctx, '/apis/monitoring.coreos.com/v1/namespaces/monitoring/servicemonitors', { method: 'POST', body: {
      apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor', metadata: { name: monitorName, namespace: 'monitoring', labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', release: 'kube-prometheus-stack' } },
      spec: { namespaceSelector: { matchNames: [OPERATION_NAMESPACE] }, selector: { matchLabels: instanceLabels }, endpoints: [{ port: 'metrics', path: '/metrics', interval: '5s', scrapeTimeout: '3s' }] },
    } });
    await k8sRequest(ctx, '/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules', { method: 'POST', body: {
      apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', metadata: { name: ruleName, namespace: 'monitoring', labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', release: 'kube-prometheus-stack' } },
      spec: { groups: [{ name: `opensphere-his-canary-${base}`, interval: '5s', rules: [{ alert: 'OpenSphereHISCanary', expr: `opensphere_his_canary{instance_id="${base}"} == 1`, for: '0m', labels: { severity: 'none', opensphere_canary_id: base }, annotations: { summary: 'OpenSphere HIS synthetic alert' } }] }] },
    } });
    const query = encodeURIComponent(`opensphere_his_canary{instance_id="${base}"}`);
    await waitForHttpJson(`http://kube-prometheus-stack-prometheus.monitoring.svc:9090/api/v1/query?query=${query}`, (value) => value.status === 'success' && (value.data?.result || []).some((entry) => entry.metric?.instance_id === base));
    await waitForHttpJson('http://kube-prometheus-stack-alertmanager.monitoring.svc:9093/api/v2/alerts', (value) => Array.isArray(value) && value.some((alert) => alert.labels?.alertname === 'OpenSphereHISCanary' && alert.labels?.opensphere_canary_id === base && alert.status?.state === 'active'));
    return { message: `synthetic metric ${base}의 ServiceMonitor scrape, Prometheus rule 평가와 Alertmanager 전달을 통과했습니다.` };
  } finally {
    await deleteIfPresent(ctx, `/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules/${encodeURIComponent(ruleName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/apis/monitoring.coreos.com/v1/namespaces/monitoring/servicemonitors/${encodeURIComponent(monitorName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/services/${encodeURIComponent(serviceName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(podName)}`).catch(() => false);
  }
}

function canaryPvc(name, storageClassName, dataSource = null) {
  return {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: OPERATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', 'opensphere.io/his-canary': 'storage' } },
    spec: {
      accessModes: ['ReadWriteOnce'], storageClassName,
      resources: { requests: { storage: '64Mi' } },
      ...(dataSource ? { dataSource } : {}),
    },
  };
}

function canaryPod(name, pvcName, image, command) {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace: OPERATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', 'opensphere.io/his-canary': 'storage' } },
    spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' }, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
      containers: [{
        name: 'probe', image, imagePullPolicy: 'IfNotPresent', command: ['/bin/sh', '-ec'], args: [command],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 1000, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '5m', memory: '8Mi' }, limits: { cpu: '50m', memory: '32Mi' } },
        volumeMounts: [{ name: 'data', mountPath: '/canary' }],
      }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName } }],
    },
  };
}

async function waitForCanaryPod(ctx, name, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(name)}`);
    if (pod?.status?.phase === 'Succeeded') return pod;
    if (pod?.status?.phase === 'Failed') {
      const terminated = pod.status?.containerStatuses?.[0]?.state?.terminated;
      throw Object.assign(new Error(`검증 Pod가 실패했습니다(exit ${terminated?.exitCode ?? 'unknown'}): ${terminated?.message || pod.status?.message || pod.status?.reason || 'unknown'}`), { code: 502 });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Object.assign(new Error(`검증 Pod ${name} 완료 대기 시간이 초과되었습니다.`), { code: 504 });
}

async function waitForPvcBound(ctx, name, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pvc = await k8sOrNull(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims/${encodeURIComponent(name)}`);
    if (pvc?.status?.phase === 'Bound') return pvc;
    if (pvc?.status?.phase === 'Lost') throw Object.assign(new Error(`검증 PVC ${name}이 Lost 상태입니다.`), { code: 502 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Object.assign(new Error(`검증 PVC ${name} 바인딩 대기 시간이 초과되었습니다.`), { code: 504 });
}

async function waitForSnapshotReady(ctx, name, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await k8sOrNull(ctx, `/apis/snapshot.storage.k8s.io/v1/namespaces/${OPERATION_NAMESPACE}/volumesnapshots/${encodeURIComponent(name)}`);
    if (snapshot?.status?.readyToUse) return snapshot;
    if (snapshot?.status?.error) throw Object.assign(new Error(`VolumeSnapshot 실패: ${snapshot.status.error.message || 'unknown'}`), { code: 502 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Object.assign(new Error(`VolumeSnapshot ${name} 준비 대기 시간이 초과되었습니다.`), { code: 504 });
}

async function storageCanaryPrerequisites(ctx, requireSnapshot = false) {
  const [classes, drivers, snapshotClasses] = await Promise.all([
    k8s(ctx, '/apis/storage.k8s.io/v1/storageclasses'),
    k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/csidrivers'),
    requireSnapshot ? k8sListOrEmpty(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses') : Promise.resolve({ items: [] }),
  ]);
  const contract = evaluateStorageContract(classes.items || [], drivers.items || [], []);
  if (!contract.defaultCsiBacked) throw Object.assign(new Error('기본 StorageClass가 등록된 CSI 드라이버에 연결되지 않아 실제 데이터 경로 검증을 실행할 수 없습니다.'), { code: 409 });
  let snapshotClass = null;
  if (requireSnapshot) {
    snapshotClass = (snapshotClasses.items || []).find((item) => item.driver === contract.defaultClass.provisioner && item.deletionPolicy === 'Delete');
    if (!snapshotClass) throw Object.assign(new Error(`CSI ${contract.defaultClass.provisioner}와 일치하고 deletionPolicy=Delete인 VolumeSnapshotClass가 필요합니다. Retain class는 검증 잔여물을 만들 수 있어 사용하지 않습니다.`), { code: 409 });
  }
  return {
    storageClass: contract.defaultClass,
    snapshotClass,
    fingerprint: requireSnapshot
      ? snapshotContractFingerprint(contract.defaultClass, snapshotClass)
      : storageContractFingerprint(contract.defaultClass),
  };
}

async function runStorageBindCanary(ctx, prerequisites = null) {
  const { storageClass } = prerequisites || await storageCanaryPrerequisites(ctx, false);
  const image = await currentRuntimeImage(ctx);
  const base = canaryResourceName('bind');
  const pvcName = `${base}-pvc`.slice(0, 63);
  const podName = `${base}-pod`.slice(0, 63);
  try {
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims`, { method: 'POST', body: canaryPvc(pvcName, storageClass.metadata.name) });
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: canaryPod(podName, pvcName, image, "printf '%s\\n' 'opensphere-his-storage-canary' > /canary/probe && grep -qx 'opensphere-his-storage-canary' /canary/probe") });
    await waitForCanaryPod(ctx, podName);
    const pvc = await waitForPvcBound(ctx, pvcName);
    return { message: `CSI 동적 provision·mount·read/write 검증을 통과했습니다. ${storageClass.metadata.name} → ${storageClass.provisioner}, PV ${pvc.spec?.volumeName || 'bound'}` };
  } finally {
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(podName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims/${encodeURIComponent(pvcName)}`).catch(() => false);
  }
}

async function runSnapshotRestoreCanary(ctx, prerequisites = null) {
  const { storageClass, snapshotClass } = prerequisites || await storageCanaryPrerequisites(ctx, true);
  const image = await currentRuntimeImage(ctx);
  const base = canaryResourceName('snapshot');
  const sourcePvc = `${base}-source`.slice(0, 63);
  const writerPod = `${base}-writer`.slice(0, 63);
  const snapshotName = `${base}-snap`.slice(0, 63);
  const restorePvc = `${base}-restore`.slice(0, 63);
  const readerPod = `${base}-reader`.slice(0, 63);
  try {
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims`, { method: 'POST', body: canaryPvc(sourcePvc, storageClass.metadata.name) });
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: canaryPod(writerPod, sourcePvc, image, "printf '%s\\n' 'opensphere-his-snapshot-canary' > /canary/probe && sync") });
    await waitForCanaryPod(ctx, writerPod);
    await waitForPvcBound(ctx, sourcePvc);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(writerPod)}`);
    await k8sRequest(ctx, `/apis/snapshot.storage.k8s.io/v1/namespaces/${OPERATION_NAMESPACE}/volumesnapshots`, {
      method: 'POST',
      body: { apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot', metadata: { name: snapshotName, namespace: OPERATION_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'opensphere-cluster-manager', 'opensphere.io/his-canary': 'snapshot' } }, spec: { volumeSnapshotClassName: snapshotClass.metadata.name, source: { persistentVolumeClaimName: sourcePvc } } },
    });
    const snapshot = await waitForSnapshotReady(ctx, snapshotName);
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims`, { method: 'POST', body: canaryPvc(restorePvc, storageClass.metadata.name, { apiGroup: 'snapshot.storage.k8s.io', kind: 'VolumeSnapshot', name: snapshotName }) });
    await k8sRequest(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods`, { method: 'POST', body: canaryPod(readerPod, restorePvc, image, "grep -qx 'opensphere-his-snapshot-canary' /canary/probe") });
    await waitForCanaryPod(ctx, readerPod);
    const restored = await waitForPvcBound(ctx, restorePvc);
    return { message: `Snapshot→Restore와 데이터 무결성 검증을 통과했습니다. ${snapshotClass.metadata.name}, content ${snapshot.status?.boundVolumeSnapshotContentName || 'ready'}, restore PV ${restored.spec?.volumeName || 'bound'}` };
  } finally {
    for (const name of [readerPod, writerPod]) await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/pods/${encodeURIComponent(name)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims/${encodeURIComponent(restorePvc)}`).catch(() => false);
    await deleteIfPresent(ctx, `/apis/snapshot.storage.k8s.io/v1/namespaces/${OPERATION_NAMESPACE}/volumesnapshots/${encodeURIComponent(snapshotName)}`).catch(() => false);
    await deleteIfPresent(ctx, `/api/v1/namespaces/${OPERATION_NAMESPACE}/persistentvolumeclaims/${encodeURIComponent(sourcePvc)}`).catch(() => false);
  }
}

async function executeCanaryValidation(ctx, actor, item, operation) {
  let current = operation;
  try {
    current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 15, message: '격리된 임시 리소스로 실제 기능 경로를 검증하고 있습니다.' });
    const storageValidation = ['storage', 'csi-snapshot'].includes(item.id);
    const prerequisites = storageValidation
      ? await storageCanaryPrerequisites(ctx, item.id === 'csi-snapshot')
      : await runtimeCanaryPrerequisites(ctx, item);
    current = await patchOperation(ctx, item, current, { validationFingerprint: prerequisites.fingerprint, progress: 25, message: '현재 HIS 기능 계약 지문을 고정하고 synthetic 검증 리소스를 생성하고 있습니다.' });
    const outcome = item.id === 'cluster-network' ? await runNetworkCanary(ctx, prerequisites)
      : item.id === 'cluster-dns' ? await runDnsCanary(ctx, prerequisites)
        : item.id === OBSERVABILITY_ITEM_ID ? await runObservabilityCanary(ctx)
          : item.id === 'storage' ? await runStorageBindCanary(ctx, prerequisites)
            : await runSnapshotRestoreCanary(ctx, prerequisites);
    await auditRequired(ctx, actor, 'HISCanaryValidated', item, operation.reason, `success:${outcome.message}`);
    await ctx.publishNotify({ userActor: actor.username, action: 'HISCanaryValidated', target: `HIS/${item.id}`, result: 'success', reason: `${operation.reason} · ${outcome.message}` });
    await patchOperation(ctx, item, current, { phase: 'Ready', progress: 100, message: outcome.message, error: '' });
  } catch (error) {
    const message = safeError(error);
    try { await auditRequired(ctx, actor, 'HISCanaryValidationFailed', item, operation.reason, message); }
    catch (auditError) { console.error(`[his-canary] failure audit unavailable id=${operation.id}: ${safeError(auditError)}`); }
    try { await ctx.publishNotify({ userActor: actor.username, action: 'HISCanaryValidationFailed', target: `HIS/${item.id}`, result: 'error', reason: `${operation.reason} · ${message}` }); }
    catch { /* best effort notification */ }
    await patchOperation(ctx, item, current, { phase: 'Failed', progress: 100, message: '실제 기능 경로 검증에 실패했습니다.', error: message });
  }
}

async function executeObservabilityConfiguration(ctx, actor, item, operation, desired, dataReset) {
  let current = operation;
  try {
    current = await patchOperation(ctx, item, current, { phase: 'Configuring', progress: 10, message: '저장소와 접근 정책의 현재 상태를 검증하고 있습니다.' });
    const configurationPlan = await observabilityConfigurationPlan(ctx, desired);
    if (!configurationPlan.live.installed) throw Object.assign(new Error('Shared Observability가 설치되지 않았습니다. 먼저 설치하십시오.'), { code: 409 });
    if (configurationPlan.blockers.length) throw Object.assign(new Error(configurationPlan.blockers.join(' ')), { code: 409 });
    if (configurationPlan.requiresDataReset && !dataReset) {
      throw Object.assign(new Error(`데이터 재배치 승인이 필요합니다: ${configurationPlan.resetTargets.join('; ')}`), { code: 409 });
    }
    if (configurationPlan.requiresDataReset) {
      current = await patchOperation(ctx, item, current, {
        phase: 'Migrating',
        progress: 25,
        message: '명시적 승인에 따라 기존 관측 데이터 PVC를 제거하고 새 저장소에 재배치하고 있습니다.',
      });
      const deleted = await resetObservabilityData(ctx, item, current, configurationPlan.live);
      current = await patchOperation(ctx, item, current, {
        phase: 'Configuring',
        progress: 45,
        message: `기존 PVC ${deleted.length}개를 제거했습니다. 새 운영 구성을 적용합니다.`,
      });
    } else if (configurationPlan.resizeTargets.length) {
      current = await patchOperation(ctx, item, current, {
        phase: 'Configuring',
        progress: 35,
        message: `온라인 확장을 지원하는 PVC ${configurationPlan.resizeTargets.length}개를 증설하고 있습니다.`,
      });
      await resizeObservabilityPvcs(ctx, configurationPlan.resizeTargets);
    }
    const variant = await clusterVariant(ctx);
    current = await patchOperation(ctx, item, current, {
      phase: 'Configuring',
      progress: 55,
      message: `Helm revision에 저장소·보존·Grafana ${desired.grafana.exposureMode} 정책을 적용하고 있습니다.`,
      clusterVariant: variant,
    });
    const args = ['upgrade', '--install', item.release, item.chart, '--namespace', item.namespace, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5', ...helmArgs(item, variant)];
    const out = await commandWithHeartbeat(ctx, item, current, args, desired);
    current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: '구성요소, PVC, NetworkPolicy와 외부 노출 정책을 재검증하고 있습니다.' });
    const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready');
    if (check.state !== 'Ready') throw Object.assign(new Error(`운영 구성 적용 후 검증 실패: ${check.message}`), { code: 502 });
    const after = await observabilityConfigurationPlan(ctx, desired);
    if (after.blockers.length) throw Object.assign(new Error(`적용 후 정책 검증 실패: ${after.blockers.join(' ')}`), { code: 502 });
    await writeObservabilityConfig(ctx, actor, desired, operation.reason);
    await auditRequired(ctx, actor, 'HISObservabilityConfigured', item, operation.reason, `success:${desired.grafana.exposureMode}`);
    await ctx.publishNotify({
      userActor: actor.username,
      action: 'HISObservabilityConfigured',
      target: `HIS/${item.id}`,
      result: 'success',
      reason: `${operation.reason} · exposure=${desired.grafana.exposureMode} · dataReset=${dataReset}`,
    });
    await patchOperation(ctx, item, current, {
      phase: 'Ready',
      progress: 100,
      message: `운영 구성이 적용되었습니다. Grafana ${desired.grafana.exposureMode}, Prometheus ${desired.prometheus.retention}, NetworkPolicy 3개 관리 중입니다.`,
      output: out.stdout.slice(-4000),
      error: '',
    });
  } catch (error) {
    const message = safeError(error);
    try { await auditRequired(ctx, actor, 'HISObservabilityConfigureFailed', item, operation.reason, message); }
    catch (auditError) { console.error(`[his-operation] configuration failure audit unavailable id=${operation.id}: ${safeError(auditError)}`); }
    try {
      await ctx.publishNotify({ userActor: actor.username, action: 'HISObservabilityConfigureFailed', target: `HIS/${item.id}`, result: 'error', reason: `${operation.reason} · ${message}` });
    } catch { /* best effort notification */ }
    await patchOperation(ctx, item, current, { phase: 'Failed', progress: 100, message: 'Observability 운영 구성 적용에 실패했습니다.', error: message });
  }
}

async function executeOperation(ctx, actor, item, operation) {
  let current = operation;
  try {
    if (operation.action === 'install' || operation.action === 'upgrade' || operation.action === 'recover') {
      const upgrading = operation.action === 'upgrade';
      const recovering = operation.action === 'recover';
      const actionLabel = recovering ? '복구' : upgrading ? '업그레이드' : '설치';
      current = await patchOperation(ctx, item, current, { phase: recovering ? 'Recovering' : upgrading ? 'Upgrading' : 'Installing', progress: 10, message: `${actionLabel} 전 상태를 확인하고 있습니다.` });
      const before = await itemStatus(ctx, item);
      const lifecycleAction = releaseLifecycleAction(before.release);
      if (lifecycleAction !== operation.action) {
        throw Object.assign(new Error(`현재 Helm release 상태에서는 ${actionLabel} 작업을 실행할 수 없습니다. 허용 작업: ${lifecycleAction}`), { code: 409 });
      }
      if (before.check.state === 'Ready' && !before.release?.managed) {
        throw Object.assign(new Error('호스트 또는 외부 관리자가 제공한 capability입니다. Cluster Manager가 덮어쓰지 않습니다.'), { code: 409 });
      }
      const componentPresent = (before.check.details?.components || []).some((component) => component.resourceName);
      if (before.check.state === 'Degraded' && !before.release?.managed && componentPresent) {
        throw Object.assign(new Error('부분 설치 워크로드가 존재합니다. 충돌을 해소한 뒤 설치하십시오.'), { code: 409 });
      }
      if (recovering) current = await recoverStuckRelease(ctx, actor, item, current, before.release, before.check);
      const variant = await clusterVariant(ctx);
      current = await patchOperation(ctx, item, current, {
        phase: recovering ? 'Recovering' : upgrading ? 'Upgrading' : 'Installing',
        progress: 35,
        message: `Helm ${item.chartName} ${item.chartVersion} 고정 payload를 ${recovering ? '재조정' : upgrading ? '업그레이드' : '적용'}하고 Ready 상태를 기다리고 있습니다.`,
        clusterVariant: variant,
      });
      const managedValues = await managedValuesForItem(ctx, item);
      const args = ['upgrade', '--install', item.release, item.chart, '--namespace', item.namespace, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5', ...helmArgs(item, variant)];
      const out = await commandWithHeartbeat(ctx, item, current, args, managedValues);
      current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: 'Helm 적용이 완료되어 구성요소와 저장소를 검증하고 있습니다.' });
      // Ingress can be installed before cert-manager; that intermediate state
      // is allowed so the administrator can complete the ordered pair. A
      // cert-manager operation itself must finish with a Ready issuer chain.
      const acceptableDegraded = new Set(['IngressTlsPolicyMissing']);
      const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready' || acceptableDegraded.has(value.reason));
      if (check.state !== 'Ready' && !acceptableDegraded.has(check.reason)) throw Object.assign(new Error(`${actionLabel} 후 검증 실패: ${check.message}`), { code: 502 });
      const auditAction = recovering ? 'HISRecovered' : upgrading ? 'HISUpgraded' : 'HISInstalled';
      await auditRequired(ctx, actor, auditAction, item, operation.reason, `success:${check.state}:${check.reason}`);
      await ctx.publishNotify({ userActor: actor.username, action: auditAction, target: `HIS/${item.id}`, result: check.state, reason: `${operation.reason} · ${check.message}` });
      current = await patchOperation(ctx, item, current, {
        phase: 'Ready',
        progress: 100,
        message: check.message,
        output: out.stdout.slice(-4000),
        error: '',
      });
      return;
    }

    if (operation.action === 'rollback') {
      const targetRevision = Number(operation.targetRevision || 0);
      current = await patchOperation(ctx, item, current, { phase: 'RollingBack', progress: 20, message: `Helm revision ${targetRevision}으로 롤백하고 있습니다.` });
      const out = await commandWithHeartbeat(ctx, item, current, ['rollback', item.release, String(targetRevision), '--namespace', item.namespace, '--wait', '--cleanup-on-fail', '--timeout', '10m']);
      current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: '롤백된 revision의 구성요소와 서비스 경로를 재검증하고 있습니다.' });
      const acceptableDegraded = new Set(['IssuerMissing', 'IngressTlsPolicyMissing']);
      const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready' || acceptableDegraded.has(value.reason));
      if (check.state !== 'Ready' && !acceptableDegraded.has(check.reason)) throw Object.assign(new Error(`롤백 후 검증 실패: ${check.message}`), { code: 502 });
      await auditRequired(ctx, actor, 'HISRolledBack', item, operation.reason, `success:revision=${targetRevision}:${check.state}`);
      await ctx.publishNotify({ userActor: actor.username, action: 'HISRolledBack', target: `HIS/${item.id}`, result: check.state, reason: `${operation.reason} · revision=${targetRevision} · ${check.message}` });
      await patchOperation(ctx, item, current, { phase: 'Ready', progress: 100, message: `revision ${targetRevision} 롤백과 검증이 완료되었습니다. ${check.message}`, output: out.stdout.slice(-4000), error: '' });
      return;
    }

    current = await patchOperation(ctx, item, current, { phase: 'Uninstalling', progress: 25, message: 'Helm release와 관리 리소스를 삭제하고 있습니다.' });
    const out = await commandWithHeartbeat(ctx, item, current, ['uninstall', item.release, '--namespace', item.namespace, '--wait', '--timeout', '10m']);
    current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: '삭제 결과와 보존 리소스를 검증하고 있습니다.' });
    const check = await waitForProbe(ctx, item, (value) => value.state !== 'Ready', 60000);
    await auditRequired(ctx, actor, 'HISUninstalled', item, operation.reason, 'success');
    await ctx.publishNotify({ userActor: actor.username, action: 'HISUninstalled', target: `HIS/${item.id}`, result: 'success', reason: `${operation.reason} · retained=${(item.retainedOnDelete || []).join(',') || 'none'}` });
    await patchOperation(ctx, item, current, {
      phase: 'Removed',
      progress: 100,
      message: `삭제가 완료되었습니다. 보존: ${(item.retainedOnDelete || []).join(', ') || '없음'}`,
      output: out.stdout.slice(-4000),
      error: '',
      check,
    });
  } catch (error) {
    const message = safeError(error);
    let release = null;
    try { release = await helmStatus(ctx, item); } catch { /* retain the primary failure */ }
    const phase = release?.status === 'uninstalling' ? 'RollbackStalled' : 'Failed';
    const failureAction = operation.action === 'install' ? 'HISInstallFailed'
      : operation.action === 'upgrade' ? 'HISUpgradeFailed'
        : operation.action === 'recover' ? 'HISRecoveryFailed'
        : operation.action === 'rollback' ? 'HISRollbackFailed' : 'HISUninstallFailed';
    try { await auditRequired(ctx, actor, failureAction, item, operation.reason, message); }
    catch (auditError) { console.error(`[his-operation] failure audit unavailable id=${operation.id}: ${safeError(auditError)}`); }
    try {
      await ctx.publishNotify({ userActor: actor.username, action: failureAction, target: `HIS/${item.id}`, result: 'error', reason: `${operation.reason} · ${message}` });
    } catch { /* best effort notification */ }
    await patchOperation(ctx, item, current, {
      phase,
      progress: 100,
      message: phase === 'RollbackStalled' ? '설치 실패 후 Helm 롤백이 완료되지 않았습니다.' : 'HIS 작업이 실패했습니다.',
      error: message,
      releaseStatus: release?.status || 'unknown',
    });
  }
}

function createHisManager(ctx) {
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/his/')) return false;
    try {
      if (req.method === 'GET' && pathname === '/api/his/status') {
        await actorFor(ctx, req, false);
        return ctx.jsonRes(res, 200, await allStatus(ctx)), true;
      }
      if (req.method === 'GET' && pathname === '/api/his/observability/config') {
        await actorFor(ctx, req, false);
        return ctx.jsonRes(res, 200, await observabilityConfiguration(ctx)), true;
      }
      if (req.method !== 'POST') throw Object.assign(new Error('method not allowed'), { code: 405 });
      const body = await readJson(req);
      const actor = await actorFor(ctx, req, true);
      if (pathname === '/api/his/profiles') {
        return ctx.jsonRes(res, 200, await setProfileSelection(ctx, actor, body)), true;
      }
      if (pathname === '/api/his/validate') {
        const item = catalogItem(String(body?.id || ''));
        if (!item || !['cluster-network', 'cluster-dns', OBSERVABILITY_ITEM_ID, 'storage', 'csi-snapshot'].includes(item.id)) throw Object.assign(new Error('실검증을 지원하지 않는 HIS 항목입니다.'), { code: 404 });
        const reason = reasonFrom(body);
        await auditRequired(ctx, actor, 'HISCanaryValidationRequested', item, reason, 'requested');
        const operation = await createOperation(ctx, item, actor, 'validate', reason);
        ctx.jsonRes(res, 202, { ok: true, operation });
        setImmediate(() => { void executeCanaryValidation(ctx, actor, item, operation); });
        return true;
      }
      const item = assertManagedItem(body);

      if (pathname === '/api/his/plan') {
        return ctx.jsonRes(res, 200, await plan(ctx, item)), true;
      }
      if (pathname === '/api/his/observability/plan') {
        if (item.id !== OBSERVABILITY_ITEM_ID) throw Object.assign(new Error('Observability 항목만 운영 구성을 지원합니다.'), { code: 400 });
        return ctx.jsonRes(res, 200, await observabilityConfigurationPlan(ctx, body.config)), true;
      }
      if (pathname === '/api/his/observability/configure') {
        if (item.id !== OBSERVABILITY_ITEM_ID) throw Object.assign(new Error('Observability 항목만 운영 구성을 지원합니다.'), { code: 400 });
        const reason = reasonFrom(body);
        const desired = validateObservabilityConfig(body.config);
        const configurationPlan = await observabilityConfigurationPlan(ctx, desired);
        if (!configurationPlan.live.installed) throw Object.assign(new Error('Shared Observability가 설치되지 않았습니다.'), { code: 409 });
        if (configurationPlan.blockers.length) throw Object.assign(new Error(configurationPlan.blockers.join(' ')), { code: 409 });
        const dataReset = Boolean(body.resetData);
        if (configurationPlan.requiresDataReset && (!dataReset || String(body.resetConfirmation || '') !== OBSERVABILITY_RESET_CONFIRMATION)) {
          throw Object.assign(new Error(`데이터 재배치를 승인하려면 '${OBSERVABILITY_RESET_CONFIRMATION}'를 입력해야 합니다.`), { code: 400 });
        }
        if (desired.grafana.exposureMode === 'PublicIngress' && String(body.publicConfirmation || '') !== OBSERVABILITY_PUBLIC_CONFIRMATION) {
          throw Object.assign(new Error(`Public Grafana를 승인하려면 '${OBSERVABILITY_PUBLIC_CONFIRMATION}'를 입력해야 합니다.`), { code: 400 });
        }
        const release = await helmStatus(ctx, item);
        if (!release?.managed) throw Object.assign(new Error('Cluster Manager가 설치한 Shared Observability만 재구성할 수 있습니다.'), { code: 409 });
        await auditRequired(ctx, actor, 'HISObservabilityConfigureRequested', item, reason, `requested:${desired.grafana.exposureMode}:reset=${dataReset}`);
        const operation = await createOperation(ctx, item, actor, 'configure', reason);
        ctx.jsonRes(res, 202, { ok: true, operation });
        setImmediate(() => { void executeObservabilityConfiguration(ctx, actor, item, operation, desired, dataReset); });
        return true;
      }

      const reason = reasonFrom(body);
      const action = pathname === '/api/his/install' ? 'install'
        : pathname === '/api/his/upgrade' ? 'upgrade'
          : pathname === '/api/his/recover' ? 'recover'
            : pathname === '/api/his/rollback' ? 'rollback'
              : pathname === '/api/his/uninstall' ? 'uninstall' : '';
      if (!action) throw Object.assign(new Error('not found'), { code: 404 });
      let operationExtra = {};
      const release = await helmStatus(ctx, item);
      const lifecycleAction = releaseLifecycleAction(release);
      if (action === 'install' && lifecycleAction !== 'install') {
        throw Object.assign(new Error(`이미 Helm release가 존재합니다. 현재 허용 작업: ${lifecycleAction}`), { code: 409 });
      }
      if (action === 'upgrade' && lifecycleAction !== 'upgrade') {
        throw Object.assign(new Error(`정상 배포된 Helm release만 업그레이드할 수 있습니다. 현재 허용 작업: ${lifecycleAction}`), { code: 409 });
      }
      if (action === 'recover' && lifecycleAction !== 'recover') {
        throw Object.assign(new Error(`실패하거나 중단된 Helm release만 복구할 수 있습니다. 현재 허용 작업: ${lifecycleAction}`), { code: 409 });
      }
      if ((action === 'rollback' && lifecycleAction !== 'upgrade') || (action === 'uninstall' && !release?.managed)) {
        throw Object.assign(new Error('Cluster Manager가 정상 관리 중인 Helm release만 이 작업을 실행할 수 있습니다.'), { code: 409 });
      }
      if (action === 'uninstall') {
        if (String(body.confirm || '') !== item.id) throw Object.assign(new Error(`삭제 확인 값으로 '${item.id}'를 입력해야 합니다.`), { code: 400 });
      }
      if (action === 'rollback') {
        const targetRevision = Number(body.revision || 0);
        const history = await helmHistory(ctx, item);
        if (!Number.isInteger(targetRevision) || targetRevision < 1 || targetRevision >= Number(release?.revision || 0) || !history.some((entry) => entry.revision === targetRevision)) {
          throw Object.assign(new Error('현재 revision보다 작은 유효한 Helm history revision을 선택해야 합니다.'), { code: 400 });
        }
        const expected = `${item.id}:${targetRevision}`;
        if (String(body.confirm || '') !== expected) throw Object.assign(new Error(`롤백 확인 값으로 '${expected}'를 입력해야 합니다.`), { code: 400 });
        operationExtra = { targetRevision };
      }
      const requestedAction = action === 'install' ? 'HISInstallRequested'
        : action === 'upgrade' ? 'HISUpgradeRequested'
          : action === 'recover' ? 'HISRecoveryRequested'
            : action === 'rollback' ? 'HISRollbackRequested' : 'HISUninstallRequested';
      await auditRequired(ctx, actor, requestedAction, item, reason, action === 'rollback' ? `requested:revision=${operationExtra.targetRevision}` : 'requested');
      const operation = await createOperation(ctx, item, actor, action, reason, operationExtra);
      ctx.jsonRes(res, 202, { ok: true, operation });
      setImmediate(() => { void executeOperation(ctx, actor, item, operation); });
      return true;
    } catch (error) {
      ctx.jsonRes(res, Number(error.code) >= 400 ? Number(error.code) : 500, { error: safeError(error) });
      return true;
    }
  };
}

module.exports = {
  createHisManager,
  allStatus,
  itemStatus,
  readJson,
  reasonFrom,
  safeError,
  command,
  withKubeconfig,
  k8s,
  k8sRequest,
  kubeconfigText,
  auditRequired,
  operationResourceName,
  operationActive,
  parseKubernetesVersion,
  compareVersions,
  kubernetesVersionSupported,
  diagnosticDetails,
  evaluateStorageContract,
  validationCanaryName,
  applyValidationOperation,
  gateValidationReadiness,
  runtimeContractFingerprint,
  storageContractFingerprint,
  snapshotContractFingerprint,
  syntheticPod,
  syntheticService,
  syntheticDenyPolicy,
  canaryPvc,
  canaryPod,
  renderedResources,
  recoverableHelmCleanupError,
  stuckReleaseRecoveryStrategy,
  releaseLifecycleAction,
  ingressDefaultCertificateRef,
  evaluateProfiles,
  evaluateStackStatus,
  validateObservabilityConfig,
  observabilityValues,
  observabilityPvcComponent,
  flattenConfiguration,
  DEFAULT_OBSERVABILITY_CONFIG,
  OBSERVABILITY_RESET_CONFIRMATION,
  OBSERVABILITY_PUBLIC_CONFIRMATION,
};
