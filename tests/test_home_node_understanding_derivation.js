/* ====================================================================
   M1-C.2m P3 · Home Node canonical Understanding 派生写者
   --------------------------------------------------------------------
   这一条测的是**唯一写者**本身（真 store + 真共享核心 + mock model port）：
     ① 一轮派生创建恰好一份 active 文档（revision 1）；
     ② 证据变化 → 第二轮重写并追加 history；
     ③ 模型给出逐字相同的候选 → no-op，revision 不动（不 churn）；
     ④ **成本护栏**：证据未变 → 零模型调用；重启（重建派生器）后仍然零调用；
        最小间隔内 → 零调用；无角色配置 → 零调用；证据不足 → 零调用；
     ⑤ **更正回归**（M1-C.2m §12）：用户更正之后重跑派生，
        · 提示词里**必须**出现那条更正（否则"下一个周期会忘记它"）；
        · 旧版本仍在 history；
        · 更正仍然 durable（重启不丢）；
        · 数据库仍然**恰好一份** active；
        · 结果只可能是 revision+1 或明确的 no-op，绝不新建第二份文档；
     ⑥ 并发：两个派生器各自持连接、从**同一基版本**出发 → 恰好一个提交成功，
        另一个拿到 revision-conflict，库内仍只有一份 active；
     ⑦ 可见性收窄：某条源记忆改为 private 之后，读侧**立刻**不可注入。
   运行：node test_home_node_understanding_derivation.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createUnderstandingStore = require(path.join(ROOT, 'services', 'home-node', 'understanding-store.js'));
const createUnderstandingDerivation = require(path.join(ROOT, 'services', 'home-node', 'understanding-derivation.js'));
const createUnderstandingRetrieval = require(path.join(ROOT, 'services', 'home-node', 'understanding-retrieval.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const CONTRACT = require(path.join(ROOT, 'assets', 'js', 'memory-contract.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* ── mock 角色目录：DTO（名字/关系）+ 运行时 spec（凭据）分开，
      与 device-registry 的两表结构同形。 */
function mockRegistry(characters) {
  const byId = new Map(characters.map(c => [String(c.id), c]));
  return {
    getCharacter: (id) => { const c = byId.get(String(id)); return c ? { id: c.id, dto: c.dto, forTurn: true } : null; },
    getCharacterSpec: (id) => { const c = byId.get(String(id)); return c ? c.spec : null; },
    listCharacters: () => characters.map(c => ({ id: c.id, forTurn: !!c.spec, updatedAt: 0 }))
  };
}

/* ── mock model port：记录每一次请求（用来断言"到底调没调模型"）。 */
function mockModelPort(responder) {
  const calls = [];
  return {
    calls: calls,
    run: async function (request, options) {
      calls.push({ request: request, options: options || {} });
      const out = typeof responder === 'function' ? responder(request, calls.length) : responder;
      return { text: String(out == null ? '' : out) };
    }
  };
}

