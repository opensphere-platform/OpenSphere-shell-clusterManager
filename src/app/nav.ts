import { Type } from '@angular/core';
import { NodesComponent } from './resources/nodes.component';
import { PodComponent } from './resources/pods.component';
import { DeploymentComponent } from './resources/deployments.component';
import { ReplicaSetComponent } from './resources/replicasets.component';
import { StatefulSetComponent } from './resources/statefulsets.component';
import { DaemonSetComponent } from './resources/daemonsets.component';
import { JobComponent } from './resources/jobs.component';
import { CronJobComponent } from './resources/cronjobs.component';
import { JobSetComponent } from './resources/jobsets.component';
import { HorizontalPodAutoscalerComponent } from './resources/hpas.component';
import { VerticalPodAutoscalerComponent } from './resources/vpas.component';
import { PodDisruptionBudgetComponent } from './resources/pdbs.component';
import { ServiceComponent } from './resources/services.component';
import { IngressComponent } from './resources/ingresses.component';
import { EndpointsComponent } from './resources/endpoints.component';
import { EndpointSliceComponent } from './resources/endpointslices.component';
import { NetworkPolicyComponent } from './resources/networkpolicies.component';
import { ConfigMapComponent } from './resources/configmaps.component';
import { ResourceQuotaComponent } from './resources/resourcequotas.component';
import { LimitRangeComponent } from './resources/limitranges.component';
import { NamespaceComponent } from './resources/namespaces.component';
import { PriorityClassComponent } from './resources/priorityclasses.component';
import { RuntimeClassComponent } from './resources/runtimeclasses.component';
import { LeaseComponent } from './resources/leases.component';
import { CustomResourceDefinitionComponent } from './resources/crds.component';
import { RoleComponent } from './resources/roles.component';
import { ServiceAccountComponent } from './resources/serviceaccounts.component';
import { IngressClassComponent } from './resources/ingressclasses.component';
import { PersistentVolumeClaimComponent } from './resources/persistentvolumeclaims.component';
import { PersistentVolumeComponent } from './resources/persistentvolumes.component';
import { StorageClassComponent } from './resources/storageclasses.component';
import { EventComponent } from './resources/events.component';
import { RoleBindingComponent } from './resources/rolebindings.component';
import { ClusterRoleComponent } from './resources/clusterroles.component';
import { ClusterRoleBindingComponent } from './resources/clusterrolebindings.component';
import { DummyVmTemplatesComponent, DummyInstanceTypesComponent, DummyBootableVolumesComponent, DummyVmMigrationPoliciesComponent } from './resources/dummy-virtualization';
import { VirtualMachinesComponent } from './resources/virtualmachines.component';
import { DummyVolumeSnapshotsComponent, DummyVolumeSnapshotClassesComponent, DummyCephComponent } from './resources/dummy-storage';
import { DummyStorageMigrationComponent, DummyMtvProvidersComponent, DummyMtvPlansComponent } from './resources/dummy-migration';
import { DummyAlertsComponent, DummyMetricsComponent, DummyDashboardsComponent, DummyTargetsComponent } from './resources/dummy-observability';

/** 앱 내부 사이드바 네비 — Headlamp 사이드바 그룹 매핑. */
export interface NavItem { id: string; label: string; component: Type<any>; }
/** scope: 'vm' 그룹은 VM 뷰 스코프에서만, 그 외(기본=cluster)는 Cluster 뷰에서만 노출(§7.1 통합 콤보 뷰). */
export interface NavGroup { group: string; items: NavItem[]; scope?: 'cluster' | 'vm'; }

