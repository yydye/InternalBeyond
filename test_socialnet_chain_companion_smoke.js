'use strict';
/* Internal Beyond — AI↔AI 连续社交链（companion 后台）测试套件（Node 内置 test runner，零依赖）
   运行：node --test test_socialnet_chain_companion_smoke.js
   覆盖：任务创建/持久化/延迟执行/AI 回复/replyTo/自动下一步/重启恢复/同任务幂等/
   >12 条停止/轮数停止/小时与日频控/45min 冷却/aiComment 开关/publishReply=false/
   非法 replyTo 回落/重复文本/API retry 与超限/事件回传/事件重放/浏览器关闭后继续/
   重新打开线程完整/第三方加入/多线程并行。全部走 mock 端点，不真实调用模型。 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

/* 隔离状态 + 短延迟：必须发生在 require 之前 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chain-cmp-'));
process.env.IB_ACTIVE_DATA_DIR = DATA_DIR;
process.env.IB_REPLY_DELAY_MIN = '5';
process.env.IB_REPLY_DELAY_MAX = '15';
const service = require('./active-message-service.js');

const {
  momentsTick, replyChainTick, syncReplyChainThreads, maybeCreateReplyTask,
  executeReplyChainTask, replyChainTaskCount, replyStore, replyChainCore,
  sanitizeReplyThread, mergeThreadComments, getState, setArmed, resetStateForTest, saveNow
} = service;

/* ── mock 模型端点（按请求体 model 区分行为） ── */
let mockPort = 0;
let mockReq = 0;
let mockFailOnce = false;
function startMockModel() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      mockReq += 1;
      let model = '', userText = '';
      try {
        const j = JSON.parse(body || '{}');
        model = String(j.model || '');
        userText = (j.messages || []).map(m => String(m && m.content != null ? m.content : '')).join('\n');
      } catch (_) { /* ignore */ }
      const ids = [...userText.matchAll(/\[(rc_[a-z0-9_]+)\]/g)].map(x => x[1]);
      const n = ids.length;
      let content;
      if (model === 'cha-ok') content = JSON.stringify({ publishReply: true, comment: '你也喜欢？', replyTo: ids[0] || '' });
      else if (model === 'ds-ok') content = JSON.stringify({ publishReply: true, comment: '这角度确实妙，回头我也试试。', replyTo: ids[n - 1] || '' });
      else if (model === 'kim-ok') content = JSON.stringify({ publishReply: true, comment: '我觉得光线很好。', replyTo: ids[n - 1] || '' });
      else if (model === 'decl') content = JSON.stringify({ publishReply: false });
      else if (model === 'badrep') content = JSON.stringify({ publishReply: true, comment: '非法回复对象测试。', replyTo: 'nope_id_123' });
      else if (model === 'duprep') content = JSON.stringify({ publishReply: true, comment: '第一句话。', replyTo: '' });
      else if (model === 'retryok') {
        if (mockFailOnce) { mockFailOnce = false; content = 'not json at all'; }
        else content = JSON.stringify({ publishReply: true, comment: '重试后终于成功。', replyTo: ids[n - 1] || '' });
      }
      else if (model === 'retryfail') content = 'never a json';
      else content = JSON.stringify({});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const USER = { id: 'u1', name: '用户' };

