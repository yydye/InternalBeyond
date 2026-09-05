/* test_proactive_interaction.js — Proactive Interaction v1 纯逻辑回归（Node 直测，零浏览器）。
   覆盖：交互模型（text_message | voice_call）、主动事件规范与去重、事件状态生命周期、
   通话状态机（呼入/接听/挂断/打断）、时长格式化、全局短回合（brevity）策略。
   生成/音频陈旧保护等 runtime 级行为由 test_voice_streaming.js / test_voice_runtime.js 覆盖。
   node test_proactive_interaction.js 运行；零依赖。 */
'use strict';

const assert = require('assert');
const pi = require('./assets/js/proactive-interaction-core.js');
const brevity = require('./assets/js/brevity-policy.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

console.log('Proactive Interaction v1 纯逻辑测试\n');

/* ── A. 交互模型 ── */
check('normalizeInteraction 接受 text_message', function () { assert.strictEqual(pi.normalizeInteraction('text_message'), 'text_message'); });
check('normalizeInteraction 接受 voice_call', function () { assert.strictEqual(pi.normalizeInteraction('voice_call'), 'voice_call'); });
check('normalizeInteraction 非法值回落 text_message', function () { assert.strictEqual(pi.normalizeInteraction('call'), 'text_message'); });
check('normalizeInteraction 空值回落 text_message', function () { assert.strictEqual(pi.normalizeInteraction(undefined), 'text_message'); });
check('INTERACTIONS 仅含两种类型', function () { assert.deepStrictEqual(pi.INTERACTIONS, ['text_message', 'voice_call']); });

/* ── B. 主动事件规范：text_message ── */
check('proactive text event 规范化', function () {
  const ev = pi.normalizeEvent({ roleId: 'r1', roleName: 'Miya', interaction: 'text_message', openingMessage: '今天过得怎么样？', reason: '想聊聊' });
  assert.strictEqual(ev.roleId, 'r1');
  assert.strictEqual(ev.interaction, 'text_message');
  assert.strictEqual(ev.openingMessage, '今天过得怎么样？');
  assert.strictEqual(ev.status, 'pending');
  assert.ok(ev.eventId);
  assert.ok(ev.createdAt);
});

/* ── C. 主动事件规范：voice_call（含 callMeta） ── */
check('proactive voice-call event 规范化（带 call 元数据）', function () {
  const ev = pi.normalizeEvent({
    roleId: 'r2', roleName: 'Sui', interaction: 'voice_call', reason: '想听见你的声音',
    openingMessage: '你在忙吗？', callMeta: { conversationId: 'main:r2', openingLine: '你在忙吗？' }, planId: 'p9'
  });
  assert.strictEqual(ev.interaction, 'voice_call');
  assert.strictEqual(ev.callMeta.conversationId, 'main:r2');
  assert.strictEqual(ev.callMeta.openingLine, '你在忙吗？');
  assert.strictEqual(ev.openingLine, '你在忙吗？');
  assert.strictEqual(ev.planId, 'p9');
});

/* ── D. 重复主动事件预防 ── */
check('isDuplicateEvent 同角色同类型近似正文 → 重复', function () {
  const a = pi.normalizeEvent({ roleId: 'r1', interaction: 'text_message', openingMessage: '今天过得怎么样呢' });
  const b = pi.normalizeEvent({ roleId: 'r1', interaction: 'text_message', openingMessage: '今天过得怎么样啊' });
  assert.strictEqual(pi.isDuplicateEvent(b, [a]), true);
});
check('isDuplicateEvent 同角色不同交互类型 → 不重复', function () {
  const a = pi.normalizeEvent({ roleId: 'r1', interaction: 'text_message', openingMessage: '今天过得怎么样呢' });
  const b = pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '今天过得怎么样呢' });
  assert.strictEqual(pi.isDuplicateEvent(b, [a]), false);
});
check('isDuplicateEvent 已有 pending 呼入 → 重复（只留一个来电）', function () {
  const a = pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '在吗', status: 'pending' });
  const b = pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '在吗', status: 'pending' });
  assert.strictEqual(pi.isDuplicateEvent(b, [a]), true);
});
check('isDuplicateEvent 已拒绝的呼入不阻塞新的呼入', function () {
  const a = pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '在吗', status: 'declined' });
  const b = pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '现在方便接电话吗' });
  assert.strictEqual(pi.isDuplicateEvent(b, [a]), false);
});
check('eventKey 稳定且区分角色/类型', function () {
  const a = pi.eventKey(pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '在吗' }));
  const b = pi.eventKey(pi.normalizeEvent({ roleId: 'r1', interaction: 'voice_call', openingMessage: '在吗' }));
  const c = pi.eventKey(pi.normalizeEvent({ roleId: 'r2', interaction: 'voice_call', openingMessage: '在吗' }));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

