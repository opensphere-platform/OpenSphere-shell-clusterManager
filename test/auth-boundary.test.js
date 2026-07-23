'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifySupabaseToken } = require('../server');

const hisManagerSource = fs.readFileSync(path.join(__dirname, '..', 'his-manager.js'), 'utf8');
const cephManagerSource = fs.readFileSync(path.join(__dirname, '..', 'ceph-manager.js'), 'utf8');

test('Cluster Manager delegates an authenticated request to the Console Supabase identity authority', async () => {
  let call;
  const actor = await verifySupabaseToken('supabase-access-token', async (url, init) => {
    call = { url, init };
    return { ok: true, status: 200, json: async () => ({ subject: 'subject-1', username: 'cmars', groups: ['console-admins'], permissions: ['console.his.read', 'console.his.manage'], assurance: 'aal2' }) };
  });
  assert.match(call.url, /\/api\/identity\/session$/);
  assert.equal(call.init.headers.authorization, 'Bearer supabase-access-token');
  assert.deepEqual(actor, {
    username: 'cmars', subject: 'subject-1', groups: ['console-admins'],
    permissions: ['console.his.read', 'console.his.manage'], assurance: 'aal2', provider: 'supabase',
  });
});

test('Cluster Manager defaults missing assurance and permission claims closed', async () => {
  const actor = await verifySupabaseToken('legacy-session', async () => ({
    ok: true, status: 200, json: async () => ({ subject: 'subject-2', groups: ['console-admins'] }),
  }));
  assert.deepEqual(actor.permissions, []);
  assert.equal(actor.assurance, 'aal1');
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

test('HIS and Ceph owner facades accept the canonical Supabase Console admin role', () => {
  for (const source of [hisManagerSource, cephManagerSource]) {
    assert.match(source, /CONSOLE_ADMIN_GROUPS/);
    assert.match(source, /console-admins,opensphere-console-admins/);
    assert.match(source, /groups\.some\(\(group\) => ADMIN_GROUPS\.has\(group\)\)/);
  }
});

test('dedicated HIS OAA owner facade double-validates permission and AAL2', () => {
  assert.match(hisManagerSource, /console\.his\.read/);
  assert.match(hisManagerSource, /console\.his\.manage/);
  assert.match(hisManagerSource, /actorForOaaOwner/);
  assert.match(hisManagerSource, /AAL2 재인증/);
  assert.match(hisManagerSource, /\/api\/his\/oaa\/observability\/configure/);
});

test('dedicated Ceph OAA owner facade double-validates permission, AAL2, and staged imports', () => {
  assert.match(cephManagerSource, /console\.ceph\.read/);
  assert.match(cephManagerSource, /console\.ceph\.manage/);
  assert.match(cephManagerSource, /actorForOaaOwner/);
  assert.match(cephManagerSource, /Ceph OAA 변경은 AAL2 재인증/);
  assert.match(cephManagerSource, /StagedSecretRefOnly/);
});
