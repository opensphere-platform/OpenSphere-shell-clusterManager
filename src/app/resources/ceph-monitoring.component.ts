import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {
  CEPH_DASHBOARD_GROUPS,
  CEPH_DASHBOARDS,
  CEPH_GRAFANA_BASE_PATH,
  CEPH_GRAFANA_ORIGIN,
  CephDashboard,
} from './ceph-monitoring.catalog';

interface TimeRange {
  value: string;
  label: string;
}

interface RefreshInterval {
  value: string;
  label: string;
}

@Component({
  selector: 'app-ceph-monitoring',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="monitoring-page" aria-labelledby="ceph-monitoring-title">
      <header class="monitoring-head">
        <div class="monitoring-identity">
          <span class="logo-frame">
            <img [src]="cephLogo" alt="Ceph" width="48" height="48" />
          </span>
          <div>
            <p class="eyebrow">CEPH PROMETHEUS · GRAFANA</p>
            <h1 id="ceph-monitoring-title">Ceph Monitoring</h1>
            <p>Ceph에 내장된 Prometheus 지표를 Grafana dashboard로 직접 조회합니다. Console은 dashboard를 중계하거나 Ceph 상태를 변경하지 않습니다.</p>
          </div>
        </div>
        <a class="btn btn-outline" [href]="grafanaCatalogUrl" target="_blank" rel="noopener noreferrer">
          Grafana 원본 열기
        </a>
      </header>

      <div class="monitoring-note" role="note">
        <div>
          <strong>읽기 전용 외부 화면</strong>
          <span>Grafana anonymous Viewer 권한으로 표시되며 Console 로그인·CephX key와 분리됩니다.</span>
        </div>
        <div class="origin">
          <span class="status-dot" aria-hidden="true"></span>
          <code>{{ grafanaOriginLabel }}</code>
        </div>
      </div>

      <div class="monitoring-layout">
        <aside class="dashboard-menu" aria-label="Ceph dashboard 메뉴">
          <div class="menu-head">
            <strong>Dashboard</strong>
            <span>{{ dashboards.length }}개</span>
          </div>
          <label class="dashboard-search">
            <span class="sr-only">Dashboard 검색</span>
            <input type="search" placeholder="Dashboard 검색" [value]="query()"
              (input)="query.set($any($event.target).value)" />
          </label>

          <nav class="dashboard-groups">
            <section *ngFor="let group of filteredGroups()">
              <header>
                <strong>{{ group.label }}</strong>
                <small>{{ group.description }}</small>
              </header>
              <button *ngFor="let dashboard of group.items" type="button"
                [class.active]="dashboard.uid === selected().uid"
                [attr.aria-current]="dashboard.uid === selected().uid ? 'page' : null"
                (click)="selectDashboard(dashboard)">
                <span>{{ dashboard.label }}</span>
                <small>{{ dashboard.title }}</small>
              </button>
            </section>
          </nav>

          <div *ngIf="filteredGroups().length === 0" class="empty-filter">
            일치하는 dashboard가 없습니다.
          </div>
        </aside>

        <main class="dashboard-workspace">
          <header class="dashboard-toolbar">
            <div class="dashboard-title">
              <p>Grafana dashboard</p>
              <h2>{{ selected().label }}</h2>
              <span>{{ selected().description }}</span>
            </div>
            <div class="dashboard-controls" aria-label="Dashboard 표시 설정">
              <label>
                <span>기간</span>
                <select [value]="range()" (change)="setRange($any($event.target).value)">
                  <option *ngFor="let item of timeRanges" [value]="item.value">{{ item.label }}</option>
                </select>
              </label>
              <label>
                <span>새로고침</span>
                <select [value]="refresh()" (change)="setRefresh($any($event.target).value)">
                  <option *ngFor="let item of refreshIntervals" [value]="item.value">{{ item.label }}</option>
                </select>
              </label>
              <button class="btn btn-sm btn-outline" type="button" (click)="reload()">다시 불러오기</button>
              <a class="btn btn-sm btn-primary" [href]="externalDashboardUrl()" target="_blank" rel="noopener noreferrer">
                새 창
              </a>
            </div>
          </header>

          <div class="certificate-help">
            <strong>화면이 표시되지 않습니까?</strong>
            <span><code>ceph.triangles.com</code>의 HTTPS 인증서를 브라우저가 신뢰해야 합니다. 인증서 경고를 우회하지 말고 조직 Root CA를 신뢰 저장소에 등록하십시오.</span>
          </div>

          <div class="dashboard-frame" [class.loading]="!frameLoaded()">
            <div *ngIf="!frameLoaded()" class="frame-loading" role="status">
              <span class="spinner spinner-sm" aria-hidden="true"></span>
              Ceph Grafana dashboard를 읽고 있습니다.
            </div>
            <iframe
              [src]="dashboardUrl()"
              [title]="'Ceph Grafana - ' + selected().title"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              referrerpolicy="no-referrer"
              allow="fullscreen"
              (load)="frameLoaded.set(true)">
            </iframe>
          </div>
        </main>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    .monitoring-page { color: var(--os-ink, #1b2438); min-width: 0; }
    .monitoring-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem;
      padding: .25rem 0 1rem; border-bottom: 1px solid var(--os-border, #d4d8e0);
    }
    .monitoring-identity { display: flex; align-items: center; gap: .9rem; min-width: 0; }
    .logo-frame {
      display: grid; place-items: center; flex: 0 0 64px; width: 64px; height: 64px;
      border: 1px solid var(--os-border, #d4d8e0); border-radius: 50%; background: #fff;
      box-shadow: 0 4px 12px rgba(15, 42, 68, .08);
    }
    .monitoring-head h1 { margin: .1rem 0 .15rem; font-size: 1.55rem; line-height: 1.2; font-weight: 500; }
    .monitoring-head p { margin: 0; color: var(--os-text-sec, #4a5568); font-size: .82rem; }
    .monitoring-head .eyebrow {
      margin: 0 0 .15rem; color: var(--os-brand-500, #4c6fff); font-size: .68rem;
      font-weight: 700; letter-spacing: .08em;
    }
    .monitoring-note {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      margin: .85rem 0; padding: .65rem .85rem; border-left: 3px solid #2e7d32;
      background: #f4faf5; color: #294833; font-size: .76rem;
    }
    .monitoring-note > div:first-child { display: flex; align-items: baseline; gap: .6rem; min-width: 0; }
    .monitoring-note .origin { display: flex; align-items: center; gap: .4rem; white-space: nowrap; }
    .status-dot { width: .48rem; height: .48rem; border-radius: 50%; background: #2e7d32; }
    code { font-family: var(--os-font-mono, Consolas, monospace); font-size: .72rem; }
    .monitoring-layout {
      display: grid; grid-template-columns: 17rem minmax(0, 1fr);
      min-height: calc(100vh - 14rem); border: 1px solid var(--os-border, #d4d8e0); background: #fff;
    }
    .dashboard-menu {
      min-width: 0; border-right: 1px solid var(--os-border, #d4d8e0);
      background: var(--os-bg-subtle, #fafbfd); overflow: auto; max-height: calc(100vh - 12rem);
    }
    .menu-head { display: flex; justify-content: space-between; align-items: center; padding: .8rem .85rem .4rem; }
    .menu-head strong { font-size: .84rem; }
    .menu-head span { color: var(--os-muted, #667193); font-size: .7rem; }
    .dashboard-search { display: block; padding: .3rem .75rem .65rem; }
    .dashboard-search input {
      width: 100%; min-height: 2rem; padding: .35rem .55rem; border: 1px solid var(--os-border, #d4d8e0);
      border-radius: 2px; background: #fff; color: inherit; font: inherit; font-size: .75rem;
    }
    .dashboard-search input:focus { outline: 2px solid rgba(76, 111, 255, .25); border-color: var(--os-brand-500, #4c6fff); }
    .dashboard-groups section { border-top: 1px solid #e6e9ee; padding: .55rem 0; }
    .dashboard-groups header { padding: 0 .85rem .35rem; }
    .dashboard-groups header strong { display: block; font-size: .72rem; color: #334155; }
    .dashboard-groups header small { display: block; margin-top: .1rem; color: var(--os-muted, #667193); font-size: .64rem; }
    .dashboard-groups button {
      display: block; width: 100%; padding: .45rem .85rem; border: 0; border-left: 3px solid transparent;
      background: transparent; color: inherit; text-align: left; cursor: pointer;
    }
    .dashboard-groups button:hover { background: #f0f3f8; }
    .dashboard-groups button.active {
      border-left-color: var(--os-brand-500, #4c6fff); background: rgba(76, 111, 255, .1); color: #173ba3;
    }
    .dashboard-groups button span { display: block; font-size: .76rem; font-weight: 500; }
    .dashboard-groups button small { display: block; margin-top: .08rem; color: var(--os-muted, #667193); font-size: .62rem; }
    .empty-filter { padding: 1rem; color: var(--os-muted, #667193); font-size: .75rem; }
    .dashboard-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .dashboard-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      min-height: 4.4rem; padding: .65rem .85rem; border-bottom: 1px solid var(--os-border, #d4d8e0);
    }
    .dashboard-title { min-width: 0; }
    .dashboard-title p { margin: 0; color: var(--os-brand-500, #4c6fff); font-size: .62rem; font-weight: 700; text-transform: uppercase; }
    .dashboard-title h2 { margin: .08rem 0; font-size: 1rem; font-weight: 500; }
    .dashboard-title span { display: block; color: var(--os-muted, #667193); font-size: .68rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dashboard-controls { display: flex; align-items: flex-end; gap: .45rem; flex: 0 0 auto; }
    .dashboard-controls label { display: flex; flex-direction: column; gap: .12rem; font-size: .64rem; color: var(--os-muted, #667193); }
    .dashboard-controls select {
      min-width: 6rem; height: 1.8rem; padding: 0 .35rem; border: 1px solid var(--os-border, #d4d8e0);
      background: #fff; color: var(--os-ink, #1b2438); font-size: .7rem;
    }
    .certificate-help {
      display: flex; gap: .45rem; padding: .42rem .8rem; background: #fff8e1; border-bottom: 1px solid #f1dfaa;
      color: #5f4b17; font-size: .67rem;
    }
    .dashboard-frame { position: relative; flex: 1 1 auto; min-height: 42rem; background: #f3f5f7; overflow: hidden; }
    .dashboard-frame iframe { display: block; width: 100%; height: 100%; min-height: 42rem; border: 0; background: #fff; }
    .frame-loading {
      position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: .5rem;
      background: #f7f8fa; color: var(--os-muted, #667193); font-size: .78rem;
    }
    .dashboard-frame:not(.loading) .frame-loading { display: none; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 1050px) {
      .monitoring-layout { grid-template-columns: 14rem minmax(0, 1fr); }
      .dashboard-toolbar { align-items: flex-start; flex-direction: column; }
      .dashboard-controls { width: 100%; flex-wrap: wrap; }
    }
    @media (max-width: 760px) {
      .monitoring-head, .monitoring-note { align-items: flex-start; flex-direction: column; }
      .monitoring-layout { grid-template-columns: 1fr; }
      .dashboard-menu { max-height: 19rem; border-right: 0; border-bottom: 1px solid var(--os-border, #d4d8e0); }
      .dashboard-title span { white-space: normal; }
    }
  `],
})
export class CephMonitoringComponent {
  readonly cephLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/ceph.svg';
  readonly grafanaOriginLabel = `${CEPH_GRAFANA_ORIGIN}${CEPH_GRAFANA_BASE_PATH}`;
  readonly grafanaCatalogUrl = `${this.grafanaOriginLabel}/dashboards`;
  readonly dashboards = CEPH_DASHBOARDS;
  readonly query = signal('');
  readonly selected = signal<CephDashboard>(CEPH_DASHBOARDS[0]);
  readonly range = signal('now-6h');
  readonly refresh = signal('30s');
  readonly frameNonce = signal(0);
  readonly frameLoaded = signal(false);

  readonly timeRanges: readonly TimeRange[] = [
    { value: 'now-1h', label: '최근 1시간' },
    { value: 'now-6h', label: '최근 6시간' },
    { value: 'now-24h', label: '최근 24시간' },
    { value: 'now-7d', label: '최근 7일' },
  ];

  readonly refreshIntervals: readonly RefreshInterval[] = [
    { value: '15s', label: '15초' },
    { value: '30s', label: '30초' },
    { value: '1m', label: '1분' },
    { value: '5m', label: '5분' },
  ];

  readonly filteredGroups = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return CEPH_DASHBOARD_GROUPS
      .map(group => ({
        ...group,
        items: CEPH_DASHBOARDS.filter(dashboard =>
          dashboard.category === group.id
          && (!query || `${dashboard.label} ${dashboard.title} ${dashboard.description}`.toLocaleLowerCase().includes(query))),
      }))
      .filter(group => group.items.length > 0);
  });

  readonly externalDashboardUrl = computed(() => this.buildDashboardUrl(false));
  readonly dashboardUrl = computed<SafeResourceUrl>(() =>
    this.sanitizer.bypassSecurityTrustResourceUrl(this.buildDashboardUrl(true)));

  constructor(private readonly sanitizer: DomSanitizer) {}

  selectDashboard(dashboard: CephDashboard): void {
    if (!CEPH_DASHBOARDS.some(item => item.uid === dashboard.uid)) return;
    this.selected.set(dashboard);
    this.reload();
  }

  setRange(value: string): void {
    if (!this.timeRanges.some(item => item.value === value)) return;
    this.range.set(value);
    this.reload();
  }

  setRefresh(value: string): void {
    if (!this.refreshIntervals.some(item => item.value === value)) return;
    this.refresh.set(value);
    this.reload();
  }

  reload(): void {
    this.frameLoaded.set(false);
    this.frameNonce.update(value => value + 1);
  }

  private buildDashboardUrl(includeNonce: boolean): string {
    const dashboard = this.selected();
    const approved = CEPH_DASHBOARDS.find(item => item.uid === dashboard.uid) ?? CEPH_DASHBOARDS[0];
    const params = new URLSearchParams({
      orgId: '1',
      from: this.range(),
      to: 'now',
      timezone: 'browser',
      refresh: this.refresh(),
      theme: 'light',
    });
    params.append('kiosk', '');
    if (includeNonce) params.set('_os', String(this.frameNonce()));
    return `${CEPH_GRAFANA_ORIGIN}${CEPH_GRAFANA_BASE_PATH}/d/${encodeURIComponent(approved.uid)}/${encodeURIComponent(approved.slug)}?${params.toString()}`;
  }
}

