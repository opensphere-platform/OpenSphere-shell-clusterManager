import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { CephPlan, CephService, CephStatus } from '../core/ceph.service';

@Component({
  selector: 'app-res-ceph',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule],
  template: `
    <header class="cm-ceph-page-head">
      <div class="cm-ceph-page-head__copy">
        <p class="cm-ceph-eyebrow">Kubernetes child storage</p>
        <h1>Ceph External Storage</h1>
        <p class="cm-ceph-summary">Ceph은 Console에 직접 마운트하지 않습니다. 선택한 Kubernetes 클러스터에 Rook External Mode와 Ceph CSI를 구성하고, Console은 연결 상태와 참조 정보만 관리합니다.</p>
      </div>
      <div class="cm-ceph-page-head__actions">
        <button class="btn btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">다시 검사</button>
        <button class="btn btn-primary" type="button" [disabled]="busy() || status()?.kubernetes?.ready !== true || !!status()?.connection" (click)="openConnect()">외부 Ceph 연결</button>
      </div>
    </header>

    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div *ngIf="notice()" class="alert alert-success" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ notice() }}</span></div></div>
    </div>

    <section class="dependency" *ngIf="status() as s">
      <div class="dependency-title">
        <span class="sequence">1</span>
        <div><strong>Kubernetes 연결</strong><span>Ceph 연결보다 먼저 성립해야 하는 부모 클러스터</span></div>
        <span class="label" [class.label-success]="s.kubernetes.ready" [class.label-danger]="!s.kubernetes.ready">{{ s.kubernetes.ready ? 'Ready' : 'Blocked' }}</span>
      </div>
      <dl>
        <dt>Cluster fingerprint</dt><dd>{{ s.kubernetes.id || '확인 불가' }}</dd>
        <dt>Kubernetes</dt><dd>{{ s.kubernetes.version || '확인 불가' }}</dd>
        <dt>Nodes</dt><dd>{{ s.kubernetes.readyNodes || 0 }}/{{ s.kubernetes.nodes || 0 }} Ready</dd>
      </dl>
      <div class="connector" aria-hidden="true"></div>
      <div class="dependency-title child">
        <span class="sequence">2</span>
        <div><strong>Ceph External 연결</strong><span>Rook operator · external CephCluster · Ceph CSI</span></div>
        <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-warning]="s.state === 'Degraded' || s.state === 'NotConfigured'" [class.label-danger]="s.state === 'Blocked'">{{ s.state }}</span>
      </div>
      <p class="status-message">{{ s.message }}</p>
    </section>

    <div class="alert alert-info" role="note">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>보안 경계:</strong> provider export는 허용된 ConfigMap·제한된 CSI Secret·StorageClass만 통과합니다. 원문 자격 증명은 Console/Backbone에 저장하지 않고 대상 Kubernetes Secret에만 기록됩니다. 외부 Ceph pool·filesystem·data는 생성하거나 삭제하지 않습니다.
      </span></div></div>
    </div>

    <ng-container *ngIf="status() as s">
      <section class="connection-card" *ngIf="s.connection as connection; else emptyConnection">
        <div class="card-head">
          <div><h2>연결 정보</h2><p>Rook External Mode · {{ connection.chartVersion }}</p></div>
          <button class="btn btn-danger-outline" type="button" [disabled]="busy()" (click)="openDisconnect()">연결 해제</button>
        </div>
        <dl class="connection-meta">
          <dt>FSID fingerprint</dt><dd><code>{{ connection.fsidFingerprint }}</code></dd>
          <dt>연결한 사용자</dt><dd>{{ connection.connectedBy }}</dd>
          <dt>연결 시각</dt><dd>{{ connection.connectedAt | date:'yyyy-MM-dd HH:mm:ss' }}</dd>
          <dt>Secret references</dt><dd>{{ connection.secretRefs.length }}개 · 값 비노출</dd>
          <dt>Ceph 상태</dt><dd>{{ s.rook?.cephCluster?.state || 'Unknown' }} · {{ s.rook?.cephCluster?.health || 'Unknown' }}</dd>
        </dl>

        <clr-datagrid>
          <clr-dg-column>Consumer resource</clr-dg-column>
          <clr-dg-column>상태</clr-dg-column>
          <clr-dg-column>세부</clr-dg-column>
          <clr-dg-row>
            <clr-dg-cell><strong>Rook operator</strong></clr-dg-cell>
            <clr-dg-cell><span class="label" [class.label-success]="s.rook?.operator?.status === 'deployed'">{{ s.rook?.operator?.status || 'not-installed' }}</span></clr-dg-cell>
            <clr-dg-cell>revision {{ s.rook?.operator?.revision || 0 }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-row>
            <clr-dg-cell><strong>External CephCluster</strong></clr-dg-cell>
            <clr-dg-cell><span class="label" [class.label-success]="s.rook?.cluster?.status === 'deployed'">{{ s.rook?.cluster?.status || 'not-installed' }}</span></clr-dg-cell>
            <clr-dg-cell>{{ s.rook?.cephCluster?.state || 'Unknown' }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-row *ngFor="let storage of s.csi?.storageClasses || []">
            <clr-dg-cell><strong>StorageClass/{{ storage.name }}</strong></clr-dg-cell>
            <clr-dg-cell><span class="label label-success">Ready</span></clr-dg-cell>
            <clr-dg-cell>{{ storage.provisioner }} · reclaim {{ storage.reclaimPolicy }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-footer>{{ (s.csi?.storageClasses?.length || 0) + 2 }}개 consumer resource</clr-dg-footer>
        </clr-datagrid>
      </section>
      <ng-template #emptyConnection>
        <section class="empty-state">
          <h2>외부 Ceph이 아직 연결되지 않았습니다</h2>
          <p>Kubernetes가 Ready인 경우 Ceph 관리자가 생성한 Rook provider export JSON으로 연결할 수 있습니다.</p>
          <button class="btn btn-primary" type="button" [disabled]="!s.kubernetes.ready || busy()" (click)="openConnect()">연결 Wizard 시작</button>
        </section>
      </ng-template>
    </ng-container>

    <clr-modal [(clrModalOpen)]="connectOpen" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">외부 Ceph 연결 Wizard</h3>
      <div class="modal-body">
        <ol class="wizard-progress" aria-label="연결 단계">
          <li [class.active]="step() >= 1">Kubernetes 확인</li>
          <li [class.active]="step() >= 2">Provider export</li>
          <li [class.active]="step() >= 3">계획 및 승인</li>
        </ol>

        <section *ngIf="step() === 1" class="wizard-step">
          <h4>1. 부모 Kubernetes 클러스터 확인</h4>
          <p>Ceph 연결 리소스는 아래 Kubernetes 클러스터에만 설치됩니다. Console 자체에는 Ceph credential을 마운트하지 않습니다.</p>
          <dl *ngIf="status() as s" class="connection-meta">
            <dt>Cluster fingerprint</dt><dd>{{ s.kubernetes.id }}</dd>
            <dt>Version</dt><dd>{{ s.kubernetes.version }}</dd>
            <dt>Nodes</dt><dd>{{ s.kubernetes.readyNodes }}/{{ s.kubernetes.nodes }} Ready</dd>
          </dl>
          <div class="alert alert-danger" *ngIf="status()?.kubernetes?.ready !== true">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">Kubernetes가 Ready가 아니므로 Ceph 연결을 진행할 수 없습니다.</span></div></div>
          </div>
        </section>

        <section *ngIf="step() === 2" class="wizard-step">
          <h4>2. Rook provider export JSON 입력</h4>
          <p>Ceph provider에서 Rook <code>create-external-cluster-resources.py --format json</code>으로 생성한 제한 권한 export를 입력하십시오. 관리자 keyring·RGW·임의 리소스는 검증 필터가 거부합니다.</p>
          <form clrForm clrLayout="vertical">
            <clr-textarea-container>
              <label>Provider export JSON</label>
              <textarea clrTextarea name="providerExport" [(ngModel)]="providerExport" required autocomplete="off" spellcheck="false" placeholder='[{"name":"rook-ceph-mon-endpoints","kind":"ConfigMap","data":{...}}]'></textarea>
              <clr-control-helper>검증/설치 요청 후 원문은 브라우저 상태에서 즉시 제거됩니다.</clr-control-helper>
            </clr-textarea-container>
          </form>
          <div *ngIf="planLoading()" class="progress loop"><progress></progress></div>
        </section>

        <section *ngIf="step() === 3 && plan() as p" class="wizard-step">
          <h4>3. 설치 계획 및 승인</h4>
          <dl class="connection-meta">
            <dt>Mode</dt><dd>{{ p.mode }}</dd>
            <dt>Namespace</dt><dd>{{ p.namespace }}</dd>
            <dt>FSID fingerprint</dt><dd><code>{{ p.fsidFingerprint }}</code></dd>
            <dt>MON endpoints</dt><dd>{{ p.monitorCount }}개</dd>
            <dt>Charts</dt><dd><span *ngFor="let chart of p.charts">{{ chart.chart }} {{ chart.version }} · </span></dd>
            <dt>Storage</dt><dd><span *ngFor="let storage of p.storage">{{ storage.name }} → {{ storage.pool }}{{ storage.filesystem ? ' / ' + storage.filesystem : '' }} · </span></dd>
            <dt>Snapshots</dt><dd>{{ p.snapshotSupported ? 'VolumeSnapshotClass 생성' : 'Snapshot API 미설치 — 생성 보류' }}</dd>
          </dl>
          <div class="resource-list">
            <div *ngFor="let resource of p.resources">
              <code>{{ resource.kind }}/{{ resource.name }}</code>
              <span>{{ resource.secretRefOnly ? 'Secret 값 비노출' : (resource.reclaimPolicy || resource.deletionPolicy || resource.namespace || 'cluster-scoped') }}</span>
            </div>
          </div>
          <div class="alert alert-warning">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">StorageClass와 snapshot은 <strong>Retain</strong> 정책입니다. 연결 해제는 사용 중인 PV/PVC가 있으면 차단되며, 원격 Ceph data는 삭제하지 않습니다.</span></div></div>
          </div>
          <form clrForm clrLayout="vertical">
            <clr-textarea-container>
              <label>변경 사유</label>
              <textarea clrTextarea name="connectReason" [(ngModel)]="connectReason" required minlength="8" maxlength="500" placeholder="승인 근거와 연결 목적(8자 이상)"></textarea>
            </clr-textarea-container>
          </form>
        </section>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="connectOpen = false">취소</button>
        <button *ngIf="step() > 1" class="btn btn-outline" type="button" [disabled]="busy() || planLoading()" (click)="back()">이전</button>
        <button *ngIf="step() === 1" class="btn btn-primary" type="button" [disabled]="status()?.kubernetes?.ready !== true" (click)="step.set(2)">다음</button>
        <button *ngIf="step() === 2" class="btn btn-primary" type="button" [disabled]="providerExport.trim().length < 20 || planLoading()" (click)="validatePlan()">검증 및 계획</button>
        <button *ngIf="step() === 3" class="btn btn-primary" type="button" [disabled]="busy() || connectReason.trim().length < 8" (click)="connect()">연결 실행</button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="disconnectOpen" [clrModalClosable]="!busy()">
      <h3 class="modal-title">외부 Ceph 연결 해제</h3>
      <div class="modal-body">
        <div class="alert alert-warning">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">사용 중인 PV/PVC가 있으면 작업은 차단됩니다. Consumer 측 Rook·CSI 연결 리소스만 제거하며 원격 Ceph pool/filesystem/data는 보존합니다.</span></div></div>
        </div>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="disconnectReason" [(ngModel)]="disconnectReason" required minlength="8" maxlength="500"></textarea>
          </clr-textarea-container>
          <clr-input-container>
            <label>확인 값</label>
            <input clrInput name="disconnectConfirm" [(ngModel)]="disconnectConfirm" autocomplete="off" placeholder="DISCONNECT">
            <clr-control-helper>DISCONNECT를 정확히 입력하십시오.</clr-control-helper>
          </clr-input-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="disconnectOpen = false">취소</button>
        <button class="btn btn-danger" type="button" [disabled]="busy() || disconnectReason.trim().length < 8 || disconnectConfirm !== 'DISCONNECT'" (click)="disconnect()">안전하게 연결 해제</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host { display: block; }
    .cm-ceph-page-head {
      box-sizing: border-box;
      display: flex;
      justify-content: space-between;
      gap: 1.5rem;
      align-items: flex-start;
      width: 100%;
      height: auto;
      min-height: 0;
      margin: 0 0 0.9rem;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      overflow: visible;
    }
    .cm-ceph-page-head__copy { min-width: 0; }
    .cm-ceph-page-head h1 { margin: 0.15rem 0 0.35rem; color: #2d4048; font-size: 1.45rem; font-weight: 400; line-height: 1.25; }
    .cm-ceph-summary { margin: 0; max-width: 63rem; color: #565656; line-height: 1.5; }
    .cm-ceph-eyebrow { margin: 0; color: #4c6fff; font-size: 0.65rem; font-weight: 600; line-height: 1.5; letter-spacing: 0.06em; text-transform: uppercase; }
    .cm-ceph-page-head__actions { display: flex; gap: 0.35rem; flex: 0 0 auto; }
    .dependency, .connection-card, .empty-state { border: 1px solid #d8d8d8; background: #fff; padding: 0.85rem 1rem; margin-bottom: 0.8rem; }
    .dependency-title { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; }
    .dependency-title > div { display: flex; flex-direction: column; gap: 0.12rem; }
    .dependency-title span:not(.label):not(.sequence) { color: #6f6f6f; font-size: 0.66rem; }
    .sequence { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; background: #4c6fff; color: #fff; font-weight: 600; }
    .dependency dl, .connection-meta { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: 0.35rem 0.8rem; margin: 0.7rem 0; }
    dt { font-weight: 600; color: #3a4d55; }
    dd { margin: 0; min-width: 0; word-break: break-word; }
    .connector { width: 2px; height: 1.1rem; margin: 0.15rem 0 0.15rem 0.68rem; background: #9a9a9a; }
    .status-message { margin: 0.55rem 0 0 2.2rem; color: #565656; }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .card-head h2, .empty-state h2 { margin: 0; font-size: 1rem; }
    .card-head p { margin: 0.15rem 0 0; color: #6f6f6f; }
    .empty-state { text-align: center; padding: 2rem; }
    .empty-state p { color: #6f6f6f; }
    .wizard-progress { display: grid; grid-template-columns: repeat(3, 1fr); padding: 0; margin: 0 0 1rem; list-style: none; counter-reset: step; }
    .wizard-progress li { padding: 0.45rem 0.5rem; border-bottom: 3px solid #d8d8d8; color: #6f6f6f; font-size: 0.68rem; }
    .wizard-progress li.active { border-color: #4c6fff; color: #1b2a32; font-weight: 600; }
    .wizard-step h4 { margin-top: 0; }
    textarea[name='providerExport'] { min-height: 14rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.62rem; }
    textarea { min-height: 4.5rem; }
    .resource-list { max-height: 14rem; overflow: auto; border: 1px solid #d8d8d8; margin: 0.65rem 0; }
    .resource-list > div { display: grid; grid-template-columns: minmax(14rem, 1fr) minmax(8rem, 0.7fr); gap: 0.6rem; padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    code { font-size: 0.63rem; }
    @media (max-width: 62rem) {
      .cm-ceph-page-head, .card-head { flex-direction: column; }
      .dependency dl, .connection-meta { grid-template-columns: 1fr; }
      .resource-list > div { grid-template-columns: 1fr; }
    }
  `],
})
export class CephClustersComponent implements OnInit {
  private ceph = inject(CephService);
  readonly status = signal<CephStatus | null>(null);
  readonly plan = signal<CephPlan | null>(null);
  readonly loading = signal(false);
  readonly planLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly step = signal(1);
  connectOpen = false;
  disconnectOpen = false;
  providerExport = '';
  connectReason = '';
  disconnectReason = '';
  disconnectConfirm = '';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.ceph.status().subscribe({
      next: (status) => { this.status.set(status); this.loading.set(false); },
      error: (failure) => { this.error.set(this.message(failure)); this.loading.set(false); },
    });
  }

  openConnect(): void {
    this.step.set(1);
    this.plan.set(null);
    this.providerExport = '';
    this.connectReason = '';
    this.error.set('');
    this.connectOpen = true;
  }

  back(): void {
    if (this.step() === 3) this.plan.set(null);
    this.step.update((value) => Math.max(1, value - 1));
  }

  validatePlan(): void {
    this.planLoading.set(true);
    this.error.set('');
    this.ceph.plan(this.providerExport).subscribe({
      next: (plan) => { this.plan.set(plan); this.planLoading.set(false); this.step.set(3); },
      error: (failure) => { this.planLoading.set(false); this.error.set(this.message(failure)); },
    });
  }

  connect(): void {
    if (!this.plan() || this.connectReason.trim().length < 8) return;
    this.busy.set(true);
    this.error.set('');
    this.ceph.connect(this.providerExport, this.connectReason.trim()).subscribe({
      next: (result) => {
        this.providerExport = '';
        this.busy.set(false);
        this.connectOpen = false;
        this.notice.set('외부 Ceph 연결 리소스 설치와 실제 연결 검증이 완료되었습니다.');
        this.status.set(result.status);
      },
      error: (failure) => {
        this.providerExport = '';
        this.busy.set(false);
        this.error.set(this.message(failure));
        this.load();
      },
    });
  }

  openDisconnect(): void {
    this.disconnectReason = '';
    this.disconnectConfirm = '';
    this.error.set('');
    this.disconnectOpen = true;
  }

  disconnect(): void {
    if (this.disconnectReason.trim().length < 8 || this.disconnectConfirm !== 'DISCONNECT') return;
    this.busy.set(true);
    this.error.set('');
    this.ceph.disconnect(this.disconnectReason.trim(), this.disconnectConfirm).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.disconnectOpen = false;
        this.notice.set(`Ceph consumer 연결을 해제했습니다. 보존: ${result.retained.join(', ')}`);
        this.load();
      },
      error: (failure) => { this.busy.set(false); this.error.set(this.message(failure)); },
    });
  }

  private message(failure: any): string {
    return String(failure?.error?.error || failure?.message || 'Ceph 연결 요청에 실패했습니다.');
  }
}
