import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// OpenShift Observe(Alerting·Metrics·Dashboards·Targets) 페이지 참고 — 더미(예시) 데이터.
@Component({
  selector: 'app-dummy-alerts',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Alerting" path="dummy" [namespaced]="false" [dummy]="true" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyAlertsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'severity', label: 'Severity', kind: 'status', get: o => o.severity, statusOf: o => (o.severity === 'critical' ? 'danger' : o.severity === 'warning' ? 'warning' : 'info') },
    { id: 'state', label: 'State', get: o => o.state },
    { id: 'source', label: 'Source', get: o => o.source },
    { id: 'age', label: 'Active since', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'KubePodCrashLooping', creationTimestamp: '2026-06-19T13:48:00Z' }, severity: 'warning', state: 'Firing', source: 'Platform' },
    { metadata: { name: 'KubeMemoryOvercommit', creationTimestamp: '2026-06-19T13:00:00Z' }, severity: 'warning', state: 'Firing', source: 'Platform' },
    { metadata: { name: 'CephClusterWarningState', creationTimestamp: '2026-06-19T13:55:00Z' }, severity: 'critical', state: 'Pending', source: 'User' },
    { metadata: { name: 'TargetDown', creationTimestamp: '2026-06-19T13:30:00Z' }, severity: 'warning', state: 'Silenced', source: 'Platform' },
    { metadata: { name: 'Watchdog', creationTimestamp: '2026-06-14T00:00:00Z' }, severity: 'none', state: 'Firing', source: 'Platform' },
  ];
}

@Component({
  selector: 'app-dummy-metrics',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Metrics" path="dummy" [namespaced]="false" [dummy]="true" createLabel="쿼리 실행" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyMetricsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'query', label: 'PromQL', get: o => o.query },
    { id: 'unit', label: 'Unit', get: o => o.unit },
  ];
  rows = [
    { metadata: { name: 'Cluster CPU usage' }, query: 'sum(rate(container_cpu_usage_seconds_total[5m]))', unit: 'cores' },
    { metadata: { name: 'Memory working set' }, query: 'sum(container_memory_working_set_bytes)', unit: 'bytes' },
    { metadata: { name: 'Pod restarts (1h)' }, query: 'sum(increase(kube_pod_container_status_restarts_total[1h]))', unit: 'count' },
    { metadata: { name: 'API request rate' }, query: 'sum(rate(apiserver_request_total[5m]))', unit: 'req/s' },
  ];
}

@Component({
  selector: 'app-dummy-dashboards',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Dashboards" path="dummy" [namespaced]="false" [dummy]="true" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyDashboardsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'source', label: 'Source', kind: 'tags', get: o => o.source },
    { id: 'panels', label: 'Panels', get: o => o.panels },
  ];
  rows = [
    { metadata: { name: 'Kubernetes / Compute Resources / Cluster' }, source: ['built-in'], panels: 12 },
    { metadata: { name: 'Kubernetes / Networking / Cluster' }, source: ['built-in'], panels: 8 },
    { metadata: { name: 'Ceph / Cluster' }, source: ['community'], panels: 20 },
    { metadata: { name: 'etcd' }, source: ['built-in'], panels: 10 },
  ];
}

@Component({
  selector: 'app-dummy-targets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Targets" path="dummy" [namespaced]="false" [dummy]="true" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyTargetsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Endpoint', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => (o.status === 'Up' ? 'success' : 'danger') },
    { id: 'namespace', label: 'Namespace', get: o => o.namespace },
    { id: 'lastscrape', label: 'Last scrape', get: o => o.lastscrape },
    { id: 'duration', label: 'Scrape duration', get: o => o.duration },
  ];
  rows = [
    { metadata: { name: 'node-exporter' }, status: 'Up', namespace: 'openshift-monitoring', lastscrape: '12s ago', duration: '8 ms' },
    { metadata: { name: 'kube-state-metrics' }, status: 'Up', namespace: 'openshift-monitoring', lastscrape: '10s ago', duration: '22 ms' },
    { metadata: { name: 'kubelet' }, status: 'Up', namespace: 'kube-system', lastscrape: '9s ago', duration: '15 ms' },
    { metadata: { name: 'ceph-mgr' }, status: 'Down', namespace: 'openshift-storage', lastscrape: '1m ago', duration: '—' },
  ];
}
