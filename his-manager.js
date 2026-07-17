'use strict';

const fs = require('fs');
const os = require('os');
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
const ACTIVE_OPERATION_PHASES = new Set(['Queued', 'Recovering', 'Installing', 'Validating', 'Uninstalling']);

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
  try { return await callback(env); }
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

async function probe(ctx, name) {
  if (name === 'kubernetesApi') {
    const version = await k8s(ctx, '/version');
    return result('Ready', 'ApiReachable', 'Kubernetes API가 응답합니다.', version.gitVersion || '');
  }
  if (name === 'nodes') {
    const list = await k8s(ctx, '/api/v1/nodes');
    const nodes = list.items || [];
    const ready = nodes.filter((node) => (node.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'));
    return ready.length === nodes.length && nodes.length
      ? result('Ready', 'NodesReady', `${ready.length}/${nodes.length}개 노드가 Ready입니다.`, nodes[0]?.status?.nodeInfo?.kubeletVersion || '')
      : result('Blocked', 'NodeNotReady', `${ready.length}/${nodes.length}개 노드만 Ready입니다.`);
  }
  if (name === 'cni') {
    const list = await k8s(ctx, '/apis/apps/v1/namespaces/kube-system/daemonsets');
    const candidates = (list.items || []).filter((ds) => /kindnet|calico|cilium|weave|flannel|canal|antrea/i.test(ds.metadata?.name || ''));
    const ready = candidates.find(readyDaemonSet);
    return ready
      ? result('Ready', 'CniReady', `${ready.metadata.name} CNI가 모든 대상 노드에서 Ready입니다.`, ready.metadata?.labels?.['app.kubernetes.io/version'] || '')
      : result('Blocked', 'CniMissing', 'Ready 상태의 CNI DaemonSet을 찾지 못했습니다.');
  }
  if (name === 'dns') {
    const deployments = await k8s(ctx, '/apis/apps/v1/namespaces/kube-system/deployments');
    const services = await k8s(ctx, '/api/v1/namespaces/kube-system/services');
    const dns = (deployments.items || []).find((d) => /coredns|kube-dns/i.test(d.metadata?.name || ''));
    const svc = (services.items || []).find((s) => /kube-dns|coredns/i.test(s.metadata?.name || ''));
    return dns && svc && availableDeployment(dns)
      ? result('Ready', 'DnsReady', `${dns.metadata.name} Deployment와 ${svc.metadata.name} Service가 Ready입니다.`, dns.spec?.template?.spec?.containers?.[0]?.image || '')
      : result('Blocked', 'DnsMissing', '호환 DNS Deployment 또는 Service가 준비되지 않았습니다.');
  }
  if (name === 'ingress') {
    const list = await k8s(ctx, '/apis/networking.k8s.io/v1/ingressclasses');
    const items = list.items || [];
    return items.length
      ? result('Ready', 'IngressClassReady', `IngressClass ${items.map((x) => x.metadata?.name).join(', ')}가 준비되었습니다.`, items[0]?.spec?.controller || '')
      : result('Blocked', 'IngressClassMissing', 'IngressClass가 없습니다. 승인된 Ingress Controller를 설치하십시오.');
  }
  if (name === 'certManager') {
    let crd = false;
    try { await k8s(ctx, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/certificates.cert-manager.io'); crd = true; } catch (e) { if (e.code !== 404) throw e; }
    let deployments = [];
    try { deployments = (await k8s(ctx, '/apis/apps/v1/namespaces/cert-manager/deployments')).items || []; } catch (e) { if (e.code !== 404) throw e; }
    const allReady = deployments.length >= 3 && deployments.every(availableDeployment);
    if (crd && allReady) return result('Ready', 'CertManagerReady', 'cert-manager CRD와 제어기가 Ready입니다.', deployments[0]?.spec?.template?.spec?.containers?.[0]?.image || '');
    if (crd || deployments.length) return result('Degraded', 'CertManagerPartial', 'cert-manager 일부 리소스만 존재합니다. 충돌 여부를 먼저 점검하십시오.');
    return result('Blocked', 'CertManagerMissing', 'cert-manager capability가 없습니다.');
  }
  if (name === 'metrics') {
    try {
      const api = await k8s(ctx, '/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io');
      const ready = (api.status?.conditions || []).some((c) => c.type === 'Available' && c.status === 'True');
      return ready
        ? result('Ready', 'MetricsApiReady', 'metrics.k8s.io APIService가 Available입니다.', api.spec?.version || '')
        : result('Degraded', 'MetricsApiUnavailable', 'metrics.k8s.io APIService가 존재하지만 Available이 아닙니다.');
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
    const list = await k8s(ctx, '/apis/storage.k8s.io/v1/storageclasses');
    const items = list.items || [];
    const defaults = items.filter((x) => x.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
    if (!items.length) return result('Blocked', 'StorageClassMissing', 'StorageClass가 없습니다.');
    return defaults.length
      ? result('Ready', 'StorageClassReady', `기본 StorageClass ${defaults[0].metadata.name}가 준비되었습니다.`, defaults[0].provisioner || '')
      : result('Degraded', 'DefaultStorageClassMissing', `${items.length}개 StorageClass가 있으나 기본값이 없습니다.`, items[0].provisioner || '');
  }
  if (name === 'snapshot') {
    const drivers = await k8s(ctx, '/apis/storage.k8s.io/v1/csidrivers');
    let classes = [];
    try { classes = (await k8s(ctx, '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses')).items || []; } catch (e) { if (e.code !== 404) throw e; }
    if ((drivers.items || []).length && classes.length) return result('Ready', 'SnapshotReady', 'CSI Driver와 VolumeSnapshotClass가 준비되었습니다.');
    if ((drivers.items || []).length) return result('Degraded', 'SnapshotClassMissing', 'CSI Driver는 있으나 VolumeSnapshotClass가 없습니다.');
    return result('Degraded', 'CsiDriverMissing', 'CSI Driver/VolumeSnapshot capability가 없습니다. 선택 profile에서 요구할 때 설치가 필요합니다.');
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

async function createOperation(ctx, item, actor, action, reason) {
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
    message: action === 'install' ? '설치 작업이 대기열에 등록되었습니다.' : '삭제 작업이 대기열에 등록되었습니다.',
    error: '',
    actor: actor.username,
    reason,
    worker: process.env.HOSTNAME || 'cluster-manager',
    startedAt: now,
    updatedAt: now,
    finishedAt: '',
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

async function recoverStuckRelease(ctx, actor, item, operation, release) {
  if (!release?.managed || !['uninstalling', 'failed', 'pending-install', 'pending-upgrade', 'pending-rollback'].includes(release.status)) {
    return operation;
  }
  operation = await patchOperation(ctx, item, operation, {
    phase: 'Recovering',
    progress: 15,
    message: `중단된 Helm release(${release.status})를 정리하고 있습니다.`,
  });
  await auditRequired(ctx, actor, 'HISRecoveryStarted', item, operation.reason, release.status);
  try {
    await withKubeconfig(ctx, (env) => command('helm', ['uninstall', item.release, '--namespace', item.namespace, '--no-hooks', '--wait', '--timeout', '2m'], { env, timeoutMs: 150000 }));
  } catch (error) {
    if (!/has no deployed releases|release: not found|not found/i.test(error.safeMessage || error.message || '')) throw error;
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
    return { ...item, check, release, operation, ownership, chart: undefined, values: undefined, kindValues: undefined };
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
  const args = ['template', item.release, item.chart, '--namespace', item.namespace, '--include-crds', ...helmArgs(item, variant)];
  const out = await withKubeconfig(ctx, (env) => command('helm', args, { env, timeoutMs: 120000 }));
  const resources = renderedResources(out.stdout, item.namespace);
  const byKind = resources.reduce((summary, resource) => {
    summary[resource.kind] = (summary[resource.kind] || 0) + 1;
    return summary;
  }, {});
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

async function commandWithHeartbeat(ctx, item, operation, args) {
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
    return await withKubeconfig(ctx, (env) => command('helm', args, { env }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeOperation(ctx, actor, item, operation) {
  let current = operation;
  try {
    if (operation.action === 'install') {
      current = await patchOperation(ctx, item, current, { phase: 'Installing', progress: 10, message: '설치 전 상태를 확인하고 있습니다.' });
      const before = await itemStatus(ctx, item);
      if (before.check.state === 'Ready' && !before.release?.managed) {
        throw Object.assign(new Error('호스트 또는 외부 관리자가 제공한 capability입니다. Cluster Manager가 덮어쓰지 않습니다.'), { code: 409 });
      }
      const componentPresent = (before.check.details?.components || []).some((component) => component.resourceName);
      if (before.check.state === 'Degraded' && !before.release?.managed && componentPresent) {
        throw Object.assign(new Error('부분 설치 워크로드가 존재합니다. 충돌을 해소한 뒤 설치하십시오.'), { code: 409 });
      }
      current = await recoverStuckRelease(ctx, actor, item, current, before.release);
      const variant = await clusterVariant(ctx);
      current = await patchOperation(ctx, item, current, {
        phase: 'Installing',
        progress: 35,
        message: `Helm ${item.chartName} ${item.chartVersion} 리소스를 적용하고 Ready 상태를 기다리고 있습니다.`,
        clusterVariant: variant,
      });
      const args = ['upgrade', '--install', item.release, item.chart, '--namespace', item.namespace, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5', ...helmArgs(item, variant)];
      const out = await commandWithHeartbeat(ctx, item, current, args);
      current = await patchOperation(ctx, item, current, { phase: 'Validating', progress: 88, message: 'Helm 적용이 완료되어 구성요소와 저장소를 검증하고 있습니다.' });
      const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready');
      if (check.state !== 'Ready') throw Object.assign(new Error(`설치 후 검증 실패: ${check.message}`), { code: 502 });
      await auditRequired(ctx, actor, 'HISInstalled', item, operation.reason, 'success');
      await ctx.publishNotify({ userActor: actor.username, action: 'HISInstalled', target: `HIS/${item.id}`, result: check.state, reason: `${operation.reason} · ${check.message}` });
      current = await patchOperation(ctx, item, current, {
        phase: 'Ready',
        progress: 100,
        message: check.message,
        output: out.stdout.slice(-4000),
        error: '',
      });
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
    try { await auditRequired(ctx, actor, operation.action === 'install' ? 'HISInstallFailed' : 'HISUninstallFailed', item, operation.reason, message); }
    catch (auditError) { console.error(`[his-operation] failure audit unavailable id=${operation.id}: ${safeError(auditError)}`); }
    try {
      await ctx.publishNotify({ userActor: actor.username, action: operation.action === 'install' ? 'HISInstallFailed' : 'HISUninstallFailed', target: `HIS/${item.id}`, result: 'error', reason: `${operation.reason} · ${message}` });
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
      if (req.method !== 'POST') throw Object.assign(new Error('method not allowed'), { code: 405 });
      const body = await readJson(req);
      const actor = await actorFor(ctx, req, true);
      const item = assertManagedItem(body);

      if (pathname === '/api/his/plan') {
        return ctx.jsonRes(res, 200, await plan(ctx, item)), true;
      }

      const reason = reasonFrom(body);
      const action = pathname === '/api/his/install' ? 'install' : pathname === '/api/his/uninstall' ? 'uninstall' : '';
      if (!action) throw Object.assign(new Error('not found'), { code: 404 });
      if (action === 'uninstall') {
        if (String(body.confirm || '') !== item.id) throw Object.assign(new Error(`삭제 확인 값으로 '${item.id}'를 입력해야 합니다.`), { code: 400 });
        const release = await helmStatus(ctx, item);
        if (!release?.managed) throw Object.assign(new Error('Cluster Manager가 설치한 Helm release가 아니므로 삭제할 수 없습니다.'), { code: 409 });
      }
      await auditRequired(ctx, actor, action === 'install' ? 'HISInstallRequested' : 'HISUninstallRequested', item, reason, 'requested');
      const operation = await createOperation(ctx, item, actor, action, reason);
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
  renderedResources,
};
