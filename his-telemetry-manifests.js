'use strict';

// HIS owns the shared telemetry substrate. These manifests are rendered into
// kube-prometheus-stack's Helm revision through extraManifests; they are never
// accepted from a browser or an OAA free-form payload.
const IMAGES = Object.freeze({
  loki: 'grafana/loki:3.7.2@sha256:191d4fdfb7264f16989f0a57f320872620a5a7c2ceeec6229212c4190ec49b86',
  tempo: 'grafana/tempo:2.10.5@sha256:ee21727732c7a7199cb71c3eee9153bbf23f9b0b87619f0555a0cf21a67f1a33',
  collector: 'otel/opentelemetry-collector-contrib:0.153.0@sha256:93aad750175cbf1a973ae1c5886c3371f4d800f61be25cdd26870b8441ffe9fa',
});

const NAMESPACE = 'monitoring';
const OWNER_LABELS = Object.freeze({
  'app.kubernetes.io/part-of': 'opensphere-his',
  'app.kubernetes.io/managed-by': 'opensphere-cluster-manager',
  'opensphere.io/owner': 'his',
  'opensphere.io/data-class': 'observability',
});

function labels(name) {
  return { ...OWNER_LABELS, 'app.kubernetes.io/name': name };
}

function metadata(name, extra = {}) {
  return { name, namespace: NAMESPACE, labels: { ...OWNER_LABELS, ...(extra.labels || {}) }, ...(extra.annotations ? { annotations: extra.annotations } : {}) };
}

function pvc(name, size, storageClassName = '') {
  return {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: metadata(name, { annotations: { 'helm.sh/resource-policy': 'keep' } }),
    spec: {
      ...(storageClassName ? { storageClassName } : {}),
      accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } },
    },
  };
}

function service(name, selector, ports) {
  return {
    apiVersion: 'v1', kind: 'Service', metadata: metadata(name, { labels: { 'app.kubernetes.io/name': name } }),
    spec: { type: 'ClusterIP', selector, ports },
  };
}

function deployment({ name, image, args, configName, dataClaim, ports, probe, runAsUser = 10001, resources }) {
  const podLabels = labels(name);
  return {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name),
    spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser, runAsGroup: runAsUser, fsGroup: runAsUser, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name, image, imagePullPolicy: 'IfNotPresent', args,
            ports, readinessProbe: probe, livenessProbe: { ...probe, initialDelaySeconds: Math.max(20, probe.initialDelaySeconds || 0) },
            resources,
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [
              { name: 'config', mountPath: '/etc/opensphere-his', readOnly: true },
              ...(dataClaim ? [{ name: 'data', mountPath: dataClaim.mountPath }] : []),
              { name: 'tmp', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'config', configMap: { name: configName } },
            ...(dataClaim ? [{ name: 'data', persistentVolumeClaim: { claimName: dataClaim.name } }] : []),
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

function networkPolicy(name, appName, namespaceNames, ports) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata(name, { labels: { 'opensphere.io/policy': 'observability-access' } }),
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': appName } }, policyTypes: ['Ingress'],
      ingress: [{
        from: [{ namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: namespaceNames }] } }],
        ports: ports.map((port) => ({ protocol: 'TCP', port })),
      }],
    },
  };
}

function serviceMonitor(name, serviceName, endpoints) {
  return {
    apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor', metadata: metadata(name),
    spec: { selector: { matchLabels: { 'app.kubernetes.io/name': serviceName } }, namespaceSelector: { matchNames: [NAMESPACE] }, endpoints },
  };
}

