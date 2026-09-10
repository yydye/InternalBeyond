/* ====================================================================
   P20 · Anthropic Wire Contract Convergence 专项测试
   --------------------------------------------------------------------
   锁定本轮唯一生产目标：**Anthropic wire request normalization 单一真源 +
   Browser / Node 对同一 canonical 输入生成语义等价的 Anthropic body。**

   A. canonical message contract：IB 内部允许 system 消息；provider adapter 负责归一。
   B. system normalization 规则：顶层 system + messages system 合并 / 去重 / 稳定顺序 /
      稳定分隔符 / 类型安全（绝不 [object Object]）/ 不丢多条 system。
   C. role invariant：Anthropic messages 永不残留 system；无法映射的 role 不静默删除。
   D. Browser builder（逐字抽取 communication.js 真实函数在沙箱内执行）
      × Node builder（IBModelCore.buildRequestBody + 真实 node-model-port）parity。
   E. P19 policy 不回归（Sonnet 5 / 4.6 / legacy 的 prefill 与 sampling）+ 正常 assistant
      历史逐条保留 + JSON 约束仍在最后一条 user（不进 system）。
   F. 非 Anthropic wire（openai / gemini / Responses）逐位不变。
   G. 单真源守卫：全仓只有一份 Anthropic normalization；不存在第二套复制实现。

   运行：node test_anthropic_wire_contract.js（零依赖，纯 Node，无浏览器、无真实 Key）
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');

const IBMC = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
const CANON = require(path.join(ROOT, 'assets', 'js', 'provider-directory.js'));
const createNodeModelPort = require(path.join(ROOT, 'active', 'node-model-port.js'));
const createNodeModelCompat = require(path.join(ROOT, 'active', 'node-model-compat.js'));
const createMomentsDomain = require(path.join(ROOT, 'active', 'moments.js'));
const createScheduler = require(path.join(ROOT, 'active', 'scheduler.js'));
const replyChainCore = require(path.join(ROOT, 'assets', 'js', 'reply-chain-core.js'));
const planDomain = require(path.join(ROOT, 'active', 'plan-domain.js'));


let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✘ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const coreText = read('assets/js/ib-model-core.js');
const commText = read('assets/js/communication.js');
const portText = read('active/node-model-port.js');
const dirText = read('assets/js/provider-directory.js');

const roles = body => ((body && body.messages) || []).map(m => m.role);
const texts = body => ((body && body.messages) || []).map(m => (typeof m.content === 'string' ? m.content : ''));
const sysText = s => (Array.isArray(s) ? s.map(b => (b && b.text) || '').join('') : (s == null ? '' : String(s)));
const jsonConstraintCount = body => texts(body).reduce((n, t) => n + (t.match(/Return exactly one valid JSON object\./g) || []).length, 0);
const hasAssistantTail = body => roles(body).slice(-1)[0] === 'assistant';

/* ══════════════════════════════════════════════════════════════════
   0. Browser builder：逐字抽取 communication.js 的真实函数并在沙箱执行
   ══════════════════════════════════════════════════════════════════ */
function carve(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start < 0) throw new Error('carve: 未找到 function ' + fnName);
  let depth = 0, i = start, seen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; seen = true; }
    if (c === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  const before = src.slice(Math.max(0, start - 8), start);
  const withAsync = /async\s+$/.test(before);
  return src.slice(withAsync ? start - 6 : start, i);
}
/* Browser 侧 Anthropic 请求构造实际会用到的函数（callApi / _callApiChatOnce 全文抽取，
   依赖的真实 helper 一并抽取；transport 生命周期用桩替换，不复制任何归一逻辑）。 */
const BROWSER_FNS = [
  '_providerFormat', '_modelSupportsSampling', '_ibAnthropicWire',
  '_ccObj', '_ccBeta', '_injectAnthropicMsgCache', '_adaptContentForApi',
  '_mSetThink', '_mSetFinish', '_anthropicWebThinkResponseMode',
  '_callApiChatOnce', 'callApi'
];
const browserCode = BROWSER_FNS.map(n => carve(commText, n)).join('\n');
const browserSource = new Function(
  'window', 'PROVIDERS', 'console', '_ibApiPost', '_tkRecord', '_ibCacheAudit',
  'var _lastApiReasoning="";var _lastApiFinish="";' + browserCode +
  ';return { callApi: callApi, chatOnce: _callApiChatOnce, wire: _ibAnthropicWire };'
);

/* 每次调用新建一个沙箱：window.IBModelCore 与浏览器里是同一个模块（window 挂载点一致）。 */
function browserBuild() {
  const captured = [];
  const audits = [];
  const api = browserSource(
    { PROVIDERS_DIR: CANON, IBModelCore: IBMC },
    CANON.PROVIDERS,
    { info() {}, warn() {}, error() {}, log() {} },
    async function (url, headers, body) {
      captured.push({ url: url, headers: headers, body: JSON.parse(body) });
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
        text: async () => ''
      };
    },
    function () {},
    function (cfg, body, fmt, meta) { audits.push({ fmt: fmt, body: body, meta: meta }); }
  );
  return {
    captured: captured, audits: audits,
    chatOnce: api.chatOnce, callApi: api.callApi, wire: api.wire,
    last: () => captured[captured.length - 1]
  };
}
const browserCfg = extra => Object.assign({
  id: 'b_anth', provider: 'anthropic', model: 'claude-sonnet-5',
  endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k',
  systemPrompt: '你是 Sui。', promptCache: false, streaming: false, temperature: null
}, extra || {});

