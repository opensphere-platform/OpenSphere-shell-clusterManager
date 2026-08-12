'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  forwardedHeaders,
  upstreamPath,
} = require('../module-lifecycle-proxy');

test('Shared Observability lifecycle proxy exposes only the approved common module routes', () => {
  assert.equal(
    upstreamPath('/api/module-lifecycle/modules/shared-observability'),
    '/api/modules/shared-observability',
  );
  assert.equal(
    upstreamPath('/api/module-lifecycle/modules/shared-observability/operations'),
    '/api/modules/shared-observability/operations',
  );
  assert.equal(
    upstreamPath('/api/module-lifecycle/modules/shared-observability/verify'),
    '/api/modules/shared-observability/verify',
  );
  assert.equal(
    upstreamPath('/api/module-lifecycle/module-operations/123e4567-e89b-12d3-a456-426614174000'),
    '/api/module-operations/123e4567-e89b-12d3-a456-426614174000',
  );
  assert.equal(upstreamPath('/api/module-lifecycle/modules/argocd/operations'), '');
  assert.equal(upstreamPath('/api/module-lifecycle/modules/shared-observability/../argocd'), '');
});

test('lifecycle proxy forwards only identity and operation correlation headers', () => {
  const headers = forwardedHeaders({
    headers: {
      authorization: 'Bearer console-user-token',
      'content-type': 'application/json',
      'x-os-correlation-id': 'corr-123',
      'x-os-idempotency-key': 'idem-12345678',
      'x-opensphere-actor': 'spoofed-admin',
      cookie: 'sensitive-browser-cookie',
    },
  });
  assert.deepEqual(headers, {
    accept: 'application/json',
    authorization: 'Bearer console-user-token',
    'content-type': 'application/json',
    'x-os-correlation-id': 'corr-123',
    'x-os-idempotency-key': 'idem-12345678',
  });
});

test('HIS UI sends Shared Observability lifecycle mutations through the common module API', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/app/core/his.service.ts'),
    'utf8',
  );
  assert.match(source, /modules\/shared-observability\/verify/);
  assert.match(source, /modules\/shared-observability\/operations/);
  assert.match(source, /action:\s*'install'/);
  assert.match(source, /action:\s*'delete-runtime'/);
  assert.match(source, /if \(id === 'kube-prometheus-stack'\)/);
});

test('runtime image contains the common module lifecycle proxy required by server.js', () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --chmod=0644 server\.js module-lifecycle-proxy\.js \/app\//);
});
