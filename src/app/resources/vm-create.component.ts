import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { dump } from 'js-yaml';
import { K8sService } from '../core/k8s.service';
import { isRfc1123 } from '../shared/k8s-validate';
import { CodeEditorComponent } from '../shared/code-editor.component';
import { OsLogoComponent } from '../shared/os-logo.component';
import { VmCreateInstancetypeComponent } from './vm-create-instancetype.component';

interface VmTemplate { id: string; logo: string; name: string; desc: string; image: string; cpu: number; mem: number; demo?: boolean; windows?: boolean; }

// 부팅 소스 카탈로그 — public containerDisk(quay.io/containerdisks/*) + 데모용 cirros.
const TEMPLATES: VmTemplate[] = [
  { id: 'cirros', logo: 'cirros', name: 'CirrOS', desc: '경량 데모 · 빠른 부팅', image: 'quay.io/kubevirt/cirros-container-disk-demo:latest', cpu: 1, mem: 1, demo: true },
  { id: 'fedora', logo: 'fedora', name: 'Fedora', desc: 'Fedora Linux', image: 'quay.io/containerdisks/fedora:latest', cpu: 1, mem: 2 },
  { id: 'centos', logo: 'centos', name: 'CentOS Stream 9', desc: 'CentOS Stream', image: 'quay.io/containerdisks/centos-stream:9', cpu: 1, mem: 2 },
  { id: 'ubuntu', logo: 'ubuntu', name: 'Ubuntu 24.04', desc: 'Ubuntu Server', image: 'quay.io/containerdisks/ubuntu:24.04', cpu: 1, mem: 2 },
  { id: 'debian', logo: 'debian', name: 'Debian 12', desc: 'Debian', image: 'quay.io/containerdisks/debian:12', cpu: 1, mem: 2 },
  { id: 'opensuse', logo: 'opensuse', name: 'openSUSE Leap', desc: 'openSUSE Leap 15.6', image: 'quay.io/containerdisks/opensuse-leap:15.6', cpu: 1, mem: 2 },
  { id: 'windows2022', logo: 'windows', name: 'Windows Server 2022', desc: 'hyperv·sata (Windows 이미지 필요)', image: 'quay.io/containerdisks/windows-server:2022', cpu: 2, mem: 4, windows: true },
  { id: 'windows11', logo: 'windows', name: 'Windows 11', desc: 'hyperv·sata (Windows 이미지 필요)', image: 'quay.io/containerdisks/windows:11', cpu: 2, mem: 4, windows: true },
];

/**
 * VirtualMachine 생성 — OpenShift Virtualization 템플릿 카탈로그 등가의 시각적 GUI.
 * OS 로고 카드 그리드에서 부팅 소스 선택 → 세부정보 폼 → containerDisk VM POST. YAML 미리보기 포함.
 * 콘솔 그룹 임퍼소네이션 write로 생성.
 */
