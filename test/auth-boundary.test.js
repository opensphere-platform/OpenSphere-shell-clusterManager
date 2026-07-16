'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertClaims, assertManagedTokenActive } = require('../server');

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://localhost:8090/oauth2/openid/opensphere-console',
    sub: 'subject-1', preferred_username: 'cmars', aud: 'opensphere-console', azp: 'opensphere-console',
    iat: now, nbf: now, exp: now + 900, typ: 'pat', jti: 'jti-1', ...overrides,
  };
}

test('current Console issuer and managed PAT state are accepted together', () => {
  const c = claims();
  assert.doesNotThrow(() => assertClaims({ alg: 'ES256' }, c));
  assert.doesNotThrow(() => assertManagedTokenActive(c, {
    active: true, type: 'pat', sub: c.sub, username: c.preferred_username, exp: c.exp, jti: c.jti,
  }));
});

test('revoked or mismatched managed credentials fail closed', () => {
  const c = claims();
  assert.throws(() => assertManagedTokenActive(c, { active: false }), (error) => error.msg === 'credential inactive or revoked');
  assert.throws(() => assertManagedTokenActive(c, {
    active: true, type: 'pat', sub: c.sub, username: c.preferred_username, exp: c.exp, jti: 'other',
  }), (error) => error.msg === 'credential state mismatch');
});

test('unsupported issuers and algorithms are rejected before live introspection', () => {
  assert.throws(() => assertClaims({ alg: 'none' }, claims()), (error) => error.msg === 'unexpected alg');
  assert.throws(() => assertClaims({ alg: 'ES256' }, claims({ iss: 'https://attacker.invalid' })), (error) => error.msg === 'bad iss');
});
