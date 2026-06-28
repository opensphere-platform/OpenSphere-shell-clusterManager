import { CommonModule } from '@angular/common';
import { Component, ViewEncapsulation, signal, computed, inject } from '@angular/core';
import { NAV, NavItem, NavGroup } from './nav';
import { NAV_ICON } from './nav-icons';
import { OverviewComponent } from './resources/overview.component';
import { K8sService } from './core/k8s.service';

// ShadowDom 인캡슐레이션 → 컴포넌트와 Clarity CSS가 shadow root에 격리(자체완결, 셸 CSS 영향 0).
// 인덱스 = Cluster Overview. 사이드바 = 표준 2단 보조 내비(.cc-secondbar, /containers/overview 템플릿).
// 뷰 스코프(Cluster ↔ VM): OKD-perspective-binding §7.1 — VM을 별도 perspective로 만들지 않고
// perspective 2(K8s Cluster) 내부의 "뷰 스코프"로 가른다. KubeVirt CRD 존재 시에만 VM 스코프 노출(capability-gate).
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, OverviewComponent],
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrls: ['./app.component.css'],
  styles: [`
    /* ── 표준 2단 보조 내비(콘솔 /containers/overview 템플릿과 동일: 라이트 .cc-secondbar) ──
       ShadowDom이라 셸 토큰이 :host의 다크값에 가려질 수 있어, 표준 라이트 팔레트를 명시값으로 고정. */
    .cc-secondbar { flex: 0 0 15.75rem; width: 15.75rem; overflow-y: auto; background: #fff; border-inline-end: 1px solid #e0e0e0; }
    .cc-title { display: flex; align-items: center; gap: 0.5rem; min-height: 3.25rem; padding-inline: 1rem; border-block-end: 1px solid #e0e0e0; }
    .cc-title strong { font-size: 0.875rem; font-weight: 600; color: #161616; }
    .cc-badge { font-size: 0.6rem; font-weight: 600; color: #4c6fff; background: rgba(76,111,255,0.12); padding: 0.05rem 0.35rem; border-radius: 3px; }

    .cc-scope { padding: 0.6rem 1rem 0.4rem; }
    .cc-scope-label { display: block; font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8c8c8c; margin-bottom: 0.25rem; }
    .cc-scope-sel { width: 100%; font-size: 0.8rem; padding: 0.35rem 0.4rem; border: 1px solid #e0e0e0; border-radius: 4px; background: #f4f4f4; color: #161616; cursor: pointer; font-family: inherit; }
    .cc-scope-sel option { color: #161616; }

    .cc-items { padding-bottom: 0.5rem; }
    .cc-item {
      display: grid; grid-template-columns: 1rem minmax(0,1fr) auto; column-gap: 0.5rem; align-items: center;
      width: 100%; min-height: 2.25rem; padding: 0.5rem 1rem; border: 0; background: transparent; text-align: left;
      color: #525252; font-size: 0.875rem; font-family: inherit; text-decoration: none; cursor: pointer; border-left: 3px solid transparent;
    }
    .cc-item:hover { background: #e8e8e8; color: #161616; }
    .cc-item.is-active { background: #e8e8e8; color: #161616; font-weight: 600; border-left-color: #4c6fff; }
    .cc-ic { width: 1rem; height: 1rem; fill: currentColor; opacity: 0.85; }
    .cc-chev { width: 1rem; height: 1rem; fill: #8c8c8c; transition: transform 0.12s; }
    .cc-chev.is-open { transform: rotate(90deg); }

    .cc-nested { display: none; }
    .cc-group.is-open > .cc-nested { display: block; }
    .cc-group:has(.cc-child.is-active) > .cc-nested { display: block; }
    .cc-child {
      display: block; padding: 0.45rem 1rem 0.45rem 2.55rem; color: #525252; font-size: 0.84rem;
      text-decoration: none; cursor: pointer; border-left: 3px solid transparent;
    }
    .cc-child:hover { background: #e8e8e8; color: #161616; }
    .cc-child.is-active { background: #e8e8e8; color: #161616; font-weight: 600; border-left-color: #4c6fff; }

    /* 페이지 경로(breadcrumb) — 표준 os-breadcrumb와 동일(비-현재=accent, 현재=ink, '/' 구분). */
    .cc-crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.85rem; font-size: 0.8rem; }
    .cc-crumb { color: #4c6fff; }
    .cc-crumb.is-cur { color: #161616; }
    .cc-crumb-sep { color: #8c8c8c; }
  `],
  template: `
    <div class="os-shell">
      <!-- 표준 2단 보조 내비(콘솔 /containers/overview 템플릿 방식) — 라이트 .cc-secondbar 트리 -->
      <nav class="cc-secondbar" aria-label="K8s Console 보조 내비">
        <!-- 브랜드 헤더 -->
        <div class="cc-title"><strong>K8s Console</strong><span class="cc-badge">Angular</span></div>

        <!-- 뷰 스코프 콤보(Cluster ↔ VM) — KubeVirt VirtualMachine CRD 존재 시에만 노출(capability-gate). -->
        <div class="cc-scope" *ngIf="vmCapable()">
          <span class="cc-scope-label">View</span>
          <select class="cc-scope-sel" (change)="setScope($any($event.target).value)">
            <option value="cluster" [selected]="viewScope() === 'cluster'">Cluster</option>
            <option value="vm" [selected]="viewScope() === 'vm'">Virtual Machines</option>
          </select>
        </div>

        <div class="cc-items" role="menu">
          <!-- 개요(인덱스) — 단독 항목 -->
          <a class="cc-item" [class.is-active]="active().id === 'overview'" tabindex="0"
             (click)="select(OVERVIEW)" (keydown.enter)="select(OVERVIEW)">
            <svg viewBox="0 0 24 24" class="cc-ic"><path [attr.d]="icon('overview')"/></svg>
            <span class="lbl">Overview</span>
          </a>

          <!-- 현재 스코프 그룹(filteredNav) — 트리(접기/펼치기) -->
          <div class="cc-group" *ngFor="let g of filteredNav()" [class.is-open]="isOpen(g.group)">
            <button type="button" class="cc-item cc-group-title"
                (click)="setOpen(g.group, !isOpen(g.group))" [attr.aria-expanded]="isOpen(g.group)">
              <svg viewBox="0 0 24 24" class="cc-ic"><path [attr.d]="secIcon(g.group)"/></svg>
              <span class="lbl">{{ g.group }}</span>
              <svg viewBox="0 0 24 24" class="cc-chev" [class.is-open]="isOpen(g.group)"><path d="M9 6l6 6-6 6z"/></svg>
            </button>
            <div class="cc-nested">
              <a *ngFor="let it of g.items" class="cc-child" tabindex="0"
                 [class.is-active]="active().id === it.id"
                 (click)="select(it)" (keydown.enter)="select(it)">{{ it.label }}</a>
            </div>
          </div>
        </div>
      </nav>

      <section class="os-content">
        <!-- 페이지 경로(breadcrumb) — 표준 템플릿(/containers/overview)과 동일한 경로 표시 -->
        <nav class="cc-crumbs" aria-label="페이지 경로">
          <ng-container *ngFor="let c of crumbs(); let last = last">
            <span class="cc-crumb" [class.is-cur]="last">{{ c }}</span>
            <span class="cc-crumb-sep" *ngIf="!last">/</span>
          </ng-container>
        </nav>
        <app-overview *ngIf="active().id === 'overview'" (open)="openId($event)"></app-overview>
        <ng-container *ngIf="active().id !== 'overview'" [ngComponentOutlet]="active().component"></ng-container>
      </section>
    </div>
  `,
})
export class AppComponent {
  private k8s = inject(K8sService);

