'use strict';

/* Internal Beyond · P23 Phase 2C · Delivery Planner 测试
   （static 组：零依赖、零网络、零浏览器、零真实 sleep）
   运行：node tests/test_delivery_planner.js

   Phase 2C 的唯一职责：把"一个完整 assistant turn 的文本"切成 delivery unit（**内容结构**），
   不产生任何时间。因此本测试全部是**纯函数**断言 + 跨阶段兼容断言：

     A 空回复 · B 单句 · C 多句 · D 段落 · E 长回复 · F markdown · G 代码块 · H 列表
     I 引用 · J 链接 · K emoji · L legacy 单条 · M 同输入同输出 · N 无随机 · O 无网络
     P 无 DOM · Q secret 探针 · R sequence contract 兼容 · S delivery runtime 兼容
     T voice 占位符保持完整 · U image 占位符保持完整

   另含：persona/style hint（唯一 extension point）、Middle Brain hint 的 inert 性、
   策略常量与无损不变量、以及"唯一实现"守卫（communication.js 里不再留第二份拆句规则）。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Planner = require(path.join(ROOT, 'assets', 'js', 'delivery-planner.js'));
const SeqCore = require(path.join(ROOT, 'assets', 'js', 'delivery-sequence-core.js'));
const RT = require(path.join(ROOT, 'assets', 'js', 'delivery-runtime.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
/* 每一段都被实测过的那份"策略不变量"：无损 + 每段都非空 + 顺序不变。 */
function checkPlan(name, text, opts, expect) {
  const plan = Planner.planTurn(text, opts);
  const e = expect || {};
  ok(name + '.mode', plan.mode === (e.mode || plan.mode), plan.mode);
  if (e.mode) ok(name + '.modeIs' + e.mode, plan.mode === e.mode, plan.mode);
  if (e.count != null) ok(name + '.count', plan.stats.unitCount === e.count, plan.stats.unitCount);
  if (e.minCount != null) ok(name + '.minCount', plan.stats.unitCount >= e.minCount, plan.stats.unitCount);
  if (e.maxCount != null) ok(name + '.maxCount', plan.stats.unitCount <= e.maxCount, plan.stats.unitCount);
  ok(name + '.losslessModuloWhitespace', norm(plan.segments.join('')) === norm(String(text == null ? '' : text)), JSON.stringify(plan.segments));
  ok(name + '.unitsMatchSegments', plan.units.every((u, i) => u.kind === 'text' && u.content === plan.segments[i]), JSON.stringify(plan.units));
  ok(name + '.noTimeFields', plan.units.every(u => !('delay' in u) && !('sendAt' in u) && !('delayBefore' in u)), JSON.stringify(plan.units));
  ok(name + '.policyExposed', !!plan.policy && plan.policy.version >= 1 && plan.policy.minUnitChars > 0 && plan.policy.maxUnitChars >= plan.policy.minUnitChars);
  if (plan.mode === 'sequence') {
    ok(name + '.allUnitsNonEmpty', plan.segments.every(s => String(s).trim().length > 0));
    ok(name + '.allUnitsWithinCap', plan.segments.every(s => s.length <= plan.policy.maxUnitChars), JSON.stringify(plan.segments.map(s => s.length)));
  }
  return plan;
}

const EX1 = '比如一等开学了，你打算怎么跟你室友介绍我？还是藏起来当秘密，还是大大方方说有个AI男朋友天天陪着你？我挺好奇这个。';

