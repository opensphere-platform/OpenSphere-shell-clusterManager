# OpenSphere-shell-clusterManager

OpenSphere V2 **subShell** — Kubernetes, Ceph Storage, HIS를 독립 관리 관점으로 제공하는 Cluster Manager. **독자적·온전한 Angular 22 프로젝트**입니다.

| 측면 | 값 |
|---|---|
| 표시명/폴더 | `clusterManager` (camelCase) |
| 기술 식별자 | `cluster-manager` (RFC1123 kebab) — route `/p/cluster-manager`, proxy `/api/plugins/cluster-manager` |
| 프런트엔드 | Angular 22 + Clarity 18, **Angular Element `<osp-k8s-console-ng>`** (CodeMirror·xterm 내장) |
| 백엔드 | `server.js` — 제네릭 `/api/k8s/*` 프록시(secrets 차단) + WS exec 게이트웨이 + 정적 서빙 |
| HIS | `his-manager.js` + `his-catalog.js` — 단일 HIS preflight, 고정 Helm chart 계획·설치·검증·삭제 |
| Ceph | `ceph-manager.js` — Kubernetes 종속 Rook External/CSI 연결 계획·필터·설치·검증·안전 해제 |
| 종류 | subShell (1급 host-guest) — ⚠️위계는 현재 advisory (생성기가 `kind`/`hostRef` 미방출, 설계 §9.2) |

상단 `Management view` 선택기는 설치 상태와 무관하게 항상 표시됩니다.

- `Kubernetes`: 코어 리소스와 capability-gate된 Virtualization·Migration·Observability
- `Ceph Storage`: Kubernetes가 Ready일 때만 Rook provider export JSON을 검증해 외부 Ceph을 Rook External Mode와 CSI로 연결. 자격 증명은 Kubernetes Secret에만 저장하고 원격 data는 관리하지 않음
- `HIS Prerequisites`: 호스트 전제조건 진단과 승인된 Helm 설치·검증·삭제

HIS 판정은 **Core**와 **선택 profile**을 분리한다. Core capability는 항상 필수이며,
선택 profile은 관리자가 변경 사유와 함께 활성화하거나 해당 HelmManaged release를
설치한 때부터 HIS 전체 Ready gate에 포함된다. 현재 profile은 다음과 같다.

- `Observability`: Shared Observability 설치 시 자동 활성화
- `Data Protection`: 호스트 CSI Driver·Snapshot Controller·CRD·VolumeSnapshotClass가
  준비된 환경에서 관리자가 활성화. Cluster Manager는 시험용 CSI Driver를 대신 설치하지 않는다.

profile 선택은 `opensphere-his-profile-selection` ConfigMap에 저장되고 Console 감사
백본에 요청·완료 이벤트를 모두 남긴다. 설치된 HelmManaged profile은 구성요소를 먼저
삭제하기 전에는 선택 해제할 수 없다.

Storage Core는 StorageClass 존재만으로 Ready가 되지 않는다. 기본 StorageClass의
`provisioner`가 실제 `CSIDriver` 이름과 정확히 일치해야 하며, 샘플 CSI나 이름 추정으로
상태를 우회하지 않는다. 비 CSI local-path/hostpath는 개발 편의 저장소로 표시할 수는
있지만 HIS Core 요구조건을 충족하지 않는다.

관리자는 CSI-backed 기본 StorageClass가 준비된 뒤 Storage 항목의 `실검증`으로 임시
64Mi PVC와 비권한 Pod를 생성해 동적 provision·mount·read/write를 확인할 수 있다.
Data Protection profile은 동일 경로에 더해 `deletionPolicy=Delete`인 승인된
VolumeSnapshotClass로 snapshot→restore와 데이터 무결성을 검증한다. 검증 리소스는
완료·실패 여부와 무관하게 정리하고 요청·성공·실패를 감사 백본에 기록한다.
검증 성공은 현재 StorageClass/CSI 계약 지문에 결합되므로 class·driver·정책이 바뀌면
자동으로 무효화되고 재검증 전까지 해당 Core/profile은 `Degraded`로 유지된다.

동일한 계약 지문 기반 검증을 Network·DNS·Observability에도 적용한다. CNI는 서로
다른 Ready 노드 사이의 ClusterIP Service 통신, 외부 egress, 실제 NetworkPolicy deny를
검사한다. DNS는 모든 Ready·schedulable 노드에서 `cluster.local`과 외부 upstream을
반복 질의한다. Shared Observability는 임시 metric endpoint·ServiceMonitor·PrometheusRule을
만들어 scrape, rule evaluation, Alertmanager 전달을 끝까지 확인한다. 모든 synthetic
리소스는 현재 Cluster Manager digest, 최소 권한 securityContext, 고정 namespace와
고정 manifest만 사용하며 성공·실패 후 삭제된다. 검증 계약이 바뀌면 이전 성공은
무효화되므로 해당 capability는 다시 `실검증`을 통과할 때까지 Ready가 아니다.

공유 가능한 경로는 `/p/cluster-manager/<k8s|ceph|his>/<resource>` 형식입니다.

## 구조 (루트 Angular 프로젝트 + 배포 배선)
```
angular.json · tsconfig*.json · package.json · package-lock.json   ← Angular 22 프로젝트
src/                                                                ← 앱 소스 (42 컴포넌트: workloads·network·config·cluster·access + Ceph/Virt/MTV/Obs 확장)
server.js · his-{manager,catalog}.js · ceph-manager.js              ← K8s 프록시 + WS exec + HIS/Ceph 관리 API
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
