import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// OpenShift Migration(MTV·Storage Migration) 페이지 참고 — 더미(예시) 데이터.
const planStatus = (s: string): 'success' | 'info' | 'danger' | 'warning' | 'unknown' =>
  s === 'Succeeded' || s === 'Ready' ? 'success' : s === 'Executing' || s === 'Running' ? 'info' : s === 'Failed' ? 'danger' : 'warning';

@Component({
  selector: 'app-dummy-storagemigration',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Storage Migration" path="dummy" [namespaced]="false" [dummy]="true" createLabel="마이그레이션 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyStorageMigrationComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => planStatus(o.status) },
    { id: 'source', label: 'Source StorageClass', get: o => o.source },
    { id: 'target', label: 'Target StorageClass', get: o => o.target },
    { id: 'pvcs', label: 'PVCs', get: o => o.pvcs },
    { id: 'age', label: 'Started', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'hdd-to-ssd', creationTimestamp: '2026-06-14T10:00:00Z' }, status: 'Succeeded', source: 'standard', target: 'fast-ssd', pvcs: 12 },
    { metadata: { name: 'ceph-rebalance', creationTimestamp: '2026-06-19T13:00:00Z' }, status: 'Running', source: 'ceph-rbd', target: 'ceph-rbd-ec', pvcs: 30 },
  ];
}

@Component({
  selector: 'app-dummy-mtvproviders',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Providers (MTV)" path="dummy" [namespaced]="true" [dummy]="true" createLabel="프로바이더 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyMtvProvidersComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'type', label: 'Type', kind: 'tags', get: o => o.type },
    { id: 'endpoint', label: 'Endpoint', get: o => o.endpoint },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => (o.status === 'Ready' ? 'success' : o.status === 'Connecting' ? 'info' : 'danger') },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'vsphere-prod', namespace: 'openshift-mtv', creationTimestamp: '2026-06-10T00:00:00Z' }, type: 'vSphere', endpoint: 'https://vcenter.corp/sdk', status: 'Ready' },
    { metadata: { name: 'ovirt-legacy', namespace: 'openshift-mtv', creationTimestamp: '2026-06-10T00:00:00Z' }, type: 'oVirt', endpoint: 'https://rhv.corp/ovirt-engine/api', status: 'Ready' },
    { metadata: { name: 'host', namespace: 'openshift-mtv', creationTimestamp: '2026-06-09T00:00:00Z' }, type: 'OpenShift', endpoint: 'https://api.cluster.local:6443', status: 'Ready' },
    { metadata: { name: 'ova-archive', namespace: 'openshift-mtv', creationTimestamp: '2026-06-11T00:00:00Z' }, type: 'OVA', endpoint: 'nfs://nas.corp/exports/ova', status: 'Connecting' },
  ];
}

@Component({
  selector: 'app-dummy-mtvplans',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Plans (MTV)" path="dummy" [namespaced]="true" [dummy]="true" createLabel="플랜 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyMtvPlansComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'source', label: 'Source provider', get: o => o.source },
    { id: 'target', label: 'Target provider', get: o => o.target },
    { id: 'vms', label: 'VMs', get: o => o.vms },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => planStatus(o.status) },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'migrate-prod-batch1', namespace: 'openshift-mtv', creationTimestamp: '2026-06-15T00:00:00Z' }, source: 'vsphere-prod', target: 'host', vms: 8, status: 'Succeeded' },
    { metadata: { name: 'ovirt-lift', namespace: 'openshift-mtv', creationTimestamp: '2026-06-19T11:00:00Z' }, source: 'ovirt-legacy', target: 'host', vms: 15, status: 'Executing' },
    { metadata: { name: 'archive-restore', namespace: 'openshift-mtv', creationTimestamp: '2026-06-18T00:00:00Z' }, source: 'ova-archive', target: 'host', vms: 3, status: 'Failed' },
  ];
}
