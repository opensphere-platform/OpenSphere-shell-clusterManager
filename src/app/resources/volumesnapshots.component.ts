import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { firstValueFrom } from 'rxjs';
import { K8sService } from '../core/k8s.service';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// CSI external-snapshotter VolumeSnapshot의 status.readyToUse(boolean) → 상태 색상.
// true=사용 가능(success), false=아직 준비 중(info), 미정의=상태 불명(unknown).
const readyColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const r = o.status?.readyToUse;
  if (r === true) return 'success';
  if (r === false) return 'info';
  if (o.status?.error) return 'danger';
  return 'unknown';
};

/**
 * CSI VolumeSnapshot 실연동 (구 DummyVolumeSnapshotsComponent 대체).
 * snapshot.storage.k8s.io/v1 — external-snapshotter CRD가 GA(v1)로 졸업한 현행 apiVersion.
 * apiGroup=snapshot.storage.k8s.io 는 app.component capability-gate 키이므로 그룹은 고정.
 * CRD 미설치 클러스터에서는 404 → ResourceListComponent가 friendly(info) 처리.
 * 읽기 전용 — createLabel/dummy/staticRows 없음.
 */
@Component({
  selector: 'app-res-volumesnapshots',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceListComponent],
  styles: [`
    .snapshot-operations { display: grid; gap: var(--os-5); margin: 0 0 var(--os-6); }
    .snapshot-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--os-5); }
    .snapshot-heading h3 { margin: 0; font-size: 1rem; }
    .snapshot-heading p { margin: var(--os-2) 0 0; color: var(--os-ink-muted); }
    .snapshot-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--os-4); }
    .snapshot-summary article { display: grid; gap: var(--os-2); min-width: 0; padding: var(--os-4); border: 1px solid var(--os-hairline); border-left: var(--os-2) solid var(--os-info); background: var(--os-surface-1); }
    .snapshot-summary article.is-ready { border-left-color: var(--os-success); }
    .snapshot-summary article.is-warning { border-left-color: var(--os-warning); }
    .snapshot-summary article.is-danger { border-left-color: var(--os-danger); background: var(--os-danger-bg); }
    .snapshot-summary span { color: var(--os-ink-muted); font: var(--os-type-caption); }
    .snapshot-summary strong { font-size: 0.9rem; overflow-wrap: anywhere; }
    .snapshot-summary small { color: var(--os-ink-muted); line-height: 1.4; overflow-wrap: anywhere; }
    .snapshot-board { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: var(--os-5); }
    .snapshot-panel { min-width: 0; padding: var(--os-5); border: 1px solid var(--os-hairline); background: var(--os-bg); }
    .snapshot-panel h4 { margin: 0 0 var(--os-4); font-size: 0.9rem; }
    .snapshot-facts { display: grid; grid-template-columns: minmax(9rem, 0.42fr) minmax(0, 1fr); gap: var(--os-3) var(--os-5); margin: 0; }
    .snapshot-facts dt { color: var(--os-ink-muted); }
    .snapshot-facts dd { min-width: 0; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    .snapshot-facts dd + dt, .snapshot-facts dt:not(:first-child) { padding-top: var(--os-2); border-top: 1px solid var(--os-hairline); }
    .snapshot-facts dd:not(:first-of-type) { padding-top: var(--os-2); border-top: 1px solid var(--os-hairline); }
    .instance-list { display: grid; margin-top: var(--os-4); border: 1px solid var(--os-hairline); }
    .instance-row { display: grid; grid-template-columns: minmax(9rem, 1.5fr) minmax(4rem, 0.7fr) minmax(6rem, 0.8fr) minmax(7rem, 1fr); gap: var(--os-3); align-items: center; padding: var(--os-3); }
    .instance-row + .instance-row { border-top: 1px solid var(--os-hairline); }
    .instance-row.is-header { color: var(--os-ink-muted); font: var(--os-type-caption); background: var(--os-surface-1); }
    .instance-row > * { min-width: 0; overflow-wrap: anywhere; }
    .diagnostic-alert { margin: 0; }
    .diagnostic-alert .alert-text { display: grid; gap: var(--os-2); }
    .evidence-list, .recovery-list { margin: var(--os-2) 0 0; padding-left: var(--os-6); }
    .evidence-list li + li, .recovery-list li + li { margin-top: var(--os-2); }
    .secondary-risks { display: grid; grid-template-columns: 1fr 1fr; gap: var(--os-4); }
    .secondary-risks clr-alert { margin: 0; }
    .diagnostic-errors { margin: 0; }
    @media (max-width: 1100px) {
      .snapshot-summary { grid-template-columns: 1fr 1fr; }
      .snapshot-board, .secondary-risks { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .snapshot-heading { display: grid; }
      .snapshot-summary { grid-template-columns: 1fr; }
      .snapshot-facts { grid-template-columns: 1fr; }
      .snapshot-facts dt, .snapshot-facts dd { border-top: 0 !important; padding-top: 0 !important; }
      .instance-row { grid-template-columns: 1fr 1fr; }
      .instance-row.is-header { display: none; }
    }
  `],
  template: `
    <app-resource-list title="Volume Snapshots" path="/apis/snapshot.storage.k8s.io/v1/volumesnapshots" [namespaced]="true" kind="VolumeSnapshot" [columns]="cols">
      <section class="snapshot-operations" aria-labelledby="snapshot-operations-title">
        <div class="snapshot-heading">
          <div>
            <h3 id="snapshot-operations-title">데이터 보호와 Ceph RBD 복구 상태</h3>
            <p>Snapshot 리소스 수만이 아니라 원본 PVC, CSI 연결, PostgreSQL HA와 복구 증거를 함께 판정합니다.</p>
          </div>
          <button class="btn btn-sm btn-outline" type="button" [disabled]="loading()" (click)="loadDiagnostics()">다시 확인</button>
        </div>

        <div class="snapshot-summary" *ngIf="diagnostics() as d; else diagnosticsLoading">
          <article [class.is-danger]="!d.rbdSnapshotClass" [class.is-ready]="d.rbdSnapshotClass">
            <span>Ceph RBD snapshot</span>
            <strong>{{ d.rbdSnapshotClass ? '준비됨' : 'SnapshotClass 없음' }}</strong>
            <small>{{ d.rbdSnapshotClass || 'rook-ceph.rbd.csi.ceph.com과 연결된 class가 필요합니다.' }}</small>
          </article>
          <article [class.is-ready]="d.snapshotCount > 0" [class.is-warning]="d.snapshotCount === 0">
            <span>VolumeSnapshot</span>
            <strong>{{ d.snapshotCount }}개</strong>
            <small>Ceph RBD 대상 PVC {{ d.cephRbdPvcCount }}개 · PostgreSQL PVC {{ d.pgPvcCount }}개</small>
          </article>
          <article [class.is-danger]="d.pgState === 'HA Degraded'" [class.is-ready]="d.pgState === 'Ready'">
            <span>PostgreSQL</span>
            <strong>{{ d.pgState }}</strong>
            <small>{{ d.pgReady }}/{{ d.pgDesired }} Ready · Primary {{ d.pgPrimary || '확인 불가' }}</small>
          </article>
          <article [class.is-danger]="!d.backupProtected" [class.is-ready]="d.backupProtected">
            <span>복구 가능한 백업</span>
            <strong>{{ d.backupProtected ? '구성됨' : '증거 없음' }}</strong>
            <small>Backup {{ d.backupCount }} · ScheduledBackup {{ d.scheduledBackupCount }} · restore 검증 {{ d.restoreVerified ? '있음' : '없음' }}</small>
          </article>
        </div>
        <ng-template #diagnosticsLoading>
          <clr-spinner clrInline aria-label="데이터 보호 상태를 확인하는 중"></clr-spinner>
        </ng-template>

        <clr-alert *ngIf="diagnostics()?.staleMapping" class="diagnostic-alert" [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">
            <strong>PostgreSQL은 완전 장애가 아니라 HA Degraded 상태입니다.</strong>
            <span>Primary와 한 개 replica는 동작하지만 <code>{{ diagnostics()?.failedInstance }}</code>가 Ceph RBD 볼륨 마운트 단계에서 중단되었습니다. PostgreSQL 설정 오류가 아니라 RBD lifecycle 복구 경로의 장애 징후입니다.</span>
          </span></clr-alert-item>
        </clr-alert>

        <div class="snapshot-board" *ngIf="diagnostics() as d">
          <section class="snapshot-panel">
            <h4>PostgreSQL HA 실측</h4>
            <dl class="snapshot-facts">
              <dt>CNPG Cluster</dt><dd>{{ d.pgCondition }} · {{ d.pgPhase }}</dd>
              <dt>인스턴스</dt><dd>{{ d.pgDesired }} 선언 · {{ d.pgReady }} Ready</dd>
              <dt>Primary</dt><dd>{{ d.pgPrimary || '—' }}</dd>
              <dt>Primary 접속 경로</dt><dd>{{ d.primaryEndpointReady ? '5432 endpoint Ready' : '5432 endpoint 확인 필요' }}</dd>
              <dt>복제 정책</dt><dd>{{ d.replicationMode }} · reporting replica {{ d.reportedReplicas }}개 · lag는 SQL 실측 필요</dd>
              <dt>PgBouncer</dt><dd>{{ d.poolerState }} · {{ d.poolerReady }}/{{ d.poolerDesired }} Ready</dd>
              <dt>PVC</dt><dd>{{ d.pgBoundPvcCount }}/{{ d.pgPvcCount }} Bound · StorageClass/ceph-rbd</dd>
              <dt>Monitoring</dt><dd>{{ d.podMonitor ? 'PodMonitor 존재' : 'PodMonitor 확인 안 됨' }}</dd>
              <dt>Database CR</dt><dd>{{ d.databaseApplied ? 'syncope Applied' : 'syncope 적용 증거 없음' }}</dd>
            </dl>
            <div class="instance-list" *ngIf="d.instances.length" aria-label="PostgreSQL 인스턴스 상태">
              <div class="instance-row is-header" aria-hidden="true"><span>인스턴스</span><span>역할</span><span>상태</span><span>노드</span></div>
              <div class="instance-row" *ngFor="let instance of d.instances">
                <code>{{ instance.name }}</code>
                <span>{{ instance.role }}</span>
                <span class="label" [class.label-success]="instance.ready" [class.label-danger]="!instance.ready">{{ instance.status }}</span>
                <span>{{ instance.node }}</span>
              </div>
            </div>
          </section>

          <section class="snapshot-panel">
            <h4>Ceph RBD 직접 원인과 구조적 결함</h4>
            <dl class="snapshot-facts">
              <dt>장애 PVC</dt><dd>{{ d.failedPvc || '—' }} · {{ d.failedPvcBound ? 'Bound' : '상태 확인 필요' }}</dd>
              <dt>VolumeAttachment</dt><dd>{{ d.attachmentState }} · {{ d.attachmentNode || '—' }}</dd>
              <dt>Mount</dt><dd>{{ d.mountState }}</dd>
              <dt>RBD image</dt><dd><code>{{ d.rbdImage || '—' }}</code></dd>
              <dt>Mounter</dt><dd>{{ d.rbdMounter || '기본값' }}</dd>
              <dt>Self-recovery</dt><dd>orphan mapping 자동 감지·정리 증거 없음</dd>
            </dl>
            <ul class="evidence-list">
              <li>PVC가 Bound이고 VolumeAttachment가 attached여도 실제 mount 성공을 의미하지 않습니다.</li>
              <li><code>rbd-nbd</code> 프로세스와 CSI staging 상태의 불일치를 노드 수준에서 검증해야 합니다.</li>
              <li>현재 NBD preparer는 device node 준비만 담당하며 stale mapping 복구를 보증하지 않습니다.</li>
              <li><code>{{ d.pgImage || 'PostgreSQL image 확인 필요' }}</code>는 이번 장애의 직접 원인이 아닙니다. PostgreSQL 기동 전 storage mount에서 중단됐습니다.</li>
            </ul>
          </section>
        </div>

        <div class="secondary-risks" *ngIf="diagnostics() as d">
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text"><strong>백업 준비 완료로 판정할 수 없습니다.</strong>
              ContinuousArchiving={{ d.continuousArchiving ? 'True' : 'False/Unknown' }}이지만 Backup·ScheduledBackup·명시적 destination·실제 restore 검증을 별도로 확인해야 합니다.
            </span></clr-alert-item>
          </clr-alert>
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text"><strong>Syncope scheduler/job coordination 별도 점검 필요</strong>
              최근 점검에서 <code>jobstatus_pkey</code> 중복과 rollback 증가가 관찰됐습니다. 이는 현재 HA Degraded의 직접 원인은 아니며 다중 인스턴스 scheduler 조정 문제로 분리합니다.
            </span></clr-alert-item>
          </clr-alert>
        </div>

        <section class="snapshot-panel" *ngIf="diagnostics()?.staleMapping">
          <h4>권장 처리 순서</h4>
          <ol class="recovery-list">
            <li>장애 노드에서 해당 PVC의 orphan <code>rbd-nbd</code> 프로세스와 CSI staging 상태를 정확히 대조하고 안전하게 정리</li>
            <li>기존 PVC로 <code>foundation-data-pg-3</code> 재기동 확인</li>
            <li>CNPG 3/3 Ready와 두 replica의 replication 상태 확인</li>
            <li>NBD/CSI 계층에 stale mapping 자동 감지·정리·재부팅/Pod 재생성 검증 구현</li>
            <li><code>ceph-rbd-snapshot</code> 구성 후 ScheduledBackup과 실제 restore 시험 추가</li>
            <li>Syncope 중복 scheduler 실행 문제를 분리 수정한 뒤 Keycloak DB 설치 진행</li>
          </ol>
        </section>

        <clr-alert *ngIf="accessIssues().length" class="diagnostic-errors" [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text"><strong>일부 실측 정보 조회 제한</strong> {{ accessIssues().join(' · ') }}</span></clr-alert-item>
        </clr-alert>
      </section>
    </app-resource-list>
  `,
})
export class VolumeSnapshotsComponent implements OnInit {
  private readonly k8s = inject(K8sService);
  readonly loading = signal(true);
  readonly accessIssues = signal<string[]>([]);
  readonly diagnostics = signal<any | null>(null);

  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'ready', label: 'Ready To Use', kind: 'status', get: o => (o.status?.readyToUse === true ? 'True' : o.status?.readyToUse === false ? 'False' : 'Unknown'), statusOf: o => readyColor(o) },
    { id: 'sourcePvc', label: 'Source PVC', get: o => o.spec?.source?.persistentVolumeClaimName, facet: true },
    { id: 'snapshotClass', label: 'Snapshot Class', get: o => o.spec?.volumeSnapshotClassName, facet: true },
    { id: 'storageClass', label: 'StorageClass', get: o => this.sourceStorageClass(o), facet: true },
    { id: 'restoreSize', label: 'Restore Size', get: o => o.status?.restoreSize },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];

  ngOnInit(): void { void this.loadDiagnostics(); }

  sourceStorageClass(snapshot: any): string {
    const source = snapshot?.spec?.source?.persistentVolumeClaimName;
    const namespace = snapshot?.metadata?.namespace;
    const pvc = this.diagnostics()?.allPvcs?.find((item: any) => item.metadata?.namespace === namespace && item.metadata?.name === source);
    return pvc?.spec?.storageClassName || '—';
  }

  async loadDiagnostics(): Promise<void> {
    this.loading.set(true);
    this.accessIssues.set([]);
    const ns = 'opensphere-foundation';
    const clusterName = 'foundation-data-pg';
    const [snapshotClasses, snapshots, storageClasses, csiDrivers, pvcs, attachments, cluster, pgPods, poolerPods, primaryEndpoints, events, backups, scheduled, pooler, database, podMonitor] = await Promise.all([
      this.list('/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses', undefined, 'VolumeSnapshotClass'),
      this.list('/apis/snapshot.storage.k8s.io/v1/volumesnapshots', undefined, 'VolumeSnapshot'),
      this.list('/apis/storage.k8s.io/v1/storageclasses', undefined, 'StorageClass'),
      this.list('/apis/storage.k8s.io/v1/csidrivers', undefined, 'CSIDriver'),
      this.list('/api/v1/persistentvolumeclaims', undefined, 'PVC'),
      this.list('/apis/storage.k8s.io/v1/volumeattachments', undefined, 'VolumeAttachment'),
      this.get(`/apis/postgresql.cnpg.io/v1/namespaces/${ns}/clusters/${clusterName}`, 'CNPG Cluster'),
      this.list(`/api/v1/namespaces/${ns}/pods`, { labelSelector: `cnpg.io/cluster=${clusterName},cnpg.io/podRole=instance` }, 'PostgreSQL Pod'),
      this.list(`/api/v1/namespaces/${ns}/pods`, { labelSelector: `cnpg.io/poolerName=${clusterName}-pooler` }, 'PgBouncer Pod'),
      this.list(`/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices`, { labelSelector: `kubernetes.io/service-name=${clusterName}-rw` }, 'Primary Endpoint'),
      this.list(`/api/v1/namespaces/${ns}/events`, { fieldSelector: `involvedObject.name=${clusterName}-3` }, 'PostgreSQL Event'),
      this.list(`/apis/postgresql.cnpg.io/v1/namespaces/${ns}/backups`, undefined, 'Backup'),
      this.list(`/apis/postgresql.cnpg.io/v1/namespaces/${ns}/scheduledbackups`, undefined, 'ScheduledBackup'),
      this.get(`/apis/postgresql.cnpg.io/v1/namespaces/${ns}/poolers/${clusterName}-pooler`, 'PgBouncer'),
      this.get(`/apis/postgresql.cnpg.io/v1/namespaces/${ns}/databases/foundation-identity-syncope`, 'Database'),
      this.get(`/apis/monitoring.coreos.com/v1/namespaces/${ns}/podmonitors/${clusterName}`, 'PodMonitor'),
    ]);

    const rbdDriver = 'rook-ceph.rbd.csi.ceph.com';
    const rbdStorage = storageClasses.find((item: any) => item.metadata?.name === 'ceph-rbd');
    const rbdSnapshot = snapshotClasses.find((item: any) => item.driver === rbdDriver);
    const cephRbdPvcs = pvcs.filter((item: any) => item.spec?.storageClassName === 'ceph-rbd');
    const pgPvcs = cephRbdPvcs.filter((item: any) => item.metadata?.labels?.['cnpg.io/cluster'] === clusterName);
    const failedMount = events
      .filter((item: any) => item.reason === 'FailedMount' && /rbd image .* is still being used/i.test(String(item.message || '')))
      .sort((a: any, b: any) => String(b.lastTimestamp || b.eventTime || '').localeCompare(String(a.lastTimestamp || a.eventTime || '')))[0];
    const failedInstance = failedMount?.involvedObject?.name || pgPods.find((item: any) => !this.podReady(item))?.metadata?.name || '';
    const failedPvc = pgPvcs.find((item: any) => item.metadata?.name === failedInstance);
    const attachment = attachments.find((item: any) => item.spec?.source?.persistentVolumeName === failedPvc?.spec?.volumeName);
    const rbdImage = String(failedMount?.message || '').match(/rbd image\s+([^\s]+)\s+is still being used/i)?.[1] || '';
    const desired = Number(cluster?.spec?.instances ?? pgPods.length);
    const ready = Number(cluster?.status?.readyInstances ?? pgPods.filter((item: any) => this.podReady(item)).length);
    const readyCondition = cluster?.status?.conditions?.find((item: any) => item.type === 'Ready');
    const continuous = cluster?.status?.conditions?.find((item: any) => item.type === 'ContinuousArchiving')?.status === 'True';
    const poolerReady = poolerPods.filter((item: any) => this.podReady(item)).length;
    const poolerDesired = Number(pooler?.status?.instances ?? pooler?.spec?.instances ?? poolerPods.length);
    const primaryEndpointReady = primaryEndpoints.some((slice: any) =>
      slice.ports?.some((port: any) => Number(port.port) === 5432)
      && slice.endpoints?.some((endpoint: any) => endpoint.conditions?.ready !== false));
    const reportedReplicas = Object.values(cluster?.status?.instancesReportedState || {})
      .filter((state: any) => state?.isPrimary === false).length;
    const instances = pgPods.map((pod: any) => ({
      name: pod.metadata?.name || '',
      role: pod.metadata?.name === cluster?.status?.currentPrimary ? 'Primary' : 'Replica',
      ready: this.podReady(pod),
      status: this.podReady(pod) ? 'Ready' : this.podStatus(pod),
      node: pod.spec?.nodeName || '—',
    })).sort((left: any, right: any) => left.name.localeCompare(right.name));

    this.diagnostics.set({
      allPvcs: pvcs,
      rbdDriverReady: csiDrivers.some((item: any) => item.metadata?.name === rbdDriver),
      rbdSnapshotClass: rbdSnapshot?.metadata?.name || '',
      snapshotCount: snapshots.length,
      cephRbdPvcCount: cephRbdPvcs.length,
      pgPvcCount: pgPvcs.length,
      pgBoundPvcCount: pgPvcs.filter((item: any) => item.status?.phase === 'Bound').length,
      pgState: desired > 0 && ready === desired ? 'Ready' : ready > 0 ? 'HA Degraded' : 'Unavailable',
      pgCondition: `Ready=${readyCondition?.status || 'Unknown'}`,
      pgPhase: cluster?.status?.phase || (ready === desired ? 'Cluster in healthy state' : 'Waiting for instances'),
      pgDesired: desired,
      pgReady: ready,
      pgPrimary: cluster?.status?.currentPrimary || instances.find((item: any) => item.role === 'Primary')?.name || '',
      primaryEndpointReady,
      replicationMode: Number(cluster?.spec?.minSyncReplicas || 0) > 0 ? 'synchronous' : 'async',
      reportedReplicas,
      pgImage: cluster?.status?.image || cluster?.spec?.imageName || '',
      instances,
      failedInstance,
      failedPvc: failedPvc?.metadata?.name || '',
      failedPvcBound: failedPvc?.status?.phase === 'Bound',
      attachmentState: attachment ? `attached=${attachment.status?.attached === true}` : 'VolumeAttachment 없음',
      attachmentNode: attachment?.spec?.nodeName || '',
      mountState: failedMount ? `${failedMount.reason} · ${failedMount.count || 1}회` : 'FailedMount 증거 없음',
      staleMapping: Boolean(failedMount),
      rbdImage,
      rbdMounter: rbdStorage?.parameters?.mounter || '',
      poolerState: pooler?.status?.phase || '확인 불가',
      poolerReady,
      poolerDesired,
      podMonitor: Boolean(podMonitor),
      databaseApplied: database?.status?.applied === true,
      backupCount: backups.length,
      scheduledBackupCount: scheduled.length,
      continuousArchiving: continuous,
      backupProtected: Boolean(cluster?.spec?.backup) && scheduled.length > 0 && backups.some((item: any) => /completed/i.test(String(item.status?.phase || ''))),
      restoreVerified: false,
    });
    this.loading.set(false);
  }

  private async list(path: string, query: Record<string, string> | undefined, label: string): Promise<any[]> {
    try { return (await firstValueFrom(this.k8s.list(path, query))).items || []; }
    catch (failure: any) { this.noteIssue(label, failure); return []; }
  }

  private async get(path: string, label: string): Promise<any | null> {
    try { return await firstValueFrom(this.k8s.get(path)); }
    catch (failure: any) { if (failure?.status !== 404) this.noteIssue(label, failure); return null; }
  }

  private noteIssue(label: string, failure: any): void {
    const detail = failure?.status === 403 ? '조회 권한 없음' : `조회 실패${failure?.status ? ` HTTP ${failure.status}` : ''}`;
    this.accessIssues.update((items) => [...items, `${label}: ${detail}`]);
  }

  private podReady(pod: any): boolean {
    return pod?.status?.conditions?.some((item: any) => item.type === 'Ready' && item.status === 'True') === true;
  }

  private podStatus(pod: any): string {
    const init = pod?.status?.initContainerStatuses?.find((item: any) => !item.ready);
    if (init) return `Init: ${init.state?.waiting?.reason || 'NotReady'}`;
    return pod?.status?.phase || 'NotReady';
  }
}
