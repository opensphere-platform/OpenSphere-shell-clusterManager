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

---

# Design QA — Ceph Monitoring navigation

- Source: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-ec3e5f1f-59fb-4f07-ab5c-30b3f7ecb123.png`
- Implementation: `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\.codex-tmp\ceph-monitoring-tree-preview\implementation-tree.png`
- Comparison: `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\.codex-tmp\ceph-monitoring-tree-preview\comparison.png`
- Viewport: Chrome desktop, 2292 × 1977
- State: `Ceph Storage > Storage (Ceph/ODF) > Ceph Monitoring > 클러스터`

## Evidence

- `Ceph Monitoring` is a tree in the existing Cluster Manager second-level navigation, immediately after `Ceph Clusters`.
- Dashboard categories expand within that navigation; selecting a leaf updates the route and embedded Grafana dashboard.
- The page-level dashboard list, search field, nested sidebar, and its additional frame were removed.
- Grafana renders in the remaining full-width content region.
- Time range and refresh controls update the selected option and Grafana query.
- Automated verification: 96 tests passed; Angular production build passed.

## Findings and resolution history

1. P1 — Dashboard menu was duplicated inside the page and created a nested-frame layout.
   - Resolved by moving the dashboard catalog into the existing second-level navigation tree.
2. P1 — Embedded Grafana failed while iframe sandboxing was enabled.
   - Resolved by removing the incompatible sandbox restriction while retaining the fixed HTTPS allowlist, `no-referrer`, and `noopener`.
3. P2 — Native select controls visually selected the first option although the generated URL used the signal defaults.
   - Resolved by binding each option's selected state to the current time-range and refresh signals.

## Final result

Passed — no open P0, P1, or P2 visual or core-interaction issues.

---

# Design QA — Shared Observability lifecycle modal

- Date: 2026-07-27
- Deployed version: `cluster-manager 1.3.13` / `202607270730`
- Source visual truth: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-3dbe7b15-751d-45ec-b54b-4c19b69a7b01.png`
- Implementation screenshot: blocked before capture by Console MFA
- Source pixels: `1173 × 1200`
- Intended implementation viewport: same desktop viewport and lifecycle state
- State: Shared Observability 관리 · 설치되지 않음 · readiness/plan blocked

## Full-view comparison evidence

The supplied source capture was opened at original resolution. It proves that the Clarity modal body creates a nested vertical scroller and that `kube-prometheus-stack` is presented without Prometheus or Grafana product imagery. The `1.3.13` implementation has been deployed, but the authenticated rendered state cannot yet be captured because the visible Chrome tab is waiting for the user's current six-digit MFA code.

## Focused comparison evidence

No post-fix focused crop is available yet. Source-focused inspection covers the modal title, chart summary, lifecycle timeline, readiness board, plan form, nested scrollbar, and footer. This evidence is sufficient to define the fixes, but not to pass visual QA without a rendered comparison.

## Findings and comparison history

1. **P1 — Nested desktop modal scrollbar**
   - Earlier evidence: the source image shows a second scrollbar inside the modal even at `1173 × 1200`, and the footer is separated from content by that scroll region.
   - Fix made: `.lifecycle-workspace` now uses `max-height: none` and `overflow: visible` on desktop. READINESS and PLAN are placed in a `0.96fr / 1.04fr` parallel grid to reduce content height instead of merely enlarging the dialog.
   - Post-fix evidence: pending authenticated Chrome capture and measured `scrollHeight/clientHeight`.

2. **P2 — Product identity is reduced to the chart name**
   - Earlier evidence: the source title and summary use only text.
   - Fix made: the supplied Prometheus and Grafana SVG assets are used in the modal title and chart lockup. Both asset URLs returned HTTP `200 image/svg+xml`.
   - Post-fix evidence: pending authenticated Chrome capture and image-complete checks.

## Required fidelity surfaces

- Fonts and typography: OpenSphere/Clarity typography and title hierarchy are preserved; rendered wrapping remains to be checked.
- Spacing and layout rhythm: the desktop content is reflowed into a parallel operational board; rendered modal/footer fit remains to be checked.
- Colors and visual tokens: all new surfaces use existing `--os-*` tokens; no hard-coded component color was added.
- Image quality and asset fidelity: real supplied SVG logos are used without handcrafted substitutes; rendered sharpness and loading remain to be checked.
- Copy and content: lifecycle meaning, chart version, readiness, installation options, and action labels are preserved.
- Accessibility: decorative title logos are hidden from assistive technology; summary logos have descriptive alternative text. Keyboard and 200% zoom checks remain pending.

## Automated and deployment evidence

- Tests: `104/104` passed.
- Production build: passed.
- Signature and manifest: verified with `opensphere-edge-local-v1`.
- Runtime: `Activated / Ready`, `2/2` replicas.
- Exact digest: `sha256:c697fab3ef631384bc7fa8f60e4654f1aada20ed057f4a402249fb03f740533a`.

## Remaining blocker

Enter the current six-digit MFA code in the visible Chrome tab. Then capture the deployed modal at the same state, compare it with the source, measure overflow, test keyboard/zoom behavior, and update this section with post-fix evidence.

final result: blocked
