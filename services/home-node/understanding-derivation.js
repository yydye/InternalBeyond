/* ====================================================================
   IB Home Node · Canonical Understanding Derivation（M1-C.2m P3）
   --------------------------------------------------------------------
   职责：Home Node 上**唯一**的理解写者。

       canonical memories（已过可见性）
             ↓   memory-visibility-core（同一份 ACL）
             ↓   understanding-derivation-core（同一份准入/提示词/印章）
             ↓   角色自己的 provider 凭据（character_runtime_specs）
             ↓   rewrite(expectedRevision)   ← CAS，冲突即拒绝
             ↓   understanding_records（每个角色恰好一份 active）
             ↓   durable watermark（重启不重置）

   ── 为什么这是唯一写者 ────────────────────────────────────────────────
   M1-C.2l 判定：旧写者是**浏览器后台 tick**，于是"只在手机上聊一周"等于
   理解完全不变；而且两个标签页可以同时写同一份文档。把写者搬到这里之后：
     · 桌面关着也继续演进（进程常驻）；
     · 浏览器不再是写者（它的 _understandingTick 只剩调度触发器）；
     · 跨标签页竞态在结构上消失（写盘只有一处）。

   ── 一个写者还不够：同一份**派生规则**同样重要 ────────────────────────
   如果桌面按"moments + diary + memories"派生，而这里只按 memories 派生，
   那就是**一个写者、两套派生** —— 缺陷换了一身衣服。因此本阶段两端都
   **只用 canonical memories**（M1-C.2m §5），增强（moments/diary）等它们
   自己也成为 canonical 之后再一次性打开（那时改的是这一处）。

   ── 成本护栏（§7）：这是唯一会花掉角色凭据的后台路径 ──────────────────
   每次 tick 的分支顺序是刻意的 —— 便宜的判据全部排在模型调用**之前**：
     ① 角色不存在 / 没有可运行配置        → skip:no-config（零成本）
     ② 证据指纹与上次成功派生的相同        → skip:evidence-unchanged（零成本）
        · 指纹只由 canonical 证据的 id+内容决定，**不含**任何时间戳或宿主
          运行时长，因此进程重启不会看起来像"证据变了"。
        · 上一次派生**没有改变文档**（accepted=false）时，即便指纹变了也
          需要新证据真的改变了指纹 —— 指纹就是那个判据，不必再叠一层。
     ③ 与上次**尝试**间隔不足 minIntervalMs → skip:min-interval（零成本）
     ④ 证据不足（可见候选为空）            → skip:no-evidence（零成本）
     ⑤ 同一角色已有派生在飞行中            → skip:in-flight（零成本）
     ⑥ 模型未给出 shouldUpdate / 准入拒绝   → skipped:model-declined（消耗一次调用）
     ⑦ 候选与当前版本逐字相同              → skipped:identical（store 层不动 revision）
   也就是说：**唯一**能让一个角色再次消耗 token 的事件是
   "canonical 可见证据集发生了变化，且距上次尝试已超过最小间隔"。
   这条规则必须能被直接断言（见 test_home_node_understanding_derivation.js）。

   ── 失败与重启语义 ──────────────────────────────────────────────────
   · 进程在模型调用之后、提交之前死掉 → 数据库**没有任何变更**（提交是单事务），
     水位也没前进；重启后重试，得到同一份候选，首次提交即为第 1 版。
   · CAS 冲突（基版本过期）→ **不覆盖**，如实回报 conflict 并让调用方决定；
     水位不前进，所以下一轮会重新读取当前版本再派生。
   · 模型/网络失败 → 记 attempts，退避 minIntervalMs 的下一次尝试；
     绝不写"半份"理解。
   ==================================================================== */