/* ── E. 通话状态机（idle/incoming/connecting/connected/listening/thinking/speaking/interrupting/ending/ended） ── */
check('状态机：idle → incoming（呼入）', function () { assert.strictEqual(pi.canTransition('idle', 'incoming'), true); });
check('状态机：incoming → connecting（接听）', function () { assert.strictEqual(pi.canTransition('incoming', 'connecting'), true); });
check('状态机：incoming → ended（拒绝/忽略）', function () { assert.strictEqual(pi.canTransition('incoming', 'ended'), true); });
check('状态机：connecting → connected', function () { assert.strictEqual(pi.canTransition('connecting', 'connected'), true); });
check('状态机：listening → thinking → speaking', function () {
  assert.strictEqual(pi.canTransition('listening', 'thinking'), true);
  assert.strictEqual(pi.canTransition('thinking', 'speaking'), true);
});
check('状态机：speaking → interrupting → listening（打断/插话）', function () {
  assert.strictEqual(pi.canTransition('speaking', 'interrupting'), true);
  assert.strictEqual(pi.canTransition('interrupting', 'listening'), true);
});
check('状态机：任意活动态 → ending → ended（挂断收尾）', function () {
  assert.strictEqual(pi.canTransition('listening', 'ending'), true);
  assert.strictEqual(pi.canTransition('speaking', 'ending'), true);
  assert.strictEqual(pi.canTransition('ending', 'ended'), true);
});
check('状态机：ended 为终态（不可回退）', function () {
  assert.strictEqual(pi.canTransition('ended', 'listening'), false);
  assert.strictEqual(pi.canTransition('ended', 'idle'), false);
});
check('状态机：非法状态回落 idle', function () { assert.strictEqual(pi.normalizeCallState('bogus'), 'idle'); });
check('状态机：同状态迁移允许（幂等重入）', function () { assert.strictEqual(pi.canTransition('listening', 'listening'), true); });

/* ── F. 事件状态生命周期与过期清理 ── */
check('normalizeEvent 状态白名单：非法回落 pending', function () {
  assert.strictEqual(pi.normalizeEvent({ status: 'rejected' }).status, 'pending');
});
check('purgeExpired 保留非 pending（已接听/已拒绝）的事件', function () {
  const old = Date.now() - 10 * 60 * 60 * 1000;
  const items = [
    pi.normalizeEvent({ roleId: 'r1', status: 'accepted', createdAt: new Date(old).toISOString() }),
    pi.normalizeEvent({ roleId: 'r1', status: 'pending', createdAt: new Date(old).toISOString() })
  ];
  const kept = pi.purgeExpired(items, 2 * 60 * 60 * 1000);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].status, 'accepted');
});

/* ── G. 时长格式化 ── */
check('formatDuration 秒级', function () { assert.strictEqual(pi.formatDuration(0), '0:00'); });
check('formatDuration 分钟 + 补零', function () { assert.strictEqual(pi.formatDuration(90000), '1:30'); });
check('formatDuration 小时级', function () { assert.strictEqual(pi.formatDuration(3661000), '1:01:01'); });

