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
      <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-danger]="s.state === 'Blocked'" [class.label-warning]="s.state === 'Degraded'">HIS Core {{ s.state }}</span>
      <span>필수 {{ requiredReady(s) }}/{{ requiredTotal(s) }} Ready</span>
      <span>선택 {{ optionalReady(s) }}/{{ optionalTotal(s) }} Ready</span>
      <span>검사 {{ s.checkedAt | date:'yyyy-MM-dd HH:mm:ss' }}</span>
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
        [clrDgExpanded]="isExpanded(item.id)"
        (clrDgExpandedChange)="setExpanded(item.id, $event)"
      >
        <clr-dg-cell>
          <strong>{{ item.displayName }}</strong>
          <div class="muted">{{ item.description }}</div>
          <div class="muted" *ngIf="item.chartName">{{ item.chartName }} {{ item.chartVersion }}</div>
        </clr-dg-cell>
        <clr-dg-cell>
          <span class="label" [class.label-info]="item.mode === 'HelmManaged'">{{ item.mode }}</span>
          <span *ngIf="item.required" class="required">필수</span>
          <span *ngIf="!item.required && item.profile" class="optional">선택 · {{ item.profile }}</span>
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
          <ng-container *ngIf="item.mode === 'HelmManaged'; else detectOnly">
            <button class="btn btn-sm btn-outline" type="button" [disabled]="busy() || operationActive(item.operation)" (click)="openPlan(item, 'install')">계획</button>
            <button class="btn btn-sm btn-primary" type="button" [disabled]="busy() || operationActive(item.operation) || !canInstall(item)" (click)="openPlan(item, 'install', true)">설치</button>
            <button *ngIf="item.id === 'kube-prometheus-stack'" class="btn btn-sm btn-outline" type="button" [disabled]="busy() || operationActive(item.operation) || !item.release?.managed" (click)="openObservabilityConfiguration()">운영 구성</button>
            <button class="btn btn-sm btn-danger-outline" type="button" [disabled]="busy() || operationActive(item.operation) || !item.release?.managed" (click)="openPlan(item, 'uninstall', true)">삭제</button>
          </ng-container>
          <ng-template #detectOnly><span class="muted">호스트 제공 · 진단만</span></ng-template>
        </clr-dg-cell>
        <clr-dg-row-detail *clrIfExpanded>
          <div class="detail">
            <section class="operation-card" *ngIf="item.operation as operation" role="status" aria-live="polite">
              <div class="operation-head">
                <div><strong>{{ operationLabel(operation) }} 작업 · {{ operation.phase }}</strong><div class="muted">작업 ID {{ operation.id }} · {{ operation.actor }} · {{ operation.worker }}</div></div>
                <span class="label" [class.label-success]="operation.phase === 'Ready' || operation.phase === 'Removed'" [class.label-danger]="operation.phase === 'Failed' || operation.phase === 'RollbackStalled'" [class.label-info]="operationActive(operation)">{{ operation.progress }}%</span>
              </div>
              <div class="progress-block"><progress [value]="operation.progress" max="100" [attr.aria-label]="operation.message"></progress></div>
              <p>{{ operation.message }}</p>
              <p class="operation-error" *ngIf="operation.error">{{ operation.error }}</p>
              <div class="muted">시작 {{ operation.startedAt | date:'yyyy-MM-dd HH:mm:ss' }} · 갱신 {{ operation.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}<span *ngIf="operation.releaseStatus"> · Helm {{ operation.releaseStatus }}</span></div>
            </section>
            <div class="detail-summary"><strong>{{ item.check.reason }}</strong><span>{{ item.check.message }}</span><span *ngIf="item.source">Source: {{ item.source }}</span></div>
            <section *ngIf="item.check.details as details" class="operational-section">
              <h4 *ngIf="details.components?.length">구성요소 운영 상태</h4>
              <table class="table table-compact component-table" *ngIf="details.components?.length">
                <thead><tr><th>서비스</th><th>리소스</th><th>상태</th><th>Ready</th><th>이미지</th></tr></thead>
                <tbody><tr *ngFor="let component of details.components">
                  <td>{{ component.name }}</td><td><code>{{ component.kind }}/{{ component.resourceName || '—' }}</code></td>
                  <td><span class="label" [class.label-success]="component.state === 'Ready'" [class.label-warning]="component.state === 'Pending'" [class.label-danger]="component.state === 'Missing'">{{ component.state }}</span></td>
                  <td>{{ component.ready }}/{{ component.desired }}</td><td class="image-cell">{{ component.image || '—' }}</td>
                </tr></tbody>
              </table>
              <div class="resource-health">
                <span>CRD {{ details.crds?.ready || 0 }}/{{ details.crds?.total || 0 }}</span>
                <span>PVC {{ details.pvcs?.length || 0 }}개</span>
                <span>Service {{ details.services?.length || 0 }}개</span>
              </div>
              <table class="table table-compact" *ngIf="details.pvcs?.length">
                <thead><tr><th>PVC</th><th>상태</th><th>요청/할당</th><th>StorageClass</th></tr></thead>
                <tbody><tr *ngFor="let pvc of details.pvcs"><td>{{ pvc.name }}</td><td>{{ pvc.phase }}</td><td>{{ pvc.requested }} / {{ pvc.capacity || '—' }}</td><td>{{ pvc.storageClass }}</td></tr></tbody>
              </table>
              <table class="table table-compact" *ngIf="details.services?.length">
                <thead><tr><th>Service</th><th>유형</th><th>Cluster IP</th><th>Ports</th></tr></thead>
                <tbody><tr *ngFor="let service of details.services"><td>{{ service.name }}</td><td>{{ service.type }}</td><td>{{ service.clusterIP }}</td><td>{{ service.ports }}</td></tr></tbody>
              </table>
            </section>
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
            <dt>Workloads / Services</dt><dd>{{ p.summary.workloads }} / {{ p.summary.services }}</dd>
            <dt>CRD / PVC</dt><dd>{{ p.summary.customResourceDefinitions }} / {{ p.summary.persistentVolumeClaims }}</dd>
          </dl>
          <div class="profile-card" *ngIf="p.operationalProfile as profile">
            <strong>설치 서비스</strong><span>{{ profile.components.join(', ') }}</span>
            <strong>영구 저장소</strong><span>{{ profile.storage.join(', ') }}</span>
            <strong>보존 정책</strong><span>{{ profile.retention.join(', ') }}</span>
            <strong>접근 방식</strong><span>{{ profile.exposure }}</span>
          </div>
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

    <clr-modal [(clrModalOpen)]="configurationModalOpen" [clrModalClosable]="!configurationBusy()" [clrModalSize]="'xl'">
      <h3 class="modal-title">Shared Observability 운영 구성</h3>
      <div class="modal-body configuration-modal">
        <div *ngIf="configurationLoading()" class="progress loop"><progress></progress></div>
        <div *ngIf="error()" class="alert alert-danger" role="alert"><div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div></div>
        <ng-container *ngIf="observabilityState() as state">
          <div class="policy-banner">
            <div><strong>저장소·보존·원격 보관</strong><span>설치 후 관리 가능한 선언형 운영 구성입니다.</span></div>
            <div><strong>외부 공개 원칙</strong><span>Grafana만 TLS+OIDC Ingress를 허용하며 Prometheus/Alertmanager 직접 공개는 금지합니다.</span></div>
            <span class="label label-info">{{ state.source }}</span>
          </div>

          <div class="alert alert-warning" *ngIf="state.live.directExternalServices.length" role="alert">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">정책 외 직접 공개 Service: {{ state.live.directExternalServices.join(', ') }}. 적용 시 ClusterIP로 복구합니다.</span></div></div>
          </div>

          <ng-container *ngIf="observabilityConfig() as config">
            <section class="config-section">
              <div class="section-heading"><div><p class="eyebrow">DATA PLANE</p><h4>영구 저장소와 보존기간</h4></div><span>StorageClass 변경·축소는 명시적 데이터 재배치가 필요합니다.</span></div>
              <table class="table table-compact config-table">
                <thead><tr><th>서비스</th><th>StorageClass</th><th>용량</th><th>보존기간</th><th>현재 PVC</th></tr></thead>
                <tbody>
                  <tr>
                    <td><strong>Prometheus</strong><div class="muted">메트릭 TSDB</div></td>
                    <td><select clrSelect name="prometheusStorageClass" [(ngModel)]="config.prometheus.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.prometheus.storageClassName) }}</div></td>
                    <td><input clrInput name="prometheusStorageSize" [(ngModel)]="config.prometheus.storageSize" placeholder="20Gi"></td>
                    <td><input clrInput name="prometheusRetention" [(ngModel)]="config.prometheus.retention" placeholder="7d"></td>
                    <td>{{ livePvc(state, 'prometheus') }}</td>
                  </tr>
                  <tr>
                    <td><strong>Alertmanager</strong><div class="muted">알림 상태·silence</div></td>
                    <td><select clrSelect name="alertmanagerStorageClass" [(ngModel)]="config.alertmanager.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.alertmanager.storageClassName) }}</div></td>
                    <td><input clrInput name="alertmanagerStorageSize" [(ngModel)]="config.alertmanager.storageSize" placeholder="2Gi"></td>
                    <td><input clrInput name="alertmanagerRetention" [(ngModel)]="config.alertmanager.retention" placeholder="120h"></td>
                    <td>{{ livePvc(state, 'alertmanager') }}</td>
                  </tr>
                  <tr>
                    <td><strong>Grafana</strong><div class="muted">대시보드·설정 DB</div></td>
                    <td><select clrSelect name="grafanaStorageClass" [(ngModel)]="config.grafana.storageClassName"><option value="">Cluster default</option><option *ngFor="let sc of state.storageClasses" [value]="sc.name">{{ sc.name }}{{ sc.isDefault ? ' (default)' : '' }}</option></select><div class="storage-hint">{{ storageClassHint(state, config.grafana.storageClassName) }}</div></td>
                    <td><input clrInput name="grafanaStorageSize" [(ngModel)]="config.grafana.storageSize" placeholder="5Gi"></td>
                    <td><span class="muted">해당 없음</span></td>
                    <td>{{ livePvc(state, 'grafana') }}</td>
                  </tr>
                </tbody>
              </table>
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
                  <dt>Managed NetworkPolicy</dt><dd>{{ state.live.networkPolicies.length }}/3</dd>
                  <dt>Grafana Ingress</dt><dd>{{ state.live.grafana.ingress?.hostname || '없음' }}</dd>
                  <dt>Prometheus 직접 공개</dt><dd>금지</dd>
                  <dt>Alertmanager 직접 공개</dt><dd>금지</dd>
                </dl>
              </div>
            </section>

            <section class="config-section">
              <div class="section-heading"><div><p class="eyebrow">ACCESS POLICY</p><h4>Grafana 접근 정책</h4></div><span>Service는 모든 모드에서 ClusterIP로 유지합니다.</span></div>
              <div class="exposure-options">
                <label [class.selected]="config.grafana.exposureMode === 'ClusterInternal'"><input type="radio" name="grafanaExposure" value="ClusterInternal" [(ngModel)]="config.grafana.exposureMode"><strong>Cluster Internal</strong><span>기본값. monitoring과 Console namespace에서만 접근</span></label>
                <label [class.selected]="config.grafana.exposureMode === 'PrivateIngress'"><input type="radio" name="grafanaExposure" value="PrivateIngress" [(ngModel)]="config.grafana.exposureMode"><strong>Private Ingress</strong><span>TLS+OIDC+IP allowlist를 모두 검증한 내부망 공개</span></label>
                <label class="danger-option" [class.selected]="config.grafana.exposureMode === 'PublicIngress'"><input type="radio" name="grafanaExposure" value="PublicIngress" [(ngModel)]="config.grafana.exposureMode"><strong>Public Ingress</strong><span>TLS+OIDC+rate limit+명시적 승인이 필요한 인터넷 공개</span></label>
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
              <div class="section-heading"><div><p class="eyebrow">CHANGE CONTROL</p><h4>변경 계획과 승인</h4></div><button class="btn btn-sm btn-outline" type="button" [disabled]="configurationPlanning() || configurationBusy()" (click)="validateConfiguration()">변경 계획 검사</button></div>
              <div *ngIf="configurationPlanning()" class="progress loop"><progress></progress></div>
              <ng-container *ngIf="observabilityPlan() as configPlan">
                <div class="alert alert-danger" *ngIf="configPlan.blockers.length"><div class="alert-items"><div class="alert-item static"><span class="alert-text"><strong>적용 차단</strong><span *ngFor="let blocker of configPlan.blockers"> · {{ blocker }}</span></span></div></div></div>
                <div class="alert alert-warning" *ngIf="configPlan.warnings.length"><div class="alert-items"><div class="alert-item static"><span class="alert-text"><strong>주의</strong><span *ngFor="let warning of configPlan.warnings"> · {{ warning }}</span></span></div></div></div>
                <table class="table table-compact change-table" *ngIf="configPlan.changes.length"><thead><tr><th>영역</th><th>항목</th><th>현재</th><th>변경</th></tr></thead><tbody><tr *ngFor="let change of configPlan.changes"><td><span class="label">{{ change.impact }}</span></td><td><code>{{ change.field }}</code></td><td>{{ change.from }}</td><td>{{ change.to }}</td></tr></tbody></table>
                <p class="muted" *ngIf="!configPlan.changes.length">선언된 구성 변경이 없습니다. 정책 리소스는 현재 값으로 재조정할 수 있습니다.</p>
                <div class="destructive-confirm" *ngIf="configPlan.requiresDataReset">
                  <strong>데이터 초기화 재배치 필요</strong>
                  <ul><li *ngFor="let target of configPlan.resetTargets">{{ target }}</li></ul>
                  <label><input type="checkbox" clrCheckbox name="resetData" [(ngModel)]="resetData"> 기존 Prometheus·Alertmanager·Grafana 데이터를 삭제하고 새 PVC를 생성합니다.</label>
                  <input clrInput name="resetConfirmation" [(ngModel)]="resetConfirmation" [placeholder]="state.policy.resetConfirmation" autocomplete="off">
                </div>
              </ng-container>
              <form clrForm clrLayout="vertical">
                <clr-textarea-container><label>변경 사유</label><textarea clrTextarea name="configurationReason" [(ngModel)]="configurationReason" required minlength="8" maxlength="500" placeholder="저장소·보존·공개 정책 변경 근거(8자 이상)"></textarea></clr-textarea-container>
                <clr-input-container *ngIf="config.grafana.exposureMode === 'PublicIngress'"><label>Public 공개 확인</label><input clrInput name="publicConfirmation" [(ngModel)]="publicConfirmation" [placeholder]="state.policy.publicConfirmation" autocomplete="off"><clr-control-helper>{{ state.policy.publicConfirmation }} 를 정확히 입력하십시오.</clr-control-helper></clr-input-container>
              </form>
            </section>
          </ng-container>
        </ng-container>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="configurationBusy()" (click)="configurationModalOpen = false">취소</button>
        <button class="btn btn-primary" type="button" [disabled]="!configurationReadyToApply()" (click)="applyObservabilityConfiguration()">운영 구성 적용</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host { display: block; }
    .his-head {
      display: flex;
      justify-content: space-between;
      gap: 1.5rem;
      align-items: flex-start;
      height: auto;
      min-height: 0;
      margin-bottom: 0.8rem;
      padding: 0;
      background: transparent;
      color: inherit;
      overflow: visible;
    }
    .his-head h1 { margin: 0.15rem 0 0.35rem; color: #2d4048; font-size: 1.45rem; font-weight: 400; line-height: 1.25; }
    .his-head p { margin: 0; max-width: 62rem; color: #565656; line-height: 1.5; }
    .eyebrow { color: #4c6fff !important; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .summary { display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0; color: #565656; font-size: 0.72rem; }
    .muted { color: #6f6f6f; font-size: 0.65rem; margin-top: 0.12rem; }
    .required { margin-left: 0.35rem; color: #a32100; font-size: 0.62rem; font-weight: 600; }
    .optional { margin-left: 0.35rem; color: #00567a; font-size: 0.62rem; font-weight: 600; }
    .detail { padding: 0.6rem 1rem; line-height: 1.5; }
    .detail-summary { display: grid; gap: 0.2rem; margin-bottom: 0.7rem; }
    .operation-inline { color: #00567a; font-size: 0.62rem; font-weight: 600; margin-top: 0.2rem; }
    .operation-card { border: 1px solid #9bd3e6; background: #eefaff; padding: 0.7rem; margin-bottom: 0.8rem; }
    .operation-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    .progress-block progress { width: 100%; height: 0.55rem; margin: 0.55rem 0 0.25rem; }
    .operation-card p { margin: 0.2rem 0; }
    .operation-error { color: #c21d00; white-space: pre-wrap; }
    .operational-section h4 { margin: 0.75rem 0 0.25rem; }
    .component-table { table-layout: fixed; }
    .component-table th:nth-child(1) { width: 15%; }
    .component-table th:nth-child(2) { width: 25%; }
    .component-table th:nth-child(3), .component-table th:nth-child(4) { width: 10%; }
    .image-cell { overflow-wrap: anywhere; font-size: 0.62rem; }
    .resource-health { display: flex; gap: 1rem; padding: 0.4rem 0; font-weight: 600; }
    .plan-meta { display: grid; grid-template-columns: 9rem 1fr; gap: 0.35rem 0.8rem; margin: 0.8rem 0; }
    .plan-meta dt { font-weight: 600; }
    .plan-meta dd { margin: 0; }
    .resource-list { max-height: 16rem; overflow: auto; border: 1px solid #d8d8d8; }
    .resource-list > div { display: grid; grid-template-columns: minmax(16rem, 1fr) minmax(8rem, 0.5fr); padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    .profile-card { display: grid; grid-template-columns: 8rem 1fr; gap: 0.3rem 0.75rem; padding: 0.65rem; margin-bottom: 0.7rem; border: 1px solid #d8d8d8; background: #fafafa; }
    .configuration-modal { display: grid; gap: 0.9rem; max-height: 72vh; overflow: auto; padding-right: 0.3rem; }
    .policy-banner { display: grid; grid-template-columns: minmax(16rem, 1fr) minmax(16rem, 1fr) auto; gap: 0.8rem; align-items: center; padding: 0.7rem; border: 1px solid #9bd3e6; background: #eefaff; }
    .policy-banner > div { display: grid; gap: 0.15rem; }
    .policy-banner span:not(.label) { color: #565656; font-size: 0.65rem; }
    .config-section { border: 1px solid #d8d8d8; background: #fff; padding: 0.75rem; }
    .section-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; margin-bottom: 0.55rem; }
    .section-heading h4 { margin: 0.05rem 0 0; font-size: 0.9rem; }
    .section-heading > span { color: #6f6f6f; font-size: 0.65rem; }
    .config-table { table-layout: fixed; margin: 0; }
    .config-table th:nth-child(1), .config-table th:nth-child(5) { width: 18%; }
    .config-table th:nth-child(2) { width: 28%; }
    .config-table th:nth-child(3), .config-table th:nth-child(4) { width: 18%; }
    .config-table input, .config-table select { width: 100%; min-width: 6rem; }
    .storage-hint { max-width: 18rem; margin-top: 0.2rem; color: #6f6f6f; font-size: 0.58rem; line-height: 1.35; }
    .split-config { display: grid; grid-template-columns: minmax(20rem, 1.25fr) minmax(16rem, 0.75fr); gap: 1rem; }
    .compact-fields, .ingress-fields { display: grid; grid-template-columns: repeat(3, minmax(10rem, 1fr)); gap: 0.65rem; margin: 0.5rem 0; }
    .compact-fields label, .ingress-fields label { display: grid; gap: 0.2rem; font-size: 0.65rem; font-weight: 600; }
    .compact-fields input, .ingress-fields input, .ingress-fields select, .ingress-fields textarea { width: 100%; }
    .runtime-policy { display: grid; grid-template-columns: 12rem 1fr; gap: 0.3rem 0.7rem; margin: 0; }
    .runtime-policy dt { color: #565656; }
    .runtime-policy dd { margin: 0; font-weight: 600; }
    .exposure-options { display: grid; grid-template-columns: repeat(3, minmax(13rem, 1fr)); gap: 0.65rem; }
    .exposure-options > label { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.4rem; align-items: start; padding: 0.65rem; border: 1px solid #c8c8c8; cursor: pointer; }
    .exposure-options > label.selected { border-color: #4c6fff; box-shadow: inset 0 0 0 1px #4c6fff; background: #f5f7ff; }
    .exposure-options > label.danger-option.selected { border-color: #c21d00; box-shadow: inset 0 0 0 1px #c21d00; background: #fff5f2; }
    .exposure-options input { grid-row: 1 / span 2; }
    .exposure-options span { color: #6f6f6f; font-size: 0.62rem; line-height: 1.4; }
    .secret-contract { margin-top: 0.55rem; padding: 0.45rem; background: #f5f5f5; }
    .secret-contract code { display: block; margin: 0.2rem 0 0 1rem; }
    .plan-section { background: #fafafa; }
    .change-table { table-layout: fixed; }
    .change-table th:nth-child(1) { width: 10%; }
    .change-table th:nth-child(2) { width: 30%; }
    .destructive-confirm { display: grid; gap: 0.4rem; margin: 0.6rem 0; padding: 0.65rem; border: 1px solid #e12200; background: #fff5f2; }
    .destructive-confirm ul { margin: 0 0 0 1.1rem; }
    .destructive-confirm input[type='text'] { max-width: 22rem; }
    @media (max-width: 1100px) {
      .split-config, .exposure-options, .policy-banner { grid-template-columns: 1fr; }
      .compact-fields, .ingress-fields { grid-template-columns: 1fr 1fr; }
    }
    textarea { min-height: 5rem; }
  `],
})
export class HisComponent implements OnInit, OnDestroy {
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
  readonly expandedItems = signal<ReadonlySet<string>>(new Set<string>());
  readonly observabilityState = signal<ObservabilityConfigurationState | null>(null);
  readonly observabilityConfig = signal<ObservabilityConfig | null>(null);
  readonly observabilityPlan = signal<ObservabilityConfigurationPlan | null>(null);
  readonly configurationLoading = signal(false);
  readonly configurationPlanning = signal(false);
  readonly configurationBusy = signal(false);
  modalOpen = false;
  configurationModalOpen = false;
  reason = '';
  confirm = '';
  allowedCidrsText = '';
  configurationReason = '';
  resetData = false;
  resetConfirmation = '';
  publicConfirmation = '';
  private configurationFingerprint = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
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
      next: (status) => { this.status.set(status); this.loading.set(false); },
      error: (error) => { if (showLoading) this.error.set(this.message(error)); this.loading.set(false); },
    });
  }

  requiredTotal(status: HisStatus): number { return status.items.filter((item) => item.required).length; }
  requiredReady(status: HisStatus): number { return status.items.filter((item) => item.required && item.check.state === 'Ready').length; }
  optionalTotal(status: HisStatus): number { return status.items.filter((item) => !item.required).length; }
  optionalReady(status: HisStatus): number { return status.items.filter((item) => !item.required && item.check.state === 'Ready').length; }
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
    return !!operation && ['Queued', 'Recovering', 'Installing', 'Configuring', 'Migrating', 'Validating', 'Uninstalling'].includes(operation.phase);
  }
  operationLabel(operation: HisOperation): string {
    return operation.action === 'install' ? '설치' : operation.action === 'configure' ? '운영 구성' : '삭제';
  }
  canInstall(item: HisItem): boolean {
    if (item.mode !== 'HelmManaged') return false;
    if (this.operationActive(item.operation)) return false;
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
      next: (response) => {
        this.busy.set(false);
        this.modalOpen = false;
        this.notice.set(`${item.displayName} ${this.action() === 'install' ? '설치' : '삭제'} 작업이 등록되었습니다. 작업 ID: ${response.operation.id}`);
        this.load();
      },
      error: (error) => { this.busy.set(false); this.error.set(this.message(error)); },
    });
  }

  openObservabilityConfiguration(): void {
    this.error.set('');
    this.observabilityState.set(null);
    this.observabilityConfig.set(null);
    this.observabilityPlan.set(null);
    this.configurationFingerprint = '';
    this.allowedCidrsText = '';
    this.configurationReason = '';
    this.resetData = false;
    this.resetConfirmation = '';
    this.publicConfirmation = '';
    this.configurationModalOpen = true;
    this.configurationLoading.set(true);
    this.his.observabilityConfig().subscribe({
      next: (state) => {
        this.observabilityState.set(state);
        const config = this.cloneConfig(state.config);
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
    return `${storageClass.provisioner} · ${storageClass.allowVolumeExpansion ? '온라인 확장 가능' : '온라인 확장 불가'} · reclaim ${storageClass.reclaimPolicy}`;
  }

  livePvc(state: ObservabilityConfigurationState, component: 'prometheus' | 'alertmanager' | 'grafana'): string {
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
    if (this.configurationReason.trim().length < 8) return false;
    if (plan.requiresDataReset && (!this.resetData || this.resetConfirmation !== state.policy.resetConfirmation)) return false;
    if (config.grafana.exposureMode === 'PublicIngress' && this.publicConfirmation !== state.policy.publicConfirmation) return false;
    return true;
  }

  applyObservabilityConfiguration(): void {
    const config = this.configurationRequestConfig();
    const state = this.observabilityState();
    if (!config || !state || !this.configurationReadyToApply()) return;
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

  private configurationRequestConfig(): ObservabilityConfig | null {
    const current = this.observabilityConfig();
    if (!current) return null;
    const config = this.cloneConfig(current);
    config.grafana.allowedCidrs = this.allowedCidrsText.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    return config;
  }

  private cloneConfig(config: ObservabilityConfig): ObservabilityConfig {
    return JSON.parse(JSON.stringify(config));
  }

  private message(error: any): string {
    return String(error?.error?.error || error?.message || 'HIS 요청에 실패했습니다.');
  }
}
