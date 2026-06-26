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
 * OKD-perspective-binding: Ceph/ODF는 perspective 2(K8s Cluster) 내부 "Storage 뷰 스코프"의 한 리소스.
 * 이 컴포넌트는 app.component의 capability-gate(ceph.rook.io CRD 존재)를 통과해야 nav에 노출된다.
 * 그래도 404면 ResourceListComponent가 friendly로 처리(빨간 에러 아님).
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
