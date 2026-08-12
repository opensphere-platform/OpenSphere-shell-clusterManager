# HISS action-column design QA

- Result: passed
- Route: `https://localhost:1114/p/cluster-manager/his/his`
- Reference: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-888c903d-fb7c-4fdd-be7a-dc155af692f6.png`
- Implementation: `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\audit-evidence\hiss-action-column\implementation-202607290817.png`
- Full comparison: `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\audit-evidence\hiss-action-column\comparison-full-202607290817.png`
- Focused comparison: `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\audit-evidence\hiss-action-column\comparison-actions-202607290817.png`
- Target viewport: 2237 × 1118 CSS pixels
- Captured pixels: reference 2237 × 1141; implementation 2237 × 1062 (Chrome content capture excludes browser chrome)
- State: authenticated, HISS Ready, Core 8/8 Ready, active profiles 2/2 Ready, no row detail or action menu open

## Visible comparison

- Preserved the existing Clarity visual language, table density, typography, borders, status badges, and capability ordering.
- Replaced mixed text, multi-button groups, and bespoke Shared Observability copy with exactly one visible primary action per row.
- Detect-only rows now use `상세 진단` or `기능 검증`.
- Helm-managed rows now use a lifecycle-aware primary action such as `업그레이드`.
- Shared Observability now uses `관측 서비스 관리`.
- Secondary lifecycle work is available through one standard overflow control.
- No clipped action labels, overlapping controls, or broken row heights were observed.

## Interaction checks

- Ingress Controller overflow opened with `계획 검토`, `롤백`, and `삭제`.
- CSI / Volume Snapshot overflow opened with `요구조건 해제`.
- `관측 서비스 관리` opened the Shared Observability management modal.
- The modal reported the stack operational with 9/9 workloads Ready, 5 PVCs, and 2/2 recent live checks Passed.
- Browser console contained an unrelated GitLab manifest HTTP 504 warning; no HISS action-column error was observed.

## Severity findings

- P0: none
- P1: none
- P2: none
- P3: none in the updated HISS action-column flow