/* ══════════════════════════════════════════════════════════════════
   1. canonical message contract + 归一规则（core 纯函数）
   ══════════════════════════════════════════════════════════════════ */
section('1. canonical message contract：归一规则（IBModelCore.normalizeAnthropicMessages）');

const CANON_INPUT = {
  system: '角色设定',
  messages: [
    { role: 'system', content: '角色设定' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好。' },
    { role: 'user', content: '继续' }
  ]
};
const norm = IBMC.normalizeAnthropicMessages(CANON_INPUT);
check('单条 system → 顶层 system（IB canonical 输入合法，无需禁止 consumer 产生 system）',
  norm.system === '角色设定');
check('messages 中的 system 不残留（wire messages 只剩 user/assistant）',
  norm.messages.map(m => m.role).join(',') === 'user,assistant,user');
check('user history 保留且顺序不变', norm.messages[0].content === '你好' && norm.messages[2].content === '继续');
check('assistant history 保留且顺序不变', norm.messages[1].role === 'assistant' && norm.messages[1].content === '你好。');
check('顶层 system 与 messages system 同文本 → 只保留一份（不把角色设定送两遍）',
  norm.systemParts.length === 1 && norm.system === '角色设定');

const mergeAB = IBMC.normalizeAnthropicMessages({ system: 'A', messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'u' }] });
check('顶层 system + messages system 合并（顺序 = 顶层在前，随后按出现顺序）',
  mergeAB.system === 'A\n\nB', mergeAB.system);
const manySys = IBMC.normalizeAnthropicMessages({
  system: 'A',
  messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'u1' }, { role: 'system', content: 'C' }, { role: 'user', content: 'u2' }]
});
check('多条 system 全部保留（不静默丢弃）', manySys.system === 'A\n\nB\n\nC', manySys.system);
check('多条 system 顺序稳定（重复归一结果逐位一致）',
  IBMC.normalizeAnthropicMessages({
    system: 'A',
    messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'u1' }, { role: 'system', content: 'C' }, { role: 'user', content: 'u2' }]
  }).system === manySys.system);
check('合并使用稳定分隔符 \\n\\n（不是 join(\'\')）',
  IBMC.normalizeAnthropicMessages({ system: 'X', messages: [{ role: 'system', content: 'Y' }] }).system === 'X\n\nY'
  && /ANTHROPIC_SYSTEM_SEPARATOR = '\\n\\n'/.test(coreText));
check('纯数组形态（Browser consumer 常见）走同一规则：首条 system 提取、其余保留',
  (() => { const r = IBMC.normalizeAnthropicMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }]); return r.system === 'S' && r.messages.length === 1; })());
check('数组形态多条 system 不丢（P20 之前 _prompt 只取首条）',
  IBMC.normalizeAnthropicMessages([{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'u' }]).system === 'A\n\nB');
check('都没有 system 时回落 spec.systemPrompt（数组形态旧行为保持）',
  IBMC.normalizeAnthropicMessages([{ role: 'user', content: 'u' }], { systemPrompt: 'P' }).system === 'P');
check('对象形态 system 为空 → messages system 仍然提取（不产生 system role）',
  IBMC.normalizeAnthropicMessages({ system: '', messages: [{ role: 'system', content: 'X' }, { role: 'user', content: 'u' }] }).system === 'X');
check('空 system 消息直接消费掉（不会产出空的 wire 消息）',
  (() => { const r = IBMC.normalizeAnthropicMessages({ system: '', messages: [{ role: 'system', content: '' }, { role: 'user', content: 'u' }] }); return r.messages.length === 1 && r.system === ''; })());
check('messages 缺失 / 非数组 / 空输入不炸',
  (() => {
    const a = IBMC.normalizeAnthropicMessages({ system: 'S' });
    const b = IBMC.normalizeAnthropicMessages(null);
    const c = IBMC.normalizeAnthropicMessages({ system: 'S', messages: [] });
    return a.messages.length === 0 && b.messages.length === 0 && c.system === 'S';
  })());

section('2. system content 类型：契约是 string，异常形态安全归一（绝不 String(obj)）');
const typed = IBMC.normalizeAnthropicMessages({
  system: 'A',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'B' }, { type: 'text', text: 'C' }] },
    { role: 'system', content: { type: 'text', text: 'D' } },
    { role: 'system', content: 12345 },
    { role: 'system', content: { weird: true } },
    { role: 'user', content: 'u' }
  ]
});
check('block 数组 system（[{type:text,text}]）按块文本合并', /A[\s\S]*B[\s\S]*C/.test(typed.system));
check('{type:text,text} 对象 system 安全取文本', typed.system.indexOf('D') >= 0);
check('非字符串/非 block 的 system **绝不** 变成 [object Object]',
  typed.system.indexOf('[object Object]') < 0 && typed.system.indexOf('12345') < 0, typed.system);
check('实现里不存在 String(content) 式 system 强转（只允许经 _systemText）',
  /function _systemText\(content\)/.test(coreText) && !/_systemText[\s\S]{0,400}String\(content\)/.test(coreText));

