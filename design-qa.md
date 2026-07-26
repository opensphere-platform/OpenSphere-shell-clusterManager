# Design QA — 외부 Ceph 클러스터 현황 타이틀 바

- Date: 2026-07-26
- Deployed version: `cluster-manager 1.3.6`
- URL: `https://localhost:1114/p/cluster-manager/ceph/ceph`
- Browser: signed-in Chrome
- State: `클러스터 현황` 탭, `HEALTH_OK`, 관측 데이터 표시

## Visual truth and implementation

- Source visual truth: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-3524cb32-f1a1-465e-8af0-4443fa97d136.png`
- Browser implementation full view: `audit-evidence/ceph-insights-1.3.6-full.png`
- Focused title-bar capture: `audit-evidence/ceph-insights-1.3.6-title-bar.png`
- Narrow viewport capture: `audit-evidence/ceph-insights-1.3.6-mobile.png`
- Before/after comparison: `audit-evidence/ceph-insights-title-bar-comparison.png`

## Viewport and normalization

- Source pixels: `2000 × 538`, supplied desktop capture.
- Desktop implementation pixels and CSS viewport: `2293 × 1934`, device scale factor `1`.
- Focused implementation pixels: `1950 × 300`.
- Narrow implementation pixels and CSS viewport: `720 × 1000`, device scale factor `1`.
- Focused comparison normalizes both title-bar crops to `1950px` width. Browser chrome is excluded.

## Findings and comparison history

1. **Earlier P1 — Host Shell header rule collapsed the title bar.**
   - Evidence: the source capture shows the 76px logo and descriptive text extending outside the fixed-height bar.
   - Cause: the component used a native `<header class="insights-hero">`, allowing the Host Shell's global `header` rule to constrain its height.
   - Fix: replaced the native header with an isolated component container and defined a two-column `minmax(0, 1fr) auto` grid, explicit content column, intrinsic `height: auto`, `min-height: 108px`, and responsive one-column behavior.
   - Post-fix evidence: the deployed desktop bar measures `1934 × 112px`; logo, copy and action remain inside its bounds. `scrollWidth === clientWidth` and `scrollHeight === clientHeight`.

2. **Earlier P2 — narrow layouts had no reliable stacking contract.**
   - Fix: at `max-width: 760px`, the title bar becomes one column, the identity block uses a `56px + minmax(0, 1fr)` grid, and the refresh action fills the available width.
   - Post-fix evidence: at `720 × 1000`, the available content rail is narrow because the management navigation remains visible, but the title bar has no horizontal or vertical overflow and all text and controls remain readable.

## Required fidelity surfaces

- Fonts and typography: existing OpenSphere/Clarity typography is preserved. Heading weight, eyebrow tracking and body line height remain consistent; Korean copy wraps without clipping.
- Spacing and layout rhythm: logo, title copy and action use explicit grid tracks and remain vertically centered at desktop width. Narrow width stacks predictably.
- Colors and tokens: existing Ceph observation colors, blue accent rail, neutral border and semantic button states are unchanged.
- Image quality and assets: the supplied Ceph SVG remains the source asset, rendered at `48 × 48px` inside a `64 × 64px` frame without stretching.
- Copy and content: all original labels and explanatory text are unchanged.

## Browser verification

- Primary interaction tested: opened `클러스터 현황` from the deployed Ceph page.
- Desktop overflow: none.
- Narrow viewport overflow: none.
- Browser console errors: `0`.
- Automated regression tests: `79/79` passed.
- Deployment: `cluster-manager 1.3.6`, `Activated / Ready`, `2/2` replicas.

## Remaining findings

No actionable P0, P1 or P2 visual mismatch remains. The narrow viewport still retains the product's persistent management navigation; this is existing shell behavior and does not break the corrected title bar.

final result: passed
