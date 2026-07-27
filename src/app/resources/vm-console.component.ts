import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClarityModule } from '@clr/angular';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { K8sService } from '../core/k8s.service';

/**
 * VM serial 콘솔 — virt-api console 서브리소스 WS 게이트웨이(/api/k8s-vmconsole/<ns>/<name>)에
 * raw 스트림으로 연결(exec와 달리 K8s 채널 프레이밍 없음 — 게스트 직렬 포트 그대로).
 * 인증은 Main Shell의 서버 측 bearer 중계를 사용한다.
 */
@Component({
  selector: 'app-vm-console',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  template: `
    <clr-alert *ngIf="error()" [clrAlertType]="'danger'" [clrAlertClosable]="false">
      <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
    </clr-alert>
    <div class="os-term" #term></div>
  `,
})
export class VmConsoleComponent implements OnInit, OnDestroy {
  @Input({ required: true }) ns!: string;
  @Input({ required: true }) name!: string;
  @ViewChild('term', { static: true }) termEl!: ElementRef<HTMLElement>;

  private k8s = inject(K8sService);
  readonly error = signal<string | null>(null);
  private term?: Terminal;
  private fit?: FitAddon;
  private ws?: WebSocket;
  private enc = new TextEncoder();
  private ro?: ResizeObserver;
  private onWinResize = () => this.doFit();

  ngOnInit(): void {
    // Console 신원 확인 후 연결. WS bearer는 Main Shell 서버 중계가 주입한다.
    this.k8s.session().subscribe({
      next: () => this.connect(),
      error: e => this.error.set('Console 신원 확인 실패: ' + (e?.error?.error || e?.message || e)),
    });
  }

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${this.base()}/api/k8s-vmconsole/${encodeURIComponent(this.ns)}/${encodeURIComponent(this.name)}`;

    this.term = new Terminal({
      convertEol: true,
      fontSize: 12,
      cursorBlink: true,
      theme: { background: this.token('--os-dark-bg'), foreground: this.token('--os-dark-text') },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termEl.nativeElement);
    setTimeout(() => this.doFit(), 0);
    this.term.writeln('\x1b[90m[serial 콘솔 연결 — Enter를 눌러 로그인 프롬프트를 깨우세요]\x1b[0m');

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.term!.focus();
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string') this.term!.write(d);
      else this.term!.write(new Uint8Array(d as ArrayBuffer));
    };
    ws.onclose = () => this.term?.write('\r\n\x1b[90m[연결 종료]\x1b[0m\r\n');
    ws.onerror = () => this.error.set('WS 연결 오류');

    this.term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(this.enc.encode(d)); });
    window.addEventListener('resize', this.onWinResize);
    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.termEl.nativeElement);
  }

  private doFit(): void { try { this.fit?.fit(); } catch { /* noop */ } }
  private token(name: string): string {
    return getComputedStyle(this.termEl.nativeElement).getPropertyValue(name).trim();
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onWinResize);
    try { this.ro?.disconnect(); } catch { /* noop */ }
    try { this.ws?.close(); } catch { /* noop */ }
    try { this.term?.dispose(); } catch { /* noop */ }
  }
}