  readonly OVERVIEW: NavItem = { id: 'overview', label: 'Overview', component: OverviewComponent };
  readonly active = signal<NavItem>(this.OVERVIEW);
  /** 펼쳐진 섹션(기본: 전부 접힘) */
  readonly expanded = signal<Set<string>>(new Set());

  /** 뷰 스코프: Cluster(코어 K8s) ↔ VM(KubeVirt). 콤보로 전환(§7.1 통합 콤보 뷰). */
  readonly viewScope = signal<'cluster' | 'vm'>('cluster');
  /** 클러스터에 실제 존재하는 apiGroup 집합(GET /apis 디스커버리) — nav 항목별 capability-gate·VM 스코프 결정. */
  readonly availableGroups = signal<Set<string>>(new Set());
  /** capability-gate: kubevirt.io 그룹이 실재할 때만 VM 스코프(콤보) 활성. §3.3 실재만 노출. */
  readonly vmCapable = computed(() => this.availableGroups().has('kubevirt.io'));

  /** 현재 스코프 그룹 + **항목별 capability-gate**(it.requires apiGroup이 클러스터에 실재할 때만) + 빈 그룹 숨김.
   *  → 실 CRD가 있는 페이지만 노출(없으면 자동 숨김). 더미·phantom 없음(§3.3 — 실구현된 것만). */
  readonly filteredNav = computed<NavGroup[]>(() => {
    const avail = this.availableGroups();
    const inScope = (g: NavGroup) => (this.viewScope() === 'vm' ? g.scope === 'vm' : g.scope !== 'vm');
    return NAV
      .filter(inScope)
      .map(g => ({ ...g, items: g.items.filter(it => !it.requires || avail.has(it.requires)) }))
      .filter(g => g.items.length > 0);
  });

