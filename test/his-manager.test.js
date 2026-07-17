'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HIS_CATALOG, catalogItem } = require('../his-catalog');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  reasonFrom,
  safeError,
  kubeconfigText,
  auditRequired,
  operationResourceName,
  operationActive,
  renderedResources,
  recoverableHelmCleanupError,
  stuckReleaseRecoveryStrategy,
  validateObservabilityConfig,
  observabilityValues,
  observabilityPvcComponent,
  DEFAULT_OBSERVABILITY_CONFIG,
} = require('../his-manager');

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

test('Helm NOTES text is excluded from the executable resource plan', () => {
  const rendered = `---
# Source: chart/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: grafana
---
You need to explicitly call out to that shell.
items: ----------------------------------------
type: string
`;
  assert.deepEqual(renderedResources(rendered, 'monitoring'), [{
    apiVersion: 'v1', kind: 'Service', namespace: 'monitoring', name: 'grafana',
  }]);
});

test('stalled uninstall metadata is recoverable only for an uninstalling release', () => {
  assert.equal(recoverableHelmCleanupError('uninstalling', 'failed to delete release: kube-prometheus-stack'), true);
  assert.equal(recoverableHelmCleanupError('deployed', 'failed to delete release: kube-prometheus-stack'), false);
  assert.equal(recoverableHelmCleanupError('failed', 'release: not found'), true);
});

test('failed releases with live workloads are repaired in place', () => {
  assert.equal(stuckReleaseRecoveryStrategy('failed', true), 'repair-in-place');
  assert.equal(stuckReleaseRecoveryStrategy('failed', false), 'replace');
  assert.equal(stuckReleaseRecoveryStrategy('uninstalling', true), 'replace');
});

test('Grafana persistence profile is repeat-install safe', () => {
  const values = yaml.load(fs.readFileSync(path.resolve(__dirname, '../his-values/kube-prometheus-stack.yaml'), 'utf8'));
  assert.equal(values.grafana.deploymentStrategy.type, 'Recreate');
  assert.equal(values.grafana.initChownData.enabled, false);
  assert.equal(values.grafana.persistence.lookupVolumeName, true);
  assert.equal(values.grafana.persistence.annotations['helm.sh/resource-policy'], 'keep');
  assert.equal(values.prometheus.prometheusSpec.persistentVolumeClaimRetentionPolicy.whenDeleted, 'Retain');
  assert.equal(values.alertmanager.alertmanagerSpec.persistentVolumeClaimRetentionPolicy.whenScaled, 'Retain');
});

test('Observability configuration is allowlisted and secure by default', () => {
  const config = validateObservabilityConfig(DEFAULT_OBSERVABILITY_CONFIG);
  const values = observabilityValues(config);
  assert.equal(values.grafana.service.type, 'ClusterIP');
  assert.equal(values.grafana.ingress.enabled, false);
  assert.equal(values.prometheus.ingress.enabled, false);
  assert.equal(values.alertmanager.ingress.enabled, false);
  assert.equal(values.extraManifests.length, 3);
  assert.equal(values.grafana.persistence.annotations['helm.sh/resource-policy'], 'keep');
  assert.deepEqual(values.prometheus.prometheusSpec.remoteWrite, []);
});

test('private Grafana ingress requires TLS, OIDC references and CIDR restrictions', () => {
  assert.throws(() => validateObservabilityConfig({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    grafana: { ...DEFAULT_OBSERVABILITY_CONFIG.grafana, exposureMode: 'PrivateIngress', hostname: 'grafana.example.com', tlsSecretName: 'grafana-tls', oidcSecretName: 'grafana-oidc' },
  }), /허용 CIDR/);
  const config = validateObservabilityConfig({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    grafana: {
      ...DEFAULT_OBSERVABILITY_CONFIG.grafana,
      exposureMode: 'PrivateIngress',
      hostname: 'grafana.example.com',
      tlsSecretName: 'grafana-tls',
      oidcSecretName: 'grafana-oidc',
      allowedCidrs: ['10.0.0.0/8'],
    },
  });
  const values = observabilityValues(config);
  assert.equal(values.grafana.ingress.enabled, true);
  assert.equal(values.grafana.ingress.annotations['nginx.ingress.kubernetes.io/whitelist-source-range'], '10.0.0.0/8');
  assert.equal(values.grafana.envFromSecret, 'grafana-oidc');
  assert.equal(values.grafana['grafana.ini']['auth.anonymous'].enabled, false);
  assert.deepEqual(values.grafana.ingress.tls[0].hosts, ['grafana.example.com']);
});

test('remote write only accepts HTTPS or cluster-local HTTP and secret references', () => {
  assert.throws(() => validateObservabilityConfig({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    prometheus: { ...DEFAULT_OBSERVABILITY_CONFIG.prometheus, remoteWrite: { enabled: true, url: 'http://metrics.example.com/write', secretName: 'remote-write', secretKey: 'token' } },
  }), /HTTPS/);
  const config = validateObservabilityConfig({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    prometheus: { ...DEFAULT_OBSERVABILITY_CONFIG.prometheus, remoteWrite: { enabled: true, url: 'https://metrics.example.com/write', secretName: 'remote-write', secretKey: 'token' } },
  });
  const remoteWrite = observabilityValues(config).prometheus.prometheusSpec.remoteWrite[0];
  assert.equal(remoteWrite.url, 'https://metrics.example.com/write');
  assert.deepEqual(remoteWrite.authorization.credentials, { name: 'remote-write', key: 'token' });
});

test('Observability PVC names are bounded to the three managed data stores', () => {
  assert.equal(observabilityPvcComponent('kube-prometheus-stack-grafana'), 'grafana');
  assert.equal(observabilityPvcComponent('prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0'), 'prometheus');
  assert.equal(observabilityPvcComponent('alertmanager-kube-prometheus-stack-alertmanager-db-alertmanager-kube-prometheus-stack-alertmanager-0'), 'alertmanager');
  assert.equal(observabilityPvcComponent('customer-database'), '');
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
