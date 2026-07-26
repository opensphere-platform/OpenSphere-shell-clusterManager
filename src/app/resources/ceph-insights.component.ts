import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import {
  DonutChartComponent,
  HistogramChartComponent,
  MeterChartComponent,
  StackedBarChartComponent,
} from '@carbon/charts-angular';
import { CephInsights } from '../core/ceph.service';

type InsightsView = 'overview' | 'capacity' | 'osd-pg' | 'hosts';

@Component({
  selector: 'app-ceph-insights',
  standalone: true,
  imports: [
    CommonModule,
    ClarityModule,
    MeterChartComponent,
    DonutChartComponent,
    StackedBarChartComponent,
    HistogramChartComponent,
  ],
  template: `
    <section class="ceph-insights" aria-labelledby="ceph-insights-title">
      <div class="insights-hero">
        <div class="insights-identity">
          <span class="logo-frame ceph-frame">
            <img [src]="cephLogo" alt="Ceph" width="58" height="58" />
          </span>
          <div class="insights-copy">
            <p class="eyebrow">READ-ONLY CLUSTER OBSERVATION</p>
            <h2 id="ceph-insights-title">외부 Ceph 클러스터 현황</h2>
            <p>연결에 사용한 제한된 CephX 계정으로 health·용량·OSD·PG와 배포 정보를 읽습니다. 이 화면은 Ceph 상태를 변경하지 않습니다.</p>
          </div>
        </div>
        <button class="btn btn-outline" type="button" [disabled]="loading" (click)="refresh.emit()" aria-label="Ceph 현황 즉시 다시 읽기">
          <cds-icon shape="refresh"></cds-icon> {{ loading ? '읽는 중…' : '지금 새로고침' }}
        </button>
      </div>

      <clr-alert *ngIf="error" [clrAlertType]="insights ? 'warning' : 'danger'" [clrAlertClosable]="false">
        <clr-alert-item><span class="alert-text">
          <strong>{{ insights ? '새 관측값 갱신이 지연되고 있습니다.' : 'Ceph 현황을 불러오지 못했습니다.' }}</strong> ·
          {{ error }}<ng-container *ngIf="insights"> 마지막으로 확인된 관측값을 계속 표시합니다.</ng-container>
        </span></clr-alert-item>
      </clr-alert>

      <ng-container *ngIf="insights as data; else noData">
        <clr-alert *ngIf="data.observerSecurity?.mode === 'LegacyUnauthenticated'"
                   [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text"><strong>관측 보안 전환 대기</strong> · {{ data.observerSecurity.message }}</span></clr-alert-item>
        </clr-alert>
        <div class="observation-strip">
          <div>
            <span class="observation-label">클러스터 상태</span>
            <strong class="health-value" [class.warn]="data.cluster.health !== 'HEALTH_OK'">{{ healthLabel(data.cluster.health) }}</strong>
            <small>{{ data.cluster.health }}</small>
          </div>
          <div>
            <span class="observation-label">관측 시각</span>
            <strong>{{ data.observedAt | date:'yyyy-MM-dd HH:mm:ss' }}</strong>
            <small>{{ data.cached ? '캐시된 관측값' : 'Ceph에서 새로 읽음' }} · {{ data.durationMs }}ms</small>
          </div>
          <div>
            <span class="observation-label">클러스터 식별 지문</span>
            <strong class="mono">{{ data.cluster.fsidFingerprint || '확인 불가' }}</strong>
            <small>원본 FSID는 화면에 표시하지 않음</small>
          </div>
          <div>
            <span class="observation-label">관측 범위</span>
            <strong>{{ data.capabilities.length }}/8 항목</strong>
            <small>{{ data.partial ? '일부 정보 제한됨' : '요청한 모든 정보 확인됨' }}</small>
          </div>
        </div>

        <clr-alert *ngIf="data.sectionErrors.length" [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text"><strong>일부 항목은 표시할 수 없습니다.</strong>
          <ul>
            <li *ngFor="let item of data.sectionErrors">
              <b>{{ sectionLabel(item.section) }}</b> — {{ item.message }}
            </li>
          </ul></span></clr-alert-item>
        </clr-alert>

        <clr-tabs aria-label="Ceph 현황 보기">
          <clr-tab><button clrTabLink type="button" (click)="view.set('overview')">전체 현황</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
          <clr-tab><button clrTabLink type="button" (click)="view.set('capacity')">용량·Pool</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
          <clr-tab><button clrTabLink type="button" (click)="view.set('osd-pg')">OSD·PG</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
          <clr-tab><button clrTabLink type="button" (click)="view.set('hosts')">호스트·서비스</button><clr-tab-content *clrIfActive></clr-tab-content></clr-tab>
        </clr-tabs>

        <ng-container *ngIf="view() === 'overview'">
          <div class="metric-grid">
            <article class="metric-card">
              <span>전체 용량</span>
              <strong>{{ bytes(data.capacity.totalBytes) }}</strong>
              <small>사용 {{ bytes(data.capacity.usedBytes) }} · 여유 {{ bytes(data.capacity.availableBytes) }}</small>
            </article>
            <article class="metric-card">
              <span>OSD 가용성</span>
              <strong>{{ data.osds.up }}/{{ data.osds.total }} Up</strong>
              <small>{{ data.osds.in }}/{{ data.osds.total }} In · 최대 사용률 {{ percent(data.osds.maxUtilization) }}</small>
            </article>
            <article class="metric-card">
              <span>Placement Group</span>
              <strong>{{ data.pgs.healthy }}/{{ data.pgs.total }} 정상</strong>
              <small *ngIf="data.pgs.unhealthy; else healthyPgs">{{ data.pgs.unhealthy }}개 확인 필요</small>
              <ng-template #healthyPgs><small>모든 PG가 active+clean 계열</small></ng-template>
            </article>
            <article class="metric-card">
              <span>배포 토폴로지</span>
              <strong>{{ data.hosts.length }} Hosts</strong>
              <small>MON {{ data.cluster.monitors }} · 서비스 {{ data.services.length }}</small>
            </article>
          </div>

          <div class="chart-grid">
            <article class="chart-card chart-card-wide">
              <div class="chart-card-header"><div><h3>클러스터 용량 사용률</h3><p>전체 raw capacity 중 현재 사용량</p></div><strong>{{ percent(data.capacity.percentUsed) }}</strong></div>
              <ibm-meter-chart [data]="capacityMeterData(data)" [options]="capacityMeterOptions" height="150px"></ibm-meter-chart>
              <details>
                <summary>차트 데이터 표로 보기</summary>
                <clr-datagrid aria-label="Ceph 전체 용량"><clr-dg-column>구분</clr-dg-column><clr-dg-column>크기</clr-dg-column><clr-dg-column>비율</clr-dg-column>
                  <clr-dg-row><clr-dg-cell>사용</clr-dg-cell><clr-dg-cell>{{ bytes(data.capacity.usedBytes) }}</clr-dg-cell><clr-dg-cell>{{ percent(data.capacity.percentUsed) }}</clr-dg-cell></clr-dg-row>
                    <clr-dg-row><clr-dg-cell>여유</clr-dg-cell><clr-dg-cell>{{ bytes(data.capacity.availableBytes) }}</clr-dg-cell><clr-dg-cell>{{ percent(100 - data.capacity.percentUsed) }}</clr-dg-cell></clr-dg-row>
                </clr-datagrid>
              </details>
            </article>
            <article class="chart-card">
              <div class="chart-card-header"><div><h3>OSD 실행 상태</h3><p>Up/Down은 데몬 응답 상태입니다.</p></div></div>
              <ibm-donut-chart [data]="osdStatusData(data)" [options]="osdDonutOptions" height="250px"></ibm-donut-chart>
              <clr-datagrid class="compact-table" aria-label="OSD 실행 상태">
                <clr-dg-row><clr-dg-cell>Up</clr-dg-cell><clr-dg-cell>{{ data.osds.up }}</clr-dg-cell></clr-dg-row><clr-dg-row><clr-dg-cell>Down</clr-dg-cell><clr-dg-cell>{{ data.osds.down }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
            </article>
            <article class="chart-card">
              <div class="chart-card-header"><div><h3>PG 데이터 상태</h3><p>active+clean 계열과 확인 필요 상태</p></div></div>
              <ibm-donut-chart [data]="pgHealthData(data)" [options]="pgDonutOptions" height="250px"></ibm-donut-chart>
              <clr-datagrid class="compact-table" aria-label="PG 데이터 상태">
                <clr-dg-row><clr-dg-cell>정상</clr-dg-cell><clr-dg-cell>{{ data.pgs.healthy }}</clr-dg-cell></clr-dg-row><clr-dg-row><clr-dg-cell>확인 필요</clr-dg-cell><clr-dg-cell>{{ data.pgs.unhealthy }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
            </article>
          </div>
        </ng-container>

        <ng-container *ngIf="view() === 'capacity'">
          <div class="chart-grid single">
            <article class="chart-card">
              <div class="chart-card-header"><div><h3>Pool별 사용량</h3><p>Pool이 실제로 사용 중인 byte를 비교합니다.</p></div></div>
              <ibm-stacked-bar-chart *ngIf="data.pools.length" [data]="poolChartData(data)" [options]="poolChartOptions" height="360px"></ibm-stacked-bar-chart>
              <p *ngIf="!data.pools.length" class="empty-section">조회 가능한 Pool 데이터가 없습니다.</p>
            </article>
          </div>
          <div class="data-panel">
            <h3>Pool 상세</h3>
            <div class="table-scroll">
              <clr-datagrid aria-label="Ceph Pool 용량과 객체 수"><clr-dg-column>Pool</clr-dg-column><clr-dg-column>사용량</clr-dg-column><clr-dg-column>저장 데이터</clr-dg-column><clr-dg-column>가용 추정</clr-dg-column><clr-dg-column>사용률</clr-dg-column><clr-dg-column>객체</clr-dg-column>
                <clr-dg-row *ngFor="let pool of data.pools"><clr-dg-cell>{{ pool.name }}</clr-dg-cell><clr-dg-cell>{{ bytes(pool.bytesUsed) }}</clr-dg-cell><clr-dg-cell>{{ bytes(pool.storedBytes) }}</clr-dg-cell><clr-dg-cell>{{ bytes(pool.maxAvailableBytes) }}</clr-dg-cell><clr-dg-cell>{{ percent(pool.percentUsed) }}</clr-dg-cell><clr-dg-cell>{{ integer(pool.objects) }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
            </div>
          </div>
        </ng-container>

        <ng-container *ngIf="view() === 'osd-pg'">
          <div class="metric-grid">
            <article class="metric-card"><span>실행 상태</span><strong>{{ data.osds.up }} Up / {{ data.osds.down }} Down</strong><small>데몬이 응답하는지 확인</small></article>
            <article class="metric-card"><span>데이터 배치</span><strong>{{ data.osds.in }} In / {{ data.osds.out }} Out</strong><small>CRUSH 배치 참여 여부</small></article>
            <article class="metric-card"><span>평균 OSD 사용률</span><strong>{{ percent(data.osds.averageUtilization) }}</strong><small>최대 {{ percent(data.osds.maxUtilization) }}</small></article>
            <article class="metric-card"><span>PG 상태</span><strong>{{ data.pgs.healthy }} 정상</strong><small>{{ data.pgs.unhealthy }} 확인 필요</small></article>
          </div>
          <div class="chart-grid">
            <article class="chart-card">
              <div class="chart-card-header"><div><h3>OSD 사용률 분포</h3><p>OSD별 사용률을 구간별로 집계합니다.</p></div></div>
              <ibm-histogram-chart *ngIf="data.osds.items.length" [data]="osdHistogramData(data)" [options]="osdHistogramOptions" height="300px"></ibm-histogram-chart>
              <p *ngIf="!data.osds.items.length" class="empty-section">조회 가능한 OSD 데이터가 없습니다.</p>
            </article>
            <article class="chart-card">
              <div class="chart-card-header"><div><h3>PG 상태 구성</h3><p>Ceph이 보고한 상태 문자열을 그대로 분리합니다.</p></div></div>
              <ibm-stacked-bar-chart *ngIf="data.pgs.states.length" [data]="pgStateData(data)" [options]="pgStateOptions" height="300px"></ibm-stacked-bar-chart>
              <p *ngIf="!data.pgs.states.length" class="empty-section">조회 가능한 PG 데이터가 없습니다.</p>
            </article>
          </div>
          <div class="data-panel">
            <h3>OSD 상세</h3>
            <div class="table-scroll">
              <clr-datagrid aria-label="Ceph OSD 상태와 사용량"><clr-dg-column>OSD</clr-dg-column><clr-dg-column>Host</clr-dg-column><clr-dg-column>Class</clr-dg-column><clr-dg-column>실행</clr-dg-column><clr-dg-column>배치</clr-dg-column><clr-dg-column>사용률</clr-dg-column><clr-dg-column>사용 / 전체</clr-dg-column>
                <clr-dg-row *ngFor="let osd of data.osds.items"><clr-dg-cell>{{ osd.name }}</clr-dg-cell><clr-dg-cell>{{ osd.host }}</clr-dg-cell><clr-dg-cell>{{ osd.deviceClass }}</clr-dg-cell>
                  <clr-dg-cell><span class="status-dot" [class.bad]="osd.status !== 'up'"></span>{{ osd.status }}</clr-dg-cell><clr-dg-cell>{{ osd.in ? 'In' : 'Out' }}</clr-dg-cell>
                  <clr-dg-cell>{{ percent(osd.utilization) }}</clr-dg-cell><clr-dg-cell>{{ bytes(osd.usedBytes) }} / {{ bytes(osd.totalBytes) }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
            </div>
          </div>
          <div class="data-panel">
            <h3>PG 상태 상세</h3>
            <clr-datagrid aria-label="Placement Group 상태별 개수"><clr-dg-column>상태</clr-dg-column><clr-dg-column>개수</clr-dg-column><clr-dg-column>비율</clr-dg-column>
              <clr-dg-row *ngFor="let state of data.pgs.states"><clr-dg-cell class="mono">{{ state.state }}</clr-dg-cell><clr-dg-cell>{{ state.count }}</clr-dg-cell><clr-dg-cell>{{ percent(data.pgs.total ? state.count / data.pgs.total * 100 : 0) }}</clr-dg-cell></clr-dg-row>
            </clr-datagrid>
          </div>
        </ng-container>

        <ng-container *ngIf="view() === 'hosts'">
          <div class="brand-relationship compact">
            <div><img [src]="kubernetesLogo" alt="" width="40" height="40" /><span><b>Consumer Kubernetes</b><small>Rook External · CSI</small></span></div>
            <span class="relationship-line" aria-hidden="true">read-only ↔ storage</span>
            <div><img [src]="cephLogo" alt="" width="40" height="40" /><span><b>External Ceph</b><small>{{ data.hosts.length }} hosts · {{ data.services.length }} daemons</small></span></div>
          </div>
          <div class="split-panels">
            <section class="data-panel">
              <h3>Ceph 호스트</h3>
              <div class="table-scroll">
                <clr-datagrid aria-label="Ceph Orchestrator 호스트 목록"><clr-dg-column>Hostname</clr-dg-column><clr-dg-column>주소</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>Labels</clr-dg-column>
                  <clr-dg-row *ngFor="let host of data.hosts"><clr-dg-cell>{{ host.hostname }}</clr-dg-cell><clr-dg-cell class="mono">{{ host.address }}</clr-dg-cell>
                    <clr-dg-cell><span class="status-dot" [class.bad]="host.status && host.status !== 'online'"></span>{{ host.status || 'online' }}</clr-dg-cell>
                    <clr-dg-cell><span *ngFor="let label of host.labels" class="tag">{{ label }}</span><span *ngIf="!host.labels.length">—</span></clr-dg-cell></clr-dg-row>
                </clr-datagrid>
              </div>
              <p *ngIf="!data.hosts.length" class="empty-section">호스트 목록을 조회할 수 없거나 등록된 호스트가 없습니다.</p>
            </section>
            <section class="data-panel">
              <h3>호스트별 OSD</h3>
              <div class="table-scroll">
                <clr-datagrid aria-label="호스트별 OSD와 사용률"><clr-dg-column>Host</clr-dg-column><clr-dg-column>OSD</clr-dg-column><clr-dg-column>Up</clr-dg-column><clr-dg-column>In</clr-dg-column><clr-dg-column>사용률</clr-dg-column>
                  <clr-dg-row *ngFor="let host of data.osds.byHost"><clr-dg-cell>{{ host.name }}</clr-dg-cell><clr-dg-cell>{{ host.osds }}</clr-dg-cell><clr-dg-cell>{{ host.up }}</clr-dg-cell><clr-dg-cell>{{ host.in }}</clr-dg-cell><clr-dg-cell>{{ percent(host.utilization) }}</clr-dg-cell></clr-dg-row>
                </clr-datagrid>
              </div>
            </section>
          </div>
          <section class="data-panel">
            <h3>배포 서비스</h3>
            <div class="table-scroll">
              <clr-datagrid aria-label="Ceph daemon 배포 서비스"><clr-dg-column>유형</clr-dg-column><clr-dg-column>ID</clr-dg-column><clr-dg-column>Host</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>Version</clr-dg-column><clr-dg-column>마지막 갱신</clr-dg-column>
                <clr-dg-row *ngFor="let service of data.services"><clr-dg-cell>{{ service.type }}</clr-dg-cell><clr-dg-cell class="mono">{{ service.id }}</clr-dg-cell><clr-dg-cell>{{ service.hostname }}</clr-dg-cell>
                  <clr-dg-cell><span class="status-dot" [class.bad]="service.status !== 1"></span>{{ service.statusDescription }}</clr-dg-cell>
                  <clr-dg-cell class="version-cell">{{ service.version || '확인 불가' }}</clr-dg-cell><clr-dg-cell>{{ service.lastRefresh || '확인 불가' }}</clr-dg-cell></clr-dg-row>
              </clr-datagrid>
            </div>
            <p *ngIf="!data.services.length" class="empty-section">배포 서비스 정보를 조회할 수 없거나 보고된 서비스가 없습니다.</p>
          </section>
        </ng-container>
      </ng-container>

      <ng-template #noData>
        <div *ngIf="loading; else waiting" class="empty-state" role="status">
          <clr-spinner clrInline aria-label="Ceph 클러스터 현황을 읽는 중"></clr-spinner><strong>Ceph 클러스터 현황을 읽고 있습니다.</strong>
        </div>
        <ng-template #waiting><div *ngIf="!error" class="empty-state"><strong>외부 Ceph 연결이 완료되면 현황을 확인할 수 있습니다.</strong></div></ng-template>
      </ng-template>
    </section>
  `,
  styleUrls: ['./ceph-insights.component.css'],
})
export class CephInsightsComponent {
  @Input() insights: CephInsights | null = null;
  @Input() loading = false;
  @Input() error = '';
  @Output() refresh = new EventEmitter<void>();

