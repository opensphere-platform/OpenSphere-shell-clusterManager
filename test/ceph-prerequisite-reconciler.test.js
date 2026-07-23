const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPECTED_DESIRED_STATE,
  canonicalJson,
  crdEstablished,
  deploymentReady,
  validateGovernedManifest,
  sha256,
} = require('../ceph-prerequisite-reconciler');

function work() {
  return {
    request_id: '123e4567-e89b-42d3-a456-426614174000',
    target: 'rook-ceph/v1.20.2',
    reason: '외부 Ceph 연결 선행요소 설치',
  };
}

function manifest() {
  const desiredState = JSON.parse(JSON.stringify(EXPECTED_DESIRED_STATE));
  return {
    apiVersion: 'platform.opensphere.io/v1alpha1',
    kind: 'GovernedChange',
    metadata: {
      requestId: work().request_id,
      consumerId: 'ceph-prerequisites',
      payloadDigest: `sha256:${sha256(canonicalJson(desiredState))}`,
    },
    spec: {
      action: 'apply',
      target: work().target,
      reason: work().reason,
      desiredState,
    },
  };
}

test('accepts only the pinned Ceph prerequisite contract', () => {
  assert.equal(validateGovernedManifest(manifest(), work()).spec.desiredState.release.version, 'v1.20.2');
  const changed = manifest();
  changed.spec.desiredState.release.version = 'latest';
  assert.throws(() => validateGovernedManifest(changed, work()), /pinned release/);
});

test('rejects a valid payload when consumer or release target differs', () => {
  const wrongConsumer = manifest();
  wrongConsumer.metadata.consumerId = 'extensions';
  assert.throws(() => validateGovernedManifest(wrongConsumer, work()), /identity mismatch/);
  const wrongTarget = manifest();
  wrongTarget.spec.target = 'rook-ceph/latest';
  assert.throws(() => validateGovernedManifest(wrongTarget, work()), /closed contract/);
});

test('observed readiness requires Established CRD and available operator generation', () => {
  assert.equal(crdEstablished({ status: { conditions: [{ type: 'Established', status: 'True' }] } }), true);
  assert.equal(crdEstablished({ status: { conditions: [{ type: 'Established', status: 'False' }] } }), false);
  assert.equal(deploymentReady({
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: { observedGeneration: 3, availableReplicas: 1, readyReplicas: 1 },
  }), true);
  assert.equal(deploymentReady({
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: { observedGeneration: 2, availableReplicas: 1, readyReplicas: 1 },
  }), false);
});
