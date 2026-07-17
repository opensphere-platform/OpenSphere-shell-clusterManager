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
const activeOperations = new Set();

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

async function k8s(ctx, apiPath) {
  const response = await fetch(`${ctx.apiServer}${apiPath}`, {
    headers: { authorization: `Bearer ${ctx.token()}`, accept: 'application/json' },
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

function result(state, reason, message, observedVersion = '') {
  return { state, reason, message, observedVersion, retryable: state !== 'Ready', lastCheckedAt: new Date().toISOString() };
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
      'prometheuses.monitoring.coreos.com',
      'servicemonitors.monitoring.coreos.com',
      'alertmanagers.monitoring.coreos.com',
    ];
    const crdChecks = await Promise.all(crdNames.map(async (crdName) => {
      try { await k8s(ctx, `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crdName}`); return true; }
      catch (e) { if (e.code === 404) return false; throw e; }
    }));
    const [deployments, statefulsets, daemonsets] = await Promise.all([
      k8s(ctx, '/apis/apps/v1/deployments'),
      k8s(ctx, '/apis/apps/v1/statefulsets'),
      k8s(ctx, '/apis/apps/v1/daemonsets'),
    ]);
    const deploymentItems = deployments.items || [];
    const statefulSetItems = statefulsets.items || [];
    const daemonSetItems = daemonsets.items || [];
    const find = (items, pattern) => items.find((item) => pattern.test(item.metadata?.name || ''));
    const components = [
      { name: 'Prometheus Operator', item: find(deploymentItems, /prometheus.*operator|kube-prometheus-stack-operator/i), ready: availableDeployment },
      { name: 'Grafana', item: find(deploymentItems, /grafana/i), ready: availableDeployment },
      { name: 'kube-state-metrics', item: find(deploymentItems, /kube-state-metrics/i), ready: availableDeployment },
      { name: 'Prometheus', item: find(statefulSetItems, /^prometheus-/i), ready: readyStatefulSet },
      { name: 'Alertmanager', item: find(statefulSetItems, /^alertmanager-/i), ready: readyStatefulSet },
      { name: 'node-exporter', item: find(daemonSetItems, /node-exporter/i), ready: readyDaemonSet },
    ];
    const present = components.filter((component) => component.item);
    const ready = components.filter((component) => component.item && component.ready(component.item));
    const crdsReady = crdChecks.every(Boolean);
    const operator = components[0].item;
    const observedVersion = operator?.spec?.template?.spec?.containers?.[0]?.image || '';
    if (crdsReady && ready.length === components.length) {
      const namespaces = [...new Set(components.map((component) => component.item?.metadata?.namespace).filter(Boolean))];
      return result('Ready', 'ObservabilityReady', `공유 관측 스택 ${ready.length}/${components.length}개 구성요소가 Ready입니다. (${namespaces.join(', ')})`, observedVersion);
    }
    if (crdChecks.some(Boolean) || present.length) {
      const missing = components.filter((component) => !component.item || !component.ready(component.item)).map((component) => component.name);
      return result('Degraded', 'ObservabilityPartial', `관측 스택 일부만 준비되었습니다. 미준비: ${missing.join(', ') || 'CRD'}`, observedVersion);
    }
    return result('Blocked', 'ObservabilityMissing', '공유 kube-prometheus-stack이 없습니다. Observability profile에서 선택 설치할 수 있습니다.');
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

async function itemStatus(ctx, item) {
  try {
    const [check, release] = await Promise.all([probe(ctx, item.probe), helmStatus(ctx, item)]);
    const ownership = release?.managed ? 'ClusterManager' : check.state === 'Ready' ? 'External' : 'Unmanaged';
    return { ...item, check, release, ownership, chart: undefined, values: undefined, kindValues: undefined };
  } catch (e) {
    return {
      ...item,
      chart: undefined,
      values: undefined,
      kindValues: undefined,
      ownership: 'Unknown',
      release: null,
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

async function plan(ctx, item) {
  const variant = await clusterVariant(ctx);
  const args = ['template', item.release, item.chart, '--namespace', item.namespace, ...helmArgs(item, variant)];
  const out = await withKubeconfig(ctx, (env) => command('helm', args, { env, timeoutMs: 120000 }));
  const resources = [];
  yaml.loadAll(out.stdout, (doc) => {
    if (!doc || typeof doc !== 'object' || !doc.kind) return;
    resources.push({ apiVersion: doc.apiVersion || '', kind: doc.kind, namespace: doc.metadata?.namespace || item.namespace, name: doc.metadata?.name || '' });
  });
  return { id: item.id, displayName: item.displayName, chart: item.chartName, chartVersion: item.chartVersion, namespace: item.namespace, release: item.release, clusterVariant: variant, resources, retainedOnDelete: item.retainedOnDelete || [] };
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
      if (activeOperations.has(item.id)) throw Object.assign(new Error('동일 HIS 항목에 대한 작업이 이미 진행 중입니다.'), { code: 409 });
      activeOperations.add(item.id);
      try {
        if (pathname === '/api/his/install') {
          const before = await itemStatus(ctx, item);
          if (before.check.state === 'Ready' && !before.release?.managed) {
            throw Object.assign(new Error('호스트 또는 외부 관리자가 제공한 capability입니다. Cluster Manager가 덮어쓰지 않습니다.'), { code: 409 });
          }
          if (before.check.state === 'Degraded' && !before.release?.managed) {
            throw Object.assign(new Error('부분 설치 리소스가 존재합니다. 충돌을 해소한 뒤 설치하십시오.'), { code: 409 });
          }
          await auditRequired(ctx, actor, 'HISInstallRequested', item, reason, 'requested');
          const variant = await clusterVariant(ctx);
          const args = ['upgrade', '--install', item.release, item.chart, '--namespace', item.namespace, '--create-namespace', '--atomic', '--wait', '--timeout', '10m', '--history-max', '5', ...helmArgs(item, variant)];
          const out = await withKubeconfig(ctx, (env) => command('helm', args, { env }));
          const check = await waitForProbe(ctx, item, (value) => value.state === 'Ready');
          await ctx.publishNotify({ userActor: actor.username, action: 'HISInstalled', target: `HIS/${item.id}`, result: check.state, reason: `${reason} · ${check.message}` });
          return ctx.jsonRes(res, check.state === 'Ready' ? 200 : 502, { ok: check.state === 'Ready', check, output: out.stdout.slice(-4000) }), true;
        }
        if (pathname === '/api/his/uninstall') {
          if (String(body.confirm || '') !== item.id) throw Object.assign(new Error(`삭제 확인 값으로 '${item.id}'를 입력해야 합니다.`), { code: 400 });
          const release = await helmStatus(ctx, item);
          if (!release?.managed) throw Object.assign(new Error('Cluster Manager가 설치한 Helm release가 아니므로 삭제할 수 없습니다.'), { code: 409 });
          await auditRequired(ctx, actor, 'HISUninstallRequested', item, reason, 'requested');
          const out = await withKubeconfig(ctx, (env) => command('helm', ['uninstall', item.release, '--namespace', item.namespace, '--wait', '--timeout', '10m'], { env }));
          const check = await waitForProbe(ctx, item, (value) => value.state !== 'Ready', 60000);
          await ctx.publishNotify({ userActor: actor.username, action: 'HISUninstalled', target: `HIS/${item.id}`, result: 'success', reason: `${reason} · retained=${(item.retainedOnDelete || []).join(',') || 'none'}` });
          return ctx.jsonRes(res, 200, { ok: true, check, retained: item.retainedOnDelete || [], output: out.stdout.slice(-4000) }), true;
        }
      } finally {
        activeOperations.delete(item.id);
      }
      throw Object.assign(new Error('not found'), { code: 404 });
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
  kubeconfigText,
  auditRequired,
};
