'use strict';

/* Memory UI uses the Home Node canonical records through the existing db* seam. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const memoryUi = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8');
const worldUi = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory-world.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8');
const autoMemory = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory', 'auto-memory.js'), 'utf8');
const siteOperations = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'site-operations.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'core.js'), 'utf8');
const localVault = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'local-vault.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const memoryContract = fs.readFileSync(path.join(ROOT, 'docs', 'contracts', 'memory', 'MEMORY_RECALL_CONTRACT.md'), 'utf8');
const authorityModule = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const createMemoryRetrieval = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); return; }
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  throw new Error(name + (detail ? ': ' + detail : ''));
}
function block(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('source block not found: ' + start);
  return source.slice(a, b);
}
function makeLocal() {
  const rows = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    get: id => Promise.resolve(rows.has(String(id)) ? clone(rows.get(String(id))) : null),
    getAll: () => Promise.resolve(Array.from(rows.values()).map(clone)),
    put: row => { rows.set(String(row.id), clone(row)); return Promise.resolve(true); },
    remove: id => { rows.delete(String(id)); return Promise.resolve(true); },
    replaceAll: list => { rows.clear(); (list || []).forEach(row => rows.set(String(row.id), clone(row))); return Promise.resolve(true); },
    applyUpserts: list => { (list || []).forEach(row => rows.set(String(row.id), clone(row))); return Promise.resolve(true); },
    applyDeletes: ids => { (ids || []).forEach(id => rows.delete(String(id))); return Promise.resolve(true); },
    bumpActivation: () => Promise.resolve(0)
  };
}

async function main() {
  const list = block(memoryUi, 'async function renderMemories(){', '\nfunction toggleMemExpand');
  const detail = block(memoryUi, 'function openMemoryModal(id){', '\nfunction closeMemoryModal');
  const save = block(memoryUi, 'async function saveMemory(){', '\nasync function deleteMemory');
  const remove = block(memoryUi, 'async function deleteMemory(id){', '\nasync function toggleMemResolved');
  const inlineSave = block(memoryUi, 'async function saveInlineEdit(id){', '\n/* --- 仪表盘');
  const cleanDelete = block(memoryUi, 'async function deleteCheckedCleanLyrics(){', '\nasync function quickCreateMemory');
  const clearAll = block(siteOperations, 'async function clearAllMemories(){', '\nasync function clearAllLetters');
  const worldRead = block(worldUi, 'function readMemories() {', 'var LAYOUT_MARGIN');
  const importRows = block(memoryUi, 'async function importCanonicalMemoryRows(rows){', '\nfunction importMemoriesFile');
  const wrapperPut = block(bootstrap, 'window.dbPut = function (store, data) {', '\nwindow.dbDelete = function');
  const wrapperDelete = block(bootstrap, 'window.dbDelete = function (store, key) {', '\nwindow.dbGet = function');
  const wrapperGet = block(bootstrap, 'window.dbGet = function (store, key) {', '\nwindow.dbGetAll = function');
  const wrapperGetAll = block(bootstrap, 'window.dbGetAll = function (store) {', '\nwindow.dbGetByIndex = function');

  check('list and search read the memories db* seam, with search over that result set',
    /dbGetAll\('memories'\)/.test(list) && /const hay=/.test(list));
  check('detail reads through dbGet and does not query autoMemory',
    /dbGet\('memories',id\)/.test(detail) && !/autoMemory/.test(detail));
  check('manual create and edit use the wrapped canonical dbPut seam',
    /await dbPut\('memories',mem\)/.test(save) && /await dbPut\('memories',m\)/.test(inlineSave));
  check('delete uses wrapped canonical dbDelete seam', /await dbDelete\('memories',id\)/.test(remove));
  check('bulk Memory cleanup and clear-all surface canonical delete failures with partial counts',
    /await dbDelete\('memories',ids\[i\]\)/.test(cleanDelete)
      && /_memoryUiMutationFailure\('清理',e,deleted\.length\)/.test(cleanDelete)
      && /await dbDelete\('memories',m\.id\)/.test(clearAll)
      && /_memoryUiMutationFailure\('清空',error,deleted\)/.test(clearAll));
  check('Memory World shares the memories reader and returns detail to the same editor',
    /reader\('memories'\)/.test(worldRead) && /window\.openMemoryModal\(item\.id\)/.test(worldUi));
  check('full backup Memory import delegates to the same canonical dbPut import seam',
    /importCanonicalMemoryRows\(data\.memories\)/.test(core)
      && /await dbPut\('memories',record\)/.test(importRows));
  check('full and encrypted exports record Memory authority and never silently replace a failed read with an empty array',
    /memoryAuthoritySnapshot:_ibMemoryAuthorityExportSnapshot\(\)/.test(core)
      && /if\(s==='memories'\)[\s\S]{0,180}memoryExport=true;throw e/.test(core)
      && /reader=window\.dbGetAll/.test(core)
      && /Memory 来自最近同步的镜像，可能不是最新/.test(core)
      && /var memoryState=data\.memoryAuthoritySnapshot&&data\.memoryAuthoritySnapshot\.state/.test(localVault)
      && /memoryState==='degraded'/.test(localVault));
  check('Home Node bootstrap owns canonical Memory list/detail/create/edit/delete',
    /memoryAuthority\.put\(data\)/.test(wrapperPut)
      && /memoryAuthority\.remove\(key\)/.test(wrapperDelete)
      && /memoryAuthority\.get\(key\)/.test(wrapperGet)
      && /memoryAuthority\.getAll\(\)/.test(wrapperGetAll));
  check('Memory UI labels canonical/degraded/local source and surfaces write failures',
    /CANONICAL · HOME NODE/.test(memoryUi)
      && /DEGRADED · HOME NODE/.test(memoryUi)
      && /LOCAL ONLY · INDEXEDDB/.test(memoryUi)
      && /status\.degraded!==true/.test(memoryUi)
      && /Home Node 当前不可用/.test(memoryUi));
  check('Memory World exposes the same source state while open',
    /mem-world-authority/.test(worldUi) && /getMemoryAuthorityUiState/.test(worldUi));
  check('Auto Memory remains a separately labeled role archive and parallel recall path',
    /Auto Memory · 角色档案/.test(html)
      && /不属于 Home Node canonical Memory，也不参与 canonical Recall/.test(html)
      && /dbGetByIndex\('autoMemory','byFriend'/.test(autoMemory)
      && /独立 store `autoMemory`/.test(memoryContract)
      && /Auto Memory \*\*不得\*\*被描述为 canonical Memory 的 producer/.test(memoryContract));
  check('global archive import reports canonical Memory failure with confirmed partial count',
    /err\.memoryImportCompleted/.test(core)
      && /_memoryUiMutationFailure\('导入',err/.test(memoryUi));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-memory-ui-canonical-'));
  const store = createMemoryStore({ dataDir: tempDir, logger: () => {} });
  store.open();
  const local = makeLocal();
  const remote = {
    health: () => Promise.resolve({ ok: true }),
    put: (record, options) => {
      const result = store.putRecord(record, options || {});
      return Promise.resolve({ ok: true, outcome: result.outcome, id: result.id, revision: result.revision });
    },
    list: () => {
      const page = store.listRecords({});
      return Promise.resolve({ ok: true, records: page.records, revision: store.getRevision(), truncated: false });
    },
    changes: (cursor, options) => {
      const result = store.changesAfter(cursor, options || {});
      return Promise.resolve({ ok: true, cursor: result.cursor, upserts: result.upserts, deletes: result.deletes, hasMore: result.hasMore });
    },
    remove: id => Promise.resolve(store.deleteRecord(String(id), {})),
    activate: (ids, options) => Promise.resolve(store.recordActivation(ids, options || {})),
    migrationState: () => Promise.resolve({ ok: true, state: null }),
    markMigration: () => Promise.resolve({ ok: true }),
    putBatch: () => Promise.resolve({ ok: true }),
    putSettings: () => Promise.resolve({ ok: true })
  };
  const authority = authorityModule.createMemoryAuthority({
    mode: 'canonical', local: local, remote: remote, fileOrigin: false,
    clock: () => 1700000000000, logger: () => {}
  });
  try {
    const now = 1700000000000;
    const birthday = {
      id: 'mem_ui_canonical_birthday', title: '生日', summary: '用户生日是 3 月 25 日',
      content: '用户生日是 3 月 25 日', rawSource: 'manual', sourceId: '', domain: '日常',
      tags: [], importance: 8, visibility: 'public', visibleTo: [], excludeFrom: [],
      created: now, lastActivated: now, activationCount: 0, pinned: false, resolved: false
    };
    const created = await authority.put(birthday);
    const uiRows = await authority.getAll();
    check('canonical Memory UI list sees the same Home Node record after a write',
      created.ok === true && created.authority === 'home-node'
        && uiRows.some(row => row.id === birthday.id && row.content === birthday.content)
        && uiRows.authority === 'home-node');
    const uiDetail = await authority.get(birthday.id);
    check('canonical Memory UI detail resolves the Home Node record',
      uiDetail && uiDetail.id === birthday.id && uiDetail.content === '用户生日是 3 月 25 日');

    const recall = createMemoryRetrieval({ store: store, random: () => 0, logger: () => {} });
    const beforeEdit = recall.retrieve('friend-1', {
      userMessage: '我的生日是哪天？', conversationId: 'conversation:ui:before', now: now + 1000, maxChars: 2400
    });
    check('canonical record is initially available to Recall',
      beforeEdit.ok === true && beforeEdit.text.includes('3 月 25 日') && beforeEdit.selectedIds.includes(birthday.id));

    const current = await authority.get(birthday.id);
    const revisionBeforeEdit = store.getRevision();
    const edited = await authority.put(Object.assign({}, current, {
      title: '生日（已修正）', summary: '用户生日是 4 月 2 日', content: '用户生日是 4 月 2 日'
    }));
    const afterEdit = recall.retrieve('friend-1', {
      userMessage: '我的生日是哪天？', conversationId: 'conversation:ui:after-edit', now: now + 2000, maxChars: 2400
    });
    const uiAfterEdit = await authority.getAll();
    check('Memory UI edit advances canonical revision and reaches the same list/detail authority',
      edited.ok === true && edited.revision > revisionBeforeEdit
        && uiAfterEdit.some(row => row.id === birthday.id && row.content === '用户生日是 4 月 2 日'));
    check('Recall observes canonical edited content rather than the old value',
      afterEdit.ok === true && afterEdit.text.includes('4 月 2 日') && !afterEdit.text.includes('3 月 25 日'));

    const removed = await authority.remove(birthday.id);
    const afterDelete = recall.retrieve('friend-1', {
      userMessage: '我的生日是哪天？', conversationId: 'conversation:ui:after-delete', now: now + 3000, maxChars: 2400
    });
    const uiAfterDelete = await authority.getAll();
    check('Memory UI delete removes the canonical record and Recall result',
      removed.ok === true && !uiAfterDelete.some(row => row.id === birthday.id)
        && !afterDelete.selectedIds.includes(birthday.id)
        && !afterDelete.text.includes('4 月 2 日'));
  } finally {
    try { store.close(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\nMemory UI authority convergence passed (' + passed + ' assertions)');
}

main().catch(error => { console.error(error); process.exit(1); });
