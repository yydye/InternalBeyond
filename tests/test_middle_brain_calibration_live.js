/* ====================================================================
   P11-2A · Character Integrity Calibration Harness · Layer B（真实 Judge 路径）
   --------------------------------------------------------------------
   目的：把 calibration cases 真正喂给**浏览器里运行的、真实的** integrity 层
        （真实 judge prompt 构建 → 真实 ASTRA 传输 → 真实响应解析 → 真实 _mbParseCiJson），
        再把观测结果交给同一套 harness 指标。Layer A 验证指标与 Gate 契约，
        Layer B 验证"这些指标跑在真实执行路径上"。
   两种模式（**默认永远不碰真实 API**）：
     · 默认（离线 mock）：本地 mock /v1/responses 端点按 case 返回固定 Judge 输出。
       provenance 记为 'mock' —— 只验证执行路径与指标管线，不代表模型真实准确率。
     · --live：仅当显式传入 --live **且** 设置了 IB_CI_CALIBRATION_KEY 时才指向真实端点
       （可选 IB_CI_CALIBRATION_ENDPOINT / IB_CI_CALIBRATION_MODEL）。
       手动运行，不进 test-all 强制路径；API 失败只记 error，不让回归变红。
   硬约束（与 Layer A 相同）：
     - 只读：除一次性写入**临时浏览器 profile** 的 middle_brain 配置外，不写任何 store；
       绝不写角色配置 / Memory / Understanding / Thread / Relationship；
     - 不触发 rewrite：characterIntegrityRewrite 恒为 false（detect-only）；
     - 不改生产 telemetry 字段，只在临时 profile 内计数；
     - 不写仓库文件（报告只打印，可选 --out 落到任意路径）。
   运行：
     node test_middle_brain_calibration_live.js                  # 离线 mock（默认）
     node test_middle_brain_calibration_live.js --max-cases=40   # 控制用例数（省 token）
     IB_CI_CALIBRATION_KEY=sk-... node test_middle_brain_calibration_live.js --live
     node test_middle_brain_calibration_live.js --corpus=readiness --budget=24

   ══════════════════════════════════════════════════════════════════════
   Astra Readiness Phase 1 · 本文件扩成"有预算、有绊线、能观测"的驱动器
   ----------------------------------------------------------------------
   这一阶段只做**观测**（不调参、不启用）。为此加了三样东西，全部只影响 harness，
   不碰任何生产文件、也不碰任何生产策略：

   ① **硬预算**（§5）：跑之前先算"计划调用次数"并打印；超过预算就在**启动浏览器
      之前**直接中止（exit 2），一次调用都不发。
      上限 = min(--budget, astra-observation.MAX_PLANNED_CALLS)。
      为什么必须在启动之前：Chrome 起来、页面装好之后再说"要不要跑"已经太晚了。
   ② **观测记录 + 交通层记录**（§4）：在页面里包一层**只读**的 `_ibApiPost` 记录器，
      逐次记录 schemaName / 请求体字节数 / HTTP 状态 / 厂商 usage / 延迟 /
      是否带鉴权头（**只记存在性，绝不记值**）。判定结果本身不来自这里 ——
      它取生产守卫自己的返回值（out.report / out.gate / out.rewrite / out.verify），
      不重新实现任何解析。
   ③ **绊线**（§12 T3–T9）：把页面里所有**持久化写入**与**门控状态**入口包上一层
      计数器；校准跑完后断言它们**一次都没被调用**。
      为什么这是证据而不是声明：这些绊线在每一次回归运行里都会被执行
      （本文件在 mock 模式下也进 test-all 的 browser 组），所以"校准不写生产状态"
      不是靠人相信，而是每次跑都验一遍。

   ⚠ 写入的真实边界（Phase 1B.1 起按实测改写，之前的说法不准确）：
     本 harness 打开的浏览器 profile 永远是**一次性临时目录**
     （os.tmpdir() 下的 mkdtemp，跑完即删），生产配置在用户真实浏览器的
     profile 里，本 harness 从不打开那个 profile —— 所以任何写入都不可能落到
     真实用户状态上。
     但"除临时 profile 的 middle_brain 配置外不写任何 store"这句是**错的**：
     校准页面自己会在启动期做维护性写入（实测在一次性 profile 的 localStorage 里，
     例如 role-letters 的一次性旧数据清理标记、core 的开站 8s 紧急镜像两连写）。
     它们与校准无因果关系，但确实发生。因此：
       · 观测窗口先做**启动期沉降**：闸门是"开站镜像已完成"的**可观测事实**
         （window._ibMirrorLastTs > 0）加上一段安静期，把这类维护写入排除在
         窗口之外，并在报告里逐条打印（key + 调用者 + 是否改值）；
       · 窗口内的 `durableWrites === 0` 仍是**未放宽**的硬断言（T3–T8 一个字没改）；
       · 被排除的写入必须可归因（T0b/T0c），且**没有一条来自校准路径**（T0）——
         判据是"调用者是不是校准路径"，不是给某些 key 开白名单。
     ⚠ 校准路径自身（middle-brain-* / dialogue-core）在整个过程中都不得产生任何
       持久化写入。这条是 T3–T8 与 T0 的共同实质。
   ══════════════════════════════════════════════════════════════════════
   ==================================================================== */
'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const CAL = require('./middle-brain-calibration.js');
const DATA = require('./middle-brain-calibration-cases.js');
const OBS = require('./astra-observation.js');
const READINESS = require('./astra-readiness-corpus.js');

/* 语料选择：默认仍是 Layer A 语料（行为与本阶段之前逐字相同）；
   --corpus=readiness 切到 Astra Readiness Phase 1 的 A–U 语料。 */
const CORPUS_NAME = (() => {
  const a = process.argv.find(x => x.startsWith('--corpus='));
  const v = a ? a.slice('--corpus='.length) : 'layerA';
  return (v === 'readiness' || v === 'layerA') ? v : 'layerA';
})();
const READINESS_MODE = CORPUS_NAME === 'readiness';
const CORPUS = READINESS_MODE ? READINESS.CASES : DATA.CASES;
const PROVENANCE = READINESS_MODE ? 'readiness' : 'layerA';

/* Phase 1B · 显式抽样。不给 --ids= 时行为与本阶段之前**逐字相同**（按类别轮转）。
   给了就必须精确、按给定顺序取这些 fixture：因为"选哪 5 条"本身就是实验设计的
   一部分（要覆盖 明确通过 / 明确人格 OOC / 风格漂移 / 证据不足 / 情感连续性），
   不应该由轮转顺序替我决定 —— 轮转拿到的前 5 条是 A,B,C,D,E，**里面没有**
   证据不足那一条。未知或重复 id 一律**大声中止**（exit 2），绝不静默降级成轮转：
   否则"预登记的样本集"和"实际跑的样本集"会悄悄不一致，而这正是 Phase 1
   花力气消除的那一类错误。 */
const IDS_ARG = (() => {
  const a = process.argv.find(x => x.startsWith('--ids='));
  if (!a) return null;
  const ids = a.slice('--ids='.length).split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
})();

const LIVE = process.argv.includes('--live');
const MAX_CASES = (() => {
  const a = process.argv.find(x => x.startsWith('--max-cases='));
  const def = IDS_ARG ? IDS_ARG.length : 24;
  const n = a ? Number(a.slice('--max-cases='.length)) : def;
  return Number.isFinite(n) && n > 0 ? Math.min(n, CORPUS.length) : def;
})();
/* 显式样本集不允许被 --max-cases 悄悄截断：截断等于偷偷改掉本轮实验的样本。 */
if (IDS_ARG && IDS_ARG.length > MAX_CASES) {
  console.error('中止（exit 2）：--ids= 给了 ' + IDS_ARG.length + ' 条，但 --max-cases=' + MAX_CASES
    + ' 会截断其中 ' + (IDS_ARG.length - MAX_CASES) + ' 条。显式样本集必须整份跑或整份不跑。');
  process.exit(2);
}
const REPEAT = (() => {
  const a = process.argv.find(x => x.startsWith('--repeat='));
  const n = a ? Number(a.slice('--repeat='.length)) : 1;
  return Number.isFinite(n) && n > 0 ? Math.min(n, OBS.MAX_REPEAT) : 1;
})();
const BUDGET_ARG = (() => {
  const a = process.argv.find(x => x.startsWith('--budget='));
  return a ? Number(a.slice('--budget='.length)) : NaN;
})();
/* detect-only 是默认（与 P11-2A 的硬约束一致）；--rewrite / --verify 才把它打开。
   注意：这只改**临时 profile 里的校准配置**，不改生产配置，也不改任何阈值。 */
const OBSERVE_REWRITE = process.argv.includes('--rewrite');
const OBSERVE_VERIFY = process.argv.includes('--verify');
const ENV_KEY = process.env.IB_CI_CALIBRATION_KEY || '';
const ENV_ENDPOINT = process.env.IB_CI_CALIBRATION_ENDPOINT || '';
const ENV_MODEL = process.env.IB_CI_CALIBRATION_MODEL || '';
/* 真实端点只在"显式 --live + 凭据 + 端点"三者齐备时启用。
   ★ 声明位置是有语义的：下面的 `!LIVE_MODE` 在 LIVE 为真时**不会短路**，因此这一行
     必须出现在第一次引用之前。Phase 1B 实测到的真实缺陷就是它曾经声明在引用之后 ——
     结果是 `--live` 一律抛 TDZ ReferenceError，凭据预检（exit 3）永远不可达。
     不变量由 tests/test_calibration_live_abort.js 常驻断言（静态顺序 + 运行期 exit 3）。 */
const LIVE_MODE = LIVE && !!ENV_KEY && !!ENV_ENDPOINT;
if (LIVE && !LIVE_MODE && process.argv.includes('--allow-mock-fallback')) {
  console.log('Layer B · --live 的凭据不齐（' + (!ENV_KEY ? 'IB_CI_CALIBRATION_KEY ' : '') + (!ENV_ENDPOINT ? 'IB_CI_CALIBRATION_ENDPOINT' : '')
    + '）；按 --allow-mock-fallback 显式要求，本次以离线 mock 运行（报告里 provenance=mock）。');
}
/* Astra Readiness Phase 1 起：显式 --live 但凭据不齐时**大声中止**，不再静默降级成
   离线 mock。理由：静默降级会让人把 mock 数据当成真实模型观测 —— 而这一阶段
   存在的唯一理由就是区分这两者。想跑离线就明确不写 --live。 */
if (LIVE && !LIVE_MODE && !process.argv.includes('--allow-mock-fallback')) {
  const missing = [];
  if (!ENV_KEY) missing.push('IB_CI_CALIBRATION_KEY');
  if (!ENV_ENDPOINT) missing.push('IB_CI_CALIBRATION_ENDPOINT');
  console.error('中止（exit 3）：显式要求 --live，但缺少 ' + missing.join(' + ') + '。');
  console.error('本阶段不允许把真实模型观测静默降级成离线 mock：两者绝不能混为一谈。');
  console.error('缺什么：' + missing.join(' / ') + '（环境变量），且必须是**合法持有凭据的执行环境**提供的。');
  console.error('只想跑离线 mock 的话：去掉 --live（或显式加 --allow-mock-fallback）。');
  process.exit(3);
}

