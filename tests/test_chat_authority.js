'use strict';
/* Internal Beyond · M1-A 浏览器权威层策略测试（static，零依赖，不开浏览器）
   运行：node tests/test_chat_authority.js
   验证 assets/js/chat-authority.js 的 authority / mirror / fallback 三态语义：
     · canonical 模式：写必须**先**到 Home Node，成功后才落镜像；
     · Home Node 离线：写 fail closed（不产生第二份 canonical），读走镜像并标 degraded；
     · Home Node 接受但镜像写失败：canonical 仍是 Home Node，结果如实报告 mirrored:false；
     · Home Node 明确拒绝（422）：标记 rejected，且不当作离线、不重试；
     · 迁移：幂等、可重复运行、skip 策略不覆盖已有记录、中断后水位可继续；
     · mirror / off 模式：明确退回本地写入并且不宣称 Home Node 权威。
   用 mock remote + mock local，不发任何真实网络请求。 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'chat-authority.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function msg(id, over) {
  return Object.assign({ id: id, role: 'user', content: 'c-' + id, friendId: 'char_a', timestamp: 1000 }, over || {});
}

/* ── mock remote：可编程的 Home Node ───────────────────────────────── */
function mockRemote(options) {
  options = options || {};
  const state = {
    online: options.online !== false,
    stored: new Map(),                 /* id → message（模拟 canonical store） */
    calls: { put: [], putBatch: [], changes: [], list: [], remove: [], health: 0, mark: [] },
    revision: 0,
    migration: {},
    failPut: null,                     /* 'offline' | 'rejected' | null */
    cursor: 0
  };
  function offline() { return { ok: false, error: 'home-node-unreachable', offline: true, retryable: true }; }
  function serialize(m) { return JSON.stringify(m); }
  return {
    state,
    health() { state.calls.health++; return Promise.resolve(state.online ? { ok: true, service: 'internal-beyond-home-node' } : offline()); },
    list(query) {
      state.calls.list.push(query || {});
      if (!state.online) return Promise.resolve(offline());
      const all = Array.from(state.stored.values()).sort((a, b) => (a.timestamp - b.timestamp));
      const limit = (query && query.limit) || 50;
      return Promise.resolve({ ok: true, messages: all.slice(-limit), revision: state.revision, hasOlder: all.length > limit, cursor: null, oldest: null });
    },
    changes(cursor) {
      state.calls.changes.push(cursor);
      if (!state.online) return Promise.resolve(offline());
      return Promise.resolve({ ok: true, cursor: state.revision, upserts: [], deletes: [], hasMore: false, revision: state.revision });
    },
    put(message, opts) {
      state.calls.put.push({ message, opts: opts || {} });
      if (state.failPut === 'offline' || !state.online) return Promise.resolve(offline());
      if (state.failPut === 'rejected') return Promise.resolve({ ok: false, error: 'invalid-message', status: 422 });
      const existing = state.stored.get(message.id);
      if (existing && serialize(existing) === serialize(message)) {
        return Promise.resolve({ ok: true, outcome: 'skipped', id: message.id, revision: state.revision });
      }
      if (existing && opts && opts.existingPolicy === 'skip') {
        return Promise.resolve({ ok: true, outcome: 'skipped', id: message.id, revision: state.revision, reason: 'exists-on-node' });
      }
      state.revision++;
      state.stored.set(message.id, message);
      return Promise.resolve({ ok: true, outcome: existing ? 'updated' : 'created', id: message.id, revision: state.revision });
    },
    putBatch(messages, opts) {
      state.calls.putBatch.push({ messages, opts: opts || {} });
      if (state.failPut === 'offline' || !state.online) return Promise.resolve(offline());
      const summary = { created: 0, updated: 0, skipped: 0 };
      for (const m of messages) {
        const existing = state.stored.get(m.id);
        if (existing && opts && opts.existingPolicy === 'skip') { summary.skipped++; continue; }
        if (existing && serialize(existing) === serialize(m)) { summary.skipped++; continue; }
        state.revision++;
        state.stored.set(m.id, m);
        if (existing) summary.updated++; else summary.created++;
      }
      return Promise.resolve({ ok: true, outcome: 'batch', summary, revision: state.revision, count: messages.length });
    },
    remove(id) {
      state.calls.remove.push(id);
      if (!state.online) return Promise.resolve(offline());
      const had = state.stored.delete(id);
      if (had) state.revision++;
      return Promise.resolve({ ok: true, outcome: had ? 'deleted' : 'not-present', id, revision: state.revision, deleted: had });
    },
    migrationState(source) {
      return Promise.resolve({ ok: true, source, state: state.migration[source] || { version: 0, lastTimestamp: 0, messages: 0 } });
    },
    markMigration(source, patch) {
      state.calls.mark.push({ source, patch });
      const cur = state.migration[source] || { version: 0, lastTimestamp: 0, messages: 0 };
      state.migration[source] = {
        version: Math.max(cur.version, patch.version || 0),
        lastTimestamp: Math.max(cur.lastTimestamp, patch.lastTimestamp || 0),
        messages: patch.messages
      };
      return Promise.resolve({ ok: true, source, state: state.migration[source] });
    }
  };
}