'use strict';

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const UNDERSTANDING = require(path.join(ASSETS_JS, 'understanding-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ASSETS_JS, 'memory-visibility-core.js'));

/* 候选窗口：与桌面 `_understandingTick` 的处理窗口一致（最近 10 条 episodic）。
   窗口不同会让"同一批 canonical 记忆"派生出不同的理解 —— 那正是本阶段
   要消灭的宿主差异。 */
const UNDERSTANDING_CANDIDATE_WINDOW = 10;
/* 最小派生间隔：与桌面既有的 6 小时水位线一致（那是产品既有节流强度，
   本阶段只把"内存水位"换成"持久水位"，不改变节流强度）。 */
const UNDERSTANDING_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/* 一个角色的理解派生最多消耗的 token 数（与桌面 `_understandingTick` 的
   maxTokens:700 一致）。 */
const UNDERSTANDING_MAX_TOKENS = 700;
const UNDERSTANDING_TIMEOUT_MS = 120000;
/* 调度扫描间隔：默认 15 分钟扫一次**水位**（不是"每 15 分钟派生一次"）。
   真正的节流在 watermark 里，因此扫描频率只影响"多久才发现可以派生"，
   不影响 token 消耗。 */
const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000;

/* 与桌面 `_memNonSemantic` 逐字等价的候选谓词（线索派生用的是同一个谓词）。 */
function nonSemantic(m) { return !!m && m.kind !== 'semantic' && m.kind !== 'core'; }

function createUnderstandingDerivation(deps) {
  deps = deps || {};
  const store = deps.store || null;                 /* understanding-store */
  const memoryStore = deps.memoryStore || null;     /* canonical memory store */
  const registry = deps.registry || null;           /* 角色 DTO + 运行时 spec */
  const modelPort = deps.modelPort || null;         /* NodeModelPort（或同形 mock） */
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const core = deps.core || UNDERSTANDING;
  const visibilityCore = deps.visibilityCore || VISIBILITY_CORE;
  const minIntervalMs = Number(deps.minIntervalMs) > 0 ? Number(deps.minIntervalMs) : UNDERSTANDING_MIN_INTERVAL_MS;
  const candidateWindow = Number(deps.candidateWindow) > 0 ? Number(deps.candidateWindow) : UNDERSTANDING_CANDIDATE_WINDOW;
  const maxTokens = Number(deps.maxTokens) > 0 ? Number(deps.maxTokens) : UNDERSTANDING_MAX_TOKENS;
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : UNDERSTANDING_TIMEOUT_MS;
  /* 观测计数（进程级，用于诊断"到底花了多少次调用"）。 */
  const stats = { ticks: 0, considered: 0, calls: 0, created: 0, updated: 0, skipped: 0, conflicts: 0, failures: 0 };

  /* 飞行中的派生（进程内互斥）：同一角色的两次 tick 不允许同时进入模型调用。
     进程外的并发由「CAS + 单活唯一索引」兜底 —— 两层都要有：
     这里省掉的是**重复的 token 消耗**，store 那里守的是**数据不变量**。 */
  const inFlight = new Set();

  function isReady() { return !!(store && memoryStore && registry && modelPort); }

  /* ── 候选集：与桌面**同一个**可见性核心、同一个谓词、同一个窗口 ────── */
  function candidatesFor(characterId) {
    const rows = readMemories();
    if (!rows.ok) return { ok: false, error: rows.error, candidates: [] };
    const visible = visibilityCore.filterDerivationCandidates(rows.records, String(characterId), nonSemantic);
    return { ok: true, candidates: visible.slice(-candidateWindow), visibleCount: visible.length, all: rows.records };
  }
  function readMemories() {
    if (!memoryStore || typeof memoryStore.listRecords !== 'function') {
      return { ok: false, error: 'memory-store-unavailable', records: [] };
    }
    try {
      const page = memoryStore.listRecords({});
      if (!page || !page.ok) return { ok: false, error: (page && page.error) || 'memory-read-failed', records: [] };
      return { ok: true, records: Array.isArray(page.records) ? page.records : [] };
    } catch (error) {
      logger('understanding-memory-read-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'memory-read-failed', records: [] };
    }
  }

  /* ── 资格判定（**零模型调用**）：返回 {eligible, skipReason, ...} ──────
     这是成本护栏的实现处。任何理由都必须是稳定的词表值，供诊断与测试断言。 */
  function eligibility(characterId, options) {
    options = options || {};
    const owner = String(characterId || '');
    if (!owner) return { eligible: false, skipReason: 'no-character' };
    if (!store || !store.isOpen || !store.isOpen()) return { eligible: false, skipReason: 'store-closed' };
    const spec = characterSpec(owner);
    if (!spec || !spec.provider || !spec.model || !spec.endpoint || !spec.apiKey) {
      /* 不可派生的角色**必须**如实跳过：缺凭据时去调用只会得到认证错误，
         而那条错误会伪装成"模型没给结果"。 */
      return { eligible: false, skipReason: 'no-config' };
    }
    const cand = candidatesFor(owner);
    if (!cand.ok) return { eligible: false, skipReason: 'no-evidence-source', error: cand.error };
    const candidates = cand.candidates;
    if (!candidates.length) return { eligible: false, skipReason: 'no-evidence', candidateCount: 0 };
    const fingerprint = core.evidenceFingerprint(candidates);
    const watermark = store.getWatermark(owner);
    const now = Number(clock());
    if (watermark.evidenceFingerprint && watermark.evidenceFingerprint === fingerprint) {
      return {
        eligible: false, skipReason: 'evidence-unchanged', fingerprint: fingerprint,
        lastDerivedAt: watermark.lastDerivedAt, candidateCount: candidates.length
      };
    }
    const since = now - Number(watermark.lastAttemptAt || 0);
    if (watermark.lastAttemptAt && since < minIntervalMs) {
      return {
        eligible: false, skipReason: 'min-interval', fingerprint: fingerprint,
        retryInMs: minIntervalMs - since, candidateCount: candidates.length
      };
    }
    if (inFlight.has(owner)) return { eligible: false, skipReason: 'in-flight', fingerprint: fingerprint };
    return {
      eligible: true, skipReason: null, fingerprint: fingerprint,
      candidateCount: candidates.length, candidates: candidates, all: cand.all,
      spec: spec, watermark: watermark
    };
  }

  function characterSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') return null;
    try { return registry.getCharacterSpec(String(characterId)) || null; }
    catch (error) {
      logger('understanding-spec-read-failed', { error: String((error && error.message) || error) });
      return null;
    }
  }
  function characterDto(characterId) {
    if (!registry || typeof registry.getCharacter !== 'function') return null;
    try {
      const row = registry.getCharacter(String(characterId));
      return (row && row.dto) || null;
    } catch (error) { return null; }
  }

  /* ── 一轮派生 ────────────────────────────────────────────────────────
     options.force          —— 忽略证据指纹与最小间隔（**仅显式调用/测试**）
     options.characterId    —— 只处理这一个角色
     返回结构化结果（outcome 词表固定）：
       created / updated / skipped / conflict / declined / failed / ineligible */
  async function derive(characterId, options) {
    options = options || {};
    const owner = String(characterId || '');
    const gate = options.force === true
      ? forceGate(owner)
      : eligibility(owner, options);
    if (!gate.eligible) {
      stats.skipped++;
      return { ok: true, outcome: 'ineligible', characterId: owner, skipReason: gate.skipReason, gate: gate };
    }
    inFlight.add(owner);
    const attemptedAt = Number(clock());
    try {
      return await runCycle(owner, gate, attemptedAt, options);
    } finally {
      inFlight.delete(owner);
    }
  }

  /* force 路径**仍然**读配置与证据（否则就是"无条件烧 token"），
     只跳过两个节流判据。调用方必须显式要求，因此不可能被调度器误用。 */
  function forceGate(owner) {
    if (!owner) return { eligible: false, skipReason: 'no-character' };
    if (!store || !store.isOpen || !store.isOpen()) return { eligible: false, skipReason: 'store-closed' };
    const spec = characterSpec(owner);
    if (!spec || !spec.provider || !spec.model || !spec.endpoint || !spec.apiKey) {
      return { eligible: false, skipReason: 'no-config' };
    }
    const cand = candidatesFor(owner);
    if (!cand.ok) return { eligible: false, skipReason: 'no-evidence-source', error: cand.error };
    if (!cand.candidates.length) return { eligible: false, skipReason: 'no-evidence', candidateCount: 0 };
    return {
      eligible: true, skipReason: null, forced: true,
      fingerprint: core.evidenceFingerprint(cand.candidates),
      candidateCount: cand.candidates.length, candidates: cand.candidates, all: cand.all, spec: spec
    };
  }

  async function runCycle(owner, gate, attemptedAt, options) {
    const active = store.getActive(owner);
    /* 更正的口径是 `constrainingCorrections`（按版本关系算），**不是** status=active：
       一条更正可能在"派生飞行途中"被记下，而那次提交因 CAS 冲突失败 ——
       它的 status 会是 applied，却从未进入过任何提示词。只读 active 会让它永久静默。 */
    const corrections = typeof store.constrainingCorrections === 'function'
      ? store.constrainingCorrections(owner)
      : store.activeCorrections(owner);
    const dto = characterDto(owner) || {};
    const charName = String(dto.name || (gate.spec && gate.spec.model) || 'AI');
    const prompt = core.buildPrompt({
      systemPrompt: (gate.spec && gate.spec.systemPrompt) || '',
      charName: charName,
      relationship: dto.relationship || '',
      fragments: core.fragmentsOf(gate.candidates, { window: candidateWindow }),
      current: active ? {
        content: active.current && active.current.content,
        dimension: active.dimension,
        conviction: active.current && active.current.conviction,
        revision: active.revision
      } : null,
      corrections: corrections.map(c => ({ text: c.text, basis: c.basis, at: c.createdAt, revision: c.revision }))
    });

    stats.calls++;
    let raw = '';
    try {
      const result = await modelPort.run({
        spec: gate.spec,
        prompt: { system: prompt.system, messages: [{ role: 'user', content: prompt.user }] },
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: maxTokens,
        jsonMode: true,
        jsonPrefill: '{"shouldUpdate":',
        /* consumer 标记沿用桌面 `_ibConsumer:'understanding'` 的口径：
           用量记账里这条调用必须能被认出来是**理解派生**，而不是聊天。 */
        consumer: 'understanding'
      }, { timeoutMs: timeoutMs });
      raw = String((result && result.text) || '');
    } catch (error) {
      stats.failures++;
      store.setWatermark(owner, {
        lastAttemptAt: attemptedAt, lastOutcome: 'failed', lastAccepted: false,
        skipReason: 'model-failed', attempts: Number((gate.watermark && gate.watermark.attempts) || 0) + 1
      });
      logger('understanding-model-failed', { characterId: owner, error: String((error && error.message) || error).slice(0, 300) });
      return { ok: false, outcome: 'failed', characterId: owner, error: 'model-failed', detail: String((error && error.message) || error).slice(0, 300) };
    }

    const parsed = core.parseCandidate(raw, (text) => core.parseModelJson(text, {
      allowPrefillContinuation: true,
      prefillSeed: '{"shouldUpdate":'
    }));
    if (!parsed) {
      store.setWatermark(owner, {
        lastAttemptAt: attemptedAt, lastOutcome: 'declined', lastAccepted: false, skipReason: 'model-declined',
        attempts: 0
      });
      return { ok: true, outcome: 'declined', characterId: owner, skipReason: 'model-declined' };
    }

    /* 证据准入：模型输出的 evidenceIds 不可信（可能幻觉、可能指向隐藏记忆）。 */
    const evidenceIds = core.visibleEvidenceIds(parsed.evidenceIds, gate.all, owner, visibilityCore)
      .slice(0, core.U_EVIDENCE_MAX);

    const cal = await core.calibrate({
      content: parsed.content,
      confidence: parsed.conviction,
      reasons: [],
      basis: parsed.rawBasis,
      operation: 'understanding',
      targetStore: 'understandings',
      category: parsed.dimension,
      evidenceIds: evidenceIds,
      memories: gate.all
    }, {
      sim: core.textSimilarity,
      extractKeywords: deps.extractKeywords || null,
      lookupEntries: lookupMemoryEntries
    });
    if (!cal || cal.rejected) {
      store.setWatermark(owner, {
        lastAttemptAt: attemptedAt, lastOutcome: 'declined', lastAccepted: false,
        skipReason: 'admission-' + ((cal && cal.rejected) || 'unknown'), attempts: 0
      });
      return {
        ok: true, outcome: 'declined', characterId: owner,
        skipReason: 'admission-' + ((cal && cal.rejected) || 'unknown'),
        distinctEvidence: cal ? cal.distinctEvidence : null
      };
    }

    /* R1/R6 印章：来源 = **本制品新旧两版的证据并集**。
       只按本次新证据算，会在"先收窄、后重新派生"时把印章放宽回旧范围。
       无法解析的证据 id 追加一条降级来源（只可能更窄，不可能放宽）。 */
    const prevIds = ((active && active.current && active.current.evidenceIds) || []).map(String);
    const stampIds = Array.from(new Set(prevIds.concat(evidenceIds.map(String))));
    const byId = new Map((gate.all || []).map(m => [String(m && m.id), m]));
    const stampRows = stampIds.map(id => byId.get(id) || { visibility: undefined });
    const stamp = core.derivationStamp(stampRows, owner, visibilityCore);

    const expectedRevision = active ? Number(active.revision) : 0;
    const written = store.rewrite(owner, {
      content: parsed.content,
      conviction: cal.confidence,
      dimension: parsed.dimension,
      basis: parsed.rawBasis,
      evidenceIds: evidenceIds,
      updatedBy: charName,
      stamp: stamp,
      /* 证据**逐条**可解析时才允许写入；有一条解析不到就如实记 unattested。
         这不是放宽隐私边界 —— 读时存证（attestDerivedArtifact）对缺失/隐藏
         证据一律拒绝注入，因此 unattested 只影响"这份文档的历史是否完整"，
         不影响"能不能被注入"。 */
      unattested: stampIds.some(id => !byId.get(id))
    }, { expectedRevision: expectedRevision });

    if (!written.ok) {
      stats.conflicts++;
      /* 冲突时**不推进**证据指纹：下一次 tick 必须重新派生，
         而不是判定"证据没变"从而永久停在过期版本上。 */
      store.setWatermark(owner, {
        lastAttemptAt: attemptedAt, lastOutcome: 'conflict', lastAccepted: false,
        skipReason: written.error || 'write-failed', attempts: Number((gate.watermark && gate.watermark.attempts) || 0) + 1
      });
      logger('understanding-write-conflict', {
        characterId: owner, expectedRevision: expectedRevision,
        actualRevision: written.actualRevision, error: written.error
      });
      return {
        ok: false, outcome: 'conflict', characterId: owner, error: written.error || 'write-failed',
        expectedRevision: expectedRevision, actualRevision: written.actualRevision, activeId: written.activeId || null
      };
    }

    const accepted = written.outcome === 'created' || written.outcome === 'updated';
    if (written.outcome === 'created') stats.created++;
    else if (written.outcome === 'updated') stats.updated++;
    else stats.skipped++;
    /* 水位**只在提交成功之后**推进。指纹指向"这次派生所依据的证据集"，
       因此只要证据不再变化，就不会再有第二次调用。 */
    store.setWatermark(owner, {
      evidenceFingerprint: gate.fingerprint,
      lastDerivedAt: accepted ? Number(clock()) : Number((gate.watermark && gate.watermark.lastDerivedAt) || 0),
      lastAttemptAt: attemptedAt,
      lastOutcome: written.outcome,
      lastAccepted: accepted,
      skipReason: accepted ? null : (written.reason || written.outcome),
      attempts: 0
    });
    logger('understanding-derived', {
      characterId: owner, outcome: written.outcome, docRevision: written.docRevision,
      historyLength: written.historyLength, evidence: evidenceIds.length,
      corrections: corrections.length, candidates: gate.candidateCount, unattested: !!written.unattested
    });
    return {
      ok: true, outcome: written.outcome, characterId: owner,
      id: written.id, docRevision: written.docRevision, historyLength: written.historyLength,
      evidenceIds: evidenceIds, corrections: corrections.length, unattested: !!written.unattested,
      revision: written.revision, accepted: accepted
    };
  }

  /* 重复计数用的候选条目：canonical memories（与桌面读的是同一批事实）。 */
  async function lookupMemoryEntries() {
    const rows = readMemories();
    return rows.ok ? rows.records : [];
  }

  /* ── 角色枚举：调度器扫描的对象 ──────────────────────────────────────
     只扫**已发布且可运行**的角色（有 runtime spec）。没有角色配置的
     目录条目不是"暂时跳过"，而是"这个宿主上不存在可派生的角色"。 */
  function eligibleCharacters() {
    if (!registry || typeof registry.listCharacters !== 'function') return [];
    let rows = [];
    try { rows = registry.listCharacters() || []; } catch (error) { return []; }
    return rows.filter(r => r && r.forTurn).map(r => String(r.id)).filter(Boolean);
  }

  /* ── 一轮扫描（调度器调用；也可被显式调用）─────────────────────────
     返回每个角色的结果，便于诊断与测试断言"到底谁被跳过了、为什么"。 */
  async function tick(options) {
    options = options || {};
    stats.ticks++;
    if (!isReady()) return { ok: false, error: 'derivation-not-ready', results: [] };
    const targets = options.characterId ? [String(options.characterId)] : eligibleCharacters();
    const results = [];
    for (const id of targets) {
      stats.considered++;
      let res;
      try {
        res = await derive(id, options);
      } catch (error) {
        stats.failures++;
        logger('understanding-tick-failed', { characterId: id, error: String((error && error.message) || error).slice(0, 300) });
        res = { ok: false, outcome: 'failed', characterId: id, error: String((error && error.message) || error).slice(0, 300) };
      }
      results.push(res);
    }
    return { ok: true, results: results, characters: targets.length };
  }

  /* ── 调度器：常驻扫描 + 持久水位 ─────────────────────────────────────
     为什么是 interval 而不是 cron/队列：本仓库已有 in-process setInterval
     （mobile-gateway 的清理与心跳），因此不引入第二套调度框架（M1-C.2m §6）。
     两点严格纪律：
       · 定时器 `unref()` —— 测试 harness 必须能自然退出（仓库测试纪律）；
       · 扫描**不等于**派生 —— 真正的节流在持久水位里，因此把扫描频率调高
         不会增加 token 消耗。 */
  let timer = null;
  function start(options) {
    options = options || {};
    if (timer) return { ok: true, alreadyRunning: true, intervalMs: options.intervalMs || DEFAULT_TICK_INTERVAL_MS };
    const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_TICK_INTERVAL_MS;
    timer = setInterval(() => {
      tick(options).then(res => {
        if (res && res.ok) {
          const acted = (res.results || []).filter(r => r && r.outcome !== 'ineligible');
          if (acted.length) logger('understanding-schedule', { characters: res.characters, acted: acted.length });
        }
      }, error => logger('understanding-schedule-failed', { error: String((error && error.message) || error) }));
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { ok: true, alreadyRunning: false, intervalMs: intervalMs };
  }
  function stop() {
    if (!timer) return { ok: true, alreadyStopped: true };
    clearInterval(timer);
    timer = null;
    return { ok: true };
  }
  function isRunning() { return !!timer; }

  function diagnostics() {
    return {
      ready: isReady(),
      running: isRunning(),
      minIntervalMs: minIntervalMs,
      candidateWindow: candidateWindow,
      inFlight: Array.from(inFlight),
      stats: Object.assign({}, stats)
    };
  }

  return {
    store: store,
    memoryStore: memoryStore,
    isReady: isReady,
    eligibility: eligibility,
    derive: derive,
    tick: tick,
    start: start,
    stop: stop,
    isRunning: isRunning,
    eligibleCharacters: eligibleCharacters,
    candidatesFor: candidatesFor,
    diagnostics: diagnostics,
    stats: stats,
    nonSemantic: nonSemantic,
    UNDERSTANDING_MIN_INTERVAL_MS: minIntervalMs,
    UNDERSTANDING_CANDIDATE_WINDOW: candidateWindow
  };
}

module.exports = createUnderstandingDerivation;
module.exports.nonSemantic = nonSemantic;
module.exports.UNDERSTANDING_MIN_INTERVAL_MS = UNDERSTANDING_MIN_INTERVAL_MS;
module.exports.UNDERSTANDING_CANDIDATE_WINDOW = UNDERSTANDING_CANDIDATE_WINDOW;
module.exports.DEFAULT_TICK_INTERVAL_MS = DEFAULT_TICK_INTERVAL_MS;
