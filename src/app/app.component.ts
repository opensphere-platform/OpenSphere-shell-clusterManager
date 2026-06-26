import { CommonModule } from '@angular/common';
import { Component, ViewEncapsulation, signal, computed, inject } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { NAV, NavItem, NavGroup } from './nav';
import { NAV_ICON } from './nav-icons';
import { OverviewComponent } from './resources/overview.component';
import { K8sService } from './core/k8s.service';

// ShadowDom 인캡슐레이션 → 컴포넌트와 Clarity CSS가 shadow root에 격리(자체완결, 셸 CSS 영향 0).
// 인덱스 = Cluster Overview. 사이드바 = Clarity clr-vertical-nav + groups.
// 뷰 스코프(Cluster ↔ VM): OKD-perspective-binding §7.1 — VM을 별도 perspective로 만들지 않고
// perspective 2(K8s Cluster) 내부의 "뷰 스코프"로 가른다. KubeVirt CRD 존재 시에만 VM 스코프 노출(capability-gate).
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ClarityModule, OverviewComponent],
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrls: ['./app.component.css'],
  styles: [`
    .os-scope { padding: 0.5rem 0.6rem 0.3rem; }
    .os-scope-label { display: block; font-size: 0.58rem; color: #8a93ab; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .os-scope-sel {
      width: 100%; font-size: 0.72rem; padding: 0.32rem 0.4rem;
      border: 1px solid rgba(255,255,255,0.28); border-radius: 3px;
      background: rgba(255,255,255,0.08); color: #e8ecf5; cursor: pointer;
    }
    .os-scope-sel option { color: #1b2a4a; }
  `],
  template: `
    <div class="os-shell">
      <!-- Clarity vertical nav — layout + groups + links -->
      <clr-vertical-nav class="os-sidebar-nav" [clrVerticalNavCollapsible]="false">
        <!-- 브랜드 헤더 -->
        <div class="os-brand">K8s Console <span class="label label-info">Angular</span></div>

        <!-- 뷰 스코프 콤보(Cluster ↔ VM) — KubeVirt VirtualMachine CRD 존재 시에만 노출(capability-gate). -->
        <div class="os-scope" *ngIf="vmCapable()">
          <span class="os-scope-label">View</span>
          <select class="os-scope-sel" (change)="setScope($any($event.target).value)">
            <option value="cluster" [selected]="viewScope() === 'cluster'">Cluster</option>
            <option value="vm" [selected]="viewScope() === 'vm'">Virtual Machines</option>
          </select>
        </div>

        <!-- 개요(인덱스) — 단독 링크 -->
        <a clrVerticalNavLink [class.active]="active().id === 'overview'"
           (click)="select(OVERVIEW)" (keydown.enter)="select(OVERVIEW)">
          <svg viewBox="0 0 24 24" class="os-tree-ic" clrVerticalNavIcon><path [attr.d]="icon('overview')"/></svg>
          Overview
        </a>

        <!-- 현재 스코프 그룹만(filteredNav) — clr-vertical-nav-group -->
        <clr-vertical-nav-group *ngFor="let g of filteredNav()"
            [clrVerticalNavGroupExpanded]="isOpen(g.group)"
            (clrVerticalNavGroupExpandedChange)="setOpen(g.group, $event)">
          <svg viewBox="0 0 24 24" class="os-tree-ic" clrVerticalNavIcon><path [attr.d]="secIcon(g.group)"/></svg>
          {{ g.group }}
          <clr-vertical-nav-group-children>
            <a *ngFor="let it of g.items" clrVerticalNavLink
               [class.active]="active().id === it.id"
               (click)="select(it)" (keydown.enter)="select(it)">
              <svg viewBox="0 0 24 24" class="os-tree-ic os-tree-ic-child" clrVerticalNavIcon><path [attr.d]="icon(it.id)"/></svg>
              {{ it.label }}
            </a>
          </clr-vertical-nav-group-children>
        </clr-vertical-nav-group>
      </clr-vertical-nav>

      <section class="os-content">
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
  /** capability-gate: kubevirt.io VirtualMachine CRD 존재 여부. 없으면 콤보·VM 그룹 숨김(§3.3 실재만 노출). */
  readonly vmCapable = signal(false);

  /** 현재 스코프 그룹만 — scope==='vm' 그룹은 VM 뷰에서만, 나머지(기본 cluster)는 Cluster 뷰에서만. */
  readonly filteredNav = computed<NavGroup[]>(() =>
    this.viewScope() === 'vm'
      ? NAV.filter(g => g.scope === 'vm')
      : NAV.filter(g => g.scope !== 'vm'));

  constructor() {
    // capability-gate: KubeVirt VirtualMachine CRD가 있으면 VM 스코프 활성(없으면 404 → 비활성 → 콤보·VM 그룹 숨김).
    this.k8s
      .get('/apis/apiextensions.k8s.io/v1/customresourcedefinitions/virtualmachines.kubevirt.io')
      .subscribe({ next: () => this.vmCapable.set(true), error: () => this.vmCapable.set(false) });
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
  }

  select(it: NavItem) { this.active.set(it); }
  icon(id: string) { return NAV_ICON[id] || NAV_ICON['fallback']; }
  secIcon(group: string) { return NAV_ICON['sec:' + group] || NAV_ICON['fallback']; }
  isOpen(group: string) { return this.expanded().has(group); }
  setOpen(group: string, open: boolean) {
    this.expanded.update(s => { const n = new Set(s); open ? n.add(group) : n.delete(group); return n; });
  }
  /** 개요 카드/링크 클릭 → 항목 id로 이동(없으면 무시). vm 스코프 항목이면 스코프도 전환. */
  openId(id: string) {
    if (id === 'overview') { this.viewScope.set('cluster'); this.active.set(this.OVERVIEW); return; }
    for (const g of NAV) {
      const it = g.items.find(x => x.id === id);
      if (it) {
        if (g.scope === 'vm') { if (!this.vmCapable()) return; this.viewScope.set('vm'); }
        else { this.viewScope.set('cluster'); }
        this.expanded.update(s => new Set(s).add(g.group));
        this.active.set(it);
        return;
      }
    }
  }
}