  /** 페이지 경로(breadcrumb) — [perspective] / [group] / [active]. 표준 템플릿 경로 표시와 동일. */
  readonly crumbs = computed<string[]>(() => {
    const a = this.active();
    const root = '2. K8s Cluster + Ceph';
    if (a.id === 'overview') return [root, 'Overview'];
    const g = this.filteredNav().find((x) => x.items.some((it) => it.id === a.id));
    return g ? [root, g.group, a.label] : [root, a.label];
  });

  constructor() {
    // CRD 디스커버리 → 전체 CRD의 spec.group 집합으로 capability-gate(item.requires).
    // (bare GET /apis는 백엔드 k8s 프록시가 400 거부 → 프록시가 허용하는 CRD 목록을 사용. requires는 전부 CRD apiGroup이라 충분.)
    this.k8s
      .get<{ items?: Array<{ spec?: { group?: string } }> }>('/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
      .subscribe({
        next: d => this.availableGroups.set(
          new Set((d.items ?? []).map(c => c.spec?.group).filter((g): g is string => !!g)),
        ),
        error: () => this.availableGroups.set(new Set()),
      });
    this.applyUrlState();
  }

  /** 콤보 전환 — 스코프 변경 + 활성 뷰를 새 스코프 기본으로 리셋(스코프 밖 stale 콘텐츠 방지). */
  setScope(scope: 'cluster' | 'vm') {
    if (scope === this.viewScope()) return;
    this.viewScope.set(scope);
    if (scope === 'vm') {
      const g = NAV.find(x => x.scope === 'vm');
      if (g && g.items[0]) { this.expanded.update(s => new Set(s).add(g.group)); this.active.set(g.items[0]); }
    } else {
      this.active.set(this.OVERVIEW);
    }
    this.syncUrl();
  }

  select(it: NavItem) { this.active.set(it); this.syncUrl(); }
  icon(id: string) { return NAV_ICON[id] || NAV_ICON['fallback']; }
  secIcon(group: string) { return NAV_ICON['sec:' + group] || NAV_ICON['fallback']; }
  isOpen(group: string) { return this.expanded().has(group); }
  setOpen(group: string, open: boolean) {
    this.expanded.update(s => { const n = new Set(s); open ? n.add(group) : n.delete(group); return n; });
  }
  /** 개요 카드/링크 클릭 → 항목 id로 이동(없으면 무시). vm 스코프 항목이면 스코프도 전환. */
  openId(id: string) {
    if (id === 'overview') { this.viewScope.set('cluster'); this.active.set(this.OVERVIEW); this.syncUrl(); return; }
    for (const g of NAV) {
      const it = g.items.find(x => x.id === id);
      if (it) {
        if (g.scope === 'vm') { if (!this.vmCapable()) return; this.viewScope.set('vm'); }
        else { this.viewScope.set('cluster'); }
        this.expanded.update(s => new Set(s).add(g.group));
        this.active.set(it);
        this.syncUrl();
        return;
      }
    }
  }

  // ── 공유 가능한 URL: 뷰 스코프(view) + 활성 리소스(res)를 쿼리 파라미터로 동기화 ──
  // 셸 경로(/p/cluster-manager)는 보존하고 쿼리만 갱신(replaceState — 셸 라우터 popstate 미발화).
  private applyUrlState(): void {
    try {
      const p = new URLSearchParams(window.location.search);
      const view = p.get('view'); const res = p.get('res');
      if (view === 'vm' || view === 'cluster') this.viewScope.set(view);
      if (res === 'overview') { this.active.set(this.OVERVIEW); }
      else if (res) {
        for (const g of NAV) {
          const it = g.items.find(x => x.id === res);
          if (it) { this.active.set(it); if (g.scope === 'vm') this.viewScope.set('vm'); this.expanded.update(s => new Set(s).add(g.group)); break; }
        }
      }
    } catch { /* noop */ }
  }
  private syncUrl(): void {
    try {
      const p = new URLSearchParams(window.location.search);
      p.set('view', this.viewScope()); p.set('res', this.active().id);
      history.replaceState(history.state, '', window.location.pathname + '?' + p.toString() + window.location.hash);
    } catch { /* noop */ }
  }
}
