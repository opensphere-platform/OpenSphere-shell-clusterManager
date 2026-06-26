import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';
import { VmCreateComponent } from './vm-create.component';
import { osIdFromImage } from '../shared/os-logo.component';
import { K8sService } from '../core/k8s.service';

// KubeVirt VM의 status.printableStatus → 상태 색상.
const vmStatusColor = (s: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const v = s || '';
  if (v === 'Running') return 'success';
  if (v === 'Stopped' || v === 'Paused') return 'warning';
  if (v === 'Provisioning' || v === 'Starting' || v === 'Stopping' || v === 'Migrating' || v === 'WaitingForVolumeBinding') return 'info';
  if (v.startsWith('Error') || v === 'CrashLoopBackOff' || v === 'Unschedulable') return 'danger';
  return 'unknown';
};
function memBytes(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(String(v)); if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}
function vmVcpu(v: any): number { const c = v.spec?.template?.spec?.domain?.cpu; return c ? (c.sockets || 1) * (c.cores || 1) * (c.threads || 1) : 0; }
function vmMemBytes(v: any): number { const d = v.spec?.template?.spec?.domain; return memBytes(d?.memory?.guest || d?.resources?.requests?.memory); }

/**
 * KubeVirt VirtualMachine 목록 — OpenShift Virtualization VM 목록 등가(상단 요약 밴드 + 테이블 + 생성).
 * 요약 밴드(가상 머신 상태 분포 + 사용량)는 list와 별도로 VM을 조회해 집계. 행 이름 클릭 → vm-detail 드로어.
 */
@Component({
  selector: 'app-res-virtualmachines',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceListComponent, VmCreateComponent],
  styles: [`
    .vm-summary { display: grid; grid-template-columns: 1.3fr 1fr; gap: 1rem; margin: .25rem 0 1rem; }
    .vm-sum-row { display: flex; gap: 1.6rem; flex-wrap: wrap; padding: .8rem 1rem; align-items: center; }
    .vm-sum-row .os-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: .35rem; }
    .vm-sum-row strong { font-size: 1.05rem; }
    @media (max-width: 820px) { .vm-summary { grid-template-columns: 1fr; } }
  `],
  template: `
    <app-vm-create *ngIf="creating()" (created)="creating.set(false); reload()" (cancel)="creating.set(false)"></app-vm-create>
    <div *ngIf="!creating()">
      <!-- 요약 밴드 (OpenShift Virtualization 목록 등가) -->
      <div class="vm-summary">
        <div class="card">
          <div class="card-header">가상 머신 ({{ vms().length }})</div>
          <div class="card-block vm-sum-row">
            <span><span class="os-dot" style="background:#e74c3c"></span>오류 <strong>{{ bucketCount('Error') }}</strong></span>
            <span><span class="os-dot" style="background:#2ecc71"></span>실행 중 <strong>{{ bucketCount('Running') }}</strong></span>
            <span><span class="os-dot" style="background:#f1c40f"></span>Stopped <strong>{{ bucketCount('Stopped') }}</strong></span>
            <span><span class="os-dot" style="background:#95a5a6"></span>기타 <strong>{{ bucketCount('Other') }}</strong></span>
          </div>
        </div>
        <div class="card">
          <div class="card-header">사용량 (실행 중 VM)</div>
          <div class="card-block vm-sum-row">
            <span>CPU <strong>{{ totalVcpu() }}</strong> vCPU</span>
            <span>메모리 <strong>{{ totalMemGb() }}</strong> GiB</span>
          </div>
        </div>
      </div>

      <app-resource-list title="Virtual Machines" path="/apis/kubevirt.io/v1/virtualmachines" [namespaced]="true"
        kind="VirtualMachine" [vm]="true" createLabel="Create VirtualMachine" (create)="creating.set(true)" [columns]="cols"></app-resource-list>
    </div>
  `,
})
export class VirtualMachinesComponent implements OnInit {
  private k8s = inject(K8sService);
  readonly creating = signal(false);
  readonly vms = signal<any[]>([]);

  ngOnInit(): void { this.reload(); }
  reload(): void {
    this.k8s.list('/apis/kubevirt.io/v1/virtualmachines').pipe(catchError(() => of({ items: [] as any[] })))
      .subscribe((r: any) => this.vms.set(r.items || []));
  }

  private bucket(v: any): string {
    const s = String(v.status?.printableStatus || '');
    if (s === 'Running') return 'Running';
    if (s === 'Stopped' || s === 'Paused') return 'Stopped';
    if (s.startsWith('Error') || s === 'CrashLoopBackOff' || s === 'Unschedulable') return 'Error';
    return 'Other';
  }
  bucketCount(b: string): number { return this.vms().filter(v => this.bucket(v) === b).length; }
  totalVcpu(): number { return this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmVcpu(v), 0); }
  totalMemGb(): string { return (this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmMemBytes(v), 0) / 1024 ** 3).toFixed(1); }

  cols: ColumnDef[] = [
    { id: 'os', label: '', kind: 'logo', get: o => osIdFromImage(o.spec?.template?.metadata?.annotations?.['vm.kubevirt.io/os'] || (o.spec?.template?.spec?.volumes || []).map((v: any) => v.containerDisk?.image).find(Boolean)) },
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.printableStatus || 'Unknown', statusOf: o => vmStatusColor(o.status?.printableStatus) },
    { id: 'ready', label: 'Ready', get: o => (o.status?.ready ? 'True' : 'False') },
    { id: 'node', label: 'Node', get: o => o.status?.nodeName || '—', facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
