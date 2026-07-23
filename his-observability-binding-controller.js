'use strict';

const fs = require('fs');
const http = require('http');
const { createHash } = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const API = process.env.KUBERNETES_API || 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE || 'opensphere-console';
const MONITORING_NAMESPACE = process.env.MONITORING_NAMESPACE || 'monitoring';
const BINDING_NAME = process.env.OBSERVABILITY_BINDING_NAME || 'opensphere-console';
const INTERVAL_MS = Math.max(10000, Number(process.env.RECONCILE_INTERVAL_MS || 30000));
const REFRESH_MS = Math.max(INTERVAL_MS, Number(process.env.EVIDENCE_REFRESH_MS || 60000));
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL
  || 'http://kube-prometheus-stack-prometheus.monitoring.svc:9090').replace(/\/$/, '');
const LOKI_URL = (process.env.LOKI_URL || 'http://opensphere-his-loki.monitoring.svc:3100').replace(/\/$/, '');
const TEMPO_URL = (process.env.TEMPO_URL || 'http://opensphere-his-tempo.monitoring.svc:3200').replace(/\/$/, '');
const OTLP_HTTP_URL = (process.env.OTLP_HTTP_URL || 'http://opensphere-his-otel-collector.monitoring.svc:4318').replace(/\/$/, '');
const OTLP_HEALTH_URL = (process.env.OTLP_HEALTH_URL || 'http://opensphere-his-otel-collector.monitoring.svc:13133').replace(/\/$/, '');
const TELEMETRY_CANARY_REFRESH_MS = Math.max(60000, Number(process.env.TELEMETRY_CANARY_REFRESH_MS || 300000));
const GROUP = 'observability.opensphere.io';
const VERSION = 'v1alpha1';
const BINDING_PATH = `/apis/${GROUP}/${VERSION}/observabilitybindings/${BINDING_NAME}`;
const MANAGED_LABELS = Object.freeze({
  'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
  'opensphere.io/owner': 'his',
  'opensphere.io/consumer': 'opensphere-console',
});
const QUERY_TEMPLATES = Object.freeze({
  'cluster.cpu.utilization': '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  'cluster.memory.utilization': '1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)',
  'cluster.nodes.ready': 'sum(kube_node_status_condition{condition="Ready",status="true"})',
  'workloads.unavailable': 'sum(kube_deployment_status_replicas_unavailable)',
  'prometheus.targets.up': 'sum(up)',
});
const LOG_QUERY_TEMPLATES = Object.freeze({
  'service.recent': '{service_name="${service}"}',
  'service.errors': '{service_name="${service}"} |~ "(?i)(error|exception|failed)"',
  'namespace.recent': '{k8s_namespace_name="${namespace}"}',
});
const TRACE_QUERY_TEMPLATES = Object.freeze({
  'trace.by_id': '/api/traces/${traceId}',
  'service.recent': '{ resource.service.name = "${service}" }',
});

const token = () => fs.readFileSync(`${SA}/token`, 'utf8').trim();

async function k8s(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/json',
      'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = { message: text.slice(0, 500) }; }
  return { ok: response.ok, status: response.status, value };
}

function workloadReady(resource) {
  if (!resource) return false;
  const desired = Number(resource.spec?.replicas ?? 1);
  return desired > 0 && Number(resource.status?.readyReplicas || 0) >= desired;
}

function parseOperation(resource) {
  try { return JSON.parse(resource?.data?.operation || '{}'); } catch { return {}; }
}

