'use strict';
/* ====================================================================
   IB Home Node · R4-F BehaviorEffect v1（P21-R4-F / P21-R4-F.1）
   --------------------------------------------------------------------
   L7 的**确定性**派生层：把一次已验证的 L3 解释（且该回合 L5 期望必须已经
   成立）投影成一个**有界、闭合、turn-local** 的行为基调，并把它交给
   **下一个**合格对话回合的主聊天。

   ── 它为什么不需要模型（§5 冻结）──────────────────────────────────
   `CONTRACT.md:875`：「BehaviorEffect | 需要模型吗 = **否** —— 必须从
   interpretation **确定性投影** | **deterministic derived**」。
   因此 `BEHAVIOR_EFFECT_EXECUTION_KIND = DETERMINISTIC_RULES`、
   `MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN = 0`、
   **没有第三个成本位**：没有模型调用可供授权，本模块不 require modelPort、
   不读 credential、不发 provider request。

   ── 免费文本通道是**结构性地不存在**（§8 冻结）────────────────────
   效果对象**只有** 7 个键（§冻结 v1 schema）：
     stance · strategy · initiativeTendency · rationaleCode ·
     sourceTurn · derivedFrom:'L3_AND_L5' · ttlTurns:1
   `validateEffect` 是**闭集键白名单**：任何白名单之外的键 ⇒ 不是效果。
   这不是"禁止写 promptText"，而是**没有这个键可写**。渲染出的一句话来自
   本文件里的**固定表**，绝不插入 L3/L5 的原文。

   ── 权威链（§5）──────────────────────────────────────────────────
   `BEHAVIOR_EFFECT_INPUT_AUTHORITY = VALIDATED_L3_AND_L5`
   `MAY_BEHAVIOR_EFFECT_BYPASS_INTERPRETATION_EXPECTATION = NO`
   `R4_F_LIVE_MEDIATOR_REQUIREMENT = L3_AND_L5`（`CONTRACT.md:2534-2539`）：
     · 只有 Recall ⇒ 没有已验证 L3 ⇒ `l3-not-validated`（不产生效果）
     · 只有 L3   ⇒ 该回合没有成立的 L5 ⇒ `expectation-absent`（不产生效果）
     · 只有 L5   ⇒ 运行时不可能出现（L5 只在 L3 成功后才被调度）
     · 浏览器伪造 ⇒ 死在请求闭集（RECALL 请求体不含 `interpretation` /
       `behaviorEffect` 之类的键），本模块没有路由。
   派生输入不只看两个布尔：`interpretationResult` 必须**结构上**是一次已验证
   的 L3 **服务端结果**（`ok:true` + `status:'succeeded'` + `recordSource` +
   结构合规的 shadow，每个 item 带非空 memoryId 且 appraisal 命中 R4-C 纯核心
   的闭集），`expectation` 必须**结构上**是一次 `status:'created'` 的 L5 结果。
   失败一律**无效果**，主聊天照常继续；**绝不**回落到浏览器提示。

   ── 时机/生命周期（§10/§11/§13）──────────────────────────────────
   `BEHAVIOR_EFFECT_APPLIES_TO = NEXT_ELIGIBLE_TURN` · 一次性 ·
   **下一个合格主聊天回合消费一次即删除** · 持有者 64 条 / 600 000 ms /
   `characterId+conversationId+turnId`（source turn 作为键的一部分） ·
   只在进程内 · 没有路由 · 不落盘。
   `SOURCE_TURN_RETROACTIVE_EFFECT = NO`：源回合**取不到自己的效果**
   （消费时按 `sourceTurn === 当前 turnId` 显式跳过）。
   消费必须是**同角色 + 同会话**的待取效果 —— 别的角色 / 别的会话
   （§16 隔离）在结构上取不到。
   ★ 诚实边界：重放保护**受持有者淘汰限制**（`CROSS_EVICTION_EXACTLY_ONCE
     = NO`，与 LIVE-5 实测的同一个界限）—— 被淘汰的旧回合可以再次产生效果；
     本相位**不加**任何持久账本，`replayBound = EVICTION_BOUNDED_NO_LEDGER`。

   ── NO_SIGNAL 是一等结果（§8）────────────────────────────────────
   中性 / 无信号 ⇒ **合法的中性结构化效果**（`neutral|answer_directly|normal`
   + `rationaleCode:'no-signal'`），**不是** null + fallback，也不是任意自然
   语言解释。固定渲染器对它给出 `NO_PLACEMENT`（结构上是一等结果，但**不**
   往 prompt 里塞一句话）。"每个 L3+L5 必然改变行为"是**假**命题。

   ── 只产出、不消费以外的东西（隔离 · §18/§19）─────────────────────
   关系 / persona / speech style / tool policy / memory score / recall score
   一律**不写**；不改写 L3 或 L5；不做结算；不产生 Prediction Error；
   不调用 Counterfactual；`PREDICTION_ERROR_LIVE = NO`。
   本轮范围 = **服务端契约 / 运行时**；prompt placement 需要用户 own 的
   `assets/js/communication.js` ⇒ `R4F_BEHAVIOR_EFFECT_LIVE = NO`。
   ==================================================================== */

