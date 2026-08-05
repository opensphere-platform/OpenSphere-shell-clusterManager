import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, Signal, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { K8sService } from '../core/k8s.service';
import { ResourceDetailComponent } from './resource-detail.component';
import { VmDetailComponent } from '../resources/vm-detail.component';
import { OsLogoComponent } from './os-logo.component';

/** 컬럼 정의 — 원시 K8s 객체에서 값을 뽑고(get), 렌더 종류(kind)로 셀을 그린다. */
export interface ColumnDef {
  id: string;
  label: string;
  get: (o: any) => any;
  /** text(기본) | name(굵게, 추후 상세링크) | age(상대시간) | tags(배지 배열) | status(상태 라벨) | logo(OS 로고) */
  kind?: 'text' | 'name' | 'age' | 'tags' | 'status' | 'logo';
  /** kind=status일 때 색상 매핑 */
  statusOf?: (o: any) => 'success' | 'danger' | 'warning' | 'info' | 'unknown';
  /** 이 컬럼을 다중선택 패싯(드롭다운)으로 노출. kind:'status'면 자동으로 패싯. */
  facet?: boolean;
  /** 패싯 옵션을 원시 get() 대신 파생값으로 (예: ready '3/3' → 'AllReady'/'NotAllReady'). */
  facetDerive?: (o: any) => string | string[];
  /** 고유값이 이 개수를 넘으면 패싯 숨김(free-text로 폴백). 기본 30. */
  facetCap?: number;
}

/** 설정 기반 Clarity Datagrid 공용 리스트. 모든 리소스 목록의 단일 렌더 경로.
 *  제네릭 프록시(K8sService)로 path를 list 하고, columns 설정대로 그린다. */
