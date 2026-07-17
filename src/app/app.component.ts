import { CommonModule } from '@angular/common';
import { Component, ViewEncapsulation, signal, computed, inject, OnDestroy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { NAV, NavItem, NavGroup, ManagementView } from './nav';
import { NAV_ICON } from './nav-icons';
import { OverviewComponent } from './resources/overview.component';
import { K8sService } from './core/k8s.service';

// ShadowDom 인캡슐레이션 → 컴포넌트와 Clarity CSS가 shadow root에 격리(자체완결, 셸 CSS 영향 0).
// 인덱스 = Cluster Overview. 사이드바 = 표준 2단 보조 내비(.cc-secondbar, /containers/overview 템플릿).
// 관리 관점(Kubernetes / Ceph / HIS): 서로 다른 운영 책임을 하나의 메뉴 트리로 섞지 않는다.
// KubeVirt는 Kubernetes 관점 안에서 capability-gate로 노출한다.
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ClarityModule, OverviewComponent],
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrls: ['./app.component.css'],
  styles: [`
    /* ── 표준 2단 보조 내비 — OpenSphere AI Hub(/p/ai) 방식: Clarity clr-vertical-nav, 흰 배경, 왼쪽 blue bar active ── */
    .cm-nav { min-height: 100vh; background: #ffffff; }
    .cm-nav clr-vertical-nav-group,
    .cm-nav .nav-group,
    .cm-nav .nav-group-content,
    .cm-nav .nav-group-children { background: transparent; }
    .cm-nav a[clrVerticalNavLink],
    .cm-nav .nav-link,
    .cm-nav .nav-trigger { color: var(--clr-vertical-nav-item-color, #1b2438); font-size: 0.72rem; }
    .cm-nav a[clrVerticalNavLink]:hover,
    .cm-nav .nav-link:hover,
    .cm-nav .nav-trigger:hover { color: #1b2438; background: rgba(0, 0, 0, 0.04); }
    /* active = 왼쪽 blue bar 하나만(중복/외곽 표시 제거) */
    .cm-nav a[clrVerticalNavLink]::before,
    .cm-nav .nav-link::before { display: none !important; content: none !important; }
    .cm-nav a[clrVerticalNavLink].active,
    .cm-nav .nav-link.active {
      color: #1b2438; font-weight: 600;
      background: rgba(76, 111, 255, 0.10);
      box-shadow: inset 3px 0 0 #4c6fff;
    }

    .cm-brand { display: flex; align-items: center; gap: 0.35rem; min-height: 3.05rem; padding: 0.55rem 0.9rem; color: #1b2438; border-bottom: 1px solid #e0e0e0; }
    .cm-brand strong { font-size: 0.78rem; font-weight: 600; }
    .cm-brand .label { font-size: 0.58rem; }

    /* 관리 관점 = Clarity Select(clr-select-wrapper + clr-select). 항상 노출, 풀폭. */
    .cm-scope { padding: 0.5rem 0.9rem 0.45rem; }
    .cm-scope-label { display: block; margin-bottom: 0.2rem; color: #666; font-size: 0.58rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .cm-scope .clr-select-wrapper { width: 100%; }
    .cm-scope .clr-select { width: 100%; }

    /* 페이지 경로 — AI Hub 표준: 상단 회색 박스 바(좌우 풀폭). negative margin = .os-content 패딩(1.1rem 1.4rem)과 동일. */
    .cc-crumbs {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; min-height: 2rem;
      margin: -1.1rem -1.4rem 0.9rem; padding: 0.45rem 1.4rem;
      background: #f4f4f4; border-top: 1px solid #d0d0d0; border-bottom: 1px solid #d0d0d0;
      font-size: 0.8125rem; line-height: 1rem;
    }
    .cc-crumb { color: #525252; }
    .cc-crumb-link { color: #4c6fff; text-decoration: none; cursor: pointer; }
    .cc-crumb-link:hover { text-decoration: underline; }
    .cc-crumb.is-cur { color: #525252; }
    .cc-crumb-sep { color: #8c8c8c; }
  `],
  template: `
    <div class="os-shell">
      <!-- 표준 2단 보조 내비 — AI Hub(/p/ai) 방식: Clarity clr-vertical-nav(흰 배경, 12rem, 왼쪽 blue bar) -->
      <clr-vertical-nav class="cm-nav" [clrVerticalNavCollapsible]="false" aria-label="Cluster Manager 보조 내비">
        <!-- 브랜드 -->
        <div class="cm-brand"><strong>Cluster Manager</strong><span class="label label-info">{{ viewBadge() }}</span></div>

        <!-- 최상위 관리 관점: K8s / Ceph / HIS. 설치 여부와 무관하게 항상 진입 가능. -->
        <div class="cm-scope">
          <label class="cm-scope-label" for="cm-management-view">Management view</label>
          <div class="clr-select-wrapper">
            <select id="cm-management-view" class="clr-select" aria-label="관리 관점 선택" [value]="viewScope()" (change)="setScope($any($event.target).value)">
              <option value="k8s">Kubernetes</option>
              <option value="ceph">Ceph Storage</option>
              <option value="his">HIS Prerequisites</option>
            </select>
          </div>
        </div>

        <!-- Kubernetes 개요(인덱스). Ceph/HIS는 각 전문 화면을 기본 진입점으로 사용한다. -->
        <a *ngIf="viewScope() === 'k8s'" clrVerticalNavLink [class.active]="active().id === 'overview'"
           (click)="select(OVERVIEW)" (keydown.enter)="select(OVERVIEW)">
          Overview
        </a>

        <!-- 현재 스코프 그룹(filteredNav) — clr-vertical-nav-group -->
        <clr-vertical-nav-group *ngFor="let g of filteredNav()"
            [clrVerticalNavGroupExpanded]="isOpen(g.group)"
            (clrVerticalNavGroupExpandedChange)="setOpen(g.group, $event)">
          <svg viewBox="0 0 24 24" class="os-tree-ic" clrVerticalNavIcon><path [attr.d]="secIcon(g.group)"/></svg>
          {{ g.group }}
          <clr-vertical-nav-group-children>
            <a *ngFor="let it of g.items" clrVerticalNavLink
               [class.active]="active().id === it.id"
               (click)="select(it)" (keydown.enter)="select(it)">{{ it.label }}</a>
          </clr-vertical-nav-group-children>
        </clr-vertical-nav-group>
      </clr-vertical-nav>

      <section class="os-content">
        <!-- 페이지 경로(breadcrumb) — 비-현재 크럼브는 링크(AI Hub 방식). -->
        <nav class="cc-crumbs" aria-label="페이지 경로">
          <ng-container *ngFor="let c of crumbs(); let last = last">
            <a *ngIf="c.link === 'home'" class="cc-crumb cc-crumb-link" href="/">{{ c.label }}</a>
            <a *ngIf="c.link && c.link !== 'home'" class="cc-crumb cc-crumb-link" (click)="crumbNav(c)">{{ c.label }}</a>
            <span *ngIf="!c.link" class="cc-crumb is-cur">{{ c.label }}</span>
            <span class="cc-crumb-sep" *ngIf="!last">/</span>
          </ng-container>
        </nav>
        <app-overview *ngIf="viewScope() === 'k8s' && active().id === 'overview'" (open)="openId($event)"></app-overview>
        <ng-container *ngIf="active().id !== 'overview'" [ngComponentOutlet]="active().component"></ng-container>
      </section>
    </div>
  `,
})
export class AppComponent implements OnDestroy {
  private k8s = inject(K8sService);
  private readonly onPopState = () => this.applyUrlState();

