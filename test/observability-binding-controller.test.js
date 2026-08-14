'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bindingProjection, workloadReady, parseOperation, currentCanary, metricsCanaryResult, statusComparable, telemetryPayloads } = require('../his-observability-binding-controller');

test('HIS binding publishes only independently verified capabilities', () => {
  const status = bindingProjection({
    stackPresent: true,
    prometheusReady: true,
    prometheusQueryReady: true,
    alertmanagerReady: true,
    grafanaReady: true,
    lokiReady: true,
    lokiQueryReady: true,
    tempoReady: true,
    tempoQueryReady: true,
    collectorReady: true,
    collectorHttpReady: true,
    telemetryCanaryReady: true,
    telemetryCanaryAt: '2026-07-23T00:01:00.000Z',
    canaryReady: true,
    canaryAt: '2026-07-23T00:00:00.000Z',
  }, '2026-07-23T01:00:00.000Z');
  assert.equal(status.phase, 'Connected');
  assert.deepEqual(status.capabilities, ['metrics', 'alerting', 'dashboards', 'logs', 'traces', 'otlp']);
  assert.deepEqual(status.evidence.unavailableCapabilities, []);
  assert.match(status.evidence.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(status.conditions[0].status, 'True');
  assert.deepEqual(Object.keys(status.contract.queryTemplates).sort(), [
    'cluster.cpu.utilization',
    'cluster.memory.utilization',
    'cluster.nodes.ready',
    'prometheus.targets.up',
    'workloads.unavailable',
  ]);
});

test('HIS binding fails closed when the live metrics query is unavailable', () => {
  const status = bindingProjection({ stackPresent: true, prometheusReady: true, prometheusQueryReady: false });
  assert.equal(status.phase, 'Degraded');
  assert.deepEqual(status.capabilities, []);
  assert.equal(status.conditions[0].status, 'False');
});

test('metrics capability requires a fresh completed synthetic validation', () => {
  const base = {
    stackPresent: true,
    prometheusReady: true,
    prometheusQueryReady: true,
    canaryReady: false,
  };
  const stale = bindingProjection(base);
  assert.equal(stale.capabilities.includes('metrics'), false);
  assert.equal(stale.evidence.metricsSyntheticCanary, 'NotCurrent');

  const operation = {
    action: 'validate',
    phase: 'Ready',
    validationFingerprint: 'verified-fingerprint',
    finishedAt: '2026-08-07T06:27:25.871Z',
  };
  assert.deepEqual(currentCanary(operation, Date.parse('2026-08-07T07:27:25.871Z')), {
    ready: true,
    observedAt: '2026-08-07T06:27:25.871Z',
  });
  assert.equal(currentCanary(operation, Date.parse('2026-08-08T06:27:25.872Z')).ready, false);
});

test('continuous metrics canary accepts only a fresh Prometheus scrape sample', () => {
  const now = Date.parse('2026-08-14T08:00:00.000Z');
  const body = { status: 'success', data: { result: [{ value: [(now - 30000) / 1000, '1'] }] } };
  assert.deepEqual(metricsCanaryResult(body, now), {
    ready: true,
    observedAt: '2026-08-14T07:59:30.000Z',
  });
  assert.equal(metricsCanaryResult({ status: 'success', data: { result: [{ value: [(now - 121000) / 1000, '1'] }] } }, now).ready, false);
  assert.equal(metricsCanaryResult({ status: 'success', data: { result: [] } }, now).ready, false);
});

test('telemetry capabilities fail closed unless workload, ingestion and read-back all pass', () => {
  const status = bindingProjection({
    stackPresent: true, prometheusReady: true, prometheusQueryReady: true,
    canaryReady: true,
    lokiReady: true, lokiQueryReady: true, tempoReady: true, tempoQueryReady: false,
    collectorReady: true, collectorHttpReady: true, telemetryCanaryReady: true,
  });
  assert.equal(status.phase, 'Degraded');
  assert.equal(status.capabilities.includes('logs'), true);
  assert.equal(status.capabilities.includes('traces'), false);
  assert.equal(status.capabilities.includes('otlp'), false);
  assert.deepEqual(status.evidence.unavailableCapabilities, ['traces', 'otlp']);
  assert.equal(status.conditions[0].reason, 'ObservabilityPathsUnavailable');
});

test('OTLP canary payload is deterministic, bounded and contains correlated log and trace evidence', () => {
  const payload = telemetryPayloads('fixed-canary', 1770000000000);
  assert.match(payload.traceId, /^[a-f0-9]{32}$/);
  assert.equal(payload.logs.resourceLogs[0].resource.attributes[0].value.stringValue, 'opensphere-his-binding-canary');
  assert.match(payload.logs.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, /fixed-canary/);
  assert.equal(payload.traces.resourceSpans[0].scopeSpans[0].spans[0].traceId, payload.traceId);
  assert.match(payload.traces.resourceSpans[0].scopeSpans[0].spans[0].name, /fixed-canary/);
});

test('workload and canary evidence parsers never infer readiness from presence alone', () => {
  assert.equal(workloadReady({ spec: { replicas: 2 }, status: { readyReplicas: 1 } }), false);
  assert.equal(workloadReady({ spec: { replicas: 2 }, status: { readyReplicas: 2 } }), true);
  assert.deepEqual(parseOperation({ data: { operation: '{bad json' } }), {});
  const first = bindingProjection({ stackPresent: true, prometheusReady: true, prometheusQueryReady: true }, '2026-07-23T01:00:00.000Z');
  const refreshed = bindingProjection({ stackPresent: true, prometheusReady: true, prometheusQueryReady: true }, '2026-07-23T01:01:00.000Z');
  assert.equal(statusComparable(first), statusComparable(refreshed));
});

test('ObservabilityBinding controller RBAC cannot read Secrets or mutate monitoring workloads', () => {
  const manifest = fs.readFileSync(path.resolve(__dirname, '../deploy/observability-binding-controller.yaml'), 'utf8');
  assert.doesNotMatch(manifest, /resources: \[secrets\]/);
  assert.match(manifest, /resources: \[statefulsets\]\s+resourceNames: \[prometheus-kube-prometheus-stack-prometheus, alertmanager-kube-prometheus-stack-alertmanager\]\s+verbs: \[get\]/);
  assert.match(manifest, /resources: \[deployments\]\s+resourceNames: \[kube-prometheus-stack-grafana, opensphere-his-loki, opensphere-his-tempo, opensphere-his-otel-collector\]\s+verbs: \[get\]/);
  assert.match(manifest, /resources: \[observabilitybindings\/status\]/);
  assert.match(manifest, /resourceNames: \[opensphere-console\]/);
  assert.match(manifest, /scope: Cluster/);
  assert.match(manifest, /kind: ServiceMonitor[\s\S]*namespace: monitoring/);
  assert.match(manifest, /path: \/metrics/);
  assert.match(manifest, /kubernetes\.io\/metadata\.name: monitoring/);
});

test('Cluster Manager and HIS Binding Controller share the GA rebuild release', () => {
  const publish = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/publish-image.yml'), 'utf8');
  assert.equal(fs.existsSync(path.resolve(__dirname, '../.github/workflows/promote-image-channel.yml')), false);
  assert.match(publish, /workflow_dispatch:/);
  assert.doesNotMatch(publish, /^  push:/m);
  assert.match(publish, /io\.opensphere\.channel=ga/);
  const managerDockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
  assert.match(managerDockerfile, /his-telemetry-manifests\.js/);
  assert.match(publish, /Dockerfile\.observability-binding-controller/);
  assert.match(publish, /ghcr\.io\/opensphere-platform\/opensphere-his-binding-controller/);
  assert.match(publish, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(publish, /binding_build\.outputs\.digest/);
  assert.match(publish, /hiss-owner-release-\$\{\{ github\.sha \}\}/);
  assert.match(publish, /observability-binding-controller\.yaml/);
  assert.match(publish, /deploy\/ceph-runtime-owner\.yaml/);
  assert.match(publish, /cephRuntimeOwner:\"ceph-runtime-owner\.yaml\"/);
  assert.match(publish, /signed platform-owned Rook operator and Ceph CRDs/);
  assert.ok(publish.includes("! grep -E 'resources: \\[\\*\\]|verbs: \\[\\*\\]'"));
  assert.match(publish, /opensphere-his-binding-controller@\$BINDING_DIGEST/);
  const deployment = fs.readFileSync(path.resolve(__dirname, '../deploy/observability-binding-controller.yaml'), 'utf8');
  assert.match(deployment, /Local developer profile/);
  assert.match(deployment, /production[\s\S]*rendered manifest/);
});
