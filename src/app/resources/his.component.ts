import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { HisItem, HisPlan, HisService, HisStatus } from '../core/his.service';

@Component({
  selector: 'app-his',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule],
  template: `
    <header class="his-head">
      <div>
        <p class="eyebrow">Host prerequisite control</p>
        <h1>Host Infrastructure Service Stack</h1>
        <p>HIS는 plugin이 아닙니다. Cluster Manager가 호스트 제공 capability를 진단하고, 승인된 항목만 고정 Helm chart로 설치·검증·삭제합니다.</p>
      </div>
      <button class="btn btn-outline" type="button" [disabled]="loading()" (click)="load()">다시 검사</button>
    </header>

    <div class="alert alert-info" role="note">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>PFS와의 경계:</strong> PFS는 자체 기능·페이지를 가진 독립 plugin입니다. HIS 항목은 개별 메뉴나 plugin을 만들지 않으며 이 화면 하나에서만 관리합니다.
      </span></div></div>
    </div>

    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div *ngIf="notice()" class="alert alert-success" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ notice() }}</span></div></div>
    </div>

    <section class="summary" *ngIf="status() as s">
      <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-danger]="s.state === 'Blocked'" [class.label-warning]="s.state === 'Degraded'">HIS {{ s.state }}</span>
      <span>필수 {{ requiredReady(s) }}/{{ requiredTotal(s) }} Ready</span>
      <span>검사 {{ s.checkedAt | date:'yyyy-MM-dd HH:mm:ss' }}</span>
    </section>

    <clr-datagrid [clrDgLoading]="loading()" *ngIf="status() as s">
      <clr-dg-column>Capability</clr-dg-column>
      <clr-dg-column>관리 방식</clr-dg-column>
      <clr-dg-column>상태</clr-dg-column>
      <clr-dg-column>관측값</clr-dg-column>
      <clr-dg-column>소유권</clr-dg-column>
      <clr-dg-column>작업</clr-dg-column>

      <clr-dg-row *clrDgItems="let item of s.items" [clrDgItem]="item">
        <clr-dg-cell>
          <strong>{{ item.displayName }}</strong>
          <div class="muted">{{ item.description }}</div>
          <div class="muted" *ngIf="item.chartName">{{ item.chartName }} {{ item.chartVersion }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <span class="label" [class.label-info]="item.mode === 'HelmManaged'">{{ item.mode }}</span>
          <span *ngIf="item.required" class="required">필수</span>
        </clr-dg-cell>
        <clr-dg-cell>
          <span class="label" [class.label-success]="item.check.state === 'Ready'" [class.label-danger]="item.check.state === 'Blocked'" [class.label-warning]="item.check.state === 'Degraded'">{{ item.check.state }}</span>
          <div class="muted">{{ item.check.reason }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <div>{{ item.check.message }}</div>
          <div class="muted" *ngIf="item.check.observedVersion">{{ item.check.observedVersion }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <div>{{ item.ownership }}</div>
          <div class="muted" *ngIf="item.release?.managed">Helm {{ item.release.status }} · revision {{ item.release.revision }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <ng-container *ngIf="item.mode === 'HelmManaged'; else detectOnly">
            <button class="btn btn-sm btn-outline" type="button" [disabled]="busy()" (click)="openPlan(item, 'install')">계획</button>
            <button class="btn btn-sm btn-primary" type="button" [disabled]="busy() || !canInstall(item)" (click)="openPlan(item, 'install', true)">설치</button>
            <button class="btn btn-sm btn-danger-outline" type="button" [disabled]="busy() || !item.release?.managed" (click)="openPlan(item, 'uninstall', true)">삭제</button>
          </ng-container>
          <ng-template #detectOnly><span class="muted">호스트 제공 · 진단만</span></ng-template>
        </clr-dg-cell>
        <clr-dg-row-detail *clrIfExpanded>
          <div class="detail"><strong>{{ item.check.reason }}</strong><br>{{ item.check.message }}<br>
            <span *ngIf="item.source">Source: {{ item.source }}</span>
          </div>
        </clr-dg-row-detail>
      </clr-dg-row>

      <clr-dg-footer>{{ s.items.length }}개 HIS capability</clr-dg-footer>
    </clr-datagrid>

    <clr-modal [(clrModalOpen)]="modalOpen" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">{{ action() === 'uninstall' ? 'HIS 삭제 확인' : 'HIS 설치 계획' }}</h3>
      <div class="modal-body" *ngIf="selected() as item">
        <p><strong>{{ item.displayName }}</strong> · {{ item.chartName }} {{ item.chartVersion }}</p>
        <div *ngIf="planLoading()" class="progress loop"><progress></progress></div>
        <div *ngIf="plan() as p">
          <dl class="plan-meta">
            <dt>Release</dt><dd>{{ p.release }}</dd>
            <dt>Namespace</dt><dd>{{ p.namespace }}</dd>
            <dt>Cluster profile</dt><dd>{{ p.clusterVariant }}</dd>
            <dt>Rendered resources</dt><dd>{{ p.resources.length }}</dd>
          </dl>
          <div class="resource-list" *ngIf="action() === 'install'">
            <div *ngFor="let r of p.resources | slice:0:40"><code>{{ r.kind }}/{{ r.name }}</code><span>{{ r.namespace }}</span></div>
            <p class="muted" *ngIf="p.resources.length > 40">외 {{ p.resources.length - 40 }}개</p>
          </div>
          <div class="alert alert-warning" *ngIf="action() === 'uninstall' && p.retainedOnDelete.length">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">삭제 후 보존: {{ p.retainedOnDelete.join(', ') }}</span></div></div>
          </div>
        </div>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="reason" [(ngModel)]="reason" required minlength="8" maxlength="500" placeholder="승인 근거와 작업 목적(8자 이상)"></textarea>
          </clr-textarea-container>
          <clr-input-container *ngIf="action() === 'uninstall'">
            <label>삭제 확인</label>
            <input clrInput name="confirm" [(ngModel)]="confirm" [placeholder]="item.id" autocomplete="off">
            <clr-control-helper>{{ item.id }} 를 정확히 입력하십시오.</clr-control-helper>
          </clr-input-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="modalOpen = false">취소</button>
        <button *ngIf="executeRequested()" class="btn" [class.btn-primary]="action() === 'install'" [class.btn-danger]="action() === 'uninstall'" type="button" [disabled]="!readyToExecute()" (click)="execute()">
          {{ action() === 'install' ? '설치 실행' : '삭제 실행' }}
        </button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host { display: block; }
    .his-head { display: flex; justify-content: space-between; gap: 1.5rem; align-items: flex-start; margin-bottom: 0.8rem; }
    .his-head h1 { margin: 0.15rem 0 0.35rem; font-size: 1.45rem; font-weight: 400; }
    .his-head p { margin: 0; max-width: 62rem; color: #565656; }
    .eyebrow { color: #4c6fff !important; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .summary { display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0; color: #565656; font-size: 0.72rem; }
    .muted { color: #6f6f6f; font-size: 0.65rem; margin-top: 0.12rem; }
    .required { margin-left: 0.35rem; color: #a32100; font-size: 0.62rem; font-weight: 600; }
    .detail { padding: 0.6rem 1rem; line-height: 1.5; }
    .plan-meta { display: grid; grid-template-columns: 9rem 1fr; gap: 0.35rem 0.8rem; margin: 0.8rem 0; }
    .plan-meta dt { font-weight: 600; }
    .plan-meta dd { margin: 0; }
    .resource-list { max-height: 16rem; overflow: auto; border: 1px solid #d8d8d8; }
    .resource-list > div { display: grid; grid-template-columns: minmax(16rem, 1fr) minmax(8rem, 0.5fr); padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    textarea { min-height: 5rem; }
  `],
})
export class HisComponent implements OnInit {
  private his = inject(HisService);
  readonly status = signal<HisStatus | null>(null);
  readonly selected = signal<HisItem | null>(null);
  readonly plan = signal<HisPlan | null>(null);
  readonly action = signal<'install' | 'uninstall'>('install');
  readonly executeRequested = signal(false);
  readonly loading = signal(false);
  readonly planLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  modalOpen = false;
  reason = '';
  confirm = '';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.his.status().subscribe({
      next: (status) => { this.status.set(status); this.loading.set(false); },
      error: (error) => { this.error.set(this.message(error)); this.loading.set(false); },
    });
  }

  requiredTotal(status: HisStatus): number { return status.items.filter((item) => item.required).length; }
  requiredReady(status: HisStatus): number { return status.items.filter((item) => item.required && item.check.state === 'Ready').length; }
  canInstall(item: HisItem): boolean {
    if (item.mode !== 'HelmManaged') return false;
    if (item.check.state === 'Ready' && item.ownership === 'External') return false;
    if (item.check.state === 'Degraded' && !item.release?.managed) return false;
    return item.check.state !== 'Ready' || !!item.release?.managed;
  }

  openPlan(item: HisItem, action: 'install' | 'uninstall', execute = false): void {
    this.selected.set(item);
    this.action.set(action);
    this.executeRequested.set(execute);
    this.plan.set(null);
    this.reason = '';
    this.confirm = '';
    this.error.set('');
    this.modalOpen = true;
    this.planLoading.set(true);
    this.his.plan(item.id).subscribe({
      next: (plan) => { this.plan.set(plan); this.planLoading.set(false); },
      error: (error) => { this.error.set(this.message(error)); this.planLoading.set(false); },
    });
  }

  readyToExecute(): boolean {
    const item = this.selected();
    if (!item || !this.plan() || this.busy() || this.reason.trim().length < 8) return false;
    return this.action() === 'install' || this.confirm === item.id;
  }

  execute(): void {
    const item = this.selected();
    if (!item || !this.readyToExecute()) return;
    this.busy.set(true);
    this.error.set('');
    const request = this.action() === 'install'
      ? this.his.install(item.id, this.reason.trim())
      : this.his.uninstall(item.id, this.reason.trim(), this.confirm);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.modalOpen = false;
        this.notice.set(`${item.displayName} ${this.action() === 'install' ? '설치 및 검증' : '삭제'}가 완료되었습니다.`);
        this.load();
      },
      error: (error) => { this.busy.set(false); this.error.set(this.message(error)); },
    });
  }

  private message(error: any): string {
    return String(error?.error?.error || error?.message || 'HIS 요청에 실패했습니다.');
  }
}
