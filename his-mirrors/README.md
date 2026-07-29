# Crossplane curated runtime mirrors

The Crossplane package registry remains the package authority. These images
mirror only the approved `linux/amd64` runtime manifests used by the local
Docker Desktop HISS profile, because kind/containerd cannot reliably pull the
upstream xpkg runtime layers.

| Runtime | Upstream compatibility | Upstream source revision | Official KST version | Canonical repository |
| --- | --- | --- | --- | --- |
| Crossplane core | v2.3.3 | `09ffaea39ccaea0f80817e35b5bbd3632b4e7e0d` | `202606222233` | `ghcr.io/opensphere-platform/mirror-crossplane` |
| provider-helm | v1.3.0 | `df02f201fec49fdabd095421bc3b0a67b1b296b6` | `202607010129` | `ghcr.io/opensphere-platform/mirror-crossplane-provider-helm` |

The Dockerfiles pin the upstream child manifest digest and add the
CONSTITUTION-0005 metadata. Publication is `linux/amd64` only. The HISS chart
uses the resulting GHCR exact digest; it never deploys `:edge`.