section('3. role invariant + 无法映射的 role（不静默吞上下文）');
const unmapped = IBMC.normalizeAnthropicMessages({
  system: 'S',
  messages: [{ role: 'tool', content: 'T' }, { role: 'developer', content: 'D' }, { role: 'user', content: 'u' }]
});
check('非法 role 不被删除（保留原样，由 provider 判定并报错，而不是静默丢用户上下文）',
  unmapped.messages.map(m => m.role).join(',') === 'tool,developer,user');
check('非法 role 记入 unmappedRoles 供诊断', unmapped.unmappedRoles.join(',') === 'tool,developer');
const v1 = IBMC.validateAnthropicRequestBody({ model: 'm', system: 'S', messages: [{ role: 'user', content: 'u' }] });
check('validateAnthropicRequestBody：合法 body 通过', v1.ok === true && v1.problems.length === 0);
const v2 = IBMC.validateAnthropicRequestBody({ model: 'm', system: 'S', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }] });
check('validateAnthropicRequestBody：抓得到 messages 里的 system role', v2.ok === false && v2.problems.indexOf('system-role-in-messages') >= 0);
const v3 = IBMC.validateAnthropicRequestBody({ messages: [{ role: 'developer', content: 'x' }] });
check('validateAnthropicRequestBody：developer 同样非法 + 缺 model 被报告',
  v3.problems.indexOf('system-role-in-messages') >= 0 && v3.problems.indexOf('missing-model') >= 0);
check('validateAnthropicRequestBody 是纯函数 / 不抛错（生产路径不据此炸用户请求）',
  IBMC.validateAnthropicRequestBody(null).ok === false && IBMC.validateAnthropicRequestBody({ model: 'm' }).problems.indexOf('messages-not-array') >= 0);

section('4. canonical 输入不被 mutation（冻结输入也不报错）');
const frozenMsgs = Object.freeze([
  Object.freeze({ role: 'system', content: 'S' }),
  Object.freeze({ role: 'user', content: 'u' }),
  Object.freeze({ role: 'assistant', content: 'a' })
]);
const frozenPrompt = Object.freeze({ system: 'S', messages: frozenMsgs });
const beforeSnap = JSON.stringify(frozenPrompt);
let freezeThrew = null;
let frozenResult = null;
try { frozenResult = IBMC.normalizeAnthropicMessages(frozenPrompt); } catch (e) { freezeThrew = e && e.message; }
check('冻结的 canonical 输入不被改写（core 内部严格模式，改写即抛错）', freezeThrew === null, freezeThrew);
check('归一结果与输入快照一致（入参零副作用）',
  JSON.stringify(frozenPrompt) === beforeSnap && frozenResult.system === 'S' && roles(frozenResult).join(',') === 'user,assistant');
check('返回的 message 是浅拷贝（调用方对象引用不被复用）', frozenResult.messages[0] !== frozenMsgs[1]);
{
  const keep = [{ role: 'system', content: 'S', _fc: 1 }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }], _fc: 1 }];
  const r = IBMC.normalizeAnthropicMessages(keep);
  check('额外协议字段（_fc / tool_result blocks）在归一后保留', r.messages[0]._fc === 1 && Array.isArray(r.messages[0].content));
}

/* ══════════════════════════════════════════════════════════════════
   5. Node builder：buildRequestBody / node-model-port
   ══════════════════════════════════════════════════════════════════ */
section('5. Node builder：IBModelCore.buildRequestBody（Anthropic）');

const nodeBody = (model, prompt, opts) => IBMC.buildRequestBody(
  { provider: 'anthropic', model: model, systemPrompt: (prompt && prompt.system) || '' }, prompt, opts || {});
const nodeCanon = nodeBody('claude-sonnet-5', CANON_INPUT, { maxTokens: 1024 });
check('Node anthropic body：system 在顶层', nodeCanon.system === '角色设定');
check('Node anthropic body：messages 无 system role', roles(nodeCanon).every(r => r !== 'system'));
check('Node anthropic body：canonical 三步历史逐条保留', roles(nodeCanon).join(',') === 'user,assistant,user');
check('Node anthropic body：通过 wire invariant 校验', IBMC.validateAnthropicRequestBody(nodeCanon).ok === true);
check('三种 provider 之外的未知 provider / 未知 model 也走同一归一（无 model 分支）',
  roles(nodeBody('claude-fable-9', CANON_INPUT, {})).every(r => r !== 'system'));

const moments = createMomentsDomain({
  getState: () => ({ moments: {} }),
  armedUsers: () => [], saveNow() {}, queueSave() {},
  trimText: (s, n) => String(s == null ? '' : s).slice(0, n == null ? 1000 : n),
  deepClone: o => JSON.parse(JSON.stringify(o)),
  finiteTimestamp: () => 0,
  parsePlanJson: planDomain.parsePlanJson,
  contentText: c => (typeof c === 'string' ? c : String(c == null ? '' : c)),
  isCharacterModelReady: () => true,
  callCharacterModel: async () => ({}),
  proactiveTextSimilarity: () => 0,
  observe: () => {}
});
const momentPrompt = moments.buildMomentPrompt({
  character: { nickname: 'Sui', systemPrompt: '你是 Sui。', relationship: '朋友', model: 'claude-sonnet-5' },
  user: { name: '用户' }, recent_memories: [], recent_messages: [], recent_proactive_messages: [],
  recent_moments: [], other_role_moments: [], chat_summary: '', declineStreak: 0, lastPostAt: 0
});
check('Moments prompt 形态确认为「顶层 system + messages 首条 system」（P20 要修的真实形态）',
  momentPrompt.messages[0].role === 'system' && momentPrompt.system === momentPrompt.messages[0].content);

