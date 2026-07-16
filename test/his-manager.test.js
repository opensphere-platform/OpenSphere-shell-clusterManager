'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HIS_CATALOG, catalogItem } = require('../his-catalog');
const { reasonFrom, safeError, kubeconfigText } = require('../his-manager');

test('HIS catalog keeps PFS/plugin concepts outside the prerequisite catalog', () => {
  assert.ok(HIS_CATALOG.some((item) => item.mode === 'DetectOnly'));
  assert.ok(HIS_CATALOG.some((item) => item.mode === 'HelmManaged'));
  assert.equal(catalogItem('foundation'), undefined);
  assert.equal(catalogItem('metrics-server').chartVersion, '3.13.1');
});

test('mutation reason is mandatory and bounded', () => {
  assert.throws(() => reasonFrom({ reason: 'short' }), /8자 이상/);
  assert.equal(reasonFrom({ reason: 'HIS 설치 승인 근거' }), 'HIS 설치 승인 근거');
  assert.throws(() => reasonFrom({ reason: 'x'.repeat(501) }), /500자 이하/);
});

test('safe errors redact bearer tokens', () => {
  assert.equal(safeError(new Error('Bearer secret.value failed')), 'Bearer [redacted] failed');
});

test('generated kubeconfig does not disable TLS verification', () => {
  const config = kubeconfigText('token', '/var/run/ca.crt', 'https://kubernetes.default.svc');
  assert.match(config, /certificate-authority: \/var\/run\/ca.crt/);
  assert.doesNotMatch(config, /insecure-skip-tls-verify/);
});