  readonly OVERVIEW: NavItem = { id: 'overview', label: 'Overview', component: OverviewComponent };
  readonly active = signal<NavItem>(this.OVERVIEW);
  /** 펼쳐진 섹션(기본: 전부 접힘) */
  readonly expanded = signal<Set<string>>(new Set());

  /** 최상위 관리 관점: Kubernetes / Ceph / HIS. */
  readonly viewScope = signal<ManagementView>('k8s');
  /** 클러스터에 실제 존재하는 apiGroup 집합(GET /apis 디스커버리) — nav 항목별 capability-gate·VM 스코프 결정. */
  readonly availableGroups = signal<Set<string>>(new Set());
  /** 현재 관리 관점 그룹 + **항목별 capability-gate**(it.requires apiGroup이 클러스터에 실재할 때만) + 빈 그룹 숨김.
   *  → 실 CRD가 있는 페이지만 노출(없으면 자동 숨김). 더미·phantom 없음(§3.3 — 실구현된 것만). */
  readonly filteredNav = computed<NavGroup[]>(() => {
    const avail = this.availableGroups();
    return NAV
      .filter(g => (g.view ?? 'k8s') === this.viewScope())
      .map(g => ({ ...g, items: g.items.filter(it => !it.requires || avail.has(it.requires)) }))
      .filter(g => g.items.length > 0);
  });

