import { CommonModule } from '@angular/common';
import { Component, ViewEncapsulation, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { NAV, NavItem } from './nav';
import { NAV_ICON } from './nav-icons';
import { OverviewComponent } from './resources/overview.component';

// ShadowDom 인캡슐레이션 → 컴포넌트와 Clarity CSS가 shadow root에 격리(자체완결, 셸 CSS 영향 0).
// 인덱스 = Cluster Overview. 사이드바 = Clarity clr-vertical-nav + groups.
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ClarityModule, OverviewComponent],
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrls: ['./app.component.css'],
  template: `
    <div class="os-shell">
      <!-- Clarity vertical nav — layout + groups + links -->
      <clr-vertical-nav class="os-sidebar-nav" [clrVerticalNavCollapsible]="false">
        <!-- 브랜드 헤더 -->
        <div class="os-brand">K8s Console <span class="label label-info">Angular</span></div>

        <!-- 개요(인덱스) — 단독 링크 -->
        <a clrVerticalNavLink [class.active]="active().id === 'overview'"
           (click)="select(OVERVIEW)" (keydown.enter)="select(OVERVIEW)">
          <svg viewBox="0 0 24 24" class="os-tree-ic" clrVerticalNavIcon><path [attr.d]="icon('overview')"/></svg>
          Overview
        </a>

        <!-- 섹션별 clr-vertical-nav-group -->
        <clr-vertical-nav-group *ngFor="let g of nav"
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
  readonly nav = NAV;
  readonly OVERVIEW: NavItem = { id: 'overview', label: 'Overview', component: OverviewComponent };
  readonly active = signal<NavItem>(this.OVERVIEW);
  /** 펼쳐진 섹션(기본: 전부 접힘) */
  readonly expanded = signal<Set<string>>(new Set());

  select(it: NavItem) { this.active.set(it); }
  icon(id: string) { return NAV_ICON[id] || NAV_ICON['fallback']; }
  secIcon(group: string) { return NAV_ICON['sec:' + group] || NAV_ICON['fallback']; }
  isOpen(group: string) { return this.expanded().has(group); }
  setOpen(group: string, open: boolean) {
    this.expanded.update(s => { const n = new Set(s); open ? n.add(group) : n.delete(group); return n; });
  }
  /** 개요 카드/링크 클릭 → 항목 id로 이동(없으면 무시). */
  openId(id: string) {
    if (id === 'overview') { this.active.set(this.OVERVIEW); return; }
    for (const g of NAV) { const it = g.items.find(x => x.id === id); if (it) { this.expanded.update(s => new Set(s).add(g.group)); this.active.set(it); return; } }
  }
}
