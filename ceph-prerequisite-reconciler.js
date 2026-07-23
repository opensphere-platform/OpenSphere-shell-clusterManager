const http = require('http');
const fs = require('fs');
const { createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = (process.env.CONSOLE_BACKEND_URL || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const GITEA_URL = (process.env.GITEA_URL || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000').replace(/\/$/, '');
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'ceph-prerequisites').replace(/^\/+|\/+$/g, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const RECONCILER_TOKEN = process.env.RECONCILER_TOKEN || '';
const RECONCILER_NAME = 'ceph-prerequisite-reconciler';
const POLL_INTERVAL_MS = Math.max(2000, Math.min(60000, Number(process.env.POLL_INTERVAL_MS || 5000) || 5000));
const ROLLOUT_TIMEOUT_MS = Math.max(60000, Math.min(900000, Number(process.env.ROLLOUT_TIMEOUT_MS || 600000) || 600000));
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const HELM = process.env.HELM_BIN || '/usr/local/bin/helm';
const ROOK_CHART = process.env.ROOK_CHART || '/app/ceph-charts/rook-ceph-v1.20.2.tgz';
const RUNTIME_CHART = process.env.RUNTIME_CHART || '/app/ceph-runtime-chart';
const ROOK_CHART_SHA256 = '6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_DESIRED_STATE = Object.freeze({
  contract: 'opensphere.ceph.rook-prerequisite/v1',
  release: Object.freeze({
    name: 'rook-ceph', namespace: 'rook-ceph', chart: 'rook-ceph',
    version: 'v1.20.2', sha256: ROOK_CHART_SHA256,
  }),
  components: Object.freeze(['crds', 'operator', 'csi', 'runtime-rbac']),
  verification: Object.freeze(['cephclusters.ceph.rook.io Established', 'deployment/rook-ceph-operator Ready']),
});

let lastClaimAt = null;
let lastSuccessAt = null;
let lastError = null;
let activeRequestId = null;
let stopping = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fileSha256(file) { return sha256(fs.readFileSync(file)); }
function serviceAccountToken() { return fs.readFileSync(`${SA_PATH}/token`, 'utf8').trim(); }
function encodedPath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  return body;
}

