import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { ClarityModule } from '@clr/angular';

const SIMPLE_ICONS_VERSION = '16.21.0';
const SIMPLE_ICON_SLUG: Record<string, string> = {
  fedora: 'fedora',
  rhel: 'redhat',
  centos: 'centos',
  ubuntu: 'ubuntu',
  debian: 'debian',
  opensuse: 'opensuse',
  windows: 'windows',
};

/**
 * OS 배포판 식별자.
 *
 * 브랜드 로고는 직접 그린 SVG가 아니라 버전이 고정된 Simple Icons 원본 자산을 사용한다.
 * CirrOS와 알 수 없는 OS는 별도 공식 브랜드 자산이 없으므로 Clarity의 computer 아이콘으로 표시한다.
 */
@Component({
  selector: 'app-os-logo',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styles: [`
    :host { display: inline-grid; place-items: center; flex: 0 0 auto; }
    img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
    cds-icon { color: var(--os-text-dim); }
  `],
  template: `
    <img *ngIf="logoUrl() as url; else genericIcon"
         [src]="url" [attr.width]="size" [attr.height]="size" [alt]="os + ' logo'" />
    <ng-template #genericIcon>
      <cds-icon shape="computer" [size]="size.toString()" [attr.aria-label]="os"></cds-icon>
    </ng-template>
  `,
})
export class OsLogoComponent {
  @Input() os = 'generic';
  @Input() size = 40;

  logoUrl(): string | null {
    const slug = SIMPLE_ICON_SLUG[this.os];
    return slug ? `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}/icons/${slug}.svg` : null;
  }
}

/** 이미지/OS 문자열 → 로고 id 추론. */
export function osIdFromImage(s?: string): string {
  const value = (s || '').toLowerCase();
  if (value.includes('cirros')) return 'cirros';
  if (value.includes('fedora')) return 'fedora';
  if (value.includes('centos')) return 'centos';
  if (value.includes('ubuntu')) return 'ubuntu';
  if (value.includes('debian')) return 'debian';
  if (value.includes('suse')) return 'opensuse';
  if (value.includes('rhel') || value.includes('redhat') || value.includes('red hat')) return 'rhel';
  if (value.includes('win')) return 'windows';
  return 'generic';
}