function bindingProjection(input, now = new Date().toISOString()) {
  const metrics = input.prometheusReady === true && input.prometheusQueryReady === true;
  const alerting = input.alertmanagerReady === true;
  const dashboards = input.grafanaReady === true;
  const logs = input.lokiReady === true && input.lokiQueryReady === true && input.telemetryCanaryReady === true;
  const traces = input.tempoReady === true && input.tempoQueryReady === true && input.telemetryCanaryReady === true;
  const otlp = input.collectorReady === true && input.collectorHttpReady === true && logs && traces;
  const capabilities = [metrics && 'metrics', alerting && 'alerting', dashboards && 'dashboards', logs && 'logs', traces && 'traces', otlp && 'otlp'].filter(Boolean);
  const unavailableCapabilities = ['metrics', 'logs', 'traces', 'otlp'].filter((capability) => !capabilities.includes(capability));
  const ready = unavailableCapabilities.length === 0;
  const phase = ready ? 'Connected' : (input.stackPresent ? 'Degraded' : 'Pending');
  const evidence = {
    stack: 'kube-prometheus-stack',
    prometheusReady: input.prometheusReady === true,
    prometheusQueryReady: input.prometheusQueryReady === true,
    alertmanagerReady: input.alertmanagerReady === true,
    grafanaReady: input.grafanaReady === true,
    lokiReady: input.lokiReady === true,
    lokiQueryReady: input.lokiQueryReady === true,
    tempoReady: input.tempoReady === true,
    tempoQueryReady: input.tempoQueryReady === true,
    collectorReady: input.collectorReady === true,
    collectorHttpReady: input.collectorHttpReady === true,
    metricsSyntheticCanary: input.canaryReady === true ? 'Passed' : 'NotCurrent',
    metricsSyntheticCanaryAt: input.canaryAt || '',
    telemetrySyntheticCanary: input.telemetryCanaryReady === true ? 'Passed' : 'Failed',
    telemetrySyntheticCanaryAt: input.telemetryCanaryAt || '',
    telemetrySyntheticCanaryError: input.telemetryCanaryError || '',
    unavailableCapabilities,
  };
  const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
  const message = ready
    ? 'HIS metrics, logs, traces and OTLP paths are independently connected and verified.'
    : `HIS binding remains fail-closed; unavailable requested capabilities: ${unavailableCapabilities.join(', ') || 'unknown'}.`;
  return {
    phase,
    observedAt: now,
    message,
    capabilities,
    contract: {
      queryEndpoint: PROMETHEUS_URL,
      capabilities,
      queryTemplates: QUERY_TEMPLATES,
      logs: { queryEndpoint: LOKI_URL, queryTemplates: LOG_QUERY_TEMPLATES },
      traces: { queryEndpoint: TEMPO_URL, queryTemplates: TRACE_QUERY_TEMPLATES },
      otlp: { httpEndpoint: OTLP_HTTP_URL },
    },
    evidence: { ...evidence, digest: evidenceDigest },
    conditions: [{
      type: 'Ready',
      status: ready ? 'True' : 'False',
      reason: ready ? 'ObservabilityPathsVerified' : (input.stackPresent ? 'ObservabilityPathsUnavailable' : 'ObservabilityStackMissing'),
      message,
      lastTransitionTime: now,
    }],
  };
}

async function prometheusQueryReady() {
  try {
    const url = new URL(`${PROMETHEUS_URL}/api/v1/query`);
    url.searchParams.set('query', 'vector(1)');
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'success' && Array.isArray(body.data?.result) && body.data.result.length > 0;
  } catch { return false; }
}

async function fetchJson(url, accepted, timeoutMs = 5000) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (!accepted(body)) throw new Error('response contract not satisfied');
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`POST ${url} HTTP ${response.status}`);
}

async function waitForJson(url, accepted, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { return await fetchJson(url, accepted); }
    catch (error) { last = String(error?.message || error).slice(0, 300); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`telemetry query timeout: ${last}`);
}

function telemetryPayloads(id, now = Date.now()) {
  const traceId = createHash('sha256').update(`trace:${id}`).digest('hex').slice(0, 32);
  const spanId = createHash('sha256').update(`span:${id}`).digest('hex').slice(0, 16);
  const start = BigInt(now) * 1000000n;
  const end = start + 1000000n;
  const resource = { attributes: [
    { key: 'service.name', value: { stringValue: 'opensphere-his-binding-canary' } },
    { key: 'opensphere.canary.id', value: { stringValue: id } },
  ] };
  return {
    traceId,
    logs: { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'opensphere-his-binding-controller' }, logRecords: [{
      timeUnixNano: start.toString(), severityNumber: 9, severityText: 'INFO', body: { stringValue: `opensphere-his-binding-log ${id}` },
      attributes: [{ key: 'opensphere.canary.id', value: { stringValue: id } }],
    }] }] }] },
    traces: { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'opensphere-his-binding-controller' }, spans: [{
      traceId, spanId, name: `opensphere-his-binding-trace-${id}`, kind: 1,
      startTimeUnixNano: start.toString(), endTimeUnixNano: end.toString(), status: { code: 1 },
      attributes: [{ key: 'opensphere.canary.id', value: { stringValue: id } }],
    }] }] }] },
  };
}

let telemetryCanaryCache = { checkedAt: 0, ready: false, lokiQueryReady: false, tempoQueryReady: false, collectorHttpReady: false, observedAt: '', error: '' };