@Component({
  selector: 'app-vm-create',
  standalone: true,
  imports: [CommonModule, ClarityModule, CodeEditorComponent, OsLogoComponent, VmCreateInstancetypeComponent],
  styles: [`
    .vm-cat { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 1rem; margin: 1rem 0 1.25rem; }
    .vm-card { position: relative; cursor: pointer; transition: box-shadow .12s, border-color .12s; }
    .vm-card:hover { border-color: var(--os-brand-500); box-shadow: var(--os-shadow-sm); }
    .vm-card.sel { border-color: var(--os-brand-500); box-shadow: 0 0 0 2px var(--os-brand-500); }
    .vm-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: .6rem; }
    .vm-card-name { font-weight: 700; font-size: .98rem; line-height: 1.2; }
    .vm-card-desc { color: var(--os-text-dim); font-size: .78rem; margin: .1rem 0 .7rem; }
    .vm-card-specs { display: grid; grid-template-columns: 1fr 1fr; gap: .25rem .5rem; margin: 0; font-size: .74rem; }
    .vm-card-specs dt { color: var(--os-text-dim); }
    .vm-card-specs dd { margin: 0; font-weight: 600; }
    .vm-form { max-width: 760px; margin-top: .5rem; }
    .vm-form-h { display: flex; align-items: center; gap: .5rem; }
    .vm-grid { padding: 0 var(--os-space-4); }
    .vm-grid input, .vm-grid select { width: min(100%, 30rem); }
    .vm-form-actions { padding: 0 var(--os-space-4) var(--os-space-3); }
    .vm-yaml-preview { padding: 0 var(--os-space-4) var(--os-space-4); }
  `],
  template: `
    <div class="os-page-header">
      <div class="os-page-header-main">
        <p class="os-page-eyebrow">Kubernetes virtualization</p>
        <h2 class="os-page-title">새 VirtualMachine 생성</h2>
        <p class="os-page-description">검증된 InstanceType 또는 부팅 소스 카탈로그에서 가상 머신 구성을 선택합니다.</p>
      </div>
    </div>
    <clr-tabs aria-label="VirtualMachine 생성 방식">
      <clr-tab><button clrTabLink type="button" (click)="mode.set('instancetype')">InstanceTypes</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
      <clr-tab><button clrTabLink type="button" (click)="mode.set('catalog')">템플릿 카탈로그</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
    </clr-tabs>
    <app-vm-create-instancetype *ngIf="mode()==='instancetype'" (created)="created.emit()" (cancel)="cancel.emit()"></app-vm-create-instancetype>
    <p class="os-sub" *ngIf="mode()==='catalog'">부팅 소스(운영체제)를 선택하면 세부 정보를 구성할 수 있습니다.</p>

    <clr-alert *ngIf="msg()" [clrAlertType]="ok() ? 'success' : 'danger'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">{{ msg() }}</span></clr-alert-item>
    </clr-alert>

    <!-- ===== OS 로고 카탈로그 ===== -->
    <div class="vm-cat" *ngIf="mode()==='catalog'">
      <div class="card vm-card" *ngFor="let t of templates" [class.sel]="sel()?.id === t.id"
           role="button" tabindex="0" (click)="pick(t)" (keydown.enter)="pick(t)">
        <div class="vm-card-top">
          <app-os-logo [os]="t.logo" [size]="42"></app-os-logo>
          <span class="label" [ngClass]="t.demo ? 'label-warning' : 'label-info'">{{ t.demo ? '데모' : '소스 사용 가능' }}</span>
        </div>
        <div class="vm-card-name">{{ t.name }}</div>
        <div class="vm-card-desc">{{ t.desc }}</div>
        <dl class="vm-card-specs">
          <dt>부팅 소스</dt><dd>containerDisk</dd>
          <dt>CPU</dt><dd>{{ t.cpu }} vCPU</dd>
          <dt>메모리</dt><dd>{{ t.mem }} GiB</dd>
          <dt>아키텍처</dt><dd>amd64</dd>
        </dl>
      </div>
    </div>

    <!-- ===== 선택 시 세부 정보 폼 ===== -->
    <div class="card vm-form" *ngIf="catalogSel() as t">
      <div class="card-header vm-form-h"><app-os-logo [os]="t.logo" [size]="22"></app-os-logo> {{ t.name }} — VirtualMachine 세부 정보</div>
      <form clrForm clrLayout="horizontal" class="vm-grid">
        <clr-input-container><label>이름</label><input clrInput type="text" name="vmName" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="my-vm" /></clr-input-container>
        <clr-input-container><label>Namespace</label><input clrInput type="text" name="vmNamespace" [value]="ns()" (input)="ns.set($any($event.target).value)" /></clr-input-container>
        <clr-input-container><label>CPU (vCPU)</label><input clrInput type="number" name="vmCpu" min="1" [value]="cpu()" (input)="cpu.set(+$any($event.target).value)" /></clr-input-container>
        <clr-input-container><label>Memory (GiB)</label><input clrInput type="number" name="vmMemory" min="1" [value]="mem()" (input)="mem.set(+$any($event.target).value)" /></clr-input-container>
        <clr-input-container><label>부팅 이미지</label><input clrInput type="text" name="vmImage" [value]="image()" (input)="image.set($any($event.target).value)" /></clr-input-container>
        <clr-select-container><label>노드</label><select clrSelect name="vmNode" (change)="selNode.set($any($event.target).value)">
          <option value="">— 배치할 노드 선택 (필수) —</option><option *ngFor="let n of nodes()" [value]="n" [selected]="selNode() === n">{{ n }}</option>
        </select></clr-select-container>
        <clr-checkbox-container><clr-checkbox-wrapper><input clrCheckbox type="checkbox" name="vmStart" [checked]="start()" (change)="start.set($any($event.target).checked)" /><label>생성 후 시작</label></clr-checkbox-wrapper></clr-checkbox-container>
      </form>
      <div class="os-actions vm-form-actions">
        <button class="btn btn-sm btn-primary" [disabled]="busy() || !name().trim() || !selNode()" (click)="submit()">VirtualMachine 생성</button>
        <button class="btn btn-sm btn-outline" (click)="showYaml.set(!showYaml())">{{ showYaml() ? 'YAML 숨기기' : 'YAML 및 CLI 보기' }}</button>
        <button class="btn btn-sm btn-link" [disabled]="busy()" (click)="cancel.emit()">취소</button>
      </div>
      <div *ngIf="showYaml()" class="vm-yaml-preview">
        <app-code-editor [value]="yamlPreview()" language="yaml" [readOnly]="true" height="380px"></app-code-editor>
      </div>
    </div>
  `,
})
export class VmCreateComponent implements OnInit {
  @Output() created = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  private k8s = inject(K8sService);
  readonly templates = TEMPLATES;
  readonly nodes = signal<string[]>([]);
  readonly selNode = signal('');
  readonly mode = signal<'instancetype' | 'catalog'>('instancetype');
  readonly sel = signal<VmTemplate | null>(null);
  readonly catalogSel = computed(() => this.mode() === 'catalog' ? this.sel() : null);
  readonly name = signal('');
  readonly ns = signal('default');
  readonly cpu = signal(1);
  readonly mem = signal(1);
  readonly image = signal('');
  readonly start = signal(true);
  readonly showYaml = signal(false);
  readonly busy = signal(false);
  readonly msg = signal<string | null>(null);
  readonly ok = signal(false);