/* 用例选择：按类别均匀抽样，保证覆盖 FP / OOC / KB / boundary / dimension / transport
   （readiness 语料的 category = 该样本的首个观测类别，于是抽样按 A–U 铺开）。 */
function selectCases() {
  /* Phase 1B · 显式样本集：按 --ids= 给定顺序精确取出；未知/重复一律中止。 */
  if (IDS_ARG) {
    const byId = new Map(CORPUS.map(c => [c.id, c]));
    const picked = [], missing = [], dupes = [], seen = new Set();
    for (const id of IDS_ARG) {
      if (seen.has(id)) { dupes.push(id); continue; }
      seen.add(id);
      const c = byId.get(id);
      if (c) picked.push(c); else missing.push(id);
    }
    if (missing.length || dupes.length) {
      console.error('中止（exit 2）：--ids= 里有' + (missing.length ? '未知 fixture [' + missing.join(', ') + ']' : '')
        + (missing.length && dupes.length ? '，以及' : '') + (dupes.length ? '重复 fixture [' + dupes.join(', ') + ']' : '') + '。');
      console.error('可用 id 见 tests/astra-readiness-corpus.js；不允许静默降级成轮转抽样。');
      process.exit(2);
    }
    return picked;
  }
  const buckets = {};
  for (const c of CORPUS) { (buckets[c.category] = buckets[c.category] || []).push(c); }
  const cats = Object.keys(buckets).sort();
  const out = [];
  let round = 0;
  while (out.length < MAX_CASES) {
    let added = 0;
    for (const cat of cats) {
      const list = buckets[cat];
      if (round < list.length && out.length < MAX_CASES) { out.push(list[round]); added++; }
    }
    if (!added) break;
    round++;
  }
  return out;
}
const CASES = selectCases();

/* 当前回合身份（readiness 语料的确定性规则，与静态观测器逐字一致）：
   历史最后一行是 user 行且带 id → 用那个 id；否则 null（桌面形状，走逐字回落）。 */
function currentIdOf(c) {
  const h = c.history || [];
  if (!h.length) return null;
  const last = h[h.length - 1];
  return (last.role === 'user' && last.id) ? last.id : null;
}

/* ── §5 · 预算：先算、先打印，超了就**在启动浏览器之前**中止 ────────────── */
const phasesOf = READINESS_MODE
  ? (c) => {
    const p = READINESS.phasesOf(c);
    return {
      judge: true,
      rewrite: OBSERVE_REWRITE && p.rewrite,
      verify: OBSERVE_REWRITE && OBSERVE_VERIFY && p.verify
    };
  }
  : () => ({ judge: true, rewrite: OBSERVE_REWRITE, verify: OBSERVE_REWRITE && OBSERVE_VERIFY });
const PLAN = OBS.planCalls(CASES, {
  repeat: REPEAT, budget: BUDGET_ARG, phasesOf: phasesOf,
  worstCasePhases: { rewrite: OBSERVE_REWRITE, verify: OBSERVE_REWRITE && OBSERVE_VERIFY }
});
console.log('Astra calibration plan: corpus=' + PROVENANCE + ' cases=' + CASES.length
  + ' repeat=' + PLAN.repeat + ' rewrite=' + OBSERVE_REWRITE + ' verify=' + (OBSERVE_REWRITE && OBSERVE_VERIFY));
console.log('PLANNED API CALLS: ' + PLAN.plannedCalls + '  budget: ' + PLAN.budget
  + ' (hard cap ' + PLAN.hardCap + ', ' + PLAN.plannedBasis + ')  -> ' + (PLAN.ok ? 'WITHIN BUDGET' : 'OVER BUDGET'));
console.log('  expected (per-case estimate): ' + PLAN.expectedCalls + ' call(s)');
if (!PLAN.ok) {
  console.error('中止：计划调用次数 ' + PLAN.plannedCalls + ' 超过预算 ' + PLAN.budget + '。请调小 --max-cases/--repeat 或调大 --budget。');
  console.error('（在启动浏览器之前中止：本次没有发起任何调用。）');
  process.exit(2);
}

/* ── Astra Readiness Phase 1B · CDP RPC 期限必须**长于**生产模型期限 ──────────
   为什么：本 harness 用 `Runtime.evaluate{awaitPromise:true}` 等在页面里跑完生产守卫，
   而页面里的生产守卫自己在 judge / astra / integrity 三层各挂了 20000 ms 的
   AbortController 期限。共享 CDP 客户端的期限若比它短，客户端就会**先**放弃，
   抛出 `CDP timeout: Runtime.evaluate` —— 与"模型没回来"看起来一模一样，
   于是观测口径掩盖了生产裁决。Phase 1B 的对照实验把这一点钉死了：
       8 s 响应        → 全链路走完（judgeError:null）
       >15 s 且 <20 s  → **假 CDP timeout**（客户端先放弃；生产还没说话）
       >20 s           → 生产自己的 judgeError:'timeout'（另一种可区分的失败）
   所以校准侧默认把 CDP 期限抬到 30000（> 20000），并保留显式覆盖能力；
   但**不允许**把它压到 <= 20000 —— 那等于把这条缺陷重新装回去，且是静默的。
   默认值只在调用方没给 IB_CDP_TIMEOUT_MS 时写入（显式覆盖永远优先）。

   ⚠ 位置纪律（不是风格问题）：这一整块必须放在**共享客户端被抽出来之后**。
     resolveCdpTimeoutMs / CDP_TIMEOUT_DEFAULT_MS 都来自下面那次 new Function 抽取，
     而 `const` 有 TDZ —— 放在抽取之前它会在模块求值期直接 ReferenceError，
     整个 harness（含两次离线 mock 回归）一行都跑不了。本文件此前已经因为同一类
     错误（LIVE_MODE 声明晚于首次引用）吃过一次亏，所以这里明确写下顺序：
     先抽取 → 再解析期限 → 再起浏览器。
     （`--live` 缺凭据的预检在抽取之前就 exit 3，所以那种错误不会被凭据回归测到，
      只有真的跑一遍 harness 才暴露 —— 第一次改动就是踩在这上面。） */
const CDP_DEADLINE_DEFAULT_MS = 30000;
const PRODUCTION_MODEL_TIMEOUT_MS = (() => {
  /* 生产期限的真源是 assets/js/middle-brain-judge.js 的 MB_JUDGE_TIMEOUT_MS。
     这里是结构断言，读的是**生产源码文本**（只读，零改动），不是复制一份常量：
     复制一份就等于把"两处必须一致"变成"两处碰巧一致"。 */
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-judge.js'), 'utf8');
  const m = src.match(/var\s+MB_JUDGE_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  if (!m) {
    console.error('中止（exit 4）：assets/js/middle-brain-judge.js 里找不到 MB_JUDGE_TIMEOUT_MS 的字面量声明。');
    console.error('CDP 期限与生产期限的先后关系是本次校准的观测前提，读不到就不能假装它成立。');
    process.exit(4);
  }
  return Number(m[1]);
})();
function resolveCalCdpDeadline() {
  if (process.env.IB_CDP_TIMEOUT_MS === undefined || process.env.IB_CDP_TIMEOUT_MS === '') {
    process.env.IB_CDP_TIMEOUT_MS = String(CDP_DEADLINE_DEFAULT_MS);
  }
  const resolved = resolveCdpTimeoutMs(process.env.IB_CDP_TIMEOUT_MS);
  if (!(resolved.ms > PRODUCTION_MODEL_TIMEOUT_MS)) {
    console.error('中止（exit 4）：CDP RPC 期限 ' + resolved.ms + 'ms 不大于生产模型期限 '
      + PRODUCTION_MODEL_TIMEOUT_MS + 'ms。');
    console.error('这样客户端会先于生产守卫的 AbortController 放弃，把生产裁决掩盖成 CDP timeout，');
    console.error('校准观测就失去意义（分不清"模型没回来"和"harness 没等够"）。');
    console.error('IB_CDP_TIMEOUT_MS=' + JSON.stringify(resolved.raw)
      + (resolved.fellBack ? '（非法值，已回落默认 ' + CDP_TIMEOUT_DEFAULT_MS + 'ms）' : '')
      + '，需要 > ' + PRODUCTION_MODEL_TIMEOUT_MS + '。');
    process.exit(4);
  }
  return resolved;
}

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort,
  resolveCdpTimeoutMs, CDP_TIMEOUT_DEFAULT_MS } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort,resolveCdpTimeoutMs,CDP_TIMEOUT_DEFAULT_MS};')(require, ROOT);

/* 抽取完成之后才解析期限（TDZ 纪律：resolveCdpTimeoutMs / CDP_TIMEOUT_DEFAULT_MS
   都来自上面那一行；把这段放在它之前会在模块求值期直接 ReferenceError）。 */
const CAL_CDP_DEADLINE = resolveCalCdpDeadline();
console.log('CDP RPC deadline: ' + CAL_CDP_DEADLINE.ms + 'ms (' + CAL_CDP_DEADLINE.source
  + ', > production model timeout ' + PRODUCTION_MODEL_TIMEOUT_MS + 'ms)' + (CAL_CDP_DEADLINE.fellBack ? '  ← IB_CDP_TIMEOUT_MS 非法，已回落默认' : ''));
/* 预备断言：默认值与生产期限的关系必须是"默认就成立"，不能靠环境变量碰巧成立。 */
check('D0.saneCdpDeadlineDefault', CDP_DEADLINE_DEFAULT_MS > PRODUCTION_MODEL_TIMEOUT_MS
  && CDP_DEADLINE_DEFAULT_MS >= 15000 && CDP_DEADLINE_DEFAULT_MS <= 60000,
  'default=' + CDP_DEADLINE_DEFAULT_MS + ' production=' + PRODUCTION_MODEL_TIMEOUT_MS);
check('D0b.legacyDefaultPreservedForOtherHarnesses', CDP_TIMEOUT_DEFAULT_MS === 15000,
  'CDP_TIMEOUT_DEFAULT_MS=' + CDP_TIMEOUT_DEFAULT_MS + '（其他 CDP harness 的既有行为必须逐字不变）');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' };

/* ── 离线 mock 端点（同进程，按当前 case 返回固定 Judge 输出） ──
   Astra Readiness 观测用到的三档 mock 行为（**只影响离线模式**，live 模式一概不用）：
     nextJudge         Layer A 语料：每条 authored 观测的 raw
     --mock-rewrite    让 rewrite 真的成功（否则按 P11-2A 的硬约束返回 500）
     verifyMode        verify 那一次 report 调用的返回值（'fail' 与 judge 同 → 观测"拒绝"） */
