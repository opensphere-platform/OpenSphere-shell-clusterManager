'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bindingProjection, workloadReady, parseOperation, statusComparable, telemetryPayloads } = require('../his-observability-binding-controller');

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

test('telemetry capabilities fail closed unless workload, ingestion and read-back all pass', () => {
  const status = bindingProjection({
    stackPresent: true, prometheusReady: true, prometheusQueryReady: true,
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
});

test('Cluster Manager and HIS Binding Controller share the signed release channel', () => {
  const publish = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/publish-image.yml'), 'utf8');
  const promote = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/promote-image-channel.yml'), 'utf8');
  assert.match(publish, /his-telemetry-manifests\.js/);
  assert.match(publish, /Dockerfile\.observability-binding-controller/);
  assert.match(publish, /ghcr\.io\/opensphere-platform\/opensphere-his-binding-controller/);
  assert.match(publish, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(publish, /binding_build\.outputs\.digest/);
  assert.match(publish, /his-owner-release-\$\{\{ github\.sha \}\}/);
  assert.match(publish, /observability-binding-controller\.yaml/);
  assert.match(publish, /deploy\/ceph-runtime-owner\.yaml/);
  assert.match(publish, /cephRuntimeOwner:\"ceph-runtime-owner\.yaml\"/);
  assert.match(publish, /signed platform-owned Rook operator and Ceph CRDs/);
  assert.ok(publish.includes("! grep -E 'resources: \\[\\*\\]|verbs: \\[\\*\\]'"));
  assert.match(publish, /opensphere-his-binding-controller@\$BINDING_DIGEST/);
  assert.match(promote, /verify_binding/);
  assert.match(promote, /binding-promotion\.json/);
  assert.match(promote, /opensphere-his-binding-controller@\$BINDING_DIGEST/);
  const deployment = fs.readFileSync(path.resolve(__dirname, '../deploy/observability-binding-controller.yaml'), 'utf8');
  assert.match(deployment, /Local developer profile/);
  assert.match(deployment, /production[\s\S]*rendered manifest/);
});
