# Design QA — Shared Observability 운영 구성

- Date: 2026-07-17
- Deployed version: `cluster-manager 1.3.3`
- URL: `https://localhost:8090/p/cluster-manager/his/his`
- Browser / viewport: Chrome, 3840 × 1991
- State: Prometheus StorageClass 변경 계획을 검사해 데이터 초기화 확인 영역이 표시된 상태

## Evidence

- Source — double scrollbar: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-5fa05939-884a-480f-9722-b1bd0a19b0fc.png`
- Source — clipped confirmation text: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-92063813-e96b-40cb-92d2-a422daa5c41c.png`
- Implementation: `audit-evidence/2026-07-17-observability-modal/after-1.3.3-single-scroll.png`
- Combined comparison: `audit-evidence/2026-07-17-observability-modal/comparison-before-after.png`

## Findings and fix history

1. The Clarity modal already provided an `overflow-y: auto` scroll surface, while `.configuration-modal` added a second `overflow: auto` and `max-height`. Removed the nested scroll surface and retained the Clarity modal body wrapper as the single vertical scroller.
2. The destructive reset phrase was used only as a narrow input placeholder. Added a persistent, fully visible `RESET OBSERVABILITY DATA` token, a clearly labelled input, and an explicit mismatch/match status message.
3. Clarity wraps `clrInput` in three intrinsic-width containers. Expanded those wrappers and the input to the confirmation field width. The deployed input measures 716 px.

## Verification

- Runtime DOM inspection found exactly one overflowing vertical container: `.modal-body-wrapper`.
- Confirmation input width: 716 px; all Clarity wrapper widths: 720 px.
- Full reset token is visible without relying on placeholder text.
- Cluster Manager deployment: 2/2 Ready.
- UIPluginRegistration: Activated.
- Automated tests: 26/26 passed.

## Final result

**PASSED** — the modal uses one vertical scrollbar and the reset confirmation text is fully readable.
