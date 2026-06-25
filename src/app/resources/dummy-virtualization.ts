import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';
import { DummyVmCreateComponent } from './dummy-vm-create';
import { DummyVmDetailComponent } from './dummy-vm-detail';

// OpenShift Virtualization(KubeVirt) 페이지 참고 — 더미(예시) 데이터. 후속 KubeVirt 연동 시 path 기반으로 교체.
const vmStatus = (s: string): 'success' | 'warning' | 'info' | 'danger' | 'unknown' =>
  s === 'Running' ? 'success' : s === 'Stopped' ? 'warning' : s === 'Provisioning' || s === 'Starting' ? 'info' : s === 'Error' ? 'danger' : 'unknown';

// 목록 ↔ 생성 위저드 ↔ 상세 를 전환하는 래퍼(딥 더미).
@Component({
  selector: 'app-dummy-virtualmachines',
  standalone: true,
  imports: [CommonModule, ResourceListComponent, DummyVmCreateComponent, DummyVmDetailComponent],
  template: `
    <app-resource-list *ngIf="mode() === 'list'"
      title="Virtual Machines" path="dummy" [namespaced]="true" [dummy]="true"
      createLabel="가상머신 생성" [staticRows]="rows()" [columns]="cols"
      (create)="mode.set('create')" (rowClick)="openDetail($event)" />
    <app-dummy-vm-create *ngIf="mode() === 'create'"
      (cancel)="mode.set('list')" (created)="onCreated($event)" />
    <app-dummy-vm-detail *ngIf="mode() === 'detail'"
      [vm]="selected()" (back)="mode.set('list')" />
  `,
})
export class DummyVirtualMachinesComponent {
  readonly mode = signal<'list' | 'create' | 'detail'>('list');
  readonly selected = signal<any>(null);
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status, statusOf: o => vmStatus(o.status) },
    { id: 'conditions', label: 'Conditions', get: o => o.conditions },
    { id: 'node', label: 'Node', get: o => o.node },
    { id: 'ip', label: 'IP address', get: o => o.ip },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  readonly rows = signal<any[]>([
    { metadata: { name: 'centos-stream9-emerald-lynx-24', namespace: 'cmars-dev', creationTimestamp: '2026-06-16T09:12:00Z' }, status: 'Running', conditions: 'Ready', node: 'desktop-worker', ip: '10.128.2.31' },
    { metadata: { name: 'fedora-cosmic-otter-88', namespace: 'cmars-dev', creationTimestamp: '2026-06-18T14:40:00Z' }, status: 'Running', conditions: 'Ready', node: 'desktop-worker2', ip: '10.128.2.45' },
    { metadata: { name: 'rhel9-silent-falcon-12', namespace: 'cmars-dev', creationTimestamp: '2026-06-14T03:20:00Z' }, status: 'Stopped', conditions: '—', node: '—', ip: '—' },
    { metadata: { name: 'win2022-amber-fox-07', namespace: 'cmars-dev', creationTimestamp: '2026-06-19T07:55:00Z' }, status: 'Provisioning', conditions: '—', node: 'desktop-worker3', ip: '—' },
  ]);
  openDetail(vm: any) { this.selected.set(vm); this.mode.set('detail'); }
  onCreated(vm: any) { this.rows.update(r => [vm, ...r]); this.mode.set('list'); }
}