async function telemetryCanary() {
  const cacheTtl = telemetryCanaryCache.ready ? TELEMETRY_CANARY_REFRESH_MS : Math.min(60000, TELEMETRY_CANARY_REFRESH_MS);
  if (telemetryCanaryCache.checkedAt && Date.now() - telemetryCanaryCache.checkedAt < cacheTtl) return telemetryCanaryCache;
  const checkedAt = Date.now();
  const observedAt = new Date(checkedAt).toISOString();
  try {
    const health = await fetch(`${OTLP_HEALTH_URL}/`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`collector health HTTP ${health.status}`);
    const id = `binding-${checkedAt.toString(36)}`;
    const payloads = telemetryPayloads(id, checkedAt);
    await Promise.all([
      postJson(`${OTLP_HTTP_URL}/v1/logs`, payloads.logs),
      postJson(`${OTLP_HTTP_URL}/v1/traces`, payloads.traces),
    ]);
    const lokiQuery = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
    lokiQuery.searchParams.set('query', `{service_name="opensphere-his-binding-canary"} |= "${id}"`);
    lokiQuery.searchParams.set('start', (BigInt(checkedAt - 300000) * 1000000n).toString());
    lokiQuery.searchParams.set('end', (BigInt(checkedAt + 60000) * 1000000n).toString());
    lokiQuery.searchParams.set('limit', '20');
    await waitForJson(lokiQuery.toString(), (body) => body.status === 'success' && (body.data?.result || []).some((stream) => (stream.values || []).some((entry) => String(entry?.[1] || '').includes(id))));
    await waitForJson(`${TEMPO_URL}/api/traces/${payloads.traceId}`, (body) => Array.isArray(body.batches) && body.batches.length > 0);
    telemetryCanaryCache = { checkedAt, ready: true, lokiQueryReady: true, tempoQueryReady: true, collectorHttpReady: true, observedAt, error: '' };
  } catch (error) {
    telemetryCanaryCache = { checkedAt, ready: false, lokiQueryReady: false, tempoQueryReady: false, collectorHttpReady: false, observedAt, error: String(error?.message || error).slice(0, 300) };
  }
  return telemetryCanaryCache;
}

