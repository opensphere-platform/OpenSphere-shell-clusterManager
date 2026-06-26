import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { K8sService } from '../core/k8s.service';

/**
 * VirtualMachine 생성 폼(증분 3) — 실 KubeVirt POST.
 * containerDisk + masquerade pod 네트워크의 최소 부팅 가능 VM. 콘솔 그룹 임퍼소네이션 write로 생성.
 * VirtualMachinesComponent가 createLabel 버튼→creating 토글로 이 폼을 띄운다.
 */
@Component({
  selector: 'app-vm-create',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styles: [`
    .vm-form { max-width: 660px; }
    .vm-grid { padding: 1rem; display: grid; grid-template-columns: 150px 1fr; gap: .7rem 1rem; align-items: center; }
    .vm-grid input[type=text], .vm-grid input[type=number] { width: 100%; max-width: 360px; }
    .vm-grid label { font-weight: 600; }
  `],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2">Create VirtualMachine <span class="label label-info">KubeVirt</span></h2>
    </div>

    <div *ngIf="msg()" class="alert" [ngClass]="ok() ? 'alert-success' : 'alert-danger'" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ msg() }}</span></div></div>
    </div>

    <div class="card vm-form">
      <div class="card-header">VM 사양</div>
      <div class="vm-grid">
        <label>Name</label>
        <input type="text" class="os-search" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="my-vm" />
        <label>Namespace</label>
        <input type="text" class="os-search" [value]="ns()" (input)="ns.set($any($event.target).value)" />
        <label>CPU (cores)</label>
        <input type="number" min="1" class="os-num" [value]="cpu()" (input)="cpu.set(+$any($event.target).value)" />
        <label>Memory (Gi)</label>
        <input type="number" min="1" class="os-num" [value]="mem()" (input)="mem.set(+$any($event.target).value)" />
        <label>Boot image</label>
        <input type="text" class="os-search" [value]="image()" (input)="image.set($any($event.target).value)" />
        <label>Start on create</label>
        <span><input type="checkbox" [checked]="start()" (change)="start.set($any($event.target).checked)" /></span>
      </div>
      <div class="os-actions" style="padding: 0 1rem 0.75rem">
        <button class="btn btn-sm btn-primary" [disabled]="busy() || !name().trim()" (click)="submit()">Create</button>
        <button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="cancel.emit()">Cancel</button>
      </div>
      <div class="os-muted" style="padding: 0 1rem 1rem">containerDisk + masquerade pod 네트워크의 최소 VM. 에뮬레이션 환경에선 기동이 느릴 수 있습니다. 기본 이미지는 cirros(경량 데모).</div>
    </div>
  `,
})
export class VmCreateComponent {
  @Output() created = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  private k8s = inject(K8sService);
  readonly name = signal('');
  readonly ns = signal('default');
  readonly cpu = signal(1);
  readonly mem = signal(1);
  readonly image = signal('quay.io/kubevirt/cirros-container-disk-demo:latest');
  readonly start = signal(true);
  readonly busy = signal(false);
  readonly msg = signal<string | null>(null);
  readonly ok = signal(false);

  submit(): void {
    const nm = this.name().trim();
    const ns = this.ns().trim() || 'default';
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(nm)) {
      this.ok.set(false); this.msg.set('이름은 소문자/숫자/하이픈만(시작·끝은 영숫자).'); return;
    }
    const vm = {
      apiVersion: 'kubevirt.io/v1',
      kind: 'VirtualMachine',
      metadata: { name: nm, namespace: ns, labels: { app: nm } },
      spec: {
        running: this.start(),
        template: {
          metadata: { labels: { 'kubevirt.io/domain': nm } },
          spec: {
            domain: {
              cpu: { cores: this.cpu() },
              memory: { guest: `${this.mem()}Gi` },
              devices: {
                disks: [{ name: 'containerdisk', disk: { bus: 'virtio' } }],
                interfaces: [{ name: 'default', masquerade: {} }],
              },
            },
            networks: [{ name: 'default', pod: {} }],
            volumes: [{ name: 'containerdisk', containerDisk: { image: this.image() } }],
          },
        },
      },
    };
    this.busy.set(true);
    this.msg.set(null);
    this.k8s.post(`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines`, vm).subscribe({
      next: () => { this.busy.set(false); this.ok.set(true); this.msg.set('생성됨.'); this.created.emit(); },
      error: e => { this.busy.set(false); this.ok.set(false); this.msg.set(e?.error?.message || e?.error?.error || e?.message || String(e)); },
    });
  }
}