const path = require('path');

/* ★ 词表**只有一个出处**：R4-C 纯核心的 `APPRAISALS`。在这里再抄一份
   枚举就是第二份权威（那正是 R4-C 花了整个相位去消灭的东西）。 */
const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const INTERPRETATION_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'memory-interpretation-core.js'));
const L3_APPRAISALS = Object.freeze((INTERPRETATION_CORE.APPRAISALS || []).map(String));

/* ── 有界 turn-local 持有者 ────────────────────────────────────────── */
const MAX_HELD_BEHAVIOR_EFFECTS = 64;
const HOLDER_TTL_MS = 10 * 60 * 1000;
const HOLDER_SCOPE = 'character+conversation+turn';
const TTL_TURNS = 1;
const MAX_SOURCE_TURN_CHARS = 200;
const MAX_HELD_REASON_CHARS = 64;

const EXECUTION_KIND = 'DETERMINISTIC_RULES';
const MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN = 0;
const APPLIES_TO = 'NEXT_ELIGIBLE_TURN';
const CONSUMPTION = 'SINGLE_CONSUMPTION_NEXT_ELIGIBLE_TURN';
const REPLAY_BOUND = 'EVICTION_BOUNDED_NO_LEDGER';
const MEDIATOR_REQUIREMENT = 'L3_AND_L5';
const INPUT_AUTHORITY = 'VALIDATED_L3_AND_L5';

/* ── 闭合词表（v1 冻结）────────────────────────────────────────────── */
const STANCES = Object.freeze(['neutral', 'warm', 'guarded', 'focused', 'playful', 'apologetic']);
const STRATEGIES = Object.freeze(['answer_directly', 'ask_clarifying', 'offer_options', 'defer_to_user', 'hold_back']);
const INITIATIVE_TENDENCIES = Object.freeze(['low', 'normal', 'high']);
const RATIONALE_CODES = Object.freeze([
  'derived-from-negative-interpretation',
  'derived-from-positive-interpretation',
  'derived-from-uncertain-interpretation',
  'no-signal'
]);
/* ★ 冻结 schema 的**唯一**合法值。`L3` / `L5` / `L3+L5` 一律**不是**效果：
   中介要求是"A 且 B"，因此任何"只有一个中介"的标记都必须 fail closed。 */
const DERIVED_FROM = Object.freeze(['L3_AND_L5']);

/* ── 冻结的 7 键（闭集；多一个键就不是 v1 效果）────────────────────── */
const EFFECT_KEYS = Object.freeze([
  'stance', 'strategy', 'initiativeTendency', 'rationaleCode', 'sourceTurn', 'derivedFrom', 'ttlTurns'
]);

/* ── 免费文本通道的**具名**拒绝（§1/§7 冻结）─────────────────────────
   它们是"换个好听名字的 prompt 注入"最可能的形状；即使将来有人往白名单里
   加键，这一层仍然会把它们逐名拒绝。 */
