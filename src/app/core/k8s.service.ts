import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/** 제네릭 K8s API 프록시 클라이언트. 백엔드 /api/k8s/<표준 K8s 경로>로 패스스루.
 *  Main Shell HttpInterceptor가 ctx.api.fetch로 인증을 중개하고, backend가 유효한 Console 신원만
 *  Cluster Manager의 고정된 읽기 권한에 연결한다. 범용 쓰기는 서버에서 차단되며 HIS 승인 경로를 사용한다.
 *  Consumer JavaScript는 raw token을 읽지 않는다. */
export interface K8sList<T = any> {
  kind?: string;
  apiVersion?: string;
  items: T[];
  metadata?: { resourceVersion?: string };
}

@Injectable({ providedIn: 'root' })
export class K8sService {
  private http = inject(HttpClient);

  private base(): string {
    // per-TAG base(__OSP_NG_BASES__['osp-k8s-console-ng']) 우선 — 멀티 subShell 전역충돌 회피.
    // 구 단일 전역(__OSP_NG_API_BASE__)은 하위호환 폴백.
    const w = window as any;
    const b = w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '';
    return String(b).replace(/\/$/, '');
  }

  /** 인증은 hostApiInterceptor가 주입한다. 여기서는 요청별 content headers만 구성한다. */
  private hdr(extra?: Record<string, string>): { headers: Record<string, string> } {
    return { headers: { ...(extra || {}) } };
  }

  private url(path: string): string { return `${this.base()}/api/k8s${path}`; }

  /** path 예: /api/v1/pods, /apis/apps/v1/deployments (전 네임스페이스). 쿼리 추가 가능. */
  list<T = any>(path: string, query?: Record<string, string>): Observable<K8sList<T>> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.http.get<K8sList<T>>(this.url(path) + qs, this.hdr());
  }

  get<T = any>(path: string): Observable<T> {
    return this.http.get<T>(this.url(path), this.hdr());
  }

  /** WS(exec/터미널)용 신원 쿠키 발급 — 토큰을 HttpOnly 쿠키로 심어 브라우저 WS가 보낼 수 있게. */
  session(): Observable<any> {
    return this.http.get(`${this.base()}/api/session`, this.hdr());
  }

  /** 텍스트 응답 GET (예: pods/<name>/log — tail 방식). */
  getText(path: string, query?: Record<string, string>): Observable<string> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.http.get(this.url(path) + qs, { headers: this.hdr().headers, responseType: 'text' });
  }

  // ── 레거시 쓰기 클라이언트 ──
  // 서버 보안 계약상 범용 쓰기는 403이다. HIS 설치/삭제는 HisService의 승인 API만 사용한다.
  /** 전체 교체(PUT). Edit YAML 적용에 사용(resourceVersion 포함된 obj 필요). */
  replace<T = any>(path: string, obj: any): Observable<T> {
    return this.http.put<T>(this.url(path), obj, this.hdr());
  }
  /** merge-patch (예: spec.replicas 스케일). */
  patchMerge<T = any>(path: string, patch: any): Observable<T> {
    return this.http.patch<T>(this.url(path), patch, this.hdr({ 'content-type': 'application/merge-patch+json' }));
  }
  /** strategic-merge-patch (예: 템플릿 어노테이션 — 롤링 재시작). */
  patchStrategic<T = any>(path: string, patch: any): Observable<T> {
    return this.http.patch<T>(this.url(path), patch, this.hdr({ 'content-type': 'application/strategic-merge-patch+json' }));
  }
  remove<T = any>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path), this.hdr());
  }
  /** 생성/액션 POST (예: pods/<name>/eviction — drain). */
  post<T = any>(path: string, body: any): Observable<T> {
    return this.http.post<T>(this.url(path), body, this.hdr());
  }
}
