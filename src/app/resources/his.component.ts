import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import {
  HisItem,
  HisOperation,
  HisPlan,
  HisService,
  HisStatus,
  ObservabilityConfig,
  ObservabilityConfigurationPlan,
  ObservabilityConfigurationState,
} from '../core/his.service';

type HisLifecycleAction = 'install' | 'upgrade' | 'recover' | 'blocked';
type HisMutationAction = 'install' | 'upgrade' | 'recover' | 'rollback' | 'uninstall';
type ObservabilityConfigurationMode = 'install' | 'operate';

@Component({
  selector: 'app-his',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule],
  template: `
    <div class="os-page-header his-head">
      <div class="os-page-header-main">
        <p class="os-page-eyebrow">Host infrastructure lifecycle</p>
        <h1 class="os-page-title">HIS <span class="title-expansion">Host Infrastructure Service Stack</span></h1>
        <p class="os-page-description">Cluster Manager가 호스트 capability를 진단하고 승인된 항목의 계획·설치·운영·구성·실검증·롤백·삭제를 관리합니다.</p>
      </div>
      <div class="os-page-header-actions">
        <button class="btn btn-outline" type="button" [disabled]="loading()" (click)="load()">
          <cds-icon shape="refresh" aria-hidden="true"></cds-icon> 다시 검사
        </button>
      </div>
    </div>

    <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">
        <strong>PFS와의 경계:</strong> PFS는 자체 기능·페이지를 가진 독립 plugin입니다. HIS 항목은 개별 메뉴나 plugin을 만들지 않으며 이 화면 하나에서만 관리합니다.
      </span></clr-alert-item>
    </clr-alert>

    <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
    </clr-alert>
    <clr-alert *ngIf="notice()" [clrAlertType]="'success'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">{{ notice() }}</span></clr-alert-item>
    </clr-alert>

    <section class="summary" *ngIf="status() as s">
      <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-danger]="s.state === 'Blocked'" [class.label-warning]="s.state === 'Degraded'">HIS {{ s.state }}</span>
      <span>Core {{ s.summary.coreReady }}/{{ s.summary.coreTotal }} Ready</span>
      <span>활성 profile {{ s.summary.selectedProfilesReady }}/{{ s.summary.selectedProfilesTotal }} Ready</span>
      <span>검사 {{ s.checkedAt | date:'yyyy-MM-dd HH:mm:ss' }}</span>
    </section>

    <section class="profile-summary" *ngIf="status() as s" aria-label="HIS profiles">
      <article *ngFor="let profile of s.profiles" [class.profile-selected]="profile.selected">
        <div>
          <strong>{{ profile.name }}</strong>
          <span>{{ profile.selected ? '활성 요구조건' : '미선택' }} · {{ profile.ready }}/{{ profile.total }} capability Ready</span>
        </div>
        <span class="label" [class.label-success]="profile.state === 'Ready'" [class.label-warning]="profile.state === 'Degraded'" [class.label-danger]="profile.state === 'Blocked'">{{ profile.state }}</span>
      </article>
    </section>

    <clr-datagrid [clrDgLoading]="loading()" *ngIf="status() as s">
      <clr-dg-column>Capability</clr-dg-column>
      <clr-dg-column>관리 방식</clr-dg-column>
      <clr-dg-column>상태</clr-dg-column>
      <clr-dg-column>관측값</clr-dg-column>
      <clr-dg-column>소유권</clr-dg-column>
      <clr-dg-column>작업</clr-dg-column>

      <clr-dg-row
        *clrDgItems="let item of s.items"
        [clrDgItem]="item"
        [attr.data-his-item]="item.id"
        [clrDgExpanded]="isExpanded(item.id)"
        (clrDgExpandedChange)="setExpanded(item.id, $event)"
      >
        <clr-dg-cell>
          <strong>{{ item.displayName }}</strong>
          <span class="domain-badge" *ngIf="item.domain">{{ item.domain }}</span>
          <div class="muted">{{ item.description }}</div>
          <div class="muted" *ngIf="item.chartName">{{ item.chartName }} {{ item.chartVersion }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <span class="label" [class.label-info]="item.mode === 'HelmManaged'">{{ item.mode }}</span>
          <span *ngIf="item.required" class="required">필수</span>
          <span *ngIf="!item.required && item.profile" class="optional">{{ item.profileSelected ? '활성 profile' : '선택 가능' }} · {{ item.profile }}</span>
        </clr-dg-cell>
        <clr-dg-cell>
          <span class="label" [class.label-success]="item.check.state === 'Ready'" [class.label-danger]="item.check.state === 'Blocked'" [class.label-warning]="item.check.state === 'Degraded'">{{ item.check.state }}</span>
          <div class="muted">{{ item.check.reason }}</div>
          <div class="operation-inline" *ngIf="item.operation && operationActive(item.operation)">{{ item.operation.phase }} · {{ item.operation.progress }}%</div>
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
          <div class="action-cell">
            <div class="action-buttons">
              <button
                class="btn btn-sm action-primary"
                [ngClass]="primaryActionClass(item)"
                type="button"
                [disabled]="primaryActionDisabled(item)"
                (click)="runPrimaryAction(item)"
              >
                {{ primaryActionLabel(item) }}
              </button>

              <clr-dropdown *ngIf="item.mode === 'HelmManaged' && item.id !== 'kube-prometheus-stack'">
                <button
                  type="button"
                  class="btn btn-sm btn-link btn-icon action-overflow"
                  clrDropdownTrigger
                  [attr.aria-label]="item.displayName + ' 추가 작업'"
                >
                  <cds-icon shape="ellipsis-vertical" aria-hidden="true"></cds-icon>
                </button>
                <clr-dropdown-menu *clrIfOpen clrPosition="bottom-right" [attr.aria-label]="item.displayName + ' 추가 작업'">
                  <button
                    type="button"
                    clrDropdownItem
                    [disabled]="busy() || operationActive(item.operation) || releaseLifecycle(item) === 'blocked'"
                    (click)="openPlan(item, planAction(item))"
                  >계획 검토</button>
                  <button
                    *ngIf="item.release?.managed"
                    type="button"
                    clrDropdownItem
                    [disabled]="busy() || operationActive(item.operation) || !rollbackAvailable(item)"
                    (click)="openPlan(item, 'rollback', true)"
                  >롤백</button>
                  <button
                    *ngIf="item.release?.managed"
                    type="button"
                    clrDropdownItem
                    class="action-danger"
                    [disabled]="busy() || operationActive(item.operation)"
                    (click)="openPlan(item, 'uninstall', true)"
                  >삭제</button>
                </clr-dropdown-menu>
              </clr-dropdown>

              <clr-dropdown *ngIf="item.mode === 'DetectOnly' && item.profile">
                <button
                  type="button"
                  class="btn btn-sm btn-link btn-icon action-overflow"
                  clrDropdownTrigger
                  [attr.aria-label]="item.displayName + ' 추가 작업'"
                >
                  <cds-icon shape="ellipsis-vertical" aria-hidden="true"></cds-icon>
                </button>
                <clr-dropdown-menu *clrIfOpen clrPosition="bottom-right" [attr.aria-label]="item.displayName + ' 추가 작업'">
                  <button type="button" clrDropdownItem [disabled]="busy()" (click)="openProfileSelection(item)">
                    {{ item.profileSelected ? '요구조건 해제' : '요구조건으로 선택' }}
                  </button>
                </clr-dropdown-menu>
              </clr-dropdown>
            </div>
          </div>
        </clr-dg-cell>
        <clr-dg-row-detail *clrIfExpanded>
          <div class="detail">
            <section class="operation-card" *ngIf="item.operation as operation" role="status" aria-live="polite">
              <div class="operation-head">
                <div><strong>{{ operationLabel(operation) }} 작업 · {{ operation.phase }}</strong><div class="muted">작업 ID {{ operation.id }} · {{ operation.actor }} · {{ operation.worker }}</div></div>
                <span class="label" [class.label-success]="operation.phase === 'Ready' || operation.phase === 'Removed'" [class.label-danger]="operation.phase === 'Failed' || operation.phase === 'RollbackStalled'" [class.label-info]="operationActive(operation)">{{ operation.progress }}%</span>
              </div>
              <clr-progress-bar class="progress-block" [clrValue]="operation.progress"
                                [attr.aria-label]="operation.message"></clr-progress-bar>
              <p>{{ operation.message }}</p>
              <p class="operation-error" *ngIf="operation.error">{{ operation.error }}</p>
              <div class="muted">시작 {{ operation.startedAt | date:'yyyy-MM-dd HH:mm:ss' }} · 갱신 {{ operation.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}<span *ngIf="operation.releaseStatus"> · Helm {{ operation.releaseStatus }}</span></div>
            </section>
            <div class="detail-summary"><strong>{{ item.check.reason }}</strong><span>{{ item.check.message }}</span><span *ngIf="item.source">Source: {{ item.source }}</span></div>
            <section *ngIf="item.check.details as details" class="operational-section">
              <h4 *ngIf="details.components?.length">구성요소 운영 상태</h4>
              <clr-datagrid class="component-table" *ngIf="details.components?.length">
                <clr-dg-column>서비스</clr-dg-column><clr-dg-column>리소스</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>Ready</clr-dg-column><clr-dg-column>이미지</clr-dg-column>
                <clr-dg-row *ngFor="let component of details.components">
                  <clr-dg-cell>{{ component.name }}</clr-dg-cell><clr-dg-cell><code>{{ component.kind }}/{{ component.resourceName || '—' }}</code></clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="component.state === 'Ready'" [class.label-warning]="component.state === 'Pending'" [class.label-danger]="component.state === 'Missing'">{{ component.state }}</span></clr-dg-cell>
                  <clr-dg-cell>{{ component.ready }}/{{ component.desired }}</clr-dg-cell><clr-dg-cell class="image-cell">{{ component.image || '—' }}</clr-dg-cell>
                </clr-dg-row>
              </clr-datagrid>
              <div class="resource-health">
                <span>CRD {{ details.crds?.ready || 0 }}/{{ details.crds?.total || 0 }}</span>
                <span>PVC {{ details.pvcs?.length || 0 }}개</span>
                <span>Service {{ details.services?.length || 0 }}개</span>
              </div>
              <clr-datagrid  *ngIf="details.pvcs?.length">
                <clr-dg-column>PVC</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>요청/할당</clr-dg-column><clr-dg-column>StorageClass</clr-dg-column>
                <clr-dg-row *ngFor="let pvc of details.pvcs"><clr-dg-cell>{{ pvc.name }}</clr-dg-cell><clr-dg-cell>{{ pvc.phase }}</clr-dg-cell><clr-dg-cell>{{ pvc.requested }} / {{ pvc.capacity || '—' }}</clr-dg-cell><clr-dg-cell>{{ pvc.storageClass }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
              <clr-datagrid  *ngIf="details.services?.length">
                <clr-dg-column>Service</clr-dg-column><clr-dg-column>유형</clr-dg-column><clr-dg-column>Cluster IP</clr-dg-column><clr-dg-column>Ports</clr-dg-column>
                <clr-dg-row *ngFor="let service of details.services"><clr-dg-cell>{{ service.name }}</clr-dg-cell><clr-dg-cell>{{ service.type }}</clr-dg-cell><clr-dg-cell>{{ service.clusterIP }}</clr-dg-cell><clr-dg-cell>{{ service.ports }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
              <div class="compatibility-card" *ngIf="details.compatibility as compatibility">
                <div><span>COMPATIBILITY</span><strong>{{ compatibility.kubernetes }}</strong></div>
                <p>{{ compatibility.policy }}</p>
              </div>
              <div class="fact-grid" *ngIf="details.facts?.length">
                <article *ngFor="let fact of details.facts" [class.fact-failed]="fact.state === 'Failed'" [class.fact-passed]="fact.state === 'Passed'">
                  <span>{{ fact.label }}</span><strong>{{ fact.value }}</strong><small>{{ fact.state }}</small>
                </article>
              </div>
              <clr-alert class="compact-alert" *ngIf="details.warnings?.length"
                         [clrAlertType]="'warning'" [clrAlertClosable]="false">
                <clr-alert-item><span class="alert-text"><strong>위험·주의</strong><ul><li *ngFor="let warning of details.warnings">{{ warning }}</li></ul></span></clr-alert-item>
              </clr-alert>
              <div class="security-card" *ngIf="details.security?.length">
                <strong>보안·노출·데이터 정책</strong><ul><li *ngFor="let policy of details.security">{{ policy }}</li></ul>
              </div>
              <section class="diagnostic-table" *ngFor="let table of details.tables">
                <h4>{{ table.title }}</h4>
                <div class="table-scroll"><clr-datagrid>
                  <clr-dg-column *ngFor="let column of table.columns">{{ column.label }}</clr-dg-column>

                    <clr-dg-row *ngFor="let row of table.rows"><clr-dg-cell *ngFor="let column of table.columns">{{ row[column.key] || '—' }}</clr-dg-cell></clr-dg-row>
                    <clr-dg-row *ngIf="!table.rows.length"><clr-dg-cell [attr.colspan]="table.columns.length" class="empty-cell">해당 오류·리소스가 없습니다.</clr-dg-cell></clr-dg-row>

                </clr-datagrid></div>
              </section>
              <section class="canary-section" *ngIf="details.canaries?.length">
                <h4>Validation canary</h4>
                <div class="canary-list"><article *ngFor="let canary of details.canaries">
                  <span class="label" [class.label-success]="canary.state === 'Passed'" [class.label-danger]="canary.state === 'Failed'" [class.label-warning]="canary.state === 'NotRun'">{{ canary.state }}</span>
                  <div><strong>{{ canary.name }}</strong><p>{{ canary.message }}</p></div>
                </article></div>
              </section>
              <section class="remediation-card" *ngIf="details.remediation as remediation">
                <p class="eyebrow">REMEDIATION</p><h4>보정 절차</h4><p>{{ remediation.summary }}</p>
                <ol><li *ngFor="let step of remediation.steps">{{ step }}</li></ol>
                <div><strong>재검증:</strong> {{ remediation.verification }}</div>
              </section>
            </section>
          </div>
        </clr-dg-row-detail>
      </clr-dg-row>

      <clr-dg-footer>{{ s.items.length }}개 HIS capability</clr-dg-footer>
    </clr-datagrid>

    <clr-modal class="observability-lifecycle-modal" [(clrModalOpen)]="observabilityLifecycleModalOpen" [clrModalClosable]="!busy() && !configurationBusy()" [clrModalSize]="'xl'">
      <h3 class="modal-title observability-modal-title">
        <span class="observability-logo-pair" aria-hidden="true">
          <img [src]="prometheusLogo" alt="" width="32" height="32">
          <img [src]="grafanaLogo" alt="" width="32" height="32">
        </span>
        <span class="observability-modal-title-copy">
          <strong>Shared Observability 관리</strong>
          <small>Prometheus metrics · Grafana dashboards</small>
        </span>
      </h3>
      <div class="modal-body lifecycle-workspace" *ngIf="observabilityTarget() as item">
        <section class="observability-quick-card" [class.is-ready]="observabilityInstallReady(item) || item.check.state === 'Ready'" aria-labelledby="observability-quick-title">
          <div class="quick-card-copy">
            <p class="eyebrow">{{ item.release?.managed ? 'CURRENT SERVICE' : 'QUICK INSTALL' }}</p>
            <div class="quick-card-title">
              <h4 id="observability-quick-title">{{ item.release?.managed ? 'Shared Observability 운영 중' : '권장 설정으로 한 번에 설치' }}</h4>
              <span class="label" [class.label-success]="item.check.state === 'Ready'" [class.label-danger]="item.check.state === 'Blocked'" [class.label-warning]="item.check.state === 'Degraded'">{{ releaseStateLabel(item) }}</span>
            </div>
            <p>{{ item.release?.managed
              ? 'Prometheus 수집과 Grafana 시각화의 현재 상태를 확인하고 필요한 운영 작업만 선택합니다.'
              : '필요한 설치 값을 선택하면 OpenSphere가 나머지 내부 준비와 실행 기록을 처리합니다.' }}</p>
            <form *ngIf="!item.release?.managed" clrForm clrLayout="vertical" class="quick-install-options">
              <clr-select-container>
                <label>Chart version</label>
                <select clrSelect name="quickChartVersion" [(ngModel)]="observabilityChartVersion" (ngModelChange)="chartVersionChanged()">
                  <option *ngFor="let version of item.availableChartVersions" [value]="version">{{ item.chartName }} {{ version }}</option>
                </select>
                <clr-control-helper>서명된 release에서 선택합니다.</clr-control-helper>
              </clr-select-container>
              <div class="quick-static-field">
                <span>Namespace</span>
                <strong><code>{{ item.namespace }}</code></strong>
                <small>Shared Observability의 고정 관리 namespace</small>
              </div>
              <clr-select-container>
                <label>StorageClass</label>
                <select clrSelect name="quickStorageClass" [ngModel]="sharedStorageClassName()" (ngModelChange)="sharedStorageClassChanged($event)">
                  <option value="">Cluster default</option>
                  <option *ngFor="let sc of observabilityState()?.storageClasses" [value]="sc.name">
                    {{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}
                  </option>
                </select>
                <clr-control-helper>{{ sharedStorageClassHint() }}</clr-control-helper>
              </clr-select-container>
            </form>
            <dl class="quick-facts" *ngIf="item.release?.managed">
              <div><dt>Chart</dt><dd>{{ item.chartName }} {{ observabilityChartVersion }}</dd></div>
              <div><dt>Namespace</dt><dd><code>{{ item.namespace }}</code></dd></div>
              <div><dt>Storage</dt><dd>{{ quickStorageSummary() }}</dd></div>
              <div><dt>Helm revision</dt><dd>{{ item.release.revision }}</dd></div>
            </dl>
          </div>
          <div class="quick-card-readiness" role="status" aria-live="polite">
            <ng-container *ngIf="configurationLoading() || configurationPlanning(); else quickReadinessResolved">
              <span class="spinner spinner-sm" aria-hidden="true"></span>
              <div><strong>선택값 확인 중</strong><p>Chart와 StorageClass를 확인하고 있습니다.</p></div>
            </ng-container>
            <ng-template #quickReadinessResolved>
              <ng-container *ngIf="observabilityBlockingIssues(item) as issues">
                <ng-container *ngIf="!issues.length; else quickBlocked">
                  <cds-icon shape="success-standard" status="success" size="28" aria-hidden="true"></cds-icon>
                  <div><strong>{{ item.release?.managed ? '서비스 정상' : '설치 가능' }}</strong><p>{{ item.release?.managed ? '필요할 때 구성 변경이나 실검증을 실행할 수 있습니다.' : '선택한 값으로 설치 요청을 제출할 수 있습니다.' }}</p></div>
                </ng-container>
                <ng-template #quickBlocked>
                  <cds-icon shape="warning-standard" status="warning" size="28" aria-hidden="true"></cds-icon>
                  <div>
                    <strong>준비할 항목 {{ issues.length }}개</strong>
                    <ul><li *ngFor="let issue of issues">{{ issue }}</li></ul>
                  </div>
                </ng-template>
              </ng-container>
            </ng-template>
          </div>
        </section>

        <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
        </clr-alert>

        <section class="observability-advanced" *ngIf="observabilityAdvancedOpen && observabilityConfig() as config">
          <div class="section-heading">
            <div><p class="eyebrow">ADVANCED SETTINGS</p><h4>{{ item.release?.managed ? '현재 운영 구성' : '설치 세부 설정' }}</h4></div>
            <button class="btn btn-sm btn-outline" type="button" [disabled]="configurationLoading() || operationActive(item.operation)" (click)="openObservabilityConfiguration(item.release?.managed ? 'operate' : 'install')">
              {{ item.release?.managed ? '구성 변경' : '전체 옵션 편집' }}
            </button>
          </div>
          <clr-alert *ngIf="observabilityState()?.live?.accessIssues?.length" [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">
              <strong>일부 운영 상태는 권한 승인 후 확인됩니다.</strong>
              StorageClass 선택과 설치 옵션은 지금 구성할 수 있습니다.
            </span></clr-alert-item>
          </clr-alert>
          <form clrForm clrLayout="vertical" class="storage-form-grid">
            <clr-select-container>
              <label>Prometheus StorageClass</label>
              <select clrSelect name="prometheusStorageClassSummary" [(ngModel)]="config.prometheus.storageClassName" (ngModelChange)="storageSelectionChanged()">
                <option value="">Cluster default</option><option *ngFor="let sc of observabilityState()?.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option>
              </select>
              <clr-control-helper>{{ config.prometheus.storageSize }} · retention {{ config.prometheus.retention }}</clr-control-helper>
            </clr-select-container>
            <clr-select-container>
              <label>Alertmanager StorageClass</label>
              <select clrSelect name="alertmanagerStorageClassSummary" [(ngModel)]="config.alertmanager.storageClassName" (ngModelChange)="storageSelectionChanged()">
                <option value="">Cluster default</option><option *ngFor="let sc of observabilityState()?.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option>
              </select>
              <clr-control-helper>{{ config.alertmanager.storageSize }} · retention {{ config.alertmanager.retention }}</clr-control-helper>
            </clr-select-container>
            <clr-select-container>
              <label>Grafana StorageClass</label>
              <select clrSelect name="grafanaStorageClassSummary" [(ngModel)]="config.grafana.storageClassName" (ngModelChange)="storageSelectionChanged()">
                <option value="">Cluster default</option><option *ngFor="let sc of observabilityState()?.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option>
              </select>
              <clr-control-helper>{{ config.grafana.storageSize }} · {{ config.grafana.exposureMode }}</clr-control-helper>
            </clr-select-container>
            <clr-select-container *ngIf="config.telemetry.enabled">
              <label>Loki·Tempo StorageClass</label>
              <select clrSelect name="telemetryStorageClassSummary" [(ngModel)]="config.telemetry.storageClassName" (ngModelChange)="storageSelectionChanged()">
                <option value="">Cluster default</option><option *ngFor="let sc of observabilityState()?.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option>
              </select>
              <clr-control-helper>Loki {{ config.telemetry.lokiStorageSize }} · Tempo {{ config.telemetry.tempoStorageSize }}</clr-control-helper>
            </clr-select-container>
          </form>
          <ng-container *ngIf="observabilityPlan() as configPlan">
            <clr-alert *ngIf="configPlan.blockers.length" [clrAlertType]="'danger'" [clrAlertClosable]="false">
              <clr-alert-item><span class="alert-text"><strong>설치 전 해결 필요</strong><ul><li *ngFor="let blocker of configPlan.blockers">{{ blocker }}</li></ul></span></clr-alert-item>
            </clr-alert>
            <clr-alert *ngIf="configPlan.warnings.length" [clrAlertType]="'warning'" [clrAlertClosable]="false">
              <clr-alert-item><span class="alert-text"><strong>운영 주의</strong><ul><li *ngFor="let warning of configPlan.warnings">{{ warning }}</li></ul></span></clr-alert-item>
            </clr-alert>
          </ng-container>
        </section>

        <section class="lifecycle-section" *ngIf="item.release?.managed">
          <div class="section-heading">
            <div><p class="eyebrow">OPERATE</p><h4>현재 운영 상태</h4></div>
            <span>Helm revision과 실제 workload·PVC·canary 결과를 함께 판정합니다.</span>
          </div>
          <div class="operation-facts">
            <article>
              <span>Helm release</span>
              <strong>{{ item.release.status }} · revision {{ item.release.revision }}</strong>
            </article>
            <article>
              <span>Workload</span>
              <strong>{{ readyComponentCount(item) }}/{{ item.check.details?.components?.length || 0 }} Ready</strong>
            </article>
            <article>
              <span>영구 데이터</span>
              <strong>PVC {{ item.check.details?.pvcs?.length || 0 }}개</strong>
            </article>
            <article>
              <span>최근 실검증</span>
              <strong>{{ validationSummary(item) }}</strong>
            </article>
          </div>
          <ng-container *ngIf="item.check.details as details">
            <clr-datagrid  *ngIf="details.components?.length">
              <clr-dg-column>서비스</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>Ready</clr-dg-column><clr-dg-column>이미지</clr-dg-column>
              <clr-dg-row *ngFor="let component of details.components">
                <clr-dg-cell>{{ component.name }}</clr-dg-cell>
                <clr-dg-cell><span class="label" [class.label-success]="component.state === 'Ready'" [class.label-warning]="component.state === 'Pending'" [class.label-danger]="component.state === 'Missing'">{{ component.state }}</span></clr-dg-cell>
                <clr-dg-cell>{{ component.ready }}/{{ component.desired }}</clr-dg-cell>
                <clr-dg-cell class="image-cell">{{ component.image || '—' }}</clr-dg-cell>
              </clr-dg-row>
            </clr-datagrid>
          </ng-container>
        </section>

        <section class="operation-card" *ngIf="item.operation as operation" role="status" aria-live="polite">
          <div class="operation-head">
            <div><strong>{{ operationLabel(operation) }} · {{ operation.phase }}</strong><div class="muted">작업 ID {{ operation.id }} · {{ operation.actor }}</div></div>
            <span class="label" [class.label-success]="operation.phase === 'Ready' || operation.phase === 'Removed'" [class.label-danger]="operation.phase === 'Failed' || operation.phase === 'RollbackStalled'" [class.label-info]="operationActive(operation)">{{ operation.progress }}%</span>
          </div>
          <clr-progress-bar [clrValue]="operation.progress" [clrMax]="100" [clrLabeled]="true"></clr-progress-bar>
          <p>{{ operation.message }}</p>
          <p class="operation-error" *ngIf="operation.error">{{ operation.error }}</p>
        </section>
      </div>
      <div class="modal-footer observability-modal-footer" *ngIf="observabilityTarget() as item">
        <div class="observability-footer-view">
          <button class="btn btn-outline" type="button" [disabled]="configurationLoading()" (click)="observabilityAdvancedOpen = !observabilityAdvancedOpen">
            {{ observabilityAdvancedOpen ? '간단히 보기' : '고급 설정' }}
          </button>
        </div>
        <div class="observability-footer-actions">
          <button class="btn btn-outline" type="button" [disabled]="busy() || configurationBusy()" (click)="observabilityLifecycleModalOpen = false">닫기</button>
          <button *ngIf="releaseLifecycle(item) === 'install'" class="btn btn-primary" type="button" [disabled]="!observabilityInstallReady(item)" (click)="openPlanFromObservability(item, 'install', true)">빠른 설치 요청</button>
          <button *ngIf="releaseLifecycle(item) === 'upgrade'" class="btn btn-primary" type="button" [disabled]="busy() || operationActive(item.operation)" (click)="openPlanFromObservability(item, 'upgrade', true)">업그레이드 요청</button>
          <button *ngIf="releaseLifecycle(item) === 'recover'" class="btn btn-warning-outline" type="button" [disabled]="busy() || operationActive(item.operation)" (click)="openPlanFromObservability(item, 'recover', true)">복구</button>
          <clr-dropdown *ngIf="item.release?.managed">
            <button clrDropdownTrigger class="btn btn-outline" type="button">추가 작업</button>
            <clr-dropdown-menu *clrIfOpen>
              <button clrDropdownItem type="button" [disabled]="busy() || operationActive(item.operation) || !canValidate(item)" (click)="openCanaryFromObservability(item)">실검증</button>
              <button clrDropdownItem type="button" [disabled]="busy() || operationActive(item.operation) || !rollbackAvailable(item)" (click)="openPlanFromObservability(item, 'rollback', true)">롤백</button>
              <button clrDropdownItem type="button" [disabled]="busy() || operationActive(item.operation)" (click)="openPlanFromObservability(item, 'uninstall', true)">삭제</button>
            </clr-dropdown-menu>
          </clr-dropdown>
        </div>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="modalOpen" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">{{ actionTitle() }}</h3>
      <div class="modal-body" *ngIf="selected() as item">
        <p><strong>{{ item.displayName }}</strong> · {{ item.chartName }} {{ item.id === 'kube-prometheus-stack' ? observabilityChartVersion : item.chartVersion }}</p>
        <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
        </clr-alert>
        <clr-spinner *ngIf="planLoading()" clrInline aria-label="계획을 불러오는 중"></clr-spinner>
        <div *ngIf="plan() as p">
          <ng-container *ngIf="quickInstallRequest(item); else fullPlan">
            <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false">
              <clr-alert-item><span class="alert-text">
                승인되면 OpenSphere가 권장값으로 설치하고 진행 상태와 결과를 이 화면에 기록합니다.
              </span></clr-alert-item>
            </clr-alert>
            <dl class="quick-confirmation">
              <div><dt>설치 항목</dt><dd>Prometheus · Grafana · Alertmanager</dd></div>
              <div><dt>Chart</dt><dd>{{ p.chart }} {{ p.chartVersion }}</dd></div>
              <div><dt>Namespace</dt><dd><code>{{ p.namespace }}</code></dd></div>
              <div><dt>영구 저장소</dt><dd>{{ quickStorageSummary() }}</dd></div>
            </dl>
            <details class="technical-plan">
              <summary>기술 계획 보기</summary>
              <dl class="plan-meta">
                <dt>Rendered resources</dt><dd>{{ p.resources.length }}</dd>
                <dt>Workloads / Services</dt><dd>{{ p.summary.workloads }} / {{ p.summary.services }}</dd>
                <dt>CRD / PVC</dt><dd>{{ p.summary.customResourceDefinitions }} / {{ p.summary.persistentVolumeClaims }}</dd>
              </dl>
              <div class="resource-list">
                <div *ngFor="let r of p.resources | slice:0:40"><code>{{ r.kind }}/{{ r.name }}</code><span>{{ r.namespace }}</span></div>
                <p class="muted" *ngIf="p.resources.length > 40">외 {{ p.resources.length - 40 }}개</p>
              </div>
            </details>
          </ng-container>
          <ng-template #fullPlan>
            <dl class="plan-meta">
              <dt>Release</dt><dd>{{ p.release }}</dd>
              <dt>Chart version</dt><dd>{{ p.chartVersion }}</dd>
              <dt>Namespace</dt><dd>{{ p.namespace }}</dd>
              <dt>Cluster profile</dt><dd>{{ p.clusterVariant }}</dd>
              <dt>Rendered resources</dt><dd>{{ p.resources.length }}</dd>
              <dt>Workloads / Services</dt><dd>{{ p.summary.workloads }} / {{ p.summary.services }}</dd>
              <dt>CRD / PVC</dt><dd>{{ p.summary.customResourceDefinitions }} / {{ p.summary.persistentVolumeClaims }}</dd>
            </dl>
            <div class="profile-card" *ngIf="p.operationalProfile as profile">
              <strong>설치 서비스</strong><span>{{ profile.components.join(', ') }}</span>
              <strong>영구 저장소</strong><span>{{ profile.storage.join(', ') }}</span>
              <strong>보존 정책</strong><span>{{ profile.retention.join(', ') }}</span>
              <strong>접근 방식</strong><span>{{ profile.exposure }}</span>
            </div>
            <clr-datagrid class="storage-plan" *ngIf="p.storagePlan?.length">
              <clr-dg-column>구성요소</clr-dg-column><clr-dg-column>StorageClass</clr-dg-column>
              <clr-dg-column>용량</clr-dg-column><clr-dg-column>보존기간</clr-dg-column>
              <clr-dg-row *ngFor="let storage of p.storagePlan">
                <clr-dg-cell>{{ storage.component }}</clr-dg-cell>
                <clr-dg-cell><strong>{{ storage.storageClassName }}</strong></clr-dg-cell>
                <clr-dg-cell>{{ storage.storageSize }}</clr-dg-cell>
                <clr-dg-cell>{{ storage.retention }}</clr-dg-cell>
              </clr-dg-row>
            </clr-datagrid>
            <div class="resource-list" *ngIf="action() === 'install'">
              <div *ngFor="let r of p.resources | slice:0:40"><code>{{ r.kind }}/{{ r.name }}</code><span>{{ r.namespace }}</span></div>
              <p class="muted" *ngIf="p.resources.length > 40">외 {{ p.resources.length - 40 }}개</p>
            </div>
          </ng-template>
          <clr-alert *ngIf="action() === 'uninstall' && p.retainedOnDelete.length"
                     [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">삭제 후 보존: {{ p.retainedOnDelete.join(', ') }}</span></clr-alert-item>
          </clr-alert>
          <clr-alert *ngIf="action() === 'install' && p.migration?.required"
                     [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">
              기존 비-Helm runtime {{ p.migration?.existingResources?.length || 0 }}개를 교체해야 합니다.
              보존: {{ p.migration?.preserved?.join(', ') || '없음' }}
            </span></clr-alert-item>
          </clr-alert>
          <section *ngIf="action() === 'rollback'" class="history-card">
            <h4>Helm revision history</h4>
            <label>롤백 대상 revision
              <select clrSelect name="rollbackRevision" [(ngModel)]="rollbackRevision">
                <option value="">선택하십시오</option>
                <option *ngFor="let entry of rollbackTargets(p, item)" [value]="entry.revision">revision {{ entry.revision }} · {{ entry.status }} · {{ entry.chart }}</option>
              </select>
            </label>
            <clr-datagrid>
              <clr-dg-column>Revision</clr-dg-column><clr-dg-column>Status</clr-dg-column>
              <clr-dg-column>Chart</clr-dg-column><clr-dg-column>Updated</clr-dg-column><clr-dg-column>Description</clr-dg-column>
              <clr-dg-row *ngFor="let entry of p.history">
                <clr-dg-cell>{{ entry.revision }}</clr-dg-cell><clr-dg-cell>{{ entry.status }}</clr-dg-cell>
                <clr-dg-cell>{{ entry.chart }}</clr-dg-cell><clr-dg-cell>{{ entry.updated }}</clr-dg-cell><clr-dg-cell>{{ entry.description }}</clr-dg-cell>
              </clr-dg-row>
              <clr-dg-placeholder>롤백할 revision이 없습니다.</clr-dg-placeholder>
            </clr-datagrid>
          </section>
        </div>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="reason" [(ngModel)]="reason" required minlength="8" maxlength="500" placeholder="승인 근거와 작업 목적(8자 이상)"></textarea>
          </clr-textarea-container>
          <clr-input-container *ngIf="action() === 'uninstall' || action() === 'rollback' || (action() === 'install' && !!plan()?.migration?.required)">
            <label>{{ action() === 'rollback' ? '롤백 확인' : action() === 'uninstall' ? '삭제 확인' : '교체 설치 확인' }}</label>
            <input clrInput name="confirm" [(ngModel)]="confirm" [placeholder]="confirmationText(item)" autocomplete="off">
            <clr-control-helper>{{ confirmationText(item) }} 를 정확히 입력하십시오.</clr-control-helper>
          </clr-input-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="modalOpen = false">취소</button>
        <button *ngIf="executeRequested()" class="btn" [class.btn-primary]="action() !== 'uninstall'" [class.btn-danger]="action() === 'uninstall'" type="button" [disabled]="!readyToExecute()" (click)="execute()">
          {{ executeButtonLabel() }}
        </button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="configurationModalOpen" [clrModalClosable]="!configurationBusy()" [clrModalSize]="'xl'">
      <h3 class="modal-title">Shared Observability {{ configurationMode === 'install' ? '설치 옵션' : '운영 구성' }}</h3>
      <div class="modal-body configuration-modal">
        <clr-spinner *ngIf="configurationLoading()" clrInline aria-label="운영 구성을 불러오는 중"></clr-spinner>
        <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
        </clr-alert>
        <ng-container *ngIf="observabilityState() as state">
          <div class="policy-banner">
            <div><strong>저장소·보존·원격 보관</strong><span>설치 후 관리 가능한 선언형 운영 구성입니다.</span></div>
            <div><strong>외부 공개 원칙</strong><span>Grafana만 TLS+OIDC Ingress를 허용하며 Prometheus/Alertmanager 직접 공개는 금지합니다.</span></div>
            <span class="label label-info">{{ state.source }}</span>
          </div>

          <clr-alert *ngIf="state.live.directExternalServices.length"
                     [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">정책 외 직접 공개 Service: {{ state.live.directExternalServices.join(', ') }}. 적용 시 ClusterIP로 복구합니다.</span></clr-alert-item>
          </clr-alert>

          <ng-container *ngIf="observabilityConfig() as config">
            <section class="config-section">
              <div class="section-heading"><div><p class="eyebrow">DATA PLANE</p><h4>영구 저장소와 보존기간</h4></div><span>StorageClass 변경·축소는 명시적 데이터 재배치가 필요합니다.</span></div>
              <clr-toggle-container>
                <clr-toggle-wrapper><input type="checkbox" clrToggle name="telemetryEnabled" [(ngModel)]="config.telemetry.enabled"><label>HIS 중앙 로그·트레이스·OTLP 수집 사용</label></clr-toggle-wrapper>
              </clr-toggle-container>
              <clr-datagrid class="config-table">
                <clr-dg-column>서비스</clr-dg-column><clr-dg-column>StorageClass</clr-dg-column><clr-dg-column>용량</clr-dg-column><clr-dg-column>보존기간</clr-dg-column><clr-dg-column>현재 PVC</clr-dg-column>

                  <clr-dg-row>
                    <clr-dg-cell><strong>Prometheus</strong><div class="muted">메트릭 TSDB</div></clr-dg-cell>
                    <clr-dg-cell><select clrSelect name="prometheusStorageClass" [(ngModel)]="config.prometheus.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.prometheus.storageClassName) }}</div></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="prometheusStorageSize" [(ngModel)]="config.prometheus.storageSize" placeholder="20Gi"></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="prometheusRetention" [(ngModel)]="config.prometheus.retention" placeholder="7d"></clr-dg-cell>
                    <clr-dg-cell>{{ livePvc(state, 'prometheus') }}</clr-dg-cell>
                  </clr-dg-row>
                  <clr-dg-row>
                    <clr-dg-cell><strong>Alertmanager</strong><div class="muted">알림 상태·silence</div></clr-dg-cell>
                    <clr-dg-cell><select clrSelect name="alertmanagerStorageClass" [(ngModel)]="config.alertmanager.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.alertmanager.storageClassName) }}</div></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="alertmanagerStorageSize" [(ngModel)]="config.alertmanager.storageSize" placeholder="2Gi"></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="alertmanagerRetention" [(ngModel)]="config.alertmanager.retention" placeholder="120h"></clr-dg-cell>
                    <clr-dg-cell>{{ livePvc(state, 'alertmanager') }}</clr-dg-cell>
                  </clr-dg-row>
                  <clr-dg-row>
                    <clr-dg-cell><strong>Grafana</strong><div class="muted">대시보드·설정 DB</div></clr-dg-cell>
                    <clr-dg-cell><select clrSelect name="grafanaStorageClass" [(ngModel)]="config.grafana.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.grafana.storageClassName) }}</div></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="grafanaStorageSize" [(ngModel)]="config.grafana.storageSize" placeholder="5Gi"></clr-dg-cell>
                    <clr-dg-cell><span class="muted">해당 없음</span></clr-dg-cell>
                    <clr-dg-cell>{{ livePvc(state, 'grafana') }}</clr-dg-cell>
                  </clr-dg-row>
                  <clr-dg-row *ngIf="config.telemetry.enabled">
                    <clr-dg-cell><strong>Loki</strong><div class="muted">중앙 로그 저장·조회</div></clr-dg-cell>
                    <clr-dg-cell><select clrSelect name="telemetryStorageClass" [(ngModel)]="config.telemetry.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }} · {{ sc.isCsi ? 'CSI' : sc.provisioner }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.telemetry.storageClassName) }}</div></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="lokiStorageSize" [(ngModel)]="config.telemetry.lokiStorageSize" placeholder="10Gi"></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="telemetryRetention" [(ngModel)]="config.telemetry.retention" placeholder="168h"></clr-dg-cell>
                    <clr-dg-cell>{{ livePvc(state, 'loki') }}</clr-dg-cell>
                  </clr-dg-row>
                  <clr-dg-row *ngIf="config.telemetry.enabled">
                    <clr-dg-cell><strong>Tempo</strong><div class="muted">분산 트레이스 저장·조회</div></clr-dg-cell>
                    <clr-dg-cell><span>{{ config.telemetry.storageClassName || 'Cluster default' }}</span></clr-dg-cell>
                    <clr-dg-cell><input clrInput name="tempoStorageSize" [(ngModel)]="config.telemetry.tempoStorageSize" placeholder="10Gi"></clr-dg-cell>
                    <clr-dg-cell>{{ config.telemetry.retention }}</clr-dg-cell>
                    <clr-dg-cell>{{ livePvc(state, 'tempo') }}</clr-dg-cell>
                  </clr-dg-row>

              </clr-datagrid>
            </section>

            <section class="config-section split-config">
              <div>
                <div class="section-heading"><div><p class="eyebrow">DURABILITY</p><h4>Prometheus Remote Write</h4></div></div>
                <clr-toggle-container>
                  <clr-toggle-wrapper><input type="checkbox" clrToggle name="remoteWriteEnabled" [(ngModel)]="config.prometheus.remoteWrite.enabled"><label>외부 장기 저장소로 전송</label></clr-toggle-wrapper>
                </clr-toggle-container>
                <div class="compact-fields" *ngIf="config.prometheus.remoteWrite.enabled">
                  <label>HTTPS endpoint<input clrInput name="remoteWriteUrl" [(ngModel)]="config.prometheus.remoteWrite.url" placeholder="https://metrics.example.com/api/v1/write"></label>
                  <label>Credential Secret<input clrInput name="remoteWriteSecret" [(ngModel)]="config.prometheus.remoteWrite.secretName" placeholder="prometheus-remote-write"></label>
                  <label>Secret key<input clrInput name="remoteWriteKey" [(ngModel)]="config.prometheus.remoteWrite.secretKey" placeholder="token"></label>
                </div>
                <p class="muted">자격 증명 값은 화면이나 ConfigMap에 저장하지 않고 monitoring namespace의 기존 Secret 참조만 저장합니다.</p>
              </div>
              <div>
                <div class="section-heading"><div><p class="eyebrow">CURRENT SECURITY</p><h4>실행 정책 상태</h4></div></div>
                <dl class="runtime-policy">
                  <dt>Grafana Service</dt><dd>{{ state.live.grafana.serviceType }}</dd>
                  <dt>Managed NetworkPolicy</dt><dd>{{ state.live.networkPolicies.length }}/{{ config.telemetry.enabled ? 6 : 3 }}</dd>
                  <dt>Loki / Tempo / OTLP</dt><dd>{{ state.live.telemetry.loki ? 'Ready' : 'Not ready' }} / {{ state.live.telemetry.tempo ? 'Ready' : 'Not ready' }} / {{ state.live.telemetry.otlp ? 'Ready' : 'Not ready' }}</dd>
                  <dt>Grafana Ingress</dt><dd>{{ state.live.grafana.ingress?.hostname || '없음' }}</dd>
                  <dt>Prometheus 직접 공개</dt><dd>금지</dd>
                  <dt>Alertmanager 직접 공개</dt><dd>금지</dd>
                </dl>
              </div>
            </section>

            <section class="config-section">
              <div class="section-heading"><div><p class="eyebrow">ACCESS POLICY</p><h4>Grafana 접근 정책</h4></div><span>Service는 모든 모드에서 ClusterIP로 유지합니다.</span></div>
              <div class="exposure-options">
                <label [class.selected]="config.grafana.exposureMode === 'ClusterInternal'"><input clrRadio type="radio" name="grafanaExposure" value="ClusterInternal" [(ngModel)]="config.grafana.exposureMode"><strong>Cluster Internal</strong><span>기본값. monitoring과 Console namespace에서만 접근</span></label>
                <label [class.selected]="config.grafana.exposureMode === 'PrivateIngress'"><input clrRadio type="radio" name="grafanaExposure" value="PrivateIngress" [(ngModel)]="config.grafana.exposureMode"><strong>Private Ingress</strong><span>TLS+OIDC+IP allowlist를 모두 검증한 내부망 공개</span></label>
                <label class="danger-option" [class.selected]="config.grafana.exposureMode === 'PublicIngress'"><input clrRadio type="radio" name="grafanaExposure" value="PublicIngress" [(ngModel)]="config.grafana.exposureMode"><strong>Public Ingress</strong><span>TLS+OIDC+rate limit+명시적 승인이 필요한 인터넷 공개</span></label>
              </div>
              <div class="ingress-fields" *ngIf="config.grafana.exposureMode !== 'ClusterInternal'">
                <label>Hostname<input clrInput name="grafanaHostname" [(ngModel)]="config.grafana.hostname" placeholder="grafana.example.com"></label>
                <label>IngressClass<select clrSelect name="grafanaIngressClass" [(ngModel)]="config.grafana.ingressClassName"><option *ngFor="let ingress of state.ingressClasses" [value]="ingress.name">{{ ingress.name }}</option></select></label>
                <label>Controller namespace<input clrInput name="grafanaIngressNamespace" [(ngModel)]="config.grafana.ingressNamespace" placeholder="ingress-nginx"></label>
                <label>TLS Secret<input clrInput name="grafanaTlsSecret" [(ngModel)]="config.grafana.tlsSecretName" placeholder="grafana-tls"></label>
                <label>OIDC env Secret<input clrInput name="grafanaOidcSecret" [(ngModel)]="config.grafana.oidcSecretName" placeholder="grafana-oidc"></label>
                <label *ngIf="config.grafana.exposureMode === 'PrivateIngress'">허용 CIDR<textarea clrTextarea name="grafanaCidrs" [(ngModel)]="allowedCidrsText" placeholder="10.0.0.0/8&#10;192.168.0.0/16"></textarea></label>
              </div>
              <details *ngIf="config.grafana.exposureMode !== 'ClusterInternal'" class="secret-contract"><summary>Grafana OIDC Secret 계약</summary><code *ngFor="let key of state.policy.requiredOidcSecretKeys">{{ key }}</code></details>
            </section>

            <section class="config-section plan-section">
              <div class="section-heading"><div><p class="eyebrow">PLAN &amp; APPROVAL</p><h4>{{ configurationMode === 'install' ? '설치 옵션 검증' : '변경 계획과 승인' }}</h4></div><button class="btn btn-sm btn-outline" type="button" [disabled]="configurationPlanning() || configurationBusy()" (click)="validateConfiguration()">계획 검사</button></div>
              <clr-spinner *ngIf="configurationPlanning()" clrInline aria-label="구성 계획을 검사하는 중"></clr-spinner>
              <ng-container *ngIf="observabilityPlan() as configPlan">
                <clr-alert *ngIf="configPlan.blockers.length" [clrAlertType]="'danger'" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text"><strong>적용 차단</strong><span *ngFor="let blocker of configPlan.blockers"> · {{ blocker }}</span></span></clr-alert-item>
                </clr-alert>
                <clr-alert *ngIf="configPlan.warnings.length" [clrAlertType]="'warning'" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text"><strong>주의</strong><span *ngFor="let warning of configPlan.warnings"> · {{ warning }}</span></span></clr-alert-item>
                </clr-alert>
                <clr-datagrid class="change-table" *ngIf="configPlan.changes.length">
                  <clr-dg-column>영역</clr-dg-column><clr-dg-column>항목</clr-dg-column>
                  <clr-dg-column>현재</clr-dg-column><clr-dg-column>변경</clr-dg-column>
                  <clr-dg-row *ngFor="let change of configPlan.changes">
                    <clr-dg-cell><span class="label">{{ change.impact }}</span></clr-dg-cell>
                    <clr-dg-cell><code>{{ change.field }}</code></clr-dg-cell>
                    <clr-dg-cell>{{ change.from }}</clr-dg-cell><clr-dg-cell>{{ change.to }}</clr-dg-cell>
                  </clr-dg-row>
                </clr-datagrid>
                <p class="muted" *ngIf="!configPlan.changes.length">선언된 구성 변경이 없습니다. 정책 리소스는 현재 값으로 재조정할 수 있습니다.</p>
                <div class="destructive-confirm" *ngIf="configPlan.requiresDataReset">
                  <strong>데이터 초기화 재배치 필요</strong>
                  <ul><li *ngFor="let target of configPlan.resetTargets">{{ target }}</li></ul>
                  <clr-checkbox-container>
                    <clr-checkbox-wrapper>
                      <input type="checkbox" clrCheckbox name="resetData" [(ngModel)]="resetData">
                      <label>영향받는 Prometheus·Alertmanager·Grafana·Loki·Tempo 데이터를 삭제하고 새 PVC를 생성합니다.</label>
                    </clr-checkbox-wrapper>
                  </clr-checkbox-container>
                  <clr-input-container class="reset-confirmation-field">
                    <label>삭제 확인 문구</label>
                    <code class="reset-confirmation-token">{{ state.policy.resetConfirmation }}</code>
                    <input
                      clrInput
                      name="resetConfirmation"
                      aria-label="삭제 확인 문구 입력"
                      [(ngModel)]="resetConfirmation"
                      placeholder="위 확인 문구를 정확히 입력하십시오"
                      autocomplete="off">
                    <clr-control-helper [class.ready]="resetConfirmation === state.policy.resetConfirmation">
                      {{ resetConfirmation === state.policy.resetConfirmation ? '확인 문구가 일치합니다.' : '전체 확인 문구를 정확히 입력해야 운영 구성을 적용할 수 있습니다.' }}
                    </clr-control-helper>
                  </clr-input-container>
                </div>
              </ng-container>
              <form clrForm clrLayout="vertical" *ngIf="configurationMode === 'operate'">
                <clr-textarea-container><label>변경 사유</label><textarea clrTextarea name="configurationReason" [(ngModel)]="configurationReason" required minlength="8" maxlength="500" placeholder="저장소·보존·공개 정책 변경 근거(8자 이상)"></textarea></clr-textarea-container>
                <clr-input-container *ngIf="config.grafana.exposureMode === 'PublicIngress'"><label>Public 공개 확인</label><input clrInput name="publicConfirmation" [(ngModel)]="publicConfirmation" [placeholder]="state.policy.publicConfirmation" autocomplete="off"><clr-control-helper>{{ state.policy.publicConfirmation }} 를 정확히 입력하십시오.</clr-control-helper></clr-input-container>
              </form>
            </section>
          </ng-container>
        </ng-container>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="configurationBusy()" (click)="closeObservabilityConfiguration()">취소</button>
        <button class="btn btn-primary" type="button" [disabled]="!configurationReadyToApply()" (click)="applyObservabilityConfiguration()">{{ configurationApplyLabel() }}</button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="profileModalOpen" [clrModalSize]="'md'" [clrModalClosable]="!profileBusy()">
      <h3 class="modal-title">HIS profile 요구조건 변경</h3>
      <div class="modal-body" *ngIf="profileTarget() as item">
        <clr-alert [clrAlertType]="item.profileSelected ? 'info' : 'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">
            <strong>{{ item.profile }}</strong> profile을 {{ item.profileSelected ? '선택 해제' : '필수 요구조건으로 선택' }}합니다.
            선택하면 profile capability가 준비되지 않은 동안 HIS 전체 상태가 Ready가 될 수 없습니다.
          </span></clr-alert-item>
        </clr-alert>
        <p *ngIf="item.mode === 'DetectOnly'" class="muted">이 capability는 Cluster Manager가 임의 설치하지 않습니다. 선택 후 호스트 공급자 절차로 준비하고 다시 검사하십시오.</p>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="profileReason" [(ngModel)]="profileReason" required minlength="8" maxlength="500" placeholder="profile 적용 목적과 승인 근거(8자 이상)"></textarea>
          </clr-textarea-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="profileBusy()" (click)="profileModalOpen = false">취소</button>
        <button class="btn btn-primary" type="button" [disabled]="profileBusy() || profileReason.trim().length < 8" (click)="applyProfileSelection()">
          {{ profileTarget()?.profileSelected ? '요구조건 해제' : '요구조건으로 선택' }}
        </button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="canaryModalOpen" [clrModalSize]="'md'" [clrModalClosable]="!canaryBusy()">
      <h3 class="modal-title">HIS 실제 기능 경로 검증</h3>
      <div class="modal-body" *ngIf="canaryTarget() as item">
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">
            <strong>{{ item.displayName }}</strong> 검증을 위해 범위가 고정된 synthetic 리소스를 생성하고 완료 후 자동 삭제합니다.
            Network는 cross-node·egress·NetworkPolicy, DNS는 모든 Ready 노드, Observability는 metric scrape·alert와 OTLP log·trace 저장/조회를 검사합니다.
            Storage/Data Protection은 고정 64Mi PVC 및 deletionPolicy=Delete인 VolumeSnapshot만 사용합니다.
          </span></clr-alert-item>
        </clr-alert>
        <p class="muted">현재 Cluster Manager digest와 서버가 고정한 manifest만 사용합니다. 임의 image·명령·manifest 입력은 받지 않습니다.</p>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>검증 사유</label>
            <textarea clrTextarea name="canaryReason" [(ngModel)]="canaryReason" required minlength="8" maxlength="500" placeholder="실검증 목적과 승인 근거(8자 이상)"></textarea>
          </clr-textarea-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="canaryBusy()" (click)="canaryModalOpen = false">취소</button>
        <button class="btn btn-primary" type="button" [disabled]="canaryBusy() || canaryReason.trim().length < 8" (click)="runCanaryValidation()">검증 실행</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host { display: block; }
    .his-head { align-items: flex-start; }
    .his-head h1 { font-size: 1.45rem; line-height: 1.25; }
    .title-expansion { color: var(--os-text-sec); font-size: 0.82rem; font-weight: 400; }
    .his-head p { max-width: 62rem; line-height: 1.5; }
    .eyebrow { color: var(--os-brand-500); font-size: 0.65rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .summary { display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0; color: var(--os-text-sec); font-size: 0.72rem; }
    .profile-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 0.55rem; margin: 0 0 0.7rem; }
    .profile-summary article { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; padding: 0.55rem 0.65rem; border: 1px solid var(--os-border); background: var(--os-bg-subtle); }
    .profile-summary article.profile-selected { border-left: 0.2rem solid var(--os-brand-500); background: var(--os-active-bg); }
    .profile-summary article > div { display: grid; gap: 0.15rem; }
    .profile-summary article span:not(.label) { color: var(--os-text-dim); font-size: 0.62rem; }
    .muted { color: var(--os-text-dim); font-size: 0.65rem; margin-top: 0.12rem; }
    .required { margin-left: 0.35rem; color: var(--os-danger); font-size: 0.62rem; font-weight: 600; }
    .optional { margin-left: 0.35rem; color: var(--os-info); font-size: 0.62rem; font-weight: 600; }
    .action-cell { min-width: 7rem; }
    .action-buttons { display: flex; align-items: center; gap: 0.2rem; white-space: nowrap; }
    .action-buttons .btn { margin: 0; }
    .action-primary { min-width: 5.25rem; }
    .action-overflow { min-width: 1.5rem; padding-inline: 0.2rem; }
    .action-overflow cds-icon { margin: 0; }
    .action-danger { color: var(--os-danger); }
    .domain-badge { display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.3rem; border: 1px solid var(--os-info-border); border-radius: 0.5rem; color: var(--os-info); font-size: 0.55rem; vertical-align: middle; }
    .detail { padding: 0.6rem 1rem; line-height: 1.5; }
    .detail-summary { display: grid; gap: 0.2rem; margin-bottom: 0.7rem; }
    .operation-inline { color: var(--os-info); font-size: 0.62rem; font-weight: 600; margin-top: 0.2rem; }
    .operation-card { border: 1px solid var(--os-info-border); background: var(--os-info-bg); padding: 0.7rem; margin-bottom: 0.8rem; }
    .operation-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    .progress-block { width: 100%; margin: 0.55rem 0 0.25rem; }
    .operation-card p { margin: 0.2rem 0; }
    .operation-error { color: var(--os-danger); white-space: pre-wrap; }
    .operational-section h4 { margin: 0.75rem 0 0.25rem; }
    .component-table { table-layout: fixed; }
    .component-table th:nth-child(1) { width: 15%; }
    .component-table th:nth-child(2) { width: 25%; }
    .component-table th:nth-child(3), .component-table th:nth-child(4) { width: 10%; }
    .image-cell { overflow-wrap: anywhere; font-size: 0.62rem; }
    .resource-health { display: flex; gap: 1rem; padding: 0.4rem 0; font-weight: 600; }
    .compatibility-card { display: flex; justify-content: space-between; gap: 1rem; margin: 0.8rem 0; padding: 0.6rem 0.75rem; border: 1px solid var(--os-info-border); background: var(--os-info-bg); }
    .compatibility-card > div { display: grid; gap: 0.15rem; }
    .compatibility-card span { color: var(--os-brand-500); font-size: 0.56rem; font-weight: 700; letter-spacing: 0.07em; }
    .compatibility-card p { margin: 0; color: var(--os-text-sec); }
    .fact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.55rem; margin: 0.75rem 0; }
    .fact-grid article { display: grid; gap: 0.15rem; min-height: 4rem; padding: 0.55rem; border: 1px solid var(--os-border); background: var(--os-bg-subtle); }
    .fact-grid article > span { color: var(--os-text-sec); font-size: 0.58rem; }
    .fact-grid article > strong { overflow-wrap: anywhere; }
    .fact-grid article > small { color: var(--os-text-dim); }
    .fact-grid .fact-passed { border-left: 0.2rem solid var(--os-success); }
    .fact-grid .fact-failed { border-left: 0.2rem solid var(--os-danger); background: var(--os-danger-bg); }
    .compact-alert ul, .security-card ul, .remediation-card ol { margin: 0.3rem 0 0 1.15rem; }
    .security-card, .remediation-card { margin: 0.75rem 0; padding: 0.7rem; border: 1px solid var(--os-border); background: var(--os-bg); }
    .diagnostic-table { margin: 0.9rem 0; }
    .diagnostic-table h4 { margin-bottom: 0.3rem; }
    .table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--os-border); }
    .table-scroll table { min-width: 46rem; margin: 0; }
    .table-scroll td { overflow-wrap: anywhere; }
    .empty-cell { padding: 0.8rem !important; text-align: center; color: var(--os-text-dim); }
    .canary-section { margin: 0.9rem 0; }
    .canary-list { display: grid; gap: 0.4rem; }
    .canary-list article { display: grid; grid-template-columns: 4.8rem 1fr; gap: 0.55rem; align-items: start; padding: 0.5rem; border-bottom: 1px solid var(--os-border); }
    .canary-list p { margin: 0.1rem 0 0; color: var(--os-text-sec); }
    .remediation-card { border-left: 0.2rem solid var(--os-brand-500); }
    .remediation-card h4 { margin: 0.1rem 0 0.25rem; }
    .plan-meta { display: grid; grid-template-columns: 9rem 1fr; gap: 0.35rem 0.8rem; margin: 0.8rem 0; }
    .plan-meta dt { font-weight: 600; }
    .plan-meta dd { margin: 0; }
    .quick-confirmation { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--os-2) var(--os-6); margin: var(--os-5) 0; }
    .quick-confirmation > div { display: grid; grid-template-columns: 7rem 1fr; gap: var(--os-3); padding: var(--os-3) 0; border-bottom: 1px solid var(--os-hairline); }
    .quick-confirmation dt { color: var(--os-ink-muted); }
    .quick-confirmation dd { margin: 0; font-weight: 600; }
    .technical-plan { margin: var(--os-4) 0; border: 1px solid var(--os-hairline); }
    .technical-plan summary { padding: var(--os-4); cursor: pointer; font-weight: 600; }
    .technical-plan[open] { padding: 0 var(--os-4) var(--os-4); }
    .technical-plan[open] summary { margin: 0 calc(var(--os-4) * -1); border-bottom: 1px solid var(--os-hairline); }
    .resource-list { max-height: 16rem; overflow: auto; border: 1px solid var(--os-border); }
    .resource-list > div { display: grid; grid-template-columns: minmax(16rem, 1fr) minmax(8rem, 0.5fr); padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--os-border); }
    .profile-card { display: grid; grid-template-columns: 8rem 1fr; gap: 0.3rem 0.75rem; padding: 0.65rem; margin-bottom: 0.7rem; border: 1px solid var(--os-border); background: var(--os-bg-subtle); }
    .history-card { margin: 0.75rem 0; padding: 0.65rem; border: 1px solid var(--os-border); background: var(--os-bg-subtle); }
    .history-card label { display: grid; grid-template-columns: 10rem minmax(14rem, 1fr); gap: 0.5rem; align-items: center; font-weight: 600; }
    .observability-modal-title { display: flex; align-items: center; gap: var(--os-4); min-width: 0; }
    .observability-modal-title-copy { display: grid; min-width: 0; gap: var(--os-2); }
    .observability-modal-title-copy strong { font: inherit; }
    .observability-modal-title-copy small { color: var(--os-ink-muted); font: var(--os-type-caption); font-weight: 400; }
    .observability-logo-pair { display: inline-flex; flex: 0 0 auto; align-items: center; }
    .observability-logo-pair img {
      display: block;
      width: 2rem;
      height: 2rem;
      padding: var(--os-2);
      border: 1px solid var(--os-hairline);
      border-radius: 50%;
      background: var(--os-bg);
      object-fit: contain;
      box-shadow: var(--os-shadow-sm);
    }
    .observability-logo-pair img + img { margin-left: calc(var(--os-2) * -1); }
    .lifecycle-workspace {
      display: grid;
      min-width: 0;
      max-height: none;
      gap: var(--os-5);
      overflow: visible;
    }
    .observability-quick-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(15rem, 0.36fr);
      align-items: stretch;
      gap: var(--os-6);
      padding: var(--os-5);
      border: 1px solid var(--os-hairline);
      background: var(--os-surface-1);
    }
    .observability-quick-card.is-ready { border-left: var(--os-2) solid var(--os-success); }
    .quick-card-copy { min-width: 0; }
    .quick-card-copy > p:last-of-type { max-width: 48rem; margin: var(--os-2) 0 0; color: var(--os-ink-muted); line-height: 1.45; }
    .quick-card-title { display: flex; align-items: center; gap: var(--os-4); min-width: 0; }
    .quick-card-title h4 { margin: 0; font-size: 1rem; }
    .quick-install-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--os-4) var(--os-6); margin-top: var(--os-5); min-width: 0; }
    .quick-install-options clr-select-container { display: block; min-width: 0; margin-top: 0; }
    .quick-install-options select[clrSelect] { width: 100%; min-width: 0; max-width: 100%; }
    .quick-install-options clr-control-helper {
      display: block;
      max-width: 100%;
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .quick-static-field { display: grid; align-content: start; gap: var(--os-2); padding-top: var(--os-3); }
    .quick-static-field > span { font-weight: 600; }
    .quick-static-field small { max-width: 100%; color: var(--os-ink-muted); font: var(--os-type-caption); line-height: 1.35; overflow-wrap: anywhere; }
    .quick-facts { display: flex; flex-wrap: wrap; gap: var(--os-3) var(--os-6); margin: var(--os-5) 0 0; }
    .quick-facts > div { display: grid; grid-template-columns: auto auto; gap: var(--os-2); align-items: baseline; }
    .quick-facts dt { color: var(--os-ink-muted); font: var(--os-type-caption); }
    .quick-facts dd { margin: 0; font-weight: 600; }
    .quick-card-readiness {
      display: flex;
      min-width: 0;
      gap: var(--os-4);
      align-items: flex-start;
      padding: var(--os-4);
      border-left: 1px solid var(--os-hairline);
      background: var(--os-bg);
    }
    .quick-card-readiness > div { min-width: 0; overflow-wrap: anywhere; }
    .quick-card-readiness cds-icon, .quick-card-readiness .spinner { flex: 0 0 auto; }
    .quick-card-readiness p { margin: var(--os-2) 0 0; color: var(--os-ink-muted); line-height: 1.4; }
    .quick-card-readiness ul { margin: var(--os-2) 0 0; padding-left: var(--os-5); }
    .quick-card-readiness li + li { margin-top: var(--os-2); }
    .observability-modal-footer {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      gap: var(--os-4);
    }
    .observability-footer-view,
    .observability-footer-actions {
      display: flex;
      align-items: center;
      gap: var(--os-3);
    }
    .observability-footer-actions { justify-content: flex-end; }
    .observability-modal-footer .btn { margin: 0; }
    .observability-advanced { min-width: 0; padding: var(--os-5); border: 1px solid var(--os-hairline); background: var(--os-bg); }
    .observability-advanced > clr-input-container { display: block; width: min(100%, 20rem); margin: 0 0 var(--os-4); }
    .observability-advanced input[clrInput] { width: 100%; }
    .observability-advanced > clr-alert { margin: var(--os-4) 0 0; }
    .lifecycle-section { min-width: 0; padding: var(--os-5) 0 0; border-top: 1px solid var(--os-hairline); }
    .lifecycle-section > clr-alert { margin: 0; }
    .storage-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--os-4) var(--os-6); margin-top: var(--os-4); }
    .storage-form-grid clr-select-container { display: block; margin-top: 0; }
    .storage-form-grid select[clrSelect] { width: 100%; }
    .observability-advanced .alert-text ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--os-2) var(--os-5); }
    .storage-plan { margin-top: 0.65rem; }
    .operation-facts { display: grid; grid-template-columns: repeat(4, minmax(9rem, 1fr)); gap: 0.55rem; margin-bottom: 0.65rem; }
    .operation-facts article { display: grid; gap: var(--os-2); padding: var(--os-4); border-left: var(--os-2) solid var(--os-info); background: var(--os-surface-1); }
    .operation-facts span { color: var(--os-ink-muted); font: var(--os-type-caption); }
    .configuration-modal { display: grid; gap: 0.9rem; max-height: none; overflow: visible; padding-right: 0.3rem; }
    .policy-banner { display: grid; grid-template-columns: minmax(16rem, 1fr) minmax(16rem, 1fr) auto; gap: 0.8rem; align-items: center; padding: 0.7rem; border: 1px solid var(--os-info-border); background: var(--os-info-bg); }
    .policy-banner > div { display: grid; gap: 0.15rem; }
    .policy-banner span:not(.label) { color: var(--os-text-sec); font-size: 0.65rem; }
    .config-section { border: 1px solid var(--os-border); background: var(--os-bg); padding: 0.75rem; }
    .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--os-5); margin-bottom: var(--os-4); }
    .section-heading h4 { margin: 0.05rem 0 0; font-size: 0.9rem; }
    .section-heading > span { color: var(--os-ink-muted); font: var(--os-type-caption); }
    .config-table { table-layout: fixed; margin: 0; }
    .config-table th:nth-child(1), .config-table th:nth-child(5) { width: 18%; }
    .config-table th:nth-child(2) { width: 28%; }
    .config-table th:nth-child(3), .config-table th:nth-child(4) { width: 18%; }
    .config-table input, .config-table select { width: 100%; min-width: 6rem; }
    .storage-hint { max-width: 18rem; margin-top: 0.2rem; color: var(--os-text-dim); font-size: 0.58rem; line-height: 1.35; }
    .split-config { display: grid; grid-template-columns: minmax(20rem, 1.25fr) minmax(16rem, 0.75fr); gap: 1rem; }
    .compact-fields, .ingress-fields { display: grid; grid-template-columns: repeat(3, minmax(10rem, 1fr)); gap: 0.65rem; margin: 0.5rem 0; }
    .compact-fields label, .ingress-fields label { display: grid; gap: 0.2rem; font-size: 0.65rem; font-weight: 600; }
    .compact-fields input, .ingress-fields input, .ingress-fields select, .ingress-fields textarea { width: 100%; }
    .runtime-policy { display: grid; grid-template-columns: 12rem 1fr; gap: 0.3rem 0.7rem; margin: 0; }
    .runtime-policy dt { color: var(--os-text-sec); }
    .runtime-policy dd { margin: 0; font-weight: 600; }
    .exposure-options { display: grid; grid-template-columns: repeat(3, minmax(13rem, 1fr)); gap: 0.65rem; }
    .exposure-options > label { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.4rem; align-items: start; padding: 0.65rem; border: 1px solid var(--os-border); cursor: pointer; }
    .exposure-options > label.selected { border-color: var(--os-brand-500); box-shadow: inset 0 0 0 1px var(--os-brand-500); background: var(--os-active-bg); }
    .exposure-options > label.danger-option.selected { border-color: var(--os-danger); box-shadow: inset 0 0 0 1px var(--os-danger); background: var(--os-danger-bg); }
    .exposure-options input { grid-row: 1 / span 2; }
    .exposure-options span { color: var(--os-text-dim); font-size: 0.62rem; line-height: 1.4; }
    .secret-contract { margin-top: 0.55rem; padding: 0.45rem; background: var(--os-surface); }
    .secret-contract code { display: block; margin: 0.2rem 0 0 1rem; }
    .plan-section { background: var(--os-bg-subtle); }
    .change-table { table-layout: fixed; }
    .change-table th:nth-child(1) { width: 10%; }
    .change-table th:nth-child(2) { width: 30%; }
    .destructive-confirm { display: grid; gap: 0.4rem; margin: 0.6rem 0; padding: 0.65rem; border: 1px solid var(--os-danger); background: var(--os-danger-bg); }
    .destructive-confirm ul { margin: 0 0 0 1.1rem; }
    .reset-confirmation-field { display: grid; gap: 0.3rem; width: min(100%, 36rem); }
    .reset-confirmation-token { display: block; width: fit-content; max-width: 100%; padding: 0.25rem 0.4rem; border: 1px solid var(--os-border); background: var(--os-bg); color: var(--os-text); font-size: 0.7rem; overflow-wrap: anywhere; }
    .reset-confirmation-field input { width: 100%; max-width: none; }
    .reset-confirmation-field .clr-control-helper { color: var(--os-danger); }
    .reset-confirmation-field .clr-control-helper.ready { color: var(--os-success); }
    @media (max-width: 1100px) {
      .split-config, .exposure-options, .policy-banner, .storage-form-grid, .operation-facts { grid-template-columns: 1fr 1fr; }
      .compact-fields, .ingress-fields { grid-template-columns: 1fr 1fr; }
      .compatibility-card { display: grid; }
      .observability-quick-card { grid-template-columns: 1fr; }
      .quick-install-options { grid-template-columns: 1fr 1fr; }
      .quick-card-readiness { border-top: 1px solid var(--os-hairline); border-left: 0; }
    }
    @media (max-width: 720px) {
      .storage-form-grid, .operation-facts, .observability-advanced .alert-text ul, .quick-confirmation { grid-template-columns: 1fr; }
      .observability-modal-title-copy small { display: none; }
      .quick-card-title { display: grid; }
      .quick-facts, .quick-install-options { display: grid; grid-template-columns: 1fr; }
      .lifecycle-workspace {
        max-height: calc(100vh - 9rem);
        padding-right: var(--os-2);
        overflow-y: auto;
      }
      .observability-modal-footer { align-items: stretch; flex-direction: column; }
      .observability-footer-view { justify-content: flex-start; }
      .observability-footer-actions { flex-wrap: wrap; justify-content: flex-end; }
    }
    textarea { min-height: 5rem; }
  `],
})
export class HisComponent implements OnInit, OnDestroy {
  private his = inject(HisService);
  readonly prometheusLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/prometheus-2.svg';
  readonly grafanaLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/grafana-2.svg';
  readonly status = signal<HisStatus | null>(null);
  readonly selected = signal<HisItem | null>(null);
  readonly plan = signal<HisPlan | null>(null);
  readonly action = signal<HisMutationAction>('install');
  readonly executeRequested = signal(false);
  readonly loading = signal(false);
  readonly planLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly expandedItems = signal<ReadonlySet<string>>(new Set<string>());
  readonly observabilityState = signal<ObservabilityConfigurationState | null>(null);
  readonly observabilityConfig = signal<ObservabilityConfig | null>(null);
  readonly observabilityPlan = signal<ObservabilityConfigurationPlan | null>(null);
  readonly observabilityTarget = signal<HisItem | null>(null);
  readonly configurationLoading = signal(false);
  readonly configurationPlanning = signal(false);
  readonly configurationBusy = signal(false);
  readonly profileTarget = signal<HisItem | null>(null);
  readonly profileBusy = signal(false);
  readonly canaryTarget = signal<HisItem | null>(null);
  readonly canaryBusy = signal(false);
  modalOpen = false;
  observabilityLifecycleModalOpen = false;
  observabilityAdvancedOpen = false;
  configurationModalOpen = false;
  profileModalOpen = false;
  canaryModalOpen = false;
  reason = '';
  confirm = '';
  rollbackRevision = '';
  allowedCidrsText = '';
  configurationReason = '';
  resetData = false;
  resetConfirmation = '';
  publicConfirmation = '';
  profileReason = '';
  canaryReason = '';
  configurationMode: ObservabilityConfigurationMode = 'operate';
  observabilityChartVersion = '87.19.1';
  private configurationFingerprint = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private focusItemId = '';
  private focusApplied = false;

