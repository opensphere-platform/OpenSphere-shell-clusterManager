import { CommonModule } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {
  CEPH_DASHBOARDS,
  CEPH_GRAFANA_BASE_PATH,
  CEPH_GRAFANA_ORIGIN,
} from './ceph-monitoring.catalog';

interface TimeRange {
  value: string;
  label: string;
}

interface RefreshInterval {
  value: string;
  label: string;
}

const CERTIFICATE_HELP_DISMISSED_KEY = 'opensphere.ceph-monitoring.certificate-help-dismissed';

@Component({
  selector: 'app-ceph-monitoring',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="monitoring-page" aria-labelledby="ceph-monitoring-title">
      <header class="monitoring-head">
        <div class="monitoring-identity">
          <span class="logo-frame">
            <img [src]="cephLogo" alt="Ceph" width="42" height="42" />
          </span>
          <div>
            <p class="eyebrow">CEPH PROMETHEUS · GRAFANA</p>
            <h1 id="ceph-monitoring-title">Ceph Monitoring</h1>
            <p>Ceph가 수집한 Prometheus 지표를 Grafana dashboard로 직접 조회합니다.</p>
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
                <option *ngFor="let item of timeRanges" [value]="item.value"
                  [selected]="item.value === range()">{{ item.label }}</option>
              </select>
            </label>
            <label>
              <span>새로고침</span>
              <select [value]="refresh()" (change)="setRefresh($any($event.target).value)">
                <option *ngFor="let item of refreshIntervals" [value]="item.value"
                  [selected]="item.value === refresh()">{{ item.label }}</option>
              </select>
            </label>
            <button class="btn btn-sm btn-outline" type="button" (click)="reload()">다시 불러오기</button>
            <a class="btn btn-sm btn-primary" [href]="externalDashboardUrl()" target="_blank" rel="noopener noreferrer">
              새 창
            </a>
          </div>
        </header>

        <div *ngIf="certificateHelpVisible()" class="certificate-help" role="note">
          <div class="certificate-copy">
            <strong>화면이 표시되지 않습니까?</strong>
            <span><code>ceph.triangles.com</code>의 HTTPS 인증서를 브라우저가 신뢰해야 합니다. 인증서 경고를 우회하지 말고 조직 Root CA를 신뢰 저장소에 등록하십시오.</span>
          </div>
          <button class="btn btn-sm btn-link certificate-close" type="button"
            aria-label="HTTPS 인증서 안내 닫기" (click)="dismissCertificateHelp()">
            닫기
          </button>
        </div>

        <div class="dashboard-frame" [class.loading]="!frameLoaded()">
          <div *ngIf="!frameLoaded()" class="frame-loading" role="status">
            <span class="spinner spinner-sm" aria-hidden="true"></span>
            Ceph Grafana dashboard를 읽고 있습니다.
          </div>
          <iframe
            [src]="dashboardUrl()"
            [title]="'Ceph Grafana - ' + selected().title"
            referrerpolicy="no-referrer"
            allow="fullscreen"
            (load)="frameLoaded.set(true)">
          </iframe>
        </div>
      </main>
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    .monitoring-page { min-width: 0; color: var(--os-ink, #1b2438); }
    .monitoring-head {
      display: flex; align-items: center; justify-content: space-between; gap: 1.25rem;
      min-height: 4.75rem; padding: .45rem .15rem .85rem; background: transparent;
      border-bottom: 1px solid var(--os-border, #d4d8e0);
    }
    .monitoring-identity { display: flex; align-items: center; gap: .8rem; min-width: 0; }
    .logo-frame {
      display: grid; place-items: center; flex: 0 0 54px; width: 54px; height: 54px;
      border: 1px solid var(--os-border, #d4d8e0); border-radius: 50%; background: #fff;
      box-shadow: 0 2px 8px rgba(15, 42, 68, .08);
    }
    .monitoring-head h1 {
      margin: .08rem 0 .12rem; color: var(--os-ink, #1b2438);
      font-size: 1.35rem; line-height: 1.2; font-weight: 500;
    }
    .monitoring-head p { margin: 0; color: var(--os-text-sec, #4a5568); font-size: .78rem; }
    .monitoring-head .eyebrow {
      color: var(--os-brand-500, #4c6fff); font-size: .64rem;
      font-weight: 700; letter-spacing: .08em;
    }
    .monitoring-note {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      margin: .75rem 0; padding: .55rem .75rem; border-left: 3px solid #2e7d32;
      background: #f4faf5; color: #294833; font-size: .72rem;
    }
    .monitoring-note > div:first-child { display: flex; align-items: baseline; gap: .55rem; min-width: 0; }
    .monitoring-note .origin { display: flex; align-items: center; gap: .4rem; white-space: nowrap; }
    .status-dot { width: .48rem; height: .48rem; border-radius: 50%; background: #2e7d32; }
    code { font-family: var(--os-font-mono, Consolas, monospace); font-size: .7rem; }
    .dashboard-workspace {
      min-width: 0; border: 1px solid var(--os-border, #d4d8e0); background: #fff;
    }
    .dashboard-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      min-height: 4.2rem; padding: .6rem .85rem; border-bottom: 1px solid var(--os-border, #d4d8e0);
      background: var(--os-bg, #fff);
    }
    .dashboard-title { min-width: 0; }
    .dashboard-title p { margin: 0; color: var(--os-brand-500, #4c6fff); font-size: .62rem; font-weight: 700; text-transform: uppercase; }
    .dashboard-title h2 { margin: .08rem 0; color: var(--os-ink, #1b2438); font-size: 1rem; font-weight: 500; }
    .dashboard-title span {
      display: block; color: var(--os-muted, #667193); font-size: .68rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dashboard-controls { display: flex; align-items: flex-end; gap: .45rem; flex: 0 0 auto; }
    .dashboard-controls label { display: flex; flex-direction: column; gap: .12rem; font-size: .64rem; color: var(--os-muted, #667193); }
    .dashboard-controls select {
      min-width: 6rem; height: 1.8rem; padding: 0 .35rem; border: 1px solid var(--os-border, #d4d8e0);
      background: #fff; color: var(--os-ink, #1b2438); font-size: .7rem;
    }
    .certificate-help {
      display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem;
      padding: .42rem .55rem .42rem .8rem; background: #fff8e1; border-bottom: 1px solid #f1dfaa;
      color: #5f4b17; font-size: .67rem;
    }
    .certificate-copy { display: flex; align-items: baseline; gap: .45rem; min-width: 0; }
    .certificate-close { flex: 0 0 auto; margin: -.25rem 0; color: #5f4b17; }
    .dashboard-frame { position: relative; min-height: calc(100vh - 15rem); background: #f3f5f7; overflow: hidden; }
    .dashboard-frame iframe {
      display: block; width: 100%; height: calc(100vh - 15rem); min-height: 44rem;
      border: 0; background: #fff;
    }
    .frame-loading {
      position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: .5rem;
      background: #f7f8fa; color: var(--os-muted, #667193); font-size: .78rem;
    }
    .dashboard-frame:not(.loading) .frame-loading { display: none; }
    @media (max-width: 900px) {
      .monitoring-head, .monitoring-note { align-items: flex-start; flex-direction: column; }
      .dashboard-toolbar { align-items: flex-start; flex-direction: column; }
      .dashboard-controls { width: 100%; flex-wrap: wrap; }
      .dashboard-title span { white-space: normal; }
      .certificate-copy { align-items: flex-start; flex-direction: column; gap: .15rem; }
    }
  `],
})
export class CephMonitoringComponent {
  readonly dashboardUid = input(CEPH_DASHBOARDS[0].uid);
  readonly cephLogo = 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/ceph.svg';
  readonly grafanaOriginLabel = `${CEPH_GRAFANA_ORIGIN}${CEPH_GRAFANA_BASE_PATH}`;
  readonly grafanaCatalogUrl = `${this.grafanaOriginLabel}/dashboards`;
  readonly selected = computed(() =>
    CEPH_DASHBOARDS.find(dashboard => dashboard.uid === this.dashboardUid()) ?? CEPH_DASHBOARDS[0]);
  readonly range = signal('now-6h');
  readonly refresh = signal('30s');
  readonly frameNonce = signal(0);
  readonly frameLoaded = signal(false);
  readonly certificateHelpVisible = signal(this.readCertificateHelpVisibility());

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

  readonly externalDashboardUrl = computed(() => this.buildDashboardUrl(false));
  readonly dashboardUrl = computed<SafeResourceUrl>(() =>
    this.sanitizer.bypassSecurityTrustResourceUrl(this.buildDashboardUrl(true)));

  constructor(private readonly sanitizer: DomSanitizer) {}

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

  dismissCertificateHelp(): void {
    this.certificateHelpVisible.set(false);
    try {
      globalThis.sessionStorage?.setItem(CERTIFICATE_HELP_DISMISSED_KEY, '1');
    } catch {
      // Storage가 차단되어도 현재 화면에서는 안내를 닫을 수 있어야 한다.
    }
  }

  private readCertificateHelpVisibility(): boolean {
    try {
      return globalThis.sessionStorage?.getItem(CERTIFICATE_HELP_DISMISSED_KEY) !== '1';
    } catch {
      return true;
    }
  }

  private buildDashboardUrl(includeNonce: boolean): string {
    const dashboard = this.selected();
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
    return `${CEPH_GRAFANA_ORIGIN}${CEPH_GRAFANA_BASE_PATH}/d/${encodeURIComponent(dashboard.uid)}/${encodeURIComponent(dashboard.slug)}?${params.toString()}`;
  }
}