async function kubernetesGet(path) {
  const response = await fetch(`${APISERVER}${path}`, {
    headers: { authorization: `Bearer ${serviceAccountToken()}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(body?.message || `Kubernetes HTTP ${response.status}`);
  return body;
}

async function claimWork() {
  const response = await jsonRequest(`${BACKEND_URL}/api/platform/reconcile/next`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opensphere-reconciler-token': RECONCILER_TOKEN },
    body: JSON.stringify({ reconciler: RECONCILER_NAME, limit: 1 }),
  });
  lastClaimAt = new Date().toISOString();
  lastError = null;
  return Array.isArray(response.items) ? response.items[0] || null : null;
}

function validateGovernedManifest(manifest, work) {
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1' || manifest?.kind !== 'GovernedChange') throw new Error('unsupported governed manifest');
  if (manifest?.metadata?.requestId !== work.request_id || manifest?.metadata?.consumerId !== 'ceph-prerequisites') throw new Error('governed manifest identity mismatch');
  if (manifest?.spec?.action !== 'apply' || manifest?.spec?.target !== 'rook-ceph/v1.20.2') throw new Error('Rook release target is outside the closed contract');
  if (manifest.spec.target !== work.target || manifest.spec.reason !== work.reason) throw new Error('governed manifest claim mismatch');
  if (canonicalJson(manifest.spec.desiredState) !== canonicalJson(EXPECTED_DESIRED_STATE)) throw new Error('Rook desired state does not match the pinned release');
  const digest = `sha256:${sha256(canonicalJson(manifest.spec.desiredState))}`;
  if (manifest.metadata.payloadDigest !== digest) throw new Error('governed manifest payload digest mismatch');
  return manifest;
}

async function loadManifest(work) {
  if (!UUID_RE.test(String(work.request_id || '')) || !/^[0-9a-f]{40,64}$/i.test(String(work.git_commit_sha || ''))) throw new Error('claimed change reference is invalid');
  if (work.git_repo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`) throw new Error('claimed repository is outside the Ceph contract');
  const path = `${GITEA_PATH}/requests/${work.request_id}.json`;
  const file = await jsonRequest(`${GITEA_URL}/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(work.git_commit_sha)}`, {
    headers: { authorization: `token ${GITEA_TOKEN}`, accept: 'application/json' },
  });
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  return validateGovernedManifest(JSON.parse(raw), work);
}

async function runHelm(args) {
  const result = await execFileAsync(HELM, args, {
    timeout: ROLLOUT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HELM_CACHE_HOME: '/tmp/helm/cache',
      HELM_CONFIG_HOME: '/tmp/helm/config',
      HELM_DATA_HOME: '/tmp/helm/data',
    },
  });
  return String(result.stdout || '').trim();
}

function crdEstablished(crd) {
  return (crd?.status?.conditions || []).some((item) => item.type === 'Established' && item.status === 'True');
}

function deploymentReady(deployment) {
  const desired = Number(deployment?.spec?.replicas || 1);
  return Number(deployment?.status?.observedGeneration || 0) >= Number(deployment?.metadata?.generation || 0)
    && Number(deployment?.status?.availableReplicas || 0) >= desired
    && Number(deployment?.status?.readyReplicas || 0) >= desired;
}

async function waitForRookReady() {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  let crd;
  let operator;
  while (Date.now() < deadline) {
    try {
      crd = await kubernetesGet('/apis/apiextensions.k8s.io/v1/customresourcedefinitions/cephclusters.ceph.rook.io');
      operator = await kubernetesGet('/apis/apps/v1/namespaces/rook-ceph/deployments/rook-ceph-operator');
      if (crdEstablished(crd) && deploymentReady(operator)) return { crd, operator };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
    }
    await sleep(3000);
  }
  throw new Error('Rook CRD/operator Ready observation timed out');
}

async function installPrerequisites() {
  const observedDigest = fileSha256(ROOK_CHART);
  if (observedDigest !== ROOK_CHART_SHA256) throw new Error('bundled Rook chart SHA-256 mismatch');
  await runHelm([
    'upgrade', '--install', 'rook-ceph', ROOK_CHART,
    '--namespace', 'rook-ceph', '--create-namespace',
    '--atomic', '--wait', '--timeout', '10m', '--history-max', '3',
    '--set', 'crds.enabled=true',
  ]);
  await runHelm([
    'upgrade', '--install', 'opensphere-ceph-runtime', RUNTIME_CHART,
    '--namespace', 'rook-ceph',
    '--atomic', '--wait', '--timeout', '5m', '--history-max', '3',
  ]);
  const observed = await waitForRookReady();
  return {
    contract: EXPECTED_DESIRED_STATE.contract,
    rookVersion: 'v1.20.2',
    chartSha256: observedDigest,
    cephClusterCrd: 'Established',
    operator: 'Ready',
    operatorGeneration: observed.operator?.metadata?.generation || null,
    operatorObservedGeneration: observed.operator?.status?.observedGeneration || null,
    operatorReadyReplicas: observed.operator?.status?.readyReplicas || 0,
    runtimeOwnerRelease: 'opensphere-ceph-runtime',
  };
}

async function sendReceipt(work, succeeded, result, evidence = {}) {
  const operationId = `${work.request_id}:${work.git_commit_sha}:${work.attempt}`.slice(0, 255);
  return jsonRequest(`${BACKEND_URL}/api/platform/reconcile/receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opensphere-reconciler-token': RECONCILER_TOKEN },
    body: JSON.stringify({
      requestId: work.request_id,
      operationId,
      reconciler: RECONCILER_NAME,
      desiredRevision: work.desired_revision || null,
      appliedRevision: succeeded ? work.git_commit_sha : null,
      observedGeneration: Number.isSafeInteger(Number(evidence.operatorObservedGeneration)) ? Number(evidence.operatorObservedGeneration) : null,
      succeeded,
      result: String(result).slice(0, 2000),
      evidence,
    }),
  });
}

async function reconcile(work) {
  activeRequestId = work.request_id;
  try {
    await loadManifest(work);
    const evidence = await installPrerequisites();
    await sendReceipt(work, true, 'Rook CRDs, operator, CSI and OpenSphere Ceph runtime RBAC are Ready', evidence);
    lastSuccessAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 500);
    try { await sendReceipt(work, false, lastError, { errorCode: 'ceph-prerequisite-reconcile-failed' }); }
    catch (receiptError) { console.error('[ceph-prerequisite-reconciler] failure receipt rejected:', receiptError.message || receiptError); }
    console.error('[ceph-prerequisite-reconciler] request failed:', work.request_id, lastError);
  } finally {
    activeRequestId = null;
  }
}

async function pollLoop() {
  while (!stopping) {
    try {
      const work = await claimWork();
      if (work) await reconcile(work);
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
      console.error('[ceph-prerequisite-reconciler] poll failed:', lastError);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const ready = Boolean(GITEA_TOKEN && RECONCILER_TOKEN && fs.existsSync(ROOK_CHART) && fs.existsSync(RUNTIME_CHART));
  const body = {
    service: RECONCILER_NAME, ready, release: 'rook-ceph/v1.20.2',
    chartDigestVerified: fs.existsSync(ROOK_CHART) && fileSha256(ROOK_CHART) === ROOK_CHART_SHA256,
    lastClaimAt, lastSuccessAt, activeRequestId, lastError: lastError ? 'reconciler_error' : null,
  };
  if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  if (path === '/readyz') { res.writeHead(ready && body.chartDigestVerified ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify(body)); }
  res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  server.listen(PORT, () => { console.log(`[ceph-prerequisite-reconciler] listening :${PORT}`); void pollLoop(); });
}

module.exports = { EXPECTED_DESIRED_STATE, canonicalJson, crdEstablished, deploymentReady, validateGovernedManifest, sha256 };
