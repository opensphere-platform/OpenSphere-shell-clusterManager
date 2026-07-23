#!/usr/bin/env bash
set -euo pipefail

repository="${1:?repository is required}"
source_channel="${2:?source channel is required}"
expected_revision="${3:?expected revision is required}"
source_repository="${4:?source repository is required}"
descriptor_required="${5:-false}"
output_key="${6:-digest}"

digest="$(crane digest "$repository:$source_channel")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
manifest="$(crane manifest "$repository@$digest")"
for architecture in amd64 arm64; do
  count="$(jq --arg arch "$architecture" '[.manifests[]? | select(.platform.os == "linux" and .platform.architecture == $arch)] | length' <<<"$manifest")"
  test "$count" = "1"
  child_digest="$(jq -r --arg arch "$architecture" '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest' <<<"$manifest")"
  [[ "$child_digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  config="$(crane config "$repository@$child_digest")"
  test "$(jq -r '.config.Labels["io.opensphere.source-revision"] // empty' <<<"$config")" = "$expected_revision"
  test "$(jq -r '.config.Labels["org.opencontainers.image.source"] // empty' <<<"$config")" = "https://github.com/$source_repository"
  if test "$descriptor_required" = "true"; then
    jq -e '
      (.config.Labels["io.opensphere.module.descriptor"] | length) > 0 and
      (.config.Labels["io.opensphere.module.descriptor.signature"] | length) > 0 and
      (.config.Labels["io.opensphere.module.descriptor.key-id"] | length) > 0
    ' <<<"$config" >/dev/null
  fi
done
for predicate in https://slsa.dev/provenance/v1 https://spdx.dev/Document/v2.3; do
  gh attestation verify "oci://$repository@$digest" --bundle-from-oci \
    --repo "$source_repository" \
    --signer-workflow "$source_repository/.github/workflows/publish-image.yml" \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --source-ref refs/heads/main --deny-self-hosted-runners \
    --predicate-type "$predicate" >/dev/null
done
echo "$output_key=$digest" >>"$GITHUB_OUTPUT"
