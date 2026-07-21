'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifySupabaseToken } = require('../server');

test('Cluster Manager delegates an authenticated request to the Console Supabase identity authority', async () => {
  let call;
  const actor = await verifySupabaseToken('supabase-access-token', async (url, init) => {
    call = { url, init };
    return { ok: true, status: 200, json: async () => ({ subject: 'subject-1', username: 'cmars', groups: ['console-admins'] }) };
  });
  assert.match(call.url, /\/api\/identity\/session$/);
  assert.equal(call.init.headers.authorization, 'Bearer supabase-access-token');
  assert.deepEqual(actor, { username: 'cmars', subject: 'subject-1', groups: ['console-admins'], provider: 'supabase' });
});

test('invalid sessions and unavailable identity authority fail closed', async () => {
  await assert.rejects(
    verifySupabaseToken('revoked-token', async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid Supabase session' }) })),
    (error) => error.code === 401 && error.msg === 'invalid Supabase session',
  );
  await assert.rejects(
    verifySupabaseToken('token', async () => { throw new Error('network down'); }),
    (error) => error.code === 503 && error.msg === 'Supabase identity authority unavailable',
  );
});