  /** 페이지 경로(breadcrumb) — [perspective] / [group] / [active]. 표준 템플릿 경로 표시와 동일. */
  /** 페이지 경로 — 비-현재는 링크(home=콘솔/, overview=셸 루트, group=그룹 첫 항목). 현재는 link:null. */
  readonly crumbs = computed<{ label: string; link: 'home' | 'overview' | 'group' | null; groupId?: string }[]>(() => {
    const a = this.active();
    const root = 'Cluster Manager';
    const out: { label: string; link: 'home' | 'overview' | 'group' | null; groupId?: string }[] = [{ label: 'OpenSphere', link: 'home' }];
    out.push({ label: root, link: 'overview' });
    if (a.id === 'overview') { out.push({ label: this.viewLabel(), link: null }); return out; }
    out.push({ label: this.viewLabel(), link: 'overview' });
    const g = this.filteredNav().find((x) => x.items.some((it) => it.id === a.id));
    if (g) out.push({ label: g.group, link: 'group', groupId: g.group });
    out.push({ label: a.label, link: null });
    return out;
  });
  /** 크럼브 클릭 이동(home은 anchor href로 처리). */
  crumbNav(c: { link: 'home' | 'overview' | 'group' | null; groupId?: string }): void {
    if (c.link === 'overview') { this.goViewHome(this.viewScope()); return; }
    if (c.link === 'group' && c.groupId) {
      const g = this.filteredNav().find((x) => x.group === c.groupId);
      if (g?.items[0]) { this.setOpen(g.group, true); this.select(g.items[0]); }
    }
  }

  constructor() {
    // CRD 디스커버리 → 전체 CRD의 spec.group 집합으로 capability-gate(item.requires).
    // (bare GET /apis는 백엔드 k8s 프록시가 400 거부 → 프록시가 허용하는 CRD 목록을 사용. requires는 전부 CRD apiGroup이라 충분.)
    this.k8s
      .get<{ items?: Array<{ spec?: { group?: string } }> }>('/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
      .subscribe({
        next: d => {
          this.availableGroups.set(new Set((d.items ?? []).map(c => c.spec?.group).filter((g): g is string => !!g)));
          // capability 목록이 준비된 뒤 VM/MTV/CSI deep-link를 다시 해석한다.
          this.applyUrlState();
        },
        error: () => this.availableGroups.set(new Set()),
      });
    this.applyUrlState();
    window.addEventListener('popstate', this.onPopState);
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPopState);
  }

  /** 콤보 전환 — 관점 변경 + 해당 전문 화면의 기본 진입점으로 이동. */
  setScope(scope: ManagementView) {
    if (!['k8s', 'ceph', 'his'].includes(scope)) return;
    if (scope === this.viewScope()) return;
    this.viewScope.set(scope);
    this.activateViewHome(scope);
    this.syncUrl();
  }

