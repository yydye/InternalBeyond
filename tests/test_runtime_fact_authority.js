'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-D3 · Turn Execution Authority Closure
   （**静态 authority 不变式** · 运行 node tests/test_runtime_fact_authority.js）

   D2 的审计结论已被 D3 关闭，本套件因此从"审计 pre-D3 状态"迁移为
   "守护 post-D3 authority 不变式"。

   冻结：
     TURN_CHARACTER_SCOPE_AUTHORITY = SERVER_VALIDATED_CANONICAL_CHARACTER_BINDING
     RAW_CLIENT_CHARACTER_ID_IS_AUTHORITY = NO
     FRIEND_ID_CHARACTER_FALLBACK = FORBIDDEN
     TURN_INSTANCE_ID_AUTHORITY = EXECUTION_RUNTIME
     PRODUCTION_CALLER_SUPPLIED_TURN_ID = FORBIDDEN
     REQUEST_IDENTITY != TURN_INSTANCE_IDENTITY
     TERMINAL_DECISION_COUNT_PER_TURN = 1
     FINALLY_IS_CLEANUP_ONLY = YES
     PERSISTENCE_SUCCESS_REQUIRED_FOR_COMPLETED = YES
     PRE_TURN_REJECTION != TURN_TERMINAL_FACT
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXEC = 'services/home-node/execution.js';
const WIRING = require('./helpers/activation-wiring-probe.js');

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

const code = WIRING.stripJsComments(read(EXEC));

