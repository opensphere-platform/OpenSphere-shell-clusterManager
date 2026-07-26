#!/usr/bin/env bash
set -euo pipefail

image="${1:?image reference is required}"
expected_compatibility_version="${2:?expected compatibility version is required}"
expected_release_tag="${3:?expected official release tag is required}"
manifest="$(crane manifest "$image")"
platforms=0
baseline_descriptor=""
baseline_signature=""

while IFS= read -r platform_digest; do
  config="$(crane config "${image%@*}@$platform_digest")"
  descriptor="$(jq -er '.config.Labels["io.opensphere.module.descriptor"]' <<<"$config")"
  signature="$(jq -er '.config.Labels["io.opensphere.module.descriptor.signature"]' <<<"$config")"
  key_id="$(jq -er '.config.Labels["io.opensphere.module.descriptor.key-id"]' <<<"$config")"
  oci_version="$(jq -er '.config.Labels["org.opencontainers.image.version"]' <<<"$config")"
  release_tag="$(jq -er '.config.Labels["io.opensphere.release-tag"]' <<<"$config")"
  compatibility_version="$(jq -er '.config.Labels["io.opensphere.compatibility-version"]' <<<"$config")"
  channel="$(jq -er '.config.Labels["io.opensphere.channel"]' <<<"$config")"
  build_authority="$(jq -er '.config.Labels["opensphere.io/build-authority"]' <<<"$config")"
  descriptor_key_id="$(jq -er '.trust.keyId' <<<"$descriptor")"

  jq -e --arg version "$expected_compatibility_version" \
    '.version == $version and .id == "cluster-manager" and .kind == "subShell"' <<<"$descriptor" >/dev/null
  test "$oci_version" = "$expected_release_tag"
  test "$release_tag" = "$expected_release_tag"
  test "$compatibility_version" = "$expected_compatibility_version"
  test "$channel" = "ga"
  test "$build_authority" = "github-actions"
  test "$key_id" = "$descriptor_key_id"
  test -n "$signature"
  if [[ -z "$baseline_descriptor" ]]; then
    baseline_descriptor="$descriptor"
    baseline_signature="$signature"
  else
    test "$descriptor" = "$baseline_descriptor"
    test "$signature" = "$baseline_signature"
  fi
  platforms=$((platforms + 1))
done < <(jq -er '.manifests[] | select(.platform.os == "linux" and (.platform.architecture == "amd64" or .platform.architecture == "arm64")) | .digest' <<<"$manifest")

test "$platforms" = 2