  readonly view = signal<InsightsView>('overview');
  readonly cephLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@b20a671aa820dace36907acb7cf95b540c0c4f81/logos/ceph.svg';
  readonly kubernetesLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@95aeaf7781b9a5753762811521131c06df328c87/logos/kubernetes-2-icon.svg';

  readonly capacityMeterOptions: any = {
    height: '150px',
    meter: { proportional: { total: 100, unit: '%' } },
    color: { scale: { 사용: 'var(--os-brand-500)' } },
    legend: { enabled: false },
    toolbar: { enabled: false },
    animations: true,
  };
  readonly osdDonutOptions: any = this.donutOptions('OSD', 'var(--os-success)', 'var(--os-danger)');
  readonly pgDonutOptions: any = this.donutOptions('PG', 'var(--os-brand-500)', 'var(--os-warn)');
  readonly poolChartOptions: any = {
    height: '360px',
    axes: {
      left: { mapsTo: 'key', scaleType: 'labels' },
      bottom: { mapsTo: 'value', stacked: true, title: '사용량 (GiB)' },
    },
    legend: { enabled: false },
    toolbar: { enabled: false },
    color: { scale: { 사용량: 'var(--os-brand-500)' } },
  };
  readonly osdHistogramOptions: any = {
    height: '300px',
    axes: {
      bottom: { mapsTo: 'value', bins: 10, title: 'OSD 사용률 (%)' },
      left: { mapsTo: 'frequency', scaleType: 'linear', title: 'OSD 수' },
    },
    legend: { enabled: false },
    toolbar: { enabled: false },
    color: { scale: { OSD: 'var(--os-gauge-mem)' } },
  };
  readonly pgStateOptions: any = {
    height: '300px',
    axes: {
      left: { mapsTo: 'key', scaleType: 'labels' },
      bottom: { mapsTo: 'value', stacked: true, title: 'PG 수' },
    },
    legend: { position: 'bottom' },
    toolbar: { enabled: false },
  };

