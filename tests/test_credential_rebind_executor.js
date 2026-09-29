'use strict';

/* CREDENTIAL-REBIND-R1 executor contract tests.
 * Synthetic-only in-memory IndexedDB. Never opens real IndexedDB, the Vault,
 * a provider, the network, or the Tauri host. */
const assert = require('assert');
const schema = require('../assets/js/webcore-db-schema.js');
const rebind = require('../assets/js/credential-rebind-executor.js');
const { CredentialRebindExecutor, assertWriteSet, findSecretFields, nonSecretProjection } = rebind;

/* ---------- minimal in-memory IndexedDB ---------- */
class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; this.onupgradeneeded = null; this.onblocked = null; }
}
class FakeStore {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  get _def() { return this.tx.db._stores.get(this.name); }
  get indexNames() { return { contains: (n) => this._def.indexNames.has(n) }; }
  createIndex(name) { this._def.indexNames.add(name); return {}; }
  _request() { this.tx._commitToken++; const r = new FakeRequest(); this.tx._pending++; return r; }
  _fire(r, ok, value) {
    setTimeout(() => {
      if (ok) { r.result = value; if (r.onsuccess) r.onsuccess({ target: r }); }
      else { r.error = value; if (r.onerror) r.onerror({ target: r }); }
      this.tx._settle();
    }, 0);
  }
  add(record) {
    const r = this._request();
    const idb = this.tx.db._idb;
    this.tx._addCount = (this.tx._addCount || 0) + 1;
    if (idb && idb.failAddAt && this.tx._addCount === idb.failAddAt) { this._fire(r, false, new Error('synthetic-add-failure')); return r; }
    const keyPath = this._def.keyPath, key = String(record[keyPath]);
    if (this.tx._working.get(this.name).has(key)) { this._fire(r, false, new Error('synthetic-constraint')); return r; }
    this.tx._working.get(this.name).set(key, record);
    this._fire(r, true, key);
    return r;
  }
  delete(key) { const r = this._request(); this.tx._working.get(this.name).delete(String(key)); this._fire(r, true, undefined); return r; }
  getAllKeys() {
    const r = this._request();
    let keys = Array.from(this.tx._working.get(this.name).keys());
    const idb = this.tx.db._idb;
    if (idb && idb.failVerify && keys.length > 0) keys = keys.slice(0, keys.length - 1);
    this._fire(r, true, keys);
    return r;
  }
  getAll() { const r = this._request(); this._fire(r, true, Array.from(this.tx._working.get(this.name).values())); return r; }
}
class FakeTx {
  constructor(db, names, mode) {
    this.db = db; this.mode = mode; this.error = null;
    this.oncomplete = null; this.onabort = null; this.onerror = null;
    this._aborted = false; this._done = false; this._pending = 0; this._commitToken = 0;
    this._working = new Map();
    names.forEach((n) => { const s = db._stores.get(n); this._working.set(n, s ? new Map(s.records) : new Map()); });
  }
  objectStore(name) { return new FakeStore(this, name); }
  _settle() {
    this._pending = Math.max(0, this._pending - 1);
    if (this._pending === 0 && !this._aborted && !this._done) this._scheduleCommit();
  }
  _scheduleCommit() {
    const token = ++this._commitToken;
    setTimeout(() => {
      if (token === this._commitToken && this._pending === 0 && !this._aborted && !this._done) this._commit();
    }, 0);
  }
  _commit() {
    if (this._done || this._aborted) return;
    this._done = true;
    this._working.forEach((records, n) => { const s = this.db._stores.get(n); if (s) s.records = records; });
    if (this.oncomplete) this.oncomplete();
  }
  abort() {
    if (this._aborted || this._done) return;
    this._aborted = true;
    this.error = new Error('synthetic-abort');
    setTimeout(() => { if (this.onabort) this.onabort(); }, 0);
  }
}
class FakeDB {
  constructor(name, idb) {
    this.name = name; this.version = 0; this._stores = new Map(); this._idb = idb;
    this.objectStoreNames = { contains: (n) => this._stores.has(n) };
  }
  createObjectStore(name, options) { this._stores.set(name, { keyPath: (options && options.keyPath) || 'id', records: new Map(), indexNames: new Set() }); return new FakeStore(new FakeTx(this, [name], 'versionchange'), name); }
  transaction(names, mode) { return new FakeTx(this, Array.prototype.slice.call(names), mode); }
  close() {}
}
class FakeIndexedDB {
  constructor() { this._dbs = new Map(); this.failAddAt = 0; this.failVerify = false; }
  open(name, version) {
    const request = new FakeRequest();
    setTimeout(() => {
      let db = this._dbs.get(name);
      const old = db ? db.version : 0;
      if (!db) { db = new FakeDB(name, this); this._dbs.set(name, db); }
      if (Number(version) > old) {
        const vtx = new FakeTx(db, Array.from(db._stores.keys()), 'versionchange');
        request.result = db; request.transaction = vtx;
        if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
        db.version = Number(version);
        vtx._done = true;
      } else { request.result = db; }
      if (request.onsuccess) request.onsuccess({ target: request });
    }, 0);
    return request;
  }
  databases() { return Promise.resolve(Array.from(this._dbs.values()).map((db) => ({ name: db.name, version: db.version }))); }
  deleteDatabase(name) { const r = new FakeRequest(); this._dbs.delete(name); setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0); return r; }
}