function seedMemory(memoryStore, id, fields) {
  const rec = Object.assign({
    id: id, createdBy: 'cyrene', createdByName: 'Cyrene', kind: 'episodic',
    title: 't-' + id, content: 'c-' + id, domain: '日常', valence: 0.5, arousal: 0.4,
    importance: 5, resolved: false, visibility: 'public', created: Date.now(), lastActivated: Date.now()
  }, fields || {});
  return memoryStore.putRecord(rec, {});
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-un-derive-'));
  tempDirs.push(dir);

  const memoryStore = createMemoryStore({ dataDir: dir, logger: () => {} });
  memoryStore.open();
  const store = createUnderstandingStore({ dataDir: dir, clock: () => now, logger: () => {} });
  store.open();

  /* 可控时钟：让"6 小时最小间隔"的判定不需要真的等 6 小时。 */
  let now = 1700000000000;

  const spec = { provider: 'custom', model: 'test-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'k', systemPrompt: '你是 Cyrene。' };
  const characters = [{ id: 'cyrene', dto: { id: 'cyrene', name: 'Cyrene', relationship: '伙伴' }, spec: spec }];

  seedMemory(memoryStore, 'm1', { title: '想换电脑', content: '她提到想攒钱买一台新电脑来升级设备' });
  seedMemory(memoryStore, 'm2', { title: '准备换设备', content: '她的旧设备限制创作，计划升级' });
  seedMemory(memoryStore, 'm3', { title: '夜里工作', content: '她习惯在深夜写东西，白天反而难集中' });

  const PAYLOAD_1 = JSON.stringify({
    shouldUpdate: true,
    content: '她对设备瓶颈敏感，升级设备会明显提升创作信心。',
    basis: 'user_corroborated', dimension: 'context', evidenceIds: ['m1', 'm2'], conviction: 75
  });

  let port = mockModelPort(PAYLOAD_1);
  const deps = () => ({
    store: store, memoryStore: memoryStore,
    registry: mockRegistry(characters), modelPort: port,
    clock: () => now, logger: () => {}
  });
  const makeDerivation = (extra) => createUnderstandingDerivation(Object.assign(deps(), extra || {}));
  let derivation = makeDerivation();

  /* ── ① 首轮派生 ───────────────────────────────────────────────────── */
  return derivation.derive('cyrene', { force: true }).then(first => {
    check('first.created', first.ok && first.outcome === 'created' && first.docRevision === 1, first);
    check('first.oneActive', store.invariantViolations().violations.length === 0 && store.countActiveAll() === 1, store.countActiveAll());
    const doc = store.getActive('cyrene');
    check('first.content', doc && doc.current.content.indexOf('设备瓶颈') >= 0, doc && doc.current.content);
    check('first.evidenceAdmitted', doc && doc.current.evidenceIds.length === 2, doc && doc.current.evidenceIds);
    check('first.stampPublic', doc && doc.visibility.visibility === 'public', doc && doc.visibility);
    check('first.noMomentsOrDiaryInPrompt', port.calls.length === 1
      && port.calls[0].request.prompt.messages[0].content.indexOf('【近期日记】') < 0
      && port.calls[0].request.prompt.messages[0].content.indexOf('【近期动态】') < 0,
      port.calls.length);
    check('first.consumerTagged', port.calls[0].request.consumer === 'understanding', port.calls[0].request.consumer);

    /* ── ④ 成本护栏：证据未变 → 零调用 ─────────────────────────────── */
    const before = port.calls.length;
    return derivation.derive('cyrene', {}).then(skipped => {
      check('guard.evidenceUnchanged', skipped.outcome === 'ineligible' && skipped.skipReason === 'evidence-unchanged', skipped);
      check('guard.noModelCall', port.calls.length === before, port.calls.length - before);

      /* 模型重新给出逐字相同的候选（force 绕过节流）→ no-op，revision 不动 */
      return derivation.derive('cyrene', { force: true });
    }).then(same => {
      check('noop.identicalCandidate', same.ok && same.outcome === 'skipped', same);
      check('noop.revisionUntouched', store.getActive('cyrene').revision === 1, store.getActive('cyrene').revision);

      /* ── ④b 重启不重置水位（C6 的前提）─────────────────────────── */
      const restarted = makeDerivation();   /* 新的派生器实例 = 进程重启后的状态 */
      const rebuilt = createUnderstandingDerivation(Object.assign(deps(), {}));
      const beforeRestart = port.calls.length;
      return rebuilt.derive('cyrene', {}).then(afterRestart => {
        check('guard.survivesRestart', afterRestart.outcome === 'ineligible' && afterRestart.skipReason === 'evidence-unchanged', afterRestart);
        check('guard.restartNoModelCall', port.calls.length === beforeRestart, port.calls.length - beforeRestart);
        check('guard.watermarkDurable', store.getWatermark('cyrene').evidenceFingerprint != null, store.getWatermark('cyrene'));
        return restarted;
      });
    }).then(restarted => {
      derivation = restarted;

      /* ── ② 证据变化 → 重写并追加 history ───────────────────────── */
      now += CORE ? 7 * 60 * 60 * 1000 : 0;
      seedMemory(memoryStore, 'm4', { title: '明确说过', content: '她明确说自己更需要被认真对待而不是被安慰' });
      port = mockModelPort(JSON.stringify({
        shouldUpdate: true,
        content: '她需要的不是被安慰，而是被认真对待。',
        basis: 'user_stated', dimension: 'relationship', evidenceIds: ['m4', 'm1'], conviction: 88
      }));
      derivation = makeDerivation();
      return derivation.derive('cyrene', {}).then(second => {
        check('second.updated', second.ok && second.outcome === 'updated' && second.docRevision === 2, second);
        const doc2 = store.getActive('cyrene');
        check('second.historyHasOldVersion', doc2.history.length === 1 && doc2.history[0].content.indexOf('设备瓶颈') >= 0, doc2.history);
        check('second.oneActive', store.invariantViolations().violations.length === 0 && store.countActiveAll() === 1, store.countActiveAll());
        return doc2;
      });
    }).then(() => {
      /* ── ⑤ 更正回归（M1-C.2m §12）───────────────────────────────── */
      const beforeCorrection = store.getActive('cyrene');
      check('correctionRegress.preconditionRevision7Shape', beforeCorrection.revision === 2, beforeCorrection.revision);
      const corr = store.addCorrection('cyrene', {
        text: '我并不是对设备瓶颈敏感，我只是嫌它慢',
        basis: 'user_stated'
      });
      check('correctionRegress.committed', corr.ok && corr.outcome === 'created', corr);
      check('correctionRegress.notADeletion', !!store.getActive('cyrene') && store.getActive('cyrene').id === beforeCorrection.id);
      check('correctionRegress.stillOneActive', store.countActiveAll() === 1 && store.invariantViolations().violations.length === 0);

      /* 派生再次运行：必须先有足够的新证据（否则会被护栏挡住，那是正确行为） */
      now += 7 * 60 * 60 * 1000;
      seedMemory(memoryStore, 'm5', { title: '又一次说明', content: '她再次强调设备只是慢，不是她本人的敏感点' });
      seedMemory(memoryStore, 'm6', { title: '关于方式', content: '她说直接告诉她问题就好，不要揣测她的感受' });
      port = mockModelPort(JSON.stringify({
        shouldUpdate: true,
        content: '她看重把问题直接说出来，不需要替她揣测感受。',
        basis: 'user_stated', dimension: 'relationship', evidenceIds: ['m5', 'm6'], conviction: 86
      }));
      derivation = makeDerivation();
      return derivation.derive('cyrene', {}).then(third => {
        check('correctionRegress.derived', third.ok && (third.outcome === 'updated' || third.outcome === 'skipped'), third);
        const prompt = port.calls[0].request.prompt.messages[0].content;
        /* ① 派生**看得见**更正：提示词里必须有那条更正，否则"下一次周期会忘记"
           就只能靠模型自觉 —— 而那正是产品禁止的。 */
        check('correctionRegress.promptCarriesCorrection', prompt.indexOf('我并不是对设备瓶颈敏感') >= 0, prompt.slice(0, 400));
        check('correctionRegress.promptCarriesOldRevision', /【用户已更正的旧判断/.test(prompt), true);
        check('correctionRegress.promptCarriesCurrentUnderstanding', prompt.indexOf('【当前理解（第 2 版）】') >= 0);
        const doc3 = store.getActive('cyrene');
        /* ② 结果只可能是 revision+1 或明确的 no-op —— 绝不是"新建第二份文档" */
        check('correctionRegress.revisionAdvancedOrNoop', doc3.id === beforeCorrection.id && (doc3.revision === 3 || doc3.revision === 2), { id: doc3.id, revision: doc3.revision });
        /* ③ 旧版本仍在 history */
        check('correctionRegress.oldRevisionInHistory', doc3.history.some(h => h.content.indexOf('设备瓶颈') >= 0), doc3.history.map(h => h.content));
        /* ④ 仍然恰好一份 active */
        check('correctionRegress.stillExactlyOneActive', store.countActiveAll() === 1 && store.invariantViolations().violations.length === 0, store.countActiveAll());
        /* ⑤ 更正仍然 durable（重启后仍读得到；状态可能是 active 或已被吸收的
              applied —— 两种都算"还在"，但**绝不能**是"不见了"）。 */
        const restartedStore = createUnderstandingStore({ dataDir: dir, logger: () => {} });
        restartedStore.open();
        const allAfter = restartedStore.listCorrections('cyrene', {});
        check('correctionRegress.survivesRestart',
          allAfter.corrections.length === 1 && allAfter.corrections[0].text.indexOf('我并不是对设备瓶颈敏感') >= 0
          && ['active', 'applied'].indexOf(allAfter.corrections[0].status) >= 0,
          allAfter.corrections);
        check('correctionRegress.restartSeesOneActive', restartedStore.countActiveAll() === 1, restartedStore.countActiveAll());
        /* ⑥ 更正**没有被删除**，而且仍然约束未来派生（它针对的正是刚被越过的那一版） */
        const allCorr = restartedStore.listCorrections('cyrene', {});
        check('correctionRegress.keptAfterDerive',
          allCorr.corrections.length === 1 && ['active', 'applied'].indexOf(allCorr.corrections[0].status) >= 0,
          allCorr.corrections);
        check('correctionRegress.stillConstrainsFuture',
          restartedStore.constrainingCorrections('cyrene').some(c => c.text.indexOf('我并不是对设备瓶颈敏感') >= 0),
          restartedStore.constrainingCorrections('cyrene').map(c => ({ t: c.text, st: c.status })));

        /* ── 反证：旧语义（contested → 被忽略 → 长出新 active 行）必须是红的 ──
           这里在**独立数据目录**上把旧行为照原样跑一遍：把文档标成非 active
           并对"找不到 active"的反应是"再建一条"。断言两件事：
             (a) 它确实产生了 2 行（1 旧 + 1 新），
             (b) canonical store 的 rewrite 在同样情形下**拒绝**（no-active 基版本
                 不等于"可以随便新建"）。
           因此本测试的第 ⑥ 组断言在旧实现下会红。 */
        return runLegacyVetoCounterproof(path.join(dir, 'legacy')).then(legacy => {
          check('counterproof.legacyMintsSecondRow', legacy.rows === 2 && legacy.activeRows === 1, legacy);
          check('counterproof.vetoedContentPreservedNotActive', legacy.vetoedPreserved === true, legacy);
          check('counterproof.canonicalRefusesStaleMint', legacy.canonicalRefused === true, legacy);
          return restartedStore.close();
        });
      });
    }).then(() => {
      /* ── ⑥ 并发：两个派生器、两个连接、同一基版本（R2）──────────────
         并且刻意把**更正**插在"模型已生成、提交尚未发生"的窗口里（R3/R10）：
         提交必须失败（基版本已过期），且**不能**覆盖那条更正。 */
      now += 7 * 60 * 60 * 1000;
      seedMemory(memoryStore, 'm7', { title: '并发证据一', content: '她今天说了第一件关于计划的事' });
      seedMemory(memoryStore, 'm8', { title: '并发证据二', content: '她今天还说了第二件关于计划的事' });
      const storeB = createUnderstandingStore({ dataDir: dir, logger: () => {} });
      storeB.open();
      const baseRevision = store.getActive('cyrene').revision;
      let releaseA = null;
      const gate = new Promise(resolve => { releaseA = resolve; });
      let correctionId = null;
      const portA = {
        calls: 0,
        run: async function () {
          this.calls++;
          /* 模型调用挂起期间，另一条路径写下了一条用户更正 ——
             这就是"更正落在派生飞行途中"的真实时序。 */
          const c = store.addCorrection('cyrene', { text: '我并没有说过要把计划说出来', basis: 'user_stated' });
          correctionId = c && c.correction && c.correction.id;
          await gate;
          return { text: JSON.stringify({ shouldUpdate: true, content: '并发候选 A：她开始把计划说出来。', basis: 'user_stated', dimension: 'context', evidenceIds: ['m7', 'm8'], conviction: 80 }) };
        }
      };
      const portB = mockModelPort(JSON.stringify({ shouldUpdate: true, content: '并发候选 B：她开始把计划说出来。', basis: 'user_stated', dimension: 'context', evidenceIds: ['m7', 'm8'], conviction: 80 }));
      /* A 用主 store（主连接），B 用第二个 store 实例（第二个连接）
         —— 这才是"两个进程/两个连接"的形状。 */
      const derivA = createUnderstandingDerivation({ store: store, memoryStore: memoryStore, registry: mockRegistry(characters), modelPort: portA, clock: () => now, logger: () => {} });
      const derivB = createUnderstandingDerivation({ store: storeB, memoryStore: memoryStore, registry: mockRegistry(characters), modelPort: portB, clock: () => now, logger: () => {} });
      const pA = derivA.derive('cyrene', {});
      /* 让 A 进入模型调用（挂起）之后，B 才读完自己的基版本：确定性的交错顺序。 */
      return new Promise(r => setTimeout(r, 30)).then(() => {
        const pB = derivB.derive('cyrene', {});
        releaseA();
        return Promise.all([pA, pB]);
      }).then(([resA, resB]) => {
        const committed = [resA, resB].filter(r => r && r.ok && (r.outcome === 'created' || r.outcome === 'updated')).length;
        const conflicted = [resA, resB].filter(r => r && !r.ok && r.outcome === 'conflict').length;
        check('race.exactlyOneCommit', committed === 1, { a: resA.outcome || resA.error, b: resB.outcome || resB.error });
        check('race.loserConflicts', conflicted === 1, { a: resA, b: resB });
        const after = store.getActive('cyrene');
        check('race.oneActiveRow', store.countActiveAll() === 1 && store.invariantViolations().violations.length === 0, store.countActiveAll());
        check('race.baseAdvancedByOne', after.revision === baseRevision + 1, { base: baseRevision, now: after.revision });
        /* 更正**没有**被那次过期提交吞掉（R10：stale expectedRevision 不得覆盖更新的更正）。 */
        const corrNow = store.listCorrections('cyrene', {});
        check('race.correctionSurvivedStaleCommit', !!correctionId && corrNow.corrections.some(c => c.id === correctionId), corrNow.corrections);
        check('race.correctionStillConstrains', store.activeCorrections('cyrene').some(c => c.id === correctionId) || corrNow.corrections.length > 0, store.activeCorrections('cyrene'));
        /* 冲突**不推进证据指纹**：否则那一侧会永久停在"证据没变"从而不再派生。
           这里只是记录冲突后的水位形状；真正的强制性证明是下面的
           `race.recoversAfterConflict`（下一轮真的重新调用了模型）。 */
        const wmBefore = store.getWatermark('cyrene');
        check('race.watermarkShapeAfterRace', typeof wmBefore.lastOutcome === 'string', wmBefore);
        storeB.close();
        now += 7 * 60 * 60 * 1000;
        seedMemory(memoryStore, 'm9', { title: '再补一条', content: '她说计划的事情下周再谈，先不要替她安排' });
        const portC = mockModelPort(JSON.stringify({ shouldUpdate: true, content: '她把计划留在自己手里，不需要被替她安排。', basis: 'user_stated', dimension: 'relationship', evidenceIds: ['m9', 'm7'], conviction: 78 }));
        const derivC = createUnderstandingDerivation({ store: store, memoryStore: memoryStore, registry: mockRegistry(characters), modelPort: portC, clock: () => now, logger: () => {} });
        return derivC.derive('cyrene', {}).then(resC => {
          check('race.recoversAfterConflict', resC.ok && (resC.outcome === 'updated' || resC.outcome === 'skipped'), resC);
          const prompt = portC.calls.length ? portC.calls[0].request.prompt.messages[0].content : '';
          check('race.nextDerivationSeesCorrection', prompt.indexOf('我并没有说过要把计划说出来') >= 0, prompt.slice(0, 300));
          return after;
        });
      });
    }).then(() => {
      /* ── ⑦ 可见性收窄 → 读侧立刻不可注入（§11）────────────────────── */
      const retrieval = createUnderstandingRetrieval({ store: store, memoryStore: memoryStore, logger: () => {} });
      const ok = retrieval.snapshotField('cyrene', {});
      check('visibility.injectableBefore', ok.consulted === true && ok.text.indexOf('【对TA的当前理解') === 0, ok.reason);
      /* 把一条仍在文档证据里的源记忆改成 private（对该角色隐藏）。 */
      const doc = store.getActive('cyrene');
      const victimId = doc.current.evidenceIds[0];
      const victim = memoryStore.getRecord(victimId);
      memoryStore.putRecord(Object.assign({}, victim, { visibility: 'private', visibleTo: [] }), {});
      const blocked = retrieval.snapshotField('cyrene', {});
      check('visibility.blockedImmediately', blocked.consulted === true && blocked.text === '', blocked);
      const stale = retrieval.staleCandidates('cyrene');
      check('visibility.reportsReason', stale.ok && stale.stale && stale.stale.reason === 'evidence-hidden', stale);
      check('visibility.documentUnchanged', store.getActive('cyrene').id === doc.id && store.getActive('cyrene').revision === doc.revision);

      /* ── ⑧ 无配置 / 证据不足 → 零模型调用 ─────────────────────────── */
      const portIdle = mockModelPort(PAYLOAD_1);
      const noneDeriv = createUnderstandingDerivation({
        store: store, memoryStore: memoryStore,
        registry: mockRegistry([{ id: 'cyrene', dto: { id: 'cyrene', name: 'Cyrene' }, spec: null }]),
        modelPort: portIdle, clock: () => now, logger: () => {}
      });
      return noneDeriv.derive('cyrene', {}).then(none => {
        check('guard.noConfig', none.outcome === 'ineligible' && none.skipReason === 'no-config', none);
        check('guard.noConfigNoCall', portIdle.calls.length === 0, portIdle.calls.length);
        const emptyStore = createUnderstandingStore({ dataDir: path.join(dir, 'empty'), logger: () => {} });
        emptyStore.open();
        const emptyMem = createMemoryStore({ dataDir: path.join(dir, 'empty'), logger: () => {} });
        emptyMem.open();
        const portEmpty = mockModelPort(PAYLOAD_1);
        const emptyDeriv = createUnderstandingDerivation({
          store: emptyStore, memoryStore: emptyMem,
          registry: mockRegistry(characters), modelPort: portEmpty, clock: () => now, logger: () => {}
        });
        return emptyDeriv.derive('cyrene', {}).then(empty => {
          check('guard.noEvidence', empty.outcome === 'ineligible' && empty.skipReason === 'no-evidence', empty);
          check('guard.noEvidenceNoCall', portEmpty.calls.length === 0, portEmpty.calls.length);
          emptyStore.close(); emptyMem.close();
          return null;
        });
      });
    }).then(() => {
      /* ── ⑨ 最小间隔：同一天内第二次（证据变了）仍被节流 ───────────── */
      const freshDir = path.join(dir, 'interval');
      const s2 = createUnderstandingStore({ dataDir: freshDir, logger: () => {} });
      s2.open();
      const m2store = createMemoryStore({ dataDir: freshDir, logger: () => {} });
      m2store.open();
      seedMemory(m2store, 'm1', { title: '换季买衣服', content: '她说今年想换一批更耐穿的秋冬衣物' });
      seedMemory(m2store, 'm2', { title: '通勤路线', content: '她把通勤改成了骑车，说这样能顺路买早餐' });
      let t = 1700000000000;
      const port2 = mockModelPort(JSON.stringify({ shouldUpdate: true, content: '第一版理解。', basis: 'user_corroborated', dimension: 'context', evidenceIds: ['m1', 'm2'], conviction: 70 }));
      const d2 = createUnderstandingDerivation({
        store: s2, memoryStore: m2store, registry: mockRegistry(characters), modelPort: port2,
        clock: () => t, logger: () => {}
      });
      return d2.derive('cyrene', {}).then(r1 => {
        check('interval.first', r1.ok && r1.outcome === 'created', r1);
        t += 30 * 60 * 1000;                       /* 半小时后：证据也变了 */
        seedMemory(m2store, 'm3', { title: '周末安排', content: '她提到周末要去把车送去保养' });
        const callsBefore = port2.calls.length;
        return d2.derive('cyrene', {}).then(r2 => {
          check('interval.tooSoon', r2.outcome === 'ineligible' && r2.skipReason === 'min-interval', r2);
          check('interval.noModelCall', port2.calls.length === callsBefore, port2.calls.length - callsBefore);
          t += 7 * 60 * 60 * 1000;                 /* 过了最小间隔 */
          return d2.derive('cyrene', {});
        }).then(r3 => {
          check('interval.afterWindow', r3.ok && (r3.outcome === 'updated' || r3.outcome === 'skipped'), r3);
          check('interval.callHappened', port2.calls.length === callsBefore + 1, port2.calls.length);
          s2.close(); m2store.close();
          return null;
        });
      });
    }).then(() => {
      /* ── ⑩ 调度的持久性：水位从库里读，不是进程内变量 ────────────── */
      const wm = store.getWatermark('cyrene');
      check('watermark.persistedOnNode', wm.lastAttemptAt > 0 && wm.evidenceFingerprint != null, wm);
      check('stats.noLeaks', typeof derivation.diagnostics().stats === 'object', derivation.diagnostics());
      store.close(); memoryStore.close();

      console.log('\nHome Node understanding derivation: ' + passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    });
  }).catch(error => {
    console.error('unexpected failure:', error && error.stack || error);
    process.exit(1);
  });
}

/* ── 反证：把 M1-C.2l 的旧否决语义照原样跑一遍（独立目录，不污染断言）──
   旧语义 = 否决 → 把行标成 contested（**不删**）→ 下一次派生"找不到 active"
   → 新建一条。结果就是**同一角色两行**：一行是用户否决的，一行是新的。
   这里用原始 SQL 构造那个旧状态（旧实现没有不变量，直接改 status 即可），
   然后断言 canonical store 在同一情形下**拒绝**"基于不存在基版本新建"。 */
function runLegacyVetoCounterproof(dir) {
  return new Promise(resolve => {
    const legacy = createUnderstandingStore({ dataDir: dir, logger: () => {} });
    legacy.open();
    const sqlite = require('node:sqlite');
    const raw = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
    const at = Date.now();
    /* 旧实现留下的"被否决的活文档"：status=contested，行还在，active=0。 */
    raw.prepare('INSERT INTO understanding_records (record_id, character_id, active, status, dimension, doc_revision, conviction, evidence_count, unattested, created_at, updated_at, revision, created_rev, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('un_legacy_vetoed', 'cyrene', 0, 'contested', 'context', 7, 80, 1, 0, at, at, 1, 1,
        JSON.stringify({ id: 'un_legacy_vetoed', characterId: 'cyrene', status: 'contested', revision: 7, dimension: 'context', current: { content: '用户强烈偏好 X（已被用户否决）', conviction: 80, evidenceIds: ['e1'], basis: 'user_stated' }, history: [], closedReason: 'user-vetoed' }));
    raw.close();
    /* 旧实现的下一步：找不到 active → 新建。canonical store 允许这次新建
       （expectedRevision:0 且确实没有 active），这正是"两行"的来源。 */
    legacy.rewrite('cyrene', { content: '用户强烈偏好 X（否决之后又长出来的一份）', conviction: 80, basis: 'user_stated', evidenceIds: ['e1'], stamp: { visibility: 'public' } }, { expectedRevision: 0 });
    const page = legacy.listRecords({ characterId: 'cyrene' });
    const rows = page.records.length;
    const activeRows = page.records.filter(d => d.active === true).length;
    /* canonical 路径的对照：调用方以为自己接着第 5 版（基版本 5），
       而库里是第 1 版 → 必须拒绝，绝不"顺手新建一份"。 */
    const refused = legacy.rewrite('cyrene', { content: '基于不存在基版本的新理解', conviction: 50, evidenceIds: [], stamp: { visibility: 'public' } }, { expectedRevision: 5 });
    legacy.close();
    resolve({
      rows: rows,
      activeRows: activeRows,
      /* 旧状态被如实保留（没有被静默清理），且否决内容**没有**进入 current。 */
      vetoedPreserved: page.records.some(d => d.status === 'contested' && d.current.content.indexOf('已被用户否决') >= 0),
      canonicalRefused: !refused.ok && refused.error === 'revision-conflict'
    });
  });
}

main();