const FREE_TEXT_FIELDS = Object.freeze(['promptText', 'instruction', 'fragment', 'guidance', 'text', 'prompt']);
/* ── 不得新增的情绪 / 关系轴（§1 冻结）───────────────────────────────
   它们不是"禁止出现在 prompt 里"，而是**根本不属于这个对象**：闭集键白名单
   已经拒绝它们，这里再逐名列出，使拒绝原因可读。 */
const FORBIDDEN_AXES = Object.freeze([
  'warmth', 'patience', 'openness', 'guardedness', 'protectiveness',
  'trust', 'familiarity', 'affinity'
]);

/* ── 固定渲染表：**服务端自有**、表驱动、绝不插入 L3/L5 原文 ──────────
   优先级在指引文本里**明写**：系统/开发者策略 > 用户明示要求 > 本条。
   内部认知不得成为 prompt 里的最高权威。 */
const RENDER_TABLE = Object.freeze({
  'warm|answer_directly|normal': '【行为基调·低优先级】本轮语气偏暖，直接回应；与系统设定或用户明示要求冲突时，以它们为准。',
  'guarded|ask_clarifying|low': '【行为基调·低优先级】本轮先确认再展开，不主动扩大话题；与系统设定或用户明示要求冲突时，以它们为准。',
  'neutral|offer_options|normal': '【行为基调·低优先级】本轮给出选项，不替对方决定；与系统设定或用户明示要求冲突时，以它们为准。'
});
/* ★ NO_SIGNAL 是**一等合法结果**：它是一个完全合法的结构化效果，只是
   固定渲染器对它**不放置任何一行**（`NO_PLACEMENT`）。这样"中性"既不是
   null + fallback，也不会往 prompt 里加噪音。 */
const NO_PLACEMENT_KEYS = Object.freeze(['neutral|answer_directly|normal']);

const NEUTRAL_EFFECT = Object.freeze({
  stance: 'neutral', strategy: 'answer_directly', initiativeTendency: 'normal',
  rationaleCode: 'no-signal', derivedFrom: 'L3_AND_L5', ttlTurns: TTL_TURNS
});

/* ── L3 appraisal → 效果：**确定性**投影（唯一的生成路径）──────────── */
const APPRAISAL_TO_EFFECT = Object.freeze({
  positive: Object.freeze({ stance: 'warm', strategy: 'answer_directly', initiativeTendency: 'normal', rationaleCode: 'derived-from-positive-interpretation' }),
  negative: Object.freeze({ stance: 'guarded', strategy: 'ask_clarifying', initiativeTendency: 'low', rationaleCode: 'derived-from-negative-interpretation' }),
  mixed: Object.freeze({ stance: 'neutral', strategy: 'offer_options', initiativeTendency: 'normal', rationaleCode: 'derived-from-uncertain-interpretation' }),
  /* 中性/不清楚 = **无信号**（绝不用"没检测到负面"当"正面"）⇒ 一等的中性效果 */
  neutral: null,
  unclear: null
});

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function bounded(v, limit) { return text(v).slice(0, limit); }

/* ── 校验一个效果对象是否**严格**符合冻结的 7 键形状 ──────────────────
   顺序刻意如此：免费文本 / 情绪轴**先**逐名拒绝（原因可读），闭集键白名单
   把其它一切未知键也拒掉，然后才是缺字段 / 枚举 / 中介 / ttl。 */