/* ---------- frozen synthetic write set (real frozen IDs + hash) ---------- */
const FROZEN_IDS = [
  'friend_1785224987526', 'friend_1785251795342', 'friend_1785261242640', 'friend_1785262029060',
  'friend_1785301791932', 'friend_1785302414855', 'friend_1785309697872', 'friend_1785310595095',
  'friend_1785411296532', 'friend_1787391487573_1w3xz7', 'friend_1787813887723_w4lxqx',
  'friend_1787927183336_epr19a', 'friend_1788318367937_tcmw0p'
];
const PROVIDERS = ['deepseek', 'glm', 'mimo', 'deepseek', 'glm', 'mimo', 'mimo', 'deepseek', 'mimo', 'deepseek', 'deepseek', 'mimo', 'qwen'];
function makeWriteSet(overrides = {}) {
  const rows = FROZEN_IDS.map((id, i) => ({
    id, vaultBindingId: id, provider: PROVIDERS[i], endpoint: 'https://provider.invalid/v1/chat/completions',
    model: 'synthetic-model', nickname: 'R' + i, temperature: 0.7, streaming: true, vision: true,
    imageGen: false, sortOrder: i, secretProjected: false
  }));
  return Object.assign({ hash: rebind.FROZEN_WRITE_SET_HASH, operations: { INSERT: 13, UPDATE: 0, DELETE: 0 }, target: rebind.TARGET, rows }, overrides);
}
function makeExecutor(idb, writeSet, extra = {}) {
  return new CredentialRebindExecutor(Object.assign({
    indexedDB: idb, schema, writeSet, testOnlySyntheticHost: true, trustedHost: true
  }, extra));
}

let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('PASS ' + name); }

