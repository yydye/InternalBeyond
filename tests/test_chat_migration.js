'use strict';
/* Internal Beyond · M1-A 迁移测试（static，零依赖，零浏览器，零真实网络）
   运行：node tests/test_chat_migration.js

   这是 Phase 6 的端到端验证：**真实的** canonical chat store（node:sqlite，临时目录）
   ← 真实的 HTTP 形状 ← 真实的 assets/js/chat-authority.js 迁移逻辑
   ← mock 的浏览器 IndexedDB 内容。

   覆盖审计与验收清单要求的全部情形：
     · 空数据库迁移
     · 已有消息迁移
     · 重复迁移（幂等：不重复插入、不前进 revision、不覆盖 Node 已有内容）
     · 迁移中断后继续（不写 marker、水位可续、重跑安全）
     · 混合 thread（thread 不串）
     · images / files / voice payload 不丢
     · malformed JSON 保护（store 侧）
     · migrated marker/version 落盘且重启仍在
     · 绝不 clear IndexedDB（镜像保留） */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'chat-authority.js'));
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* ── mock local：浏览器 IndexedDB 镜像（迁移的**来源**）──────────── */
function mockLocal(seed) {
  const state = { rows: new Map(), calls: { replaceAll: 0, applyUpserts: 0, applyDeletes: 0, put: 0, remove: 0 } };
  for (const m of seed || []) state.rows.set(m.id, m);
  return {
    state,
    get: id => Promise.resolve(state.rows.get(id) || null),
    getAll: () => Promise.resolve(Array.from(state.rows.values())),
    getByFriend: fid => Promise.resolve(Array.from(state.rows.values()).filter(r => r.friendId === fid)),
    put: m => { state.calls.put++; state.rows.set(m.id, m); return Promise.resolve(); },
    remove: id => { state.calls.remove++; state.rows.delete(id); return Promise.resolve(); },
    applyUpserts: ms => { state.calls.applyUpserts++; for (const m of ms) state.rows.set(m.id, m); return Promise.resolve(); },
    applyDeletes: ds => { state.calls.applyDeletes++; for (const d of ds) state.rows.delete(d.messageId); return Promise.resolve(); },
    replaceAll: ms => { state.calls.replaceAll++; state.rows.clear(); for (const m of ms) state.rows.set(m.id, m); return Promise.resolve(); }
  };
}

/* ── mock remote：把真实 store 包成 HTTP 形状（与 services/home-node/http.js
     的路由语义逐条对应，但不经过网络 —— 网络路径由 test_home_node_http.js 覆盖）── */
function storeRemote(store, options) {
  options = options || {};
  const state = { offlineAfterBatch: options.offlineAfterBatch == null ? Infinity : options.offlineAfterBatch, batchCount: 0 };
  function offline() { return { ok: false, error: 'home-node-unreachable', offline: true, retryable: true }; }
  return {
    state,
    health: () => Promise.resolve(store.isOpen() ? { ok: true, service: 'internal-beyond-home-node' } : offline()),
    list: function (query) {
      const res = store.listMessages(query || {});
      if (!res.ok) return Promise.resolve({ ok: false, error: res.error });
      return Promise.resolve({ ok: true, messages: res.messages, revision: res.revision, hasOlder: res.hasOlder, cursor: res.cursor, oldest: res.oldest });
    },
    changes: function (cursor) {
      const res = store.changesAfter(cursor, {});
      return Promise.resolve(res.ok ? { ok: true, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes, hasMore: res.hasMore, revision: res.revision } : { ok: false, error: res.error });
    },
    put: function (message, opts) {
      const res = store.putMessage(message, { requestId: (opts && opts.requestId) || '', existingPolicy: (opts && opts.existingPolicy) || 'overwrite' });
      return Promise.resolve(res);
    },
    putBatch: function (messages, opts) {
      state.batchCount++;
      if (state.batchCount > state.offlineAfterBatch) return Promise.resolve(offline());
      const res = store.putMessages(messages, { requestId: (opts && opts.requestId) || '', existingPolicy: (opts && opts.existingPolicy) || 'overwrite' });
      return Promise.resolve(res);
    },
    remove: function (id) { return Promise.resolve(store.deleteMessage(id, {})); },
    migrationState: function (source) { return Promise.resolve({ ok: true, source, state: store.getMigrationState(source) }); },
    markMigration: function (source, patch) { return Promise.resolve(store.setMigrationState(source, patch)); }
  };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-migrate-'));
  const store = createStore({ dataDir: dir });
  store.open();
  return { store, dir };
}

