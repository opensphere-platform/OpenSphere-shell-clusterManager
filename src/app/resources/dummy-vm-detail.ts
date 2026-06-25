import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';

// VirtualMachine 상세 — OpenShift VM 상세(Overview/YAML/Events) 참고 클론(더미).
@Component({
  selector: 'app-dummy-vm-detail',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styleUrls: ['./dummy-vm-detail.css'],
  template: `
    <div class="vd-head">
      <button class="vd-back" (click)="back.emit()">‹ Virtual Machines</button>
      <h1 class="vd-h1">{{ vm?.metadata?.name }}</h1>
      <span class="label" [ngClass]="statusClass()">{{ vm?.status }}</span>
      <span class="label label-warning">DUMMY · 예시</span>
      <span class="vd-actions">
        <button class="btn btn-sm btn-outline" type="button">{{ vm?.status === 'Running' ? '중지' : '시작' }}</button>
        <button class="btn btn-sm btn-outline" type="button">재시작</button>
        <button class="btn btn-sm btn-outline" type="button">콘솔 열기</button>
      </span>
    </div>

    <div class="vd-tabs">
      <button class="vd-tab" *ngFor="let t of tabs" [class.on]="tab() === t" (click)="tab.set(t)">{{ t }}</button>
    </div>

    <!-- Overview -->
    <div *ngIf="tab() === 'Overview'">
      <div class="vd-grid">
        <div class="vd-card">
          <h4>세부정보 (Details)</h4>
          <table>
            <tr><td class="k">Name</td><td>{{ vm?.metadata?.name }}</td></tr>
            <tr><td class="k">Namespace</td><td>{{ vm?.metadata?.namespace }}</td></tr>
            <tr><td class="k">Status</td><td>{{ vm?.status }}</td></tr>
            <tr><td class="k">Operating system</td><td>{{ os() }}</td></tr>
            <tr><td class="k">Node</td><td>{{ vm?.node }}</td></tr>
            <tr><td class="k">IP address</td><td>{{ vm?.ip }}</td></tr>
            <tr><td class="k">Created</td><td>{{ vm?.metadata?.creationTimestamp }}</td></tr>
          </table>
        </div>
        <div class="vd-card">
          <h4>구성 (Configuration)</h4>
          <table>
            <tr><td class="k">InstanceType</td><td>u1.large</td></tr>
            <tr><td class="k">vCPU · Memory</td><td>2 vCPU · 8 GiB</td></tr>
            <tr><td class="k">Boot volume</td><td>{{ vm?.metadata?.name }}-rootdisk (30 GiB · ceph-rbd)</td></tr>
            <tr><td class="k">Network</td><td>default (Pod network) · masquerade</td></tr>
            <tr><td class="k">Boot order</td><td>1. rootdisk · 2. cloudinitdisk</td></tr>
          </table>
        </div>
        <div class="vd-card">
          <h4>활용 (Utilization)</h4>
          <div class="vd-util">
            <div class="u"><div class="n">14%</div><div class="l">CPU</div></div>
            <div class="u"><div class="n">38%</div><div class="l">Memory</div></div>
            <div class="u"><div class="n">2.1 MBps</div><div class="l">Network</div></div>
            <div class="u"><div class="n">0.4 MBps</div><div class="l">Storage</div></div>
          </div>
        </div>
        <div class="vd-card">
          <h4>스냅샷 / 디스크</h4>
          <table>
            <tr><td class="k">rootdisk</td><td>30 GiB · ceph-rbd · Bound</td></tr>
            <tr><td class="k">cloudinitdisk</td><td>cloud-init (no-cloud)</td></tr>
            <tr><td class="k">최근 스냅샷</td><td>—</td></tr>
          </table>
        </div>
      </div>
    </div>

    <!-- YAML -->
    <div *ngIf="tab() === 'YAML'">
      <pre class="vd-yaml">{{ yaml() }}</pre>
    </div>

    <!-- Events -->
    <div *ngIf="tab() === 'Events'">
      <table class="vd-ev">
        <thead><tr><th>Type</th><th>Reason</th><th>Message</th><th>Age</th></tr></thead>
        <tbody>
          <tr><td>Normal</td><td>SuccessfulCreate</td><td>Created virtual machine pod virt-launcher-{{ vm?.metadata?.name }}</td><td>2m</td></tr>
          <tr><td>Normal</td><td>Scheduled</td><td>Successfully assigned {{ vm?.metadata?.namespace }}/virt-launcher to {{ vm?.node }}</td><td>2m</td></tr>
          <tr><td>Normal</td><td>Started</td><td>VirtualMachineInstance started</td><td>1m</td></tr>
        </tbody>
      </table>
    </div>
  `,
})
export class DummyVmDetailComponent {
  @Input() vm: any;
  @Output() back = new EventEmitter<void>();
  readonly tabs = ['Overview', 'YAML', 'Events'];
  readonly tab = signal('Overview');

  os(): string {
    const n = (this.vm?.metadata?.name || '').toLowerCase();
    if (n.startsWith('centos')) return 'CentOS Stream 9';
    if (n.startsWith('fedora')) return 'Fedora 41';
    if (n.startsWith('rhel')) return 'RHEL 9';
    if (n.startsWith('ubuntu')) return 'Ubuntu 24.04 LTS';
    if (n.startsWith('win')) return 'Windows Server 2022';
    return 'Linux';
  }
  statusClass(): Record<string, boolean> {
    const s = this.vm?.status;
    return { 'label-success': s === 'Running', 'label-warning': s === 'Stopped', 'label-info': s === 'Provisioning' || s === 'Starting', 'label-danger': s === 'Error' };
  }
  yaml(): string {
    const m = this.vm?.metadata || {};
    return `apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: ${m.name}
  namespace: ${m.namespace}
  labels:
    app: ${m.name}
    kubevirt.io/dynamic-credentials-support: "true"
spec:
  running: ${this.vm?.status !== 'Stopped'}
  instancetype:
    name: u1.large
  preference:
    name: ${this.os().toLowerCase().split(' ')[0]}
  template:
    metadata:
      labels:
        kubevirt.io/domain: ${m.name}
    spec:
      domain:
        devices:
          disks:
            - name: rootdisk
              disk: { bus: virtio }
            - name: cloudinitdisk
              disk: { bus: virtio }
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume: { name: ${m.name}-rootdisk }
        - name: cloudinitdisk
          cloudInitNoCloud:
            userData: |
              #cloud-config
              user: cloud-user`;
  }
}