@Component({
  selector: 'app-resource-list',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceDetailComponent, VmDetailComponent, OsLogoComponent],
  styles: [`
    .os-kebab cds-icon { pointer-events: none; }
    .os-row-action-danger { color: var(--clr-color-danger-700); }
  `],
  template: `
    <!-- 목록은 항상 좌측에 유지. 상세는 우측 슬라이드 오버 드로어로 표시. -->
    <div class="os-page-header">
      <div class="os-page-header-main">
        <p class="os-page-eyebrow">Kubernetes resources</p>
        <h2 class="os-page-title">{{ title }}</h2>
        <p class="os-page-description">
          {{ filtered().length }}<span *ngIf="filtersActive()"> / {{ rows().length }}</span>개 리소스
          <span *ngIf="dummy" class="label label-warning">DUMMY · 예시</span>
        </p>
      </div>
      <div class="os-page-header-actions">
        <input clrInput class="os-search" type="search" aria-label="리소스 검색"
               placeholder="검색 (이름·네임스페이스·값)" [value]="search()"
               (input)="search.set($any($event.target).value)" />
        <button *ngIf="createLabel" class="btn btn-sm btn-primary" type="button" (click)="create.emit()">{{ createLabel }}</button>
      </div>
    </div>

    <!-- 리소스 종류별 운영 요약. 기본 목록은 그대로 유지하고 필요한 화면만 진단 보드를 투영한다. -->
    <ng-content></ng-content>

    <!-- 다중선택 패싯 필터 — OpenSphere 표준 Clarity dropdown으로 키보드·포커스·닫힘 동작을 통일한다. -->
    <div class="os-facets" *ngIf="(namespaced && nsOptions().length) || facetCols().length">
      <clr-dropdown *ngIf="namespaced && nsOptions().length">
        <button type="button" class="btn btn-sm btn-outline" clrDropdownTrigger>
          Namespace
          <span class="badge badge-info" *ngIf="countFor(NS)">{{ countFor(NS) }}</span>
          <cds-icon shape="angle" direction="down" aria-hidden="true"></cds-icon>
        </button>
        <clr-dropdown-menu *clrIfOpen clrPosition="bottom-left" aria-label="Namespace filter">
          <button type="button" clrDropdownItem *ngIf="countFor(NS)" (click)="clearFacet(NS)">모든 namespace</button>
          <label class="dropdown-item os-filter-check" *ngFor="let ns of nsOptions()">
            <input type="checkbox" clrCheckbox [checked]="isPicked(NS, ns)"
                   (change)="toggle(NS, ns, $any($event.target).checked)" />
            <span>{{ ns }}</span>
          </label>
        </clr-dropdown-menu>
      </clr-dropdown>

      <ng-container *ngFor="let c of facetCols()">
        <clr-dropdown *ngIf="optionsFor(c).length">
          <button type="button" class="btn btn-sm btn-outline" clrDropdownTrigger>
            {{ c.label }}
            <span class="badge badge-info" *ngIf="countFor(c.id)">{{ countFor(c.id) }}</span>
            <cds-icon shape="angle" direction="down" aria-hidden="true"></cds-icon>
          </button>
          <clr-dropdown-menu *clrIfOpen clrPosition="bottom-left" [attr.aria-label]="c.label + ' filter'">
            <button type="button" clrDropdownItem *ngIf="countFor(c.id)" (click)="clearFacet(c.id)">모두 보기</button>
            <label class="dropdown-item os-filter-check" *ngFor="let v of optionsFor(c)">
              <input type="checkbox" clrCheckbox [checked]="isPicked(c.id, v)"
                     (change)="toggle(c.id, v, $any($event.target).checked)" />
              <span class="label" *ngIf="c.kind === 'status'" [ngClass]="statusClass(statusSwatch(c, v))">{{ v }}</span>
              <span *ngIf="c.kind !== 'status'">{{ v }}</span>
            </label>
          </clr-dropdown-menu>
        </clr-dropdown>
      </ng-container>

      <button type="button" class="btn btn-sm btn-link os-facet-clearall" *ngIf="filtersActive()" (click)="clearAll()">Clear all</button>
    </div>

    <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
    </clr-alert>

    <!-- 404 = 해당 API/CRD 미설치(또는 비활성). 빨간 에러 대신 안내(Headlamp 동작과 동등). -->
    <clr-alert *ngIf="unavailable()" [clrAlertType]="'info'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">이 리소스 종류는 이 클러스터에 없습니다 — CRD 미설치이거나 API가 비활성화됨. 설치되면 자동으로 표시됩니다.</span></clr-alert-item>
    </clr-alert>

    <clr-datagrid [clrDgLoading]="loading()">
      <clr-dg-column *ngIf="namespaced" [clrDgSortBy]="nsComparator">Namespace</clr-dg-column>
      <clr-dg-column *ngFor="let c of columns" [clrDgSortBy]="comparator(c)">{{ c.label }}</clr-dg-column>
      <clr-dg-column *ngIf="rowActions"></clr-dg-column>

      <clr-dg-row *clrDgItems="let item of filtered()">
        <clr-dg-cell *ngIf="namespaced">{{ item.metadata?.namespace }}</clr-dg-cell>
        <clr-dg-cell *ngFor="let c of columns" [ngSwitch]="c.kind || 'text'">
          <ng-container *ngSwitchCase="'name'">
            <a *ngIf="kind && pageDetail" class="os-link" role="button" tabindex="0" (click)="rowOpen.emit(item)" (keydown.enter)="rowOpen.emit(item)">{{ c.get(item) }}</a>
            <a *ngIf="kind && !pageDetail" class="os-link" role="button" tabindex="0" (click)="selected.set(item)" (keydown.enter)="selected.set(item)">{{ c.get(item) }}</a>
            <a *ngIf="!kind && dummy" class="os-link" role="button" tabindex="0" (click)="rowClick.emit(item)" (keydown.enter)="rowClick.emit(item)">{{ c.get(item) }}</a>
            <strong *ngIf="!kind && !dummy">{{ c.get(item) }}</strong>
          </ng-container>
          <ng-container *ngSwitchCase="'age'">{{ age(c.get(item)) }}</ng-container>
          <ng-container *ngSwitchCase="'tags'">
            <span *ngFor="let t of asArray(c.get(item))" class="label">{{ t }}</span>
            <span *ngIf="asArray(c.get(item)).length === 0" class="os-muted">—</span>
          </ng-container>
          <ng-container *ngSwitchCase="'status'">
            <span class="label" [ngClass]="statusClass(c.statusOf?.(item))">{{ c.get(item) }}</span>
          </ng-container>
          <ng-container *ngSwitchCase="'logo'"><app-os-logo [os]="c.get(item)" [size]="22"></app-os-logo></ng-container>
          <ng-container *ngSwitchDefault>{{ display(c.get(item)) }}</ng-container>
        </clr-dg-cell>
        <clr-dg-cell *ngIf="rowActions">
          <clr-dropdown>
            <button type="button" class="btn btn-sm btn-link btn-icon os-kebab" clrDropdownTrigger
                    aria-label="리소스 작업">
              <cds-icon shape="ellipsis-vertical"></cds-icon>
            </button>
            <clr-dropdown-menu clrPosition="bottom-right" *clrIfOpen>
              <button *ngFor="let a of rowActions!(item)" type="button" clrDropdownItem
                      [class.os-row-action-danger]="a.danger" (click)="a.run()">{{ a.label }}</button>
            </clr-dropdown-menu>
          </clr-dropdown>
        </clr-dg-cell>
      </clr-dg-row>

      <clr-dg-footer>
        <clr-dg-pagination #pg [clrDgPageSize]="20">
          <clr-dg-page-size [clrPageSizeOptions]="[10, 20, 50, 100]">{{ title }} per page</clr-dg-page-size>
          {{ pg.firstItem + 1 }} - {{ pg.lastItem + 1 }} / {{ pg.totalItems }}
        </clr-dg-pagination>
      </clr-dg-footer>
    </clr-datagrid>

    <!-- 상세는 Clarity side panel로 통일한다. 포커스 트랩·Esc·스크린리더 제목을 프레임워크가 관리한다. -->
    <clr-side-panel [clrSidePanelOpen]="!!selected()" (clrSidePanelOpenChange)="sidePanelOpenChanged($event)"
                    [clrSidePanelSize]="'xl'" [clrSidePanelPosition]="'right'">
      <h3 class="side-panel-title" *ngIf="selected() as sel">{{ kind }} · {{ sel.metadata?.name }}</h3>
      <div class="side-panel-body" *ngIf="selected() as sel">
        <app-vm-detail *ngIf="vm"
          [item]="sel" [listPath]="path" [namespaced]="namespaced"
          (back)="closeDrawer()" (changed)="load()" />
        <app-resource-detail *ngIf="!vm"
          [kind]="kind!" [listPath]="path" [namespaced]="namespaced" [item]="sel"
          [scalable]="scalable" [restartable]="restartable" [cordonable]="cordonable"
          (back)="closeDrawer()" (changed)="load()" />
      </div>
    </clr-side-panel>
  `,
})
export class ResourceListComponent implements OnInit {
  /** 화면 제목(복수형, 예: Pods) */
  @Input({ required: true }) title!: string;
  /** K8s list 경로(예: /api/v1/pods) */
  @Input({ required: true }) path!: string;
  /** 네임스페이스 컬럼 표시 여부 */
  @Input() namespaced = true;
  /** 컬럼 설정 */
  @Input({ required: true }) columns!: ColumnDef[];
  /** K8s Kind — 지정 시 이름 클릭으로 상세(detail) 진입 + 액션 활성 */
  @Input() kind?: string;
  /** 스케일 가능(Deployment/ReplicaSet/StatefulSet 등) */
  @Input() scalable = false;
  /** 롤링 재시작 가능(Deployment/StatefulSet/DaemonSet 등) */
  @Input() restartable = false;
  /** 코든/드레인 가능(Node) */
  @Input() cordonable = false;
  /** KubeVirt VM 라이프사이클(Start/Stop/Restart) 액션 활성 — kind='VirtualMachine'과 함께 사용. */
  @Input() vm = false;
  /** 행별 작업(⋮) — item을 받아 작업 목록 반환. 지정 시 마지막에 작업(⋮) 컬럼 표시. */
  @Input() rowActions?: (item: any) => Array<{ label: string; danger?: boolean; run: () => void }>;
  /** 페이지 상세 모드 — 이름 클릭 시 드로어 대신 (rowOpen)으로 상위에 위임(상위가 전체 페이지로 상세 렌더). OpenShift 방식. */
  @Input() pageDetail = false;
  /** 더미 모드 — 지정 시 프록시 호출 대신 staticRows를 그대로 렌더(예시 페이지). */
  @Input() dummy = false;
  /** 더미 정적 행(K8s 객체 형태). dummy=true와 함께 사용. */
  @Input() staticRows: any[] | null = null;
  /** 우상단 Create 버튼 라벨(있으면 표시). */
  @Input() createLabel?: string;
  /** Create 버튼 클릭 — 상위(더미 래퍼)가 생성 위저드로 전환. */
  @Output() create = new EventEmitter<void>();
  /** 더미 모드에서 행(이름) 클릭 — 상위가 상세로 전환. */
  @Output() rowClick = new EventEmitter<any>();
  /** pageDetail 모드에서 행(이름) 클릭 — 상위가 전체 페이지 상세로 전환. */
  @Output() rowOpen = new EventEmitter<any>();
  // ── 검색 + 다중선택 패싯 필터 (Headlamp 네임스페이스 다중선택 패리티, 섀도우 자체완결) ──
  /** 네임스페이스 패싯의 예약 facetId */
  readonly NS = '__ns__';
  /** 전역 자유 검색(이름·네임스페이스·모든 컬럼 값 텍스트 매칭) */
  readonly search = signal('');
  /** facetId → 선택값들. 빈 배열/미존재 = 제약 없음(=전체, Headlamp empty=all). */
  readonly selections = signal<Record<string, string[]>>({});
  /** 패싯 컬럼(상태 컬럼 자동 + facet:true 명시) */
  readonly facetCols = computed<ColumnDef[]>(() => this.columns.filter(c => c.facet || c.kind === 'status'));

