'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeK8sProxyRequest, buildK8sReadHeaders } = require('../server');

const req = (authorization) => ({ headers: authorization ? { authorization } : {} });

test('authenticated Console reads use the bounded ServiceAccount without impersonation headers', async () => {
  const actor = { username: 'cmars', groups: ['opensphere-console-admins'] };
  const verified = await authorizeK8sProxyRequest(
    req('Bearer console-token'),
    false,
    async (token) => {
      assert.equal(token, 'console-token');
      return actor;
    },
  );
  assert.equal(verified, actor);

  const headers = buildK8sReadHeaders('service-account-token');
  assert.deepEqual(headers, {
    Authorization: 'Bearer service-account-token',
    Accept: 'application/json',
  });
  assert.equal(headers['Impersonate-User'], undefined);
  assert.equal(headers['Impersonate-Group'], undefined);
});

test('missing or invalid Console credentials fail closed instead of falling back to ServiceAccount access', async () => {
  await assert.rejects(
    authorizeK8sProxyRequest(req(), false, async () => { throw { code: 401, msg: 'no id token' }; }),
    (error) => error.code === 401 && error.msg === 'no id token',
  );
  await assert.rejects(
    authorizeK8sProxyRequest(req('Bearer revoked'), false, async () => { throw { code: 401, msg: 'credential inactive or revoked' }; }),
    (error) => error.code === 401 && error.msg === 'credential inactive or revoked',
  );
});

test('generic Kubernetes mutations stay outside the approved HIS mutation boundary', async () => {
  await assert.rejects(
    authorizeK8sProxyRequest(req('Bearer console-token'), true, async () => ({ username: 'cmars', groups: ['opensphere-console-admins'] })),
    (error) => error.code === 403 && /approved HIS action/.test(error.msg),
  );
});