  select(it: NavItem) { this.active.set(it); this.syncUrl(); }
  /** 그룹 헤더 아이콘(최종 메뉴는 아이콘 미사용 — leaf는 호출 안 함). */
  secIcon(group: string) { return NAV_ICON['sec:' + group] || NAV_ICON['fallback']; }
  isOpen(group: string) { return this.expanded().has(group); }
  setOpen(group: string, open: boolean) {
    this.expanded.update(s => { const n = new Set(s); open ? n.add(group) : n.delete(group); return n; });
  }
  /** 개요 카드/링크 클릭 → 항목 id로 이동(없으면 무시). 대상의 관리 관점도 함께 전환. */
  openId(id: string) {
    if (id === 'overview') { this.goViewHome('k8s'); return; }
    for (const g of NAV) {
      const it = g.items.find(x => x.id === id);
      if (it) {
        if (it.requires && !this.availableGroups().has(it.requires)) return;
        this.viewScope.set(g.view ?? 'k8s');
        this.expanded.update(s => new Set(s).add(g.group));
        this.active.set(it);
        this.syncUrl();
        return;
      }
    }
  }

  // ── 공유 가능한 URL: 표준 = `/p/<id>/서브패스` + pushState/popstate(§OpenSphere-console/app.routes.ts
  // pluginHostMatcher, OpenSphere-shell-ai의 원조 구현과 동형). 관리 관점(view)/활성 리소스(res)를
  // `/p/cluster-manager/<k8s|ceph|his>/<resId>` 경로로 인코딩 — 콘솔 라우터는 `id`만 보므로 재마운트되지 않는다.
  // (구 쿼리 파라미터+replaceState 방식은 popstate를 피하려던 과잉 안전장치였음이 밝혀져 폐기 — 뒤로가기 지원.)
  private static readonly BASE = '/p/cluster-manager';

  /** 콘솔 경로 중 'cluster-manager' 세그먼트 뒤(서브패스)만 취함 — 접두사 변경에 안전. */
  private currentUiRoute(): string {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('cluster-manager');
    return idx >= 0 ? parts.slice(idx + 1).join('/') : '';
  }

  private applyUrlState(): void {
    try {
      const [view, res] = this.currentUiRoute().split('/');
      const targetView: ManagementView = view === 'ceph' || view === 'his' || view === 'k8s' ? view : 'k8s';
      this.viewScope.set(targetView);
      if (!res || res === 'overview') { this.activateViewHome(targetView); }
      else {
        for (const g of NAV) {
          const it = g.items.find(x => x.id === res);
          const itemView = g.view ?? 'k8s';
          if (it && itemView === targetView && (!it.requires || this.availableGroups().has(it.requires))) {
            this.active.set(it);
            this.expanded.update(s => new Set(s).add(g.group));
            return;
          }
        }
        this.activateViewHome(targetView);
      }
    } catch { /* noop */ }
  }
  private syncUrl(): void {
    try {
      const atDefault = this.viewScope() === 'k8s' && this.active().id === this.OVERVIEW.id;
      const nextUrl = atDefault ? AppComponent.BASE : `${AppComponent.BASE}/${this.viewScope()}/${this.active().id}`;
      if (window.location.pathname === nextUrl) return;
      history.pushState(null, '', nextUrl + window.location.search + window.location.hash);
    } catch { /* noop */ }
  }

  viewLabel(view: ManagementView = this.viewScope()): string {
    return view === 'k8s' ? 'Kubernetes' : view === 'ceph' ? 'Ceph Storage' : 'HIS Prerequisites';
  }
  viewBadge(): string { return this.viewScope() === 'k8s' ? 'K8s' : this.viewScope() === 'ceph' ? 'Ceph' : 'HIS'; }

  private goViewHome(view: ManagementView): void {
    this.viewScope.set(view);
    this.activateViewHome(view);
    this.syncUrl();
  }

  private activateViewHome(view: ManagementView): void {
    if (view === 'k8s') { this.active.set(this.OVERVIEW); return; }
    const group = NAV.find(g => (g.view ?? 'k8s') === view);
    const item = group?.items.find(it => !it.requires || this.availableGroups().has(it.requires));
    if (group && item) {
      this.expanded.update(s => new Set(s).add(group.group));
      this.active.set(item);
    }
  }
}