/* ── mock local：可编程的 IndexedDB 镜像 ───────────────────────────── */
function mockLocal(options) {
  options = options || {};
  const state = { rows: new Map(), failPut: false, calls: { put: 0, remove: 0, replaceAll: 0, applyUpserts: 0, applyDeletes: 0 } };
  if (options.seed) for (const m of options.seed) state.rows.set(m.id, m);
  return {
    state,
    get(id) { return Promise.resolve(state.rows.get(id) || null); },
    getAll() { return Promise.resolve(Array.from(state.rows.values())); },
    getByFriend(fid) { return Promise.resolve(Array.from(state.rows.values()).filter(r => r.friendId === fid)); },
    put(m) {
      state.calls.put++;
      if (state.failPut) return Promise.reject(new Error('IndexedDB mirror write failed'));
      state.rows.set(m.id, m);
      return Promise.resolve();
    },
    remove(id) { state.calls.remove++; state.rows.delete(id); return Promise.resolve(); },
    applyUpserts(ms) { state.calls.applyUpserts++; for (const m of ms) state.rows.set(m.id, m); return Promise.resolve(); },
    applyDeletes(ds) { state.calls.applyDeletes++; for (const d of ds) state.rows.delete(d.messageId); return Promise.resolve(); },
    replaceAll(ms) {
      state.calls.replaceAll++;
      state.rows.clear();
      for (const m of ms) state.rows.set(m.id, m);
      return Promise.resolve();
    }
  };
}

