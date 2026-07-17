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

function condition(resource, type) {
  return (resource?.status?.conditions || []).find((item) => item.type === type);
}

function containerImages(resource) {
  return (resource?.spec?.template?.spec?.containers || []).map((item) => item.image).filter(Boolean).join(', ');
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
      ],
    });
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
    const rows = controllerServices.map((service) => ({ name: service.metadata?.name || '', type: service.spec?.type || 'ClusterIP', clusterIP: service.spec?.clusterIP || '', external: addressOfService(service) || 'None', listeners: (service.spec?.ports || []).map((port) => `${port.name || ''}:${port.port}->${port.targetPort}`).join(', ') }));
    const externallyExposed = rows.some((row) => ['LoadBalancer', 'NodePort'].includes(row.type));
    const details = diagnosticDetails({
      facts: [
        { label: 'IngressClass', value: classItems.map((item) => `${item.metadata?.name} (${item.spec?.controller})`).join(', ') || 'Missing', state: classItems.length ? 'Passed' : 'Failed' },
        { label: 'Controller', value: controller ? `${controller.status?.availableReplicas || 0}/${controller.spec?.replicas || 1}` : 'Missing', state: controller && availableDeployment(controller) ? 'Passed' : 'Failed' },
        { label: 'Ready endpoints', value: String(readyEndpoints), state: readyEndpoints ? 'Passed' : 'Failed' },
        { label: 'TLS Ingress references', value: `${tlsIngresses}/${ingresses.items?.length || 0}`, state: 'Info' },
      ],
      tables: [{ title: 'Ingress service exposure', columns: [{ key: 'name', label: 'Service' }, { key: 'type', label: 'Type' }, { key: 'clusterIP', label: 'Cluster IP' }, { key: 'external', label: 'External address' }, { key: 'listeners', label: 'Listeners' }], rows }],
      warnings: externallyExposed && !tlsIngresses ? ['외부 listener가 있으나 TLS를 참조하는 Ingress가 없습니다.'] : [],
      security: [externallyExposed ? '외부 진입 경로 존재: TLS·OIDC·allowlist 정책을 서비스별로 검증하십시오.' : 'ClusterIP 내부 경로만 발견'],
      canaries: [{ name: 'Controller endpoint', state: readyEndpoints ? 'Passed' : 'Failed', message: `${readyEndpoints}개 ready endpoint` }, { name: 'Host/TLS reachability', state: 'NotRun', message: '실제 hostname과 승인된 인증서가 필요한 on-demand 검증' }],
    });
    if (!classItems.length || !controller || !availableDeployment(controller) || !readyEndpoints) return result('Blocked', 'IngressControlMissing', 'IngressClass·controller·endpoint 계약이 준비되지 않았습니다.', containerImages(controller), details);
    if (externallyExposed && !tlsIngresses) return result('Degraded', 'IngressTlsPolicyMissing', 'Controller는 Ready이나 외부 listener에 TLS 참조가 없습니다.', containerImages(controller), details);
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
    const [list, pvcs, pvs] = await Promise.all([
      k8s(ctx, '/apis/storage.k8s.io/v1/storageclasses'),
      k8sListOrEmpty(ctx, '/api/v1/persistentvolumeclaims'),
      k8sListOrEmpty(ctx, '/api/v1/persistentvolumes'),
    ]);
    const items = list.items || [];
    const defaults = items.filter((x) => x.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
    const rows = items.map((item) => ({ name: item.metadata?.name || '', default: defaults.includes(item) ? 'Yes' : 'No', provisioner: item.provisioner || '', binding: item.volumeBindingMode || 'Immediate', expansion: item.allowVolumeExpansion ? 'Yes' : 'No', reclaim: item.reclaimPolicy || 'Delete', parameters: Object.entries(item.parameters || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'None' }));
    const pendingPvcs = (pvcs.items || []).filter((pvc) => pvc.status?.phase !== 'Bound');
    const localDelete = rows.filter((row) => /local-path|hostpath/i.test(row.provisioner) && row.reclaim === 'Delete');
    const details = diagnosticDetails({
      facts: [
        { label: 'StorageClasses', value: String(items.length), state: items.length ? 'Passed' : 'Failed' },
        { label: 'Default class', value: defaults.map((item) => item.metadata?.name).join(', ') || 'Missing', state: defaults.length === 1 ? 'Passed' : 'Failed' },
        { label: 'PVC Bound', value: `${(pvcs.items?.length || 0) - pendingPvcs.length}/${pvcs.items?.length || 0}`, state: pendingPvcs.length ? 'Failed' : 'Passed' },
        { label: 'PersistentVolumes', value: String(pvs.items?.length || 0), state: 'Info' },
      ],
      tables: [{ title: 'StorageClass capability matrix', columns: [{ key: 'name', label: 'StorageClass' }, { key: 'default', label: 'Default' }, { key: 'provisioner', label: 'Provisioner' }, { key: 'binding', label: 'Binding' }, { key: 'expansion', label: 'Expansion' }, { key: 'reclaim', label: 'Reclaim' }, { key: 'parameters', label: 'Parameters' }], rows }],
      warnings: [
        ...localDelete.map((row) => `${row.name}: 노드 로컬 저장소 + reclaim Delete는 운영 내구 저장소로 권장하지 않습니다.`),
        ...pendingPvcs.map((pvc) => `${pvc.metadata?.namespace}/${pvc.metadata?.name}: ${pvc.status?.phase || 'Pending'}`),
      ],
      security: ['StorageClass 변경은 기존 PVC spec을 변경하지 않습니다. class migration은 명시적 데이터 재배치가 필요합니다.'],
      canaries: [{ name: 'PVC inventory', state: pendingPvcs.length ? 'Failed' : 'Passed', message: `${pendingPvcs.length}개 unbound PVC` }, { name: 'Dynamic provision/bind', state: 'NotRun', message: '승인된 on-demand PVC canary가 필요합니다.' }],
    });
    if (!items.length) return result('Blocked', 'StorageClassMissing', 'StorageClass가 없습니다.', '', details);
    if (defaults.length !== 1 || pendingPvcs.length) return result('Degraded', defaults.length ? 'StorageContractDegraded' : 'DefaultStorageClassMissing', `StorageClass ${items.length}개, 기본값 ${defaults.length}개, unbound PVC ${pendingPvcs.length}개입니다.`, defaults[0]?.provisioner || items[0]?.provisioner || '', details);
    return result('Ready', 'StorageClassReady', `기본 StorageClass ${defaults[0].metadata.name}와 PVC ${(pvcs.items?.length || 0) - pendingPvcs.length}/${pvcs.items?.length || 0}개가 준비되었습니다.`, defaults[0].provisioner || '', details);
  }
  if (name === 'snapshot') {
    const [drivers, classes, crds, deployments, snapshots] = await Promise.all([
      k8sListOrEmpty(ctx, '/apis/storage.k8s.io/v1/csidrivers'),
      k8sListOrEmpty(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses'),
      k8sListOrEmpty(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
      k8sListOrEmpty(ctx, '/apis/apps/v1/deployments'),
      k8sListOrEmpty(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshots'),
    ]);
    const driverItems = drivers.items || [];
    const classItems = classes.items || [];
    const snapshotCrds = (crds.items || []).filter((item) => item.spec?.group === 'snapshot.storage.k8s.io');
    const controllers = (deployments.items || []).filter((item) => /snapshot-controller|csi.*controller/i.test(item.metadata?.name || ''));
    const rows = driverItems.map((item) => ({ name: item.metadata?.name || '', attachRequired: String(item.spec?.attachRequired ?? true), podInfo: String(item.spec?.podInfoOnMount ?? false), fsGroupPolicy: item.spec?.fsGroupPolicy || '', modes: (item.spec?.volumeLifecycleModes || []).join(', '), tokenRequests: String(item.spec?.tokenRequests?.length || 0) }));
    const details = diagnosticDetails({
      facts: [
        { label: 'CSI drivers', value: String(driverItems.length), state: driverItems.length ? 'Passed' : 'Failed' },
        { label: 'Snapshot CRDs', value: `${snapshotCrds.length}/3`, state: snapshotCrds.length >= 3 ? 'Passed' : 'Failed' },
        { label: 'Snapshot classes', value: String(classItems.length), state: classItems.length ? 'Passed' : 'Failed' },
        { label: 'Controller deployments', value: `${controllers.filter(availableDeployment).length}/${controllers.length}`, state: controllers.length && controllers.every(availableDeployment) ? 'Passed' : 'Failed' },
        { label: 'VolumeSnapshots', value: String(snapshots.items?.length || 0), state: 'Info' },
      ],
      tables: [
        { title: 'CSI driver capabilities', columns: [{ key: 'name', label: 'Driver' }, { key: 'attachRequired', label: 'Attach' }, { key: 'podInfo', label: 'Pod info' }, { key: 'fsGroupPolicy', label: 'FSGroup' }, { key: 'modes', label: 'Lifecycle modes' }, { key: 'tokenRequests', label: 'Token requests' }], rows },
        { title: 'VolumeSnapshotClass mapping', columns: [{ key: 'name', label: 'Class' }, { key: 'driver', label: 'Driver' }, { key: 'deletionPolicy', label: 'Deletion policy' }], rows: classItems.map((item) => ({ name: item.metadata?.name || '', driver: item.driver || '', deletionPolicy: item.deletionPolicy || '' })) },
      ],
      warnings: !driverItems.length ? ['호스트가 CSI driver를 제공하지 않습니다. local-path provisioner만으로 snapshot을 제공할 수 없습니다.'] : !classItems.length ? ['CSI driver는 있으나 VolumeSnapshotClass가 없습니다.'] : [],
      security: ['Snapshot deletionPolicy와 restore 대상 StorageClass는 데이터 보존·암호화 정책과 함께 승인해야 합니다.'],
      canaries: [{ name: 'Snapshot API contract', state: driverItems.length && classItems.length && snapshotCrds.length >= 3 ? 'Passed' : 'Failed', message: `${driverItems.length} drivers · ${classItems.length} classes · ${snapshotCrds.length} CRDs` }, { name: 'Snapshot → restore', state: 'NotRun', message: '승인된 on-demand 데이터 보호 canary가 필요합니다.' }],
    });
    const complete = driverItems.length && classItems.length && snapshotCrds.length >= 3 && controllers.length && controllers.every(availableDeployment);
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
        : action === 'rollback' ? `revision ${extra.targetRevision || ''} 롤백 작업이 대기열에 등록되었습니다.`
          : action === 'configure' ? '운영 구성 변경이 대기열에 등록되었습니다.' : '삭제 작업이 대기열에 등록되었습니다.',
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
    const enrichedCheck = {
      ...check,
      details: {
        ...(check.details || {}),
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

async function allStatus(ctx) {
  const items = [];
  for (const item of HIS_CATALOG) items.push(await itemStatus(ctx, item));
  const required = items.filter((item) => item.required);
  const state = required.some((item) => item.check.state === 'Blocked')
    ? 'Blocked'
    : required.some((item) => item.check.state === 'Degraded') ? 'Degraded' : 'Ready';
  return { stack: 'HIS', state, checkedAt: new Date().toISOString(), items };
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
    if (operation.action === 'install' || operation.action === 'upgrade') {
      const upgrading = operation.action === 'upgrade';
      current = await patchOperation(ctx, item, current, { phase: upgrading ? 'Upgrading' : 'Installing', progress: 10, message: `${upgrading ? '업그레이드' : '설치'} 전 상태를 확인하고 있습니다.` });
      const before = await itemStatus(ctx, item);
      if (upgrading && !before.release?.managed) {
        throw Object.assign(new Error('Cluster Manager가 소유한 Helm release만 업그레이드할 수 있습니다.'), { code: 409 });
      }
      if (before.check.state === 'Ready' && !before.release?.managed) {
        throw Object.assign(new Error('호스트 또는 외부 관리자가 제공한 capability입니다. Cluster Manager가 덮어쓰지 않습니다.'), { code: 409 });
      }
      const componentPresent = (before.check.details?.components || []).some((component) => component.resourceName);
      if (before.check.state === 'Degraded' && !before.release?.managed && componentPresent) {
        throw Object.assign(new Error('부분 설치 워크로드가 존재합니다. 충돌을 해소한 뒤 설치하십시오.'), { code: 409 });
      }
      current = await recoverStuckRelease(ctx, actor, item, current, before.release, before.check);
      const variant = await clusterVariant(ctx);
      current = await patchOperation(ctx, item, current, {
        phase: upgrading ? 'Upgrading' : 'Installing',
        progress: 35,
        message: `Helm ${item.chartName} ${item.chartVersion} 고정 payload를 ${upgrading ? '업그레이드' : '적용'}하고 Ready 상태를 기다리고 있습니다.`,
        clusterVariant: variant,
      });
      const managedValues = await managedValuesForItem(ctx, item);
      const args = ['upgrade', '--install', item.release, item.chart, '--namespace', item.namespace, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5', ...helmArgs(item, variant)];
      const out = await commandWithHeartbeat(ctx, item, current, args, managedValues);
      current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: 'Helm 적용이 완료되어 구성요소와 저장소를 검증하고 있습니다.' });
      const acceptableDegraded = new Set(['IssuerMissing', 'IngressTlsPolicyMissing']);
      const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready' || acceptableDegraded.has(value.reason));
      if (check.state !== 'Ready' && !acceptableDegraded.has(check.reason)) throw Object.assign(new Error(`${upgrading ? '업그레이드' : '설치'} 후 검증 실패: ${check.message}`), { code: 502 });
      const auditAction = upgrading ? 'HISUpgraded' : 'HISInstalled';
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
          : pathname === '/api/his/rollback' ? 'rollback'
            : pathname === '/api/his/uninstall' ? 'uninstall' : '';
      if (!action) throw Object.assign(new Error('not found'), { code: 404 });
      let operationExtra = {};
      if (action === 'uninstall' || action === 'upgrade' || action === 'rollback') {
        const release = await helmStatus(ctx, item);
        if (!release?.managed) throw Object.assign(new Error('Cluster Manager가 설치한 Helm release만 변경할 수 있습니다.'), { code: 409 });
      }
      if (action === 'uninstall') {
        if (String(body.confirm || '') !== item.id) throw Object.assign(new Error(`삭제 확인 값으로 '${item.id}'를 입력해야 합니다.`), { code: 400 });
      }
      if (action === 'rollback') {
        const targetRevision = Number(body.revision || 0);
        const release = await helmStatus(ctx, item);
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
  renderedResources,
  recoverableHelmCleanupError,
  stuckReleaseRecoveryStrategy,
  validateObservabilityConfig,
  observabilityValues,
  observabilityPvcComponent,
  flattenConfiguration,
  DEFAULT_OBSERVABILITY_CONFIG,
  OBSERVABILITY_RESET_CONFIRMATION,
  OBSERVABILITY_PUBLIC_CONFIRMATION,
};