/* 一份典型的浏览器旧历史：主对话 + thread + 群聊 + 附件 + 撤回墓碑 */
function browserHistory() {
  return [
    { id: 'msg_1700000000001_u', role: 'user', content: '第一条', friendId: 'friend_1', timestamp: 1700000000001 },
    {
      id: 'msg_1700000000002_111', role: 'assistant', content: '回复一', reasoning_content: '想了一下',
      friendId: 'friend_1', timestamp: 1700000000002,
      metadata: { model: 'deepseek', model_id: 'deepseek-flash', config_id: 'friend_1', showThinking: true }
    },
    {
      id: 'msg_1700000000003_u', role: 'user', content: '这条带附件', friendId: 'friend_1', timestamp: 1700000000003,
      images: [{ dataUrl: 'data:image/png;base64,QUJD', base64: 'QUJD', mime: 'image/png', name: 'a.png' }],
      files: [{ name: 'n.txt', ext: 'txt', size: 3, text: 'hey' }],
      voice: { dataUrl: 'data:audio/mp3;base64,WFla', mime: 'audio/mp3', duration: 2, transcript: '文字', tone: 'calm' }
    },
    { id: 'msg_1700000000004_u', role: 'user', content: 'thread 里的', friendId: 'friend_1', timestamp: 1700000000004, threadId: 'th_1' },
    { id: 'msg_1700000000005_222', role: 'assistant', content: 'thread 回复', friendId: 'friend_1', timestamp: 1700000000005, threadId: 'th_1' },
    { id: 'msg_sys_1700000000006_ab12', role: 'system', content: 'A joined the group', friendId: 'group_1700', timestamp: 1700000000006, metadata: { eventType: 'member_join', characterId: 'friend_1' } },
    { id: 'msg_1700000000007_333', role: 'assistant', content: '【A撤回了一条消息】', friendId: 'friend_1', timestamp: 1700000000007, withdrawn: true, withdrawnBy: 'self' }
  ];
}

