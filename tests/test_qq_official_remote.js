'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const values = new Map([
    ['ib_home_node_token', 'mock-desktop-token'],
    ['ib_home_node_http', 'http://127.0.0.1:23138']
  ]);
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const requests = [];
  const window = { IB: {}, __IB_HOME_NODE_PORT__: 23138 };
  const context = {
    window,
    localStorage: storage,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, paused: false, accounts: [] }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/home-node-client.js'), 'utf8'), context,
    { filename: 'home-node-client.js-qq-groups' });
  const remote = window.IB.createQQOfficialRemote({ writeTimeoutMs: 1000 });
  const result = await remote.configure({
    paused: false,
    accounts: [{
      appId: 'group-client-app', roleId: 'role-private', takeover: false,
      allowedUserOpenIds: ['c2c-member-openid'], combinedIntentConsent: true,
      privateRoleSelections: [{ userOpenId: 'c2c-member-openid', roleId: 'role-member', sessionId: 'session-private-a' }],
      appSecret: 'must-not-pass',
      groups: [{ groupOpenId: 'group-openid-a', roleId: 'role-group-a', takeover: true,
        adminMemberOpenIds: ['member-openid-admin'], sessionId: 'session-group-a',
        unexpected: 'must-not-pass' }]
    }]
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.accounts[0].groups, [
    { groupOpenId: 'group-openid-a', roleId: 'role-group-a', takeover: true,
      adminMemberOpenIds: ['member-openid-admin'], sessionId: 'session-group-a' }
  ], 'the local Home Node client forwards only the allowlisted group binding fields');
  assert.deepEqual(body.accounts[0].privateRoleSelections, [
    { userOpenId: 'c2c-member-openid', roleId: 'role-member', sessionId: 'session-private-a' }
  ], 'the local Home Node client forwards private role selections with allowlisted fields');
  assert.equal(Object.prototype.hasOwnProperty.call(body.accounts[0], 'appSecret'), false,
    'group configuration does not alter Vault credential boundaries');
  assert.equal(JSON.stringify(body).includes('must-not-pass'), false, 'unknown and secret fields are stripped');
  console.log('QQ Official Home Node remote preserves group bindings with field allowlisting');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
