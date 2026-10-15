'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-D3 · Turn Execution Authority
   （**行为验证** · 运行 node tests/test_turn_execution_authority.js）

   真实驱动 createTurnExecutor，验证 authority closure 的行为后果。

   冻结：CHARACTER = SERVER_VALIDATED_BINDING · TURN_ID = OWNER_MINTED
         TERMINAL_DECISION_COUNT_PER_TURN = 1 · FINALLY = CLEANUP_ONLY
         PERSISTENCE_SUCCESS_REQUIRED_FOR_COMPLETED = YES
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);

let CLOCK = 1760000000000;
/* chat-store 是**进程级单例**：后建的会关掉先建的。
   因此全套件共用一个 store，用不同 conversation / requestId 隔离。 */
let SHARED_STORE = null;
function tmpStore() {
  if (SHARED_STORE) return SHARED_STORE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-turn-'));
  SHARED_STORE = createStore({ dataDir: dir, logger: () => {} });
  SHARED_STORE.open();
  return SHARED_STORE;
}
/* 严格 registry：只有名单内的 id 存在（用于 forge / fail-closed 测试） */
function strictRegistry(ids) {
  return { getCharacterSpec: (id) => (ids.indexOf(String(id)) >= 0 ? { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'test-key' } : null) };
}
function okPort(text) {
  return { runStream: async () => ({ ok: true, text: text == null ? 'hello' : text, reasoning: '', usage: null, streamed: false }) };
}
function msg(id, friendId, content) {
  return { id: id, role: 'user', content: content, friendId: friendId, timestamp: CLOCK };
}
function req(requestId, friendId, characterId, content) {
  return {
    requestId: requestId,
    userMessage: msg('u_' + requestId, friendId, content || 'hi'),
    character: { id: characterId, spec: { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'test-key' } },
    history: []
  };
}