(async () => {
  /* ── 1 · 空数据库迁移 ────────────────────────────────────────────── */
  {
    const { store } = freshStore();
    const local = mockLocal([]);
    const authority = AUTHORITY.createChatAuthority({ remote: storeRemote(store), local, mode: 'canonical' });
    const res = await authority.migrate({ source: 'browser-indexeddb' });
    check('migrate-empty 空库迁移成功', res.ok === true && res.total === 0 && res.completed === true, res);
    check('migrate-empty 不产生任何记录', store.countMessages() === 0, store.countMessages());
    check('migrate-empty 仍写出 marker（表示"已迁移过且当时为空"）',
      store.getMigrationState('browser-indexeddb').version >= 1, store.getMigrationState('browser-indexeddb'));
    store.close();
  }

  /* ── 2 · 已有消息迁移（含附件与混合 thread）──────────────────────── */
  let seededDir = null;
  {
    const { store, dir } = freshStore();
    seededDir = dir;
    const local = mockLocal(browserHistory());
    const authority = AUTHORITY.createChatAuthority({ remote: storeRemote(store), local, mode: 'canonical' });
    const res = await authority.migrate({ source: 'browser-indexeddb', batchSize: 3 });
    check('migrate-seeded 全部迁移', res.ok === true && res.created === 7 && res.completed === true, res);
    check('migrate-seeded 分多批完成（batchSize=3 → ≥3 批）', res.batches >= 3, res.batches);
    check('migrate-seeded store 里正好 7 条', store.countMessages() === 7, store.countMessages());

    /* message id 保留 */
    for (const m of browserHistory()) {
      check('migrate-seeded 保留 message id ' + m.id, !!store.getMessage(m.id));
    }
    /* 附件不丢 */
    const withAttach = store.getMessage('msg_1700000000003_u');
    check('migrate-seeded images payload 不丢',
      withAttach.images && withAttach.images[0].base64 === 'QUJD' && withAttach.images[0].dataUrl === 'data:image/png;base64,QUJD', withAttach.images);
    check('migrate-seeded files payload 不丢',
      withAttach.files && withAttach.files[0].name === 'n.txt' && withAttach.files[0].text === 'hey', withAttach.files);
    check('migrate-seeded voice payload 不丢',
      withAttach.voice && withAttach.voice.transcript === '文字' && withAttach.voice.tone === 'calm', withAttach.voice);
    /* metadata 与 reasoning 不丢 */
    const assistant = store.getMessage('msg_1700000000002_111');
    check('migrate-seeded reasoning_content 不丢', assistant.reasoning_content === '想了一下', assistant.reasoning_content);
    check('migrate-seeded metadata 不丢', assistant.metadata && assistant.metadata.model_id === 'deepseek-flash', assistant.metadata);
    /* 撤回墓碑不丢 */
    check('migrate-seeded 撤回墓碑不丢',
      store.getMessage('msg_1700000000007_333').withdrawn === true &&
      store.getMessage('msg_1700000000007_333').withdrawnBy === 'self');
    /* 群聊命名空间 */
    check('migrate-seeded 群聊消息落在 group 命名空间',
      !!store.getMessage('msg_sys_1700000000006_ab12'));
    /* thread 不串 */
    const main = store.listMessages({ conversationId: 'dm:friend_1', limit: 50 });
    const thread = store.listMessages({ conversationId: 'dm:friend_1|th_1', limit: 50 });
    check('migrate-seeded 主对话与 thread 分离（主对话 4 条）', main.messages.length === 4, main.messages.map(m => m.id));
    check('migrate-seeded thread 2 条且不串', thread.messages.length === 2 && thread.messages.every(m => m.threadId === 'th_1'), thread.messages.map(m => m.id));
    check('migrate-seeded 群聊独立会话',
      store.listMessages({ conversationId: 'group:group_1700', limit: 50 }).messages.length === 1);
    /* 镜像未被清空 */
    check('migrate-seeded 绝不清空 IndexedDB（镜像仍是 7 条）', local.state.rows.size === 7, local.state.rows.size);
    check('migrate-seeded 迁移过程没有走 replaceAll（那是 hydrate 专用）', local.state.calls.replaceAll === 0, local.state.calls.replaceAll);
    /* marker */
    const marker = store.getMigrationState('browser-indexeddb');
    check('migrate-seeded marker version ≥ 1', marker.version >= 1, marker);
    check('migrate-seeded marker 记录消息数', marker.messages > 0, marker);
    check('migrate-seeded marker 记录水位（最大 timestamp）', marker.lastTimestamp === 1700000000007, marker.lastTimestamp);
    const revAfterFirst = store.getRevision();

    /* ── 3 · 重复迁移：幂等 ────────────────────────────────────────── */
    const second = await authority.migrate({ source: 'browser-indexeddb', batchSize: 3 });
    check('migrate-repeat 重复迁移成功', second.ok === true, second);
    check('migrate-repeat 不新增、不更新（全部 skipped）', second.created === 0 && second.updated === 0, second);
    check('migrate-repeat revision 不前进', store.getRevision() === revAfterFirst, [revAfterFirst, store.getRevision()]);
    check('migrate-repeat 记录数不变', store.countMessages() === 7, store.countMessages());

    /* 完整重放（忽略水位）：仍然全部 skipped */
    const replay = await authority.migrate({ source: 'browser-indexeddb', full: true, batchSize: 4 });
    check('migrate-repeat full 重放仍然幂等（created=0）', replay.ok === true && replay.created === 0, replay);
    check('migrate-repeat full 重放 revision 仍不前进', store.getRevision() === revAfterFirst, store.getRevision());

    /* ── 4 · 不覆盖 Home Node 上更新的内容 ────────────────────────── */
    const nodeNewer = { id: 'msg_1700000000001_u', role: 'user', content: 'NODE-NEWER-CONTENT', friendId: 'friend_1', timestamp: 1700000000001 };
    store.putMessage(nodeNewer, {});
    const revBeforeConflict = store.getRevision();
    const conflict = await authority.migrate({ source: 'browser-indexeddb', full: true, batchSize: 7 });
    check('migrate-conflict 冲突迁移成功', conflict.ok === true, conflict);
    check('migrate-conflict 不覆盖 Home Node 上更新的内容',
      store.getMessage('msg_1700000000001_u').content === 'NODE-NEWER-CONTENT',
      store.getMessage('msg_1700000000001_u').content);
    check('migrate-conflict 该条被计为 skipped', conflict.skipped >= 1, conflict.skipped);
    check('migrate-conflict 不因为跳过而出错', conflict.created === 0, conflict.created);

    store.close();
  }

  /* ── 5 · 迁移中断 → 继续 ────────────────────────────────────────── */
  {
    const { store } = freshStore();
    const local = mockLocal(browserHistory());
    const remote = storeRemote(store, { offlineAfterBatch: 2 });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const interrupted = await authority.migrate({ source: 'browser-indexeddb', batchSize: 3 });
    check('migrate-interrupt 中断被如实报告（ok=false）', interrupted.ok === false, interrupted);
    /* 迁移把传输层的不可达原样透出（词表与 home-node-client 的错误分类一致），
       不伪装成别的错误 —— 调用方据此分支「稍后重试」。 */
    check('migrate-interrupt 报告传输层不可达',
      interrupted.error === 'home-node-unreachable' || interrupted.error === 'home-node-offline', interrupted.error);
    check('migrate-interrupt 报告失败位置（可续）', typeof interrupted.failedAt === 'number', interrupted.failedAt);
    const partialCount = store.countMessages();
    check('migrate-interrupt 已写入的部分保留', partialCount > 0 && partialCount < 7, partialCount);
    check('migrate-interrupt 中断时**不写** marker（避免谎报完成）',
      store.getMigrationState('browser-indexeddb').version === 0, store.getMigrationState('browser-indexeddb'));
    check('migrate-interrupt 中断时不清空镜像', local.state.rows.size === 7, local.state.rows.size);

    /* 恢复后重跑：从头重放，重复记录被 skipped，最终补齐 */
    remote.state.offlineAfterBatch = Infinity;
    const resumed = await authority.migrate({ source: 'browser-indexeddb', batchSize: 3 });
    check('migrate-resume 恢复后完成', resumed.ok === true && resumed.completed === true, resumed);
    check('migrate-resume 不产生重复记录（总数仍为 7）', store.countMessages() === 7, store.countMessages());
    check('migrate-resume 已存在部分被计为 skipped', resumed.skipped === partialCount, { skipped: resumed.skipped, partialCount: partialCount });
    check('migrate-resume marker 现在写出', store.getMigrationState('browser-indexeddb').version >= 1);
    store.close();
  }

  /* ── 6 · 持久化：重启后历史与 marker 都还在 ────────────────────── */
  {
    const store1 = createStore({ dataDir: seededDir });
    store1.open();
    check('migrate-restart 重开后历史仍在', store1.countMessages() === 7, store1.countMessages());
    check('migrate-restart 重开后 marker 仍在', store1.getMigrationState('browser-indexeddb').version >= 1,
      store1.getMigrationState('browser-indexeddb'));
    const rev = store1.getRevision();
    const local = mockLocal(browserHistory());
    const authority = AUTHORITY.createChatAuthority({ remote: storeRemote(store1), local, mode: 'canonical' });
    const again = await authority.migrate({ source: 'browser-indexeddb', full: true, batchSize: 5 });
    check('migrate-restart 重启后重复迁移仍然幂等', again.created === 0, again);
    check('migrate-restart 重启后 revision 不前进', store1.getRevision() === rev, [rev, store1.getRevision()]);
    /* malformed JSON 保护：手工把一行 payload 写坏，读回必须不抛错 */
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(store1.file);
    raw.prepare('UPDATE messages SET payload_json=? WHERE id=?').run('{broken json', 'msg_1700000000002_111');
    raw.close();
    const corrupt = store1.getMessage('msg_1700000000002_111');
    check('migrate-corrupt malformed JSON 不抛错且有可读占位', !!corrupt && corrupt.__malformedPayload === true, corrupt);
    check('migrate-corrupt 占位仍保留 schema 必需字段（id/role/friendId/timestamp）',
      corrupt.id === 'msg_1700000000002_111' && corrupt.role === 'assistant' && corrupt.friendId === 'friend_1' && typeof corrupt.timestamp === 'number',
      corrupt);
    check('migrate-corrupt 列表读回也不抛错',
      Array.isArray(store1.listMessages({ conversationId: 'dm:friend_1', limit: 50 }).messages));
    store1.close();
  }

  /* ── 7 · 迁移也会带上 proactive / 火山遗留字段 ─────────────────── */
  {
    const { store } = freshStore();
    const local = mockLocal([
      {
        id: 'active_setting_1_1700000009999', role: 'assistant', content: '主动消息', friendId: 'friend_1',
        timestamp: 1700000009999, metadata: { source: 'active_message', activePlanId: 'plan_1' }
      },
      /* 未知字段（本仓库没有的）必须原样往返，绝不静默丢失 */
      { id: 'msg_1700000010000_u', role: 'user', content: '未来字段', friendId: 'friend_1', timestamp: 1700000010000, futureSurfaceField: { a: 1 } }
    ]);
    const authority = AUTHORITY.createChatAuthority({ remote: storeRemote(store), local, mode: 'canonical' });
    const res = await authority.migrate({ source: 'browser-indexeddb' });
    check('migrate-extra proactive 元数据不丢',
      res.ok === true && store.getMessage('active_setting_1_1700000009999').metadata.source === 'active_message',
      store.getMessage('active_setting_1_1700000009999'));
    check('migrate-extra 未知字段原样往返',
      JSON.stringify(store.getMessage('msg_1700000010000_u').futureSurfaceField) === JSON.stringify({ a: 1 }),
      store.getMessage('msg_1700000010000_u'));
    check('migrate-extra 未知字段进入变更日志（可同步给未来客户端）',
      store.changesAfter(0).upserts.some(u => u.message.id === 'msg_1700000010000_u'));
    store.close();
  }

  console.log('');
  if (failed) { console.error('Chat migration 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Chat migration tests passed ✔ (' + passed + ' 项)');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