  healthLabel(value: string): string {
    if (value === 'HEALTH_OK') return '정상';
    if (value === 'HEALTH_WARN') return '주의';
    if (value === 'HEALTH_ERR') return '오류';
    return '확인 불가';
  }

  sectionLabel(value: string): string {
    return ({
      status: '클러스터 상태', health: 'Health 상세', capacity: '용량·Pool', osds: 'OSD',
      pgs: 'PG', hosts: '호스트', services: '배포 서비스', versions: 'Version',
    } as Record<string, string>)[value] || value;
  }

  bytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const amount = value / 1024 ** index;
    return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2 }).format(amount)} ${units[index]}`;
  }

  percent(value: number): string {
    return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0)}%`;
  }

  integer(value: number): string {
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
  }

  capacityMeterData(data: CephInsights): any[] {
    return [{ group: '사용', value: Number(data.capacity.percentUsed.toFixed(2)) }];
  }

  osdStatusData(data: CephInsights): any[] {
    return [{ group: 'Up', value: data.osds.up }, { group: 'Down', value: data.osds.down }];
  }

  pgHealthData(data: CephInsights): any[] {
    return [{ group: '정상', value: data.pgs.healthy }, { group: '확인 필요', value: data.pgs.unhealthy }];
  }

  poolChartData(data: CephInsights): any[] {
    return data.pools.map((pool) => ({ group: '사용량', key: pool.name, value: pool.bytesUsed / 1024 ** 3 }));
  }

  osdHistogramData(data: CephInsights): any[] {
    return data.osds.items.map((osd) => ({ group: 'OSD', value: osd.utilization }));
  }

  pgStateData(data: CephInsights): any[] {
    return data.pgs.states.map((state) => ({ group: state.state, key: '전체 PG', value: state.count }));
  }

  private donutOptions(label: string, primary: string, danger: string): any {
    return {
      height: '250px',
      donut: { center: { label } },
      legend: { position: 'bottom' },
      toolbar: { enabled: false },
      color: { scale: { Up: primary, Down: danger, 정상: primary, '확인 필요': danger } },
    };
  }
}
