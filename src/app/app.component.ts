import { CommonModule } from '@angular/common';
import { Component, ViewEncapsulation, signal, computed, inject, OnDestroy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
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

    /* 뷰 스코프 = Clarity Select(clr-select-wrapper + clr-select). 라벨 없음(요청). 풀폭. */
    .cm-scope { padding: 0.5rem 0.9rem 0.45rem; }
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
      <clr-vertical-nav class="cm-nav" [clrVerticalNavCollapsible]="false" aria-label="K8s Console 보조 내비">
        <!-- 브랜드 -->
        <div class="cm-brand"><strong>K8s Console</strong><span class="label label-info">Angular</span></div>

        <!-- 뷰 스코프 콤보(Cluster ↔ VM) — KubeVirt CRD 존재 시에만 노출(capability-gate). -->
        <div class="cm-scope" *ngIf="vmCapable()">
          <div class="clr-select-wrapper">
            <select class="clr-select" aria-label="뷰 스코프(Cluster/Virtual Machines)" (change)="setScope($any($event.target).value)">
              <option value="cluster" [selected]="viewScope() === 'cluster'">Cluster</option>
              <option value="vm" [selected]="viewScope() === 'vm'">Virtual Machines</option>
            </select>
          </div>
        </div>

        <!-- 개요(인덱스) — 단독 leaf. 최종(이동) 메뉴는 아이콘 미사용(원칙). -->
        <a clrVerticalNavLink [class.active]="active().id === 'overview'"
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
        <app-overview *ngIf="active().id === 'overview'" (open)="openId($event)"></app-overview>
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
  /** 페이지 경로 — 비-현재는 링크(home=콘솔/, overview=셸 루트, group=그룹 첫 항목). 현재는 link:null. */
  readonly crumbs = computed<{ label: string; link: 'home' | 'overview' | 'group' | null; groupId?: string }[]>(() => {
    const a = this.active();
    const root = '2. K8s Cluster + Ceph';
    const out: { label: string; link: 'home' | 'overview' | 'group' | null; groupId?: string }[] = [{ label: 'OpenSphere', link: 'home' }];
    if (a.id === 'overview') { out.push({ label: root, link: null }); return out; }
    out.push({ label: root, link: 'overview' });
    const g = this.filteredNav().find((x) => x.items.some((it) => it.id === a.id));
    if (g) out.push({ label: g.group, link: 'group', groupId: g.group });
    out.push({ label: a.label, link: null });
    return out;
  });
  /** 크럼브 클릭 이동(home은 anchor href로 처리). */
  crumbNav(c: { link: 'home' | 'overview' | 'group' | null; groupId?: string }): void {
    if (c.link === 'overview') { this.select(this.OVERVIEW); return; }
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
        next: d => this.availableGroups.set(
          new Set((d.items ?? []).map(c => c.spec?.group).filter((g): g is string => !!g)),
        ),
        error: () => this.availableGroups.set(new Set()),
      });
    this.applyUrlState();
    window.addEventListener('popstate', this.onPopState);
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPopState);
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
  /** 그룹 헤더 아이콘(최종 메뉴는 아이콘 미사용 — leaf는 호출 안 함). */
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

  // ── 공유 가능한 URL: 표준 = `/p/<id>/서브패스` + pushState/popstate(§OpenSphere-console/app.routes.ts
  // pluginHostMatcher, OpenSphere-shell-ai의 원조 구현과 동형). 뷰 스코프(view)/활성 리소스(res)를
  // `/p/cluster-manager/<view>/<resId>` 경로로 인코딩 — 콘솔 라우터는 `id`만 보므로 재마운트되지 않는다.
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
      if (view === 'vm' || view === 'cluster') this.viewScope.set(view);
      if (!res || res === 'overview') { this.active.set(this.OVERVIEW); }
      else {
        for (const g of NAV) {
          const it = g.items.find(x => x.id === res);
          if (it) { this.active.set(it); if (g.scope === 'vm') this.viewScope.set('vm'); this.expanded.update(s => new Set(s).add(g.group)); break; }
        }
      }
    } catch { /* noop */ }
  }
  private syncUrl(): void {
    try {
      const atDefault = this.viewScope() === 'cluster' && this.active().id === this.OVERVIEW.id;
      const nextUrl = atDefault ? AppComponent.BASE : `${AppComponent.BASE}/${this.viewScope()}/${this.active().id}`;
      if (window.location.pathname === nextUrl) return;
      history.pushState(null, '', nextUrl + window.location.search + window.location.hash);
    } catch { /* noop */ }
  }
}
