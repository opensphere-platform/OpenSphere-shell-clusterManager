import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClarityModule } from '@clr/angular';
import { Diagnosis, DiagAction } from './diagnose.model';

/**
 * DiagnoseCardComponent — "왜 안 떠 있나"의 평문 진단 + 추천 액션(C3/§5.3).
 * 문제 있을 때만 렌더(diagnoses.length>0). 읽기 전용 — 액션은 act emit만(실행은 호출측).
 * ⚠️ Clarity 전역 CSS 트랩 회피: <header>/<h3> 미사용(div/strong/p만) — 메모리 console-clarity-semantic-tag-trap.
 */
@Component({
  selector: 'app-diagnose-card',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <clr-alert *ngFor="let d of diagnoses" [clrAlertType]="d.severity" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">
        <strong>{{ d.title }}</strong>
        <span class="dg-detail" *ngIf="d.detail">{{ d.detail }}</span>
        <span class="dg-actions">
          <button type="button" class="btn btn-sm btn-outline" *ngFor="let a of d.actions" (click)="act.emit(a)">{{ a.label }}</button>
        </span>
        <small class="dg-src">근거: <span class="dg-mono">{{ d.source }}</span></small>
      </span></clr-alert-item>
    </clr-alert>
  `,
  styles: [`
    .dg-detail, .dg-src { display: block; margin-top: var(--os-space-1); }
    .dg-actions { display: flex; flex-wrap: wrap; gap: var(--os-space-1); margin-top: var(--os-space-2); }
    .dg-actions .btn { margin: 0; }
    .dg-src { color: var(--os-text-dim); }
    .dg-mono { font-family: var(--os-font-mono, monospace); }
  `],
})
export class DiagnoseCardComponent {
  @Input({ required: true }) diagnoses!: Diagnosis[];
  @Output() act = new EventEmitter<DiagAction>();
}