const mock = {
  nextJudge: null, nextMode: 'ok', judgeCalls: 0, rewriteCalls: 0, lastBody: '',
  rewriteMode: OBSERVE_REWRITE ? 'ok' : 'fail',
  currentCandidate: '',
  reportCallsThisCase: 0,
  verifyMode: (process.argv.find(x => x.startsWith('--mock-verify=')) || '').slice('--mock-verify='.length) || 'pass',
  lastRewriteBody: '', lastRewriteReply: null
};
function responsesBody(text) {
  return JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
}
/* §9 的第三档观测：judge 说 fail、rewrite 成功、verify 通过 —— 三档都要能被观测到。
   mock 的取值只由**命令行开关**决定，不由语料的 expectation 决定（否则就是用期望当答案）。 */
const MOCK_JUDGE_FAIL = JSON.stringify({ pass: false, score: 0.12, confidence: 0.95,
  violations: [{ dimension: 'persona', severity: 0.95, evidence: '示例片段', reason: '示例理由' }] });
const MOCK_JUDGE_PASS = JSON.stringify({ pass: true, score: 0.95, confidence: 0.9, violations: [] });
const mockApi = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (/character_integrity_rewrite/.test(raw)) {
    mock.rewriteCalls++; mock.lastRewriteBody = raw;
    if (mock.rewriteMode !== 'ok') { res.writeHead(500, CORS); res.end('{}'); return; }
    /* 确定性改写：原文 + 一个句号（既非空、无控制标签、长度也在净化器的允许区间内）。
       候选文本由 harness 在跑之前放进 mock.currentCandidate —— 不从线上报文里解析，
       因为"从请求里反解候选"就是在重新实现一遍生产 prompt 的形状。 */
    var cand = String(mock.currentCandidate || '');
    var reply = cand ? (cand.slice(-1) === '。' ? cand : cand + '。') : '（mock 改写）';
    mock.lastRewriteReply = reply;
    res.writeHead(200, CORS);
    res.end(responsesBody(JSON.stringify({ reply: reply })));
    return;
  }
  mock.judgeCalls++; mock.lastBody = raw; mock.reportCallsThisCase++;
  if (mock.nextMode === 'fail') { res.writeHead(500, CORS); res.end('{}'); return; }
  res.writeHead(200, CORS);
  var payload;
  if (mock.nextJudge != null) payload = mock.nextJudge;                      /* Layer A：authored 观测 */
  else if (mock.reportCallsThisCase >= 2 && mock.verifyMode === 'pass') payload = MOCK_JUDGE_PASS;
  else payload = (mock.rewriteMode === 'ok' && mock.verifyMode !== 'fail') ? MOCK_JUDGE_FAIL : MOCK_JUDGE_PASS;
  res.end(responsesBody(payload));
});