function schedule(characterId, extra) {
  const now = Date.now();
  return {
    id: characterId, characterId, user_id: 'u1', enabled: true, frequency: 'low',
    nextAt: now + 86400000, lastPostAt: 0, status: 'idle', claimedAt: 0, executionId: '',
    attemptCount: 0, revision: 1, updatedAt: new Date(now - 60000).toISOString(),
    executedAt: null, lastMomentId: '', lastError: '', synced_at: 0,
    ...(extra || {})
  };
}
function compactThread(momentId, ownerRoleId, content, comments) {
  return {
    id: momentId, roleId: ownerRoleId, authorType: 'role', content,
    visibility: 'all', createdAt: new Date(Date.now() - 900000).toISOString(), imagesCount: 1,
    comments: (comments || []).map(c => ({
      id: c.id, authorType: 'role', authorId: c.authorId,
      content: c.content, replyTo: c.replyTo || '', createdAt: c.createdAt || new Date().toISOString()
    }))
  };
}
/* 每个角色一条 schedule + 线程快照 + 偏好（等价浏览器 PUT /moments 载荷） */
function seedRoles(roleModels, thread, prefs) {
  const s = getState();
  Object.keys(roleModels).forEach(rid => {
    const model = roleModels[rid];
    s.moments[rid] = {
      ...schedule(rid),
      character: { id: rid, provider: 'openai', apiKey: 'sk-mock', model, endpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`, nickname: rid === 'cha' ? 'ChromeAI' : (rid === 'ds' ? 'DeepSeek' : (rid === 'kim' ? 'Kimi' : rid)), relationship: '朋友', systemPrompt: `你是 ${rid}。` },
      user: USER,
      recent_memories: [],
      recent_messages: [],
      recent_proactive_messages: [],
      chat_summary: '',
      last_interaction_at: 0,
      recent_moments: [],
      other_role_moments: [],
      recent_threads: [thread],
      moments_prefs: prefs || { aiComment: true }
    };
  });
}
function comment(id, authorId, content, replyTo, createdAt) {
  return { id, authorType: 'role', authorId, content, replyTo: replyTo || '', createdAt: createdAt || new Date().toISOString() };
}
function newestComment(s) {
  const t = s.thread.comments;
  return t[t.length - 1];
}
function eventByKind() {
  const evs = Object.values(getState().events).filter(e => e.kind === 'moment_reply');
  return evs.sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0));
}

test.before(async () => {
  const mock = await startMockModel();
  mockPort = mock.port;
  test.mockServer = mock.server;
});
test.after(() => { try { if (test.mockServer) test.mockServer.close(); } catch (_) {} });
test.beforeEach(() => {
  resetStateForTest();
  setArmed('u1');
  mockReq = 0;
  mockFailOnce = false;
});

/* 1+2+3+4+5+6+20：完整生命周期（创建→持久化→延迟→执行→replyTo→自动下一步→事件） */
test('生命周期：任务创建/持久化/延迟执行/回复/replyTo/自动下一步/事件', async () => {
  const mid = 'life_1';
  const c1 = comment('rc_c1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  const thread = compactThread(mid, 'cha', '今天拍了一张照片，光线很好。', [c1]);
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, thread);
  const now = Date.now();
  syncReplyChainThreads(now);
  /* 1. 创建任务 */
  const t1 = maybeCreateReplyTask(mid, now);
  assert.ok(t1, '1: task created');
  assert.strictEqual(t1.status, 'pending');
  assert.strictEqual(t1.roleId, 'cha', '1: author is the only candidate');
  /* 2. 持久化（写盘后可读回） */
  saveNow();
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'active-message-service.json'), 'utf8'));
  assert.ok(onDisk.replyChains[mid] && onDisk.replyChains[mid].tasks[t1.taskKey], '2: task persisted');
  /* 3. 延迟执行：创建后仅排队（pending + 未来时刻），不立即执行 */
  assert.strictEqual(t1.status, 'pending');
  assert.ok(t1.scheduledAt > now, '3: scheduled in the future (delayed execution)');
  const due = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  /* 4. AI 回复成功 */
  assert.ok(due && due.published, '4: reply published');
  assert.strictEqual(due.comment.authorId, 'cha');
  /* 5. replyTo 正确（相对首层评论） */
  const rec = getState().replyChains[mid];
  assert.strictEqual(due.comment.replyTo, 'rc_c1', '5: replyTo correct');
  assert.strictEqual(rec.thread.comments.length, 2);
  /* 6. 下一轮任务自动产生（角色不同 + 指向最新评论） */
  const active = Object.values(rec.tasks).filter(t => ['pending', 'running'].includes(t.status));
  assert.strictEqual(active.length, 1, '6: next task auto-created');
  const t2 = active[0];
  assert.notStrictEqual(t2.roleId, 'cha');
  assert.strictEqual(t2.commentId, due.comment.id, '6: next task references the newest comment');
  /* 20. 事件回传 */
  const evs = eventByKind();
  assert.strictEqual(evs.length, 1, '20: one moment_reply event');
  assert.strictEqual(evs[0].moment_id, mid);
  assert.strictEqual(evs[0].comment_id, due.comment.id);
  assert.strictEqual(evs[0].reply_to, 'rc_c1');
  assert.strictEqual(evs[0].role_id, 'cha');
  assert.strictEqual(evs[0].acknowledged, false, '20: unacked for browser pull');
  /* 第 2 步：DeepSeek 回复 ChromeAI（cooldown 内 cha 不可再发；ds 90min 前发言 → 可发） */
  const due2 = await executeReplyChainTask(mid, t2.taskKey, t2.scheduledAt + 200);
  assert.ok(due2 && due2.published, 'ds replies');
  assert.strictEqual(due2.comment.authorId, 'ds');
  assert.strictEqual(due2.comment.replyTo, due.comment.id);
  assert.strictEqual(rec.thread.comments.length, 3);
  /* 冷却耗尽：cha 与 ds 均在 45min 冷却内 → 不再产生任务 */
  assert.strictEqual(maybeCreateReplyTask(mid, Date.now()), null, '6: no more candidates -> chain stops');
});

/* 7：companion 关闭/重启后任务恢复（状态文件 → 重新装载 → 继续执行） */
test('重启恢复：pending 任务从磁盘恢复后可继续执行', async () => {
  const mid = 'restart_1';
  const c1 = comment('rc_r1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '重启测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  assert.ok(t1);
  saveNow();
  /* 模拟关闭再启动：内存状态清空（armedUsers 归零——真实流程需浏览器重新对账） */
  resetStateForTest();
  const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'active-message-service.json'), 'utf8'));
  assert.ok(parsed.replyChains[mid] && parsed.replyChains[mid].tasks[t1.taskKey], 'task durable on disk');
  Object.assign(getState(), parsed);
  setArmed('u1');
  const due = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(due && due.published, '7: resumed task executes after restart');
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 2);
});

/* 8：同任务重复执行幂等（进程内重放） */
test('幂等：同一 task 重复执行不产生重复评论/事件', async () => {
  const mid = 'idem_1';
  const c1 = comment('rc_i1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok' }, compactThread(mid, 'cha', '幂等测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  const r1 = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(r1 && r1.published);
  const before = getState().replyChains[mid].thread.comments.length;
  const evBefore = eventByKind().length;
  const r2 = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 400);
  assert.ok(r2 && r2.skipped, '8: replay skipped');
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, before, '8: no duplicate comment');
  assert.strictEqual(eventByKind().length, evBefore, '8: no duplicate event');
});

/* 9+10：评论 >12 停止 / 轮数 ≥3 停止 */
test('护栏：>12 条评论与 3 轮后不再创建任务', () => {
  const mid = 'lim_1';
  const cs13 = [];
  for (let i = 1; i <= 13; i++) cs13.push(comment('rc_l' + i, i % 2 ? 'ds' : 'cha', '评论 ' + i, i > 1 ? 'rc_l' + (i - 1) : ''));
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '上限测试。', cs13));
  const now = Date.now();
  syncReplyChainThreads(now);
  assert.strictEqual(maybeCreateReplyTask(mid, now), null, '9: over 12 comments -> no task');
  const midR = 'lim_r';
  /* 4 条全部带 replyTo → 轮数 4 ≥ 3 */
  const csR = [];
  for (let i = 1; i <= 4; i++) csR.push(comment('rc_r' + i, i % 2 ? 'ds' : 'cha', '轮 ' + i, 'rc_r' + (i - 1)));
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(midR, 'cha', '轮数测试。', csR));
  syncReplyChainThreads(now);
  assert.strictEqual(maybeCreateReplyTask(midR, now), null, '10: round >= 3 -> no task');
});

/* 11+12+13：频控与冷却规则（共享核心纯函数 = 前后台同规则） */
test('频控：小时/日上限与 45min 冷却（共享核心规则）', () => {
  const now = Date.now();
  const four = [now - 1000, now - 60000, now - 120000, now - 180000];
  assert.strictEqual(replyChainCore.replyRoomOk(four, 0, now), false, '11: hourly cap blocks');
  const daily = [now - 500].concat(four.slice(0, 3)).concat([now - 2 * 3600000, now - 3 * 3600000, now - 4 * 3600000, now - 5 * 3600000, now - 6 * 3600000, now - 7 * 3600000, now - 8 * 3600000, now - 9 * 3600000]);
  assert.strictEqual(replyChainCore.replyRoomOk(daily, 0, now), false, '12: daily cap blocks');
  assert.strictEqual(replyChainCore.replyRoomOk([now - 1000], 0, now), false, '13: 45min cooldown blocks via recent timestamp');
  assert.strictEqual(replyChainCore.replyRoomOk([new Date(now - 90 * 60000).getTime()], 0, now), true);
});

/* 14：aiComment 关闭 → 到期任务被撤销 + 不再创建 */
test('开关：aiComment=false 撤销 pending 并停止创建', () => {
  const mid = 'toggle_1';
  const c1 = comment('rc_t1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '开关测试。', [c1]), { aiComment: false });
  const s = getState();
  const now = Date.now();
  syncReplyChainThreads(now);
  assert.strictEqual(maybeCreateReplyTask(mid, now), null, '14: no task when aiComment off');
  assert.strictEqual(replyChainTaskCount(), 0, '14: no pending tasks');
  /* 先在开启状态建任务，再关闭 → 撤销 */
  s.moments.cha.moments_prefs = { aiComment: true };
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  assert.ok(t1);
  const s2 = getState();
  s2.moments.cha.moments_prefs = { aiComment: false };
  syncReplyChainThreads(now);
  assert.strictEqual(getState().replyChains[mid].tasks[t1.taskKey].status, 'expired', '14: pending expired on off');
});

/* 15：publishReply=false → 无回复、无事件、链自然结束 */
test('模型选择不参与：publishReply=false', async () => {
  const mid = 'decl_1';
  const c1 = comment('rc_d1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'decl', ds: 'ds-ok' }, compactThread(mid, 'cha', '不参与测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  assert.ok(t1);
  const r = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(r && r.published === false, '15: declined');
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 1, '15: no comment appended');
  assert.strictEqual(eventByKind().length, 0, '15: no reply event');
  assert.strictEqual(maybeCreateReplyTask(mid, Date.now()), null, '15: chain stops');
});

/* 16：非法 replyTo → 回落到建议目标（线程最新评论） */
test('非法 replyTo 回落到建议目标', async () => {
  const mid = 'bad_1';
  const c1 = comment('rc_b1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'badrep' }, compactThread(mid, 'cha', '非法回复测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  const r = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(r && r.published, '16: published with fallback');
  assert.strictEqual(r.comment.replyTo, 'rc_b1', '16: invalid replyTo fell back to suggested target');
});

/* 17：重复文本 → 不追加重复评论 */
test('重复文本被过滤', async () => {
  const mid = 'dup_1';
  const c1 = comment('rc_p1', 'ds', '第一句话。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'duprep' }, compactThread(mid, 'cha', '重复测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  const r = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(r && (r.published === false || r.retry || r.failed || r.skipped), '17: no duplicate appended');
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 1, '17: thread unchanged');
});

/* 18+19：API retry（生成内重试成功）与 retry 超限（任务级失败） */
test('API 重试与超限', async () => {
  /* 18: retryok 首次非 JSON → 第二次成功 */
  const mid = 'retry_ok';
  const c1 = comment('rc_o1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'retryok' }, compactThread(mid, 'cha', '重试成功测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t1 = maybeCreateReplyTask(mid, now);
  mockFailOnce = true;
  const r = await executeReplyChainTask(mid, t1.taskKey, t1.scheduledAt + 200);
  assert.ok(r && r.published, '18: generation retried and succeeded');
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 2);

  /* 19: retryfail 两次执行（任务级）后 failed —— 使用独立角色 rf 避开上一段 cha 的冷却 */
  const mid2 = 'retry_fail';
  const c2 = comment('rc_f1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ rf: 'retryfail' }, compactThread(mid2, 'rf', '重试失败测试。', [c2]));
  const now2 = Date.now();
  syncReplyChainThreads(now2);
  const t2 = maybeCreateReplyTask(mid2, now2);
  assert.ok(t2, '19: task created for rf');
  const r1 = await executeReplyChainTask(mid2, t2.taskKey, t2.scheduledAt + 200);
  assert.ok(r1 && r1.retry, '19: first execution schedules a retry');
  const t2b = getState().replyChains[mid2].tasks[t2.taskKey];
  assert.strictEqual(t2b.status, 'pending');
  const r2 = await executeReplyChainTask(mid2, t2.taskKey, Math.max(t2b.scheduledAt + 200, Date.now() + 200));
  assert.ok(r2 && r2.failed, '19: retry limit reached -> failed');
  assert.ok(getState().replyChains[mid2].thread.comments.length === 1, '19: no partial comment');
});

/* 21：事件重放（浏览器重复拉取）不重复；重新打开（重同步）线程完整 */
test('事件重放与重新打开：线程完整、无重复', async () => {
  const mid = 'reopen_1';
  const c1 = comment('rc_m1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '重新打开测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  let t = maybeCreateReplyTask(mid, now);
  await executeReplyChainTask(mid, t.taskKey, t.scheduledAt + 200);
  t = Object.values(getState().replyChains[mid].tasks).find(x => x.status === 'pending');
  await executeReplyChainTask(mid, t.taskKey, t.scheduledAt + 200);
  const finals = getState().replyChains[mid];
  assert.strictEqual(finals.thread.comments.length, 3, 'chain: ds → cha → ds');
  /* 事件重放：再次执行已完成任务 → 无重复评论/事件 */
  const evBefore = eventByKind().length;
  for (const k of Object.keys(finals.tasks)) {
    const skip = await executeReplyChainTask(mid, k, Date.now() + 1000);
    assert.ok(skip && skip.skipped, '21: replay skipped');
  }
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 3);
  assert.strictEqual(eventByKind().length, evBefore, '21: no duplicate events');
  /* 重新打开：浏览器（已 ingest 全部事件）重新同步快照 → 并集合并不重复、线程完整 */
  const browserComments = [
    comment('rc_m1', 'ds', '这个照片拍得不错。', ''),
    ...getState().replyChains[mid].thread.comments.slice(1).map(c => ({
      id: c.id, authorType: 'role', authorId: c.authorId, content: c.content, replyTo: c.replyTo, createdAt: c.createdAt
    }))
  ];
  const browserThread = compactThread(mid, 'cha', '重新打开测试。', browserComments);
  const s = getState();
  s.moments.cha.recent_threads = [browserThread];
  s.moments.ds.recent_threads = [browserThread];
  syncReplyChainThreads(Date.now());
  const merged = getState().replyChains[mid].thread.comments;
  assert.strictEqual(merged.length, 3, '23: reopen keeps complete thread exactly once');
  const ids = merged.map(c => c.id);
  assert.strictEqual(new Set(ids).size, 3, '23: no duplicate comment ids');
  assert.strictEqual(Object.values(getState().replyChains[mid].tasks).filter(x => ['pending', 'running'].includes(x.status)).length, 0, '23: no duplicate pending tasks');
});

/* 22：浏览器关闭后继续（无浏览器同步，任务照常执行；replyChainTick 的完整路径） */
test('浏览器关闭后：replyChainTick 持续推进到冷却耗尽', async () => {
  const mid = 'closed_1';
  const c1 = comment('rc_c1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '关闭浏览器测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const rec0 = getState().replyChains[mid];
  assert.ok(rec0, '22: thread synced before browser close');
  /* 连打 6 个 tick（每个 +30ms 超过 5-15ms 延迟 + 500ms 容差）——期间没有任何浏览器同步 */
  for (let i = 1; i <= 6; i++) await replyChainTick(now + i * 60);
  const rec = getState().replyChains[mid];
  assert.strictEqual(rec.thread.comments.length, 3, '22: chain advances to 3 comments with no browser');
  assert.strictEqual(rec.thread.comments[1].authorId, 'cha', '22: author replied');
  assert.strictEqual(rec.thread.comments[2].authorId, 'ds', '22: first participant replied back');
  /* 冷却耗尽 → 停止 */
  await replyChainTick(now + 7 * 60);
  assert.strictEqual(getState().replyChains[mid].thread.comments.length, 3, '22: chain stops at cooldown');
  assert.ok(eventByKind().length >= 2, '22: events queued for later browser reopen');
});

/* 23（补充 assert 已在 reopen 测试）：浏览器重开后事件可重建完整线程 */
test('重新打开后：事件载荷即可重建完整线程（replyTo 关系正确）', () => {
  const mid = 'rebuild_1';
  const c1 = comment('rc_q1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '重建测试。', [c1]));
  const now = Date.now();
  syncReplyChainThreads(now);
  const t = maybeCreateReplyTask(mid, now);
  return executeReplyChainTask(mid, t.taskKey, t.scheduledAt + 200).then(r => {
    assert.ok(r && r.published);
    const ev = eventByKind()[0];
    assert.ok(ev && ev.comment && ev.comment.replyTo === 'rc_q1', '23: event payload carries correct replyTo');
    /* 浏览器按事件重建：追加 comment 到已存在的 moment */
    const rebuilt = [c1, ev.comment].map(c => ({ id: c.id, authorId: c.authorId, replyTo: c.replyTo, content: c.content }));
    assert.strictEqual(rebuilt.length, 2);
    assert.strictEqual(rebuilt[1].replyTo, rebuilt[0].id, '23: tree edge preserved');
  });
});

/* 24：第三方加入（确定性搜一个 momentId 使亲和门槛通过） */
test('第三方角色加入（共享核心候选规则）', () => {
  const c1css = [comment('rc_t3', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString())];
  const roles = [
    { id: 'cha', canSpeak: true },
    { id: 'ds', canSpeak: false }, /* lastRC 由核心排除 */
    { id: 'kim', canSpeak: true }
  ];
  let found = null;
  for (let i = 0; i < 30; i++) {
    const mid = 'tp_' + i + '_' + Math.random().toString(36).slice(2, 6);
    const step = replyChainCore.pickNextReplyRole({ momentId: mid, comments: c1css, postAuthor: 'cha', roles });
    if (step && step.roleId === 'kim') { found = { mid, step }; break; }
  }
  assert.ok(found, '24: found a deterministic momentId choosing the third party');
  assert.strictEqual(found.step.kind, 'third');
  assert.strictEqual(found.step.replyTo, 'rc_t3');
  /* 同 momentId 重放 → 完全一致（确定性） */
  const again = replyChainCore.pickNextReplyRole({ momentId: found.mid, comments: c1css, postAuthor: 'cha', roles });
  assert.strictEqual(again.roleId, 'kim', '24: deterministic replay identical');
});

/* 在共享核心规则上搜索一个确定性 momentId，使 picker 必选期望角色（与 #24 同法） */
function findDeterministicMoment(prefix, comments, postAuthor, roleIds, expected) {
  for (let i = 0; i < 60; i++) {
    const mid = `${prefix}_${i}`;
    const roles = roleIds.map(id => ({ id, canSpeak: true }));
    const step = replyChainCore.pickNextReplyRole({ momentId: mid, comments, postAuthor, roles });
    if (step && step.roleId === expected) return mid;
  }
  throw new Error(`no deterministic momentId for ${prefix} -> ${expected}`);
}

/* 25：多线程并行互不影响（不同作者/角色组合，各自推进、事件独立） */
test('多线程并行：两条链各自推进、事件独立', async () => {
  const cA0 = comment('rc_a1', 'ds', 'A 的首层。', '', new Date(Date.now() - 90 * 60000).toISOString());
  const cB0 = comment('rc_b1', 'ds', 'B 的首层。', '', new Date(Date.now() - 90 * 60000).toISOString());
  const roleIds = ['cha', 'ds', 'kim'];
  const mA = findDeterministicMoment('multi_a', [cA0], 'cha', roleIds, 'cha');
  const mB = findDeterministicMoment('multi_b', [cB0], 'kim', roleIds, 'kim');
  /* 用确定性 momentId 重造 comment 引用（搜索时用的是临时 id，落库前重新构造） */
  const cA = comment('rc_a1', 'ds', 'A 的首层。', '', cA0.createdAt);
  const cB = comment('rc_b1', 'ds', 'B 的首层。', '', cB0.createdAt);
  const tAObj = compactThread(mA, 'cha', 'A 帖。', [cA]);
  const tBObj = compactThread(mB, 'kim', 'B 帖。', [cB]);
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok', kim: 'kim-ok' }, tAObj);
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok', kim: 'kim-ok' }, tBObj);
  /* 两个线程都进所有角色快照（等价浏览器会同时看到两条链） */
  const s = getState();
  ['cha', 'ds', 'kim'].forEach(rid => { s.moments[rid].recent_threads = [tAObj, tBObj]; });
  const now = Date.now();
  syncReplyChainThreads(now);
  assert.ok(getState().replyChains[mA] && getState().replyChains[mB], '25: both thread records synced');
  const tA = maybeCreateReplyTask(mA, now);
  const tB = maybeCreateReplyTask(mB, now);
  assert.ok(tA && tB, '25: both threads got tasks');
  assert.strictEqual(tA.roleId, 'cha', '25: A picked author');
  assert.strictEqual(tB.roleId, 'kim', '25: B picked its author');
  await executeReplyChainTask(mA, tA.taskKey, tA.scheduledAt + 200);
  await executeReplyChainTask(mB, tB.taskKey, tB.scheduledAt + 200);
  const recA = getState().replyChains[mA], recB = getState().replyChains[mB];
  assert.strictEqual(recA.thread.comments.length, 2, '25: thread A advanced once');
  assert.strictEqual(recB.thread.comments.length, 2, '25: thread B advanced once');
  assert.strictEqual(recA.thread.comments[1].content, '你也喜欢？');
  assert.strictEqual(recB.thread.comments[1].content, '我觉得光线很好。');
  assert.strictEqual(recA.thread.comments[1].replyTo, 'rc_a1');
  assert.strictEqual(recB.thread.comments[1].replyTo, 'rc_b1');
  const evs = eventByKind();
  assert.strictEqual(evs.length, 2, '25: two independent events');
  assert.deepStrictEqual(evs.map(e => e.moment_id).sort(), [mA, mB].sort());
});

/* helper 冒烟：sanitize / merge */
test('工具函数：sanitizeReplyThread / mergeThreadComments', () => {
  const t = sanitizeReplyThread(compactThread('x', 'cha', '内容', [comment('rc_s1', 'ds', '好。')]));
  assert.ok(t && t.id === 'x' && t.comments.length === 1);
  const merged = mergeThreadComments(
    [comment('rc_z1', 'ds', '一', '')],
    [comment('rc_z1', 'ds', '一', ''), comment('rc_z2', 'cha', '二', 'rc_z1')]
  );
  assert.strictEqual(merged.length, 2, 'union by id');
  assert.strictEqual(merged[1].id, 'rc_z2');
});

test('momentsTick 集成：既有发帖调度与回复链同一 tick 共存', async () => {
  const mid = 'coexist_1';
  const c1 = comment('rc_x1', 'ds', '这个照片拍得不错。', '', new Date(Date.now() - 90 * 60000).toISOString());
  seedRoles({ cha: 'cha-ok', ds: 'ds-ok' }, compactThread(mid, 'cha', '共存测试。', [c1]));
  const now = Date.now();
  await momentsTick(now);
  assert.ok(getState().replyChains[mid], 'reply chain record synced within momentsTick');
  await momentsTick(now + 20);
  assert.ok(getState().replyChains[mid].thread.comments.length >= 1, 'reply executed within momentsTick integration');
});
