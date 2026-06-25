# OpenSphere-shell-clusterManager

OpenSphere V2 **subShell** — K8s Cluster + Ceph 관리 (구 Perspective #2 `cluster` 계승·개명).

| 측면 | 값 |
|---|---|
| 표시명/폴더 | `clusterManager` (camelCase 허용) |
| 기술 식별자 | `cluster-manager` (RFC1123 kebab) |
| route | `/p/cluster-manager` · proxy `/api/plugins/cluster-manager` |
| 종류 | subShell (1급 host-guest) — ⚠️위계는 현재 advisory (생성기가 `kind`/`hostRef` 미방출, 설계 §9.2) |

V1 `console/perspectives/cluster`에서 이관 + `cluster`→`cluster-manager` 전면 리네임 + durable 키 재서명.

## 구성 (단일 컨테이너 배포형)
- `server.js` — 제네릭 K8s 프록시(`/api/k8s/*`, secrets 차단) + WS exec 게이트웨이 + ui-shell·www 서빙
- `ui-shell/` — 서명된 셸 진입점 (`ui-shell.plugin.js` + `ui-shell.manifest.json` + `.sig`, ManifestV2)
- `www/` — Angular 범용 K8s 콘솔 번들
- `uipluginpackage.yaml` — DUPA 설치 계약 (UIPluginPackage + UIPluginRegistration)
- `rbac.yaml` — ClusterRole `cluster-reader` (광범위 read-only + impersonate; SA=`default`)
- `Dockerfile` — node:22-alpine 단일 스테이지

## DUPA 자동설치
`dupa-registry-controller`가 `uipluginpackage.yaml` reconcile → 서명검증(trust keyId `opensphere-plugins-v1`) → Deployment/Service 생성·소유(ownerReference GC) → Main Shell에 nav band·page 주입.

## 재서명
```
node <console>/perspectives/_resign.mjs . <durable-key.pem>
```
`ui-shell.plugin.js` 불변 시 `entrySha256` 유지, manifest 변경분만 재서명 + `uipluginpackage.yaml` sha256 핀 자동 갱신.