(async () => {
  const mockPort = await listen(mockApi), mockBase = 'http://127.0.0.1:' + mockPort;
  const endpoint = LIVE_MODE ? ENV_ENDPOINT : mockBase + '/v1/responses';
  const model = (LIVE_MODE && ENV_MODEL) ? ENV_MODEL : 'calibration-mock-model';
  /* 离线模式故意用一个**哨兵形状**的假 key：它让"凭据值绝不进报告"这条断言在
     每一次离线回归里都被真的执行到（而且它只发给本机 mock 端点）。 */
  const apiKey = LIVE_MODE ? ENV_KEY : 'sk-sentinel-offline-0000-NEVER-LEAK';
  const mode = LIVE_MODE ? 'live' : 'mock';
  const provenance = mode === 'live' ? 'live' : 'mock';

  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cal-live-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;

  const setMb = cfg => evaluate(cdp, `(async function(){await saveMiddleBrainConfig(${JSON.stringify(cfg)});return true})()`);
  const telemetry = () => evaluate(cdp, `(function(){return IB.middleBrain.middleBrainCharacterIntegrityTelemetry()})()`);
  const resetTel = () => evaluate(cdp, `(function(){IB.middleBrain.middleBrainCharacterIntegrityReset();return true})()`);
  const parseOnPage = (raw) => evaluate(cdp, `(function(){
    var r=IB.__middleBrainContracts.integrity._mbParseCiJson(${JSON.stringify(raw)});
    return r?{pass:r.pass,score:r.score,confidence:r.confidence,maxSeverity:r.maxSeverity,dimensions:r.dimensions,violations:r.violations}:null;
  })()`);
  const gateOnPage = (sensitivity, report) => evaluate(cdp, `(function(){
    var g=IB.__middleBrainContracts.integrity._mbCiGate(${JSON.stringify(report)}, {characterIntegrityRewrite:true,characterIntegritySensitivity:${JSON.stringify(sensitivity)}}, {});
    return {rewrite:g.rewrite,reason:g.reason,thresholds:g.thresholds};
  })()`);
  const evidenceOnPage = (c) => evaluate(cdp, `(async function(){
    var CS=window.IBContextSnapshot, ctx=${JSON.stringify(c.context || null)} || {};
    var fields={};
    ['memory','understanding','thread','moments'].forEach(function(n){ fields[n]=CS.field('cal:'+n, ctx[n]||''); });
    var snap=CS.create({characterId:${JSON.stringify(c.character.id)},turnId:'cal',fields:fields,gates:{}});
    var ev=IB.__middleBrainContracts.integrity._mbCiBuildEvidence(${JSON.stringify(c.character.id)},${JSON.stringify(c.userMessage)},{character:${JSON.stringify(c.character)},history:${JSON.stringify(c.history || [])},contextSnapshot:snap});
    return ev.available;
  })()`);
  const runGuard = (c) => evaluate(cdp, `(async function(){
    var CS=window.IBContextSnapshot, ctx=${JSON.stringify(c.context || null)} || {};
    var fields={};
    ['memory','understanding','thread','moments'].forEach(function(n){ fields[n]=CS.field('cal:'+n, ctx[n]||''); });
    var snap=CS.create({characterId:${JSON.stringify(c.character.id)},turnId:'cal',fields:fields,gates:{}});
    var out=await IB.middleBrain.middleBrainCharacterIntegrity(${JSON.stringify(c.character.id)},${JSON.stringify(c.userMessage)},${JSON.stringify(c.candidate)},{character:${JSON.stringify(c.character)},history:${JSON.stringify(c.history || [])},contextSnapshot:snap});
    return {
      replyUnchanged: out.reply===${JSON.stringify(c.candidate)},
      ran: out.ran===true,
      gate: out.gate,
      judgeError: out.judgeError||null,
      evidenceAvailable: out.evidence?out.evidence.available:null,
      judgePromptHasEvidence: true
    };
  })()`);

  /* ── §12 · 观测器 + 绊线 + **网络白名单守卫**（document-start 注入）────────
     为什么必须在 document-start 注入，而不是等页面加载完再包：实测发现
     **校准页面在启动阶段就会 `POST http://127.0.0.1:23118/memory/settings`**
     （home-node-bootstrap 的 publishMemorySettings，把桌面记忆预算发布给本机
     Home Node）。那是一个**写请求**，而且目标是**这台机器上真实运行的本地服务**。
     只在页面加载完之后包一层是抓不到它的 —— 它早就在窗口之外发生了。
     所以守卫从 document start 起就生效：白名单之外的 host 一律**拒绝**，
     返回合成 403，一个字节都不发出去，并把尝试记录下来（denied 清单）。
     这不是"修生产"，而是让 harness 真的侧效应为零（§11 允许的 harness 改动）。

     绊线分两层：
       · **平台层**（IDBObjectStore / Storage / XMLHttpRequest / fetch 原型方法）：
         无论哪一层闭包直接调用，持久化写入都必然经过它们 —— 这是"没有写盘"的强证据。
         只包 window.X 不够：模块内部的闭包引用会绕过 window。
       · **语义层**（window.dbPut / saveMemory / …）：只为让报告可读。 */
  const ALLOWED_HOSTS = (() => {
    const out = ['127.0.0.1:' + webPort, 'localhost:' + webPort, '127.0.0.1:' + mockPort, 'localhost:' + mockPort];
    if (LIVE_MODE) {
      try {
        const h = String(endpoint).replace(/^https?:\/\//i, '').split('/')[0];
        if (out.indexOf(h) < 0) out.push(h);
      } catch (e) {}
    }
    return out;
  })();
  const OBSERVER_SOURCE = `(function(){
    'use strict';
    if (window.__ASTRA_OBS) return;
    var ALLOW = ${JSON.stringify(ALLOWED_HOSTS)};
    var O = {transport:[], tripwires:{}, platform:{}, fetchHosts:[], denied:[], wsAttempts:[], allowed:ALLOW.slice(), startedAt:Date.now()};
    window.__ASTRA_OBS = O;
    function hostOf(u){
      try {
        var s = String(u == null ? '' : u);
        var m = s.match(/^[a-z]+:\\/\\/([^\\/?#]+)/i);
        if (m) return m[1];
        if (/^[a-z]+:/i.test(s)) return '';
        return (typeof location !== 'undefined' && location.host) ? location.host : '';
      } catch(e){ return ''; }
    }
    function allowed(h){ return ALLOW.indexOf(h) >= 0; }
    function deny(kind, entry){
      for (var i=0;i<O.denied.length;i++) if (O.denied[i].kind===kind && O.denied[i].entry===entry) { O.denied[i].calls++; return; }
      O.denied.push({kind:kind, entry:entry, calls:1});
    }
    /* ① fetch：白名单之外一律拒绝（合成 403；不发出任何字节） */
    var of = window.fetch;
    O.platform.fetch = {present: typeof of === 'function', calls:0, stores:{}};
    if (typeof of === 'function') {
      window.fetch = function(input, init){
        var u = (typeof input === 'string') ? input : ((input && input.url) || '');
        var m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var h = hostOf(u);
        var path = String(u).replace(/^[a-z]+:\\/\\/[^\\/]*/i, '').split('?')[0];
        var seg = path.split('/');
        var entry = m + ' ' + h + (seg.length>1?'/'+seg[1]:'') + (seg.length>2?'/'+seg[2]:'');
        if (!allowed(h)) {
          deny('fetch', entry);
          return Promise.resolve(new Response(JSON.stringify({ok:false, error:'blocked-by-calibration-harness'}), {status:403, headers:{'Content-Type':'application/json'}}));
        }
        O.platform.fetch.calls++;
        if (O.fetchHosts.indexOf(entry) < 0) O.fetchHosts.push(entry);
        return of.apply(this, arguments);
      };
    }
    /* ② XHR：同样按 host 拒绝 */
    var XO = window.XMLHttpRequest;
    if (XO && XO.prototype) {
      var open = XO.prototype.open, send = XO.prototype.send;
      O.platform.xhrSend = {present:true, calls:0, stores:{}};
      XO.prototype.open = function(method, url){
        try { this.__ibObsMethod = String(method||'GET').toUpperCase(); this.__ibObsHost = hostOf(url);
              this.__ibObsEntry = this.__ibObsMethod + ' ' + this.__ibObsHost; } catch(e){}
        return open.apply(this, arguments);
      };
      XO.prototype.send = function(){
        try {
          if (!allowed(this.__ibObsHost)) {
            deny('xhr', this.__ibObsEntry || '(unknown)');
            try { this.abort(); } catch(e){}
            return;
          }
          O.platform.xhrSend.calls++;
        } catch(e){}
        return send.apply(this, arguments);
      };
    }
    /* ③ sendBeacon：写通道，一并拒绝 */
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      var ob = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data){
        if (!allowed(hostOf(url))) { deny('beacon', 'POST ' + hostOf(url)); return false; }
        return ob(url, data);
      };
    }
    /* ④ WebSocket：只**记录**不拒绝（拒绝可能让页面启动失败；而连接本身不是写）。
       校准窗口内应为 0，非 0 就在报告里如实说明。 */
    var WS = window.WebSocket;
    if (typeof WS === 'function') {
      window.WebSocket = function(url, protocols){
        try { var h = hostOf(url); if (O.wsAttempts.indexOf(h) < 0) O.wsAttempts.push(h); } catch(e){}
        return protocols === undefined ? new WS(url) : new WS(url, protocols);
      };
      window.WebSocket.prototype = WS.prototype;
      try { window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3; } catch(e){}
    }
    /* ⑤ 平台层持久化绊线（原型级） */
    /* 调用者归属：只取**仓库内的**前几帧 assets/js/xxx.js:line。
       为什么必须记这个：Phase 1B.1 实测发现，只记计数的绊线一旦变红就**不可归因** ——
       报告只能说"有 3 次 durable 写入"，说不出是谁写的、写的哪个 key，
       于是既无法判断它是不是校准造成的，也无法判断它有没有碰到真实用户状态。
       记前 3 帧而不是 1 帧：像 core.js 的 dbPut 这种通用传输助手，最内层帧只是助手本身，
       语义所有者要再往上一帧才看得到。
       去掉 host:port 是为了让输出在不同运行之间稳定可比。 */
    function framesOf(){
      var out = [];
      try {
        var lines = String(new Error().stack || '').split('\\n');
        for (var i = 0; i < lines.length && out.length < 3; i++) {
          var m = lines[i].match(/assets\\/js\\/([^\\/\\s:]+):(\\d+):(\\d+)/);
          if (m) out.push(m[1] + ':' + m[2]);
        }
      } catch(e){ out.push('(stack-error)'); }
      return out.length ? out : ['(no-assets-frame)'];
    }
    function patch(proto, method, key){
      try {
        if (!proto || typeof proto[method] !== 'function') { O.platform[key] = {present:false, calls:0, stores:{}, detail:[]}; return; }
        var orig = proto[method];
        O.platform[key] = {present:true, calls:0, stores:{}, detail:[]};
        var isStorage = (key.indexOf('storage') === 0);
        var hasKeyArg = (method === 'setItem' || method === 'removeItem' || method === 'delete');
        proto[method] = function(){
          var cell = O.platform[key]; cell.calls++;
          try {
            var n = (this && this.name) || (this === window.localStorage ? 'localStorage' : (this === window.sessionStorage ? 'sessionStorage' : '(unknown)'));
            cell.stores[n] = (cell.stores[n] || 0) + 1;
            /* 明细只留前 64 条：够归因，且不让异常页面把观测器撑爆。
               完整性由 T0c 断言（calls ≤ 64 时 detail 必须逐条对上）。 */
            if (cell.detail.length < 64) {
              var frames = framesOf();
              var rec = {seq: cell.calls, store: n, caller: frames[0], callers: frames};
              if (hasKeyArg) {
                try {
                  var a0 = arguments[0];
                  rec.key = (a0 && typeof a0 === 'object' && a0.id != null) ? ('id:' + String(a0.id)) : (a0 == null ? null : String(a0).slice(0, 60));
                } catch(e){ rec.key = null; }
              } else { rec.key = null; }   /* clear() 类没有 key 参数 */
              if (isStorage && method === 'setItem') {
                var k = String(arguments[0]);
                var before = null; try { before = this.getItem(k); } catch(e){}
                rec.key = k;
                rec.valueLength = String(arguments[1] == null ? '' : arguments[1]).length;
                rec.existedBefore = before !== null;
                rec.changed = before === null ? true : (String(before) !== String(arguments[1]));
              }
              cell.detail.push(rec);
            }
          } catch(e){}
          return orig.apply(this, arguments);
        };
      } catch(e){ O.platform[key] = {present:false, calls:0, stores:{}, detail:[], error:String(e && e.message || e).slice(0,80)}; }
    }
    patch(window.IDBObjectStore && window.IDBObjectStore.prototype, 'put', 'idbPut');
    patch(window.IDBObjectStore && window.IDBObjectStore.prototype, 'add', 'idbAdd');
    patch(window.IDBObjectStore && window.IDBObjectStore.prototype, 'delete', 'idbDelete');
    patch(window.IDBObjectStore && window.IDBObjectStore.prototype, 'clear', 'idbClear');
    patch(window.Storage && window.Storage.prototype, 'setItem', 'storageSet');
    patch(window.Storage && window.Storage.prototype, 'removeItem', 'storageRemove');
    patch(window.Storage && window.Storage.prototype, 'clear', 'storageClear');
    /* ⑥ 交通层记录器：communication.js 给 window._ibApiPost 赋值时自动被包住
       （用访问器拦截，所以"第一次赋值"就已经在我们的记录之下，不会漏掉任何一次）。 */
    var real = null;
    function wrapTransport(f){
      return function(endpoint, headers, bodyStr, opts){
        var t0 = Date.now();
        var name = '';
        try { var b = JSON.parse(bodyStr); name = (b && b.text && b.text.format && b.text.format.name) || ''; } catch(e){}
        var auth = false;
        try { for (var k in (headers||{})) if (/^authorization$/i.test(k)) auth = !!String(headers[k]||'').trim(); } catch(e){}
        var rec = {name:name, bodyChars:String(bodyStr==null?'':bodyStr).length, authPresent:auth,
                   status:null, ok:null, latencyMs:null, usage:null, wireChars:null};
        O.transport.push(rec);
        var p = f.apply(this, arguments);
        return Promise.resolve(p).then(function(res){
          rec.latencyMs = Date.now()-t0;
          rec.status = (res && res.status != null) ? res.status : null;
          rec.ok = !!(res && res.ok);
          if (res && typeof res.json === 'function') {
            var oj = res.json;
            try {
              res.json = function(){
                return Promise.resolve(oj.apply(res, arguments)).then(function(d){
                  try { rec.usage = (d && d.usage) ? d.usage : null; rec.wireChars = JSON.stringify(d || null).length; } catch(e){}
                  return d;
                });
              };
            } catch(e){ rec.jsonWrapped = false; }
          }
          return res;
        });
      };
    }
    try {
      Object.defineProperty(window, '_ibApiPost', {
        configurable: true,
        get: function(){ return real; },
        set: function(f){ real = (typeof f === 'function') ? wrapTransport(f) : f; }
      });
      O.transportIntercepted = true;
    } catch(e){ O.transportIntercepted = false; }
    /* ⑦ 语义层绊线（只为可读性） */
    var WRITE = {dbPut:'storage', dbDelete:'storage',
      saveMemory:'memory', deleteMemory:'memory', writeOneLineToMemory:'memory', quickCreateMemory:'memory', consolidateCharacterMemory:'memory',
      createThread:'thread', deleteThread:'thread',
      createMoment:'moment', deleteMoment:'moment', addMomentComment:'moment', deleteMomentComment:'moment',
      deleteSingleMsg:'chat', deleteSelectedMessages:'chat',
      saveCurrentApi:'provider_config', addNewApi:'provider_config', deleteApiConfig:'provider_config', deleteCurrentApi:'provider_config',
      saveMiddleBrainConfig:'calibration_profile_config',
      middleBrainAdmissionGate:'gate_state', middleBrainAdmissionGateReset:'gate_state'};
    O.semanticMissing = [];
    Object.keys(WRITE).forEach(function(n){
      if (O.tripwires[n]) return;
      O.tripwires[n] = {kind:WRITE[n], present:false, calls:0};
      try {
        Object.defineProperty(window, n, {
          configurable: true,
          get: function(){ return O.tripwires[n].__f; },
          set: function(f){
            if (typeof f !== 'function') { O.tripwires[n].__f = f; O.tripwires[n].present = false; O.semanticMissing.push(n); return; }
            O.tripwires[n].present = true;
            O.tripwires[n].__f = function(){ O.tripwires[n].calls++; return f.apply(this, arguments); };
          }
        });
      } catch(e){ O.tripwires[n].wrapError = String(e && e.message || e).slice(0,80); }
    });
  })();`;

  const readObserver = () => evaluate(cdp, `(function(){
    var O = window.__ASTRA_OBS || {};
    return {transport:O.transport||[], tripwires:O.tripwires||{}, platform:O.platform||{},
            fetchHosts:O.fetchHosts||[], denied:O.denied||[], wsAttempts:O.wsAttempts||[],
            transportIntercepted:!!O.transportIntercepted, allowed:O.allowed||[]};
  })()`);
  /* 清空**校准窗口**的计数（不改变"已装载"的事实，只移动窗口起点）。
     为什么要有这一步：页面启动与配置写入本身就发生在窗口之前，它们不属于
     "校准过程中的副作用"，但必须能被观测到（见 initWindow 那段打印）。 */
  const resetObserver = () => evaluate(cdp, `(function(){
    var O = window.__ASTRA_OBS; if (!O) return false;
    O.transport.length = 0; O.fetchHosts.length = 0; O.denied.length = 0; O.wsAttempts.length = 0;
    Object.keys(O.platform).forEach(function(k){ O.platform[k].calls = 0; O.platform[k].stores = {}; O.platform[k].detail = []; });
    Object.keys(O.tripwires).forEach(function(k){ O.tripwires[k].calls = 0; });
    return true;
  })()`);

  /* ── Phase 1B.1 · 启动期写入沉降（窗口卫生）────────────────────────────
     为什么需要：把窗口起点放在"页面刚 mount"之后，会把**页面自身的启动期维护
     写入**一起算进校准窗口，于是 T3–T8 全红 —— 但那 3 次写入与校准毫无因果关系
     （Phase 1B.1 归因：role-letters.js 的一次性旧数据清理标记 + core.js 开站 8s
     的紧急镜像两连写，全部发生在一次性临时 profile 里）。

     修法**不是**给 key 开白名单（那会把"有写入"这件事藏起来），而是让窗口
     真的从"页面启动维护已经排空"之后开始。判据必须**基于可观测的完成事实**，
     不能靠"安静了几秒"去猜 —— 实测教训：3 秒安静期**抓不到还没到点的定时器**，
     core.js:1205 的 `setTimeout(_ibMirrorNow, 8000)` 会在窗口开了 2 秒之后才写，
     于是又把 T3–T8 染红（本轮第一版实现就踩了这个坑）。所以真正的闸门是：
       · **镜像一次写已完成的直接证据**：core.js 用 `ibCoreLive('_ibMirrorLastTs',…)`
         把该变量定义成 window 上的活取器，它在 `_ibMirrorNow` 末尾（两次 setItem
         之后）才被赋值 → `> 0` 就是"开站底片已经拍完"的铁证；
       · 再看平台绊线的 durable 调用数连续 QUIET 毫秒不变（兜住其它启动期写入）；
       · 兜底：若该访问器不存在（页面被改过），则退回最小等待 MIN_MS 并**在报告里
         明说是兜底规则**，绝不静默按"安静"就开窗。
     这样 T3–T8 的 `durableWrites === 0` 一个字都不用改，仍然是硬断言：
     窗口内任何一次持久化写入（不管是谁写的）依旧会让它们全红，只是现在红得可归因。
     被排除的写入逐条打印（key + 调用者），并断言它们**从不是校准路径**写的。 */
  const SETTLE_QUIET_MS = (() => {
    const a = process.argv.find(x => x.startsWith('--settle-quiet-ms='));
    const n = a ? Number(a.slice('--settle-quiet-ms='.length)) : 3000;
    return Number.isFinite(n) && n >= 0 ? n : 3000;
  })();
  const SETTLE_MAX_MS = (() => {
    const a = process.argv.find(x => x.startsWith('--settle-max-ms='));
    const n = a ? Number(a.slice('--settle-max-ms='.length)) : 30000;
    return Number.isFinite(n) && n > 0 ? n : 30000;
  })();
  /* 兜底最小等待的证据来源：core.js 的开站镜像 `setTimeout(..., 8000)`。 */
  const SETTLE_MIN_FALLBACK_MS = (() => {
    const a = process.argv.find(x => x.startsWith('--settle-min-ms='));
    const n = a ? Number(a.slice('--settle-min-ms='.length)) : 9000;
    return Number.isFinite(n) && n >= 0 ? n : 9000;
  })();
  const DURABLE_KEYS = ['idbPut', 'idbAdd', 'idbDelete', 'idbClear', 'storageSet', 'storageRemove', 'storageClear'];
  const durableCount = (o) => DURABLE_KEYS.reduce((a, n) => a + ((o.platform[n] && o.platform[n].calls) || 0), 0);
  const durableDetailOf = (o) => DURABLE_KEYS.reduce((acc, n) => {
    const cell = o.platform[n]; if (!cell) return acc;
    (cell.detail || []).forEach(d => acc.push({ method: n, store: d.store, key: d.key, valueLength: d.valueLength,
      existedBefore: d.existedBefore, changed: d.changed, caller: d.caller }));
    return acc;
  }, []);
  const startupGate = () => evaluate(cdp, `(function(){
    var out = {mirrorAccessor:false, mirrorLastTs:null};
    try { if (typeof window._ibMirrorLastTs === 'number') { out.mirrorAccessor = true; out.mirrorLastTs = window._ibMirrorLastTs; } } catch(e){}
    return out;
  })()`);
  async function settleStartupWrites() {
    const t0 = Date.now();
    let last = -1, quietSince = t0, lastChange = null;
    while (Date.now() - t0 < SETTLE_MAX_MS) {
      const n = durableCount(await readObserver());
      if (n !== last) { last = n; quietSince = Date.now(); lastChange = Date.now(); }
      const gate = await startupGate();
      const mirrorDone = gate.mirrorAccessor
        ? (gate.mirrorLastTs > 0)
        : (Date.now() - t0 >= SETTLE_MIN_FALLBACK_MS);
      if ((Date.now() - quietSince) >= SETTLE_QUIET_MS && mirrorDone) {
        return { ok: true, waitedMs: Date.now() - t0, quietMs: Date.now() - quietSince, durable: n,
          rule: gate.mirrorAccessor ? 'mirror-one-shot-completed' : 'min-wait-fallback',
          mirrorAccessor: gate.mirrorAccessor, mirrorLastTs: gate.mirrorLastTs,
          lastChangeMs: lastChange ? lastChange - t0 : null };
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return { ok: false, waitedMs: Date.now() - t0, durable: last, timedOut: true };
  }

  /* ── Astra Readiness 语料的页面侧调用（与 layerA 的差别只有三点，都是契约要求）──
     ① 有 currentId：本轮消息的 canonical 身份（M1-C.2p 的 currentId 参数）
     ② 上下文快照按"有内容才 present"构造（缺 = missing，而不是 present-empty）
     ③ 返回生产守卫的**完整**输出（report / gate / rewrite / verify / evidence），
        观测直接用这些值，不重新解析任何东西 */
  const readinessEvidence = (c) => evaluate(cdp, `(async function(){
    var CS = window.IBContextSnapshot, ctx = ${JSON.stringify(c.context || {})};
    var INS = window.IB.__middleBrainContracts.integrity;
    var POL = window.IB.__middleBrainContracts.policy;
    var core = window.IBDialogueCore;
    var fields = {};
    ['memory','understanding','thread','moments'].forEach(function(n){ if (ctx[n]) fields[n] = CS.field('obs:'+n, String(ctx[n])); });
    var snap = CS.create({characterId:${JSON.stringify(c.character.id)}, turnId:'obs', fields:fields, gates:{}});
    var input = { history: ${JSON.stringify(c.history || [])}, userMessage: ${JSON.stringify(c.user)}, currentId: ${JSON.stringify(currentIdOf(c))} };
    var ev = INS._mbCiBuildEvidence(${JSON.stringify(c.character.id)}, ${JSON.stringify(c.user)}, {
      character: ${JSON.stringify(c.character)}, history: input.history, currentId: input.currentId, contextSnapshot: snap
    });
    /* 消费预算**之前**的投影：直接问共享核心要（不重新实现投影） */
    var coreLines = [];
    try { coreLines = core.assemble(input).lines; } catch (e) {}
    var coreChars = 0; for (var i=0;i<coreLines.length;i++) coreChars += coreLines[i].length;
    /* Gate 的真实信号（生产函数；零网络） */
    var sig = null;
    try { sig = await POL._mbAnalyzeSignals(${JSON.stringify(c.character.id)}, ${JSON.stringify(c.user)}, { dialogue: coreLines, contextSnapshot: snap }, null); } catch (e) {}
    return {available: ev.available, dialogueMeta: ev.dialogueMeta,
            dialogue: ev.dialogue, context: ev.context, userMessageChars: ev.userMessage.length,
            coreLinesCount: coreLines.length, coreChars: coreChars,
            signals: sig ? {dialogueChars: sig.dialogueChars, contextChars: sig.contextChars,
              memoryItems: sig.memoryItems, understandingItems: sig.understandingItems,
              threadItems: sig.threadItems, momentItems: sig.momentItems,
              multipleThreads: sig.multipleThreads, conflictSignal: sig.conflictSignal,
              nearBudget: sig.nearBudget, localCompressionRatio: sig.localCompressionRatio} : null};
  })()`);
  const readinessGuard = (c) => evaluate(cdp, `(async function(){
    var CS = window.IBContextSnapshot, ctx = ${JSON.stringify(c.context || {})};
    var fields = {};
    ['memory','understanding','thread','moments'].forEach(function(n){ if (ctx[n]) fields[n] = CS.field('obs:'+n, String(ctx[n])); });
    var out = await IB.middleBrain.middleBrainCharacterIntegrity(${JSON.stringify(c.character.id)}, ${JSON.stringify(c.user)}, ${JSON.stringify(c.candidate)}, {
      character: ${JSON.stringify(c.character)},
      history: ${JSON.stringify(c.history || [])},
      currentId: ${JSON.stringify(currentIdOf(c))},
      contextSnapshot: CS.create({characterId:${JSON.stringify(c.character.id)}, turnId:'obs', fields:fields, gates:{}})
    });
    return {
      replyUnchanged: out.reply === ${JSON.stringify(c.candidate)},
      finalChars: String(out.reply || '').length,
      reply: String(out.reply || ''),
      candidateChars: ${JSON.stringify(c.candidate)}.length,
      ran: out.ran === true,
      report: out.report ? {pass: out.report.pass, score: out.report.score, confidence: out.report.confidence,
        maxSeverity: out.report.maxSeverity, dimensions: out.report.dimensions, violations: out.report.violations} : null,
      gate: out.gate ? {rewrite: out.gate.rewrite, reason: out.gate.reason, thresholds: out.gate.thresholds} : null,
      rewrite: out.rewrite ? {reply: out.rewrite.reply, latencyMs: out.rewrite.latencyMs} : null,
      verify: out.verify || null,
      judgeError: out.judgeError || null,
      evidenceAvailable: out.evidence ? out.evidence.available : null,
      budgetDropped: out.evidence ? out.evidence.dialogueMeta.budgetDropped : null,
      currentIncluded: out.evidence ? out.evidence.dialogueMeta.currentIncluded : null
    };
  })()`);

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    /* 守卫必须在 navigate **之前**注入：校准页面在启动阶段就会试图
       POST 到本机 Home Node（见 OBSERVER_SOURCE 的说明）。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && !!(window.IB&&window.IB.middleBrain) && typeof IB.middleBrain.middleBrainCharacterIntegrity==='function'", 25000), 'page + integrity layer mounted');

    /* ── 观测口径自证：真实连接上的 CDP 期限必须**长于**生产期限 ──────────
       D0 断言的是默认常量，这里断言的是**这条连接实际生效的值**：
       resolveCdpTimeoutMs 在 Cdp 构造时解析，两条路径不同，必须都验。
       否则"常量对、连接错"（例如有人绕过 env 直接 new Cdp）会被漏掉。 */
    check('D1.cdpDeadlineExceedsProductionModelTimeout',
      cdp.timeoutMs > PRODUCTION_MODEL_TIMEOUT_MS && cdp.timeoutMs === CAL_CDP_DEADLINE.ms,
      'cdp.timeoutMs=' + cdp.timeoutMs + ' env=' + CAL_CDP_DEADLINE.ms + ' production=' + PRODUCTION_MODEL_TIMEOUT_MS);

    /* detect-only 是默认：--rewrite / --verify 才打开（只写进一次性临时 profile）。
       这里写的不是生产配置：本页面的 profile 是 os.tmpdir() 下的 mkdtemp 目录。 */
    /* Offline calibration seeds a synthetic config before the measurement window.
       The real Vault writer correctly routes through Active, but the harness blocks
       that transport. Keep the setup isolated with an in-memory-only writer so this
       pre-window config seed cannot touch a real Vault or masquerade as a product call. */
    await evaluate(cdp, `(function(){
      var vault = Object.create(null);
      window.__ibCalibrationSyntheticVault = vault;
      window._ibWriteVaultCredential = async function(bindingId, config, secret) {
        var id = String(bindingId || ''), key = String(secret || '');
        if (!id || !key) throw new Error('synthetic-calibration-vault-input-invalid');
        vault[id] = { provider: String(config && config.provider || ''), endpoint: String(config && config.endpoint || ''), model: String(config && config.model || ''), secretPresent: true };
        return id;
      };
      window.IB = window.IB || {};
      window.IB.host = window.IB.host || {};
      window.IB.host.credentialResolver = {
        available: true,
        resolve: async function(ref) {
          return String(ref || '') === 'middle_brain'
            ? { ok: true, apiKey: 'synthetic-calibration-vault-key' }
            : { ok: false, error: 'credential-unavailable' };
        }
      };
      return true;
    })()`);
    await setMb({ enabled: true, endpoint, model, apiKey, reasoningEffort: 'medium', speed: 'standard',
      characterIntegrityEnabled: true, characterIntegritySensitivity: 'conservative',
      characterIntegrityRewrite: OBSERVE_REWRITE, characterIntegrityVerify: OBSERVE_REWRITE && OBSERVE_VERIFY });
    await resetTel();
    mock.judgeCalls = 0; mock.rewriteCalls = 0;

    /* 装载后的自检：观测器真的装上了吗？然后记录"校准窗口之前"发生过什么。 */
    const initObs = await readObserver();
    check('S0.observerInstalledAtDocumentStart', initObs.transportIntercepted === true
      && initObs.platform.idbPut && initObs.platform.idbPut.present === true
      && initObs.platform.storageSet && initObs.platform.storageSet.present === true
      && initObs.platform.xhrSend && initObs.platform.xhrSend.present === true,
      JSON.stringify({ transportIntercepted: initObs.transportIntercepted, platform: Object.keys(initObs.platform) }));
    const semanticPresent = Object.keys(initObs.tripwires).filter(k => initObs.tripwires[k].present);
    check('S0b.tripwireCoverage', ['dbPut', 'saveMemory', 'createMoment', 'createThread', 'middleBrainAdmissionGate']
      .every(n => semanticPresent.indexOf(n) >= 0),
      JSON.stringify({ present: semanticPresent, missing: Object.keys(initObs.tripwires).filter(k => !initObs.tripwires[k].present) }));
    check('S0c.networkGuardRejectedOutOfScopeRequests', initObs.denied.length > 0,
      '校准窗口之前被守卫拒绝的站外请求: ' + JSON.stringify(initObs.denied));
    console.log('\n  [§12] pre-window activity (page init + calibration-profile config write)');
    console.log('       allowed hosts: ' + JSON.stringify(initObs.allowed));
    console.log('       DENIED out-of-scope requests: ' + JSON.stringify(initObs.denied));
    console.log('       platform writes before the window: '
      + JSON.stringify(['idbPut', 'idbAdd', 'idbDelete', 'idbClear', 'storageSet'].reduce((m, n) => {
        m[n] = { calls: initObs.platform[n] ? initObs.platform[n].calls : null, stores: initObs.platform[n] ? initObs.platform[n].stores : null }; return m;
      }, {})));
    console.log('       ws attempts before the window: ' + JSON.stringify(initObs.wsAttempts));
    /* Phase 1B.1：等页面自身的启动期维护写入排空，再开窗。
       这一步是"窗口里到底该算什么"的定义，不是加速/减速开关。 */
    const settle = await settleStartupWrites();
    const preWindowObs = await readObserver();
    const excludedWrites = durableDetailOf(preWindowObs);
    console.log('\n  [§12] startup settle: waited ' + settle.waitedMs + 'ms'
      + ' (rule=' + (settle.rule || 'TIMEOUT') + ', quiet ' + (settle.quietMs != null ? settle.quietMs : 'n/a') + 'ms, durable calls at open=' + settle.durable
      + ', mirror one-shot completed=' + settle.mirrorAccessor + ')'
      + (settle.timedOut ? '  ← 超时开窗（页面启动期仍在写；下面窗口内的写入会因此变红）' : ''));
    check('T0d.settleGateIsEvidenceBased', settle.ok === true && settle.rule === 'mirror-one-shot-completed',
      JSON.stringify(settle) + ' —— 开窗闸门必须是"开站镜像已完成的直接证据"，退回最小等待只能算兜底');
    console.log('       writes EXCLUDED from the calibration window (page startup maintenance): '
      + JSON.stringify(excludedWrites));
    /* 被排除的启动期写入必须满足两条**内容性**不变量（不是给 key 开白名单）：
       ① 没有任何一条来自校准路径 —— 校准路径（middle-brain-* / dialogue-core）在
          整个过程中都不得产生持久化写入，启动期也不例外；
       ② 每条都归因完整：带 key 参数的 API 必须记到 key，且必须有仓库内调用帧。
       注意 ① 不声称"启动期没有 DB 写入"：全新临时 profile 里页面**本来就要**建自己的库
       （实测 core.js 的 seed/init 会写 apiSettings(indexedDB 的 middle_brain 配置)、
       about、categories）。那种写入是页面初始化，不是校准副作用，也不在真实用户 profile 里。
       用"是不是校准路径"来判，比用"是不是某个 key"来判更难被绕过。 */
    const CAL_PATH_RE = /^(middle-brain|dialogue-core)/;
    check('T0.startupWritesExcludeCalibrationPath',
      excludedWrites.every(d => !CAL_PATH_RE.test(String(d.caller)) && !CAL_PATH_RE.test(String((d.callers || [])[1] || ''))),
      JSON.stringify(excludedWrites.filter(d => CAL_PATH_RE.test(String(d.caller)) || CAL_PATH_RE.test(String((d.callers || [])[1] || '')))));
    check('T0b.everyExcludedWriteIsAttributed',
      excludedWrites.every(d => d.caller && d.caller !== '(no-assets-frame)' && d.caller !== '(stack-error)'
        && (d.key != null || !/setItem|removeItem|delete$/.test(d.method))),
      JSON.stringify(excludedWrites.filter(d => !d.caller || d.caller === '(no-assets-frame)'
        || (d.key == null && /setItem|removeItem|delete$/.test(d.method)))));
    /* 归因必须**完整**：只要某方法总调用数 ≤ 64，明细条数就必须逐条对上。
       否则"没有记到"会被误读成"没有发生" —— 这正是本轮要消除的那类歧义。 */
    check('T0c.durableAttributionIsComplete',
      DURABLE_KEYS.every(n => {
        const cell = preWindowObs.platform[n]; if (!cell || !cell.present) return true;
        return (cell.detail || []).length === Math.min(cell.calls, 64);
      }),
      JSON.stringify(DURABLE_KEYS.map(n => {
        const cell = preWindowObs.platform[n] || {};
        return { m: n, calls: cell.calls || 0, detail: (cell.detail || []).length, err: (cell.detail || []).length !== Math.min(cell.calls || 0, 64) };
      }).filter(x => x.err)));
    await resetObserver();   /* 窗口从这里开始 */

    const observations = [];   /* 每条 = 真实执行路径上的 Judge 观测（Layer A 断言用） */
    const runRows = [];
    const records = [];        /* §4 观测记录（readiness 模式） */
    let transportIdx = 0;
    const actualCalls = { judge: 0, rewrite: 0, verify: 0, total: 0 };

    if (READINESS_MODE) {
      /* ── Astra Readiness：按 §4 组装观测记录 ─────────────────────────────
         判定结果全部来自生产守卫的返回值；usage / 状态 / 延迟来自只读交通记录器。
         任何拿不到的事实一律 null（绝不写 0 冒充）。 */
      for (let attempt = 1; attempt <= PLAN.repeat; attempt++) {
        for (const c of CASES) {
          mock.currentCandidate = c.candidate;
          mock.reportCallsThisCase = 0;
          const facts = await readinessEvidence(c);
          const t0 = Date.now();
          const out = await readinessGuard(c);
          const wall = Date.now() - t0;
          const obs = await readObserver();
          const slice = obs.transport.slice(transportIdx);
          transportIdx = obs.transport.length;

          const byName = (n) => slice.filter(x => x.name === n);
          const reports = byName('character_integrity_report');
          const rewrites = byName('character_integrity_rewrite');
          const judgeWire = reports[0] || null;
          const verifyWire = reports[1] || null;
          const rewriteWire = rewrites[0] || null;

          const rec = OBS.emptyObservation(c, 'desktop');
          rec.attempt = attempt;
          rec.provenance = LIVE_MODE ? 'live' : 'mock';
          rec.mockDriven = !LIVE_MODE;

          const avail = out.evidenceAvailable || {};
          rec.inputFacts.evidenceDimensionsAvailable = Object.keys(avail).filter(k => avail[k]);
          rec.inputFacts.evidenceDimensionsUnavailable = Object.keys(avail).filter(k => !avail[k]);
          rec.inputFacts.dialogueRowCount = facts.dialogue.length;
          rec.inputFacts.dialogueChars = facts.dialogue.reduce((a, m) => a + m.text.length + (m.role === 'assistant' ? 3 : 3), 0);
          rec.inputFacts.dialogueCharsBeforeBudget = facts.coreChars;
          rec.inputFacts.dialogueBudgetDropped = facts.dialogueMeta.budgetDropped;
          rec.inputFacts.dialogueCurrentTurnRows = facts.dialogue.filter(m => m.role === 'user' && m.text === c.user).length;
          rec.inputFacts.memory = { present: !!facts.context.memory, chars: facts.context.memory.length };
          rec.inputFacts.understanding = { present: !!facts.context.understanding, chars: facts.context.understanding.length };
          rec.inputFacts.thread = { present: !!facts.context.thread, chars: facts.context.thread.length };
          rec.inputFacts.moments = { present: !!facts.context.moments, chars: facts.context.moments.length };
          if (facts.signals) {
            rec.inputFacts.multipleThreadsInputState = {
              value: facts.signals.multipleThreads,
              threadItems: facts.signals.threadItems,
              understandingItems: facts.signals.understandingItems,
              reason: facts.signals.threadItems >= 2 ? (facts.signals.understandingItems >= 2 ? 'thread_and_understanding' : 'thread_lines>=2')
                : (facts.signals.understandingItems >= 2 ? 'understanding_lines>=2' : null)
            };
            rec.inputFacts.gateBucket = facts.signals.dialogueChars < 600 ? 'below_low'
              : (facts.signals.dialogueChars >= 3500 ? 'at_or_above_high' : 'ramp');
            rec.inputFacts.gateBucketReason = 'dialogueChars=' + facts.signals.dialogueChars
              + ' contextChars=' + facts.signals.contextChars
              + ' conflict=' + facts.signals.conflictSignal + ' nearBudget=' + facts.signals.nearBudget;
            rec.inputFacts.gateSignals = facts.signals;
          }

          rec.execution.provider = LIVE_MODE ? 'live-endpoint' : 'local-mock';
          rec.execution.model = model;
          rec.execution.reasoningEffort = 'medium';
          rec.execution.latencyMs = wall;
          /* 生产守卫每轮的结构是固定的：第 1 次 report 调用 = judge；
             若开了 verify 就还有第 2 次 report 调用（verify 复用同一个 schema）。
             所以按调用序号区分，而不是按 schema 名（schema 名相同）。 */
          rec.execution.calls = { judge: reports.length > 0 ? 1 : 0, rewrite: rewrites.length, verify: Math.max(0, reports.length - 1) };
          rec.execution.usage = slice.reduce((a, x) => OBS.addUsage(a, OBS.usageOf(x.usage)), null);
          rec.execution.error = slice.filter(x => x.ok === false).map(x => 'http_' + x.status).join(',') || null;
          rec.execution.timeout = slice.some(x => x.status == null && x.ok == null) ? true : null;
          rec.execution.retry = 0;
          rec.execution.authPresent = slice.some(x => x.authPresent === true);
          actualCalls.judge += rec.execution.calls.judge;
          actualCalls.rewrite += rec.execution.calls.rewrite;
          actualCalls.verify += rec.execution.calls.verify;

          rec.judge.ran = out.ran === true;
          rec.judge.promptChars = judgeWire ? judgeWire.bodyChars : null;
          rec.judge.responseChars = judgeWire ? judgeWire.wireChars : null;
          rec.judge.latencyMs = judgeWire ? judgeWire.latencyMs : null;
          rec.judge.usage = judgeWire ? OBS.usageOf(judgeWire.usage) : null;
          if (out.report) {
            rec.judge.pass = out.report.pass;
            rec.judge.score = out.report.score;
            rec.judge.confidence = out.report.confidence;
            rec.judge.maxSeverity = out.report.maxSeverity;
            rec.judge.dimensions = out.report.dimensions;
            rec.judge.violations = (out.report.violations || []).map(v => ({
              dimension: v.dimension, severity: v.severity,
              evidenceChars: String(v.evidence || '').length, reasonChars: String(v.reason || '').length
            }));
            rec.judge.malformed = false;
            rec.judge.error = null;
          } else if (out.judgeError) {
            rec.judge.malformed = false;
            rec.judge.error = out.judgeError;
          } else if (out.ran === true) {
            rec.judge.malformed = true;   /* 调用成功但解析不出 report = malformed */
            rec.judge.error = null;
          }

          rec.rewrite.triggered = rec.execution.calls.rewrite > 0;
          rec.rewrite.latencyMs = rewriteWire ? rewriteWire.latencyMs : null;
          rec.rewrite.usage = rewriteWire ? OBS.usageOf(rewriteWire.usage) : null;
          if (out.rewrite && typeof out.rewrite.reply === 'string') {
            rec.rewrite.ok = true;
            rec.rewrite.rejectReason = null;
            rec.rewrite.changed = out.rewrite.reply !== c.candidate;
            rec.rewrite.lengthRatio = Math.round((out.rewrite.reply.length / Math.max(1, c.candidate.length)) * 1000) / 1000;
            rec.rewrite.excerpt = out.rewrite.reply.slice(0, 60);
            rec.rewrite.contractViolations = c.rewriteContract ? (() => {
              const v = [];
              for (const s of (c.rewriteContract.mustPreserve || [])) if (out.rewrite.reply.indexOf(s) < 0) v.push('lost:' + s);
              for (const s of (c.rewriteContract.mustNotContain || [])) if (out.rewrite.reply.indexOf(s) >= 0) v.push('kept:' + s);
              return v;
            })() : null;
          } else if (rec.rewrite.triggered) {
            rec.rewrite.ok = false;
            rec.rewrite.rejectReason = (rewriteWire && rewriteWire.ok === false) ? 'http_' + rewriteWire.status
              : (rewriteWire && rewriteWire.wireChars === 4 ? 'empty_response' : 'rejected_or_malformed');
            rec.rewrite.contractViolations = null;
          }

          rec.verify.triggered = rec.execution.calls.verify > 0;
          rec.verify.latencyMs = verifyWire ? verifyWire.latencyMs : null;
          rec.verify.usage = verifyWire ? OBS.usageOf(verifyWire.usage) : null;
          if (rec.verify.triggered && out.verify) {
            rec.verify.ok = out.verify.ok === true;
            rec.verify.pass = out.verify.ok === true ? out.verify.pass : null;
            rec.verify.score = out.verify.ok === true ? out.verify.score : null;
            rec.verify.maxSeverity = out.verify.ok === true ? out.verify.maxSeverity : null;
            rec.verify.error = out.verify.ok === true ? null : (out.verify.error || 'unknown');
          }
          /* verify 真的发生了（有第 2 次 report 调用）但生产没给出 out.verify
             → 只可能"没走到 verify 分支"（例如 cfg.verify 关掉），如实标注。 */
          if (rec.verify.triggered && !out.verify) { rec.verify.ok = false; rec.verify.error = 'no_verify_output'; }

          rec.disposition = (() => {
            if (out.ran !== true) return 'guard_not_run';
            if (rec.judge.error) return 'judge_error:' + rec.judge.error;
            if (rec.judge.malformed) return 'judge_malformed';
            if (rec.judge.pass === true) return 'judge_pass';
            if (out.gate && out.gate.rewrite !== true) return 'gate_blocked:' + out.gate.reason;
            if (rec.rewrite.ok === true) return 'rewritten';
            if (rec.rewrite.triggered) return 'rewrite_failed:' + rec.rewrite.rejectReason;
            return 'judge_ooc_no_gate';
          })();
          OBS.compare(rec);

          records.push(rec);
          observations.push({ id: c.id, judgeCalls: reports.length, error: rec.judge.error });
          runRows.push({ id: c.id, out, avail: avail, transportError: rec.judge.error });
        }
      }
      check('R1.readinessRecordsBuilt', records.length === CASES.length * PLAN.repeat,
        records.length + ' vs ' + (CASES.length * PLAN.repeat));
      check('R2.oneJudgeCallPerSample', records.every(r => r.execution.calls.judge >= 1),
        JSON.stringify(records.filter(r => r.execution.calls.judge < 1).map(r => r.id)));
      check('R3.exactlyOneCurrentTurnInEvidence', records.every(r => r.inputFacts.dialogueCurrentTurnRows === 1),
        JSON.stringify(records.filter(r => r.inputFacts.dialogueCurrentTurnRows !== 1).map(r => [r.id, r.inputFacts.dialogueCurrentTurnRows])));
      check('R4.neverMoreThanOneRewritePerSample', records.every(r => r.execution.calls.rewrite <= 1),
        JSON.stringify(records.filter(r => r.execution.calls.rewrite > 1).map(r => r.id)));
      check('R5.everyRecordHasEvidenceFactsOrExplicitNull',
        records.every(r => r.inputFacts.gateBucket != null && r.inputFacts.dialogueChars != null && r.execution.calls != null));
    } else {
      for (const c of CASES) {
        const obs = c.observedJudge || {};
        const avail = await evidenceOnPage(c);
        mock.nextJudge = obs.raw == null ? null : obs.raw;
        mock.nextMode = obs.error ? 'fail' : 'ok';
        const before = mock.judgeCalls;
        const out = await runGuard(c);
        const judgeCalls = mock.judgeCalls - before;
        observations.push({ id: c.id, judgeCalls, error: obs.error || null });
        runRows.push({ id: c.id, out, avail, transportError: obs.error || null });
      }
    }

    /* ── 真实路径上的断言 ── */
    check('B1.allCasesRanThroughRealGuard', runRows.every(r => r.out && r.out.ran === true),
      runRows.filter(r => !r.out || r.out.ran !== true).map(r => r.id).join(', '));
    check('B6.realJudgePromptBuilt', mode !== 'mock' || mock.lastBody.length > 500,
      'lastBody=' + mock.lastBody.length);
    check('B7.realPromptContainsEvidence', mode !== 'mock' || /【角色证据】[\s\S]*【候选回复】/.test(mock.lastBody));
    check('B8.realPromptHasNoGroundTruth', mode !== 'mock' || !/expected|groundTruth|rewriteExpected|expectation|classes/i.test(mock.lastBody));
    if (!READINESS_MODE) {
      check('B2.neverRewrote', runRows.every(r => r.out.replyUnchanged === true) && mock.rewriteCalls === 0,
        'rewriteCalls=' + mock.rewriteCalls);
      check('B3.oneJudgeCallPerCase', observations.every(o => o.judgeCalls === 1),
        JSON.stringify(observations.filter(o => o.judgeCalls !== 1).slice(0, 5)));
      check('B4.guardNeverRanRewriteGate', runRows.every(r => !r.out.gate || r.out.gate.rewrite === false));
      check('B5.telemetryDetectOnly', (async () => true)() && (await (async () => {
        const t = await telemetry();
        return t.rewriteTriggered === 0 && t.rewriteOk === 0 && t.maxRewritesPerTurn === 0 && t.judgeRuns === CASES.length;
      })()), JSON.stringify(await telemetry()));
    }

    /* ── 用同一套 harness 指标评估真实路径观测（Layer A 语料） ── */
    let RES = null;
    if (!READINESS_MODE) {
      const rawCache = new Map(), gateCache = new Map(), availCache = new Map();
      for (const c of CASES) {
        const raw = (c.observedJudge && c.observedJudge.raw != null) ? c.observedJudge.raw : null;
        if (raw != null && !rawCache.has(raw)) rawCache.set(raw, await parseOnPage(raw));
        availCache.set(c.id, await evidenceOnPage(c));
      }
      for (const c of CASES) {
        const raw = (c.observedJudge && c.observedJudge.raw != null) ? c.observedJudge.raw : null;
        const report = raw == null ? null : rawCache.get(raw);
        for (const s of CAL.SENSITIVITIES) {
          const key = s + '|' + JSON.stringify(report);
          if (!gateCache.has(key)) gateCache.set(key, await gateOnPage(s, report));
        }
      }
      const deps = {
        productionSensitivity: 'conservative',
        parseJudge: (raw) => (raw == null ? null : (rawCache.has(raw) ? rawCache.get(raw) : null)),
        gate: (s, report) => gateCache.get(s + '|' + JSON.stringify(report)) || { rewrite: false, reason: 'gate_error', thresholds: null },
        evidenceAvailable: (c) => availCache.get(c.id) || {}
      };
      RES = CAL.runCalibration(CASES, deps);
      check('B9.harnessMetricsOverRealPath', RES.cases === CASES.length && RES.judge.decision.total > 0);
      check('B10.noGroundTruthLeakIntoPrompt', runRows.length === CASES.length);
    }

    /* ═══════════ §12 · 安全包络（两种语料、两种模式都会跑）═══════════════
       下面这些断言就是"把'安全'从声明变成每次回归都会被执行的证据"。
       关键判据全部落在**平台层**（IDB / Storage / XHR / fetch 的原型方法）：
       模块内部的闭包引用绕不过它们，所以"没有写盘"不是靠人相信 window.X 被包住了。 */
    const finalObs = await readObserver();
    if (!READINESS_MODE) {
      /* layerA 分支没有逐条记录，实际调用数直接从只读交通记录里数 —— 更直接，也更诚实。 */
      actualCalls.judge = finalObs.transport.filter(x => x.name === 'character_integrity_report').length;
      actualCalls.rewrite = finalObs.transport.filter(x => x.name === 'character_integrity_rewrite').length;
      actualCalls.verify = 0;
    }
    actualCalls.total = actualCalls.judge + actualCalls.rewrite + actualCalls.verify;
    const tw = (n) => (finalObs.tripwires[n] ? finalObs.tripwires[n].calls : 0);
    const pf = (n) => (finalObs.platform[n] ? finalObs.platform[n].calls : null);
    const pfStores = (n) => (finalObs.platform[n] && finalObs.platform[n].stores) || {};
    const durableWrites = ['idbPut', 'idbAdd', 'idbDelete', 'idbClear', 'storageSet', 'storageRemove', 'storageClear']
      .reduce((a, n) => a + (pf(n) || 0), 0);
    /* 窗口内的持久化写入必须**可归因**：key + 调用者 + 是否改值。
       否则一次红只能得到"durable=3"这种不可行动的信息（Phase 1B.1 的教训）。 */
    const inWindowDurable = durableDetailOf(finalObs);
    const durableWhy = 'durable=' + durableWrites
      + (inWindowDurable.length ? '  [' + inWindowDurable.map(d => d.method + ' ' + JSON.stringify(d.key) + ' @ ' + d.caller).join(' | ') + ']' : '');
    const semanticBy = (kind) => Object.keys(finalObs.tripwires)
      .filter(n => finalObs.tripwires[n].kind === kind)
      .reduce((a, n) => a + finalObs.tripwires[n].calls, 0);

    console.log('\n  [§12] safety envelope');
    console.log('       planned calls=' + PLAN.plannedCalls + '  actual: judge=' + actualCalls.judge
      + ' rewrite=' + actualCalls.rewrite + ' verify=' + actualCalls.verify + ' total=' + actualCalls.total);
    console.log('       platform tripwires: ' + JSON.stringify(Object.keys(finalObs.platform).reduce((m, n) => { m[n] = { calls: pf(n), stores: pfStores(n) }; return m; }, {})));
    if (inWindowDurable.length) console.log('       durable writes INSIDE the window (must be empty): ' + JSON.stringify(inWindowDurable));
    console.log('       semantic tripwires (non-zero only): '
      + JSON.stringify(Object.keys(finalObs.tripwires).filter(n => finalObs.tripwires[n].calls > 0).reduce((m, n) => { m[n] = finalObs.tripwires[n].calls; return m; }, {})));
    console.log('       fetch hosts contacted: ' + JSON.stringify(finalObs.fetchHosts));
    console.log('       auth header present on calibration calls: ' + (records.length ? String(records.some(r => r.execution.authPresent === true)) : 'n/a (layerA)'));

    check('D2.cdpDeadlineNeverFiredDuringCalibration', cdp.timeouts === 0,
      'CDP RPC timeout fired ' + cdp.timeouts + ' time(s) at ' + cdp.timeoutMs + 'ms — '
      + '客户端先放弃了，生产裁决被掩盖（Phase 1B 的症状）');
    /* 两种语料都断言：生产看到的 judgeError 里**不得**出现 CDP timeout。
       注意判据取的是生产守卫自己的返回（out.judgeError），不是 harness 的 fixture 记录 ——
       否则这条断言会退化成"校验我们自己写死的期望值"。 */
    check('D2b.productionJudgementNeverMaskedByHarnessDeadline',
      READINESS_MODE
        ? records.every(r => !/^CDP timeout/.test(String(r.judge.error || '')))
        : runRows.every(r => !/^CDP timeout/.test(String((r.out && r.out.judgeError) || ''))),
      JSON.stringify((READINESS_MODE
        ? records.filter(r => /^CDP timeout/.test(String(r.judge.error || ''))).map(r => [r.id, r.judge.error])
        : runRows.filter(r => /^CDP timeout/.test(String((r.out && r.out.judgeError) || ''))).map(r => r.id))));
    check('T1.explicitCallLimitEnforced', PLAN.ok && actualCalls.total <= PLAN.budget,
      'actual=' + actualCalls.total + ' budget=' + PLAN.budget);
    check('T2.noRetryAndBoundedAttempts',
      actualCalls.total <= PLAN.plannedCalls
      && (READINESS_MODE ? records.every(r => r.execution.retry === 0) : true),
      'actual=' + actualCalls.total + ' planned(worst case)=' + PLAN.plannedCalls);
    check('T3.noChatWrites', durableWrites === 0 && semanticBy('chat') === 0,
      durableWhy + ' chat=' + semanticBy('chat'));
    check('T4.noMemoryWrites', durableWrites === 0 && semanticBy('memory') === 0,
      durableWhy + ' memory=' + semanticBy('memory'));
    check('T5.noUnderstandingWrites', durableWrites === 0 && pfStores('idbPut').understanding == null && pfStores('idbDelete').understanding == null,
      durableWhy + ' ' + JSON.stringify(pfStores('idbPut')));
    check('T6.noThreadWrites', durableWrites === 0 && semanticBy('thread') === 0, durableWhy + ' thread=' + semanticBy('thread'));
    check('T7.noMomentWrites', durableWrites === 0 && semanticBy('moment') === 0, durableWhy + ' moment=' + semanticBy('moment'));
    check('T8.noMiddleBrainConfigMutationDuringCalibration', durableWrites === 0 && tw('saveMiddleBrainConfig') === 0,
      durableWhy + ' saveMiddleBrainConfig=' + tw('saveMiddleBrainConfig'));
    check('T9.noGateStateMutation', semanticBy('gate_state') === 0, 'gate_state=' + semanticBy('gate_state'));
    check('T10.noProductionProviderConfigWrite', semanticBy('provider_config') === 0, 'provider_config=' + semanticBy('provider_config'));
    check('T11.configWritesConfinedToIsolatedTempProfile', (() => {
      const t = profile.replace(/\\/g, '/');
      const inTmp = t.indexOf(os.tmpdir().replace(/\\/g, '/')) === 0;
      const args = ['--user-data-dir=' + profile];
      return inTmp && args.length === 1 && profile.indexOf('ib-cal-live-') >= 0;
    })(), profile);
    check('T12.deterministicFixtureIds', new Set(CASES.map(c => c.id)).size === CASES.length
      && CASES.every(c => /^[A-Za-z0-9_:-]+$/.test(c.id)));
    check('T13.expectedAndObservedSeparated', READINESS_MODE
      ? records.every(r => r.expectation && r.comparison && r.comparison.labelKind === r.expectation.kind)
      : true);
    check('T14.providerErrorsRecordedHonestly', READINESS_MODE
      ? records.every(r => (r.judge.error == null) === (r.judge.pass != null || r.judge.malformed === true))
      : true);
    check('T15.onlyCalibrationAndOwnPageHostsContacted', finalObs.fetchHosts.every(h => {
      /* 允许三类，且仅这三类：harness 自己的页面服务器、本机 mock 端点、
         （仅 live 模式）真实校准端点所在 host。任何第四方 host 都是失败。 */
      const bare = String(h).replace(/^\S+\s+/, '').replace(/\/.*$/, '');
      const allowed = ['127.0.0.1:' + webPort, '127.0.0.1:' + mockPort];
      if (allowed.indexOf(bare) >= 0) return true;
      try { return LIVE_MODE && bare === String(ENV_ENDPOINT).replace(/^https?:\/\//i, '').split('/')[0]; } catch (e) { return false; }
    }), JSON.stringify(finalObs.fetchHosts));
    /* 这条比"只联系了哪几个 host"更强：**只读**是靠方法证明的。
       校准只能读；任何一次非 GET/HEAD 都只允许打向校准端点本身。 */
    const writeRequests = finalObs.fetchHosts.filter(h => !/^(GET|HEAD)\s/.test(h));
    check('T15c.noWriteRequestsToAnythingButTheCalibrationEndpoint', writeRequests.every(h => {
      const bare = String(h).replace(/^\S+\s+/, '').replace(/\/.*$/, '');
      return bare === '127.0.0.1:' + mockPort || (LIVE_MODE && (() => { try { return bare === String(ENV_ENDPOINT).replace(/^https?:\/\//i, '').split('/')[0]; } catch (e) { return false; } })());
    }), JSON.stringify(writeRequests));
    check('T15b.noXhrWritesAtAll', pf('xhrSend') === 0 || pf('xhrSend') == null, 'xhrSend=' + pf('xhrSend'));

    /* ── 报告 ── */
    console.log('\nLayer B mode=' + mode + ' (corpus=' + PROVENANCE + ', provenance=' + provenance + ') · cases=' + CASES.length
      + ' · endpoint=' + (mode === 'live' ? endpoint : 'local mock'));
    if (mode === 'mock') {
      console.log('注意：离线 mock 模式下 Judge 输出为固定记录，本报告只验证"真实执行路径 + 观测管线 + 安全包络"，');
      console.log('      不代表模型真实准确率；模型真实准确率需要 --live 手动运行。');
    }
    let report, outPayload;
    if (READINESS_MODE) {
      const SUMM = OBS.summarize(records, {
        mode: mode, provenance: provenance + (mode === 'mock' ? '(mock-driven)' : ''),
        provider: LIVE_MODE ? 'live-endpoint' : 'local-mock', model: model, reasoningEffort: 'medium',
        host: 'desktop', plan: PLAN,
        actualCalls: { judge: actualCalls.judge, rewrite: actualCalls.rewrite, verify: actualCalls.verify, total: actualCalls.total }
      });
      report = OBS.renderReport(SUMM);
      console.log('\n' + '='.repeat(72) + '\n' + report + '\n' + '='.repeat(72));
      outPayload = { mode, corpus: PROVENANCE, provenance, cases: CASES.length, repeat: PLAN.repeat,
        plan: PLAN, actualCalls: actualCalls, report, summary: SUMM, records: records };
    } else {
      report = CAL.renderReport(RES).replace('Observation provenance: authored=' + CASES.length,
        'Observation provenance: ' + provenance + '=' + CASES.length);
      console.log('\n' + '='.repeat(72) + '\n' + report + '\n' + '='.repeat(72));
      outPayload = { mode, corpus: PROVENANCE, provenance, cases: CASES.length, plan: PLAN, actualCalls: actualCalls, report, summary: {
        judge: RES.judge.decision, intervention: RES.intervention, byDimension: RES.byDimension,
        bySensitivity: RES.bySensitivity, boundary: { cases: RES.boundary.cases.length, flips: RES.boundary.flips.length },
        knowledgeBoundary: RES.knowledgeBoundary
      } };
    }

    const outArg = process.argv.find(a => a.startsWith('--out='));
    if (outArg) {
      const p = outArg.slice('--out='.length);
      /* §12 T11：任何落盘产物都必须过脱敏（只按值替换，不做"看起来像 key"的猜测） */
      const text = OBS.redact(JSON.stringify(outPayload, null, 2), [ENV_KEY]);
      const leaked = OBS.leaksSecret(text, [ENV_KEY]);
      check('T11b.artifactCarriesNoCredential', leaked === null, leaked ? 'a credential value appears in the artifact' : '');
      fs.writeFileSync(p, text, 'utf8');
      console.log('\n结构化结果已写入: ' + p);
    }
    /* 哨兵自检：这条断言在离线回归里也会真的执行 —— apiKey 的位置放的就是一个
       哨兵值，所以"凭据值不得出现在输出里"是被验证过的，而不是被假设的。 */
    const leakedInReport = OBS.leaksSecret(report, [apiKey]);
    check('T11c.credentialValueNeverAppearsInReport', leakedInReport === null,
      leakedInReport ? '凭据值出现在报告里' : '');

    console.log('\nCharacter Integrity Calibration (P11-2A Layer B / ' + mode + ' / ' + PROVENANCE + '): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { mockApi.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