(async () => {
  /* ── 1 · canonical：写必须先到 Home Node，成功后才落镜像 ─────────── */
  {
    const remote = mockRemote();
    const local = mockLocal();
    const order = [];
    const remotePut = remote.put.bind(remote);
    remote.put = (m, o) => { order.push('remote'); return remotePut(m, o); };
    const localPut = local.put.bind(local);
    local.put = (m) => { order.push('local'); return localPut(m); };
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    await authority.sync();
    const res = await authority.put(msg('m1'));
    check('authority.put 成功且权威标注为 home-node', res.ok === true && res.authority === 'home-node', res);
    check('authority.put 写入顺序 = remote 先、local 后', order.join(',') === 'remote,local', order);
    check('authority.put 落到 Home Node canonical store', remote.state.stored.has('m1'));
    check('authority.put 镜像同步更新', local.state.rows.has('m1'));
    check('authority.put 报告 mirrored:true', res.mirrored === true);
    check('authority.put 采用 Home Node 返回的 revision', res.revision === 1, res.revision);
    check('authority.put 由 Home Node 分配/确认 id', res.id === 'm1');
  }

  /* ── 2 · Home Node 离线：写 fail closed，读走镜像并标 degraded ───── */
  {
    const remote = mockRemote({ online: false });
    const local = mockLocal({ seed: [msg('old1')] });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    await authority.probe();
    const write = await authority.put(msg('m2'));
    check('offline 写被拒绝（fail closed）', write.ok === false && write.error === 'home-node-offline', write);
    check('offline 写没有落到镜像（不产生第二份 canonical）', !local.state.rows.has('m2'));
    check('offline 写没有声称成功', write.authority === 'home-node');
    check('offline 写给出明确 hint', typeof write.hint === 'string' && write.hint.length > 0);
    const read = await authority.get('old1');
    check('offline 读仍可用（陈旧的镜像）', !!read && read.id === 'old1', read);
    check('offline 读标记 authority=home-node 且 readFrom 反映降级',
      read.authority === 'home-node' && /mirror/.test(String(read.readFrom)), { a: read.authority, f: read.readFrom });
    const status = authority.status();
    check('offline status 报告 degraded + 原因', status.degraded === true && !!status.degradedReason, status);
    check('offline 写失败计入 failures', status.stats.failures >= 1);
  }

  /* ── 3 · Home Node 接受但镜像写失败：canonical 仍是 Home Node ───── */
  {
    const remote = mockRemote();
    const local = mockLocal();
    local.state.failPut = true;
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    await authority.sync();
    const res = await authority.put(msg('m3'));
    check('mirror-fail 整体仍报告成功（canonical 已落 Home Node）', res.ok === true && res.authority === 'home-node', res);
    check('mirror-fail 如实报告 mirrored:false', res.mirrored === false);
    check('mirror-fail 带 mirrorError 字段', typeof res.mirrorError === 'string' && res.mirrorError.length > 0);
    check('mirror-fail Home Node 里确实有这条消息', remote.state.stored.has('m3'));
    check('mirror-fail 镜像里确实没有这条消息', !local.state.rows.has('m3'));
  }

  /* ── 4 · Home Node 明确拒绝（422）不是"离线"────────────────────── */
  {
    const remote = mockRemote();
    remote.state.failPut = 'rejected';
    const local = mockLocal();
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const res = await authority.put(msg('m4'));
    check('rejected 被标记为 rejected:true', res.ok === false && res.rejected === true, res);
    check('rejected 不标为 offline', !res.offline);
    check('rejected 不写镜像', !local.state.rows.has('m4'));
    check('rejected 保留 Home Node 的 error 词表', res.error === 'invalid-message', res.error);
  }

  /* ── 5 · mirror / off 模式：明确退回本地，且不宣称 Home Node 权威 ── */
  for (const mode of ['mirror', 'off']) {
    const remote = mockRemote();
    const local = mockLocal();
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode });
    const res = await authority.put(msg('m-' + mode));
    check('mode=' + mode + ' 写入成功但权威是 indexeddb',
      res.ok === true && res.authority === 'indexeddb' && res.mirrorOnly === true, res);
    check('mode=' + mode + ' 完全不调用 Home Node', remote.state.calls.put.length === 0, remote.state.calls.put.length);
    check('mode=' + mode + ' 落本地 IndexedDB', local.state.rows.has('m-' + mode));
    const status = authority.status();
    check('mode=' + mode + ' status 报告 authority=indexeddb 且 degraded 有原因',
      status.authority === 'indexeddb' && status.degraded === true, status);
  }

  /* ── 6 · 迁移：幂等、可重复运行、skip 策略不覆盖 Node 已有内容 ──── */
  {
    const remote = mockRemote();
    const local = mockLocal({ seed: [msg('a1', { timestamp: 10 }), msg('a2', { timestamp: 20 }), msg('a3', { timestamp: 30 })] });
    /* Home Node 上已存在 a2，但内容不同（模拟"Node 版本较新"） */
    remote.state.stored.set('a2', msg('a2', { timestamp: 20, content: 'NODE-NEWER' }));
    remote.state.revision = 1;
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const first = await authority.migrate({ source: 'browser-indexeddb', batchSize: 2 });
    check('migrate 第一次成功', first.ok === true && first.completed === true, first);
    check('migrate 统计 created=2（a1/a3）', first.created === 2, first);
    check('migrate 统计 skipped=1（a2 因 skip 策略跳过）', first.skipped === 1, first);
    check('migrate 没有覆盖 Home Node 上更新的 a2',
      remote.state.stored.get('a2').content === 'NODE-NEWER', remote.state.stored.get('a2'));
    check('migrate 保住了 message id（未重新编号）',
      remote.state.stored.has('a1') && remote.state.stored.has('a3'));
    check('migrate 写入 marker/version', remote.state.migration['browser-indexeddb'] && remote.state.migration['browser-indexeddb'].version >= 1,
      remote.state.migration);
    check('migrate 记录水位 = 最大 timestamp', remote.state.migration['browser-indexeddb'].lastTimestamp === 30,
      remote.state.migration['browser-indexeddb']);

    /* 重复运行：幂等（全部 skipped），且不新插入 */
    const revBefore = remote.state.revision;
    const second = await authority.migrate({ source: 'browser-indexeddb', batchSize: 2 });
    check('migrate 可重复运行且成功', second.ok === true, second);
    check('migrate 重复运行不产生新记录', second.created === 0 && second.updated === 0, second);
    check('migrate 重复运行不前进 revision', remote.state.revision === revBefore, [revBefore, remote.state.revision]);

    /* 绝不 clear IndexedDB */
    check('migrate 绝不清空 IndexedDB（镜像保留）', local.state.rows.size === 3, local.state.rows.size);
  }

  /* ── 7 · 迁移中断：不写 marker，下次从水位继续 ─────────────────── */
  {
    const remote = mockRemote({ online: false });
    const local = mockLocal({ seed: [msg('b1', { timestamp: 10 }), msg('b2', { timestamp: 20 })] });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const res = await authority.migrate({ source: 'src-x', batchSize: 1 });
    check('migrate 中断时 ok=false 且带 error', res.ok === false && !!res.error, res);
    check('migrate 中断不写 marker', !remote.state.migration['src-x']);
    check('migrate 中断报告 failedAt（可续跑）', typeof res.failedAt === 'number', res.failedAt);

    /* 恢复后继续：水位未推进 → 从头重放，仍然幂等 */
    remote.state.online = true;
    const retry = await authority.migrate({ source: 'src-x', batchSize: 2 });
    check('migrate 恢复后可继续并完成', retry.ok === true && retry.completed === true, retry);
    check('migrate 恢复后 created=2', retry.created === 2, retry);
    check('migrate 恢复后写出 marker', !!remote.state.migration['src-x']);
  }

  /* ── 8 · 水位续跑：只重放水位之后的消息 ───────────────────────── */
  {
    const remote = mockRemote();
    remote.state.migration['src-y'] = { version: 1, lastTimestamp: 20, messages: 2 };
    const local = mockLocal({ seed: [msg('c1', { timestamp: 10 }), msg('c2', { timestamp: 20 }), msg('c3', { timestamp: 30 })] });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const res = await authority.migrate({ source: 'src-y', batchSize: 10 });
    /* 过滤条件是 timestamp >= watermark（同毫秒的多条消息必须整批重放），
       因此水位 20 之后仍是 c2 与 c3 两条。 */
    check('migrate 水位续跑只处理未确认的消息', res.created === 2 && res.total === 3 && res.processed === 2, res);
    check('migrate 水位续跑报告 fromWatermark', res.fromWatermark === 20, res.fromWatermark);
  }

  /* ── 9 · hydrate 播种 + 增量同步 ──────────────────────────────── */
  {
    const remote = mockRemote();
    remote.state.stored.set('s1', msg('s1', { timestamp: 1 }));
    remote.state.stored.set('s2', msg('s2', { timestamp: 2 }));
    remote.state.revision = 2;
    const local = mockLocal({ seed: [msg('stale', { timestamp: 0 })] });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    const h = await authority.hydrate();
    check('hydrate 播种最新一页', h.ok === true && h.seeded === 2, h);
    check('hydrate 清掉镜像里 Home Node 不再拥有的旧行', !local.state.rows.has('stale'), Array.from(local.state.rows.keys()));
    check('hydrate 后 status 不再 degraded', authority.status().degraded === false, authority.status());
    const s = await authority.sync();
    check('sync 增量拉取 changes(cursor)', s.ok === true && remote.state.calls.changes.length === 1, remote.state.calls.changes);
  }

  /* ── 10 · 读路径形状与既有调用点完全一致 ──────────────────────── */
  {
    const remote = mockRemote();
    const local = mockLocal({ seed: [msg('r1', { timestamp: 1 }), msg('r2', { timestamp: 2, friendId: 'char_b' })] });
    const authority = AUTHORITY.createChatAuthority({ remote, local, mode: 'canonical' });
    check('getExisting 返回对象', (await authority.get('r1')).id === 'r1');
    check('getMissing 返回 null（不是 undefined）', (await authority.get('nope')) === null);
    const all = await authority.getAll();
    check('getAll 返回数组', Array.isArray(all) && all.length === 2, all.length);
    const byFriend = await authority.getByFriend('char_b');
    check('getByFriend 按 friendId 过滤', byFriend.length === 1 && byFriend[0].id === 'r2');
  }

  console.log('');
  if (failed) { console.error('Chat authority 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Chat authority tests passed ✔ (' + passed + ' 项)');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
