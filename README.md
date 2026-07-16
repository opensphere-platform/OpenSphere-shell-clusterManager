# OpenSphere-shell-clusterManager

OpenSphere V2 **subShell** — K8s Cluster + Ceph 관리. **독자적·온전한 Angular 22 프로젝트** (구 Perspective #2 `cluster` 계승·개명).

| 측면 | 값 |
|---|---|
| 표시명/폴더 | `clusterManager` (camelCase) |
| 기술 식별자 | `cluster-manager` (RFC1123 kebab) — route `/p/cluster-manager`, proxy `/api/plugins/cluster-manager` |
| 프런트엔드 | Angular 22 + Clarity 18, **Angular Element `<osp-k8s-console-ng>`** (CodeMirror·xterm 내장) |
| 백엔드 | `server.js` — 제네릭 `/api/k8s/*` 프록시(secrets 차단) + WS exec 게이트웨이 + 정적 서빙 |
| HIS | `his-manager.js` + `his-catalog.js` — 단일 HIS preflight, 고정 Helm chart 계획·설치·검증·삭제 |
| 종류 | subShell (1급 host-guest) — ⚠️위계는 현재 advisory (생성기가 `kind`/`hostRef` 미방출, 설계 §9.2) |

## 구조 (루트 Angular 프로젝트 + 배포 배선)
```
angular.json · tsconfig*.json · package.json · package-lock.json   ← Angular 22 프로젝트
src/                                                                ← 앱 소스 (42 컴포넌트: workloads·network·config·cluster·access + Ceph/Virt/MTV/Obs 확장)
server.js · his-{manager,catalog}.js                                ← K8s 프록시 + WS exec + HIS 관리 API
ui-shell/  (ui-shell.plugin.js + manifest + .sig)                   ← 셸 플러그인 진입점 (Angular Element 주입, ManifestV2, 서명됨)
Dockerfile (멀티스테이지)                                            ← ng build → dist/.../browser → /app/www
uipluginpackage.yaml · rbac.yaml                                    ← DUPA 설치계약 · RBAC
```

## 로컬 개발
```bash
npm install
npm run build          # ng build --configuration production → dist/k8s-console-angular/browser (main.js·styles.css, outputHashing=none)
npm run serve:backend  # node server.js (PLUGINS_DIR/WWW_DIR/PORT env)
# 또는 ng serve (npm start) 로 프런트만
```

## 빌드/배포 (단일 이미지)
```bash
docker build --build-arg OS_MODULE_DESCRIPTOR="$(cat module-package.json)" \
  --build-arg OS_MODULE_SIGNATURE="$(tr -d '\r\n' < module-package.json.sig)" \
  -t localhost:5000/cluster-manager:<tag> .
docker push localhost:5000/cluster-manager:<tag>
```
멀티스테이지: stage1이 Angular를 빌드(`browser/main.js`), stage2가 `server.js` + 빌드본 + 서명 ui-shell + `ws`로 런타임 이미지 구성.

## DUPA 자동등록
`dupa-registry-controller`가 `uipluginpackage.yaml` reconcile → 서명검증(trust keyId `opensphere-plugins-v1`) → Deployment/Service 생성 → `/registry/plugins.json` 전사 → 메인 셸(opensphere-console)이 동적으로 nav 밴드·라우트·페이지 등록 (**셸 무수정**).

Kanidm 신뢰 CA는 이미지에 포함하지 않는다. Console Extension Host가 Setup-managed
`opensphere-console-auth-ca` Secret을 각 관리 워크로드에 read-only로 마운트하고,
Cluster Manager는 그 CA로 BFF JWKS와 매 요청 live token introspection을 검증한다.

## 재서명 (ui-shell 변경 시)
```
node <console>/perspectives/_resign.mjs . <durable-key.pem>
```
`ui-shell.plugin.js` 불변 시 `entrySha256` 유지, manifest 변경분만 재서명 + `uipluginpackage.yaml` sha256 핀 자동 갱신.

---
*소스 출처: 구 `opensphere-INFRA/k8s-console-angular` (Headlamp(React) 대체 Angular 재작성) — 2026-06-25 본 repo로 단일화·이관, 원본 폴더 삭제.*
