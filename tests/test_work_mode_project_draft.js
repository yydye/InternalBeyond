'use strict';

const assert = require('assert');
const draftModule = require('../assets/js/work-mode-project-draft.js');

async function main() {
  const data = new Map();
  const storage = {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  const store = draftModule.createSessionStore(storage);
  assert.strictEqual(store.save({ projectRef: 'proj_alpha', fileIds: ['pf_a', 'pf_b'], consentId: 'secret' }), true);
  assert.deepStrictEqual(store.load(), { version: 1, projectRef: 'proj_alpha', fileIds: ['pf_a', 'pf_b'] });
  assert.strictEqual(data.get(draftModule.KEY).includes('consentId'), false,
    'the refresh draft stores only a project reference and opaque file IDs');
  assert.strictEqual(data.get(draftModule.KEY).includes('secret'), false);
  assert.strictEqual(store.save({ projectRef: '../outside', fileIds: ['pf_a'] }), false);
  assert.strictEqual(store.save({ projectRef: 'proj_alpha', fileIds: ['pf_a', '../outside'] }), false);
  data.set(draftModule.KEY, '{broken');
  assert.strictEqual(store.load(), null, 'corrupt draft data does not become a selected scope');
  assert.strictEqual(store.clear(), true);
  assert.strictEqual(store.load(), null);
  console.log('Work Mode refresh draft contract passed (project and file IDs only; corrupt and unsafe values rejected).');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