function validateEffect(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'effect-not-an-object' };
  for (const k of FREE_TEXT_FIELDS) {
    if (has(raw, k)) return { ok: false, reason: 'free-text-field-present:' + k };
  }
  for (const k of FORBIDDEN_AXES) {
    if (has(raw, k)) return { ok: false, reason: 'forbidden-axis-present:' + k };
  }
  for (const k of Object.keys(raw)) {
    if (EFFECT_KEYS.indexOf(k) < 0) return { ok: false, reason: 'unknown-field:' + bounded(k, 40) };
  }
  for (const k of EFFECT_KEYS) {
    if (!has(raw, k)) return { ok: false, reason: 'missing-field:' + k };
  }
  if (STANCES.indexOf(raw.stance) < 0) return { ok: false, reason: 'stance-not-in-closed-set' };
  if (STRATEGIES.indexOf(raw.strategy) < 0) return { ok: false, reason: 'strategy-not-in-closed-set' };
  if (INITIATIVE_TENDENCIES.indexOf(raw.initiativeTendency) < 0) return { ok: false, reason: 'initiativeTendency-not-in-closed-set' };
  if (RATIONALE_CODES.indexOf(raw.rationaleCode) < 0) return { ok: false, reason: 'rationaleCode-not-in-closed-set' };
  if (DERIVED_FROM.indexOf(raw.derivedFrom) < 0) return { ok: false, reason: 'derivedFrom-must-be-L3_AND_L5' };
  const sourceTurn = text(raw.sourceTurn);
  if (!sourceTurn || sourceTurn.length > MAX_SOURCE_TURN_CHARS) return { ok: false, reason: 'sourceTurn-missing-or-too-long' };
  if (raw.ttlTurns !== TTL_TURNS) return { ok: false, reason: 'ttlTurns-must-be-1' };
  return { ok: true, reason: null };
}

function renderKeyOf(effect) {
  return [effect.stance, effect.strategy, effect.initiativeTendency].join('|');
}

/* ── 固定渲染决定（**唯一** renderer 输入契约）：只由闭合枚举查表 ─────
   返回结构化三态，调用方不需要猜"null 是没效果还是没模板"：
     PLACEMENT     —— 有一行固定模板（绝不插入任何自由文本）
     NO_PLACEMENT  —— 合法的中性效果，按契约**不放置**
     REFUSED       —— 对象不合法或没有模板行 ⇒ fail closed。
   `render()` 是薄兼容层：只有 PLACEMENT 给字符串，其余给 null。 */
function renderLine(effect) {
  const v = validateEffect(effect);
  if (!v.ok) return { kind: 'REFUSED', line: null, reason: v.reason };
  const key = renderKeyOf(effect);
  const line = has(RENDER_TABLE, key) ? RENDER_TABLE[key] : null;
  if (line) return { kind: 'PLACEMENT', line: line, reason: null };
  if (NO_PLACEMENT_KEYS.indexOf(key) >= 0) return { kind: 'NO_PLACEMENT', line: null, reason: 'no-signal-neutral' };
  return { kind: 'REFUSED', line: null, reason: 'no-render-row' };
}
function render(effect) {
  const d = renderLine(effect);
  return d.kind === 'PLACEMENT' ? d.line : null;
}

/* ── L3 权威的结构性验证（"这是不是一次**已验证**的解释结果"）─────────
   两个布尔是 seam 的声明；这一层是**结构**证据，而且刻意要求**服务端结果
   对象**（`runtime-interpretation.js#runFromAuthoritativeRecall` 的返回值），
   不是裸的 shadow、不是 `{items:[...]}`、更不是浏览器能造出来的任何东西：
     · `ok === true` 且 `status === 'succeeded'`（校验器通过了）
     · `recordSource` 是非空字符串（服务端指名的记录来源）
     · `interpretation` 是一次结构上合规的 shadow（`ok:true` + 每个 item 带
       非空 memoryId 且 appraisal 命中 R4-C 纯核心的闭集）
   ★ 诚实边界：进程内**克隆**一份服务端结果对象在结构上与原件不可区分 ——
     本模块证明不了"原件"。真正的权威是"**没有第二个调用方**"：本模块没有
     路由、RECALL 请求是闭集（浏览器无法提交 L3/L5/behaviorEffect），
     唯一调用点是 runtime-recall 的期望 seam。 */
