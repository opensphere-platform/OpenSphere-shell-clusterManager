import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// KubeVirt VM의 status.printableStatus → 상태 색상.
const vmStatusColor = (s: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const v = s || '';
  if (v === 'Running') return 'success';
  if (v === 'Stopped' || v === 'Paused') return 'warning';
  if (v === 'Provisioning' || v === 'Starting' || v === 'Stopping' || v === 'Migrating' || v === 'WaitingForVolumeBinding') return 'info';
  if (v.startsWith('Error') || v === 'CrashLoopBackOff' || v === 'Unschedulable') return 'danger';
  return 'unknown';
};

/**
 * KubeVirt VirtualMachine 실연동 (구 DummyVirtualMachinesComponent 대체).
 * OKD-perspective-binding §7.1: VM은 별도 perspective가 아니라 perspective 2(K8s Cluster) 내부
 * "VM 뷰 스코프"의 한 리소스 — Node·PVC·Service와 같은 object graph 위에서 본다.
 * 이 컴포넌트는 app.component의 capability-gate(kubevirt.io CRD 존재)를 통과해야 nav에 노출된다.
 * 그래도 404면 ResourceListComponent가 friendly로 처리(빨간 에러 아님).
 */
@Component({
  selector: 'app-res-virtualmachines',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Virtual Machines" path="/apis/kubevirt.io/v1/virtualmachines" [namespaced]="true" kind="VirtualMachine" [vm]="true" [columns]="cols" />`,
})
export class VirtualMachinesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.printableStatus || 'Unknown', statusOf: o => vmStatusColor(o.status?.printableStatus) },
    { id: 'ready', label: 'Ready', get: o => (o.status?.ready ? 'True' : 'False') },
    { id: 'node', label: 'Node', get: o => o.status?.nodeName || '—', facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