  ngOnInit(): void {
    try {
      const requested = new URLSearchParams(window.location.search).get('focus') || '';
      this.focusItemId = /^[a-z0-9-]{1,80}$/.test(requested) ? requested : '';
    } catch { /* standalone/test environment */ }
    this.load();
    this.pollTimer = setInterval(() => this.load(false), 3000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  load(showLoading = true): void {
    if (showLoading) {
      this.loading.set(true);
      this.error.set('');
    }
    this.his.status().subscribe({
      next: (status) => {
        const prior = new Map((this.status()?.items || []).map((item) => [item.id, item]));
        const items = status.items.map((item) => Object.assign(prior.get(item.id) || {}, item));
        this.status.set({ ...status, items });
        this.applyRequestedFocus(items);
        this.loading.set(false);
      },
      error: (error) => { if (showLoading) this.error.set(this.message(error)); this.loading.set(false); },
    });
  }

  private applyRequestedFocus(items: HisItem[]): void {
    if (this.focusApplied || !this.focusItemId || !items.some((item) => item.id === this.focusItemId)) return;
    this.focusApplied = true;
    this.setExpanded(this.focusItemId, true);
    setTimeout(() => {
      document.querySelector(`[data-his-item="${this.focusItemId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  requiredTotal(status: HisStatus): number { return status.items.filter((item) => item.required).length; }
  requiredReady(status: HisStatus): number { return status.items.filter((item) => item.required && item.check.state === 'Ready').length; }
  optionalTotal(status: HisStatus): number { return status.items.filter((item) => !item.required).length; }
  optionalReady(status: HisStatus): number { return status.items.filter((item) => !item.required && item.check.state === 'Ready').length; }
  primaryActionLabel(item: HisItem): string {
    if (item.mode === 'DetectOnly') return this.canValidate(item) ? '기능 검증' : '상세 진단';
    if (item.id === 'kube-prometheus-stack') return '관측 서비스 관리';
    const lifecycle = this.releaseLifecycle(item);
    return lifecycle === 'install' ? '설치'
      : lifecycle === 'upgrade' ? '업그레이드'
        : lifecycle === 'recover' ? '복구' : '상태 확인';
  }

  primaryActionClass(item: HisItem): string {
    if (item.mode === 'DetectOnly' || this.releaseLifecycle(item) === 'blocked') return 'btn-outline';
    if (this.releaseLifecycle(item) === 'recover') return 'btn-warning-outline';
    return 'btn-primary';
  }

  primaryActionDisabled(item: HisItem): boolean {
    if (this.busy() || this.operationActive(item.operation)) return true;
    if (item.mode === 'DetectOnly' || item.id === 'kube-prometheus-stack') return false;
    return this.releaseLifecycle(item) === 'install' && !this.canInstall(item);
  }

  runPrimaryAction(item: HisItem): void {
    if (item.mode === 'DetectOnly') {
      if (this.canValidate(item)) this.openCanaryValidation(item);
      else this.setExpanded(item.id, true);
      return;
    }
    if (item.id === 'kube-prometheus-stack') {
      this.openSharedObservability(item);
      return;
    }
    const lifecycle = this.releaseLifecycle(item);
    if (lifecycle === 'blocked') {
      this.setExpanded(item.id, true);
      return;
    }
    this.openPlan(item, lifecycle, true);
  }

  openProfileSelection(item: HisItem): void {
    this.profileTarget.set(item);
    this.profileReason = '';
    this.error.set('');
    this.profileModalOpen = true;
  }

  applyProfileSelection(): void {
    const item = this.profileTarget();
    if (!item?.profile || this.profileBusy() || this.profileReason.trim().length < 8) return;
    this.profileBusy.set(true);
    this.error.set('');
    this.his.setProfile(item.profile, !item.profileSelected, this.profileReason.trim()).subscribe({
      next: (status) => {
        this.status.set(status);
        this.profileBusy.set(false);
        this.profileModalOpen = false;
        this.notice.set(`${item.profile} profile이 ${item.profileSelected ? '선택 해제' : '필수 요구조건으로 선택'}되었습니다.`);
      },
      error: (error) => { this.error.set(this.message(error)); this.profileBusy.set(false); },
    });
  }
  canValidate(item: HisItem): boolean {
    const reasons: Record<string, string[]> = {
      'cluster-network': ['CniReady', 'NetworkCanaryRequired', 'NetworkCanaryExpired', 'NetworkCanaryFailed'],
      'cluster-dns': ['DnsResolutionReady', 'DnsCanaryRequired', 'DnsCanaryExpired', 'DnsCanaryFailed'],
      'kube-prometheus-stack': ['ObservabilityReady', 'ObservabilityCanaryRequired', 'ObservabilityCanaryExpired', 'ObservabilityCanaryFailed'],
      storage: ['CsiStorageReady', 'StorageCanaryRequired', 'StorageCanaryExpired', 'StorageCanaryFailed'],
      'csi-snapshot': ['SnapshotReady', 'DataProtectionCanaryRequired', 'DataProtectionCanaryExpired', 'DataProtectionCanaryFailed'],
    };
    return (reasons[item.id] || []).includes(item.check.reason);
  }
  openCanaryValidation(item: HisItem): void {
    this.canaryTarget.set(item);
    this.canaryReason = '';
    this.error.set('');
    this.canaryModalOpen = true;
  }
  runCanaryValidation(): void {
    const item = this.canaryTarget();
    const ids = ['cluster-network', 'cluster-dns', 'kube-prometheus-stack', 'storage', 'csi-snapshot'] as const;
    if (!item || !ids.includes(item.id as typeof ids[number]) || this.canaryBusy() || this.canaryReason.trim().length < 8) return;
    this.canaryBusy.set(true);
    this.error.set('');
    this.his.validate(item.id as typeof ids[number], this.canaryReason.trim()).subscribe({
      next: (response) => {
        this.canaryBusy.set(false);
        this.canaryModalOpen = false;
        this.notice.set(`${item.displayName} 실제 기능 경로 검증이 시작되었습니다. 작업 ID: ${response.operation.id}`);
        this.setExpanded(item.id, true);
        this.load();
      },
      error: (error) => { this.error.set(this.message(error)); this.canaryBusy.set(false); },
    });
  }
  isExpanded(itemId: string): boolean { return this.expandedItems().has(itemId); }
  setExpanded(itemId: string, expanded: boolean): void {
    this.expandedItems.update((current) => {
      if (current.has(itemId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }
  operationActive(operation?: HisOperation | null): boolean {
    return !!operation && ['Queued', 'Recovering', 'Installing', 'Upgrading', 'RollingBack', 'Configuring', 'Migrating', 'Validating', 'Uninstalling'].includes(operation.phase);
  }
  operationLabel(operation: HisOperation): string {
    return operation.action === 'install' ? '설치'
      : operation.action === 'upgrade' ? '업그레이드'
        : operation.action === 'recover' ? '복구'
          : operation.action === 'rollback' ? '롤백'
            : operation.action === 'configure' ? '운영 구성'
              : operation.action === 'validate' ? '실검증' : '삭제';
  }
  releaseLifecycle(item: HisItem): HisLifecycleAction {
    if (!item.release?.managed) return 'install';
    const status = String(item.release.status || '').toLowerCase();
    if (status === 'deployed') return 'upgrade';
    if (['failed', 'pending-install', 'pending-upgrade', 'pending-rollback', 'uninstalling'].includes(status)) return 'recover';
    return 'blocked';
  }
  planAction(item: HisItem): Exclude<HisLifecycleAction, 'blocked'> {
    const action = this.releaseLifecycle(item);
    return action === 'blocked' ? 'install' : action;
  }
  canInstall(item: HisItem): boolean {
    if (item.mode !== 'HelmManaged') return false;
    if (this.operationActive(item.operation)) return false;
    if (this.releaseLifecycle(item) !== 'install') return false;
    if (item.check.state === 'Ready' && item.ownership === 'External') return false;
    if (item.check.state === 'Degraded' && !item.release?.managed && !item.replacementPolicy) return false;
    return item.check.state !== 'Ready';
  }

  rollbackAvailable(item: HisItem): boolean {
    return Boolean(this.releaseLifecycle(item) === 'upgrade' && Number(item.release?.revision) >= 2);
  }

  openSharedObservability(item: HisItem): void {
    this.observabilityTarget.set(item);
    this.observabilityChartVersion = item.chartVersion || '87.19.1';
    this.configurationMode = item.release?.managed ? 'operate' : 'install';
    this.observabilityAdvancedOpen = false;
    this.observabilityLifecycleModalOpen = true;
    this.error.set('');
    this.loadObservabilityConfiguration();
  }

  releaseStateLabel(item: HisItem): string {
    if (!item.release?.managed) return '설치되지 않음';
    const status = String(item.release.status || 'unknown');
    const version = item.release.chartVersion ? ` · chart ${item.release.chartVersion}` : '';
    return status === 'deployed' ? `Helm 배포됨${version}` : `Helm ${status}${version}`;
  }

  chartVersionSupported(item: HisItem): boolean {
    return Boolean(this.observabilityChartVersion && (item.availableChartVersions || []).includes(this.observabilityChartVersion.trim()));
  }

  chartVersionChanged(): void {
    this.plan.set(null);
    this.error.set('');
  }

  storageSelectionChanged(): void {
    this.observabilityPlan.set(null);
    this.validateConfiguration();
  }

  sharedStorageClassName(): string {
    const config = this.observabilityConfig();
    if (!config) return '';
    const selected = [
      config.prometheus.storageClassName,
      config.alertmanager.storageClassName,
      config.grafana.storageClassName,
      ...(config.telemetry.enabled ? [config.telemetry.storageClassName] : []),
    ];
    return selected.every((name) => name === selected[0]) ? selected[0] : '';
  }

  sharedStorageClassChanged(storageClassName: string): void {
    const config = this.observabilityConfig();
    if (!config) return;
    config.prometheus.storageClassName = storageClassName;
    config.alertmanager.storageClassName = storageClassName;
    config.grafana.storageClassName = storageClassName;
    if (config.telemetry.enabled) config.telemetry.storageClassName = storageClassName;
    this.storageSelectionChanged();
  }

  sharedStorageClassHint(): string {
    const state = this.observabilityState();
    if (!state) return '클러스터 StorageClass를 불러오는 중입니다.';
    const selected = this.sharedStorageClassName();
    const storageClass = state.storageClasses.find((item) => item.name === selected)
      || state.storageClasses.find((item) => item.isDefault);
    if (!storageClass) return 'StorageClass를 선택하십시오.';
    return storageClass.isCsi
      ? `${storageClass.provisioner} · CSI 영구 저장소`
      : `${storageClass.provisioner} · 설치 가능, snapshot·온라인 확장은 제한될 수 있음`;
  }

  storageReadiness(): string {
    const state = this.observabilityState();
    const config = this.observabilityConfig();
    if (!state || !config) return this.status()?.items.find((item) => item.id === 'storage')?.check.state || 'Unknown';
    const defaultClass = state.storageClasses.find((item) => item.isDefault)?.name || '';
    const selected = [
      config.prometheus.storageClassName || defaultClass,
      config.alertmanager.storageClassName || defaultClass,
      config.grafana.storageClassName || defaultClass,
      ...(config.telemetry.enabled ? [config.telemetry.storageClassName || defaultClass] : []),
    ];
    if (selected.some((name) => !name)) return 'Blocked';
    return selected.every((name) => state.storageClasses.some((item) => item.name === name)) ? 'Ready' : 'Blocked';
  }

  storageReadinessMessage(): string {
    const state = this.observabilityState();
    const config = this.observabilityConfig();
    if (!state || !config) {
      const storage = this.status()?.items.find((item) => item.id === 'storage');
      return storage ? `${storage.check.message} 설치 옵션에서 StorageClass를 명시적으로 선택할 수 있습니다.` : 'StorageClass 실측 결과가 없습니다.';
    }
    const defaultClass = state.storageClasses.find((item) => item.isDefault)?.name || '';
    const selections = [
      ['Prometheus', config.prometheus.storageClassName || defaultClass],
      ['Alertmanager', config.alertmanager.storageClassName || defaultClass],
      ['Grafana', config.grafana.storageClassName || defaultClass],
      ...(config.telemetry.enabled ? [['Loki·Tempo', config.telemetry.storageClassName || defaultClass]] : []),
    ];
    const invalid = selections.filter(([, name]) => !name || !state.storageClasses.some((item) => item.name === name));
    if (invalid.length) return `StorageClass 선택 필요: ${invalid.map(([component, name]) => `${component}=${name || '미지정'}`).join(', ')}`;
    const nonCsi = selections.filter(([, name]) => !state.storageClasses.find((item) => item.name === name)?.isCsi);
    const summary = selections.map(([component, name]) => `${component}=${name}`).join(' · ');
    return nonCsi.length ? `${summary} · snapshot/온라인 확장 제한 가능` : summary;
  }

  selectedStorageClass(selected: string): string {
    if (selected) return selected;
    return this.observabilityState()?.storageClasses.find((item) => item.isDefault)?.name || '기본 StorageClass 미지정';
  }

  observabilityInstallCandidate(item: HisItem): boolean {
    if (item.id !== 'kube-prometheus-stack' || item.mode !== 'HelmManaged') return false;
    if (this.operationActive(item.operation) || this.releaseLifecycle(item) !== 'install') return false;
    if (item.check.state === 'Ready' && item.ownership === 'External') return false;
    return item.check.state !== 'Ready';
  }

  observabilityInstallReady(item: HisItem): boolean {
    const plan = this.observabilityPlan();
    return this.observabilityInstallCandidate(item)
      && this.storageReadiness() === 'Ready'
      && this.chartVersionSupported(item)
      && Boolean(plan?.canApply)
      && !this.configurationLoading()
      && !this.configurationPlanning();
  }

  observabilityBlockingIssues(item: HisItem): string[] {
    if (item.release?.managed && item.check.state === 'Ready') return [];
    const issues: string[] = [];
    if (this.storageReadiness() !== 'Ready') issues.push('StorageClass 선택');
    if (!this.chartVersionSupported(item)) issues.push('지원 Chart 버전 선택');
    if (!item.release?.managed && this.observabilityPlan() && !this.observabilityPlan()?.canApply && !issues.length) {
      issues.push('클러스터 설치 조건 확인');
    }
    return issues;
  }

  quickStorageSummary(): string {
    const state = this.observabilityState();
    const config = this.observabilityConfig();
    if (!state || !config) return '자동 선택';
    const fallback = state.storageClasses.find((item) => item.isDefault)?.name || '';
    const selected = [
      config.prometheus.storageClassName || fallback,
      config.alertmanager.storageClassName || fallback,
      config.grafana.storageClassName || fallback,
      ...(config.telemetry.enabled ? [config.telemetry.storageClassName || fallback] : []),
    ].filter(Boolean);
    const unique = [...new Set(selected)];
    if (!unique.length) return '사용 가능한 CSI 없음';
    return unique.length === 1 ? `${unique[0]} · 자동 선택` : `${unique.length}개 CSI · 구성요소별 자동 선택`;
  }

  readyComponentCount(item: HisItem): number {
    return (item.check.details?.components || []).filter((component) => component.state === 'Ready').length;
  }

  validationSummary(item: HisItem): string {
    const canaries = item.check.details?.canaries || [];
    if (!canaries.length) return '실행 기록 없음';
    const passed = canaries.filter((canary) => canary.state === 'Passed').length;
    return `${passed}/${canaries.length} Passed`;
  }

  openPlanFromObservability(item: HisItem, action: HisMutationAction, execute = false): void {
    this.observabilityLifecycleModalOpen = false;
    this.openPlan(item, action, execute);
  }

  openCanaryFromObservability(item: HisItem): void {
    this.observabilityLifecycleModalOpen = false;
    this.openCanaryValidation(item);
  }

  quickInstallRequest(item: HisItem): boolean {
    return item.id === 'kube-prometheus-stack' && this.action() === 'install' && this.executeRequested();
  }

  openPlan(item: HisItem, action: HisMutationAction, execute = false): void {
    this.selected.set(item);
    this.action.set(action);
    this.executeRequested.set(execute);
    this.plan.set(null);
    this.reason = '';
    this.confirm = '';
    this.rollbackRevision = '';
    this.error.set('');
    this.modalOpen = true;
    this.planLoading.set(true);
    this.his.plan(
      item.id,
      item.id === 'kube-prometheus-stack' ? this.configurationRequestConfig() || undefined : undefined,
      item.id === 'kube-prometheus-stack' ? this.observabilityChartVersion.trim() : undefined,
    ).subscribe({
      next: (plan) => { this.plan.set(plan); this.planLoading.set(false); },
      error: (error) => { this.error.set(this.message(error)); this.planLoading.set(false); },
    });
  }

  readyToExecute(): boolean {
    const item = this.selected();
    if (!item || !this.plan() || this.busy() || this.reason.trim().length < 8) return false;
    if (['install', 'upgrade', 'recover'].includes(this.action()) && item.id === 'kube-prometheus-stack' && !this.chartVersionSupported(item)) return false;
    if (this.action() === 'install' && item.id === 'kube-prometheus-stack' && !this.observabilityPlan()?.canApply) return false;
    if (this.action() === 'install') return !this.plan()?.migration?.required || this.confirm === this.plan()?.migration?.confirmation;
    if (this.action() === 'upgrade' || this.action() === 'recover') return true;
    if (this.action() === 'rollback') return !!this.rollbackRevision && this.confirm === `${item.id}:${this.rollbackRevision}`;
    return this.confirm === item.id;
  }

  actionTitle(): string {
    return this.action() === 'uninstall' ? 'HIS 삭제 확인'
      : this.action() === 'upgrade' ? 'HIS 업그레이드 계획'
        : this.action() === 'recover' ? 'HIS release 복구 계획'
          : this.action() === 'rollback' ? 'HIS revision 롤백' : 'HIS 설치 계획';
  }

  executeButtonLabel(): string {
    return this.action() === 'install' ? '설치 실행'
      : this.action() === 'upgrade' ? '업그레이드 실행'
        : this.action() === 'recover' ? '복구 실행'
          : this.action() === 'rollback' ? '롤백 실행' : '삭제 실행';
  }

  rollbackTargets(plan: HisPlan, item: HisItem): HisPlan['history'] {
    return plan.history.filter((entry) => entry.revision < Number(item.release?.revision || 0));
  }

  confirmationText(item: HisItem): string {
    if (this.action() === 'rollback') return `${item.id}:${this.rollbackRevision || '<revision>'}`;
    if (this.action() === 'install' && this.plan()?.migration?.required) return this.plan()?.migration?.confirmation || `replace ${item.id}`;
    return item.id;
  }

  execute(): void {
    const item = this.selected();
    if (!item || !this.readyToExecute()) return;
    this.busy.set(true);
    this.error.set('');
    const request = this.action() === 'install'
      ? this.his.install(
        item.id,
        this.reason.trim(),
        item.id === 'kube-prometheus-stack' ? this.configurationRequestConfig() || undefined : undefined,
        item.id === 'kube-prometheus-stack' ? this.observabilityChartVersion.trim() : undefined,
        this.confirm.trim() || undefined,
      )
      : this.action() === 'upgrade' ? this.his.upgrade(item.id, this.reason.trim(), item.id === 'kube-prometheus-stack' ? this.observabilityChartVersion.trim() : undefined)
        : this.action() === 'recover' ? this.his.recover(item.id, this.reason.trim(), item.id === 'kube-prometheus-stack' ? this.observabilityChartVersion.trim() : undefined)
          : this.action() === 'rollback' ? this.his.rollback(item.id, Number(this.rollbackRevision), this.reason.trim(), this.confirm)
            : this.his.uninstall(item.id, this.reason.trim(), this.confirm);
    request.subscribe({
      next: (response) => {
        this.busy.set(false);
        this.modalOpen = false;
        this.notice.set(`${item.displayName} ${this.operationLabel(response.operation)} 작업이 등록되었습니다. 작업 ID: ${response.operation.id}`);
        this.load();
      },
      error: (error) => { this.busy.set(false); this.error.set(this.message(error)); },
    });
  }

  openObservabilityConfiguration(mode: ObservabilityConfigurationMode = 'operate'): void {
    this.configurationMode = mode;
    this.observabilityLifecycleModalOpen = false;
    this.error.set('');
    this.configurationReason = '';
    this.resetData = false;
    this.resetConfirmation = '';
    this.publicConfirmation = '';
    this.configurationModalOpen = true;
    if (this.observabilityState() && this.observabilityConfig()) {
      this.validateConfiguration();
      return;
    }
    this.loadObservabilityConfiguration();
  }

  private loadObservabilityConfiguration(): void {
    this.observabilityState.set(null);
    this.observabilityConfig.set(null);
    this.observabilityPlan.set(null);
    this.configurationFingerprint = '';
    this.allowedCidrsText = '';
    this.configurationLoading.set(true);
    this.his.observabilityConfig().subscribe({
      next: (state) => {
        this.observabilityState.set(state);
        const config = this.applyQuickInstallDefaults(state, this.cloneConfig(state.config));
        this.observabilityConfig.set(config);
        this.allowedCidrsText = config.grafana.allowedCidrs.join('\n');
        this.configurationLoading.set(false);
        this.validateConfiguration();
      },
      error: (error) => { this.configurationLoading.set(false); this.error.set(this.message(error)); },
    });
  }

  storageClassHint(state: ObservabilityConfigurationState, selected: string): string {
    const storageClass = state.storageClasses.find((item) => item.name === selected)
      || state.storageClasses.find((item) => item.isDefault);
    if (!storageClass) return '기본 StorageClass 없음';
    return `${storageClass.provisioner} · ${storageClass.isCsi ? 'CSI' : '동적 provisioner'} · ${storageClass.allowVolumeExpansion ? '온라인 확장 가능' : '온라인 확장 제한'} · reclaim ${storageClass.reclaimPolicy}`;
  }

  livePvc(state: ObservabilityConfigurationState, component: 'prometheus' | 'alertmanager' | 'grafana' | 'loki' | 'tempo'): string {
    const pvc = state.live.pvcs[component];
    return pvc ? `${pvc.requested || pvc.capacity} · ${pvc.storageClassName} · ${pvc.selectedNode || 'node pending'}` : '없음';
  }

  validateConfiguration(): void {
    const config = this.configurationRequestConfig();
    if (!config) return;
    this.error.set('');
    this.configurationPlanning.set(true);
    this.observabilityPlan.set(null);
    this.his.observabilityPlan(config).subscribe({
      next: (plan) => {
        const normalized = this.cloneConfig(plan.config);
        this.observabilityConfig.set(normalized);
        this.allowedCidrsText = normalized.grafana.allowedCidrs.join('\n');
        this.configurationFingerprint = JSON.stringify(normalized);
        this.observabilityPlan.set(plan);
        this.configurationPlanning.set(false);
      },
      error: (error) => { this.configurationPlanning.set(false); this.error.set(this.message(error)); },
    });
  }

  configurationReadyToApply(): boolean {
    const state = this.observabilityState();
    const plan = this.observabilityPlan();
    const config = this.configurationRequestConfig();
    if (!state || !plan || !config || !plan.canApply || this.configurationBusy() || this.configurationPlanning()) return false;
    if (JSON.stringify(config) !== this.configurationFingerprint) return false;
    if (this.configurationMode === 'install') return !plan.requiresDataReset;
    if (this.configurationReason.trim().length < 8) return false;
    if (plan.requiresDataReset && (!this.resetData || this.resetConfirmation !== state.policy.resetConfirmation)) return false;
    if (config.grafana.exposureMode === 'PublicIngress' && this.publicConfirmation !== state.policy.publicConfirmation) return false;
    return true;
  }

  applyObservabilityConfiguration(): void {
    const config = this.configurationRequestConfig();
    const state = this.observabilityState();
    if (!config || !state || !this.configurationReadyToApply()) return;
    if (this.configurationMode === 'install') {
      this.configurationModalOpen = false;
      this.observabilityLifecycleModalOpen = true;
      this.notice.set('Shared Observability 고급 설정이 빠른 설치 요청에 반영되었습니다.');
      return;
    }
    this.configurationBusy.set(true);
    this.error.set('');
    this.his.configureObservability(
      config,
      this.configurationReason.trim(),
      this.resetData,
      this.resetConfirmation,
      this.publicConfirmation,
    ).subscribe({
      next: (response) => {
        this.configurationBusy.set(false);
        this.configurationModalOpen = false;
        this.notice.set(`Shared Observability 운영 구성 작업이 등록되었습니다. 작업 ID: ${response.operation.id}`);
        this.setExpanded('kube-prometheus-stack', true);
        this.load();
      },
      error: (error) => { this.configurationBusy.set(false); this.error.set(this.message(error)); },
    });
  }

  configurationApplyLabel(): string {
    return this.configurationMode === 'install' ? '설치 계획에 반영' : '운영 구성 적용';
  }

  closeObservabilityConfiguration(): void {
    this.configurationModalOpen = false;
    if (this.observabilityTarget()) this.observabilityLifecycleModalOpen = true;
  }

  private configurationRequestConfig(): ObservabilityConfig | null {
    const current = this.observabilityConfig();
    if (!current) return null;
    const config = this.cloneConfig(current);
    config.grafana.allowedCidrs = this.allowedCidrsText.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    return config;
  }

  private applyQuickInstallDefaults(state: ObservabilityConfigurationState, config: ObservabilityConfig): ObservabilityConfig {
    if (this.observabilityTarget()?.release?.managed) return config;
    const preferred = state.storageClasses.find((item) => item.isDefault && item.isCsi)
      || state.storageClasses.find((item) => item.isCsi)
      || state.storageClasses.find((item) => item.isDefault)
      || state.storageClasses[0];
    if (!preferred) return config;
    const choose = (current: string): string => state.storageClasses.some((item) => item.name === current)
      ? current
      : preferred.name;
    config.prometheus.storageClassName = choose(config.prometheus.storageClassName);
    config.alertmanager.storageClassName = choose(config.alertmanager.storageClassName);
    config.grafana.storageClassName = choose(config.grafana.storageClassName);
    if (config.telemetry.enabled) config.telemetry.storageClassName = choose(config.telemetry.storageClassName);
    return config;
  }

  private cloneConfig(config: ObservabilityConfig): ObservabilityConfig {
    return JSON.parse(JSON.stringify(config));
  }

  private message(error: any): string {
    return String(error?.error?.error || error?.message || 'HIS 요청에 실패했습니다.');
  }
}