async function main() {
  console.log('CREDENTIAL-REBIND-R1 executor synthetic tests');

  await check('write set: 13 ids recompute to the frozen config-id-set hash', async () => {
    const validated = await assertWriteSet(makeWriteSet());
    assert.strictEqual(validated.ids.length, 13);
    assert.strictEqual(validated.idSetSha256, rebind.FROZEN_CONFIG_ID_SET_HASH);
  });

  await check('write set: rejects wrong hash, ops, count, duplicate id, secret field, id-set', async () => {
    await assert.rejects(assertWriteSet(makeWriteSet({ hash: 'f'.repeat(64) })), /write-set-hash-mismatch/);
    await assert.rejects(assertWriteSet(makeWriteSet({ operations: { INSERT: 13, UPDATE: 1, DELETE: 0 } })), /operations-invalid/);
    await assert.rejects(assertWriteSet(makeWriteSet({ operations: { INSERT: 13, UPDATE: 0, DELETE: 1 } })), /operations-invalid/);
    const short = makeWriteSet(); short.rows = short.rows.slice(0, 12);
    await assert.rejects(assertWriteSet(short), /row-count-invalid/);
    const dup = makeWriteSet(); dup.rows[1] = Object.assign({}, dup.rows[1], { id: dup.rows[0].id, vaultBindingId: dup.rows[0].id });
    await assert.rejects(assertWriteSet(dup), /(row-id-duplicate|config-id-set-mismatch)/);
    const secret = makeWriteSet(); secret.rows[0] = Object.assign({}, secret.rows[0], { apiKey: 'x' });
    await assert.rejects(assertWriteSet(secret), /secret-field-forbidden/);
    const nested = makeWriteSet(); nested.rows[2] = Object.assign({}, nested.rows[2], { options: { imageGenApiKey: 'x' } });
    await assert.rejects(assertWriteSet(nested), /secret-field-forbidden/);
    await assert.rejects(assertWriteSet(makeWriteSet(), { expectedIdSetHash: '0'.repeat(64) }), /config-id-set-mismatch/);
  });

  await check('secret detection + projection strip forbidden keys at depth', async () => {
    assert.deepStrictEqual(findSecretFields({ a: 1, nested: { token: 'x' } }), ['nested.token']);
    assert.deepStrictEqual(findSecretFields({ apiKey: 'x', imageGenApiKey: 'y' }).sort(), ['apiKey', 'imageGenApiKey']);
    assert.deepStrictEqual(nonSecretProjection({ id: 'a', apiKey: 'x', o: { secret: 'y' }, keep: 1 }), { id: 'a', o: {}, keep: 1 });
  });

  await check('host gate: executor refuses without the RecoveryOnly host marker', async () => {
    const idb = new FakeIndexedDB();
    const executor = new CredentialRebindExecutor({ indexedDB: idb, schema, writeSet: makeWriteSet() });
    await assert.rejects(executor.preflight(), /recoveryonly-host-required/);
  });

  await check('origin gate: wrong origin is refused', async () => {
    const idb = new FakeIndexedDB();
    const executor = makeExecutor(idb, makeWriteSet(), { location: { origin: 'http://evil.example' } });
    await assert.rejects(executor.preflight(), /origin-mismatch/);
  });

  await check('preflight: empty target is required and reported', async () => {
    const idb = new FakeIndexedDB();
    const executor = makeExecutor(idb, makeWriteSet());
    const result = await executor.preflight();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.currentCount, 0);
    assert.strictEqual(result.empty, true);
    assert.strictEqual(result.planned, 13);
  });

  await check('execute happy path: 13 inserted, readback verified, 0 secrets', async () => {
    const idb = new FakeIndexedDB();
    const executor = makeExecutor(idb, makeWriteSet());
    await assert.rejects(executor.execute('wrong phrase'), /confirmation-required/);
    const report = await executor.execute(rebind.CONFIRMATION);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.planned, 13);
    assert.strictEqual(report.actual, 13);
    assert.strictEqual(report.secretPersisted, 0);
    assert.strictEqual(report.providerCalls, 0);
    const keys = await executor._readKeys();
    assert.strictEqual(keys.length, 13);
    const stored = idb._dbs.get('InternalBeyondDB')._stores.get('apiConfigs').records;
    assert.strictEqual(stored.size, 13);
    Array.from(stored.values()).forEach((row) => assert.strictEqual(findSecretFields(row).length, 0));
    executor.close();
  });

  await check('non-empty target is refused (no UPDATE/DELETE)', async () => {
    const idb = new FakeIndexedDB();
    const seed = makeExecutor(idb, makeWriteSet());
    await seed.execute(rebind.CONFIRMATION);
    seed.close();
    const executor = makeExecutor(idb, makeWriteSet());
    await assert.rejects(executor.execute(rebind.CONFIRMATION), /target-not-empty/);
    const count = await executor._readKeys();
    assert.strictEqual(count.length, 13);
    executor.close();
  });

  await check('transaction failure aborts atomically and leaves 0 rows', async () => {
    const idb = new FakeIndexedDB();
    idb.failAddAt = 5;
    const executor = makeExecutor(idb, makeWriteSet());
    await assert.rejects(executor.execute(rebind.CONFIRMATION), /CREDENTIAL_REBIND_FAILED_ROLLED_BACK|synthetic-add-failure/);
    const count = await executor._readKeys().catch(() => []);
    assert.strictEqual(count.length, 0);
    executor.close();
  });

  await check('post-commit verification failure triggers delete rollback to 0 rows', async () => {
    const idb = new FakeIndexedDB();
    const executor = makeExecutor(idb, makeWriteSet());
    idb.failVerify = true;
    await assert.rejects(executor.execute(rebind.CONFIRMATION), /CREDENTIAL_REBIND_FAILED_ROLLED_BACK/);
    idb.failVerify = false;
    const count = await executor._readKeys();
    assert.strictEqual(count.length, 0);
    executor.close();
  });

  await check('verify() reports missing ids and rollback() deletes only given keys', async () => {
    const idb = new FakeIndexedDB();
    const executor = makeExecutor(idb, makeWriteSet());
    await executor.execute(rebind.CONFIRMATION);
    const bad = await executor.verify(['friend_1785224987526', 'friend_missing']);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.failures.some((f) => f.reason === 'missing-ids'));
    const rolled = await executor.rollback(['friend_1785224987526']);
    assert.strictEqual(rolled.ok, true);
    const keys = await executor._readKeys();
    assert.strictEqual(keys.length, 12);
    assert.ok(!keys.includes('friend_1785224987526'));
    executor.close();
  });

  console.log('PASS ' + pass + ' CREDENTIAL-REBIND-R1 executor checks');
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
