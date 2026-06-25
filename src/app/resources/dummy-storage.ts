import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// OpenShift Storage(Ceph/ODF·VolumeSnapshot) 페이지 참고 — 더미(예시) 데이터.
@Component({
  selector: 'app-dummy-volumesnapshots',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Volume Snapshots" path="dummy" [namespaced]="true" [dummy]="true" createLabel="스냅샷 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyVolumeSnapshotsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => (o.status === 'Ready' ? 'success' : o.status === 'Pending' ? 'info' : 'warning') },
    { id: 'source', label: 'Source (PVC)', get: o => o.source },
    { id: 'size', label: 'Size', get: o => o.size },
    { id: 'class', label: 'Snapshot class', get: o => o.snapclass },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'mysql-data-snap-20260618', namespace: 'cmars-dev', creationTimestamp: '2026-06-18T22:00:00Z' }, status: 'Ready', source: 'mysql-data', size: '20 GiB', snapclass: 'csi-rbdplugin-snapclass' },
    { metadata: { name: 'postgres-snap-20260617', namespace: 'cmars-dev', creationTimestamp: '2026-06-17T01:30:00Z' }, status: 'Ready', source: 'postgres-pvc', size: '8 GiB', snapclass: 'csi-rbdplugin-snapclass' },
    { metadata: { name: 'registry-snap', namespace: 'cmars-dev', creationTimestamp: '2026-06-19T13:10:00Z' }, status: 'Pending', source: 'registry-pvc', size: '100 GiB', snapclass: 'csi-cephfsplugin-snapclass' },
  ];
}

@Component({
  selector: 'app-dummy-volumesnapshotclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Volume Snapshot Classes" path="dummy" [namespaced]="false" [dummy]="true" createLabel="클래스 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyVolumeSnapshotClassesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'driver', label: 'Driver', get: o => o.driver },
    { id: 'deletion', label: 'Deletion policy', get: o => o.deletion },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'csi-rbdplugin-snapclass', creationTimestamp: '2026-05-20T00:00:00Z' }, driver: 'rook-ceph.rbd.csi.ceph.com', deletion: 'Delete' },
    { metadata: { name: 'csi-cephfsplugin-snapclass', creationTimestamp: '2026-05-20T00:00:00Z' }, driver: 'rook-ceph.cephfs.csi.ceph.com', deletion: 'Delete' },
  ];
}

@Component({
  selector: 'app-dummy-ceph',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Ceph / ODF Storage Systems" path="dummy" [namespaced]="true" [dummy]="true" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyCephComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'health', label: 'Health', kind: 'status', get: o => o.health, statusOf: o => (o.health === 'HEALTH_OK' ? 'success' : o.health === 'HEALTH_WARN' ? 'warning' : 'danger') },
    { id: 'capacity', label: 'Raw capacity', get: o => o.capacity },
    { id: 'used', label: 'Used', get: o => o.used },
    { id: 'provider', label: 'Provider', kind: 'tags', get: o => o.provider },
  ];
  rows = [
    { metadata: { name: 'ocs-storagecluster', namespace: 'openshift-storage' }, health: 'HEALTH_OK', capacity: '2.0 TiB', used: '156 GiB (7.6%)', provider: ['Ceph RBD', 'CephFS', 'RGW'] },
  ];
}