/* ── A–E · 基本切分 ─────────────────────────────────────────────────── */
function basics() {
  /* A · 空回复 */
  {
    const p = checkPlan('A.empty', '', null, { mode: 'single', count: 1 });
    ok('A.empty.noUnits', p.units.length === 0 && p.stats.reason === 'empty');
    ok('A.empty.whitespaceOnly', Planner.planTurn('   \n  ').mode === 'single' && Planner.planTurn('   \n  ').units.length === 0);
    ok('A.empty.segmentIsNull', Planner.segment('') === null && Planner.segment(null) === null && Planner.segment(undefined) === null);
  }
  /* B · 单句 */
  {
    const p = checkPlan('B.single', '就一句。', null, { mode: 'single', count: 1 });
    ok('B.single.reason', p.stats.reason === 'not-multiple');
    ok('B.single.segmentIsNull', Planner.segment('就一句。') === null);
    ok('B.single.contentPreserved', p.segments[0] === '就一句。');
  }
  /* C · 多句 */
  {
    const p = checkPlan('C.multi', '今天天气真好啊。阳光很暖。适合出去走走。', null, { mode: 'sequence', count: 3 });
    ok('C.multi.order', p.segments.join('|') === '今天天气真好啊。|阳光很暖。|适合出去走走。', JSON.stringify(p.segments));
    ok('C.multi.segmentMatches', Planner.segment('今天天气真好啊。阳光很暖。适合出去走走。').length === 3);
  }
  /* D · 段落（空行是最高优先级边界） */
  {
    const t = '第一段第一句。第一段第二句。\n\n第二段只有一句。';
    const p = checkPlan('D.paragraph', t, null, { mode: 'sequence', minCount: 3 });
    ok('D.paragraph.paragraphBoundaryKept', p.segments.some(s => s.indexOf('第一段第二句') >= 0) && p.segments.some(s => s.indexOf('第二段只有一句') >= 0));
  }
  /* E · 长回复（无逗号长段 → 硬上界生效，且段数有界） */
  {
    const long = '甲'.repeat(400);
    const p = checkPlan('E.long', long, null, { mode: 'sequence' });
    ok('E.long.hardCapped', p.stats.hardCapped >= 1 && p.segments.every(s => s.length <= p.policy.maxUnitChars), JSON.stringify({ capped: p.stats.hardCapped, lens: p.segments.map(s => s.length) }));
    ok('E.long.underMaxUnits', p.stats.unitCount <= p.policy.maxUnits);
    const many = Array.from({ length: 80 }, (_, i) => '第' + i + '句。').join('');
    const pm = checkPlan('E.long.manySentences', many, null, { mode: 'sequence' });
    /* 段数上限（30）在**长度上界**之下让位：宁可多两条，也不要 255 字的气泡。
       硬上限仍是 MAX_UNITS(60)，且每一条都在 maxUnitChars 之内。 */
    ok('E.long.overflowMerged', pm.stats.overflowMerged >= 1, JSON.stringify(pm.stats));
    ok('E.long.overflowBounded', pm.stats.unitCount <= Planner.POLICY.MAX_UNITS
      && pm.stats.overflowForced === 0
      && pm.segments.every(s => s.length <= pm.policy.maxUnitChars),
      JSON.stringify({ n: pm.stats.unitCount, lens: pm.segments.map(s => s.length) }));
    ok('E.long.overflowCountSane', pm.stats.unitCount >= 29 && pm.stats.unitCount <= 36, pm.stats.unitCount);
  }
  /* 已冻结的既有行为（浏览器端到端测试同样钉住这些） */
  {
    const ex1 = checkPlan('CASE.example1', EX1, null, { mode: 'sequence', count: 3 });
    ok('CASE.example1.order', ex1.segments[0].indexOf('怎么跟你室友介绍我') >= 0
      && ex1.segments[1].indexOf('还是藏起来当秘密') >= 0
      && ex1.segments[2].indexOf('我挺好奇这个') >= 0, JSON.stringify(ex1.segments));
    const d = Planner.planTurn('嗯哼？然后呢？真的假的？不是吧。');
    ok('CASE.shortUtterancesStillSplit', d.mode === 'sequence' && d.stats.unitCount > 1, JSON.stringify(d.segments));
    const six = Planner.planTurn('第一句。第二句。第三句。第四句。第五句。第六句。');
    ok('CASE.sixSentencesSixUnits', six.stats.unitCount === 6 && six.segments.every(s => s.length <= 96), JSON.stringify(six.segments));
    const two = Planner.planTurn('你。好。');
    ok('CASE.tinyUnitsMerged', two.mode === 'single' && two.segments.length === 1
      && norm(two.segments[0]) === norm('你。好。'), JSON.stringify(two.segments));
  }
}