/* ── H. 全局短回合（brevity）策略 ── */
check('isDetailedRequest 命中中文详细请求', function () { assert.strictEqual(brevity.isDetailedRequest('请详细解释一下'), true); });
check('isDetailedRequest 命中中文为什么', function () { assert.strictEqual(brevity.isDetailedRequest('为什么会这样'), true); });
check('isDetailedRequest 命中英文 why', function () { assert.strictEqual(brevity.isDetailedRequest('why does this happen'), true); });
check('isDetailedRequest 普通闲聊不命中', function () { assert.strictEqual(brevity.isDetailedRequest('早啊'), false); });
check('guidance voice 明显短于 text（含“短句”约束）', function () {
  const v = brevity.guidanceFor('voice').join('\n');
  const t = brevity.guidanceFor('text').join('\n');
  assert.ok(/1 至 2 个短句/.test(v), 'voice 应约束为 1-2 句');
  assert.ok(/1 至 3 个短句/.test(t), 'text 应约束为 1-3 句');
  assert.ok(v.indexOf('短于文字') !== -1);
});
check('buildGuidance proactive 为 1-2 句', function () {
  assert.ok(/1 至 2 个短句/.test(brevity.buildGuidance({ mode: 'proactive' })));
});
check('buildGuidance detailed 覆盖时不输出策略', function () { assert.strictEqual(brevity.buildGuidance({ detailed: true }), ''); });
check('apply 幂等（不重复注入）', function () {
  const sys = '你是 Mia。';
  const once = brevity.apply(sys, { mode: 'text' });
  const twice = brevity.apply(once, { mode: 'text' });
  assert.strictEqual(once, twice);
});
check('apply detailed 时不追加策略', function () { assert.strictEqual(brevity.apply('你是Mia。', { detailed: true }), '你是Mia。'); });
/* ── I. 角色级「简洁回复」（replyStyle === 'concise'）── */
check('conciseGuidance 输出简洁回复约束', function () {
  const g = brevity.conciseGuidance();
  assert.ok(g.indexOf('【简洁回复') === 0, '应包含简洁回复标记');
  assert.ok(/重复用户已经知道的信息/.test(g), '应包含“不重复用户已知信息”');
  assert.ok(/不主动追加“如果你愿意我还可以/.test(g), '应禁止追加“如果你愿意我还可以”尾巴');
  assert.ok(/详细解释/.test(g), '应保留“允许详细展开”豁免');
});
check('buildGuidance concise 用简洁约束而非全局短回合', function () {
  assert.ok(brevity.buildGuidance({ concise: true }).indexOf('【简洁回复') === 0);
  assert.ok(brevity.buildGuidance({ concise: true }).indexOf('【表达风格】') === -1);
});
check('buildGuidance concise + detailed 覆盖时不输出', function () { assert.strictEqual(brevity.buildGuidance({ concise: true, detailed: true }), ''); });
check('apply concise 注入简洁约束并可幂等', function () {
  const once = brevity.apply('你是Mia。', { concise: true });
  assert.ok(once.indexOf('【简洁回复') !== -1);
  assert.strictEqual(once, brevity.apply(once, { concise: true }));
  assert.strictEqual(brevity.apply('你是Mia。', { concise: true, detailed: true }), '你是Mia。');
});
check('apply normal（默认）不回退到简洁约束（回复依赖 replyStyle 缺省为 normal）', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', concise: false });
  assert.ok(out.indexOf('【表达风格】') !== -1);
  assert.ok(out.indexOf('【简洁回复') === -1);
});
/* ── J. 角色级「自然收尾」（naturalEnding === true，与 replyStyle 相互独立）── */
check('naturalEndingGuidance 输出自然收尾约束', function () {
  const g = brevity.naturalEndingGuidance();
  assert.ok(g.indexOf('【自然收尾') === 0, '应包含自然收尾标记');
  assert.ok(/机械追加问题、总结、邀请/.test(g), '应约束“不机械追加问题/总结/邀请”');
  assert.ok(/不要每条消息都以问题结尾/.test(g), '应禁止每条都以问题结尾');
  assert.ok(/需要询问关键信息时仍然应该询问/.test(g), '应保留“关键信息仍应询问”');
  assert.ok(/用户明确要求建议、下一步/.test(g), '应保留“用户要求展开时不阻止”');
});
check('naturalEnding=true 注入对应 guidance', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', naturalEnding: true });
  assert.ok(out.indexOf('【自然收尾') !== -1);
  assert.ok(out.indexOf('【表达风格】') !== -1, '自然收尾与全局短回合应同时存在');
});
check('naturalEnding=false 不注入', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', naturalEnding: false });
  assert.ok(out.indexOf('【自然收尾') === -1);
});
check('replyStyle=concise + naturalEnding=true 同时生效', function () {
  const out = brevity.apply('你是Mia。', { concise: true, naturalEnding: true });
  assert.ok(out.indexOf('【简洁回复') !== -1);
  assert.ok(out.indexOf('【自然收尾') !== -1);
});
check('replyStyle=normal + naturalEnding=true 独立生效', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', concise: false, naturalEnding: true });
  assert.ok(out.indexOf('【表达风格】') !== -1, 'normal 保持全局短回合');
  assert.ok(out.indexOf('【简洁回复') === -1);
  assert.ok(out.indexOf('【自然收尾') !== -1);
});
check('detailed 请求不因 naturalEnding 阻止必要结构（豁免）', function () {
  assert.strictEqual(brevity.apply('你是Mia。', { mode: 'text', naturalEnding: true, detailed: true }), '你是Mia。');
});
check('naturalEnding 注入具有幂等性', function () {
  const once = brevity.apply('你是Mia。', { concise: true, naturalEnding: true });
  const twice = brevity.apply(once, { concise: true, naturalEnding: true });
  assert.strictEqual(once, twice);
});
check('老角色缺失 naturalEnding 字段时行为保持不变（回退 false）', function () {
  const cfg = {}; /* 旧角色无字段 */
  const out = brevity.apply('你是Mia。', { mode: 'text', concise: !!(cfg.replyStyle === 'concise'), naturalEnding: !!cfg.naturalEnding });
  assert.ok(out.indexOf('【表达风格】') !== -1);
  assert.ok(out.indexOf('【自然收尾】') === -1);
});
check('不存在输出后处理：apply 只追加不裁剪原文本', function () {
  const base = '这句话以“需要我帮你吗？”自然结尾。';
  const out = brevity.apply(base, { concise: true, naturalEnding: true });
  assert.ok(out.indexOf(base) === 0, '原文必须原样保留在开头，不做任何删除/截断');
  assert.ok(out.length > base.length, '只在末尾追加策略文本');
});
/* ── K. 角色级「保持对话连贯」（conversationContinuity === true，与其余表达设置相互独立）── */
check('conversationContinuityGuidance 输出对话连贯约束', function () {
  const g = brevity.conversationContinuityGuidance();
  assert.ok(g.indexOf('【对话连贯') === 0, '应包含对话连贯标记');
  assert.ok(/不要重新介绍自己/.test(g), '应禁止重新介绍自己');
  assert.ok(/指代.*根据现有上下文理解/.test(g), '应处理指代（它/那个/这样）');
  assert.ok(/不要猜测关键事实/.test(g), '应防止伪造线索/猜测事实');
  assert.ok(/可以正常询问/.test(g), '上下文不足时应允许询问');
});
check('conversationContinuity=true 注入对应 guidance', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', conversationContinuity: true });
  assert.ok(out.indexOf('【对话连贯') !== -1);
});
check('conversationContinuity=false 不注入', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', conversationContinuity: false });
  assert.ok(out.indexOf('【对话连贯') === -1);
});
check('老角色缺失 conversationContinuity 字段时回退 false（行为保持不变）', function () {
  const cfg = {}; /* 旧角色无字段 */
  const out = brevity.apply('你是Mia。', { mode: 'text', conversationContinuity: !!cfg.conversationContinuity });
  assert.ok(out.indexOf('【表达风格】') !== -1);
  assert.ok(out.indexOf('【对话连贯') === -1);
});
check('concise + continuity 可以同时生效', function () {
  const out = brevity.apply('你是Mia。', { concise: true, conversationContinuity: true });
  assert.ok(out.indexOf('【简洁回复') !== -1);
  assert.ok(out.indexOf('【对话连贯') !== -1);
});
check('naturalEnding + continuity 可以同时生效', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', naturalEnding: true, conversationContinuity: true });
  assert.ok(out.indexOf('【自然收尾') !== -1);
  assert.ok(out.indexOf('【对话连贯') !== -1);
});
check('三者同时开启可以正确组合', function () {
  const out = brevity.apply('你是Mia。', { concise: true, naturalEnding: true, conversationContinuity: true });
  assert.ok(out.indexOf('【简洁回复') !== -1);
  assert.ok(out.indexOf('【自然收尾') !== -1);
  assert.ok(out.indexOf('【对话连贯') !== -1);
});
check('对话连贯注入具有幂等性', function () {
  const once = brevity.apply('你是Mia。', { concise: true, middle: true, conversationContinuity: true });
  const twice = brevity.apply(once, { concise: true, naturalEnding: true, conversationContinuity: true });
  assert.strictEqual(once, twice);
});
check('detailed 请求不删除必要 continuity 行为（仍注入对话连贯）', function () {
  const out = brevity.apply('你是Mia。', { mode: 'text', concise: true, naturalEnding: true, conversationContinuity: true, detailed: true });
  assert.ok(out.indexOf('【对话连贯') !== -1, 'detailed 时对话连贯仍应注入，避免重复已建立上下文');
  assert.ok(out.indexOf('【简洁回复') === -1, 'detailed 时简洁约束豁免');
  assert.ok(out.indexOf('【自然收尾') === -1, 'detailed 时自然收尾豁免');
});
check('角色之间配置互不污染（不同 cfg 各自独立）', function () {
  const A = brevity.apply('你是A。', { mode: 'text', conversationContinuity: true });
  const B = brevity.apply('你是B。', { mode: 'text', conversationContinuity: false });
  assert.ok(A.indexOf('【对话连贯') !== -1, '角色 A（开）应注入');
  assert.ok(B.indexOf('【对话连贯') === -1, '角色 B（关）应不注入');
});
check('连续性不强制引用上一句/不禁止一切重复（允许必要时重复）', function () {
  const g = brevity.conversationContinuityGuidance();
  assert.ok(!/每次回复都.*引用上一句/.test(g), '不应强制每条都引用上一句');
  assert.ok(/盲目相信上下文/.test(g), '应明示不盲目相信上下文');
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
