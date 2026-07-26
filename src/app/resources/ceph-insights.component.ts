import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ViewEncapsulation, signal } from '@angular/core';
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
        <button class="refresh-button" type="button" [disabled]="loading" (click)="refresh.emit()" aria-label="Ceph 현황 즉시 다시 읽기">
          {{ loading ? '읽는 중…' : '지금 새로고침' }}
        </button>
      </div>

      <div *ngIf="error" class="section-alert danger" role="alert">
        <strong>Ceph 현황을 불러오지 못했습니다.</strong>
        <span>{{ error }}</span>
      </div>

      <ng-container *ngIf="insights as data; else noData">
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

        <div *ngIf="data.sectionErrors.length" class="section-alert warning" role="status">
          <strong>일부 항목은 표시할 수 없습니다.</strong>
          <ul>
            <li *ngFor="let item of data.sectionErrors">
              <b>{{ sectionLabel(item.section) }}</b> — {{ item.message }}
            </li>
          </ul>
        </div>

        <nav class="view-switcher" aria-label="Ceph 현황 보기">
          <button type="button" [attr.aria-current]="view() === 'overview' ? 'page' : null" [class.active]="view() === 'overview'" (click)="view.set('overview')">전체 현황</button>
          <button type="button" [attr.aria-current]="view() === 'capacity' ? 'page' : null" [class.active]="view() === 'capacity'" (click)="view.set('capacity')">용량·Pool</button>
          <button type="button" [attr.aria-current]="view() === 'osd-pg' ? 'page' : null" [class.active]="view() === 'osd-pg'" (click)="view.set('osd-pg')">OSD·PG</button>
          <button type="button" [attr.aria-current]="view() === 'hosts' ? 'page' : null" [class.active]="view() === 'hosts'" (click)="view.set('hosts')">호스트·서비스</button>
        </nav>

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
              <header><div><h3>클러스터 용량 사용률</h3><p>전체 raw capacity 중 현재 사용량</p></div><strong>{{ percent(data.capacity.percentUsed) }}</strong></header>
              <ibm-meter-chart [data]="capacityMeterData(data)" [options]="capacityMeterOptions" height="150px"></ibm-meter-chart>
              <details>
                <summary>차트 데이터 표로 보기</summary>
                <table><caption>Ceph 전체 용량</caption><thead><tr><th>구분</th><th>크기</th><th>비율</th></tr></thead>
                  <tbody><tr><td>사용</td><td>{{ bytes(data.capacity.usedBytes) }}</td><td>{{ percent(data.capacity.percentUsed) }}</td></tr>
                    <tr><td>여유</td><td>{{ bytes(data.capacity.availableBytes) }}</td><td>{{ percent(100 - data.capacity.percentUsed) }}</td></tr></tbody>
                </table>
              </details>
            </article>
            <article class="chart-card">
              <header><div><h3>OSD 실행 상태</h3><p>Up/Down은 데몬 응답 상태입니다.</p></div></header>
              <ibm-donut-chart [data]="osdStatusData(data)" [options]="osdDonutOptions" height="250px"></ibm-donut-chart>
              <table class="compact-table"><caption>OSD 실행 상태</caption><tbody>
                <tr><th>Up</th><td>{{ data.osds.up }}</td></tr><tr><th>Down</th><td>{{ data.osds.down }}</td></tr>
              </tbody></table>
            </article>
            <article class="chart-card">
              <header><div><h3>PG 데이터 상태</h3><p>active+clean 계열과 확인 필요 상태</p></div></header>
              <ibm-donut-chart [data]="pgHealthData(data)" [options]="pgDonutOptions" height="250px"></ibm-donut-chart>
              <table class="compact-table"><caption>PG 데이터 상태</caption><tbody>
                <tr><th>정상</th><td>{{ data.pgs.healthy }}</td></tr><tr><th>확인 필요</th><td>{{ data.pgs.unhealthy }}</td></tr>
              </tbody></table>
            </article>
          </div>
        </ng-container>

        <ng-container *ngIf="view() === 'capacity'">
          <div class="chart-grid single">
            <article class="chart-card">
              <header><div><h3>Pool별 사용량</h3><p>Pool이 실제로 사용 중인 byte를 비교합니다.</p></div></header>
              <ibm-stacked-bar-chart *ngIf="data.pools.length" [data]="poolChartData(data)" [options]="poolChartOptions" height="360px"></ibm-stacked-bar-chart>
              <p *ngIf="!data.pools.length" class="empty-section">조회 가능한 Pool 데이터가 없습니다.</p>
            </article>
          </div>
          <div class="data-panel">
            <h3>Pool 상세</h3>
            <div class="table-scroll">
              <table><caption>Ceph Pool 용량과 객체 수</caption><thead><tr><th>Pool</th><th>사용량</th><th>저장 데이터</th><th>가용 추정</th><th>사용률</th><th>객체</th></tr></thead>
                <tbody><tr *ngFor="let pool of data.pools"><th>{{ pool.name }}</th><td>{{ bytes(pool.bytesUsed) }}</td><td>{{ bytes(pool.storedBytes) }}</td><td>{{ bytes(pool.maxAvailableBytes) }}</td><td>{{ percent(pool.percentUsed) }}</td><td>{{ integer(pool.objects) }}</td></tr></tbody>
              </table>
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
              <header><div><h3>OSD 사용률 분포</h3><p>OSD별 사용률을 구간별로 집계합니다.</p></div></header>
              <ibm-histogram-chart *ngIf="data.osds.items.length" [data]="osdHistogramData(data)" [options]="osdHistogramOptions" height="300px"></ibm-histogram-chart>
              <p *ngIf="!data.osds.items.length" class="empty-section">조회 가능한 OSD 데이터가 없습니다.</p>
            </article>
            <article class="chart-card">
              <header><div><h3>PG 상태 구성</h3><p>Ceph이 보고한 상태 문자열을 그대로 분리합니다.</p></div></header>
              <ibm-stacked-bar-chart *ngIf="data.pgs.states.length" [data]="pgStateData(data)" [options]="pgStateOptions" height="300px"></ibm-stacked-bar-chart>
              <p *ngIf="!data.pgs.states.length" class="empty-section">조회 가능한 PG 데이터가 없습니다.</p>
            </article>
          </div>
          <div class="data-panel">
            <h3>OSD 상세</h3>
            <div class="table-scroll">
              <table><caption>Ceph OSD 상태와 사용량</caption><thead><tr><th>OSD</th><th>Host</th><th>Class</th><th>실행</th><th>배치</th><th>사용률</th><th>사용 / 전체</th></tr></thead>
                <tbody><tr *ngFor="let osd of data.osds.items"><th>{{ osd.name }}</th><td>{{ osd.host }}</td><td>{{ osd.deviceClass }}</td>
                  <td><span class="status-dot" [class.bad]="osd.status !== 'up'"></span>{{ osd.status }}</td><td>{{ osd.in ? 'In' : 'Out' }}</td>
                  <td>{{ percent(osd.utilization) }}</td><td>{{ bytes(osd.usedBytes) }} / {{ bytes(osd.totalBytes) }}</td></tr></tbody>
              </table>
            </div>
          </div>
          <div class="data-panel">
            <h3>PG 상태 상세</h3>
            <table><caption>Placement Group 상태별 개수</caption><thead><tr><th>상태</th><th>개수</th><th>비율</th></tr></thead>
              <tbody><tr *ngFor="let state of data.pgs.states"><th class="mono">{{ state.state }}</th><td>{{ state.count }}</td><td>{{ percent(data.pgs.total ? state.count / data.pgs.total * 100 : 0) }}</td></tr></tbody>
            </table>
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
                <table><caption>Ceph Orchestrator 호스트 목록</caption><thead><tr><th>Hostname</th><th>주소</th><th>상태</th><th>Labels</th></tr></thead>
                  <tbody><tr *ngFor="let host of data.hosts"><th>{{ host.hostname }}</th><td class="mono">{{ host.address }}</td>
                    <td><span class="status-dot" [class.bad]="host.status && host.status !== 'online'"></span>{{ host.status || 'online' }}</td>
                    <td><span *ngFor="let label of host.labels" class="tag">{{ label }}</span><span *ngIf="!host.labels.length">—</span></td></tr></tbody>
                </table>
              </div>
              <p *ngIf="!data.hosts.length" class="empty-section">호스트 목록을 조회할 수 없거나 등록된 호스트가 없습니다.</p>
            </section>
            <section class="data-panel">
              <h3>호스트별 OSD</h3>
              <div class="table-scroll">
                <table><caption>호스트별 OSD와 사용률</caption><thead><tr><th>Host</th><th>OSD</th><th>Up</th><th>In</th><th>사용률</th></tr></thead>
                  <tbody><tr *ngFor="let host of data.osds.byHost"><th>{{ host.name }}</th><td>{{ host.osds }}</td><td>{{ host.up }}</td><td>{{ host.in }}</td><td>{{ percent(host.utilization) }}</td></tr></tbody>
                </table>
              </div>
            </section>
          </div>
          <section class="data-panel">
            <h3>배포 서비스</h3>
            <div class="table-scroll">
              <table><caption>Ceph daemon 배포 서비스</caption><thead><tr><th>유형</th><th>ID</th><th>Host</th><th>상태</th><th>Version</th><th>마지막 갱신</th></tr></thead>
                <tbody><tr *ngFor="let service of data.services"><th>{{ service.type }}</th><td class="mono">{{ service.id }}</td><td>{{ service.hostname }}</td>
                  <td><span class="status-dot" [class.bad]="service.status !== 1"></span>{{ service.statusDescription }}</td>
                  <td class="version-cell">{{ service.version || '확인 불가' }}</td><td>{{ service.lastRefresh || '확인 불가' }}</td></tr></tbody>
              </table>
            </div>
            <p *ngIf="!data.services.length" class="empty-section">배포 서비스 정보를 조회할 수 없거나 보고된 서비스가 없습니다.</p>
          </section>
        </ng-container>
      </ng-container>

      <ng-template #noData>
        <div *ngIf="loading; else waiting" class="empty-state" role="status">
          <span class="spinner" aria-hidden="true"></span><strong>Ceph 클러스터 현황을 읽고 있습니다.</strong>
        </div>
        <ng-template #waiting><div *ngIf="!error" class="empty-state"><strong>외부 Ceph 연결이 완료되면 현황을 확인할 수 있습니다.</strong></div></ng-template>
      </ng-template>
    </section>
  `,
  styleUrls: ['./ceph-insights.component.css'],
  encapsulation: ViewEncapsulation.None,
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
    color: { scale: { 사용: '#0f62fe' } },
    legend: { enabled: false },
    toolbar: { enabled: false },
    animations: true,
  };
  readonly osdDonutOptions: any = this.donutOptions('OSD', '#198038', '#da1e28');
  readonly pgDonutOptions: any = this.donutOptions('PG', '#0f62fe', '#ff832b');
  readonly poolChartOptions: any = {
    height: '360px',
    axes: {
      left: { mapsTo: 'key', scaleType: 'labels' },
      bottom: { mapsTo: 'value', stacked: true, title: '사용량 (GiB)' },
    },
    legend: { enabled: false },
    toolbar: { enabled: false },
    color: { scale: { 사용량: '#0f62fe' } },
  };
  readonly osdHistogramOptions: any = {
    height: '300px',
    axes: {
      bottom: { mapsTo: 'value', bins: 10, title: 'OSD 사용률 (%)' },
      left: { mapsTo: 'frequency', scaleType: 'linear', title: 'OSD 수' },
    },
    legend: { enabled: false },
    toolbar: { enabled: false },
    color: { scale: { OSD: '#8a3ffc' } },
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
