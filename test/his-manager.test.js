'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HIS_CATALOG, catalogItem } = require('../his-catalog');
const { reasonFrom, safeError, kubeconfigText, auditRequired, operationResourceName, operationActive } = require('../his-manager');

test('HIS catalog keeps PFS/plugin concepts outside the prerequisite catalog', () => {
  assert.ok(HIS_CATALOG.some((item) => item.mode === 'DetectOnly'));
  assert.ok(HIS_CATALOG.some((item) => item.mode === 'HelmManaged'));
  assert.equal(catalogItem('foundation'), undefined);
  assert.equal(catalogItem('metrics-server').chartVersion, '3.13.1');
  const observability = catalogItem('kube-prometheus-stack');
  assert.equal(observability.mode, 'HelmManaged');
  assert.equal(observability.required, false);
  assert.equal(observability.profile, 'Observability');
  assert.equal(observability.chartVersion, '86.0.1');
});

test('mutation reason is mandatory and bounded', () => {
  assert.throws(() => reasonFrom({ reason: 'short' }), /8자 이상/);
  assert.equal(reasonFrom({ reason: 'HIS 설치 승인 근거' }), 'HIS 설치 승인 근거');
  assert.throws(() => reasonFrom({ reason: 'x'.repeat(501) }), /500자 이하/);
});

test('safe errors redact bearer tokens', () => {
  assert.equal(safeError(new Error('Bearer secret.value failed')), 'Bearer [redacted] failed');
  assert.equal(safeError({ code: 401, msg: 'token introspection unavailable' }), 'token introspection unavailable');
});

test('generated kubeconfig does not disable TLS verification', () => {
  const config = kubeconfigText('token', '/var/run/ca.crt', 'https://kubernetes.default.svc');
  assert.match(config, /certificate-authority: \/var\/run\/ca.crt/);
  assert.doesNotMatch(config, /insecure-skip-tls-verify/);
});

test('HIS operations use bounded Kubernetes names and reject stale heartbeats', () => {
  assert.equal(operationResourceName('kube-prometheus-stack'), 'opensphere-his-operation-kube-prometheus-stack');
  assert.ok(operationResourceName('X'.repeat(100)).length <= 63);
  assert.equal(operationActive({ phase: 'Installing', updatedAt: new Date().toISOString() }), true);
  assert.equal(operationActive({ phase: 'Installing', updatedAt: new Date(Date.now() - 120000).toISOString() }), false);
  assert.equal(operationActive({ phase: 'Ready', updatedAt: new Date().toISOString() }), false);
});

test('durable audit request authenticates with the managed workload ServiceAccount token', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true };
  };
  try {
    await auditRequired(
      { controller: 'http://controller', token: () => 'workload-token' },
      { username: 'cmars' },
      'HISInstallRequested',
      { id: 'metrics-server', chartName: 'metrics-server', chartVersion: '3.13.1', release: 'metrics-server', namespace: 'kube-system' },
      'metrics-server 설치 승인 근거',
      'requested',
    );
    assert.equal(captured.options.headers.authorization, 'Bearer workload-token');
    assert.equal(captured.options.headers['x-opensphere-source'], 'cluster-manager');
    assert.equal(JSON.parse(captured.options.body).userActor, 'cmars');
    assert.equal(JSON.parse(captured.options.body).actor, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});
