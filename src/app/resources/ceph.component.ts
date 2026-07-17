import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// Rook-Ceph CephCluster의 status.ceph.health → 상태 색상.
const cephHealthColor = (h: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const v = h || '';
  if (v === 'HEALTH_OK') return 'success';
  if (v === 'HEALTH_WARN') return 'warning';
  if (v === 'HEALTH_ERR') return 'danger';
  return 'unknown';
};

/**
 * Rook-Ceph CephCluster 실연동 (구 DummyCephComponent 대체).
 * Cluster Manager의 Ceph Storage 전문 관점 기본 화면.
 * Ceph가 미설치된 상태에서도 진입점은 노출하고, 404는 ResourceListComponent가 friendly로 처리한다.
 * 읽기 전용 — 생성 액션 없음(createLabel 미지정).
 */
@Component({
  selector: 'app-res-ceph',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Ceph / ODF" path="/apis/ceph.rook.io/v1/cephclusters" [namespaced]="true" kind="CephCluster" [columns]="cols" />`,
})
export class CephClustersComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'health', label: 'Health', kind: 'status', get: o => o.status?.ceph?.health || 'Unknown', statusOf: o => cephHealthColor(o.status?.ceph?.health) },
    { id: 'phase', label: 'Phase', get: o => o.status?.phase || '—', facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