  private facetVal(c: ColumnDef, o: any): string[] {
    const raw = c.facetDerive ? c.facetDerive(o) : c.get(o);
    return (Array.isArray(raw) ? raw : [raw]).map(v => this.norm(v)).filter(v => v !== '');
  }

  /** 컬럼별 옵션 시그널(ngOnInit에서 1회 생성 — CD마다 computed 재생성 방지). cap 초과 시 빈 배열(패싯 숨김). */
  private optMap = new Map<string, Signal<string[]>>();
  optionsFor(c: ColumnDef): string[] { return this.optMap.get(c.id)?.() ?? []; }

  /** 네임스페이스 옵션(로드된 rows에서 도출) */
  readonly nsOptions = computed(() => {
    if (!this.namespaced) return [];
    const set = new Set<string>();
    for (const o of this.rows()) { const ns = o.metadata?.namespace; if (ns) set.add(ns); }
    return [...set].sort((a, b) => this.strcmp(a, b));
  });

  /** 필터 활성 여부(카운트 배지 'X / total' 표시) */
  readonly filtersActive = computed(() =>
    !!this.search().trim() || Object.values(this.selections()).some(v => v.length > 0));

  /** 단일 진실원: rows에 네임스페이스/컬럼 패싯(패싯 간 AND, 패싯 내 OR) + 자유검색(AND) 적용 */
  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const sel = this.selections();
    let list = this.rows();
    const nsSel = sel[this.NS];
    if (this.namespaced && nsSel?.length) list = list.filter(o => nsSel.includes(o.metadata?.namespace));
    for (const c of this.facetCols()) {
      const picked = sel[c.id];
      if (!picked?.length) continue;
      if (!this.optionsFor(c).length) continue; // cap 초과로 숨겨진 패싯은 조용히 필터하지 않음(UI와 일치)
      list = list.filter(o => this.facetVal(c, o).some(v => picked.includes(v)));
    }
    if (q) list = list.filter(o => {
      const hay = [o.metadata?.namespace, ...this.columns.map(c => this.norm(c.get(o)))].join(' ').toLowerCase();
      return hay.includes(q);
    });
    return list;
  });

  // 선택 변경(zoneless-safe: 명시적 signal write로 CD 트리거)
  toggle(facetId: string, value: string, checked: boolean): void {
    this.selections.update(s => {
      const cur = s[facetId] ?? [];
      const next = checked ? [...new Set([...cur, value])] : cur.filter(v => v !== value);
      return { ...s, [facetId]: next };
    });
  }
  isPicked(facetId: string, value: string): boolean { return (this.selections()[facetId] ?? []).includes(value); }
  countFor(facetId: string): number { return (this.selections()[facetId] ?? []).length; }
  clearFacet(facetId: string): void { this.selections.update(s => ({ ...s, [facetId]: [] })); }
  clearAll(): void { this.selections.set({}); this.search.set(''); }
  /** 상태 옵션 배지 색(값에 해당하는 첫 행의 statusOf) */
  statusSwatch(c: ColumnDef, value: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' {
    const o = this.rows().find(r => this.facetVal(c, r).includes(value));
    return o && c.statusOf ? c.statusOf(o) : 'unknown';
  }

  /** 선택된 항목 → 우측 슬라이드 드로어 상세 표시 */
  readonly selected = signal<any | null>(null);
  closeDrawer(): void { this.selected.set(null); }
  sidePanelOpenChanged(open: boolean): void { if (!open) this.closeDrawer(); }

  private k8s = inject(K8sService);
  readonly rows = signal<any[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** 404(API/CRD 미설치) — 빨간 에러 대신 안내 표시 */
  readonly unavailable = signal(false);

  ngOnInit(): void {
    // 컬럼 id 유일성 보장 — optMap/cmp 캐시 키 충돌(같은 id가 서로 덮어씀) + NS 예약어 충돌 방지(fail-fast).
    const ids = this.columns.map(c => c.id);
    if (new Set(ids).size !== ids.length || ids.includes(this.NS)) {
      throw new Error(`ResourceList(${this.title}): 중복/예약 컬럼 id — ${ids.join(', ')}`);
    }
    // 패싯 컬럼별 옵션 시그널을 1회 생성(rows 변경 시 자동 재계산, cap 초과 시 빈 배열로 패싯 숨김).
    for (const c of this.facetCols()) {
      this.optMap.set(c.id, computed(() => {
        const set = new Set<string>();
        for (const o of this.rows()) for (const v of this.facetVal(c, o)) set.add(v);
        const arr = [...set].sort((a, b) => this.strcmp(a, b));
        return arr.length > (c.facetCap ?? 30) ? [] : arr;
      }));
    }
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.unavailable.set(false);
    // 더미 모드: 프록시 호출 없이 정적 예시 행을 렌더.
    if (this.dummy) {
      this.rows.set(this.staticRows || []);
      this.pruneStaleSelections();
      this.loading.set(false);
      return;
    }
    this.k8s.list(this.path).subscribe({
      next: res => { this.rows.set(res.items || []); this.pruneStaleSelections(); this.loading.set(false); },
      error: err => {
        this.loading.set(false);
        this.rows.set([]);
        // 404 = API/CRD 미설치 → 친절 안내(info), 그 외 → 실제 에러(danger)
        if (err?.status === 404) { this.unavailable.set(true); this.error.set(null); }
        else { this.unavailable.set(false); this.error.set(err?.error?.error || err?.message || String(err)); }
      },
    });
  }

  /** 로드 후, 더 이상 데이터에 존재하지 않는 선택값 제거(유령 패싯 "1 selected/0 rows" 방지).
   *  cap 무관하게 원시값(facetVal) 기준 — 단일 .set()로 zoneless-safe. */
  private pruneStaleSelections(): void {
    const cur = this.selections();
    const next: Record<string, string[]> = { ...cur };
    let changed = false;
    const prune = (id: string, live: Set<string>) => {
      const picked = cur[id];
      if (!picked?.length) return;
      const kept = picked.filter(v => live.has(v));
      if (kept.length !== picked.length) { next[id] = kept; changed = true; }
    };
    if (this.namespaced) {
      const live = new Set<string>();
      for (const o of this.rows()) { const ns = o.metadata?.namespace; if (ns) live.add(ns); }
      prune(this.NS, live);
    }
    for (const c of this.facetCols()) {
      const live = new Set<string>();
      for (const o of this.rows()) for (const v of this.facetVal(c, o)) live.add(v);
      prune(c.id, live);
    }
    if (changed) this.selections.set(next);
  }

  // 파생값(get) 기반 커스텀 정렬 comparator(컬럼별 캐시, 안정 참조).
  private cmp = new Map<string, { compare: (a: any, b: any) => number }>();
  readonly nsComparator = { compare: (a: any, b: any) => this.strcmp(a.metadata?.namespace, b.metadata?.namespace) };
  comparator(c: ColumnDef) {
    if (!this.cmp.has(c.id)) {
      this.cmp.set(c.id, { compare: (a: any, b: any) => this.strcmp(this.norm(c.get(a)), this.norm(c.get(b))) });
    }
    return this.cmp.get(c.id)!;
  }
  private norm(v: any): string { return Array.isArray(v) ? v.join(',') : v == null ? '' : String(v); }
  private strcmp(a: any, b: any): number { return a < b ? -1 : a > b ? 1 : 0; }
  asArray(v: any): any[] { return Array.isArray(v) ? v : v == null ? [] : [v]; }
  display(v: any): string { return v == null || v === '' ? '—' : String(v); }
  statusClass(s?: string): Record<string, boolean> {
    return {
      'label-success': s === 'success',
      'label-danger': s === 'danger',
      'label-warning': s === 'warning',
      'label-info': s === 'info',
    };
  }
  age(ts: string): string {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const d = Math.floor(ms / 86400000);
    if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000);
    if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000);
    return m > 0 ? m + 'm' : '<1m';
  }
}