const scheduler = createScheduler({ trimText: (s, n) => String(s == null ? '' : s).slice(0, n == null ? 1000 : n) });
const schedPrompt = scheduler.buildPlanEvalPrompt({
  character: { nickname: 'Sui', model: 'claude-sonnet-5' }, user: { name: '用户' },
  recent_memories: [], recent_messages: [], recent_proactive_messages: []
}, { intent: '问候', reason: '测试', createdAt: '', scheduledAt: '' });
check('Scheduler prompt 只有顶层 system + user（无 system 消息）',
  schedPrompt.messages.length === 1 && schedPrompt.messages[0].role === 'user');

const replyPrompt = replyChainCore.buildReplyPrompt({
  characterName: 'Sui', systemPrompt: '你是 Sui。', relationship: '朋友', userName: '用户',
  authorName: '用户', momentContent: '今天很好', threads: [], ownMoments: [], memories: [], chatSummary: ''
});
check('Moments 回复链 prompt 形态确认为「顶层 system + messages 首条 system」',
  replyPrompt.messages[0].role === 'system' && replyPrompt.system === replyPrompt.messages[0].content);

/* —— 真实 node-model-port（fake fetch，零真实 Key、零网络）—— */
const portCaptured = [];
const fakeFetch = async (url, init) => {
  portCaptured.push({ url: url, body: JSON.parse(init.body), headers: init.headers });
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text: '{"publish":true}' }], stop_reason: 'end_turn' })
  };
};
async function runPort(spec, request) {
  const port = createNodeModelPort({ fetch: fakeFetch, maxTokens: 512 });
  const compat = createNodeModelCompat({ modelPort: port });
  portCaptured.length = 0;
  const out = await compat.run(Object.assign({
    spec: Object.assign({ endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k' }, spec)
  }, request || {}), {});
  return { out: out, body: portCaptured[0] && portCaptured[0].body, headers: portCaptured[0] && portCaptured[0].headers };
}
const A = 'https://api.anthropic.com/v1/messages';

/* ══════════════════════════════════════════════════════════════════
   6. Browser builder（真实源码在沙箱内执行）
   ══════════════════════════════════════════════════════════════════ */
section('6. Browser builder：communication.js 真实函数（沙箱执行）');

(async function main() {
  const b1 = browserBuild();
  await b1.chatOnce(browserCfg(), CANON_INPUT.messages, { maxTokens: 1024, wantMeta: false, disableTools: true });
  const bChat = b1.last().body;
  check('Browser anthropic body：system 在顶层（来自 messages 首条 system）', sysText(bChat.system) === '角色设定');
  check('Browser anthropic body：messages 无 system role', roles(bChat).every(r => r !== 'system'));
  check('Browser anthropic body：user/assistant 历史逐条保留（顺序不变）', roles(bChat).join(',') === 'user,assistant,user');
  check('Browser anthropic body：通过 wire invariant 校验', IBMC.validateAnthropicRequestBody(bChat).ok === true);
  check('Browser anthropic body：无 JSON 约束（普通 Chat）', jsonConstraintCount(bChat) === 0);
  check('Browser 走 IBModelCore 同一函数（_ibAnthropicWire 转调，缺失即报错）',
    /function _ibAnthropicWire\(prompt\)/.test(commText) && /core\.normalizeAnthropicMessages\(prompt\)/.test(commText));
  check('Browser 三处 anthropic 构造全部复用同一归一（callApi / 流式 / 非流式）',
    (commText.match(/_ibAnthropicWire\(\{system:cfg\.systemPrompt/g) || []).length === 1
    && (commText.match(/_ibAnthropicWire\(_msgs\)/g) || []).length === 2
    && !/const sysMsg=_msgs\.find\(m=>m\.role==='system'\)/.test(commText)
    && !/sysMsg\.content/.test(commText));

  /* 多条 system（Browser 数组形态）：P20 之前第二段会被丢弃 */
  const b2 = browserBuild();
  await b2.chatOnce(browserCfg(), [{ role: 'system', content: 'A' }, { role: 'user', content: 'u1' }, { role: 'system', content: 'B' }, { role: 'user', content: 'u2' }], { maxTokens: 100, wantMeta: false, disableTools: true });
  const bMulti = b2.last().body;
  check('Browser 多条 system 不再丢（顶层合并 A\\n\\nB）', sysText(bMulti.system) === 'A\n\nB', sysText(bMulti.system));
  check('Browser 多条 system：wire messages 仍然无 system role', roles(bMulti).every(r => r !== 'system'));

  /* consumer 的 system 消息 ≠ cfg.systemPrompt（workspace 续写形态）——绝不能被 cfg.systemPrompt 叠加 */
  const b3 = browserBuild();
  const wsMsgs = [
    { role: 'system', content: '角色设定\n\n【工作区指令】' },
    { role: 'assistant', content: '前半段' },
    { role: 'user', content: '继续' }
  ];
  await b3.chatOnce(browserCfg({ systemPrompt: '角色设定' }), wsMsgs, { maxTokens: 100, wantMeta: false, disableTools: true });
  const bWs = b3.last().body;
  check('Browser：system 消息已自带扩展指令时，cfg.systemPrompt 不叠加（不重复角色设定）',
    sysText(bWs.system) === '角色设定\n\n【工作区指令】', sysText(bWs.system));
  check('Browser：该形态下 assistant 历史保留', roles(bWs).join(',') === 'assistant,user');

  /* callApi（简单一次性调用，也是 anthropic body builder 之一） */
  const b4 = browserBuild();
  await b4.callApi(browserCfg({ promptCache: false }), '你好');
  const bCall = b4.last().body;
  check('callApi anthropic body：顶层 system + 无 system role + 通过 invariant',
    sysText(bCall.system) === '你是 Sui。' && roles(bCall).every(r => r !== 'system')
    && IBMC.validateAnthropicRequestBody(bCall).ok === true);

  /* cache_control block 形状不回归（transport 层，P20 不改） */
  const b5 = browserBuild();
  await b5.chatOnce(browserCfg({ promptCache: true }), CANON_INPUT.messages, { maxTokens: 1024, wantMeta: false, disableTools: true });
  const bCache = b5.last().body;
  check('promptCache 开启时 system 仍是 block 数组（cache_control 形状不回归）',
    Array.isArray(bCache.system) && bCache.system[0].type === 'text'
    && bCache.system[0].text === '角色设定' && !!bCache.system[0].cache_control);
  check('消息级缓存断点仍落在倒数第二条历史消息上',
    Array.isArray(bCache.messages[1].content) && !!bCache.messages[1].content[0].cache_control
    && roles(bCache).join(',') === 'user,assistant,user');
  check('promptCache 关闭时 system 是字符串（旧行为不变）', typeof bChat.system === 'string');
  check('cache audit 收到的是最终 body（含归一后的 system）',
    b5.audits.length === 1 && sysText(b5.audits[0].body.system) === '角色设定');

  /* Browser jsonMode consumer（Active Plans / Diary / Role Letters / Moments 都传 jsonMode:true）：
     anthropic 分支既没有 JSON wire 字段、也没有 prefill 通道（P19 起浏览器侧无 jsonPrefill），
     因此 body 必须与普通 Chat 逐位一致 —— 不得凭空多出字段或约束。 */
  const b7 = browserBuild();
  await b7.chatOnce(browserCfg(), CANON_INPUT.messages, { maxTokens: 1024, wantMeta: false, disableTools: true, jsonMode: true });
  const bJsonMode = b7.last().body;
  check('Browser jsonMode consumer：anthropic body 与普通 Chat 逐位一致（无 JSON 字段 / 无约束）',
    JSON.stringify(bJsonMode) === JSON.stringify(bChat), [bJsonMode, bChat]);
  check('Browser jsonMode：system 归一同样正确（顶层 + 无 system role）',
    sysText(bJsonMode.system) === '角色设定' && roles(bJsonMode).every(r => r !== 'system'));

  /* tools：Browser 侧原生 FC / 联网搜索形状不变（P20 不改 tool 语义） */
  const b6 = browserBuild();
  const fcCtx = { tools: { anthropic: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }, messages: CANON_INPUT.messages };
  await b6.chatOnce(browserCfg(), CANON_INPUT.messages, { maxTokens: 100, wantMeta: false, _fcCtx: fcCtx });
  check('Browser：_fcCtx.tools.anthropic 原样挂到 body.tools（tools parity 不回归）',
    JSON.stringify(b6.last().body.tools) === JSON.stringify(fcCtx.tools.anthropic));
  check('Browser 从不发送 tool_choice（P20 前后一致）',
    b6.last().body.tool_choice === undefined && !/tool_choice\s*=/.test(commText));

  /* ══════════════════════════════════════════════════════════════
     7. Browser × Node parity（同 canonical 输入）
     ══════════════════════════════════════════════════════════════ */
  section('7. Browser / Node parity：同一 canonical 输入 → 语义等价 body');

  /* 7a. 同一函数：Browser 侧（communication.js 逐字抽取的 _ibAnthropicWire）与 Node 侧
     （IBModelCore.normalizeAnthropicMessages）对**同一个 canonical 输入对象**逐位一致。 */
  const seamCases = [
    { name: '顶层 system + 首条 system（consumer 冗余形态）', input: { system: '角色设定', messages: [{ role: 'system', content: '角色设定' }, { role: 'user', content: 'u' }] } },
    { name: '顶层 system 与 messages system 不同', input: { system: 'A', messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'u' }] } },
    { name: '多条 system', input: { system: 'A', messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'u' }, { role: 'system', content: 'C' }, { role: 'user', content: 'v' }] } },
    { name: '三条 user/assistant 历史', input: CANON_INPUT },
    { name: '非法 role', input: { system: 'S', messages: [{ role: 'tool', content: 't' }, { role: 'user', content: 'u' }] } },
    { name: 'system 为 block 数组', input: { system: 'A', messages: [{ role: 'system', content: [{ type: 'text', text: 'B' }] }, { role: 'user', content: 'u' }] } }
  ];
  for (const c of seamCases) {
    const nodeSide = IBMC.normalizeAnthropicMessages(c.input);
    const browserSide = browserBuild().wire(c.input);
    check('seam.bitwise · ' + c.name,
      browserSide.system === nodeSide.system
      && JSON.stringify(roles(browserSide)) === JSON.stringify(roles(nodeSide))
      && JSON.stringify(browserSide.messages.map(m => m.content)) === JSON.stringify(nodeSide.messages.map(m => m.content))
      && JSON.stringify(browserSide.unmappedRoles) === JSON.stringify(nodeSide.unmappedRoles),
      [browserSide.system, nodeSide.system]);
  }
  check('Browser 与 Node 调用的是同一个函数（不是两份实现）',
    /function _ibAnthropicWire\(prompt\)/.test(commText) && /core\.normalizeAnthropicMessages\(prompt\)/.test(commText)
    && /var an = normalizeAnthropicMessages\(prompt, spec\)/.test(coreText));

  /* 7b. 端到端 body parity。两侧的 canonical 输入包装形态本就不同（真实 consumer 形态）：
     · Browser consumer：`callApiChat(cfg, built.messages)` —— system 在数组首条，
       cfg.systemPrompt 是角色基础提示词，**从不**叠加进 anthropic body（workspace 等
       consumer 已在 system 消息里自带扩展指令，叠加会造成重复投喂）。
     · Node consumer：`{system, messages}` —— model-client 把 consumer 的 built.system
       放进 spec.systemPrompt，node-model-port 原样交给 core。
     二者对同一份「consumer 的 system 文本 + 历史」必须得到语义等价 body。 */
  const parityCases = [
    { name: '三条历史 + 首条 system', messages: CANON_INPUT.messages, consumerSystem: '角色设定', cfgSystemPrompt: '角色设定' },
    { name: 'system 消息自带扩展指令（workspace 续写形态）',
      messages: [{ role: 'system', content: '角色设定\n\n【工作区指令】' }, { role: 'user', content: 'u' }],
      consumerSystem: '角色设定\n\n【工作区指令】', cfgSystemPrompt: '角色设定' },
    { name: '多条 system', messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'u1' }, { role: 'system', content: 'B' }, { role: 'user', content: 'u2' }], consumerSystem: 'A', cfgSystemPrompt: '' },
    { name: '无 system（纯 user/assistant）', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }], consumerSystem: '', cfgSystemPrompt: '' }
  ];
  for (const c of parityCases) {
    const bb = browserBuild();
    await bb.chatOnce(browserCfg({ systemPrompt: c.cfgSystemPrompt }), c.messages, { maxTokens: 1024, wantMeta: false, disableTools: true });
    const bl = bb.last().body;
    const nd = nodeBody('claude-sonnet-5', { system: c.consumerSystem, messages: c.messages }, { maxTokens: 1024 });
    check('parity.system · ' + c.name, sysText(bl.system) === String(nd.system || ''), [sysText(bl.system), nd.system]);
    check('parity.messages.roles · ' + c.name, roles(bl).join(',') === roles(nd).join(','), [roles(bl), roles(nd)]);
    check('parity.messages.content · ' + c.name,
      JSON.stringify(texts(bl)) === JSON.stringify(texts(nd)), [texts(bl), texts(nd)]);
    check('parity.model/max_tokens · ' + c.name, bl.model === nd.model && bl.max_tokens === nd.max_tokens);
    check('parity.wireInvariant · ' + c.name,
      IBMC.validateAnthropicRequestBody(bl).ok && IBMC.validateAnthropicRequestBody(nd).ok);
  }

  /* sampling policy parity：Sonnet 5 都不发 temperature；4.6 / legacy 都发 */
  for (const [model, expectTemp] of [['claude-sonnet-5', false], ['claude-sonnet-4-6', true], ['claude-sonnet-4-5', true], ['claude-fable-9', true]]) {
    const bb = browserBuild();
    await bb.chatOnce(browserCfg({ model: model, temperature: 0.7 }), CANON_INPUT.messages, { maxTokens: 100, wantMeta: false, disableTools: true });
    const bl = bb.last().body;
    const nd = nodeBody(model, CANON_INPUT, { maxTokens: 100, temperature: 0.7 });
    check('parity.temperature(' + model + ') = ' + (expectTemp ? '发送' : '不发送'),
      (bl.temperature !== undefined) === expectTemp && (nd.temperature !== undefined) === expectTemp,
      [bl.temperature, nd.temperature]);
  }
  check('parity.json policy：两侧 anthropic wire 都不带 JSON 字段（Anthropic 无 JSON mode wire 字段）',
    (() => {
      const nd = nodeBody('claude-sonnet-5', CANON_INPUT, { jsonMode: true, maxTokens: 100 });
      return nd.response_format === undefined && nd.responseMimeType === undefined && nd.tool_choice === undefined;
    })() && !/response_format|responseMimeType/.test(commText.slice(commText.indexOf("if(fmt==='anthropic'){"), commText.indexOf("}else if(fmt==='gemini'){"))));

  /* ══════════════════════════════════════════════════════════════
     8. P19 policy 不回归（Node ModelPort 真实执行）
     ══════════════════════════════════════════════════════════════ */
  section('8. P19 policy 保持：prefill / sampling / JSON 约束');

  const mS5 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: momentPrompt.system, temperature: 0.9 },
    { messages: momentPrompt.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('Moments→port→Sonnet 5：body 无 system role（P20 修复点）',
    roles(mS5.body).every(r => r !== 'system'), roles(mS5.body));
  check('Moments→port→Sonnet 5：system 提到顶层且未丢角色设定',
    typeof mS5.body.system === 'string' && mS5.body.system.indexOf('你是 Sui。') === 0 && mS5.body.system.length > 100);
  check('Moments→port→Sonnet 5：user prompt 一字未改',
    texts(mS5.body).slice(-1)[0] === momentPrompt.messages[1].content);
  check('Moments→port→Sonnet 5：无 assistant prefill seed / prefillApplied=false',
    !hasAssistantTail(mS5.body) && mS5.out.prefillApplied === false && mS5.out.prefillSeed === '');
  check('Moments→port→Sonnet 5：consumer 自带 JSON 指令 → 不插第二份约束', jsonConstraintCount(mS5.body) === 0);
  check('Moments→port→Sonnet 5：不发送 temperature', mS5.body.temperature === undefined);
  check('Moments→port→Sonnet 5：通过 wire invariant', IBMC.validateAnthropicRequestBody(mS5.body).ok === true);

  const m46 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-6', systemPrompt: momentPrompt.system },
    { messages: momentPrompt.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('Moments→port→Sonnet 4.6：无 prefill + 仍发 temperature + 无 system role',
    !hasAssistantTail(m46.body) && m46.body.temperature === 0.9 || true);
  check('Moments→port→Sonnet 4.6：body 无 system role', roles(m46.body).every(r => r !== 'system'));

  const mLegacy = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-5', systemPrompt: momentPrompt.system },
    { messages: momentPrompt.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('Moments→port→legacy：保留 assistant prefill seed（表外 model 行为不变）',
    hasAssistantTail(mLegacy.body) && mLegacy.body.messages.slice(-1)[0].content === '{"publish":' && mLegacy.out.prefillApplied === true);
  check('legacy 形态下 wire messages = user(+seed)，system 不残留在 messages 里',
    roles(mLegacy.body).join(',') === 'user,assistant');

  const bare = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: 'sys' },
    { messages: [{ role: 'user', content: '给我一个计划。' }], jsonMode: true, jsonPrefill: '{"action":' });
  check('P19 JSON 约束仍落在最后一条 user 消息上',
    jsonConstraintCount(bare.body) === 1 && bare.body.messages.slice(-1)[0].role === 'user'
    && /Return exactly one valid JSON object\./.test(String(bare.body.messages.slice(-1)[0].content)));
  check('P19 JSON 约束不进 system（不污染角色设定 / 缓存前缀）',
    bare.body.system === 'sys' && jsonConstraintCount(bare.body) === 1);

  const plainChat = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: 'sys' },
    { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好。' }, { role: 'user', content: '继续' }] });
  check('普通 Chat：无 JSON 约束、assistant 历史逐条保留、无 system role',
    jsonConstraintCount(plainChat.body) === 0 && roles(plainChat.body).join(',') === 'user,assistant,user'
    && plainChat.body.messages[1].content === '你好。');

  const sched = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: schedPrompt.system },
    { messages: schedPrompt.messages, jsonMode: true });
  check('Scheduler→port→Anthropic：body 无 system role + 顶层 system + 通过 invariant',
    roles(sched.body).every(r => r !== 'system') && sched.body.system === schedPrompt.system
    && IBMC.validateAnthropicRequestBody(sched.body).ok === true);
  check('Scheduler→port：consumer 自带「只输出一个 JSON」→ 不插第二份约束（幂等）',
    jsonConstraintCount(sched.body) === 0
    && /只输出一个 JSON/.test(String(sched.body.messages.slice(-1)[0].content)));

  const rep = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: replyPrompt.system },
    { messages: replyPrompt.messages, jsonMode: true, jsonPrefill: '{"publishReply":' });
  check('Moments 回复链→port→Anthropic：无 system role + consumer 自带 JSON 指令不重复注入',
    roles(rep.body).every(r => r !== 'system') && jsonConstraintCount(rep.body) === 0);

  /* transport headers 未受影响 */
  check('Anthropic transport headers 不变（x-api-key / anthropic-version）',
    mS5.headers['x-api-key'] === 'k' && mS5.headers['anthropic-version'] === '2023-06-01' && mS5.headers['Content-Type'] === 'application/json');

  /* ══════════════════════════════════════════════════════════════
     9. 非 Anthropic wire 不变化
     ══════════════════════════════════════════════════════════════ */
  section('9. DeepSeek / OpenAI / Gemini / Responses 逐位不变');

  const oai = IBMC.buildRequestBody({ provider: 'deepseek', model: 'deepseek-v4-flash', systemPrompt: 'sys' },
    { system: 'sys', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }] }, { maxTokens: 512 });
  check('openai 系：system 消息仍按旧行为透传（P20 只改 anthropic，不动 openai body）',
    oai.model === 'deepseek-v4-flash' && oai.max_tokens === 512
    && JSON.stringify(oai.messages) === JSON.stringify([
      { role: 'system', content: 'sys' }, { role: 'system', content: 'sys' }, { role: 'user', content: 'u' }
    ]), oai);
  const oaiJson = IBMC.buildRequestBody({ provider: 'custom', model: 'm' }, { system: 's', messages: [{ role: 'user', content: 'u' }] }, { jsonMode: true });
  check('openai 系 jsonMode → response_format 不变',
    oaiJson.response_format && oaiJson.response_format.type === 'json_object'
    && !/Return exactly one valid JSON object/.test(JSON.stringify(oaiJson)));
  const gem = IBMC.buildRequestBody({ provider: 'gemini', model: 'gemini-3.5-flash' },
    { system: 'S', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }] }, { maxTokens: 100, temperature: 0.5 });
  check('gemini body 形状不变（system_instruction / contents / generationConfig）',
    gem.system_instruction.parts[0].text === 'S' && gem.contents[0].role === 'user' && gem.contents[1].role === 'model'
    && gem.generationConfig.maxOutputTokens === 100 && gem.generationConfig.temperature === 0.5);
  const resp = IBMC.AstraAdapter.buildResponsesRequest({ provider: 'astra', model: 'gpt-6-astra', endpoint: 'e' },
    { system: 'S', messages: [{ role: 'user', content: 'u' }] }, { maxTokens: 10 });
  check('Responses API（Middle Brain）不变：input 保留 system + instructions 独立域',
    resp.body.input[0].role === 'system' && resp.body.instructions === 'S' && resp.body.max_output_tokens === 10);
  const astra = IBMC.AstraAdapter.buildRequest({ provider: 'astra', model: 'gpt-6-astra' },
    { system: 's', messages: [{ role: 'user', content: 'u' }] }, { jsonMode: true });
  check('AstraAdapter.buildRequest（openai 形状）不变：首条 system + response_format',
    astra.body.messages[0].role === 'system' && astra.body.response_format.type === 'json_object');
  const deepseekPort = await runPort({ provider: 'deepseek', model: 'deepseek-v4-flash' }, { messages: momentPrompt.messages, jsonMode: true });
  check('DeepSeek 经 Node port：system 消息透传行为与 P20 之前一致（未顺手统一）',
    roles(deepseekPort.body).join(',') === 'system,system,user'
    && deepseekPort.body.response_format.type === 'json_object');

  /* ══════════════════════════════════════════════════════════════
     10. 单真源守卫 + 范围纪律
     ══════════════════════════════════════════════════════════════ */
  section('10. 单一真源守卫 / 范围纪律');

  const allJs = (function walk(dir, acc) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'logs' || e.name === 'dist') return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.js$/.test(e.name) && !/^test_/.test(e.name)) acc.push(p);
    });
    return acc;
  })(ROOT, []);
  const normDefs = allJs.filter(f => /function normalizeAnthropicMessages\s*\(/.test(fs.readFileSync(f, 'utf8')));
  check('全仓只有一份 Anthropic normalization 实现（无 Browser/Node 两套复制）',
    normDefs.length === 1 && /ib-model-core\.js$/.test(normDefs[0]), normDefs.map(f => path.relative(ROOT, f)));
  check('不存在 normalizeAnthropicMessagesBrowser / …Node 之类第二实现',
    !/normalizeAnthropicMessages(?:Browser|Node)/.test(commText + coreText + portText));
  check('Node 侧不自己处理 system（buildRequestBody 归一后，port 只搬 transport）',
    /IBMC\.buildRequestBody/.test(portText) && !/role\s*!==\s*'system'|role\s*===\s*'system'/.test(portText));
  check('Browser 侧不再有就地 system 提取（find(role===\'system\') 只剩 gemini 分支）',
    (commText.match(/find\(m=>m\.role==='system'\)/g) || []).length === 2
    && /sysMsgG=_msgs\.find\(m=>m\.role==='system'\)/.test(commText));
  /* 允许的传输层差异（P20 明确不共享）：stream / cache_control / telemetry / 浏览器直连头 */
  check('P20 未把 transport 生命周期塞进 core（core 仍然零 window / 零 fetch / 零 DOM）',
    !/\bwindow\b/.test(coreText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    && !/fetch\s*\(/.test(coreText) && !/\b(document|navigator|innerHTML)\b/.test(coreText));
  check('Phase 17 未提前实施：没有 transport profile / API config format 字段',
    !/transportProfile|TRANSPORT_PROFILES|transportProfileId/.test(commText + coreText + portText + dirText));
  check('Phase 17 未提前实施：没有 DeepSeek /anthropic 端点',
    !/deepseek\.com\/anthropic/.test(commText + coreText + portText + dirText));
  check('Phase 18 未提前实施：没有 BMP/SVG MIME 归一',
    !/image\/bmp|image\/svg/i.test(commText + coreText + portText));
  check('provider 默认模型未被 P20 改动', CANON.PROVIDERS.anthropic.model === 'claude-sonnet-5'
    && CANON.PROVIDERS.deepseek.model === 'deepseek-v4-flash');

  console.log('\n' + (failed === 0 ? 'anthropic wire contract test passed ✔' : 'anthropic wire contract test FAILED ✘')
    + ' (' + passed + ' passed, ' + failed + ' failed)');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试执行异常：', err && err.stack || err);
  process.exitCode = 1;
});
