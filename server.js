// Perspective 2 K8s Cluster — server.js. 구 k8s-console-ng 피처 컨테이너 전체 흡수(누락 없이): 제네릭 /api/k8s/* 프록시 + WS exec + Angular 범용콘솔(www) + perspective ui-shell 서빙.
// 셸 nginx가 /api/plugins/k8s-console-ng/<X> → 이 서버 /<X> 로 prefix strip 프록시.
//   /plugins/*  → 매니페스트/번들/서명
//   /app/*      → Angular dist(main.js, styles.css)
//   /api/nodes  → 노드 집계
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { createHisManager } = require('./his-manager');
const { createCephManager } = require('./ceph-manager');
const COOKIE = 'osng_token'; // 브라우저 WS는 커스텀 헤더를 못 실음 → 신원 토큰을 HttpOnly 쿠키로 전달
function tokenFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function requestToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}const PORT = process.env.PORT || 8080;
const PLUGINS = process.env.PLUGINS_DIR || '/app/plugins';
const WWW = process.env.WWW_DIR || '/app/www';
const VERSION = process.env.APP_VERSION || '0.1.0';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const APISERVER = 'https://kubernetes.default.svc';
const tok = () => fs.readFileSync(`${SA}/token`, 'utf8').trim();

// ── Console 신원 검증 ──
// Cluster Manager는 독립 IdP/JWKS를 소유하지 않는다. Console Backend가 Supabase
// Auth 세션과 console.operator_role을 함께 검증하는 단일 identity authority다.
const CONSOLE_IDENTITY_URL = (process.env.CONSOLE_IDENTITY_URL
  || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
async function verifySupabaseToken(rawToken, identityFetch = fetch) {
  if (!rawToken) throw { code: 401, msg: 'no bearer token' };
  let response;
  try {
    response = await identityFetch(`${CONSOLE_IDENTITY_URL}/api/identity/session`, {
      headers: { authorization: `Bearer ${rawToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw { code: 503, msg: 'Supabase identity authority unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status === 403 ? 403 : 401, msg: body.error || 'invalid Supabase session' };
  return {
    username: body.username || body.subject || 'unknown',
    subject: body.subject || '',
    groups: Array.isArray(body.groups) ? body.groups : [],
    provider: 'supabase',
  };
}
async function verifyToken(rawToken) {
  return verifySupabaseToken(rawToken);
}
const jsonRes = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.ico': 'image/x-icon',
};

async function nodes() {
  const r = await fetch(`${APISERVER}/api/v1/nodes`, { headers: { Authorization: `Bearer ${tok()}` } });
  if (!r.ok) throw new Error(`nodes HTTP ${r.status}`);
  const items = (await r.json()).items || [];
  return items.map((n) => {
    const cond = (n.status?.conditions || []).find((c) => c.type === 'Ready');
    const roles = Object.keys(n.metadata?.labels || {})
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.split('/')[1]).filter(Boolean);
    const addr = (n.status?.addresses || []).find((a) => a.type === 'InternalIP');
    const ni = n.status?.nodeInfo || {};
    return {
      name: n.metadata?.name, ready: cond?.status === 'True',
      roles: roles.length ? roles : ['<none>'], version: ni.kubeletVersion || '',
      os: ni.osImage || '', arch: ni.architecture || '',
      cpu: n.status?.capacity?.cpu || '', memory: n.status?.capacity?.memory || '',
      internalIP: addr?.address || '', created: n.metadata?.creationTimestamp || '',
      schedulable: !n.spec?.unschedulable,
    };
  });
}

// ── 콘솔 통합 알림 연동 (ADR-UI-003 P1 발행 백본) ──
// cluster-manager 백엔드 → 콘솔 audit bus(/api/admin/events) → 셸 단일 인박스.
// 시작/노드 경고를 콘솔 인박스에 발행 = subShell이 콘솔 알림 core와 '유기적' 작동.
// best-effort: 발행 실패해도 cluster-manager 본 기능엔 영향 없음. (manifest 권한 불요 — 백엔드 in-cluster 호출)
const CONTROLLER = process.env.OSP_CONTROLLER || 'http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080';
async function publishNotify(ev) {
  try {
    await fetch(`${CONTROLLER}/api/admin/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok()}`,
        'content-type': 'application/json',
        'x-opensphere-source': 'cluster-manager',
      },
      body: JSON.stringify({ source: 'cluster-manager', ...ev }),
    });
  } catch (e) { /* 콘솔 알림은 best-effort */ }
}
const hisManager = createHisManager({
  verifyToken,
  requestToken,
  jsonRes,
  token: tok,
  apiServer: APISERVER,
  caPath: `${SA}/ca.crt`,
  controller: CONTROLLER,
  publishNotify,
});
const cephManager = createCephManager({
  verifyToken,
  requestToken,
  jsonRes,
  token: tok,
  apiServer: APISERVER,
  caPath: `${SA}/ca.crt`,
  controller: CONTROLLER,
  publishNotify,
});
const _notifiedNodes = new Set();
async function nodeHealthPublish() {
  try {
    for (const n of await nodes()) {
      if (!n.ready && !_notifiedNodes.has(n.name)) {
        _notifiedNodes.add(n.name);
        await publishNotify({ action: 'NodeNotReady', target: `Node/${n.name}`, result: 'warning', reason: `노드 ${n.name} NotReady (cluster-manager 감지)` });
      } else if (n.ready) {
        _notifiedNodes.delete(n.name); // 복구 시 재경고 허용
      }
    }
  } catch (e) { /* best-effort */ }
}

function serveFrom(root, rel, res) {
  const fp = path.join(root, path.normalize('/' + rel).replace(/^(\.\.[/\\])+/, ''));
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const mime = MIME[path.extname(fp)] || 'application/octet-stream';
    // PoC: 재배포 시 셸 브라우저가 구 번들을 캐시해 변경이 안 보이는 문제 회피
    fs.createReadStream(fp).once('open', () => res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })).pipe(res);
  });
}

// 제네릭 K8s API 프록시: /api/k8s/<표준 K8s 경로> → APISERVER.
// 읽기(GET): Console 자격을 fail-closed로 검증한 뒤 전용 ServiceAccount의 고정 읽기 권한으로 수행한다.
// 범용 쓰기: 차단한다. 변경은 live 관리자 검증·계획·감사를 갖춘
// /api/his/* 및 /api/ceph/* 승인 경로만 사용한다.
// ServiceAccount에 users/groups impersonate 권한을 부여하지 않는 것이 permissionProfile의 보안 계약이다.
async function authorizeK8sProxyRequest(req, isWrite, verifier = verifyToken) {
  let actor;
  try { actor = await verifier(requestToken(req)); }
  catch (e) { throw { code: e.code || 401, msg: e.msg || 'unauthorized' }; }
  if (isWrite) {
    throw { code: 403, msg: 'generic Kubernetes mutations are disabled; use an approved HIS action' };
  }
  return actor;
}

function buildK8sReadHeaders(serviceAccountToken) {
  return { Authorization: `Bearer ${serviceAccountToken}`, Accept: 'application/json' };
}

async function k8sProxy(req, res, rawUrl) {
  // 보안: 원시 경로 정규식 매칭은 URL 인코딩(sec%72ets)으로 우회됨 → 디코드 후 세그먼트 정확 매칭.
  const qIdx = rawUrl.indexOf('?');
  const rawQuery = qIdx >= 0 ? rawUrl.slice(qIdx) : ''; // 쿼리는 원형 유지(labelSelector 등)
  let pathOnly;
  try { pathOnly = decodeURIComponent(rawUrl.slice('/api/k8s'.length).split('?')[0]); }
  catch { return jsonRes(res, 400, { error: 'bad path encoding' }); }
  if (!/^\/(api|apis)\//.test(pathOnly)) return jsonRes(res, 400, { error: 'only /api or /apis paths allowed' });
  const segs = pathOnly.split('/').filter(Boolean);
  // 이중 인코딩 거부(%xx가 디코드 후에도 남아있으면 차단)
  if (segs.some((s) => s.includes('%'))) return jsonRes(res, 400, { error: 'encoded path segments not allowed' });
  // 시크릿: 어느 세그먼트든 'secrets'면 차단(denylist)
  if (segs.includes('secrets')) return jsonRes(res, 403, { error: 'secrets are blocked by policy' });
  // 고위험 서브리소스(마지막 세그먼트) 차단: exec/attach/portforward/proxy, serviceaccounts/*/token
  const last = segs[segs.length - 1];
  if (['exec', 'attach', 'portforward', 'proxy'].includes(last)) return jsonRes(res, 403, { error: 'subresource blocked by policy' });
  if (segs.includes('serviceaccounts') && last === 'token') return jsonRes(res, 403, { error: 'token subresource blocked by policy' });

  const isWrite = WRITE_METHODS.has(req.method);
  // 클라이언트의 Authorization/Impersonate-*는 업스트림에 전달하지 않는다.
  // 인증 실패를 ServiceAccount 조회로 폴백하지 않고 즉시 종료한다.
  let actor;
  try { actor = await authorizeK8sProxyRequest(req, isWrite); }
  catch (e) { return jsonRes(res, e.code || 401, { error: e.msg || 'unauthorized' }); }
  const headers = buildK8sReadHeaders(tok());
  // 업스트림은 검증된 디코드 경로 + 원형 쿼리로 재구성(원시 sub 그대로 전달 금지)
  const u = new URL(`${APISERVER}${pathOnly}${rawQuery}`);
  const up = await new Promise((resolve, reject) => {
    const preq = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: req.method, headers }, (pres) => {
      const ch = []; pres.on('data', (c) => ch.push(c));
      pres.on('end', () => resolve({ status: pres.statusCode, ct: pres.headers['content-type'], text: Buffer.concat(ch).toString('utf8') }));
    });
    preq.on('error', reject);
    preq.end();
  });
  console.log(`[access] user=${actor.username} verb=${req.method} path=${pathOnly} status=${up.status} ${new Date().toISOString()}`);
  res.writeHead(up.status, { 'content-type': up.ct || 'application/json', 'cache-control': 'no-store' });
  res.end(up.text);
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://${req.headers.host}`).pathname;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/api/session') {
      // WS(exec/터미널)용 신원 쿠키 발급 — 토큰 JWKS 검증 후 HttpOnly 쿠키로(브라우저 WS가 보낼 수 있게)
      let actor;
      try { actor = await verifyToken(requestToken(req)); }
      catch (e) { return jsonRes(res, e.code || 401, { error: e.msg || 'unauthorized' }); }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${COOKIE}=${encodeURIComponent(requestToken(req))}; HttpOnly; SameSite=Strict; Path=/api/plugins/cluster-manager;${secure} Max-Age=600`,
      });
      return res.end(JSON.stringify({ user: actor.username }));
    }
    if (p.startsWith('/api/his/')) return hisManager(req, res, p);
    if (p.startsWith('/api/ceph/')) return cephManager(req, res, p);
    if (p.startsWith('/api/k8s/')) return k8sProxy(req, res, req.url);
    if (p === '/api/nodes') {
      const list = await nodes();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        meta: { service: 'cluster-manager', version: VERSION, servedBy: process.env.HOSTNAME, time: new Date().toISOString() },
        nodes: list,
      }));
    }
    if (p === '/plugins' || p === '/plugins/') {
      const files = fs.existsSync(PLUGINS) ? fs.readdirSync(PLUGINS).filter((f) => !f.startsWith('.')) : [];
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ plugins: files }));
    }
    if (p.startsWith('/plugins/')) return serveFrom(PLUGINS, p.slice('/plugins/'.length), res);
    if (p.startsWith('/app/')) return serveFrom(WWW, p.slice('/app/'.length), res);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) }));
  }
});
// ── WS exec/터미널 게이트웨이 ──────────────────────────────────────────────
// 브라우저 WS(/api/k8s-exec/<ns>/<pod>?container=&command=) → 쿠키 토큰 JWKS 검증 → apiserver exec
// 채널(v4.channel.k8s.io)로 투명 릴레이. SA 토큰 + Impersonate-User로 사용자 본인 RBAC(create pods/exec) 인가.
const wss = new WebSocketServer({ noServer: true });
// 검증된 actor → 임퍼소네이션 헤더(그룹은 배열=별도 헤더 라인). exec/VM콘솔 공용.
function impHeaders(actor) {
  const h = { Authorization: `Bearer ${tok()}`, 'Impersonate-User': actor.username };
  if (Array.isArray(actor.groups) && actor.groups.length) h['Impersonate-Group'] = [...actor.groups, 'system:authenticated'];
  return h;
}
// 브라우저 WS ↔ 업스트림 WS 양방향 raw 릴레이. execMode면 업스트림 에러를 채널3 프레임으로(터미널 표시).
function relayWs(browserWs, up, execMode) {
  const closeBoth = () => { try { browserWs.close(); } catch {} try { up.close(); } catch {} };
  up.on('message', (data) => { if (browserWs.readyState === 1) browserWs.send(data, { binary: true }); });
  browserWs.on('message', (data) => { if (up.readyState === 1) up.send(data); });
  up.on('close', closeBoth);
  up.on('error', (e) => { if (execMode) { try { browserWs.send(Buffer.from([3, ...Buffer.from(String(e))])); } catch {} } closeBoth(); });
  browserWs.on('close', closeBoth);
  browserWs.on('error', closeBoth);
}
server.on('upgrade', async (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const exec = u.pathname.match(/^\/api\/k8s-exec\/([^/]+)\/([^/]+)$/);
  const vmc = u.pathname.match(/^\/api\/k8s-(vmconsole|vmvnc)\/([^/]+)\/([^/]+)$/);
  if (!exec && !vmc) { socket.destroy(); return; }
  let actor;
  try { actor = await verifyToken(tokenFromCookie(req.headers.cookie)); }
  catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const headers = impHeaders(actor);
  if (exec) {
    const ns = decodeURIComponent(exec[1]);
    const pod = decodeURIComponent(exec[2]);
    const container = u.searchParams.get('container') || '';
    const commands = u.searchParams.getAll('command');
    const cmds = commands.length ? commands : ['/bin/sh'];
    wss.handleUpgrade(req, socket, head, (browserWs) => {
      const qs = new URLSearchParams();
      if (container) qs.set('container', container);
      qs.set('stdin', 'true'); qs.set('stdout', 'true'); qs.set('stderr', 'true'); qs.set('tty', 'true');
      for (const c of cmds) qs.append('command', c);
      const upUrl = `${APISERVER.replace(/^https/, 'wss')}/api/v1/namespaces/${ns}/pods/${pod}/exec?${qs.toString()}`;
      const up = new WebSocket(upUrl, ['v4.channel.k8s.io'], { headers });
      console.log(`[audit] exec user=${actor.username} pod=${ns}/${pod} container=${container} ${new Date().toISOString()}`);
      relayWs(browserWs, up, true);
    });
    return;
  }
  // VM serial 콘솔(/console) / VNC(/vnc) — apiserver가 virt-api로 집계 프록시. raw 스트림 릴레이.
  const sub = vmc[1] === 'vmvnc' ? 'vnc' : 'console';
  const ns = decodeURIComponent(vmc[2]);
  const name = decodeURIComponent(vmc[3]);
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    const upUrl = `${APISERVER.replace(/^https/, 'wss')}/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}/${sub}`;
    const up = new WebSocket(upUrl, { headers });
    console.log(`[audit] vm-${sub} user=${actor.username} vmi=${ns}/${name} ${new Date().toISOString()}`);
    relayWs(browserWs, up, false);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`k8s-console-ng v${VERSION} on :${PORT}`);
    // 콘솔 인박스에 시작 이벤트 발행 + 주기적 노드 헬스(유기적 연동)
    publishNotify({ action: 'started', target: 'cluster-manager', result: 'info', reason: `K8s Cluster 콘솔 백엔드 v${VERSION} 시작` });
    nodeHealthPublish();
    setInterval(nodeHealthPublish, 60000);
  });
} else {
  module.exports = { verifySupabaseToken, authorizeK8sProxyRequest, buildK8sReadHeaders };
}