/* ── F–K · 结构保护（markdown / 代码 / 列表 / 引用 / 链接 / emoji）─────── */
function structures() {
  /* F · markdown：强调符号不改变句读边界；加粗句子仍按句读切 */
  {
    const t = '**你好。**今天怎么样？';
    const p = checkPlan('F.markdown', t, null, { mode: 'sequence' });
    ok('F.markdown.markersIntact', p.segments.every(s => (s.match(/\*\*/g) || []).length % 2 === 0), JSON.stringify(p.segments));
  }
  /* G · 代码块：整块一条，内部绝不切碎 */
  {
    const t = '来看这段：\n```js\nconst a = 1;\nconst b = "x。y！z";\n```\n就这些。';
    const p = checkPlan('G.codeblock', t, null, { mode: 'sequence' });
    const fenceIdx = p.segments.map((s, i) => (s.indexOf('```') >= 0 ? i : -1)).filter(i => i >= 0);
    ok('G.codeblock.oneUnitHoldsFence', fenceIdx.length === 1, JSON.stringify(p.segments));
    ok('G.codeblock.fenceNotSplit', p.segments.filter(s => s.indexOf('```') >= 0).every(s => (s.match(/```/g) || []).length >= 2), JSON.stringify(p.segments));
    ok('G.codeblock.innerPunctuationKept', p.segments.join('').indexOf('const a = 1;') >= 0);
    const only = Planner.planTurn('```js\nconst a=1;\n```');
    ok('G.codeblock.aloneIsSingle', only.mode === 'single');
  }
  /* H · 列表：整块保持（不按行/标点拆碎） */
  {
    const t = '这些是重点：\n- 第一项，很重要\n- 第二项，也很重要\n然后呢？';
    /* 列表是"保持整体"的对象：两个条目**必须**在同一条消息里（拆开会让 markdown 列表
       在两条气泡里各自失效）；至于整条回复是一条还是两条，取决于句读，不做断言。 */
    const p = checkPlan('H.list', t, null, {});
    const listUnit = p.segments.filter(s => s.indexOf('- 第一项') >= 0);
    ok('H.list.itemsStayTogether', listUnit.length === 1 && listUnit[0].indexOf('- 第二项') >= 0, JSON.stringify(p.segments));
    const longer = '这些是重点。\n- 第一项，很重要\n- 第二项，也很重要\n记住了吗？';
    const pl = checkPlan('H.list.longer', longer, null, { mode: 'sequence' });
    const oneListUnit = pl.segments.filter(s => s.indexOf('- 第一项') >= 0);
    ok('H.list.stillOneUnitInsideSequence', oneListUnit.length === 1 && oneListUnit[0].indexOf('- 第二项') >= 0, JSON.stringify(pl.segments));
  }
  /* I · 引用：引用块整体保留 */
  {
    const t = '他写道：「晚安。早点睡。」你看。';
    const p = checkPlan('I.quote', t, null, { mode: 'sequence' });
    const q = p.segments.filter(s => s.indexOf('「') >= 0);
    ok('I.quote.pairedIntact', q.length >= 1 && q.every(s => s.indexOf('「') >= 0 && s.indexOf('」') >= 0), JSON.stringify(p.segments));
  }
  /* J · 链接：URL 与 markdown 链接绝不被拆开 */
  {
    const t = '看这个 https://example.com/a?b=1&c=2 很有意思。另外 [点这里](https://example.com/d) 也行。';
    const p = checkPlan('J.link', t, null, { mode: 'sequence' });
    const urls = p.segments.filter(s => s.indexOf('https://example.com/a') >= 0);
    ok('J.link.urlIntact', urls.length === 1 && urls[0].indexOf('https://example.com/a?b=1&c=2') >= 0, JSON.stringify(p.segments));
    const md = p.segments.filter(s => s.indexOf('[点这里]') >= 0);
    ok('J.link.markdownIntact', md.length === 1 && md[0].indexOf('](https://example.com/d)') >= 0, JSON.stringify(p.segments));
  }
  /* K · emoji / sticker：保持整体；单独 emoji 不与文本粘连成碎段 */
  {
    const t = '开心。😀。今天真好。';
    const p = checkPlan('K.emoji', t, null, { mode: 'sequence' });
    ok('K.emoji.present', p.segments.join('').indexOf('😀') >= 0);
    ok('K.emoji.noUnitWithoutContent', p.segments.every(s => norm(s).length > 0));
    const st = '你回来啦？[sticker:happy] 我好想你。';
    const ps = checkPlan('K.sticker', st, null, { mode: 'sequence' });
    const holders = ps.segments.filter(s => s.indexOf('[sticker:happy]') >= 0);
    ok('K.sticker.tokenIntact', holders.length === 1 && holders[0].indexOf('[sticker:happy]') >= 0, JSON.stringify(ps.segments));
    ok('K.sticker.neverSplitAcrossUnits', ps.segments.filter(s => s.indexOf('[sticker:') >= 0).length === 1, JSON.stringify(ps.segments));
  }
}

/* ── L/N/O/P/Q · legacy、纯净性与安全 ───────────────────────────────── */
function purity() {
  /* L · legacy：普通短回复仍然一条消息（single-unit fast path） */
  {
    for (const t of ['hello', '在吗', '好的，我知道了。', '嗯。']) {
      const p = Planner.planTurn(t);
      ok('L.legacy.single.' + t.slice(0, 6), p.mode === 'single' && p.units.length <= 1, JSON.stringify({ mode: p.mode, n: p.stats.unitCount }));
    }
    /* 功能标签：整条一条（工作区/日历/记忆/思考/撤回/blog_read） */
    for (const t of ['<ws_create path="a.txt">x</ws_create>继续', '<cal_note>明天 9 点</cal_note>记住了。', '<mem_save>喜欢咖啡</mem_save>好。', '<blog_read name="标题"/>读一下。', '我改口：<withdraw/>抱歉。']) {
      const p = Planner.planTurn(t);
      ok('L.functional.single.' + t.slice(1, 8), p.mode === 'single' && p.stats.functionalTags === true && p.segments.length === 1, JSON.stringify({ mode: p.mode, tags: p.stats.functionalTags }));
    }
  }
  /* M · deterministic（同输入同输出，逐字节） */
  {
    const a = JSON.stringify(Planner.planTurn(EX1));
    const b = JSON.stringify(Planner.planTurn(EX1));
    ok('M.deterministic.identical', a === b);
    const runs = new Set();
    for (let i = 0; i < 50; i++) runs.add(JSON.stringify(Planner.planTurn('一。二。三。四。').segments));
    ok('M.deterministic.stableAcross50Runs', runs.size === 1, runs.size);
  }
  /* N · 无随机（源码级） */
  {
    const src = stripComments(read('assets/js/delivery-planner.js'));
    ok('N.noRandom', !/Math\.random/.test(src));
    ok('N.noClock', !/Date\.now|performance\.now/.test(src));
    ok('N.noTimer', !/setTimeout|setInterval|requestAnimationFrame/.test(src));
  }
  /* O · 无网络 */
  {
    const src = stripComments(read('assets/js/delivery-planner.js'));
    ok('O.noNetwork', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/.test(src));
    ok('O.noProvider', !/provider|endpoint|apiKey|Authorization/i.test(src));
  }
  /* P · 无 DOM */
  {
    const src = stripComments(read('assets/js/delivery-planner.js'));
    ok('P.noDom', !/\bdocument\b|\bwindow\b|\bElement\b|\bHTMLElement\b|innerHTML|querySelector/.test(src));
    ok('P.noStorage', !/\blocalStorage\b|\bIndexedDB\b|\bindexedDB\b|\bdbPut\b/.test(src));
  }
  /* Q · secret 探针：planner 不保存任何内容，也不引入凭据面 */
  {
    const src = stripComments(read('assets/js/delivery-planner.js'));
    ok('Q.noSecretApi', !/\bsk-[A-Za-z0-9_\-]{8,}|Bearer\s|client_secret|access_token/.test(src));
    const t = '这是正文。sk-this-is-a-secret-shaped-token-0001';
    const p = Planner.planTurn(t);
    /* planner 是纯函数：正文原样参与切分；凭据边界由 Phase 2A 的 sequence 契约在落库前拦住。 */
    ok('Q.secret.stillPureText', p.mode === 'sequence' && norm(p.segments.join('')) === norm(t));
    const blocked = SeqCore.buildMessages(
      Object.assign({ turnId: SeqCore.turnIdFor('x') }, Planner.toSequenceInput(p)),
      { friendId: 'f', timestamp: 1700000000000 });
    ok('Q.secret.rejectedDownstream', blocked.length === 0, blocked.length);
    ok('Q.summaryHasNoContent', (() => {
      const s = Planner.summaryOf(p);
      return !!s && JSON.stringify(s).indexOf('正文') < 0 && JSON.stringify(s).indexOf('sk-') < 0;
    })());
  }
}

/* ── R · Sequence Contract（Phase 2A）兼容 ──────────────────────────── */
function sequenceCompatibility() {
  const plan = Planner.planTurn(EX1);
  const turn = SeqCore.turnIdFor('msg_1700000000100_u');
  const msgs = SeqCore.buildMessages(Object.assign({ turnId: turn }, Planner.toSequenceInput(plan)),
    { friendId: 'friend_1', timestamp: 1700000000100, model: 'p', configId: 'friend_1' });
  ok('R.contract.oneMessagePerUnit', msgs.length === plan.units.length && msgs.length === 3, msgs.length);
  ok('R.contract.contentIsAuthority', msgs.map(m => m.content).join('') === plan.segments.join(''));
  ok('R.contract.turnIdentity', msgs.every(m => m.metadata.turnId === turn) && msgs.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2');
  ok('R.contract.canonicalShape', msgs.every(m => ChatCore.validateMessage(m).ok));
  ok('R.contract.idsOrderable', msgs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(m => m.metadata.sequenceIndex).join(',') === '0,1,2');
  ok('R.contract.unitShapeHasNoTime', plan.units.every(u => Object.keys(u).sort().join(',') === 'content,kind'), JSON.stringify(plan.units.map(u => Object.keys(u))));
  ok('R.contract.voiceImagePassthrough', (() => {
    /* schema 必须允许未来 voice/image 单元原样流过这个转换点（本阶段不产出它们）。 */
    const fake = Planner.toSequenceInput({ units: [{ kind: 'voice', content: '语音文字稿' }, { kind: 'image', content: '' }] });
    return fake.units[0].kind === 'voice' && fake.units[0].text === '语音文字稿' && fake.units[1].kind === 'image';
  })());
  ok('R.contract.emitsTextOnlyToday', Planner.EMITTED_KINDS.length === 1 && Planner.EMITTED_KINDS[0] === 'text'
    && plan.units.every(u => u.kind === 'text'));
  const full = Planner.planTurn('一。二。三。四。五。');
  const fmsgs = SeqCore.buildMessages(Object.assign({ turnId: SeqCore.turnIdFor('y') }, Planner.toSequenceInput(full)),
    { friendId: 'f', timestamp: 1700000000000 });
  ok('R.contract.allUnitsDeliverable', fmsgs.length === full.units.length && fmsgs.every(m => m.voice === undefined));
}

/* ── S · Delivery Runtime（Phase 2B）兼容 ───────────────────────────── */
function runtimeCompatibility() {
  function fakeClock() {
    let now = 0, seq = 0, timers = [];
    return {
      now: () => now,
      setTimeout: (fn, ms) => { const h = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn }; timers.push(h); return h; },
      clearTimeout: h => { timers = timers.filter(t => t !== h); },
      advance: ms => {
        const target = now + Math.max(0, Number(ms) || 0);
        for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > target) break; timers.shift(); now = t.at; t.fn(); }
        now = target;
      }
    };
  }
  const plan = Planner.planTurn(EX1);
  const turn = SeqCore.turnIdFor('msg_1700000000200_u');
  const msgs = SeqCore.buildMessages(Object.assign({ turnId: turn }, Planner.toSequenceInput(plan)),
    { friendId: 'friend_1', timestamp: 1700000000200, model: 'p', configId: 'friend_1' });
  const clock = fakeClock();
  const delivered = [];
  const rt = RT.createDeliveryRuntime({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const handle = rt.enqueue({
    turnId: turn, conversationId: 'dm:friend_1',
    units: msgs.map(m => ({ kind: 'text', content: m.content, message: m })),
    onUnit: (u, i) => { delivered.push({ i: i, content: u.message.content }); return { ok: true }; }
  });
  ok('S.runtime.enqueueAccepted', !!handle);
  clock.advance(120000);
  ok('S.runtime.deliveredInPlanOrder', delivered.map(d => d.content).join('|') === plan.segments.join('|'),
    JSON.stringify(delivered.map(d => d.i)));
  ok('S.runtime.allUnitsDelivered', delivered.length === msgs.length);
  ok('S.runtime.releasedAfterCompletion', rt.stateOf('dm:friend_1') === 'idle' && rt.activeCount() === 0);
  ok('S.runtime.traceHasNoContent', JSON.stringify(rt.trace(20)).indexOf(plan.segments[0].slice(0, 8)) < 0);
  /* single plan：单条不产生等待、不产生 typing（fast path 与 2B 一致） */
  const clock2 = fakeClock();
  const rt2 = RT.createDeliveryRuntime({ now: clock2.now, setTimeout: clock2.setTimeout, clearTimeout: clock2.clearTimeout });
  const one = SeqCore.buildMessages(Object.assign({ turnId: SeqCore.turnIdFor('z') }, Planner.toSequenceInput(Planner.planTurn('就一句。'))),
    { friendId: 'friend_1', timestamp: 1700000000000 });
  const typLog = [];
  rt2.enqueue({
    turnId: SeqCore.turnIdFor('z'), conversationId: 'dm:friend_1',
    units: one.map(m => ({ kind: 'text', content: m.content, message: m })),
    onUnit: () => true, onTyping: on => typLog.push(on)
  });
  ok('S.runtime.singlePlanNoWaitNoTyping', typLog.length === 0 && clock2.now() === 0);
}

/* ── T/U · 占位符保持完整（voice / image）──────────────────────────────
   审计事实（先说清楚，不发明语法）：
     · IB 目前**没有** AI 文本内的 voice 占位符语法 —— voice 是 Phase 1 的独立消息能力，
       由 delivery 层决定（TTS 或原生语音消息），不靠文本 token。
     · image 的既有形态有三类：markdown 图片 `![alt](url)`（atomic）、
       `[sticker:<name>]` 表情 token（atomic）、`<ws_gen_image .../>` 功能标签（整条不拆）。
   因此 T/U 断言的是**通用规则**：任何成对括号形状的占位符整体保留、绝不跨 unit 拆开；
   将来若真的引入新占位符（例如 voice/image token），它自带同样的形状保证。 */
function placeholders() {
  const cases = [
    ['T.voiceShape', '先听这个。[voice:v1|今晚早点睡] 好梦。', '[voice:v1|今晚早点睡]'],
    ['T.voiceShapeDouble', '[[voice:2]] 你听到了吗？我在呢。', '[[voice:2]]'],
    ['U.imageShape', '看这个 [[image:7]] 喜欢吗？我拍的。', '[[image:7]]'],
    ['U.markdownImage', '![照片](https://example.com/a.png) 好看吧？嗯。', '![照片](https://example.com/a.png)'],
    ['K.stickerShape', '[sticker:wave] 早上好呀？醒了没。', '[sticker:wave]']
  ];
  for (const item of cases) {
    const name = item[0], text = item[1], token = item[2];
    const p = Planner.planTurn(text);
    const holders = p.segments.filter(s => s.indexOf(token) >= 0);
    ok(name + '.tokenIntact', holders.length === 1 && holders[0].indexOf(token) >= 0, JSON.stringify(p.segments));
    ok(name + '.neverSplitAcrossUnits', p.segments.filter(s => s.indexOf(token.slice(0, 3)) >= 0).length === 1, JSON.stringify(p.segments));
    ok(name + '.lossless', norm(p.segments.join('')) === norm(text));
  }
  const gen = Planner.planTurn('<ws_gen_image prompt="一只猫，在窗边" size="1024x1024"/> 画好了。');
  ok('U.genImageTag.singleUnit', gen.mode === 'single' && gen.stats.functionalTags === true && gen.segments.length === 1,
    JSON.stringify({ mode: gen.mode, tags: gen.stats.functionalTags }));
  ok('T.voice.notProducedByPlanner', Planner.planTurn('随便一句。再来一句。').units.every(u => u.kind === 'text'));
}

/* ── HINT · persona / Middle Brain extension point（§7 / §12）────────── */
function hints() {
  const t = '甲'.repeat(140) + '。';
  const def = Planner.planTurn(t);
  const shortPlan = Planner.planTurn(t, { hints: { style: 'short' } });
  const longPlan = Planner.planTurn(t, { hints: { style: 'long' } });
  ok('HINT.default.cap', def.policy.maxUnitChars === Planner.POLICY.MAX_UNIT_CHARS);
  ok('HINT.short.lowerCap', shortPlan.policy.maxUnitChars === Planner.POLICY.STYLE_MAX_CHARS.short
    && shortPlan.policy.maxUnitChars < def.policy.maxUnitChars);
  ok('HINT.long.higherCap', longPlan.policy.maxUnitChars === Planner.POLICY.STYLE_MAX_CHARS.long
    && longPlan.policy.maxUnitChars > def.policy.maxUnitChars);
  ok('HINT.long.keepsLongUnitWhole', longPlan.segments.length === 1 && longPlan.segments[0] === t,
    JSON.stringify(longPlan.segments.map(s => s.length)));
  ok('HINT.noContentRewrite', norm(shortPlan.segments.join('')) === norm(t) && norm(longPlan.segments.join('')) === norm(t));
  ok('HINT.sentenceBoundariesUnchanged', (function () {
    const s = '你好。今天怎么样？我很好。';
    const a = Planner.planTurn(s).segments.join('|');
    const b = Planner.planTurn(s, { hints: { style: 'short' } }).segments.join('|');
    const c = Planner.planTurn(s, { hints: { style: 'long' } }).segments.join('|');
    return a === b && a === c;
  })());
  const base = Planner.planTurn(EX1);
  const hinted = Planner.planTurn(EX1, { hints: { preferVoice: true } });
  ok('HINT.preferVoice.accepted', hinted.hints.preferVoice === true && hinted.policy.preferVoice === true);
  ok('HINT.preferVoice.inert', JSON.stringify(base.units) === JSON.stringify(hinted.units));
  ok('HINT.unknownInert', JSON.stringify(Planner.planTurn(EX1, { hints: { style: 'weird', nope: 1 } }).units) === JSON.stringify(base.units));
  ok('HINT.garbageSafe', Planner.planTurn(EX1, { hints: 42 }).mode === base.mode && Planner.planTurn(EX1, null).mode === base.mode);
  ok('HINT.singleEntryPoint', (function () {
    const src = read('assets/js/delivery-planner.js');
    return /function normalizeHints\(/.test(src) && !/middleBrain|middle_brain|IB\.middleBrain/.test(src);
  })());
}

/* ── 唯一实现守卫 + 生产接线（MessagePresentation 现在只是呈现层）──── */
function wiring() {
  const comm = read('assets/js/communication.js');
  const commCode = stripComments(comm);
  ok('WIRE.noSecondSplitter', !/function _tokenize\(|function _beatsFromTokens\(|function _segmentProse\(|function _utterances\(|function _splitLong\(|function _antiFrag\(/.test(commCode));
  ok('WIRE.noSecondConnectorTable', !/SPLIT_CONNECTOR_RE|FILLER_RE|RECURSIVE_PAIRS|ATOMIC_PAIRS/.test(commCode));
  ok('WIRE.messagePresentationDelegates', /return P\.segment\(text, opts \|\| \{\}\)/.test(comm)
    && /function planner\(\)/.test(comm));
  ok('WIRE.deliveryPlanExposed', /function deliveryPlan\(reply, opts\)/.test(comm) && /deliveryPlan: deliveryPlan/.test(comm));
  ok('WIRE.delayBetweenKept', /function delayBetween\(len\)/.test(comm) && /if \(len <= 10\) return 320;/.test(comm));
  ok('WIRE.planModesKept', /mode: 'stream'/.test(comm) && /mode: 'single'/.test(comm) && /mode: 'multi'/.test(comm));
  ok('WIRE.plannerPlaneNoRuntime', !/IBDeliveryRuntime|_ibStartDelivery|queue|cancel/i.test(stripComments(read('assets/js/delivery-planner.js')).replace(/\/\/[^\n]*/g, '')));
  ok('WIRE.htmlOrder', (function () {
    const html = read('InternalBeyond.html');
    const core = html.indexOf('assets/js/delivery-sequence-core.js');
    const rt = html.indexOf('assets/js/delivery-runtime.js');
    const pl = html.indexOf('assets/js/delivery-planner.js');
    const ca = html.indexOf('assets/js/chat-authority.js');
    return core > 0 && rt > core && pl > rt && ca > pl;
  })());
  ok('WIRE.plannerPureModule', !/\bwindow\b/.test(stripComments(read('assets/js/delivery-planner.js'))));
}

async function main() {
  console.log('== Internal Beyond · P23 Phase 2C · Delivery Planner 测试 ==');
  basics();
  structures();
  purity();
  sequenceCompatibility();
  runtimeCompatibility();
  placeholders();
  hints();
  wiring();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
