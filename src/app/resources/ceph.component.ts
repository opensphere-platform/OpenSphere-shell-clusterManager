import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { CEPH_PROVIDER_GUIDE, CephConnectionInput, CephFsConfigurationInput, CephInsights, CephPlan, CephPrerequisiteRequest, CephProviderGuide, CephService, CephStatus, CephStorageService } from '../core/ceph.service';
import { CephInsightsComponent } from './ceph-insights.component';

@Component({
  selector: 'app-res-ceph',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule, CephInsightsComponent],
  template: `
    <header class="cm-ceph-page-head">
      <div class="cm-ceph-page-head__copy">
        <p class="cm-ceph-eyebrow">Kubernetes child storage</p>
        <div class="cm-ceph-title">
          <span class="cm-ceph-title__logo"><img [src]="cephLogo" alt="Ceph" width="46" height="46" /></span>
          <h1>Ceph External Storage</h1>
        </div>
        <p class="cm-ceph-summary">Ceph은 Console에 직접 마운트하지 않습니다. 선택한 Kubernetes 클러스터에 Rook External Mode와 Ceph CSI를 구성하고, Console은 연결 상태와 참조 정보만 관리합니다.</p>
      </div>
      <div class="cm-ceph-page-head__actions">
        <button class="btn btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">다시 검사</button>
        <button class="btn btn-primary" type="button" [disabled]="busy() || status()?.kubernetes?.ready !== true || status()?.ownerPrerequisites?.ready !== true || !!status()?.connection" (click)="openConnect()">외부 Ceph 연결</button>
      </div>
    </header>

    <nav class="cm-ceph-tabs" aria-label="Ceph 관리 화면">
      <button type="button" [class.active]="activeTab() === 'connection'" [attr.aria-current]="activeTab() === 'connection' ? 'page' : null" (click)="selectTab('connection')">
        연결 및 설정
      </button>
      <button type="button" [class.active]="activeTab() === 'insights'" [attr.aria-current]="activeTab() === 'insights' ? 'page' : null" (click)="selectTab('insights')">
        클러스터 현황
        <span *ngIf="status()?.connection" class="tab-status" [class.warn]="status()?.rook?.cephCluster?.health !== 'HEALTH_OK'">{{ status()?.rook?.cephCluster?.health || '연결됨' }}</span>
      </button>
      <button type="button" [class.active]="activeTab() === 'services'" [attr.aria-current]="activeTab() === 'services' ? 'page' : null" (click)="selectTab('services')">
        스토리지 서비스
        <span *ngIf="status()?.csi?.serviceCoverage as coverage" class="tab-status" [class.warn]="coverage.needsConfiguration > 0 || coverage.verified < coverage.configured">{{ coverage.configured }}/{{ coverage.installed }} 구성 · {{ coverage.verified ? coverage.verified + ' 검증' : '실제 검증 없음' }}</span>
      </button>
    </nav>
    <div *ngIf="statusPollWarning()" class="alert alert-warning" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ statusPollWarning() }}</span></div></div>
    </div>

    <ng-container *ngIf="activeTab() === 'connection' || activeTab() === 'services'">
    <ng-container *ngIf="activeTab() === 'connection'">
    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div *ngIf="notice()" class="alert alert-success" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ notice() }}</span></div></div>
    </div>
    <div *ngIf="status()?.ownerPrerequisites?.ready === false" class="alert alert-warning" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>Ceph 제어 준비 미완료:</strong> {{ status()?.ownerPrerequisites?.blockers?.join(' · ') }}
      </span></div></div>
    </div>

    <section class="dependency" *ngIf="status() as s">
      <div class="dependency-title">
        <span class="sequence">1</span>
        <img class="dependency-logo" [src]="kubernetesLogo" alt="Kubernetes" width="34" height="34" />
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
        <img class="dependency-logo" [src]="cephLogo" alt="Ceph" width="34" height="34" />
        <div><strong>Ceph External 연결</strong><span>Rook operator · external CephCluster · Ceph CSI</span></div>
        <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-warning]="s.state === 'Degraded' || s.state === 'NotConfigured'" [class.label-danger]="s.state === 'Blocked'">{{ s.state }}</span>
      </div>
      <p class="status-message">{{ s.message }}</p>
    </section>

    <div class="alert alert-info" role="note">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>보안 경계:</strong> 입력한 CephX key는 계획·감사 응답에 표시하지 않고 대상 Kubernetes Secret에만 기록합니다. 이 기능은 기존 Ceph pool에 연결할 뿐 외부 Ceph의 상태를 변경하거나 data를 생성·삭제하지 않습니다.
      </span></div></div>
    </div>

    <section class="readiness-board" *ngIf="status() as s">
      <div class="card-head">
        <div><h2>Kubernetes 연결 준비</h2><p>외부 Ceph 연결 리소스를 설치할 수 있는지 시스템이 이 Kubernetes 클러스터를 자동 점검합니다.</p></div>
        <span class="label" [class.label-success]="s.ownerPrerequisites?.ready" [class.label-warning]="!s.ownerPrerequisites?.ready"
          [class.label-info]="hasActivePrerequisiteRequest(s)">
          {{ s.ownerPrerequisites?.ready ? 'Consumer Ready' : prerequisiteBoardLabel(s) }}
        </span>
      </div>
      <div class="readiness-grid">
        <article class="readiness-panel">
          <h3>Consumer Kubernetes 실측</h3>
          <ul class="status-checks">
            <li>
              <span class="status-dot" [class.ready]="s.kubernetes.ready"></span>
              <span><strong>Kubernetes</strong><small>{{ s.kubernetes.readyNodes || 0 }}/{{ s.kubernetes.nodes || 0 }} nodes Ready</small></span>
              <a *ngIf="!s.kubernetes.ready" class="prereq-action" href="/p/cluster-manager">상태 점검</a>
            </li>
            <li>
              <span class="status-dot" [class.ready]="consumerNamespacesReady(s)"></span>
              <span><strong>전용 namespace</strong><small>rook-ceph · opensphere-ceph-imports</small></span>
              <button *ngIf="!consumerNamespacesReady(s)" class="prereq-action" type="button" (click)="openPrerequisiteInstall('runtime-owner')">{{ prerequisiteActionLabel(s, '일괄 설치 요청') }}</button>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.cephClusterCrdReady"></span>
              <span><strong>CephCluster CRD</strong><small>signed platform release가 사전 설치</small></span>
              <button *ngIf="!s.ownerPrerequisites?.cephClusterCrdReady" class="prereq-action" type="button" (click)="openPrerequisiteInstall('crd')">{{ prerequisiteActionLabel(s, 'CRD 설치 요청') }}</button>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.operatorReady"></span>
              <span><strong>Rook operator {{ providerGuide(s).rookVersion }}</strong><small>rook-ceph namespace에서 Ready</small></span>
              <button *ngIf="!s.ownerPrerequisites?.operatorReady" class="prereq-action" type="button" (click)="openPrerequisiteInstall('operator')">{{ prerequisiteActionLabel(s, 'Operator 설치 요청') }}</button>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.missingPermissions?.length === 0"></span>
              <span><strong>Cluster Manager RBAC</strong><small>{{ s.ownerPrerequisites?.missingPermissions?.length || 0 }}개 누락</small></span>
              <button *ngIf="(s.ownerPrerequisites?.missingPermissions?.length || 0) > 0" class="prereq-action" type="button" (click)="openPrerequisiteInstall('runtime-rbac')">{{ prerequisiteActionLabel(s, 'RBAC 적용 요청') }}</button>
            </li>
            <li>
              <span class="status-dot optional" [class.ready]="s.ownerPrerequisites?.snapshotApiReady"></span>
              <span><strong>VolumeSnapshot API</strong><small>선택 사항 · 없으면 snapshot class 생성을 생략</small></span>
              <a *ngIf="!s.ownerPrerequisites?.snapshotApiReady" class="prereq-action optional" href="/manage/state-changes">설치 검토</a>
            </li>
          </ul>
          <div *ngIf="s.ownerPrerequisites?.installationRequest as request" class="request-tracker"
            [class.request-tracker-active]="requestActive(request)"
            [class.request-tracker-complete]="request.phase === 'Completed'"
            [class.request-tracker-failed]="request.phase === 'Failed' || request.phase === 'NeedsAttention' || request.phase === 'Unavailable'">
            <div class="request-tracker-head">
              <div>
                <small>플랫폼 상태 변경 요청</small>
                <strong>{{ request.requestId || '요청 상태 확인 불가' }}</strong>
              </div>
              <span class="label" [class.label-info]="requestActive(request)" [class.label-success]="request.phase === 'Completed'"
                [class.label-danger]="request.phase === 'Failed' || request.phase === 'NeedsAttention'"
                [class.label-warning]="request.phase === 'Unavailable'">{{ prerequisitePhaseLabel(request) }}</span>
            </div>
            <p>{{ request.message || prerequisitePhaseMessage(request) }}</p>
            <dl *ngIf="request.trackingAvailable !== false">
              <dt>신청 시각</dt><dd>{{ request.requestedAt ? (request.requestedAt | date:'yyyy-MM-dd HH:mm:ss') : '확인 중' }}</dd>
              <dt>승인</dt><dd>{{ request.approvalCount || 0 }}건 · {{ request.pullRequest?.number ? 'PR #' + request.pullRequest.number : 'PR 준비 중' }}</dd>
              <dt>적용 상태</dt><dd>{{ request.reconcilerStatus || 'NotScheduled' }}<span *ngIf="request.attemptCount"> · 시도 {{ request.attemptCount }}회</span></dd>
            </dl>
            <div class="request-tracker-actions">
              <button class="btn btn-sm btn-outline" type="button" (click)="openPrerequisiteInstall(request.source || 'ceph-readiness')">상세 상태</button>
              <a class="btn btn-sm btn-primary" href="/manage/state-changes">변경 요청 열기</a>
            </div>
          </div>
          <div *ngIf="s.ownerPrerequisites?.ready === false" class="prereq-next">
            <p><strong>설치가 필요한가요?</strong> Rook·CRD·RBAC는 브라우저에서 임의 Helm 명령으로 설치하지 않고, 서명된 플랫폼 변경으로 요청·승인·적용합니다.</p>
            <div>
              <a class="btn btn-sm btn-outline" href="/manual?doc=help-center%2Fperspective-02-k8s-cluster-ceph">설치 가이드</a>
              <button class="btn btn-sm btn-primary" type="button" (click)="openPrerequisiteInstall('readiness')">{{ prerequisiteActionLabel(s, '이 페이지에서 설치 요청') }}</button>
              <button class="btn btn-sm btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">설치 후 다시 검사</button>
            </div>
          </div>
          <div *ngIf="s.ownerPrerequisites?.blockers?.length" class="blocker-list">
            <strong>현재 차단 사유</strong>
            <ul><li *ngFor="let blocker of s.ownerPrerequisites.blockers">{{ blocker }}</li></ul>
          </div>
        </article>

        <article class="readiness-panel">
          <h3>Ceph 접속 정보</h3>
          <ng-container *ngIf="s.connection as connection; else requiredConnectionInformation">
            <dl class="provider-info connection-values">
              <dt>Cluster ID (FSID) fingerprint</dt>
              <dd>
                <code>{{ connection.fsidFingerprint || '확인되지 않음' }}</code>
                <small class="value-note">Ceph 관리자가 제공한 FSID의 SHA-256 앞 16자리와 대조하십시오. 원문 FSID는 Console에 보관하지 않습니다.</small>
              </dd>
              <dt>MON endpoints</dt>
              <dd>
                <ul class="monitor-values" *ngIf="connection.monitors.length; else monitorsUnavailable">
                  <li *ngFor="let monitor of connection.monitors"><code>{{ monitor }}</code></li>
                </ul>
                <ng-template #monitorsUnavailable>확인되지 않음</ng-template>
              </dd>
              <dt>CephX userID</dt>
              <dd><code>{{ connection.userID || '확인되지 않음' }}</code></dd>
              <dt>RBD pool</dt>
              <dd><code>{{ connection.pool || '확인되지 않음' }}</code></dd>
            </dl>
            <p class="secret-boundary-note">User key는 Kubernetes Secret에만 저장되며 이 화면과 API 응답에는 표시하지 않습니다.</p>
          </ng-container>
          <ng-template #requiredConnectionInformation>
            <dl class="provider-info">
              <ng-container *ngFor="let item of providerGuide(s).requiredInformation">
                <dt>{{ item.label }} <span *ngIf="item.secret" class="label label-info">민감</span></dt>
                <dd>{{ item.description }}</dd>
              </ng-container>
            </dl>
            <p class="scope-note"><strong>입력하지 않는 정보:</strong> {{ providerGuide(s).unsupportedInputs.join(' · ') }}</p>
          </ng-template>
        </article>
      </div>

    </section>

    </ng-container>

    <section class="service-coverage" *ngIf="activeTab() === 'services' && status()?.connection && status()?.csi?.serviceCoverage as coverage">
      <div class="card-head service-coverage-head">
        <div>
          <p class="section-kicker">CSI SERVICE READINESS</p>
          <h2>Ceph 스토리지 서비스 준비도</h2>
          <p>드라이버·StorageClass 참조 구성과 실제 PVC 데이터 경로 검증을 분리해 표시합니다. 구성 완료만으로 실사용 검증 완료로 계산하지 않습니다.</p>
        </div>
      </div>

      <div *ngIf="coverage.needsConfiguration > 0" class="service-warning" role="alert">
        <strong>구성 보완 필요</strong>
        <span>설치된 서비스 {{ coverage.installed }}종 중 {{ coverage.needsConfiguration }}종은 Ceph 제공 정보 또는 Kubernetes 구성이 없어 아직 사용할 수 없습니다.</span>
      </div>

      <div class="service-grid">
        <article *ngFor="let service of coverage.services" class="service-card" [class.service-ready]="service.verified" [class.service-gap]="service.driverInstalled && !service.configured">
          <header class="storage-service-header">
            <div class="service-identity">
              <img [src]="cephLogo" alt="" width="30" height="30" />
              <div><h3>{{ service.name }}</h3><p>{{ service.description }}</p></div>
            </div>
            <span class="service-state" [class.ready]="service.verified" [class.gap]="service.driverInstalled && !service.configured">
              {{ serviceStateLabel(service) }}
            </span>
          </header>

          <ol class="service-checkpoints" aria-label="서비스 준비 단계">
            <li [class.complete]="service.driverInstalled"><span>1</span><strong>CSI 드라이버</strong><small>{{ service.driverInstalled ? '설치됨' : '미설치' }}</small></li>
            <li [class.complete]="service.configured"><span>2</span><strong>StorageClass</strong><small>{{ service.configured ? '구성됨' : '미구성' }}</small></li>
            <li [class.complete]="service.verified"><span>3</span><strong>데이터 경로 검증</strong><small>{{ service.verified ? '검증 기록 있음' : '미검증' }}</small></li>
          </ol>

          <div *ngIf="service.storageClasses.length" class="service-class-list">
            <div *ngFor="let storage of service.storageClasses">
              <strong>StorageClass/{{ storage.name }}</strong>
              <span>{{ storage.filesystem ? 'filesystem ' + storage.filesystem + ' · ' : '' }}pool {{ storage.pool || '미입력' }} · {{ storage.reclaimPolicy || '정책 미확인' }}</span>
            </div>
          </div>

          <div *ngIf="service.blockers.length" class="service-blockers">
            <strong>현재 부족한 구성</strong>
            <ul><li *ngFor="let blocker of service.blockers">{{ blocker }}</li></ul>
          </div>

          <section *ngIf="service.driverInstalled && !service.configured" class="provider-request">
            <div class="provider-request-head">
              <div>
                <strong>Ceph 관리자에게 요청할 정보 <span class="requirement-count">{{ service.providerRequirements.length }}개</span></strong>
                <span>필요한 값과 최소 권한 조건을 한 번에 전달할 수 있습니다.</span>
              </div>
              <button class="btn btn-sm btn-outline" type="button" (click)="copyProviderRequest(service)">요청 문구 복사</button>
            </div>
            <details class="provider-request-details">
              <summary>요청 정보와 권한 조건 보기</summary>
              <dl>
                <ng-container *ngFor="let item of service.providerRequirements">
                  <dt>{{ item.label }} <span *ngIf="item.secret" class="sensitive">Secret</span></dt>
                  <dd>{{ item.description }}</dd>
                </ng-container>
              </dl>
              <div class="provider-contract" *ngIf="service.id === 'cephfs'">
                <strong>권한 조건</strong>
                <span><code>client.admin</code>은 사용하지 않습니다. Provisioner는 CephFS subvolume 관리, Node 계정은 해당 filesystem mount에 필요한 최소 CephX caps만 가져야 합니다.</span>
                <span>MDS 상태는 관리자가 서약하는 값이 아니라 연결 후 시스템이 관측합니다.</span>
              </div>
            </details>
            <div class="service-actions">
              <button *ngIf="service.id === 'cephfs'" class="btn btn-primary" type="button" [disabled]="busy()" (click)="openCephFsConfiguration()">CephFS 구성 추가</button>
              <button class="btn btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">정보 반영 후 다시 검사</button>
            </div>
          </section>

          <p class="service-next"><strong>다음 조치:</strong> {{ service.nextAction }}</p>
        </article>
      </div>
      <p class="verification-note"><strong>판정 범위:</strong> CSI 드라이버 등록, StorageClass 필수 값과 참조 Secret을 확인합니다. 실제 읽기·쓰기 mount 검증은 테스트 PVC 또는 업무 PVC를 생성한 시점에 별도 이력으로 남겨야 합니다.</p>
    </section>

    <section class="empty-state" *ngIf="activeTab() === 'services' && !status()?.connection">
      <h2>Ceph 연결 후 서비스 준비도를 확인할 수 있습니다</h2>
      <p>Ceph 연결이 완료되면 설치된 RBD·CephFS 드라이버와 StorageClass, 참조 Secret을 서비스별로 판정합니다.</p>
      <button class="btn btn-primary" type="button" [disabled]="status()?.kubernetes?.ready !== true || status()?.ownerPrerequisites?.ready !== true || busy()" (click)="selectTab('connection')">연결 및 설정으로 이동</button>
    </section>

    <ng-container *ngIf="activeTab() === 'connection'">
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
          <p>Kubernetes가 Ready인 경우 Cluster ID, Monitor, User ID·key, RBD pool을 입력해 연결할 수 있습니다.</p>
          <button class="btn btn-primary" type="button" [disabled]="!s.kubernetes.ready || s.ownerPrerequisites?.ready !== true || busy()" (click)="openConnect()">연결 Wizard 시작</button>
        </section>
      </ng-template>
    </ng-container>
    </ng-container>
    </ng-container>

    <ng-container *ngIf="activeTab() === 'insights'">
      @defer (when activeTab() === 'insights') {
        <app-ceph-insights
          [insights]="insights()"
          [loading]="insightsLoading()"
          [error]="insightsError()"
          (refresh)="loadInsights(true)">
        </app-ceph-insights>
      } @placeholder {
        <section class="insights-placeholder" role="status">클러스터 현황 화면을 준비하고 있습니다.</section>
      }
    </ng-container>

    <clr-modal [(clrModalOpen)]="prerequisiteOpen" [clrModalClosable]="!busy()" [clrModalSize]="'xl'">
      <h3 class="modal-title">Rook 선행요소 설치 요청</h3>
      <div class="modal-body">
        <div class="alert alert-info" role="note">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            이 버튼은 브라우저에서 임의 Helm 명령을 실행하지 않습니다. 서명된 <strong>Rook v1.20.2</strong> 설치 PR을 생성하고,
            다른 운영자의 MFA 승인 후 자동 설치·Ready 검증을 수행합니다.
          </span></div></div>
        </div>
        <h4>한 번에 설치되는 Consumer 구성</h4>
        <ul class="install-scope">
          <li><code>rook-ceph</code>·<code>opensphere-ceph-imports</code> namespace</li>
          <li>CephCluster CRD와 Rook operator/CSI</li>
          <li>Cluster Manager 전용 최소 권한 RBAC</li>
          <li>CRD Established·operator Ready 검증 및 변경 영수증</li>
          <li class="scope-elevated">
            <strong>모든 워커 노드</strong>에 호스트 권한 DaemonSet(<code>opensphere-ceph-nbd-preparer</code>) 배치 —
            <code>nbd</code> 커널 모듈 적재(<code>SYS_MODULE</code>)와 호스트 <code>/dev</code>에
            <code>/dev/nbdN</code> 디바이스 노드 생성(<code>MKNOD</code>) 권한이 필요합니다.
            RBD 볼륨을 <code>rbd-nbd</code>로 mount하기 위한 노드 선행요소이며 control-plane 노드에는 배치하지 않습니다.
          </li>
        </ul>
        <p class="scope-note"><strong>설치하지 않는 것:</strong> 외부 Ceph cluster, pool, CephFS, MDS, CephX 사용자는 변경하지 않습니다.</p>
        <label class="scope-consent">
          <input type="checkbox" [(ngModel)]="elevatedScopeAcknowledged" name="elevatedScopeAcknowledged" />
          <span>위 <strong>호스트 권한 DaemonSet</strong>이 모든 워커 노드에 배치된다는 점을 확인했습니다.</span>
        </label>
        <div *ngIf="prerequisiteError()" class="alert alert-danger" role="alert">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            <strong>설치 요청 실패:</strong> {{ prerequisiteError() }}
          </span></div></div>
        </div>
        <form *ngIf="!prerequisiteRequest()" class="prerequisite-form" clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>설치 사유</label>
            <textarea clrTextarea name="prerequisiteReason" [(ngModel)]="prerequisiteReason" required minlength="8" maxlength="500"
              placeholder="외부 Ceph 연결 목적과 대상 환경을 8자 이상 입력"></textarea>
            <clr-control-helper>감사 기록과 Gitea PR에 남는 운영 사유입니다.</clr-control-helper>
          </clr-textarea-container>
        </form>
        <div *ngIf="prerequisiteRequest() as request" class="modal-request-status"
          [class.request-tracker-active]="requestActive(request)"
          [class.request-tracker-complete]="request.phase === 'Completed'"
          [class.request-tracker-failed]="request.phase === 'Failed' || request.phase === 'NeedsAttention' || request.phase === 'Unavailable'"
          role="status">
          <div class="request-tracker-head">
            <div><small>설치 요청 상태</small><strong>{{ request.requestId || '조회 불가' }}</strong></div>
            <span class="label" [class.label-info]="requestActive(request)" [class.label-success]="request.phase === 'Completed'"
              [class.label-danger]="request.phase === 'Failed' || request.phase === 'NeedsAttention'"
              [class.label-warning]="request.phase === 'Unavailable'">{{ prerequisitePhaseLabel(request) }}</span>
          </div>
          <p>{{ request.message || prerequisitePhaseMessage(request) }}</p>
          <dl *ngIf="request.trackingAvailable !== false">
            <dt>신청 시각</dt><dd>{{ request.requestedAt ? (request.requestedAt | date:'yyyy-MM-dd HH:mm:ss') : '방금 접수됨' }}</dd>
            <dt>현재 단계</dt><dd>{{ request.status || 'authorized' }} · {{ request.reconcilerStatus || 'NotScheduled' }}</dd>
            <dt>승인</dt><dd>{{ request.approvalCount || 0 }}건<span *ngIf="request.pullRequest?.number"> · PR #{{ request.pullRequest.number }}</span></dd>
            <dt *ngIf="request.reason">신청 사유</dt><dd *ngIf="request.reason">{{ request.reason }}</dd>
          </dl>
          <p *ngIf="request.lastError" class="request-error"><strong>최근 오류:</strong> {{ request.lastError }}</p>
        </div>
        <div *ngIf="prerequisiteRequest() as request" class="alert alert-info" role="status">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            이 화면은 10초마다 변경 체인의 실제 상태를 다시 조회합니다. 준비상태는 설치 완료 후 Kubernetes 실측 결과로만 Ready가 됩니다.
          </span></div></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="prerequisiteOpen = false">닫기</button>
        <a *ngIf="prerequisiteRequest()" class="btn btn-primary" href="/manage/state-changes">승인 현황 보기</a>
        <button *ngIf="canRetryPrerequisiteRequest(prerequisiteRequest())" class="btn btn-outline" type="button"
          [disabled]="busy()" (click)="startNewPrerequisiteRequest()">새 설치 요청 작성</button>
        <button *ngIf="!prerequisiteRequest()" class="btn btn-primary" type="button"
          [disabled]="busy() || prerequisiteReason.trim().length < 8 || !elevatedScopeAcknowledged" (click)="requestPrerequisiteInstall()">설치 요청 생성</button>
      </div>
    </clr-modal>

    <clr-modal [clrModalOpen]="connectOpen" (clrModalOpenChange)="setConnectOpen($event)" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">외부 Ceph 연결 Wizard</h3>
      <div class="modal-body">
        <ol class="wizard-progress" aria-label="연결 단계">
          <li [class.active]="step() >= 1">Kubernetes 준비</li>
          <li [class.active]="step() >= 2">Ceph 접속 정보</li>
          <li [class.active]="step() >= 3">연결 계획</li>
        </ol>
        <div *ngIf="connectError()" class="alert alert-danger wizard-feedback" role="alert" aria-live="assertive">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            <strong>{{ connectErrorTitle() }}</strong><br>{{ connectError() }}
          </span></div></div>
        </div>
        <div *ngIf="connectNotice()" class="alert alert-success wizard-feedback" role="status" aria-live="polite">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            <strong>{{ connectNoticeTitle() }}</strong><br>{{ connectNotice() }}
          </span></div></div>
        </div>

        <section *ngIf="step() === 1 && !connectCompleted()" class="wizard-step">
          <h4>1. Kubernetes 연결 준비</h4>
          <p>Ceph 연결에 필요한 Kubernetes node, namespace, Rook operator·CRD, runtime 권한을 시스템이 자동으로 점검했습니다. 외부 Ceph의 health나 운영 상태는 이 Wizard에서 관리자에게 확인하지 않습니다.</p>
          <dl *ngIf="status() as s" class="connection-meta">
            <dt>Cluster fingerprint</dt><dd>{{ s.kubernetes.id }}</dd>
            <dt>Version</dt><dd>{{ s.kubernetes.version }}</dd>
            <dt>Nodes</dt><dd>{{ s.kubernetes.readyNodes }}/{{ s.kubernetes.nodes }} Ready</dd>
          </dl>
          <div class="alert alert-danger" *ngIf="status()?.kubernetes?.ready !== true">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">Kubernetes가 Ready가 아니므로 Ceph 연결을 진행할 수 없습니다.</span></div></div>
          </div>
          <div class="alert alert-danger" *ngIf="status()?.ownerPrerequisites?.ready !== true">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">Rook namespace·CRD·operator·runtime RBAC가 준비되지 않아 연결을 진행할 수 없습니다.</span></div></div>
          </div>
          <div class="automatic-check">
            <strong>자동 점검 범위</strong>
            <span>이 클러스터가 외부 Ceph 연결 리소스를 안전하게 설치할 수 있는지만 확인합니다. 준비 완료 시 별도의 운영자 체크 없이 다음 단계로 이동할 수 있습니다.</span>
          </div>
        </section>

        <section *ngIf="step() === 2 && !connectCompleted()" class="wizard-step">
          <h4>2. Ceph 접속 정보 입력</h4>
          <p>Ceph에서 준비한 접속 값만 입력하십시오. 서버가 UUID, MON 주소·포트, CephX 사용자 표기, pool과 StorageClass 이름의 형식을 확인하고 Kubernetes 리소스로 변환합니다.</p>
          <form clrForm clrLayout="vertical" class="connection-form">
            <clr-input-container class="wide-field">
              <label>Cluster ID (FSID)</label>
              <input clrInput name="clusterID" [(ngModel)]="clusterID" required autocomplete="off" spellcheck="false" placeholder="12345678-1234-4234-9234-123456789abc">
              <clr-control-helper>Ceph 클러스터의 UUID입니다.</clr-control-helper>
            </clr-input-container>
            <clr-textarea-container class="monitor-input wide-field">
              <label>Monitor endpoints</label>
              <textarea clrTextarea name="monitors" [(ngModel)]="monitors" required autocomplete="off" spellcheck="false" placeholder="10.10.0.11:3300&#10;10.10.0.12:3300&#10;10.10.0.13:3300"></textarea>
              <clr-control-helper>MON public 주소를 줄바꿈 또는 쉼표로 구분합니다. 3300(msgr2) 또는 6789(msgr1)를 사용하십시오.</clr-control-helper>
            </clr-textarea-container>
            <div class="role-credentials wide-field">
              <h5>역할별 CephX 자격 증명</h5>
              <p class="role-note">
                최소권한을 위해 역할마다 <strong>분리된 CephX 계정</strong>이 필요합니다. 같은 계정이나 같은 key를 두 역할에 쓰면 거부됩니다.
                <code>opensphere-dev</code>와 <code>client.opensphere-dev</code> 표기를 모두 허용하며, Rook에는 정식 엔티티·ceph-csi에는 접두어 없는 userID로 저장합니다.
                key는 계획 화면이나 API 응답에 표시하지 않고 Kubernetes Secret에만 저장합니다.
              </p>
              <ng-container *ngFor="let role of connectionRoles">
                <div class="role-row">
                  <clr-input-container>
                    <label>{{ role.label }} 사용자</label>
                    <input clrInput [name]="role.id + 'UserID'" [(ngModel)]="roleUserID[role.id]" required
                      autocomplete="off" spellcheck="false" [placeholder]="role.placeholder">
                    <clr-control-helper>{{ role.caps }}</clr-control-helper>
                  </clr-input-container>
                  <clr-password-container>
                    <label>{{ role.label }} key</label>
                    <input clrPassword [name]="role.id + 'UserKey'" [(ngModel)]="roleUserKey[role.id]" required autocomplete="new-password">
                  </clr-password-container>
                </div>
              </ng-container>
              <div *ngIf="duplicateRoleCredential() as duplicate" class="alert alert-warning" role="alert">
                <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ duplicate }}</span></div></div>
              </div>
            </div>
            <clr-input-container>
              <label>RBD pool</label>
              <input clrInput name="pool" [(ngModel)]="pool" required autocomplete="off" spellcheck="false" placeholder="kubernetes-rbd">
            </clr-input-container>
            <clr-input-container>
              <label>StorageClass 이름</label>
              <input clrInput name="storageClassName" [(ngModel)]="storageClassName" required autocomplete="off" spellcheck="false" placeholder="ceph-rbd">
              <clr-control-helper>Kubernetes에서 PVC가 사용할 이름입니다. <code>ceph-rbd</code> 또는 <code>ceph-rbd-</code>로 시작해야 합니다.</clr-control-helper>
            </clr-input-container>
          </form>
          <div *ngIf="planLoading()" class="progress loop"><progress></progress></div>
        </section>

        <section *ngIf="step() === 3 && !connectCompleted() && plan() as p" class="wizard-step">
          <h4>3. 검증 결과 및 연결 계획</h4>
          <p>입력 형식과 대상별 사용자 표기 변환을 확인했습니다. 실제 CephX 인증과 pool 접근은 Kubernetes 연결 단계에서 확인됩니다.</p>
          <dl class="connection-meta">
            <dt>Cluster ID</dt><dd><code>{{ p.clusterID }}</code></dd>
            <dt>Monitor</dt><dd>{{ p.monitors.join(' · ') }}</dd>
            <dt>MON protocol</dt><dd>{{ (p.monitorProtocols || ['unknown']).join(' · ') }}</dd>
            <dt>Ceph 엔티티</dt><dd><code>{{ p.cephEntity }}</code> <span class="field-purpose">Rook operator용</span></dd>
            <dt>CSI userID</dt><dd><code>{{ p.csiUserID }}</code> <span class="field-purpose">ceph-csi Secret용</span></dd>
            <dt>Storage</dt><dd><span *ngFor="let storage of p.storage">{{ storage.name }} → {{ storage.pool }}{{ storage.filesystem ? ' / ' + storage.filesystem : '' }} · </span></dd>
            <dt>설치 위치</dt><dd>{{ p.namespace }} namespace</dd>
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

        <section *ngIf="connectCompleted() && plan() as p" class="wizard-step connection-complete">
          <h4>3. Kubernetes 연결 완료</h4>
          <p>외부 Ceph 연결 리소스 설치와 실제 Ready 검증을 완료했습니다. 이 결과는 모달을 닫기 전까지 유지됩니다.</p>
          <dl class="connection-meta">
            <dt>상태</dt><dd><span class="label label-success">{{ status()?.state || 'Ready' }}</span></dd>
            <dt>Cluster ID</dt><dd><code>{{ p.clusterID }}</code></dd>
            <dt>Storage</dt><dd><span *ngFor="let storage of p.storage">{{ storage.name }} → {{ storage.pool }} · </span></dd>
            <dt>설치 위치</dt><dd>{{ p.namespace }} namespace</dd>
          </dl>
        </section>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="setConnectOpen(false)">{{ connectCompleted() ? '닫기' : '취소' }}</button>
        <button *ngIf="!connectCompleted() && step() > 1" class="btn btn-outline" type="button" [disabled]="busy() || planLoading()" (click)="back()">이전</button>
        <button *ngIf="!connectCompleted() && step() === 1" class="btn btn-primary" type="button" [disabled]="status()?.kubernetes?.ready !== true || status()?.ownerPrerequisites?.ready !== true" (click)="goToConnectionInput()">다음</button>
        <button *ngIf="!connectCompleted() && step() === 2" class="btn btn-primary" type="button" [disabled]="!connectionInputComplete() || !!duplicateRoleCredential() || planLoading()" (click)="validatePlan()">입력 확인 및 계획 생성</button>
        <button *ngIf="!connectCompleted() && step() === 3" class="btn btn-primary" type="button" [disabled]="busy() || connectReason.trim().length < 8" (click)="connect()">Kubernetes에 연결</button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="cephFsOpen" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">CephFS 공유 파일 스토리지 구성</h3>
      <div class="modal-body">
        <div class="alert alert-info" role="note">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">
            외부 Ceph에서 전달받은 filesystem·data pool과 제한된 CephX 계정을 입력합니다. Secret 값은 Kubernetes Secret에만 저장되며 화면·감사 기록에 남기지 않습니다.
          </span></div></div>
        </div>
        <div *ngIf="cephFsError()" class="alert alert-danger wizard-feedback" role="alert">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text"><strong>CephFS 구성 실패:</strong> {{ cephFsError() }}</span></div></div>
        </div>
        <div *ngIf="cephFsNotice()" class="alert alert-success wizard-feedback" role="status">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text"><strong>CephFS 구성 완료:</strong> {{ cephFsNotice() }}</span></div></div>
        </div>
        <form *ngIf="!cephFsCompleted()" clrForm clrLayout="vertical" class="connection-form cephfs-form">
          <clr-input-container>
            <label>CephFS filesystem 이름</label>
            <input clrInput name="cephFsFilesystem" [(ngModel)]="cephFsFilesystem" required autocomplete="off" spellcheck="false" placeholder="예: cephfs">
            <clr-control-helper><code>ceph fs ls</code>에 표시되는 이름</clr-control-helper>
          </clr-input-container>
          <clr-input-container>
            <label>CephFS data pool</label>
            <input clrInput name="cephFsPool" [(ngModel)]="cephFsPool" required autocomplete="off" spellcheck="false" placeholder="예: cephfs-data0">
            <clr-control-helper>CSI subvolume을 저장할 data pool</clr-control-helper>
          </clr-input-container>
          <clr-input-container>
            <label>Provisioner User ID</label>
            <input clrInput name="cephFsProvisionerUserID" [(ngModel)]="cephFsProvisionerUserID" required autocomplete="username" spellcheck="false" placeholder="client.csi-cephfs-provisioner">
            <clr-control-helper>subvolume 생성·삭제용 제한 계정</clr-control-helper>
          </clr-input-container>
          <clr-password-container>
            <label>Provisioner User key</label>
            <input clrPassword name="cephFsProvisionerUserKey" [(ngModel)]="cephFsProvisionerUserKey" required autocomplete="new-password">
            <clr-control-helper>Kubernetes Secret에만 저장</clr-control-helper>
          </clr-password-container>
          <clr-input-container>
            <label>Node User ID</label>
            <input clrInput name="cephFsNodeUserID" [(ngModel)]="cephFsNodeUserID" required autocomplete="username" spellcheck="false" placeholder="client.csi-cephfs-node">
            <clr-control-helper>Kubernetes node의 mount용 제한 계정</clr-control-helper>
          </clr-input-container>
          <clr-password-container>
            <label>Node User key</label>
            <input clrPassword name="cephFsNodeUserKey" [(ngModel)]="cephFsNodeUserKey" required autocomplete="new-password">
            <clr-control-helper>Kubernetes Secret에만 저장</clr-control-helper>
          </clr-password-container>
          <clr-input-container>
            <label>StorageClass 이름</label>
            <input clrInput name="cephFsStorageClassName" [(ngModel)]="cephFsStorageClassName" required autocomplete="off" spellcheck="false" placeholder="cephfs">
            <clr-control-helper>PVC에서 선택할 이름. <code>cephfs</code> 또는 <code>cephfs-</code>로 시작해야 합니다(예: <code>cephfs-shared</code>).</clr-control-helper>
          </clr-input-container>
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="cephFsReason" [(ngModel)]="cephFsReason" required minlength="8" maxlength="500" placeholder="CephFS 구성 목적과 승인 근거(8자 이상)"></textarea>
          </clr-textarea-container>
        </form>
        <div *ngIf="cephFsCompleted()" class="connection-complete">
          <p>CephFS CSI Secret과 StorageClass를 생성하고 서비스 준비도를 다시 확인했습니다.</p>
          <dl class="connection-meta">
            <dt>Filesystem</dt><dd>{{ cephFsFilesystem }}</dd>
            <dt>Data pool</dt><dd>{{ cephFsPool }}</dd>
            <dt>StorageClass</dt><dd>{{ cephFsStorageClassName }}</dd>
            <dt>자격 증명</dt><dd>Secret 2개 저장 · 값 비노출</dd>
          </dl>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="closeCephFsConfiguration()">닫기</button>
        <button *ngIf="!cephFsCompleted()" class="btn btn-primary" type="button" [disabled]="busy() || !cephFsInputComplete() || cephFsReason.trim().length < 8" (click)="configureCephFs()">CephFS 구성 적용</button>
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
            <input clrInput name="disconnectConfirm" [(ngModel)]="disconnectConfirm" autocomplete="off" placeholder="disconnect Ceph external storage">
            <clr-control-helper>disconnect Ceph external storage를 정확히 입력하십시오.</clr-control-helper>
          </clr-input-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="disconnectOpen = false">취소</button>
        <button class="btn btn-danger" type="button" [disabled]="busy() || disconnectReason.trim().length < 8 || disconnectConfirm !== 'disconnect Ceph external storage'" (click)="disconnect()">안전하게 연결 해제</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host {
      display: block;
      --ceph-body-font-size: 0.72rem;
    }
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
    .cm-ceph-title { display: flex; align-items: center; gap: 0.7rem; }
    .cm-ceph-title__logo { display: grid; width: 3rem; height: 3rem; flex: 0 0 3rem; place-items: center; border: 1px solid #d7e1e7; border-radius: 50%; background: #fff; box-shadow: 0 0.2rem 0.7rem rgb(31 95 141 / 12%); }
    .cm-ceph-title__logo img { display: block; max-width: 2.25rem; max-height: 2.25rem; object-fit: contain; }
    .cm-ceph-page-head h1 { margin: 0.15rem 0 0.35rem; color: #2d4048; font-size: 1.45rem; font-weight: 400; line-height: 1.25; }
    .cm-ceph-summary { margin: 0; max-width: 63rem; color: #565656; font-size: var(--ceph-body-font-size); line-height: 1.5; }
    .cm-ceph-eyebrow { margin: 0; color: #4c6fff; font-size: 0.65rem; font-weight: 600; line-height: 1.5; letter-spacing: 0.06em; text-transform: uppercase; }
    .cm-ceph-page-head__actions { display: flex; gap: 0.35rem; flex: 0 0 auto; }
    .cm-ceph-tabs { display: flex; gap: 0; margin: 0 0 0.9rem; border-bottom: 1px solid #b8c4ca; }
    .cm-ceph-tabs button { display: inline-flex; min-height: 2.45rem; align-items: center; gap: 0.45rem; padding: 0 0.85rem; border: 0; border-bottom: 3px solid transparent; background: transparent; color: #51636d; font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer; }
    .cm-ceph-tabs button:hover { background: #edf3f6; color: #17242b; }
    .cm-ceph-tabs button.active { border-bottom-color: #2f62ff; background: #f3f7ff; color: #1642b8; }
    .cm-ceph-tabs button:focus-visible { outline: 3px solid #2f62ff; outline-offset: 2px; }
    .tab-status { padding: 0.08rem 0.4rem; border-radius: 0.8rem; background: #dff0d4; color: #266900; font-size: 0.58rem; }
    .tab-status.warn { background: #fff0c2; color: #6b4d00; }
    .insights-placeholder { display: grid; min-height: 16rem; place-items: center; border: 1px dashed #9babb4; background: #f4f7f8; color: #51636d; }
    .dependency, .connection-card, .empty-state, .readiness-board, .service-coverage {
      border: 1px solid #d8d8d8;
      background: #fff;
      padding: 0.85rem 1rem;
      margin-bottom: 0.8rem;
      font-size: var(--ceph-body-font-size);
    }
    .dependency-title { display: grid; grid-template-columns: 1.6rem 2.1rem minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; }
    .dependency-logo { display: block; width: 1.8rem; height: 1.8rem; object-fit: contain; }
    .dependency-title > div { display: flex; flex-direction: column; gap: 0.12rem; }
    .dependency-title span:not(.label):not(.sequence) { color: #6f6f6f; font-size: 0.66rem; }
    .sequence { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; background: #4c6fff; color: #fff; font-weight: 600; }
    .dependency dl, .connection-meta { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: 0.35rem 0.8rem; margin: 0.7rem 0; }
    dt { font-weight: 600; color: #3a4d55; }
    dd { margin: 0; min-width: 0; word-break: break-word; }
    .field-purpose { margin-left: 0.35rem; color: #5f6b72; font-size: 0.64rem; }
    .connector { width: 2px; height: 1.1rem; margin: 0.15rem 0 0.15rem 0.68rem; background: #9a9a9a; }
    .status-message { margin: 0.55rem 0 0 2.2rem; color: #565656; }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .card-head h2, .empty-state h2 { margin: 0; font-size: 1rem; }
    .card-head p { margin: 0.15rem 0 0; color: #6f6f6f; }
    .empty-state { text-align: center; padding: 2rem; }
    .empty-state p { color: #6f6f6f; }
    .readiness-board h2 { margin: 0; font-size: 1rem; }
    .readiness-board h3 { margin: 0 0 0.65rem; font-size: 0.8rem; color: #2d4048; }
    .readiness-grid { display: grid; grid-template-columns: minmax(18rem, 0.9fr) minmax(24rem, 1.1fr); gap: 0.8rem; margin-top: 0.85rem; }
    .readiness-panel, .provider-preparation { border: 1px solid #e3e6e8; padding: 0.8rem; background: #fafbfc; }
    .status-checks { display: grid; gap: 0.45rem; margin: 0; padding: 0; list-style: none; }
    .status-checks li { display: grid; grid-template-columns: 0.7rem minmax(0, 1fr) auto; gap: 0.5rem; align-items: start; }
    .status-checks li > span:nth-child(2) { display: flex; flex-direction: column; gap: 0.08rem; }
    .status-checks small { color: #6f6f6f; }
    .status-dot { width: 0.55rem; height: 0.55rem; margin-top: 0.25rem; border-radius: 50%; background: #c92100; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #c92100; }
    .status-dot.ready { background: #318700; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #318700; }
    .status-dot.optional:not(.ready) { background: #f0a228; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #f0a228; }
    .prereq-action { padding: 0; border: 0; background: transparent; color: #0065ab; cursor: pointer; font: inherit; font-size: 0.62rem; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .prereq-action:hover { text-decoration: underline; }
    .prereq-action.optional { color: #805a00; }
    .prereq-next { margin-top: 0.75rem; padding: 0.65rem; border: 1px solid #b8d8f0; background: #eef7fc; }
    .prereq-next p { margin: 0 0 0.55rem; color: #3a4d55; line-height: 1.45; }
    .prereq-next > div { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .prereq-next .btn { margin: 0; }
    .request-tracker, .modal-request-status { margin-top: 0.75rem; padding: 0.7rem; border: 1px solid #8ab4f8; border-left: 4px solid #0f62fe; background: #edf5ff; }
    .request-tracker-complete { border-color: #69a03a; border-left-color: #318700; background: #f1f8e9; }
    .request-tracker-failed { border-color: #e09b8e; border-left-color: #c92100; background: #fff3f0; }
    .request-tracker-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; }
    .request-tracker-head > div { display: flex; min-width: 0; flex-direction: column; gap: 0.12rem; }
    .request-tracker-head small { color: #565656; }
    .request-tracker-head strong { word-break: break-all; }
    .request-tracker p, .modal-request-status p { margin: 0.5rem 0; line-height: 1.45; }
    .request-tracker dl, .modal-request-status dl { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 0.25rem 0.6rem; margin: 0.5rem 0; }
    .request-tracker-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.55rem; }
    .request-tracker-actions .btn { margin: 0; }
    .request-error { color: #8a1f11; }
    .provider-info { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: 0.4rem 0.7rem; margin: 0; }
    .provider-info dt { font-size: 0.68rem; }
    .provider-info dd { color: #565656; }
    .provider-info .label { margin-left: 0.25rem; vertical-align: middle; }
    .connection-values code { color: #1b2a32; font-family: Consolas, "SFMono-Regular", monospace; font-size: 0.68rem; }
    .monitor-values { display: grid; gap: 0.22rem; margin: 0; padding: 0; list-style: none; }
    .secret-boundary-note { margin: 0.75rem 0 0; padding: 0.55rem 0.65rem; border-left: 3px solid #0f62fe; background: #edf5ff; color: #37474f; line-height: 1.45; }
    .scope-note { margin: 0.75rem 0 0; padding-top: 0.6rem; border-top: 1px solid #e3e6e8; color: #565656; }
    .blocker-list { margin-top: 0.75rem; padding: 0.55rem; background: #fff3f0; color: #8a1f11; }
    .blocker-list ul { margin: 0.3rem 0 0 1rem; padding: 0; }
    .provider-preparation { margin-top: 0.8rem; }
    .preparation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
    .preparation-grid > div { display: flex; flex-direction: column; gap: 0.12rem; padding-left: 0.65rem; border-left: 3px solid #4c6fff; }
    .preparation-grid span { color: #565656; }
    .network-contract { display: flex; flex-wrap: wrap; gap: 0.35rem 0.7rem; margin-top: 0.75rem; padding: 0.55rem 0.65rem; background: #eaf4ff; }
    .service-coverage-head { align-items: center; }
    .service-coverage-head h2 { margin: 0; color: #1b2a32; font-size: 1.05rem; }
    .service-coverage-head p:not(.section-kicker) { margin: 0.18rem 0 0; max-width: 55rem; color: #565656; line-height: 1.45; }
    .section-kicker { margin: 0 0 0.15rem; color: #0f62fe; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; }
    .service-warning { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.65rem; margin-top: 0.8rem; padding: 0.6rem 0.7rem; border-left: 3px solid #f1c21b; background: #fffdf5; color: #4f3b00; }
    .service-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; gap: 0; margin-top: 0.8rem; border: 1px solid #c9d2d8; }
    .service-card { min-width: 0; padding: 0.9rem; border: 0; background: #fff; }
    .service-card + .service-card { border-left: 1px solid #c9d2d8; }
    .storage-service-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; padding: 0; background: #fff; color: #1b2a32; }
    .service-identity { display: grid; min-width: 0; grid-template-columns: 2rem minmax(0, 1fr); gap: 0.55rem; align-items: center; }
    .service-identity img { display: block; width: 1.75rem; height: 1.75rem; object-fit: contain; }
    .service-identity h3 { margin: 0; color: #1b2a32; font-size: 0.86rem; }
    .service-identity p { margin: 0.16rem 0 0; color: #565656; line-height: 1.4; }
    .service-state { flex: 0 0 auto; padding: 0.15rem 0.45rem; border-radius: 0.8rem; background: #e5e8ea; color: #3a4d55; font-size: 0.68rem; font-weight: 700; }
    .service-state.ready { background: #dff0d4; color: #266900; }
    .service-state.gap { background: #fff0c2; color: #6b4d00; }
    .service-checkpoints { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0.8rem 0 0; padding: 0.45rem 0; border-top: 1px solid #e3e6e8; border-bottom: 1px solid #e3e6e8; list-style: none; }
    .service-checkpoints li { display: grid; grid-template-columns: 1.2rem minmax(0, 1fr); gap: 0.04rem 0.35rem; padding: 0.18rem 0.55rem; background: transparent; }
    .service-checkpoints li + li { border-left: 1px solid #e3e6e8; }
    .service-checkpoints li > span { display: grid; grid-row: 1 / 3; width: 1.15rem; height: 1.15rem; place-items: center; border-radius: 50%; background: #8d9ba3; color: #fff; font-size: 0.68rem; }
    .service-checkpoints li.complete > span { background: #318700; }
    .service-checkpoints strong { font-size: 0.7rem; line-height: 1.2; }
    .service-checkpoints small { color: #6f6f6f; font-size: 0.68rem; }
    .service-class-list { display: grid; gap: 0.35rem; margin-top: 0.7rem; }
    .service-class-list > div { display: flex; flex-direction: column; gap: 0.12rem; padding: 0.45rem 0; border-bottom: 1px solid #e3e6e8; background: transparent; }
    .service-class-list span { color: #565656; }
    .service-blockers { margin-top: 0.7rem; padding: 0.5rem 0.6rem; border-left: 3px solid #f1c21b; background: #fffdf5; color: #4f3b00; }
    .service-blockers ul { margin: 0.3rem 0 0 1rem; padding: 0; }
    .provider-request { margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px solid #d8d8d8; background: transparent; }
    .provider-request-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem; }
    .provider-request-head > div { display: flex; flex-direction: column; gap: 0.08rem; }
    .provider-request-head span:not(.requirement-count) { color: #565656; }
    .provider-request-head .btn { flex: 0 0 auto; margin: 0; }
    .requirement-count { margin-left: 0.25rem; color: #565656; font-size: 0.68rem; font-weight: 500; }
    .provider-request-details { margin-top: 0.55rem; border-top: 1px solid #e3e6e8; }
    .provider-request-details summary { padding: 0.5rem 0; color: #0065ab; cursor: pointer; font-weight: 600; }
    .provider-request-details summary:focus-visible { outline: 2px solid #0f62fe; outline-offset: 2px; }
    .provider-request dl { display: grid; grid-template-columns: minmax(9rem, 0.7fr) minmax(0, 1.3fr); gap: 0.35rem 0.65rem; margin: 0.2rem 0 0; padding-top: 0.55rem; border-top: 1px solid #e3e6e8; }
    .provider-request dd { color: #3a4d55; }
    .sensitive { display: inline-block; margin-left: 0.2rem; padding: 0.04rem 0.28rem; border-radius: 0.5rem; background: #e5e8ea; color: #3a4d55; font-size: 0.68rem; }
    .provider-contract { display: grid; gap: 0.2rem; margin-top: 0.65rem; padding-top: 0.55rem; border-top: 1px solid #e3e6e8; background: transparent; color: #3a4d55; }
    .service-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.65rem; }
    .service-actions .btn { margin: 0; }
    .service-next { margin: 0.7rem 0 0; color: #3a4d55; }
    .verification-note { margin: 0.8rem 0 0; padding-top: 0.7rem; border-top: 1px solid #d8d8d8; color: #565656; line-height: 1.45; }
    .cephfs-form clr-textarea-container { grid-column: 1 / -1; }
    .command-block { display: grid; gap: 0.35rem; margin-top: 0.75rem; }
    .command-block span { color: #565656; }
    .command-block code { display: block; padding: 0.65rem; overflow-x: auto; background: #1b2a32; color: #eef5f7; white-space: nowrap; }
    .install-scope { display: grid; gap: 0.35rem; margin: 0.55rem 0 0.75rem; padding-left: 1.1rem; }
    .install-scope .scope-elevated {
      margin: 0.35rem 0 0.15rem; padding: 0.5rem 0.65rem; list-style-position: outside;
      background: #fdf3e6; border: 1px solid #e8bd7a; border-left: 3px solid #c47500; border-radius: 3px; color: #52401f;
    }
    .scope-consent { display: flex; align-items: flex-start; gap: 0.45rem; margin: 0.6rem 0 0; color: #313131; }
    .scope-consent input { margin-top: 0.2rem; }
    .value-note { display: block; margin-top: 0.15rem; color: #6b6b6b; font-size: 0.6875rem; line-height: 1rem; }
    .role-credentials { margin: 0.35rem 0 0; padding: 0.7rem 0.85rem; background: #fafafa; border: 1px solid #e3e6e8; border-radius: 3px; }
    .role-credentials h5 { margin: 0 0 0.25rem; font-size: 0.8125rem; font-weight: 600; color: #21313c; }
    .role-note { margin: 0 0 0.5rem; color: #565656; font-size: 0.6875rem; line-height: 1.05rem; }
    .role-row { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 0 0.9rem; align-items: start; }
    @media (max-width: 900px) { .role-row { grid-template-columns: minmax(0, 1fr); } }
    .prerequisite-form, .prerequisite-form clr-textarea-container, textarea[name='prerequisiteReason'] { display: block; width: 100%; }
    textarea[name='prerequisiteReason'] { min-height: 6rem; resize: vertical; }
    .automatic-check { display: grid; gap: 0.25rem; margin-top: 0.8rem; padding: 0.7rem 0.8rem; border-left: 4px solid #318700; background: #f1f8e9; color: #25421c; }
    .wizard-progress { display: grid; grid-template-columns: repeat(3, 1fr); padding: 0; margin: 0 0 1rem; list-style: none; counter-reset: step; }
    .wizard-progress li { padding: 0.45rem 0.5rem; border-bottom: 3px solid #d8d8d8; color: #6f6f6f; font-size: 0.68rem; }
    .wizard-progress li.active { border-color: #4c6fff; color: #1b2a32; font-weight: 600; }
    .wizard-feedback { margin: 0 0 0.8rem; }
    .wizard-step { font-size: var(--ceph-body-font-size); }
    .wizard-step h4 { margin-top: 0; }
    .connection-complete { min-height: 15rem; }
    .connection-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 1rem; align-items: start; }
    .connection-form > * { min-width: 0; width: 100%; }
    .connection-form .wide-field { grid-column: 1 / -1; }
    .connection-form input[clrInput], .connection-form input[clrPassword], .connection-form textarea[clrTextarea] { width: 100%; max-width: none; }
    :host ::ng-deep .connection-form .clr-form-control,
    :host ::ng-deep .connection-form .clr-control-container,
    :host ::ng-deep .connection-form .clr-input-wrapper,
    :host ::ng-deep .connection-form .clr-input-group,
    :host ::ng-deep .connection-form .clr-textarea-wrapper { width: 100%; max-width: none; }
    .monitor-input textarea { min-height: 6.5rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    textarea { min-height: 4.5rem; }
    .resource-list { max-height: 14rem; overflow: auto; border: 1px solid #d8d8d8; margin: 0.65rem 0; }
    .resource-list > div { display: grid; grid-template-columns: minmax(14rem, 1fr) minmax(8rem, 0.7fr); gap: 0.6rem; padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    code { font-size: 0.63rem; }
    @media (max-width: 62rem) {
      .cm-ceph-page-head, .card-head { flex-direction: column; }
      .readiness-grid, .preparation-grid, .connection-form, .service-grid { grid-template-columns: 1fr; }
      .service-card + .service-card { border-top: 1px solid #c9d2d8; border-left: 0; }
      .dependency dl, .connection-meta { grid-template-columns: 1fr; }
      .resource-list > div { grid-template-columns: 1fr; }
      .status-checks li { grid-template-columns: 0.7rem minmax(0, 1fr); }
      .prereq-action { grid-column: 2; justify-self: start; }
      .service-checkpoints { grid-template-columns: 1fr; }
      .service-checkpoints li + li { border-top: 1px solid #e3e6e8; border-left: 0; }
      .provider-request-head { flex-direction: column; }
      .provider-request dl { grid-template-columns: 1fr; }
      .service-warning { grid-template-columns: 1fr; }
    }
  `],
})
export class CephClustersComponent implements OnInit, OnDestroy {
  private ceph = inject(CephService);
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private insightsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private statusInFlight = false;
  private pollFailures = 0;
  private insightsPollFailures = 0;
  private readonly visibilityHandler = (): void => {
    if (document.hidden) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.insightsRefreshTimer) clearTimeout(this.insightsRefreshTimer);
      return;
    }
    this.load(true);
    this.scheduleInsightsPoll(2_000);
  };
  readonly cephLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@b20a671aa820dace36907acb7cf95b540c0c4f81/logos/ceph.svg';
  readonly kubernetesLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@95aeaf7781b9a5753762811521131c06df328c87/logos/kubernetes-2-icon.svg';
  readonly activeTab = signal<'connection' | 'insights' | 'services'>('connection');
  readonly status = signal<CephStatus | null>(null);
  readonly insights = signal<CephInsights | null>(null);
  readonly insightsLoading = signal(false);
  readonly insightsError = signal('');
  readonly plan = signal<CephPlan | null>(null);
  readonly loading = signal(false);
  readonly planLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly statusPollWarning = signal('');
  readonly connectError = signal('');
  readonly connectErrorTitle = signal('입력 값 확인 실패');
  readonly connectNotice = signal('');
  readonly connectNoticeTitle = signal('입력 형식 확인 완료');
  readonly connectCompleted = signal(false);
  readonly cephFsError = signal('');
  readonly cephFsNotice = signal('');
  readonly cephFsCompleted = signal(false);
  readonly step = signal(1);
  readonly prerequisiteRequest = signal<CephPrerequisiteRequest | null>(null);
  readonly prerequisiteError = signal('');
  prerequisiteOpen = false;
  connectOpen = false;
  cephFsOpen = false;
  disconnectOpen = false;
  prerequisiteReason = '';
  prerequisiteSource = '';
  /** 호스트 권한 DaemonSet 배치에 대한 명시적 동의. 설치 요청 생성의 선행 조건이다. */
  elevatedScopeAcknowledged = false;
  clusterID = '';
  monitors = '';
  /** 감사 H-02: RBD 경로도 CephFS처럼 역할별 CephX 계정을 분리해 받는다. */
  readonly connectionRoles: { id: 'operator' | 'provisioner' | 'node' | 'observer'; label: string; placeholder: string; caps: string }[] = [
    { id: 'operator', label: 'Rook health checker', placeholder: 'opensphere-healthchecker', caps: 'Rook v1.20 공식 external export로 생성합니다. MON quorum/version 및 MGR config 조회에 필요한 최소 command 권한만 사용합니다.' },
    { id: 'provisioner', label: 'RBD provisioner', placeholder: 'opensphere-rbd-provisioner', caps: 'Rook v1.20 restricted export로 생성합니다. MON profile rbd·osd blocklist, MGR allow rw와 대상 pool로 제한한 OSD profile rbd가 필요합니다.' },
    { id: 'node', label: 'RBD node', placeholder: 'opensphere-rbd-node', caps: 'Rook v1.20 restricted export로 생성합니다. MON profile rbd·osd blocklist와 대상 pool로 제한한 OSD profile rbd가 필요합니다.' },
    { id: 'observer', label: '읽기 전용 관측기', placeholder: 'opensphere-observer', caps: '화면에서 사용하는 고정 MON·MGR 조회 명령만 허용합니다. pool 제한 없는 osd allow r 권한은 발급하지 않습니다.' },
  ];
  roleUserID: Record<'operator' | 'provisioner' | 'node' | 'observer', string> = { operator: '', provisioner: '', node: '', observer: '' };
  roleUserKey: Record<'operator' | 'provisioner' | 'node' | 'observer', string> = { operator: '', provisioner: '', node: '', observer: '' };
  pool = '';
  storageClassName = 'ceph-rbd';
  cephFsFilesystem = '';
  cephFsPool = '';
  cephFsProvisionerUserID = '';
  cephFsProvisionerUserKey = '';
  cephFsNodeUserID = '';
  cephFsNodeUserKey = '';
  cephFsStorageClassName = 'cephfs';
  cephFsReason = '';
  connectReason = '';
  disconnectReason = '';
  disconnectConfirm = '';

  ngOnInit(): void {
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.load();
    this.scheduleInsightsPoll(60_000);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.insightsRefreshTimer) clearTimeout(this.insightsRefreshTimer);
  }

  load(silent = false): void {
    if (this.statusInFlight) return;
    this.statusInFlight = true;
    if (!silent) this.loading.set(true);
    this.error.set('');
    this.ceph.status().subscribe({
      next: (status) => {
        this.status.set(status);
        this.statusInFlight = false;
        this.pollFailures = 0;
        this.statusPollWarning.set(status.importCleanup?.consecutiveFailures
          ? status.importCleanup.lastError || '만료된 접속 정보 정리 상태를 확인해야 합니다.'
          : '');
        if (!status.connection) {
          this.insights.set(null);
          this.insightsError.set('');
        }
        if (status.ownerPrerequisites && Object.prototype.hasOwnProperty.call(status.ownerPrerequisites, 'installationRequest')) {
          this.prerequisiteRequest.set(status.ownerPrerequisites.installationRequest || null);
        }
        this.loading.set(false);
        this.scheduleStatusPoll(10_000);
      },
      error: (failure) => {
        this.statusInFlight = false;
        this.pollFailures += 1;
        if (!silent) this.error.set(this.message(failure));
        if (silent && this.pollFailures >= 2) {
          this.statusPollWarning.set(`상태 갱신이 ${this.pollFailures}회 연속 실패했습니다. 마지막 표시 값은 최신 상태가 아닐 수 있습니다.`);
        }
        this.loading.set(false);
        this.scheduleStatusPoll(Math.min(300_000, 10_000 * (2 ** Math.min(this.pollFailures, 5))));
      },
    });
  }

  private scheduleStatusPoll(delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (document.hidden) return;
    const jitter = Math.round(delay * (0.9 + Math.random() * 0.2));
    this.refreshTimer = setTimeout(() => {
      if (!this.busy()) this.load(true);
      else this.scheduleStatusPoll(5_000);
    }, jitter);
  }

  private scheduleInsightsPoll(delay: number): void {
    if (this.insightsRefreshTimer) clearTimeout(this.insightsRefreshTimer);
    if (document.hidden) return;
    const jitter = Math.round(delay * (0.9 + Math.random() * 0.2));
    this.insightsRefreshTimer = setTimeout(() => {
      if (this.activeTab() === 'insights' && this.status()?.connection && !this.insightsLoading()) this.loadInsights();
      else this.scheduleInsightsPoll(60_000);
    }, jitter);
  }

  selectTab(tab: 'connection' | 'insights' | 'services'): void {
    this.activeTab.set(tab);
    if (tab === 'insights' && this.status()?.connection && !this.insights() && !this.insightsLoading()) {
      this.loadInsights();
    }
  }

  loadInsights(refresh = false): void {
    if (!this.status()?.connection) {
      this.insights.set(null);
      this.insightsError.set('');
      return;
    }
    this.insightsLoading.set(true);
    this.insightsError.set('');
    this.ceph.insights(refresh).subscribe({
      next: (insights) => {
        this.insights.set(insights);
        this.insightsPollFailures = 0;
        this.insightsError.set('');
        this.insightsLoading.set(false);
        if (this.activeTab() === 'insights') this.scheduleInsightsPoll(60_000);
      },
      error: (failure) => {
        this.insightsPollFailures += 1;
        this.insightsError.set(this.insightsFailureMessage(failure));
        this.insightsLoading.set(false);
        if (this.activeTab() === 'insights') {
          this.scheduleInsightsPoll(Math.min(300_000, 15_000 * (2 ** Math.min(this.insightsPollFailures - 1, 4))));
        }
      },
    });
  }

  openConnect(): void {
    this.step.set(1);
    this.plan.set(null);
    this.clearConnectionInput();
    this.connectReason = '';
    this.clearConnectFeedback();
    this.connectCompleted.set(false);
    this.error.set('');
    this.connectOpen = true;
  }

  setConnectOpen(open: boolean): void {
    this.connectOpen = open;
    if (open) return;
    this.plan.set(null);
    this.step.set(1);
    this.connectReason = '';
    this.clearConnectionInput();
    this.clearConnectFeedback();
    this.connectCompleted.set(false);
  }

  openPrerequisiteInstall(source: string): void {
    this.prerequisiteSource = source;
    const tracked = this.status()?.ownerPrerequisites?.installationRequest;
    if (tracked) this.prerequisiteRequest.set(tracked);
    if (!this.prerequisiteRequest()) this.prerequisiteReason = '';
    this.elevatedScopeAcknowledged = false;
    this.prerequisiteError.set('');
    this.error.set('');
    this.prerequisiteOpen = true;
  }

  requestPrerequisiteInstall(): void {
    const reason = this.prerequisiteReason.trim();
    if (reason.length < 8) return;
    this.busy.set(true);
    this.prerequisiteError.set('');
    this.error.set('');
    this.ceph.requestPrerequisites(reason, this.prerequisiteSource || 'ceph-readiness').subscribe({
      next: (request) => {
        this.busy.set(false);
        this.prerequisiteError.set('');
        const tracked = this.normalizePrerequisiteRequest(request);
        this.prerequisiteRequest.set(tracked);
        this.status.update((current) => current?.ownerPrerequisites
          ? { ...current, ownerPrerequisites: { ...current.ownerPrerequisites, installationRequest: tracked } }
          : current);
        this.notice.set(request.duplicate
          ? `기존 Rook 설치 요청 ${request.requestId}을 사용합니다. 승인 현황을 확인하십시오.`
          : `Rook 선행요소 설치 요청 ${request.requestId}을 생성했습니다. 두 번째 운영자 승인 후 자동 설치됩니다.`);
      },
      error: (failure) => {
        this.busy.set(false);
        this.prerequisiteError.set(this.message(failure));
      },
    });
  }

  startNewPrerequisiteRequest(): void {
    this.prerequisiteRequest.set(null);
    this.prerequisiteReason = '';
    this.prerequisiteError.set('');
  }

  requestActive(request: CephPrerequisiteRequest | null | undefined): boolean {
    return ['Creating', 'AwaitingApproval', 'Queued', 'Applying'].includes(String(request?.phase || ''));
  }

  canRetryPrerequisiteRequest(request: CephPrerequisiteRequest | null | undefined): boolean {
    return ['Failed', 'NeedsAttention'].includes(String(request?.phase || ''));
  }

  hasActivePrerequisiteRequest(status: CephStatus): boolean {
    return this.requestActive(status.ownerPrerequisites?.installationRequest);
  }

  prerequisitePhaseLabel(request: CephPrerequisiteRequest | null | undefined): string {
    const labels: Record<string, string> = {
      Creating: '요청 생성 중',
      AwaitingApproval: '승인 대기',
      Queued: '적용 대기',
      Applying: '설치·검증 중',
      Completed: '적용 완료',
      Failed: '실패',
      NeedsAttention: '확인 필요',
      Unavailable: '상태 확인 불가',
    };
    return labels[String(request?.phase || '')] || '요청됨';
  }

  prerequisitePhaseMessage(request: CephPrerequisiteRequest | null | undefined): string {
    const messages: Record<string, string> = {
      Creating: '변경 요청과 서명된 상태 선언을 준비하고 있습니다.',
      AwaitingApproval: '요청이 접수되어 두 번째 운영자의 승인을 기다리고 있습니다.',
      Queued: '승인이 완료되어 전용 적용기의 작업 대기열에 있습니다.',
      Applying: 'Consumer Kubernetes에 선행요소를 설치하고 실측 검증하고 있습니다.',
      Completed: '설치와 검증이 완료되었습니다. 준비상태를 다시 검사하십시오.',
      Failed: '설치 또는 검증에 실패했습니다. 오류를 확인한 뒤 재요청할 수 있습니다.',
      NeedsAttention: '변경 결과 또는 선언과 실측 상태를 운영자가 확인해야 합니다.',
      Unavailable: '변경 체인에 연결할 수 없어 신청 상태를 확인할 수 없습니다. 중복 요청을 만들지 말고 변경 요청 화면을 확인하십시오.',
    };
    return messages[String(request?.phase || '')] || '변경 요청의 현재 상태를 조회하고 있습니다.';
  }

  prerequisiteBoardLabel(status: CephStatus): string {
    const request = status.ownerPrerequisites?.installationRequest;
    return request ? this.prerequisitePhaseLabel(request) : 'Consumer 준비 필요';
  }

  prerequisiteActionLabel(status: CephStatus, defaultLabel: string): string {
    const request = status.ownerPrerequisites?.installationRequest;
    if (!request) return defaultLabel;
    if (request.phase === 'Completed') return '적용 완료 · 다시 검사';
    if (request.phase === 'Failed' || request.phase === 'NeedsAttention') return '요청 실패 · 상세';
    if (request.phase === 'Unavailable') return '요청 상태 확인 불가';
    return `${this.prerequisitePhaseLabel(request)} · 상태 보기`;
  }

  private normalizePrerequisiteRequest(request: CephPrerequisiteRequest): CephPrerequisiteRequest {
    const phase = request.phase || (request.status === 'authorized' ? 'AwaitingApproval' : 'Creating');
    const normalized = { ...request, trackingAvailable: true, phase, requestedAt: request.requestedAt || new Date().toISOString() };
    return { ...normalized, message: normalized.message || this.prerequisitePhaseMessage(normalized) };
  }

  providerGuide(status: CephStatus | null): CephProviderGuide {
    return status?.providerGuide || CEPH_PROVIDER_GUIDE;
  }

  consumerNamespacesReady(status: CephStatus): boolean {
    return Boolean(status.ownerPrerequisites?.namespaces?.runtime && status.ownerPrerequisites.namespaces.imports);
  }

  serviceStateLabel(service: CephStorageService): string {
    if (service.verified) return '데이터 경로 검증됨';
    if (service.configured) return '구성 완료 · 미검증';
    if (service.driverInstalled) return '정보·구성 필요';
    return '미설치';
  }

  async copyProviderRequest(service: CephStorageService): Promise<void> {
    const requirements = service.providerRequirements
      .map((item) => `- ${item.label}: ${item.secret ? '[보안 채널로 전달]' : '[값 입력]'}\n  ${item.description}`)
      .join('\n');
    const text = [
      `[OpenSphere ${service.name} 구성 요청]`,
      '',
      '목적: Kubernetes CSI StorageClass 구성',
      `CSI 드라이버: ${service.driver}`,
      '',
      '회신이 필요한 정보',
      requirements,
      '',
      '보안·권한 조건',
      '- client.admin 계정은 전달하지 마십시오.',
      '- 대상 pool 또는 filesystem 범위의 최소 CephX 권한만 부여하십시오.',
      '- key는 승인된 보안 채널로만 전달하고 일반 메일·메신저 본문에는 남기지 마십시오.',
      '- Ceph health 또는 MDS 상태를 수동 확인 문구로 회신할 필요는 없습니다. 연결 후 시스템이 관측합니다.',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.notice.set(`${service.name} 구성 요청 문구를 복사했습니다.`);
    } catch {
      this.error.set('브라우저가 클립보드 복사를 허용하지 않았습니다. 화면의 요청 항목을 사용하십시오.');
    }
  }

  openCephFsConfiguration(): void {
    this.cephFsFilesystem = '';
    this.cephFsPool = '';
    this.cephFsProvisionerUserID = '';
    this.cephFsProvisionerUserKey = '';
    this.cephFsNodeUserID = '';
    this.cephFsNodeUserKey = '';
    this.cephFsStorageClassName = 'cephfs';
    this.cephFsReason = '';
    this.cephFsError.set('');
    this.cephFsNotice.set('');
    this.cephFsCompleted.set(false);
    this.cephFsOpen = true;
  }

  closeCephFsConfiguration(): void {
    this.cephFsProvisionerUserKey = '';
    this.cephFsNodeUserKey = '';
    this.cephFsOpen = false;
  }

  cephFsConfiguration(): CephFsConfigurationInput {
    return {
      filesystem: this.cephFsFilesystem.trim(),
      pool: this.cephFsPool.trim(),
      provisionerUserID: this.cephFsProvisionerUserID.trim(),
      provisionerUserKey: this.cephFsProvisionerUserKey.trim(),
      nodeUserID: this.cephFsNodeUserID.trim(),
      nodeUserKey: this.cephFsNodeUserKey.trim(),
      storageClassName: this.cephFsStorageClassName.trim(),
    };
  }

  cephFsInputComplete(): boolean {
    return Object.values(this.cephFsConfiguration()).every((value) => value.length > 0);
  }

  configureCephFs(): void {
    if (!this.cephFsInputComplete() || this.cephFsReason.trim().length < 8) return;
    this.busy.set(true);
    this.cephFsError.set('');
    this.cephFsNotice.set('');
    this.ceph.configureCephFs(this.cephFsConfiguration(), this.cephFsReason.trim()).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.cephFsProvisionerUserKey = '';
        this.cephFsNodeUserKey = '';
        this.status.set(result.status);
        this.cephFsCompleted.set(true);
        this.cephFsNotice.set('CephFS StorageClass와 제한 자격 증명이 구성되어 PVC 사용 준비 상태가 되었습니다.');
      },
      error: (failure) => {
        this.busy.set(false);
        this.cephFsProvisionerUserKey = '';
        this.cephFsNodeUserKey = '';
        this.cephFsError.set(`${this.message(failure)} 보안을 위해 CephFS key 입력값을 지웠습니다.`);
        this.load(true);
      },
    });
  }

  connectionInput(): CephConnectionInput {
    return {
      clusterID: this.clusterID.trim(),
      monitors: this.monitors.trim(),
      operatorUserID: this.roleUserID.operator.trim(),
      operatorUserKey: this.roleUserKey.operator.trim(),
      provisionerUserID: this.roleUserID.provisioner.trim(),
      provisionerUserKey: this.roleUserKey.provisioner.trim(),
      nodeUserID: this.roleUserID.node.trim(),
      nodeUserKey: this.roleUserKey.node.trim(),
      observerUserID: this.roleUserID.observer.trim(),
      observerUserKey: this.roleUserKey.observer.trim(),
      pool: this.pool.trim(),
      storageClassName: this.storageClassName.trim(),
    };
  }

  connectionInputComplete(): boolean {
    return Object.values(this.connectionInput()).every((value) => value.length > 0);
  }

  /** 역할 간 계정·key 재사용은 서버가 거부하므로 입력 단계에서 미리 알린다. */
  duplicateRoleCredential(): string {
    const ids = this.connectionRoles.map((role) => this.roleUserID[role.id].trim().replace(/^client\./, '')).filter(Boolean);
    const keys = this.connectionRoles.map((role) => this.roleUserKey[role.id].trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) return '두 역할이 동일한 CephX 사용자를 사용합니다. 역할별로 분리된 계정을 입력하십시오.';
    if (new Set(keys).size !== keys.length) return '두 역할이 동일한 CephX key를 사용합니다. 역할별로 분리된 계정을 입력하십시오.';
    return '';
  }

  private clearConnectionInput(): void {
    this.clusterID = '';
    this.monitors = '';
    for (const role of this.connectionRoles) {
      this.roleUserID[role.id] = '';
      this.roleUserKey[role.id] = '';
    }
    this.pool = '';
    this.storageClassName = 'ceph-rbd';
  }

  private clearConnectFeedback(): void {
    this.connectError.set('');
    this.connectNotice.set('');
  }

  goToConnectionInput(): void {
    this.clearConnectFeedback();
    this.step.set(2);
  }

  back(): void {
    if (this.step() === 3) this.plan.set(null);
    this.clearConnectFeedback();
    this.step.update((value) => Math.max(1, value - 1));
  }

  validatePlan(): void {
    this.planLoading.set(true);
    this.clearConnectFeedback();
    this.ceph.plan(this.connectionInput()).subscribe({
      next: (plan) => {
        this.plan.set(plan);
        this.planLoading.set(false);
        this.connectNoticeTitle.set('입력 형식 확인 완료');
        this.connectNotice.set('CephX 사용자를 Rook용 정식 엔티티와 ceph-csi용 userID로 구분했습니다. 실제 인증과 pool 접근은 연결 단계에서 확인합니다.');
        this.step.set(3);
      },
      error: (failure) => {
        this.planLoading.set(false);
        this.connectErrorTitle.set('입력 값 확인 실패');
        this.connectError.set(this.message(failure));
      },
    });
  }

  connect(): void {
    if (!this.plan() || this.connectReason.trim().length < 8) return;
    this.busy.set(true);
    this.clearConnectFeedback();
    const request = this.ceph.connect(this.connectionInput(), this.connectReason.trim());
    request.subscribe({
      next: (result) => {
        this.clearConnectionInput();
        this.busy.set(false);
        this.status.set(result.status);
        this.connectCompleted.set(true);
        this.connectNoticeTitle.set('외부 Ceph 연결 완료');
        this.connectNotice.set('연결 리소스 설치와 실제 Ready 검증을 완료했습니다. 결과를 확인한 뒤 닫으십시오.');
        this.loadInsights(true);
      },
      error: (failure) => {
        // 비밀 값만 선별 제거한다. 비밀이 아닌 FSID·MON·pool은 재입력 편의를 위해 보존한다.
        for (const role of this.connectionRoles) this.roleUserKey[role.id] = '';
        this.busy.set(false);
        this.connectErrorTitle.set('Kubernetes 연결 실패');
        this.connectError.set(`${this.message(failure)} 보안을 위해 역할별 key 입력값을 지웠습니다.`);
        this.load(true);
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
    if (this.disconnectReason.trim().length < 8 || this.disconnectConfirm !== 'disconnect Ceph external storage') return;
    this.busy.set(true);
    this.error.set('');
    this.ceph.disconnect(this.disconnectReason.trim()).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.disconnectOpen = false;
        this.activeTab.set('connection');
        this.insights.set(null);
        this.insightsError.set('');
        this.notice.set(`Ceph consumer 연결을 해제했습니다. 보존: ${result.retained.join(', ')}`);
        this.load();
      },
      error: (failure) => { this.busy.set(false); this.error.set(this.message(failure)); },
    });
  }

  private message(failure: any): string {
    return String(failure?.error?.error || failure?.message || 'Ceph 연결 요청에 실패했습니다.');
  }

  private insightsFailureMessage(failure: any): string {
    const status = Number(failure?.status || 0);
    if ([0, 500, 502, 503, 504].includes(status)) {
      return 'Console 권한 확인 또는 Ceph 관측 경로가 일시적으로 응답하지 않습니다. 자동 재시도를 마쳤으며 잠시 후 다시 확인합니다.';
    }
    return this.message(failure);
  }
}