export const NAV: NavGroup[] = [
  {
    group: 'Workloads',
    items: [
      { id: 'pods', label: 'Pods', component: PodComponent },
      { id: 'deployments', label: 'Deployments', component: DeploymentComponent },
      { id: 'replicasets', label: 'ReplicaSets', component: ReplicaSetComponent },
      { id: 'statefulsets', label: 'StatefulSets', component: StatefulSetComponent },
      { id: 'daemonsets', label: 'DaemonSets', component: DaemonSetComponent },
      { id: 'jobs', label: 'Jobs', component: JobComponent },
      { id: 'cronjobs', label: 'CronJobs', component: CronJobComponent },
      { id: 'jobsets', label: 'Job Sets', component: JobSetComponent },
      { id: 'hpas', label: 'Horizontal Pod Autoscalers', component: HorizontalPodAutoscalerComponent },
      { id: 'vpas', label: 'Vertical Pod Autoscalers', component: VerticalPodAutoscalerComponent },
      { id: 'pdbs', label: 'Pod Disruption Budgets', component: PodDisruptionBudgetComponent },
    ],
  },
  {
    group: 'Network',
    items: [
      { id: 'services', label: 'Services', component: ServiceComponent },
      { id: 'ingresses', label: 'Ingresses', component: IngressComponent },
      { id: 'endpoints', label: 'Endpoints', component: EndpointsComponent },
      { id: 'endpointslices', label: 'Endpoint Slices', component: EndpointSliceComponent },
      { id: 'ingressclasses', label: 'Ingress Classes', component: IngressClassComponent },
      { id: 'networkpolicies', label: 'Network Policies', component: NetworkPolicyComponent },
    ],
  },
  {
    group: 'Config & Storage',
    items: [
      { id: 'configmaps', label: 'ConfigMaps', component: ConfigMapComponent },
      { id: 'resourcequotas', label: 'Resource Quotas', component: ResourceQuotaComponent },
      { id: 'limitranges', label: 'Limit Ranges', component: LimitRangeComponent },
      { id: 'pvcs', label: 'Persistent Volume Claims', component: PersistentVolumeClaimComponent },
      { id: 'pvs', label: 'Persistent Volumes', component: PersistentVolumeComponent },
      { id: 'storageclasses', label: 'Storage Classes', component: StorageClassComponent },
    ],
  },
  {
    group: 'Cluster',
    items: [
      { id: 'nodes', label: 'Nodes', component: NodesComponent },
      { id: 'namespaces', label: 'Namespaces', component: NamespaceComponent },
      { id: 'events', label: 'Events', component: EventComponent },
      { id: 'priorityclasses', label: 'Priority Classes', component: PriorityClassComponent },
      { id: 'runtimeclasses', label: 'Runtime Classes', component: RuntimeClassComponent },
      { id: 'leases', label: 'Leases', component: LeaseComponent },
      { id: 'crds', label: 'Custom Resource Definitions', component: CustomResourceDefinitionComponent },
    ],
  },
  {
    group: 'Access',
    items: [
      { id: 'roles', label: 'Roles', component: RoleComponent },
      { id: 'rolebindings', label: 'Role Bindings', component: RoleBindingComponent },
      { id: 'clusterroles', label: 'Cluster Roles', component: ClusterRoleComponent },
      { id: 'clusterrolebindings', label: 'Cluster Role Bindings', component: ClusterRoleBindingComponent },
      { id: 'serviceaccounts', label: 'Service Accounts', component: ServiceAccountComponent },
    ],
  },
  // ── OpenSphere 확장(코어 K8s 콘솔에 없는 고유 영역) — OpenShift 콘솔 구조 참고 더미 페이지, 후속 실연동 ──
  {
    group: 'Virtualization',
    scope: 'vm',
    items: [
      { id: 'virtualmachines', label: 'Virtual Machines', component: VirtualMachinesComponent },
      { id: 'vm-templates', label: 'Templates', component: DummyVmTemplatesComponent },
      { id: 'vm-instancetypes', label: 'Instance Types', component: DummyInstanceTypesComponent },
      { id: 'vm-bootablevolumes', label: 'Bootable Volumes', component: DummyBootableVolumesComponent },
      { id: 'vm-migrationpolicies', label: 'Migration Policies', component: DummyVmMigrationPoliciesComponent },
    ],
  },
  {
    group: 'Storage (Ceph/ODF)',
    items: [
      { id: 'volumesnapshots', label: 'Volume Snapshots', component: DummyVolumeSnapshotsComponent },
      { id: 'volumesnapshotclasses', label: 'Volume Snapshot Classes', component: DummyVolumeSnapshotClassesComponent },
      { id: 'ceph', label: 'Ceph / ODF', component: DummyCephComponent },
    ],
  },
  {
    group: 'Migration (MTV)',
    scope: 'vm',
    items: [
      { id: 'mtv-storage-migration', label: 'Storage Migration', component: DummyStorageMigrationComponent },
      { id: 'mtv-providers', label: 'Providers', component: DummyMtvProvidersComponent },
      { id: 'mtv-plans', label: 'Plans', component: DummyMtvPlansComponent },
    ],
  },
  {
    group: 'Observability',
    items: [
      { id: 'mon-alerts', label: 'Alerting', component: DummyAlertsComponent },
      { id: 'mon-metrics', label: 'Metrics', component: DummyMetricsComponent },
      { id: 'mon-dashboards', label: 'Dashboards', component: DummyDashboardsComponent },
      { id: 'mon-targets', label: 'Targets', component: DummyTargetsComponent },
    ],
  },
];
