import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';

// OpenShift Virtualization "Create VirtualMachine (from InstanceType)" 플로우 클론 — 더미(예시).
interface Vol { id: string; os: string; icon: string; label: string; size: string; sc: string; }
interface IType { id: string; series: string; cpu: number; mem: string; }

@Component({
  selector: 'app-dummy-vm-create',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule],
  styleUrls: ['./dummy-vm-create.css'],
  template: `
    <div class="vc-head">
      <h1 class="vc-h1">VirtualMachine 생성</h1>
      <span class="label label-info">InstanceType 방식</span>
      <span class="label label-warning">DUMMY · 예시</span>
    </div>
    <p class="vc-sec-sub">부팅 볼륨과 InstanceType을 고르면 자동으로 VirtualMachine이 구성됩니다. (OpenShift Virtualization 참고 클론)</p>

    <div class="vc">
      <div class="vc-main">
        <!-- 1. 부팅 볼륨 -->
        <div>
          <p class="vc-sec-h"><span class="vc-step">1</span>부팅할 볼륨 선택</p>
          <p class="vc-sec-sub">OS 이미지(bootable volume)를 선택합니다.</p>
          <div class="vc-cards">
            <div class="vc-card" *ngFor="let v of vols" [class.sel]="vol()?.id === v.id" (click)="pickVol(v)">
              <span class="vc-card-ic">{{ v.icon }}</span>
              <span class="vc-card-t">{{ v.label }}</span>
              <span class="vc-card-m">{{ v.os }}</span>
              <span class="vc-card-m">{{ v.size }} · {{ v.sc }}</span>
            </div>
          </div>
        </div>

        <!-- 2. InstanceType -->
        <div>
          <p class="vc-sec-h"><span class="vc-step">2</span>InstanceType 선택</p>
          <p class="vc-sec-sub">Red Hat 제공 시리즈 — vCPU·메모리 묶음.</p>
          <div class="vc-tabs">
            <button type="button" class="vc-tab" *ngFor="let s of series" [class.on]="tab() === s" (click)="tab.set(s)">{{ s }}</button>
          </div>
          <div class="vc-cards">
            <div class="vc-card" *ngFor="let t of typesFor()" [class.sel]="itype()?.id === t.id" (click)="itype.set(t)">
              <span class="vc-card-t">{{ t.id }}</span>
              <span class="vc-card-m">{{ t.cpu }} vCPU · {{ t.mem }}</span>
            </div>
          </div>
        </div>

        <!-- 3. 세부정보 -->
        <div class="vc-form">
          <p class="vc-sec-h"><span class="vc-step">3</span>VirtualMachine 세부정보</p>
          <label>이름 (Name)</label>
          <input type="text" [(ngModel)]="nameVal" />
          <label>프로젝트 (Namespace)</label>
          <select [(ngModel)]="projVal">
            <option>cmars-dev</option><option>default</option><option>openshift-virtualization</option>
          </select>
          <label>Public SSH key (선택)</label>
          <input type="text" placeholder="ssh-ed25519 AAAA… (선택)" [(ngModel)]="sshVal" />
          <label class="vc-chk"><input type="checkbox" [(ngModel)]="startVal" /> 생성 후 이 VirtualMachine 시작</label>
        </div>
      </div>

      <!-- 요약 -->
      <aside class="vc-aside">
        <div class="vc-summary">
          <h4>VirtualMachine 요약</h4>
          <table>
            <tr><td class="k">운영체제</td><td>{{ vol()?.os || '—' }}</td></tr>
            <tr><td class="k">부팅 볼륨</td><td>{{ vol()?.label || '—' }}</td></tr>
            <tr><td class="k">이름</td><td>{{ nameVal || '—' }}</td></tr>
            <tr><td class="k">프로젝트</td><td>{{ projVal }}</td></tr>
            <tr><td class="k">InstanceType</td><td>{{ itype()?.id || '—' }}</td></tr>
            <tr><td class="k">vCPU · 메모리</td><td>{{ itype() ? itype()!.cpu + ' vCPU · ' + itype()!.mem : '—' }}</td></tr>
            <tr><td class="k">시작 정책</td><td>{{ startVal ? '생성 후 시작' : '중지 상태로 생성' }}</td></tr>
          </table>
          <div class="vc-foot">
            <button type="button" class="btn btn-primary btn-sm" [disabled]="!canCreate()" (click)="doCreate()">VirtualMachine 생성</button>
            <button type="button" class="btn btn-outline btn-sm" (click)="cancel.emit()">취소</button>
          </div>
          <div class="vc-note" *ngIf="!canCreate()">볼륨·InstanceType·이름을 모두 선택하면 생성할 수 있습니다.</div>
          <div class="vc-note" *ngIf="canCreate()">예시(더미) 플로우 — 실제 KubeVirt 객체는 생성되지 않고 목록에 예시 행으로 추가됩니다.</div>
        </div>
      </aside>
    </div>
  `,
})
export class DummyVmCreateComponent {
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<any>();