@Component({
  selector: 'app-dummy-vmtemplates',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Templates" path="dummy" [namespaced]="true" [dummy]="true" createLabel="템플릿 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyVmTemplatesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'workload', label: 'Workload profile', get: o => o.workload },
    { id: 'boot', label: 'Boot source', kind: 'status', get: o => o.boot, statusOf: o => (o.boot === 'Source available' ? 'success' : 'warning') },
    { id: 'cpumem', label: 'CPU | Memory', get: o => o.cpumem },
  ];
  rows = [
    { metadata: { name: 'centos-stream9-server-small', namespace: 'openshift' }, workload: 'server', boot: 'Source available', cpumem: '1 CPU | 2 GiB' },
    { metadata: { name: 'fedora-server-medium', namespace: 'openshift' }, workload: 'server', boot: 'Source available', cpumem: '1 CPU | 2 GiB' },
    { metadata: { name: 'rhel9-server-small', namespace: 'openshift' }, workload: 'server', boot: 'Source available', cpumem: '1 CPU | 2 GiB' },
    { metadata: { name: 'windows2022-server-large', namespace: 'openshift' }, workload: 'server', boot: 'Boot source required', cpumem: '2 CPU | 8 GiB' },
  ];
}

@Component({
  selector: 'app-dummy-instancetypes',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Instance Types" path="dummy" [namespaced]="false" [dummy]="true" createLabel="인스턴스 타입 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyInstanceTypesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'class', label: 'Class', get: o => o.class },
    { id: 'vcpus', label: 'vCPUs', get: o => o.vcpus },
    { id: 'memory', label: 'Memory', get: o => o.memory },
  ];
  rows = [
    { metadata: { name: 'u1.medium' }, class: 'general purpose', vcpus: 1, memory: '4 GiB' },
    { metadata: { name: 'u1.large' }, class: 'general purpose', vcpus: 2, memory: '8 GiB' },
    { metadata: { name: 'cx1.2xlarge' }, class: 'compute exclusive', vcpus: 8, memory: '16 GiB' },
    { metadata: { name: 'm1.large' }, class: 'memory intensive', vcpus: 2, memory: '16 GiB' },
  ];
}

@Component({
  selector: 'app-dummy-bootablevolumes',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Bootable Volumes" path="dummy" [namespaced]="true" [dummy]="true" createLabel="볼륨 추가" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyBootableVolumesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'preference', label: 'Preference', get: o => o.preference },
    { id: 'instancetype', label: 'Default instance type', get: o => o.instancetype },
    { id: 'size', label: 'Size', get: o => o.size },
    { id: 'age', label: 'Created', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
  rows = [
    { metadata: { name: 'centos-stream9', namespace: 'openshift-virtualization-os-images', creationTimestamp: '2026-05-20T00:00:00Z' }, preference: 'centos.stream9', instancetype: 'u1.medium', size: '30 GiB' },
    { metadata: { name: 'fedora', namespace: 'openshift-virtualization-os-images', creationTimestamp: '2026-05-20T00:00:00Z' }, preference: 'fedora', instancetype: 'u1.medium', size: '30 GiB' },
    { metadata: { name: 'rhel9', namespace: 'openshift-virtualization-os-images', creationTimestamp: '2026-05-20T00:00:00Z' }, preference: 'rhel.9', instancetype: 'u1.large', size: '30 GiB' },
  ];
}

@Component({
  selector: 'app-dummy-vmmigrationpolicies',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Migration Policies" path="dummy" [namespaced]="false" [dummy]="true" createLabel="정책 생성" [staticRows]="rows" [columns]="cols" />`,
})
export class DummyVmMigrationPoliciesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'bandwidth', label: 'Bandwidth per node', get: o => o.bandwidth },
    { id: 'autoconverge', label: 'Auto converge', kind: 'status', get: o => o.autoconverge, statusOf: o => (o.autoconverge === 'Enabled' ? 'success' : 'info') },
    { id: 'postcopy', label: 'Post-copy', kind: 'status', get: o => o.postcopy, statusOf: o => (o.postcopy === 'Enabled' ? 'success' : 'info') },
  ];
  rows = [
    { metadata: { name: 'large-vms' }, bandwidth: '1 Gi', autoconverge: 'Enabled', postcopy: 'Disabled' },
    { metadata: { name: 'prod-tier' }, bandwidth: 'Unlimited', autoconverge: 'Disabled', postcopy: 'Enabled' },
  ];
}
