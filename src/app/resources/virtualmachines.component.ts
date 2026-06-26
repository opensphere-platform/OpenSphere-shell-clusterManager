import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';
import { VmCreateComponent } from './vm-create.component';
import { osIdFromImage } from '../shared/os-logo.component';
import { K8sService } from '../core/k8s.service';

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
 * KubeVirt VirtualMachine 목록 — OpenShift Virtualization VM 목록 등가:
 * 상단 요약 밴드(네임스페이스 + 가상 머신 상태 + 사용량) + 테이블(OS 로고·상태·조건·행 액션 ⋮).
 * 행 이름 클릭 → vm-detail 드로어. ⋮ → 시작/정지/재시작/삭제(그룹 임퍼소네이션 write).
 */
@Component({
  selector: 'app-res-virtualmachines',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceListComponent, VmCreateComponent],
  styles: [`
    .vm-summary { display: grid; grid-template-columns: 1fr 1.4fr 1.1fr; gap: 1rem; margin: .25rem 0 1rem; }
    .vm-sum-row { display: flex; gap: 1.5rem; flex-wrap: wrap; padding: .8rem 1rem; align-items: center; }
    .vm-sum-row .os-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: .35rem; }
    .vm-sum-row strong { font-size: 1.05rem; }
    @media (max-width: 1000px) { .vm-summary { grid-template-columns: 1fr; } }
  `],
  template: `
    <app-vm-create *ngIf="creating()" (created)="creating.set(false); reload()" (cancel)="creating.set(false)"></app-vm-create>
    <div *ngIf="!creating()">
      <!-- 요약 밴드 (OpenShift Virtualization 목록 등가) -->
      <div class="vm-summary">
        <div class="card">
          <div class="card-header">프로젝트</div>
          <div class="card-block vm-sum-row">
            <span *ngFor="let ns of namespaces()" class="label label-info">{{ ns }}</span>
            <span *ngIf="!namespaces().length" class="os-muted">—</span>
          </div>
        </div>
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
          <div class="card-header">사용량 (실행 중)</div>
          <div class="card-block vm-sum-row">
            <span>CPU <strong>{{ totalVcpu() }}</strong> vCPU</span>
            <span>메모리 <strong>{{ totalMemGb() }}</strong> GiB</span>
          </div>
        </div>
      </div>

      <app-resource-list title="Virtual Machines" path="/apis/kubevirt.io/v1/virtualmachines" [namespaced]="true"
        kind="VirtualMachine" [vm]="true" createLabel="Create VirtualMachine" (create)="creating.set(true)"
        [columns]="cols" [rowActions]="vmActions"></app-resource-list>
    </div>
  `,
})
export class VirtualMachinesComponent implements OnInit {
  private k8s = inject(K8sService);
  @ViewChild(ResourceListComponent) list?: ResourceListComponent;
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
  namespaces(): string[] { return [...new Set(this.vms().map(v => v.metadata?.namespace).filter(Boolean))]; }

  // ── 행 액션(⋮): 시작/정지/재시작/삭제 ──
  private isRunning(v: any): boolean {
    const s = v.spec || {};
    if (typeof s.running === 'boolean') return s.running;
    if (s.runStrategy) return s.runStrategy !== 'Halted' && s.runStrategy !== 'Manual';
    return v.status?.printableStatus === 'Running';
  }
  private runPatch(v: any, on: boolean): any {
    const s = v.spec || {};
    return (s.runStrategy && typeof s.running !== 'boolean') ? { spec: { runStrategy: on ? 'Always' : 'Halted' } } : { spec: { running: on } };
  }
  vmActions = (vm: any): Array<{ label: string; danger?: boolean; run: () => void }> => {
    const ns = vm.metadata?.namespace, name = vm.metadata?.name;
    const path = `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}`;
    const sub = (s: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}/${s}`;
    const after = () => { setTimeout(() => { this.list?.load(); this.reload(); }, 500); };
    const running = this.isRunning(vm);
    const acts: Array<{ label: string; danger?: boolean; run: () => void }> = [];
    if (!running) acts.push({ label: '시작', run: () => this.k8s.patchMerge(path, this.runPatch(vm, true)).subscribe(after) });
    if (running) acts.push({ label: '정지', run: () => this.k8s.patchMerge(path, this.runPatch(vm, false)).subscribe(after) });
    if (running) acts.push({ label: '재시작', run: () => this.k8s.post(sub('restart'), {}).subscribe(after) });
    acts.push({ label: '삭제', danger: true, run: () => this.k8s.remove(path).subscribe(after) });
    return acts;
  };

  cols: ColumnDef[] = [
    { id: 'os', label: '', kind: 'logo', get: o => osIdFromImage(o.spec?.template?.metadata?.annotations?.['vm.kubevirt.io/os'] || (o.spec?.template?.spec?.volumes || []).map((v: any) => v.containerDisk?.image).find(Boolean)) },
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.printableStatus || 'Unknown', statusOf: o => vmStatusColor(o.status?.printableStatus) },
    { id: 'conditions', label: 'Conditions', kind: 'tags', get: o => (o.status?.conditions || []).filter((c: any) => c.status === 'True').map((c: any) => c.type) },
    { id: 'node', label: 'Node', get: o => o.status?.nodeName || '—', facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