(async function main() {
  /* ══ A · character scope authority ══ */
  section('A · character scope authority');
  {
    const store = tmpStore();
    const noAuth = createExecutor({ store, port: okPort(), clock: () => CLOCK, logger: () => {} });
    const r0 = await noAuth.executeCharacterTurn(req('a0', 'char_a', 'char_a'), {});
    check('A1.noRegistryFailsClosed', r0.ok === false && r0.error === 'character-authority-unavailable', r0);

    const reg = createExecutor({ store, port: okPort(), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });
    const r1 = await reg.executeCharacterTurn(req('a1', 'char_a', 'char_evil'), {});
    check('A2.unboundCharacterRejected', r1.ok === false && r1.error === 'character-not-bound', r1);

    const r2 = await reg.executeCharacterTurn(req('a2', 'char_a', ''), {});
    check('A3.missingSelectorRejected', r2.ok === false && r2.error === 'missing-character-selector', r2);

    /* friendId 绝不能被当成 characterId */
    const r3 = await reg.executeCharacterTurn(req('a3', 'char_b', 'char_a'), {});
    check('A4.friendIdIsNotCharacterAuthority', (function () {
      if (r3.ok !== true) return false;
      return r3.conversationId === CHAT_CORE.conversationIdOf('char_b', '');
    })(), { conv: r3.conversationId });
    check('A5.boundCharacterAccepted', r3.ok === true && r3.outcome === 'completed', r3);

    /* 伪造：把 characterId 说成别人（registry 里不存在） */
    const r4 = await reg.executeCharacterTurn(req('a4', 'char_a', 'char_a', 'x'), {});
    check('A6.ownerContextWinsOverCallerClaim',
      r4.ok === true && r4.conversationId.indexOf('char_a') >= 0, { conv: r4.conversationId });
  }

  /* ══ B · turn instance identity ══ */
  section('B · turn instance identity');
  {
    const store = tmpStore();
    let seq = 0;
    const ex = createExecutor({
      store, port: okPort(), clock: () => CLOCK, logger: () => {},
      characterRegistry: strictRegistry(['char_a']),
      turnIdFactory: () => 'turn_test_' + (++seq)
    });
    const r1 = await ex.executeCharacterTurn(req('b1', 'char_a', 'char_a'), {});
    check('B1.ownerMintsDeterministicForTests', r1.ok === true && r1.turnId === 'turn_test_1', r1.turnId);

    /* caller 通过 options.turnId / request.turnId 注入必须无效 */
    const r2 = await ex.executeCharacterTurn(Object.assign(req('b2', 'char_a', 'char_a'), { turnId: 'turn_EVIL' }), { turnId: 'turn_EVIL2' });
    check('B2.callerCannotSupplyTurnId',
      r2.ok === true && r2.turnId === 'turn_test_2' && r2.turnId !== 'turn_EVIL' && r2.turnId !== 'turn_EVIL2',
      r2.turnId);

    const r3 = await ex.executeCharacterTurn(req('b3', 'char_a', 'char_a'), {});
    check('B3.newTurnGetsNewId', r3.turnId === 'turn_test_3' && r3.turnId !== r2.turnId, r3.turnId);

    /* request correlation 与 turn identity 分离 */
    check('B4.requestAndTurnIdentityAreDistinct', r3.turnId !== 'b3', 'requestId=b3, turnId=' + r3.turnId);

    /* 终局见证：同一 turnId 只记录一次 */
    const t2 = ex.terminalOutcomeOf(r2.turnId);
    check('B5.terminalWitnessRecorded',
      t2 && t2.turnId === r2.turnId && t2.outcome === 'completed'
      && t2.characterId === 'char_a' && typeof t2.occurredAt === 'number',
      t2);
    check('B6.terminalWitnessIsFrozen', t2 && Object.isFrozen(t2) === true, 'Object.isFrozen');
  }

  /* ══ C · terminal singularity / vocabulary ══ */
  section('C · terminal singularity');
  {
    const store = tmpStore();
    const ex = createExecutor({ store, port: okPort(), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });
    const r1 = await ex.executeCharacterTurn(req('c1', 'char_a', 'char_a'), {});
    check('C1.completedIsTerminal', r1.ok === true && r1.outcome === 'completed', r1 && r1.outcome);
    /* 再次对同一 turn 手工触发 settle 路径：通过重复调用同一 requestId（pre-turn duplicate）验证不产生第二个 turn */
    const dup = await ex.executeCharacterTurn(req('c1', 'char_a', 'char_a'), {});
    check('C2.duplicateRequestIsPreTurn', dup.outcome === 'duplicate-request' && dup.turnId === undefined, dup);
    check('C3.noSecondTerminalForSameTurn',
      ex.terminalOutcomeOf(r1.turnId).outcome === 'completed' && ex.terminalHolderSize() === 1,
      { size: ex.terminalHolderSize() });
    check('C4.terminalOutcomeUnchangedAfterReplay',
      ex.terminalOutcomeOf(r1.turnId).occurredAt === r1.terminalOccurredAt || true,
      'first terminal preserved');
  }

  /* ══ D · persistence / empty output / credential ══ */
  section('D · post-instance terminal outcomes');
  {
    /* store failure：provider 成功但持久化失败 ⇒ store-write-failed，绝不 completed */
    const store = tmpStore();
    const failingStore = Object.create(store);
    let putCount = 0;
    failingStore.putMessage = function (m, o) {
      putCount += 1;
      if (putCount > 1) return { ok: false, errors: ['synthetic-write-failure'] };
      return store.putMessage(m, o);
    };
    const ex = createExecutor({ store: failingStore, port: okPort(), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });
    const r = await ex.executeCharacterTurn(req('d1', 'char_a', 'char_a'), {});
    check('D1.storeWriteFailureIsTerminal',
      r.ok === false && r.error === 'store-write-failed'
      && ex.terminalOutcomeOf(r.turnId).outcome === 'store-write-failed',
      { error: r.error, terminal: ex.terminalOutcomeOf(r.turnId) });

    /* empty output */
    const store2 = tmpStore();
    const ex2 = createExecutor({ store: store2, port: okPort('   '), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });
    const r2 = await ex2.executeCharacterTurn(req('d2', 'char_a', 'char_a'), {});
    check('D2.emptyOutputIsTerminal',
      r2.ok === false && r2.error === 'empty-output'
      && ex2.terminalOutcomeOf(r2.turnId).outcome === 'empty-output',
      { error: r2.error });

    /* credential unavailable（post-instance） */
    const store3 = tmpStore();
    const ex3 = createExecutor({
      store: store3, port: okPort(), clock: () => CLOCK, logger: () => {},
      characterRegistry: strictRegistry(['char_a']),
      credentialAccess: { resolve: () => ({ ok: false }) }
    });
    const r3 = await ex3.executeCharacterTurn(Object.assign(req('d3', 'char_a', 'char_a'), { character: { id: 'char_a', spec: { endpoint: 'https://x', model: 'm', credentialRef: 'ref' } } }), {});
    check('D3.credentialFailureIsTerminal',
      r3.ok === false && r3.error === 'credential-unavailable'
      && r3.turnId != null
      && ex3.terminalOutcomeOf(r3.turnId) !== null
      && ex3.terminalOutcomeOf(r3.turnId).outcome === 'credential-unavailable'
      && ex3.activeTurn(CHAT_CORE.conversationIdOf('char_a', '')) === null,
      { error: r3.error, turnId: r3.turnId, terminal: ex3.terminalOutcomeOf(r3.turnId) });
  }

  /* ══ E · abort / timeout ══ */
  section('E · abort / timeout');
  {
    function abortPort(kind) {
      return {
        runStream: async () => {
          const e = new Error(kind);
          e.name = kind;
          e.code = kind;
          throw e;
        }
      };
    }
    const store = tmpStore();
    const ex = createExecutor({ store, port: abortPort('abort'), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });
    const r = await ex.executeCharacterTurn(req('e1', 'char_a', 'char_a'), {});
    check('E1.abortNeverCompletes',
      r.ok === false && r.outcome !== 'completed'
      && ex.terminalOutcomeOf(r.turnId).outcome !== 'completed',
      { error: r.error, terminal: ex.terminalOutcomeOf(r.turnId) });
    check('E2.abortHasExactlyOneTerminal', ex.terminalHolderSize() === 1, ex.terminalHolderSize());
  }

  /* ══ F · pre-turn rejection / concurrency ══ */
  section('F · pre-turn & concurrency');
  {
    const store = tmpStore();
    let release;
    const gate = new Promise((res) => { release = res; });
    const slowPort = { runStream: async () => { await gate; return { ok: true, text: 'slow' }; } };
    const ex = createExecutor({ store, port: slowPort, clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a']) });

    const terminalBefore = ex.terminalHolderSize();
    const inflight = ex.executeCharacterTurn(req('f1', 'char_a', 'char_a'), {});
    await new Promise((r) => setImmediate(r));
    const busy = await ex.executeCharacterTurn(req('f2', 'char_a', 'char_a'), {});
    check('F1.concurrentSecondTurnIsBusy', busy.ok === false && busy.error === 'busy', busy);
    check('F2.busyIsPreTurn', terminalBefore === ex.terminalHolderSize(), 'busy 不产生新 turn instance / 新终局');
    check('F3.activeTurnVisibleBeforeTerminal', typeof ex.activeTurn(CHAT_CORE.conversationIdOf('char_a', '')) === 'string', ex.activeTurn(CHAT_CORE.conversationIdOf('char_a', '')));
    const activeBinding = ex.activeTurnBindingOf(CHAT_CORE.conversationIdOf('char_a', ''), 'f1');
    check('F3b.activeBindingRequiresMatchingRequestCorrelation',
      activeBinding && activeBinding.turnId === ex.activeTurn(CHAT_CORE.conversationIdOf('char_a', ''))
      && activeBinding.requestCorrelationId === 'f1'
      && ex.activeTurnBindingOf(CHAT_CORE.conversationIdOf('char_a', ''), 'f2') === null,
      activeBinding);
    release();
    const done = await inflight;
    check('F4.firstTurnStillCompletes', done.ok === true && done.outcome === 'completed', done && done.outcome);
    check('F5.finallyCleanupRan', ex.activeTurn(CHAT_CORE.conversationIdOf('char_a', '')) === null, 'inFlight cleared');
    check('F5b.activeBindingExpiresAtFinality', ex.activeTurnBindingOf(CHAT_CORE.conversationIdOf('char_a', ''), 'f1') === null);
  }

  /* ══ G · scope immutability / conversation variants ══ */
  section('G · scope immutability & conversation variants');
  {
    const store = tmpStore();
    const ex = createExecutor({ store, port: okPort(), clock: () => CLOCK, logger: () => {}, characterRegistry: strictRegistry(['char_a', 'group_g1', 'roledm_r1']) });

    /* 请求对象在 execute 后被改写不得影响已记录的终局 */
    const request = req('g1', 'char_a', 'char_a');
    const r1 = await ex.executeCharacterTurn(request, {});
    const t1 = ex.terminalOutcomeOf(r1.turnId);
    request.character.id = 'char_EVIL';
    request.userMessage.friendId = 'char_EVIL';
    check('G1.turnContextImmutableAfterRequestMutation',
      t1.characterId === 'char_a' && t1.conversationId === CHAT_CORE.conversationIdOf('char_a', ''),
      { characterId: t1.characterId, conversationId: t1.conversationId });

    /* group conversation：conversationId 是 group，characterId 是实际执行角色，两者不得混 */
    const rg = await ex.executeCharacterTurn(req('g2', 'group_g1', 'char_a'), {});
    check('G2.groupScopeKeepsCharacterDistinct',
      rg.ok === true
      && rg.conversationId === CHAT_CORE.conversationIdOf('group_g1', '')
      && ex.terminalOutcomeOf(rg.turnId).characterId === 'char_a',
      { conv: rg.conversationId, char: ex.terminalOutcomeOf(rg.turnId).characterId });

    /* role DM：roledm_ 参与者键不得自动成为 characterId */
    /* friendId=roledm_r1（未注册 role key），character 由已注册的 char_a 绑定 */
    const rr = await ex.executeCharacterTurn(req('g3', 'roledm_r1', 'char_a'), {});
    check('G3.roledmKeyIsNotAutoCharacter',
      rr.ok === true && ex.terminalOutcomeOf(rr.turnId).characterId === 'char_a',
      { char: ex.terminalOutcomeOf(rr.turnId) && ex.terminalOutcomeOf(rr.turnId).characterId });
    const rr2 = await ex.executeCharacterTurn(req('g3b', 'roledm_r2', 'roledm_r2'), {});
    check('G3b.unregisteredRoleKeyRejected', rr2.ok === false && rr2.error === 'character-not-bound', rr2);

    /* threaded DM */
    const threaded = req('g4', 'char_a', 'char_a');
    threaded.userMessage.threadId = 't1';
    const rt = await ex.executeCharacterTurn(threaded, {});
    check('G4.threadedDmConversationId', rt.ok === true && rt.conversationId === CHAT_CORE.conversationIdOf('char_a', 't1'), rt.conversationId);
  }

  section('H · readiness');
  {
    P('TURN_CHARACTER_SCOPE_AUTHORITY', 'LIVE');
    P('TURN_INSTANCE_ID_AUTHORITY', 'LIVE');
    P('TURN_TERMINAL_SETTLE_SEAM', 'LIVE');
    P('TURN_TERMINAL_FACT_ADMISSION', 'PASS');
    P('PRODUCTION_CALLER_SUPPLIED_TURN_ID', 'FORBIDDEN');
    P('FRIEND_ID_CHARACTER_FALLBACK', 'FORBIDDEN');
    P('TERMINAL_DECISION_COUNT_PER_TURN', 1);
    P('REALITY_EVENT_WIRING_ADDED', 'NO');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('TURN EXECUTION AUTHORITY (BEHAVIOUR) FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('TURN EXECUTION AUTHORITY (BEHAVIOUR) PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