function hisTelemetryManifests(config = {}) {
  if (config.enabled === false) return [];
  const storageClassName = String(config.storageClassName || '');
  const lokiSize = String(config.lokiStorageSize || '10Gi');
  const tempoSize = String(config.tempoStorageSize || '10Gi');
  const retention = String(config.retention || '168h');
  const allConsumers = ['monitoring', 'opensphere-console', 'opensphere-console-data', 'opensphere-console-change', 'opensphere-foundation', 'opensphere-system'];
  const ownerReaders = ['monitoring', 'opensphere-console'];

  const lokiConfig = [
    'auth_enabled: false',
    'server:',
    '  http_listen_port: 3100',
    'common:',
    '  ring:',
    '    instance_addr: 127.0.0.1',
    '    kvstore: { store: inmemory }',
    '  replication_factor: 1',
    '  path_prefix: /var/loki',
    'schema_config:',
    '  configs:',
    '    - from: 2020-05-15',
    '      store: tsdb',
    '      object_store: filesystem',
    '      schema: v13',
    '      index: { prefix: index_, period: 24h }',
    'storage_config:',
    '  filesystem: { directory: /var/loki/chunks }',
    'limits_config:',
    '  allow_structured_metadata: true',
    `  retention_period: ${retention}`,
    'compactor:',
    '  working_directory: /var/loki/compactor',
    '  retention_enabled: true',
    '  delete_request_store: filesystem',
    'analytics: { reporting_enabled: false }',
    '',
  ].join('\n');
  const tempoConfig = [
    'stream_over_http_enabled: true',
    'server:',
    '  http_listen_port: 3200',
    'distributor:',
    '  receivers:',
    '    otlp:',
    '      protocols:',
    '        grpc: { endpoint: "0.0.0.0:4317" }',
    '        http: { endpoint: "0.0.0.0:4318" }',
    'storage:',
    '  trace:',
    '    backend: local',
    '    wal: { path: /var/tempo/wal }',
    '    local: { path: /var/tempo/blocks }',
    'compactor:',
    '  compaction:',
    `    block_retention: ${retention}`,
    'usage_report: { reporting_enabled: false }',
    '',
  ].join('\n');
  const collectorConfig = [
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      grpc: { endpoint: 0.0.0.0:4317 }',
    '      http: { endpoint: 0.0.0.0:4318 }',
    'processors:',
    '  memory_limiter: { check_interval: 5s, limit_mib: 384, spike_limit_mib: 96 }',
    '  batch: { timeout: 1s }',
    'exporters:',
    '  otlp/tempo:',
    '    endpoint: opensphere-his-tempo.monitoring.svc.cluster.local:4317',
    '    tls: { insecure: true }',
    '  otlphttp/loki:',
    '    endpoint: http://opensphere-his-loki.monitoring.svc.cluster.local:3100/otlp',
    '    tls: { insecure: true }',
    '  prometheus: { endpoint: 0.0.0.0:8889 }',
    'extensions:',
    '  health_check: { endpoint: 0.0.0.0:13133 }',
    'service:',
    '  extensions: [health_check]',
    '  pipelines:',
    '    traces: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp/tempo] }',
    '    logs: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlphttp/loki] }',
    '    metrics: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [prometheus] }',
    '',
  ].join('\n');

  const loki = 'opensphere-his-loki';
  const tempo = 'opensphere-his-tempo';
  const collector = 'opensphere-his-otel-collector';
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(`${loki}-config`), data: { 'config.yaml': lokiConfig } },
    pvc(`${loki}-data`, lokiSize, storageClassName),
    deployment({
      name: loki, image: IMAGES.loki, args: ['-config.file=/etc/opensphere-his/config.yaml'], configName: `${loki}-config`,
      dataClaim: { name: `${loki}-data`, mountPath: '/var/loki' }, ports: [{ name: 'http', containerPort: 3100 }],
      probe: { httpGet: { path: '/ready', port: 'http' }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 12 },
      resources: { requests: { cpu: '50m', memory: '192Mi' }, limits: { cpu: '1', memory: '768Mi' } },
    }),
    service(loki, { 'app.kubernetes.io/name': loki }, [{ name: 'http', port: 3100, targetPort: 'http' }]),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(`${tempo}-config`), data: { 'config.yaml': tempoConfig } },
    pvc(`${tempo}-data`, tempoSize, storageClassName),
    deployment({
      name: tempo, image: IMAGES.tempo, args: ['-config.file=/etc/opensphere-his/config.yaml', '-target=all'], configName: `${tempo}-config`,
      dataClaim: { name: `${tempo}-data`, mountPath: '/var/tempo' },
      ports: [{ name: 'http', containerPort: 3200 }, { name: 'otlp-grpc', containerPort: 4317 }, { name: 'otlp-http', containerPort: 4318 }],
      probe: { httpGet: { path: '/ready', port: 'http' }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 12 },
      resources: { requests: { cpu: '50m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
    }),
    service(tempo, { 'app.kubernetes.io/name': tempo }, [
      { name: 'http', port: 3200, targetPort: 'http' }, { name: 'otlp-grpc', port: 4317, targetPort: 'otlp-grpc' }, { name: 'otlp-http', port: 4318, targetPort: 'otlp-http' },
    ]),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(`${collector}-config`), data: { 'config.yaml': collectorConfig } },
    deployment({
      name: collector, image: IMAGES.collector, args: ['--config=/etc/opensphere-his/config.yaml'], configName: `${collector}-config`, runAsUser: 10001,
      ports: [{ name: 'otlp-grpc', containerPort: 4317 }, { name: 'otlp-http', containerPort: 4318 }, { name: 'metrics', containerPort: 8889 }, { name: 'health', containerPort: 13133 }],
      probe: { httpGet: { path: '/', port: 'health' }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 12 },
      resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    }),
    service(collector, { 'app.kubernetes.io/name': collector }, [
      { name: 'otlp-grpc', port: 4317, targetPort: 'otlp-grpc' }, { name: 'otlp-http', port: 4318, targetPort: 'otlp-http' },
      { name: 'metrics', port: 8889, targetPort: 'metrics' }, { name: 'health', port: 13133, targetPort: 'health' },
    ]),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('opensphere-his-grafana-datasources', { labels: { grafana_datasource: '1' } }), data: {
      'opensphere-his.yaml': [
        'apiVersion: 1', 'datasources:',
        '  - name: OpenSphere HIS Logs', '    uid: opensphere-his-loki', '    type: loki', '    access: proxy', `    url: http://${loki}.${NAMESPACE}.svc.cluster.local:3100`, '    editable: false',
        '  - name: OpenSphere HIS Traces', '    uid: opensphere-his-tempo', '    type: tempo', '    access: proxy', `    url: http://${tempo}.${NAMESPACE}.svc.cluster.local:3200`, '    editable: false',
        '',
      ].join('\n'),
    } },
    networkPolicy(`${collector}-ingress`, collector, allConsumers, [4317, 4318, 8889, 13133]),
    networkPolicy(`${loki}-ingress`, loki, ownerReaders, [3100]),
    networkPolicy(`${tempo}-ingress`, tempo, ownerReaders, [3200, 4317, 4318]),
    serviceMonitor(`${collector}-metrics`, collector, [{ port: 'metrics', interval: '30s' }]),
    serviceMonitor(`${loki}-metrics`, loki, [{ port: 'http', path: '/metrics', interval: '30s' }]),
    serviceMonitor(`${tempo}-metrics`, tempo, [{ port: 'http', path: '/metrics', interval: '30s' }]),
  ];
}

module.exports = { IMAGES, hisTelemetryManifests };