  vols: Vol[] = [
    { id: 'centos9', os: 'CentOS Stream 9', icon: '🟣', label: 'centos-stream9', size: '30 GiB', sc: 'ceph-rbd' },
    { id: 'fedora', os: 'Fedora 41', icon: '🔵', label: 'fedora', size: '30 GiB', sc: 'ceph-rbd' },
    { id: 'rhel9', os: 'RHEL 9', icon: '🔴', label: 'rhel9', size: '30 GiB', sc: 'ceph-rbd' },
    { id: 'ubuntu', os: 'Ubuntu 24.04 LTS', icon: '🟠', label: 'ubuntu2404', size: '25 GiB', sc: 'ceph-rbd' },
    { id: 'win2022', os: 'Windows Server 2022', icon: '🟦', label: 'windows2022', size: '60 GiB', sc: 'ceph-rbd' },
  ];
  series = ['General Purpose (U)', 'Compute (CX)', 'Memory (M)'];
  types: IType[] = [
    { id: 'u1.small', series: 'General Purpose (U)', cpu: 1, mem: '2 GiB' },
    { id: 'u1.medium', series: 'General Purpose (U)', cpu: 1, mem: '4 GiB' },
    { id: 'u1.large', series: 'General Purpose (U)', cpu: 2, mem: '8 GiB' },
    { id: 'u1.xlarge', series: 'General Purpose (U)', cpu: 4, mem: '16 GiB' },
    { id: 'cx1.medium', series: 'Compute (CX)', cpu: 1, mem: '2 GiB' },
    { id: 'cx1.large', series: 'Compute (CX)', cpu: 2, mem: '4 GiB' },
    { id: 'cx1.xlarge', series: 'Compute (CX)', cpu: 4, mem: '8 GiB' },
    { id: 'm1.large', series: 'Memory (M)', cpu: 2, mem: '16 GiB' },
    { id: 'm1.xlarge', series: 'Memory (M)', cpu: 4, mem: '32 GiB' },
  ];

  readonly vol = signal<Vol | null>(null);
  readonly itype = signal<IType | null>(null);
  readonly tab = signal(this.series[0]);
  nameVal = '';
  projVal = 'cmars-dev';
  sshVal = '';
  startVal = true;

  readonly typesFor = computed(() => this.types.filter(t => t.series === this.tab()));

  pickVol(v: Vol) {
    this.vol.set(v);
    if (!this.nameVal || /-[a-z]+-[a-z]+-\d+$/.test(this.nameVal)) {
      const adj = ['emerald', 'cosmic', 'silent', 'amber', 'rapid', 'cobalt'];
      const noun = ['lynx', 'otter', 'falcon', 'fox', 'heron', 'puma'];
      const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
      this.nameVal = `${v.label}-${pick(adj)}-${pick(noun)}-${Math.floor(Math.random() * 90 + 10)}`;
    }
  }
  canCreate() { return !!this.vol() && !!this.itype() && !!this.nameVal.trim(); }
  doCreate() {
    if (!this.canCreate()) return;
    this.created.emit({
      metadata: { name: this.nameVal.trim(), namespace: this.projVal, creationTimestamp: new Date().toISOString() },
      status: this.startVal ? 'Provisioning' : 'Stopped',
      conditions: this.startVal ? '—' : 'Stopped',
      node: this.startVal ? '(scheduling)' : '—',
      ip: '—',
    });
  }
}