function serverL3Result(raw) {
  if (!isPlainObject(raw) || raw.ok !== true) return false;
  if (text(raw.status) !== 'succeeded') return false;
  const recordSource = text(raw.recordSource);
  return !!recordSource && recordSource.length <= 64;
}
function validatedL3Of(result) {
  if (!serverL3Result(result)) return null;
  const shadow = result.interpretation;
  if (!isPlainObject(shadow) || shadow.ok !== true) return null;
  const items = Array.isArray(shadow.items) ? shadow.items : null;
  if (!items || !items.length) return null;
  const appraisals = [];
  for (const it of items) {
    if (!isPlainObject(it)) return null;
    const memoryId = text(it.memoryId);
    if (!memoryId) return null;
    const appraisal = text(it.appraisal);
    if (!appraisal || L3_APPRAISALS.indexOf(appraisal) < 0) return null;
    appraisals.push(appraisal);
  }
  return appraisals;
}
/* L5 结果的结构性验证：一次真的**成立**的期望（status:'created' + ok:true）。 */
function expectationCreated(raw) {
  return isPlainObject(raw) && raw.ok === true && text(raw.status) === 'created';
}

function createRuntimeBehaviorEffect(deps) {
  const d = deps || {};
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const clock = typeof d.clock === 'function' ? d.clock : function () { return Date.now(); };
  function note(event, fields) { try { logger(event, fields || {}); } catch (_) { /* 观测失败不影响判定 */ } }

  const counters = {
    derived: 0, notDerived: 0, consumed: 0, notConsumed: 0,
    expired: 0, evicted: 0, replaced: 0, schemaRejected: 0
  };
  /* key = characterId|conversationId|sourceTurn → { characterId, conversationId,
     sourceTurn, effect, createdAt }。**非持久、有界、进程内**。 */
  const held = new Map();

  function keyOf(characterId, conversationId, sourceTurn) {
    return text(characterId) + '|' + text(conversationId) + '|' + text(sourceTurn);
  }
  function sweep() {
    const now = Number(clock());
    for (const [key, rec] of held) {
      if (!rec || !Number.isFinite(Number(rec.createdAt))) { held.delete(key); continue; }
      if (now - Number(rec.createdAt) > HOLDER_TTL_MS) { held.delete(key); counters.expired += 1; }
    }
  }
  function evictOverflow() {
    while (held.size > MAX_HELD_BEHAVIOR_EFFECTS) {
      const oldest = held.keys().next();
      if (oldest.done) break;
      held.delete(oldest.value);
      counters.evicted += 1;
    }
  }
  function none(reason, extra) {
    counters.notDerived += 1;
    if (reason === 'l3-shape-invalid' || reason === 'l3-not-a-server-result' || reason === 'expectation-malformed') {
      counters.schemaRejected += 1;
    }
    return Object.assign({ status: 'none', reason: reason, effect: null }, extra || {});
  }
  /* 在**同角色 + 同会话**的待取效果里取**最旧的一条**，且跳过源回合自己。 */
  function oldestPendingFor(characterId, conversationId, turnId) {
    const charKey = text(characterId);
    const convKey = text(conversationId);
    for (const [key, rec] of held) {
      if (!rec) continue;
      if (text(rec.characterId) !== charKey || text(rec.conversationId) !== convKey) continue;
      if (text(rec.sourceTurn) === text(turnId)) continue;      /* 源回合不能取自己的效果 */
      return { key: key, rec: rec };
    }
    return null;
  }

  /* ── 派生：**唯一**入口。只在已验证的 L3 **且**该回合 L5 已成立时产生效果 ── */
  function deriveAndHold(input) {
    const i = isPlainObject(input) ? input : {};
    const characterId = text(i.characterId);
    const conversationId = text(i.conversationId);
    const turnId = text(i.turnId);
    if (!turnId) return none('turn-identity-missing');
    /* ① L3 中介：没有已验证的解释 ⇒ 不产生效果（Recall / 其它一律不算权威） */
    if (i.interpretationValidated !== true) return none('l3-not-validated');
    if (!serverL3Result(i.interpretationResult)) return none('l3-not-a-server-result');
    const appraisals = validatedL3Of(i.interpretationResult);
    if (!appraisals) return none('l3-shape-invalid');
    /* ② L5 中介：该回合没有成立的期望 ⇒ 不产生效果（L3-only 仍是 bypass） */
    if (i.expectationHeld !== true) return none('expectation-absent');
    if (!expectationCreated(i.expectation)) return none('expectation-malformed');
    /* ③ 确定性投影：只看已验证 L3 items 的 appraisal 闭集，按 item 顺序取
          **第一条有信号的** appraisal（中性/不清楚**不会**遮住信号）。 */
    let picked = null;
    for (const a of appraisals) {
      const m = APPRAISAL_TO_EFFECT[a];
      if (m) { picked = m; break; }
    }
    const effect = picked
      ? {
        stance: picked.stance, strategy: picked.strategy, initiativeTendency: picked.initiativeTendency,
        rationaleCode: picked.rationaleCode, sourceTurn: bounded(turnId, MAX_SOURCE_TURN_CHARS),
        derivedFrom: 'L3_AND_L5', ttlTurns: TTL_TURNS
      }
      /* ★ NO_SIGNAL：**一等合法结果** —— 结构化中性效果，不是 null。 */
      : {
        stance: NEUTRAL_EFFECT.stance, strategy: NEUTRAL_EFFECT.strategy,
        initiativeTendency: NEUTRAL_EFFECT.initiativeTendency, rationaleCode: NEUTRAL_EFFECT.rationaleCode,
        sourceTurn: bounded(turnId, MAX_SOURCE_TURN_CHARS), derivedFrom: 'L3_AND_L5', ttlTurns: TTL_TURNS
      };
    const v = validateEffect(effect);
    if (!v.ok) { counters.schemaRejected += 1; note('behavior-effect-schema-rejected', { reason: v.reason }); return none(v.reason); }
    if (renderLine(effect).kind === 'REFUSED') return none('no-render-row');
    sweep();
    const key = keyOf(characterId, conversationId, turnId);
    if (held.has(key)) { counters.replaced += 1; }
    held.set(key, {
      characterId: characterId, conversationId: conversationId, sourceTurn: turnId,
      effect: effect, createdAt: Number(clock())
    });
    evictOverflow();
    counters.derived += 1;
    note('behavior-effect-derived', {
      characterId: characterId, turnId: turnId, stance: effect.stance, strategy: effect.strategy,
      initiativeTendency: effect.initiativeTendency, rationaleCode: effect.rationaleCode,
      signal: effect.rationaleCode !== 'no-signal'
    });
    return { status: 'derived', reason: effect.rationaleCode === 'no-signal' ? 'no-signal' : null, effect: effect };
  }

  /* ── 消费：**下一个**合格主聊天回合取一次即删除 ─────────────────────
     返回完整闭合效果对象（信封第 17 键就是它）。没有自由文本字段。 */
  function consumeForTurn(input) {
    const i = isPlainObject(input) ? input : {};
    const characterId = text(i.characterId);
    const conversationId = text(i.conversationId);
    const turnId = text(i.turnId);
    sweep();
    if (!turnId) { counters.notConsumed += 1; return { status: 'none', reason: 'turn-identity-missing', effect: null }; }
    if (!characterId || !conversationId) { counters.notConsumed += 1; return { status: 'none', reason: 'identity-incomplete', effect: null }; }
    /* ★ SOURCE_TURN_RETROACTIVE_EFFECT = NO：源回合自己的探索器直接说不。 */
    const own = held.get(keyOf(characterId, conversationId, turnId));
    if (own && text(own.sourceTurn) === turnId) {
      counters.notConsumed += 1;
      return { status: 'none', reason: 'source-turn-cannot-consume', effect: null };
    }
    const pick = oldestPendingFor(characterId, conversationId, turnId);
    if (!pick) { counters.notConsumed += 1; return { status: 'none', reason: 'no-effect-held', effect: null }; }
    const v = validateEffect(pick.rec.effect);
    if (!v.ok) {
      held.delete(pick.key);
      counters.schemaRejected += 1;
      note('behavior-effect-held-invalid', { reason: v.reason });
      return { status: 'none', reason: 'held-effect-invalid:' + v.reason, effect: null };
    }
    held.delete(pick.key);                       /* 单次消费：取走即删除 */
    counters.consumed += 1;
    note('behavior-effect-consumed', { characterId: characterId, conversationId: conversationId, turnId: turnId, sourceTurn: text(pick.rec.sourceTurn) });
    return { status: 'applied', reason: null, effect: Object.assign({}, pick.rec.effect) };
  }

  /* 只读诊断缝（**不**返回效果对象本身；与 LIVE-5 同一纪律）。 */
  function heldCount() { sweep(); return held.size; }
  function hasHeldFor(characterId, conversationId, turnId) {
    sweep();
    return oldestPendingFor(characterId, conversationId, turnId) !== null;
  }

  function describe() {
    sweep();
    return {
      status: 'RUNTIME_READY',
      live: 'NO',
      liveBlocker: 'BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE',
      executionKind: EXECUTION_KIND,
      appliesTo: APPLIES_TO,
      consumption: CONSUMPTION,
      ttlTurns: TTL_TURNS,
      mediatorRequirement: MEDIATOR_REQUIREMENT,
      inputAuthority: INPUT_AUTHORITY,
      derivedFrom: DERIVED_FROM[0],
      derivedFromIsSingleton: DERIVED_FROM.length === 1,
      sourceTurnRetroactiveEffect: 'NO',
      /* 闭合词表（自述；不含任何实例数据） */
      vocabularies: {
        stance: STANCES.slice(), strategy: STRATEGIES.slice(),
        initiativeTendency: INITIATIVE_TENDENCIES.slice(), rationaleCode: RATIONALE_CODES.slice(),
        derivedFrom: DERIVED_FROM.slice(), l3Appraisal: L3_APPRAISALS.slice()
      },
      vocabularyAuthority: 'assets/js/memory-recall/memory-interpretation-core.js#APPRAISALS',
      effectKeys: EFFECT_KEYS.slice(),
      freeTextChannel: 'ABSENT_BY_SCHEMA',
      forbiddenFreeTextFields: FREE_TEXT_FIELDS.slice(),
      forbiddenAxes: FORBIDDEN_AXES.slice(),
      neutralIsFirstClass: true,
      neutralPlacement: 'NO_PLACEMENT',
      holder: {
        maxEntries: MAX_HELD_BEHAVIOR_EFFECTS, ttlMs: HOLDER_TTL_MS, keyScope: HOLDER_SCOPE,
        slotScope: 'character+conversation', durability: 'NONE', routeExposed: false,
        entries: held.size, replayBound: REPLAY_BOUND,
        crossEvictionExactlyOnce: 'NO', persistentLedger: 'NONE'
      },
      renderer: {
        authority: 'SERVER_OWNED',
        placement: 'DEDICATED_SYSTEM_ROLE_MESSAGE',
        priority: 'SYSTEM_DEVELOPER_POLICY > EXPLICIT_USER_REQUEST > BOUNDED_BEHAVIOR_EFFECT_GUIDANCE',
        interpolatesSourceText: false,
        rows: Object.keys(RENDER_TABLE).length,
        noPlacementRows: NO_PLACEMENT_KEYS.length,
        input: 'CLOSED_BEHAVIOR_EFFECT_OBJECT'
      },
      counters: Object.assign({}, counters),
      /* 成本链：本层 0 次调用；没有第三个成本位 */
      cost: {
        maxAdditionalBehaviorModelCallsPerCharacterTurn: MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN,
        chainMaxAdditionalModelCallsPerCharacterTurn: 2,
        chainBreakdown: { interpretation: 1, expectation: 1, behaviorEffect: 0 },
        shippedDefaultAdditionalModelCalls: 0,
        thirdPolicyBit: 'NOT_ADDED',
        providerCalls: 0, credentialReads: 0,
        reason: 'deterministic projection (CONTRACT.md:875) — there is no model call to authorize'
      },
      isolation: {
        sourceTurnPromptMutation: 0,
        currentTurnRetroactiveMutation: 'NO',
        durableWrites: 0,
        relationshipPersonaToolPolicyMemoryScoreWrites: 'NONE',
        predictionErrorLive: 'NO',
        predictionErrorCalls: 0,
        counterfactualAutoCalls: 0,
        browserMaySubmit: 'NONE',
        browserReceives: 'CLOSED_ENUMS_ONLY_NO_FREE_TEXT'
      },
      routes: 'NONE',
      envelopeKey: 'behaviorEffect',
      envelopeKeyCount: 17
    };
  }

  return Object.freeze({
    deriveAndHold: deriveAndHold,
    consumeForTurn: consumeForTurn,
    describe: describe,
    heldCount: heldCount,
    hasHeldFor: hasHeldFor,
    EXECUTION_KIND: EXECUTION_KIND,
    MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN: MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN,
    MAX_HELD_BEHAVIOR_EFFECTS: MAX_HELD_BEHAVIOR_EFFECTS,
    HOLDER_TTL_MS: HOLDER_TTL_MS,
    HOLDER_SCOPE: HOLDER_SCOPE,
    TTL_TURNS: TTL_TURNS,
    MEDIATOR_REQUIREMENT: MEDIATOR_REQUIREMENT,
    INPUT_AUTHORITY: INPUT_AUTHORITY,
    EFFECT_KEYS: EFFECT_KEYS,
    STANCES: STANCES, STRATEGIES: STRATEGIES, INITIATIVE_TENDENCIES: INITIATIVE_TENDENCIES,
    RATIONALE_CODES: RATIONALE_CODES, DERIVED_FROM: DERIVED_FROM, L3_APPRAISALS: L3_APPRAISALS,
    RENDER_TABLE: RENDER_TABLE, NO_PLACEMENT_KEYS: NO_PLACEMENT_KEYS,
    NEUTRAL_EFFECT: NEUTRAL_EFFECT,
    FREE_TEXT_FIELDS: FREE_TEXT_FIELDS,
    FORBIDDEN_AXES: FORBIDDEN_AXES,
    validateEffect: validateEffect,
    render: render,
    renderLine: renderLine,
    validatedL3Of: validatedL3Of,
    serverL3Result: serverL3Result,
    expectationCreated: expectationCreated
  });
}