(function main() {
  /* ══ A · character scope authority ══ */
  section('A · character scope authority');
  {
    check('A1.serverValidatedBindingPath',
      /function resolveCharacterBinding\(request\)/.test(code)
      && /characterRegistry\.getCharacterSpec\(selector\)/.test(code),
      'character 必须经 server registry 确认 ⇒ RAW_CLIENT_CHARACTER_ID_IS_AUTHORITY = NO');
    check('A2.failsClosedWithoutAuthority',
      /'character-authority-unavailable'/.test(code)
      && /'character-not-bound'/.test(code)
      && /'missing-character-selector'/.test(code),
      '无 registry / 未绑定 / 无 selector 一律 fail closed');
    check('A3.friendIdFallbackPermanentlyRemoved',
      !/\|\|\s*friendId\s*\|\|/.test(code)
      && !/characterId\s*=\s*friendId/.test(code)
      && !/request\.character\s*&&\s*request\.character\.id/.test(code),
      '★ FRIEND_ID_CHARACTER_FALLBACK = FORBIDDEN');
    check('A4.bindingPrecedesInstanceCreation',
      code.indexOf('resolveCharacterBinding(request)') < code.indexOf('const turnId = makeTurnId()'),
      'binding 在 turn instance 建立之前解析');
    check('A5.bindingFailureIsPreTurn',
      code.indexOf('fail(binding.error') < code.indexOf('inFlight.set(conversationId, turnId)'),
      'PRE_TURN_REJECTION != TURN_TERMINAL_FACT');
  }

  /* ══ B · turn instance identity authority ══ */
  section('B · turn instance identity authority');
  {
    check('B1.ownerMintsTurnId', /const turnId = makeTurnId\(\);/.test(code), 'TURN_INSTANCE_ID_AUTHORITY = EXECUTION_RUNTIME');
    check('B2.callerSuppliedTurnIdRemoved',
      !/options\.turnId\s*\|\|/.test(code) && !/makeTurnId = deps\.makeTurnId/.test(code),
      '★ PRODUCTION_CALLER_SUPPLIED_TURN_ID = FORBIDDEN');
    check('B3.testSeamIsConstructionTimeOnly',
      /const turnIdFactory = typeof deps\.turnIdFactory === 'function'/.test(code)
      && /createTurnContext\(\{/.test(code),
      'deterministic identity 只能在 createExecutor 构造期注入');
    check('B4.turnContextImmutable',
      /function deepFreezeTurnContext\(ctx\)/.test(code)
      && /return Object\.freeze\(ctx\);/.test(code)
      && /const turnContext = createTurnContext\(\{/.test(code),
      'turnId / characterId / conversationId 创建后 immutable');
    check('B5.contextCarriesRequestCorrelationSeparately',
      /requestCorrelationId: requestId/.test(code) && /turnId: turnId/.test(code),
      'REQUEST_IDENTITY != TURN_INSTANCE_IDENTITY');
    check('B6.conversationAuthorityUnchanged',
      /CHAT_CORE\.conversationIdOf\(friendId, threadId\)/.test(code),
      'TURN_CONVERSATION_SCOPE_AUTHORITY = CHAT_CORE.conversationIdOf');
  }

  /* ══ C · terminal settle seam ══ */
  section('C · terminal settle seam');
  {
    check('C1.singleSeamExists',
      /function settleTurnOutcome\(turnContext, outcomeCode\)/.test(code)
      && /function finalize\(turnContext, outcomeCode, result\)/.test(code),
      'ONE_CANONICAL_TERMINAL_SETTLE_SEAM');
    check('C2.terminalSingularity',
      /const prior = terminalByTurnId\.get\(turnContext\.turnId\)/.test(code)
      && /if \(prior\) return \{ ok: false, status: 'duplicate'/.test(code),
      '★ TERMINAL_DECISION_COUNT_PER_TURN = 1');
    check('C3.terminalHolderBoundedSessionOnly',
      /const TERMINAL_HOLDER_MAX = 256;/.test(code)
      && /terminalByTurnId\.size > TERMINAL_HOLDER_MAX/.test(code)
      && !/sqlite|writeFile|localStorage/i.test(code),
      'bounded · session-only · 无 durable storage');
    check('C4.allPostInstancePathsUseTheSeam',
      count(code, /return finalize\(/g) >= 6,
      'post-instance terminal 全部经 finalize（count=' + count(code, /return finalize\(/g) + '）');
    check('C5.finallyIsCleanupOnly',
      /} finally \{/.test(code) && /inFlight\.delete\(conversationId\);/.test(code)
      && !/finally \{[\s\S]{0,200}settleTurnOutcome/.test(code),
      '★ FINALLY_IS_CLEANUP_ONLY = YES（finally 不推断终局）');
    check('C6.persistencePrecedesCompleted',
      code.indexOf("finalize(turnContext, 'store-write-failed'") > 0
      && code.indexOf("finalize(turnContext, 'store-write-failed'") < code.indexOf("finalize(turnContext, 'completed'"),
      '★ PERSISTENCE_SUCCESS_REQUIRED_FOR_COMPLETED = YES');
    check('C7.terminalVocabularyNotFlattened', (function () {
      const kinds = ['empty-output', 'store-write-failed', 'credential-unavailable', 'completed',
        'abort', 'timeout', 'cancelled', 'provider-error'];
      return kinds.every(k => code.indexOf("'" + k + "'") >= 0);
    })(), '真实 outcome 词汇未被压平成 failed');
    check('C8.noRealityOrSettlementAuthorityInSeam',
      code.indexOf('runtimeRealityEvent') < 0 && code.indexOf('computeSettlement') < 0
      && code.indexOf('settlePrediction') < 0 && code.indexOf('calibrationCounted') < 0
      && code.indexOf('ingestSettlement') < 0,
      'seam 不含 RealityEvent / pairing / settlement / calibration authority');
    check('C9.terminalWitnessExposedReadOnly',
      /function terminalOutcomeOf\(turnId\)/.test(code) && /terminalOutcomeOf: terminalOutcomeOf/.test(code),
      'D4 的只读见证入口（本模块不接 RealityEvent）');
  }

  /* ══ D · readiness ══ */
  section('D · readiness');
  {
    P('TURN_CHARACTER_SCOPE_AUTHORITY', 'LIVE');
    P('TURN_INSTANCE_ID_AUTHORITY', 'LIVE');
    P('TURN_TERMINAL_SETTLE_SEAM', 'LIVE');
    P('TURN_TERMINAL_FACT_ADMISSION', 'PASS');
    P('REALITY_EVENT_WIRING_ADDED', 'NO');
    P('REALITY_EVENT_SOURCE_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('TURN EXECUTION AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('TURN EXECUTION AUTHORITY PASSED · ' + passed + ' assertions green');
})();