async function observe() {
  const [prometheus, alertmanager, grafana, service, operation, queryReady, loki, tempo, collector, lokiService, tempoService, collectorService, telemetry] = await Promise.all([
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/statefulsets/prometheus-kube-prometheus-stack-prometheus`),
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/statefulsets/alertmanager-kube-prometheus-stack-alertmanager`),
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/deployments/kube-prometheus-stack-grafana`),
    k8s('GET', `/api/v1/namespaces/${MONITORING_NAMESPACE}/services/kube-prometheus-stack-prometheus`),
    k8s('GET', `/api/v1/namespaces/${CONSOLE_NAMESPACE}/configmaps/opensphere-his-operation-kube-prometheus-stack`),
    prometheusQueryReady(),
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/deployments/opensphere-his-loki`),
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/deployments/opensphere-his-tempo`),
    k8s('GET', `/apis/apps/v1/namespaces/${MONITORING_NAMESPACE}/deployments/opensphere-his-otel-collector`),
    k8s('GET', `/api/v1/namespaces/${MONITORING_NAMESPACE}/services/opensphere-his-loki`),
    k8s('GET', `/api/v1/namespaces/${MONITORING_NAMESPACE}/services/opensphere-his-tempo`),
    k8s('GET', `/api/v1/namespaces/${MONITORING_NAMESPACE}/services/opensphere-his-otel-collector`),
    telemetryCanary(),
  ]);
  const canary = parseOperation(operation.ok ? operation.value : null);
  return {
    stackPresent: service.ok || prometheus.ok || alertmanager.ok || grafana.ok || loki.ok || tempo.ok || collector.ok,
    prometheusReady: prometheus.ok && service.ok && workloadReady(prometheus.value),
    prometheusQueryReady: queryReady,
    alertmanagerReady: alertmanager.ok && workloadReady(alertmanager.value),
    grafanaReady: grafana.ok && workloadReady(grafana.value),
    lokiReady: loki.ok && lokiService.ok && workloadReady(loki.value),
    tempoReady: tempo.ok && tempoService.ok && workloadReady(tempo.value),
    collectorReady: collector.ok && collectorService.ok && workloadReady(collector.value),
    lokiQueryReady: telemetry.lokiQueryReady,
    tempoQueryReady: telemetry.tempoQueryReady,
    collectorHttpReady: telemetry.collectorHttpReady,
    telemetryCanaryReady: telemetry.ready,
    telemetryCanaryAt: telemetry.observedAt,
    telemetryCanaryError: telemetry.error,
    canaryReady: canary.action === 'validate' && canary.phase === 'Ready' && Boolean(canary.validationFingerprint),
    canaryAt: canary.finishedAt || canary.updatedAt || '',
  };
}

function statusComparable(status) {
  const value = structuredClone(status || {});
  delete value.observedAt;
  for (const condition of value.conditions || []) delete condition.lastTransitionTime;
  return JSON.stringify(value);
}

async function publish(status) {
  let current = await k8s('GET', BINDING_PATH);
  const spec = {
    consumerRef: { apiVersion: 'apps/v1', kind: 'Deployment', namespace: CONSOLE_NAMESPACE, name: 'opensphere-console' },
    requestedCapabilities: ['metrics', 'logs', 'traces', 'otlp'],
    owner: 'HIS',
  };
  if (current.status === 404) {
    const created = await k8s('POST', `/apis/${GROUP}/${VERSION}/observabilitybindings`, {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: 'ObservabilityBinding',
      metadata: { name: BINDING_NAME, labels: MANAGED_LABELS },
      spec,
    });
    if (!created.ok) throw new Error(`ObservabilityBinding create HTTP ${created.status}: ${created.value?.message || ''}`);
    current = created;
  } else if (!current.ok) {
    throw new Error(`ObservabilityBinding read HTTP ${current.status}: ${current.value?.message || ''}`);
  } else {
    const currentLabels = current.value?.metadata?.labels || {};
    const labelsMatch = Object.entries(MANAGED_LABELS).every(([key, value]) => currentLabels[key] === value);
    const specMatches = JSON.stringify(current.value?.spec || {}) === JSON.stringify(spec);
    if (!labelsMatch || !specMatches) {
      const patched = await k8s('PATCH', BINDING_PATH, { metadata: { labels: MANAGED_LABELS }, spec });
      if (!patched.ok) throw new Error(`ObservabilityBinding spec patch HTTP ${patched.status}: ${patched.value?.message || ''}`);
      current = patched;
    }
  }

  const previous = current.value?.status || {};
  const lastObserved = Date.parse(previous.observedAt || '');
  const same = statusComparable(previous) === statusComparable(status);
  if (same && Number.isFinite(lastObserved) && Date.now() - lastObserved < REFRESH_MS) return previous;
  const previousReady = (previous.conditions || []).find((condition) => condition.type === 'Ready');
  if (previousReady?.status === status.conditions[0].status) {
    status.conditions[0].lastTransitionTime = previousReady.lastTransitionTime || status.conditions[0].lastTransitionTime;
  }
  const written = await k8s('PATCH', `${BINDING_PATH}/status`, { status });
  if (!written.ok) throw new Error(`ObservabilityBinding status patch HTTP ${written.status}: ${written.value?.message || ''}`);
  return written.value?.status || status;
}

let lastSuccessAt = 0;
let lastError = '';

async function reconcileOnce() {
  const status = bindingProjection(await observe());
  await publish(status);
  lastSuccessAt = Date.now();
  lastError = '';
  console.log(`[his-observability-binding] phase=${status.phase} capabilities=${status.capabilities.join(',') || 'none'} evidence=${status.evidence.digest}`);
  return status;
}

async function loop() {
  try { await reconcileOnce(); }
  catch (error) {
    lastError = String(error?.message || error).slice(0, 500);
    console.error(`[his-observability-binding] reconcile failed: ${lastError}`);
  } finally {
    setTimeout(loop, INTERVAL_MS);
  }
}

if (require.main === module) {
  http.createServer((req, res) => {
    if (!['/healthz', '/readyz'].includes(req.url)) { res.writeHead(404); return res.end('not found'); }
    const ready = lastSuccessAt > 0 && Date.now() - lastSuccessAt < Math.max(90000, INTERVAL_MS * 4);
    const ok = req.url === '/healthz' || ready;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok, ready, lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : '', lastError }));
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`HIS ObservabilityBinding controller listening :${PORT}`);
    void loop();
  });
} else {
  module.exports = { bindingProjection, workloadReady, parseOperation, statusComparable, telemetryPayloads };
}
