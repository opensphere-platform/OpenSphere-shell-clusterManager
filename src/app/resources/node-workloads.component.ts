import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { K8sService } from '../core/k8s.service';

const isReady = (n: any) => !!n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True');
const nodeRoles = (n: any) => Object.keys(n.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).filter(Boolean).join(', ') || 'worker';
const kvm = (n: any) => !!(n.status?.allocatable?.['devices.kubevirt.io/kvm'] || n.status?.capacity?.['devices.kubevirt.io/kvm']);

/**
 * 운영 노드 중심 보기 — 각 노드에 어떤 VM·파드가 배치돼 있고 용량은 얼마인가(설치된 노드 개념).
 * nodes + pods(spec.nodeName) + VMIs(status.nodeName) 조인. VM 생성 시 nodeSelector로 노드 지정과 짝.
 */
@Component({
  selector: 'app-node-workloads',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styles: [`
    .nw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .nw-kv { display: grid; grid-template-columns: 90px 1fr; gap: .3rem .6rem; padding: .25rem 0; }
    .nw-kv dt { color: var(--clr-color-neutral-600, #666); }
    .nw-kv dd { margin: 0; }
    .nw-vms { margin-top: .6rem; display: flex; flex-wrap: wrap; gap: .3rem; }
  `],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2">노드 워크로드 <span class="label label-info">Node-centric</span></h2>
      <span class="os-sub" *ngIf="!loaded()">불러오는 중…</span>
      <button class="btn btn-sm btn-link os-ml-auto" (click)="load()">새로고침</button>
    </div>
    <p class="os-sub">운영 노드별 배치 현황 — 각 노드에 어떤 VM·파드가 올라가 있고 용량(CPU·메모리)·VM 가능 여부는 어떤가.</p>
    <div class="nw-grid">
      <div class="card" *ngFor="let n of nodeView()">
        <div class="card-header">
          {{ n.name }}
          <span class="label" [ngClass]="n.ready ? 'label-success' : 'label-danger'">{{ n.ready ? 'Ready' : 'NotReady' }}</span>
          <span class="label label-info" *ngIf="n.kvm">VM 가능</span>
        </div>
        <div class="card-block">
          <dl class="nw-kv">
            <dt>역할</dt><dd>{{ n.roles }}</dd>
            <dt>CPU</dt><dd>{{ n.cpu }} cores</dd>
            <dt>메모리</dt><dd>{{ n.mem }}</dd>
            <dt>파드</dt><dd>{{ n.podCount }}</dd>
            <dt>VM</dt><dd><strong>{{ n.vms.length }}</strong></dd>
          </dl>
          <div class="nw-vms" *ngIf="n.vms.length">
            <span class="label label-info" *ngFor="let v of n.vms">🖥 {{ v }}</span>
          </div>
          <div class="os-muted" *ngIf="!n.vms.length">이 노드에 VM 없음</div>
        </div>
      </div>
      <div *ngIf="!nodeView().length && loaded()" class="os-muted">노드 없음.</div>
    </div>
  `,
})
export class NodeWorkloadsComponent implements OnInit {
  private k8s = inject(K8sService);
  readonly nodes = signal<any[]>([]);
  readonly pods = signal<any[]>([]);
  readonly vmis = signal<any[]>([]);
  readonly loaded = signal(false);

  ngOnInit(): void { this.load(); }
  load(): void {
    this.loaded.set(false);
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      nodes: safe('/api/v1/nodes'),
      pods: safe('/api/v1/pods'),
      vmis: safe('/apis/kubevirt.io/v1/virtualmachineinstances'),
    }).subscribe(r => {
      this.nodes.set(r.nodes.items || []); this.pods.set(r.pods.items || []); this.vmis.set(r.vmis.items || []);
      this.loaded.set(true);
    });
  }

  readonly nodeView = computed(() => this.nodes().map(n => {
    const name = n.metadata?.name;
    const mem = n.status?.capacity?.memory;
    return {
      name, ready: isReady(n), roles: nodeRoles(n), kvm: kvm(n),
      cpu: n.status?.capacity?.cpu || '—',
      mem: mem ? (parseInt(mem, 10) / 1024 / 1024).toFixed(1) + ' GiB' : '—',
      podCount: this.pods().filter(p => p.spec?.nodeName === name).length,
      vms: this.vmis().filter(v => v.status?.nodeName === name).map(v => v.metadata?.name),
    };
  }));
}
