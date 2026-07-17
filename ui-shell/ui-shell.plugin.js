// ─────────────────────────────────────────────────────────────────────────
// Cluster Manager — Kubernetes / Ceph Storage / HIS 전문 관리 관점을 하나의 subShell에서 제공한다.
//   단일 nav = 콘솔 nav(실데이터): Workloads · Network · Config&Storage · Cluster · Access
//     + OpenSphere 확장: Virtualization · Storage(Ceph/ODF) · Migration(MTV) · Observability.
//   별도 perspective 더미 트리 없음(중복 제거). server.js가 /api/k8s/* 프록시 + WS exec + /app(번들) 서빙.
//   Fleet(여러 클러스터)은 `1 기반`. 셸 계약: ESM activate/deactivate. light DOM.
// ─────────────────────────────────────────────────────────────────────────
const TAG = 'osp-k8s-console-ng'; // www/main.js(Angular Elements)가 customElements.define(TAG)
let injected = false;
let hostContextInstalled = false;

function injectOnce(base) {
  if (injected) return;
  injected = true;
  // per-TAG base 레지스트리 — 전역 단일 키(__OSP_NG_API_BASE__) 충돌 회피.
  // 멀티 subShell(cluster-manager·ai 등) 공존 시 셸이 전부 로드하면 마지막이 전역을 덮어써 콘솔이 엉뚱한 base로 호출되던 버그 수정.
  // 각 콘솔은 자기 TAG로 base를 읽으므로(TAG가 서로 다름) 충돌 없음.
  (window.__OSP_NG_BASES__ = window.__OSP_NG_BASES__ || {})[TAG] = base;
  const v = `?v=${Date.now()}`; // 재배포 번들 즉시 반영(PoC 캐시버스터)
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = `${base}/app/styles.css${v}`;
  css.setAttribute('data-osp-plugin', 'cluster');
  document.head.appendChild(css);
  const s = document.createElement('script');
  s.type = 'module'; s.src = `${base}/app/main.js${v}`;
  s.setAttribute('data-osp-plugin', 'cluster-manager');
  document.head.appendChild(s);
}

export function activate(ctx) {
  const base = (ctx.api?.baseUrl ?? '').replace(/\/$/, '');
  const contexts = window.__OPENSPHERE_HOST_CONTEXTS__ ||= Object.create(null);
  contexts['cluster-manager'] = { api: { baseUrl: base, fetch: ctx.api?.fetch } };
  hostContextInstalled = true;
  injectOnce(base);
  ctx.extensions.registerPage({
    id: ctx.pluginId,
    title: 'Cluster Manager',
    navBand: '운영 Operate',
    elementTag: TAG,
  });
}

export function deactivate() {
  if (hostContextInstalled && window.__OPENSPHERE_HOST_CONTEXTS__) delete window.__OPENSPHERE_HOST_CONTEXTS__['cluster-manager'];
  document.querySelectorAll('[data-osp-plugin="cluster-manager"], [data-osp-plugin="cluster"]').forEach((node) => node.remove());
  if (window.__OSP_NG_BASES__) delete window.__OSP_NG_BASES__[TAG];
  hostContextInstalled = false;
  injected = false;
}