  ngOnInit(): void {
    this.k8s.list('/api/v1/nodes').pipe(catchError(() => of({ items: [] as any[] })))
      .subscribe((r: any) => this.nodes.set((r.items || []).map((n: any) => n.metadata?.name).filter(Boolean)));
  }

  pick(t: VmTemplate): void {
    this.sel.set(t);
    this.cpu.set(t.cpu); this.mem.set(t.mem); this.image.set(t.image);
    this.msg.set(null);
  }

  private buildVm(): any {
    const nm = this.name().trim() || 'my-vm';
    const ns = this.ns().trim() || 'default';
    const win = !!this.sel()?.windows;
    return {
      apiVersion: 'kubevirt.io/v1',
      kind: 'VirtualMachine',
      metadata: { name: nm, namespace: ns, labels: { app: nm, 'vm.kubevirt.io/template': this.sel()?.id || '' } },
      spec: {
        running: this.start(),
        template: {
          metadata: { labels: { 'kubevirt.io/domain': nm }, annotations: { 'vm.kubevirt.io/os': this.sel()?.id || '' } },
          spec: {
            nodeSelector: { 'kubernetes.io/hostname': this.selNode() },
            domain: {
              cpu: { cores: this.cpu() },
              memory: { guest: `${this.mem()}Gi` },
              ...(win ? { features: { acpi: {}, apic: {}, hyperv: { relaxed: {}, vapic: {}, spinlocks: { spinlocks: 8191 } } }, clock: { utc: {}, timer: { hpet: { present: false }, pit: { tickPolicy: 'delay' }, rtc: { tickPolicy: 'catchup' }, hyperv: {} } } } : {}),
              devices: {
                disks: [{ name: 'containerdisk', disk: { bus: win ? 'sata' : 'virtio' } }],
                interfaces: [{ name: 'default', masquerade: {}, ...(win ? { model: 'e1000e' } : {}) }],
              },
            },
            networks: [{ name: 'default', pod: {} }],
            volumes: [{ name: 'containerdisk', containerDisk: { image: this.image() } }],
          },
        },
      },
    };
  }

  yamlPreview(): string { try { return dump(this.buildVm()); } catch { return ''; } }

  submit(): void {
    const nm = this.name().trim();
    const ns = this.ns().trim() || 'default';
    if (!isRfc1123(nm)) {
      this.ok.set(false); this.msg.set('이름은 소문자/숫자/하이픈만(시작·끝은 영숫자).'); return;
    }
    this.busy.set(true); this.msg.set(null);
    this.k8s.post(`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines`, this.buildVm()).subscribe({
      next: () => { this.busy.set(false); this.ok.set(true); this.msg.set('생성됨.'); this.created.emit(); },
      error: e => { this.busy.set(false); this.ok.set(false); this.msg.set(e?.error?.message || e?.error?.error || e?.message || String(e)); },
    });
  }
}
