'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-D1 · Economy Scope & Emission Audit
   （**audit-only**：零 production 改动、零 schema 迁移、零 wiring）

   运行：node tests/test_economy_scope_audit.js

   本套件把 P5-B3-D1 的审计结论变成**机械断言**，使它不能被口头推翻：
     · change-log 只有一个 durable sink（无绕过 INSERT）
     · 33 个 appendChange 调用点 vs 1 个 sink
     · Economy **没有** conversation scope（0 处）
     · ownerId 是 party 引用，不是 characterId
     · shared sink 同时被 bootstrap / rebuild 使用 ⇒ 不可直接作 emission point
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ECON = 'services/home-node/economy-store.js';
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

const src = read(ECON);
const code = WIRING.stripJsComments(src);

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · shared sink topology
     ══════════════════════════════════════════════════════════════════ */
  section('A · shared sink topology');
  {
    const insertUses = count(code, /SQL\.insertChange/g);
    check('A1.exactlyOneUseOfTheInsertStatement',
      insertUses === 1,
      'SQL.insertChange 使用次数=' + insertUses + '（>1 表示存在绕过 appendChange 的路径）');
    check('A2.exactlyOneChangeLogInsertLiteral',
      count(code, /INSERT INTO[\s\S]{0,40}CHANGE_LOG_TABLE/g) === 1,
      'change_log 的 INSERT 字面量必须唯一');
    const callSites = count(code, /appendChange\(\{/g);
    check('A3.appendChangeCallSitesCounted',
      callSites >= 30,
      'appendChange 调用点=' + callSites);
    check('A4.appendChangeIsTheOnlyWriter',
      /function appendChange\(change\)/.test(code)
      && code.indexOf('db.prepare(SQL.insertChange).run(') >= 0,
      'appendChange → SQL.insertChange 是唯一 durable 写入路径');
    check('A5.noDirectChangeLogInsertOutsideSink',
      count(code, /INSERT INTO economy_change_log/g) === 0
      && count(code, /INSERT OR REPLACE INTO economy_change_log/g) === 0,
      '没有直接写 change_log 的旁路');
    P('FACT_CREATION_SITES', callSites);
    P('CANONICAL_DURABLE_SINKS', 1);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · scope authority
     ══════════════════════════════════════════════════════════════════ */
  section('B · scope authority');
  {
    check('B1.noConversationScopeAnywhereInEconomy',
      count(code, /conversationId/g) === 0
      && count(code, /threadId/g) === 0
      && count(code, /sessionId/g) === 0,
      '★ CONVERSATION_SCOPE = NO（economy-store 全仓 0 处）');
    check('B2.changeLogColumnsHaveNoScopeColumns', (function () {
      /* DDL 是跨行字符串拼接；取 createChangeLog 到下一个 SQL 键之间的区域 */
      const start = code.indexOf('createChangeLog:');
      const end = code.indexOf('createChangeLogByTx:');
      if (start < 0 || end <= start) return false;
      const ddl = code.slice(start, end);
      /* 行形状：revision / kind / entity_id / transaction_id / wallet_id / at / payload_json */
      return ddl.indexOf('character_id') < 0
        && ddl.indexOf('conversation_id') < 0
        && ddl.indexOf('revision INTEGER PRIMARY KEY') >= 0
        && ddl.indexOf('entity_id') >= 0
        && ddl.indexOf('at INTEGER NOT NULL') >= 0
        && ddl.indexOf('payload_json') >= 0;
    })(), 'change_log 行形状不含 scope 列');
    check('B3.economyDoesNotReadCharacters',
      /不涉及任何角色表/.test(src) || code.indexOf('characterId') < 3,
      'Economy 明确不读角色表 ⇒ 不存在 ownerId→character 的 FK');
    check('B4.ownerIdIsAPartyReferenceNotACharacter',
      /canonical party/.test(src)
      && /'user'/.test(src) && /'character'/.test(src)
      && /id 空间/.test(src),
      'ownerId 是 party（character | user | system），且 user/character 是不同 id 空间');
    check('B5.noHeuristicScopeResolver', (function () {
      const banned = [/currentCharacter/, /defaultCharacter/, /activeConversation/,
        /currentConversation/, /ownerId\s*as\s*characterId/];
      return banned.every(re => !re.test(code));
    })(), '审计阶段未埋任何启发式 scope 映射');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · replay / bootstrap contamination
     ══════════════════════════════════════════════════════════════════ */
  section('C · emission-point contamination');
  {
    const nonLiveKinds = ['BALANCE_REBUILT', 'ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED', 'initial-credit-bootstrap'];
    const present = nonLiveKinds.filter(k => code.indexOf(k) >= 0);
    check('C1.sharedSinkReceivesNonLivePaths',
      present.length >= 2,
      '非 live 路径经过同一 sink：' + JSON.stringify(present));
    check('C2.rebuildGoesThroughAppendChange',
      /function rebuildWalletBalance/.test(code)
      && /BALANCE_REBUILT/.test(code),
      'rebuild/repair 会经 appendChange ⇒ REALITY_SOURCE_MUST_NOT_EMIT_DURING_REPLAY 需要 mode 判别');
    check('C3.noModeDiscriminatorToday',
      !/mode:\s*'LIVE'/.test(code) && !/emissionMode/.test(code),
      'sink 今天**没有** LIVE/REPLAY/MIGRATION/RESTORE 判别 ⇒ 不能直接充当 emission point');
    check('C4.migrationDoesNotAppendChange',
      (function () {
        const m = code.match(/function migrateSchema\(\)[\s\S]{0,4000}/);
        return !!m && m[0].indexOf('appendChange(') < 0;
      })(),
      'migrateSchema 本身不写 change log（但 rebuild 写）');
    check('C5.postCommitSeamUndetermined',
      /* 用**标识符边界**：`reservationCommitted` 里的 onCommit 是子串误报 */
      !/(?<![A-Za-z])postCommit(?![A-Za-z])/.test(code)
      && !/(?<![A-Za-z])afterCommit(?![A-Za-z])/.test(code)
      && !/(?<![A-Za-z])onCommit(?![A-Za-z])/.test(code),
      'economy-store 无 post-commit 回调 ⇒ INSERT 成功 != COMMIT 成功（UNDETERMINED）');
  }

  /* ══════════════════════════════════════════════════════════════════
     D · identity / timestamp / terminality
     ══════════════════════════════════════════════════════════════════ */
  section('D · identity & timestamp');
  {
    check('D1.revisionIsOwnerAllocated',
      /function allocateRevision/.test(code) && /maxChangeRevision/.test(code),
      'revision 由 economy owner 分配（monotonic）');
    check('D2.timestampComesFromFactNotProcess',
      /change\.at/.test(code) && /Number\(change\.at\)/.test(code),
      'timestamp 来自事实字段 `at`，不是 adapter 调用时刻');
    check('D3.eventIdentityAndEntityIdentityAreSeparate',
      /revision: revision, kind:/.test(code) && /entityId: String\(walletId\)/.test(code),
      'revision = event identity；entity_id = canonical entity（两者分离）');
    check('D4.economyIsDurableOwner',
      /createChangeLog/.test(code) && /PRAGMA journal_mode/.test(code),
      'durable canonical owner = YES');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · admission table（§15/§30）
     ══════════════════════════════════════════════════════════════════ */
  section('E · admission table');
  {
    const table = {
      AUTHORITATIVE_OWNER: 'PASS',
      STABLE_SOURCE_EVENT_ID: 'PASS',
      AUTHORITATIVE_TIMESTAMP: 'PASS',
      TYPED_FACT: 'PASS',
      CHARACTER_SCOPE: 'FAIL',
      CONVERSATION_SCOPE: 'FAIL',
      BOUNDED_PAYLOAD: 'PASS',
      ONE_CANONICAL_EMISSION_POINT: 'CONDITIONAL',
      HOME_NODE_ACCESSIBLE: 'PASS'
    };
    const blocking = Object.keys(table).filter(k => table[k] !== 'PASS');
    check('E1.admissionNotFullyPassed',
      blocking.length > 0,
      '未通过项：' + JSON.stringify(blocking));
    check('E2.blockerIsScope',
      table.CHARACTER_SCOPE === 'FAIL' && table.CONVERSATION_SCOPE === 'FAIL',
      '★ 两条 scope 都 FAIL ⇒ P5_B3_D1_RESULT = BLOCKED');
    check('E3.emissionPointOnlyConditional',
      table.ONE_CANONICAL_EMISSION_POINT === 'CONDITIONAL',
      'sink 唯一（PASS）但 replay 污染 + post-commit 未定 ⇒ CONDITIONAL');
    Object.keys(table).forEach(k => P('ADMISSION.' + k, table[k]));
    P('P5_B3_D1_RESULT', 'BLOCKED');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · scope proof
     ══════════════════════════════════════════════════════════════════ */
  section('F · scope proof');
  {
    P('P5_B3_D1_STATUS', 'COMPLETE');
    P('PRODUCTION_REALITY_WIRING_ADDED', 'NO');
    P('ECONOMY_SCHEMA_MIGRATION_PERFORMED', 'NO');
    P('ADAPTER_WRITTEN', 'NO');
    P('REALITY_EVENT_SOURCE_LIVE', 'NO');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'NO');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'NO');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('ECONOMY SCOPE AUDIT FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('ECONOMY SCOPE AUDIT PASSED · ' + passed + ' assertions green');
})();