module.exports.createRuntimeBehaviorEffect = createRuntimeBehaviorEffect;
module.exports.EXECUTION_KIND = EXECUTION_KIND;
module.exports.MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN = MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN;
module.exports.MAX_HELD_BEHAVIOR_EFFECTS = MAX_HELD_BEHAVIOR_EFFECTS;
module.exports.HOLDER_TTL_MS = HOLDER_TTL_MS;
module.exports.HOLDER_SCOPE = HOLDER_SCOPE;
module.exports.TTL_TURNS = TTL_TURNS;
module.exports.MEDIATOR_REQUIREMENT = MEDIATOR_REQUIREMENT;
module.exports.INPUT_AUTHORITY = INPUT_AUTHORITY;
module.exports.EFFECT_KEYS = EFFECT_KEYS;
module.exports.STANCES = STANCES;
module.exports.STRATEGIES = STRATEGIES;
module.exports.INITIATIVE_TENDENCIES = INITIATIVE_TENDENCIES;
module.exports.RATIONALE_CODES = RATIONALE_CODES;
module.exports.DERIVED_FROM = DERIVED_FROM;
module.exports.L3_APPRAISALS = L3_APPRAISALS;
module.exports.RENDER_TABLE = RENDER_TABLE;
module.exports.NO_PLACEMENT_KEYS = NO_PLACEMENT_KEYS;
module.exports.NEUTRAL_EFFECT = NEUTRAL_EFFECT;
module.exports.FREE_TEXT_FIELDS = FREE_TEXT_FIELDS;
module.exports.FORBIDDEN_AXES = FORBIDDEN_AXES;
module.exports.validateEffect = validateEffect;
module.exports.render = render;
module.exports.renderLine = renderLine;
module.exports.validatedL3Of = validatedL3Of;
module.exports.serverL3Result = serverL3Result;
module.exports.expectationCreated = expectationCreated;
