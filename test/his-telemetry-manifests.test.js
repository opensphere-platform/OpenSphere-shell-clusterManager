'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAGES, hisTelemetryManifests } = require('../his-telemetry-manifests');

test('HIS telemetry stack is fixed, internal, persistent and digest pinned', () => {
  const manifests = hisTelemetryManifests({ retention: '72h', lokiStorageSize: '12Gi', tempoStorageSize: '14Gi', storageClassName: 'durable-csi' });
  assert.equal(manifests.length, 18);
  const deployments = manifests.filter((item) => item.kind === 'Deployment');
  const services = manifests.filter((item) => item.kind === 'Service');
  const pvcs = manifests.filter((item) => item.kind === 'PersistentVolumeClaim');
  assert.equal(deployments.length, 3);
  assert.equal(services.length, 3);
  assert.equal(pvcs.length, 2);
  assert.deepEqual(new Set(deployments.map((item) => item.spec.template.spec.containers[0].image)), new Set(Object.values(IMAGES)));
  for (const image of Object.values(IMAGES)) assert.match(image, /@sha256:[a-f0-9]{64}$/);
  for (const service of services) {
    assert.equal(service.spec.type, 'ClusterIP');
    assert.equal(service.metadata.labels['app.kubernetes.io/name'], service.metadata.name);
  }
  for (const pvc of pvcs) {
    assert.equal(pvc.spec.storageClassName, 'durable-csi');
    assert.equal(pvc.metadata.annotations['helm.sh/resource-policy'], 'keep');
  }
  assert.equal(pvcs.find((item) => /loki/.test(item.metadata.name)).spec.resources.requests.storage, '12Gi');
  assert.equal(pvcs.find((item) => /tempo/.test(item.metadata.name)).spec.resources.requests.storage, '14Gi');
});

test('OTLP routing, Grafana discovery, ServiceMonitor selectors and network policy are explicit', () => {
  const manifests = hisTelemetryManifests();
  const configMaps = manifests.filter((item) => item.kind === 'ConfigMap');
  const collector = configMaps.find((item) => item.metadata.name === 'opensphere-his-otel-collector-config').data['config.yaml'];
  assert.match(collector, /traces:.*exporters: \[otlp\/tempo\]/);
  assert.match(collector, /logs:.*exporters: \[otlphttp\/loki\]/);
  assert.match(collector, /metrics:.*exporters: \[prometheus\]/);
  const grafana = configMaps.find((item) => item.metadata.name === 'opensphere-his-grafana-datasources');
  assert.equal(grafana.metadata.labels.grafana_datasource, '1');
  assert.match(grafana.data['opensphere-his.yaml'], /type: loki/);
  assert.match(grafana.data['opensphere-his.yaml'], /type: tempo/);
  const services = new Map(manifests.filter((item) => item.kind === 'Service').map((item) => [item.metadata.name, item]));
  const monitors = manifests.filter((item) => item.kind === 'ServiceMonitor');
  assert.equal(monitors.length, 3);
  for (const monitor of monitors) {
    const selectedName = monitor.spec.selector.matchLabels['app.kubernetes.io/name'];
    assert.equal(services.get(selectedName).metadata.labels['app.kubernetes.io/name'], selectedName);
  }
  assert.equal(manifests.filter((item) => item.kind === 'NetworkPolicy').length, 3);
});

test('telemetry workloads carry no generic execution or secret surface', () => {
  const manifests = hisTelemetryManifests();
  const serialized = JSON.stringify(manifests);
  assert.doesNotMatch(serialized, /hostPath|privileged|kind":"Secret|kind":"Ingress/);
  for (const deployment of manifests.filter((item) => item.kind === 'Deployment')) {
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  }
  assert.deepEqual(hisTelemetryManifests({ enabled: false }), []);
});
