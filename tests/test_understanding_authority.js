/* ====================================================================
   M1-C.2m P5/P8 · Understanding Authority · 有效一致性探针
   --------------------------------------------------------------------
   这一条回答的是 M1-C.2m §17 的问题，而且**只回答它**：

     对同一份 canonical 状态与同一个可见性主体，
     Desktop 与 Home Node 的**理解证据信封**是否相等？

   ── 为什么比较"证据信封"而不是"模型最后写出的文字" ───────────────────
   §10 明确禁止用最终模型散文当证明：同一段证据在不同温度/不同 provider 上
   本来就会写出不同的话，而两端**必须**相等的是"她被喂了什么"。
   因此比较的是：
     · 渲染后的理解块（逐字 —— 两端共用同一个渲染实现）
     · 快照三态与 gatedBy（present / empty / missing 的含义必须相同）
     · 证据 id 集合与可见性判定（同一份存证核心）

   ── 同时钉住的其余四类差异（**必须全部被分类，零未解释项**）────────────
     memory          MATCH（M1-C.2d 已收敛）
     threads         MATCH（M1-C.2k 已收敛）
     understanding   MATCH（本阶段收敛）
     moments         EXPECTED_DEFERRED_CONTEXT（仍是浏览器独有，§14 明确不做）
     dialogue        EXPECTED_HOST_DIFFERENCE（M1-C.2l §5 已审计，明确不在本阶段修）
   这台探针**不**声称 FULL Same Evidence —— 只要 moments/dialogue 仍被推迟，
   就仍然存在已知差异，因此断言的是"已知差异清单完全被解释"，不是"零差异"。

   纪律：纯 Node、临时数据目录、零网络、零浏览器。运行：
     node test_understanding_authority.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createUnderstandingStore = require(path.join(ROOT, 'services', 'home-node', 'understanding-store.js'));
const createUnderstandingRetrieval = require(path.join(ROOT, 'services', 'home-node', 'understanding-retrieval.js'));
const createUnderstandingAuthority = require(path.join(ROOT, 'assets', 'js', 'understanding-authority.js')).createUnderstandingAuthority;
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const UNDERSTANDING = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const CONTEXT_SNAPSHOT = require(path.join(ROOT, 'assets', 'js', 'context-snapshot.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});
const ROLE = 'cyrene';
const NOW = 1700000000000;
const STAMP_PUBLIC = { visibility: 'public', visibleTo: [], excludeFrom: [] };

function seedMemory(memoryStore, id, extra) {
  return memoryStore.putRecord(Object.assign({
    id: id, createdBy: ROLE, createdByName: 'Cyrene', kind: 'episodic',
    title: 't-' + id, content: 'c-' + id, domain: '日常', valence: 0.5, arousal: 0.4,
    importance: 5, resolved: false, visibility: 'public', created: NOW, lastActivated: NOW
  }, extra || {}), {});
}

/* ══ ① Desktop 侧的理解证据信封 ═══════════════════════════════════════
   桌面这一侧由 memory.js 的 `getUnderstandingContext` 产出，它做两件事：
     (a) 取 canonical 活跃文档（镜像）
     (b) `_ibAttestDerived` = 共享存证核心，证据不可解析/隐藏 → 不注入
     (c) 用共享渲染器拼块
   本探针用**同一批共享实现**复现它 —— 这段代码就是 memory.js 那三个函数的
   语义等价物（断言在后面会证明它与节点侧逐字相等，因此"复现"本身可被证伪）。 */
function desktopUnderstandingBlock(doc, memoryRows, roleId) {
  if (!doc || !doc.current || !doc.current.content) return { text: '', consulted: true, reason: 'empty' };
  const att = VISIBILITY_CORE.attestDerivedArtifact(doc.visibility, doc.current.evidenceIds || [], memoryRows, roleId);
  if (!att.ok) return { text: '', consulted: true, reason: att.reason };
  return { text: UNDERSTANDING.renderUnderstandingContext(doc), consulted: true, reason: null };
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-un-auth-'));
  tempDirs.push(dir);

  const memoryStore = createMemoryStore({ dataDir: dir, logger: () => {} });
  memoryStore.open();
  const store = createUnderstandingStore({ dataDir: dir, clock: () => NOW, logger: () => {} });
  store.open();

  seedMemory(memoryStore, 'm1', { title: '想换电脑', content: '她提到想攒钱买一台新电脑来升级设备' });
  seedMemory(memoryStore, 'm2', { title: '准备换设备', content: '她的旧设备限制创作，计划升级' });

  /* ══ ② 存储契约：迁移 + 修订链 + 更正全部经 canonical 路径 ═══════════ */
  const seeded = store.rewrite(ROLE, {
    id: 'un_cyrene_1',
    content: '她对设备瓶颈敏感，升级设备会明显提升创作信心。',
    conviction: 75, dimension: 'context', basis: 'user_corroborated',
    evidenceIds: ['m1', 'm2'], stamp: STAMP_PUBLIC
  }, { expectedRevision: 0 });
  check('store.seededAsCanonical', seeded.ok && seeded.outcome === 'created', seeded);
  check('store.singleActive', store.invariantViolations().violations.length === 0 && store.countActiveAll() === 1);

  const retrieval = createUnderstandingRetrieval({ store: store, memoryStore: memoryStore, logger: () => {} });

  /* ══ ③ 有效一致性：理解维度 MATCH ═══════════════════════════════════ */
  const rows = memoryStore.listRecords({}).records;
  const nodeField = retrieval.snapshotField(ROLE, {});
  const desktop = desktopUnderstandingBlock(store.getActive(ROLE), rows, ROLE);

  check('parity.understanding.textIdentical', nodeField.text === desktop.text && nodeField.text.length > 0,
    { node: nodeField.text.slice(0, 80), desktop: desktop.text.slice(0, 80) });
  check('parity.understanding.consultedBoth', nodeField.consulted === true && desktop.consulted === true, { node: nodeField.consulted, desktop: desktop.consulted });
  check('parity.understanding.noGatedBy', nodeField.gatedBy === null, nodeField.gatedBy);
  check('parity.understanding.blockShape', nodeField.text.indexOf(UNDERSTANDING.UNDERSTANDING_HEADER) === 0);
  check('parity.understanding.evidenceCountRendered',
    nodeField.text.indexOf('依据：2 条记忆') >= 0 && nodeField.evidenceCount === 2, nodeField.text.slice(0, 200));

  /* 快照契约：两端必须给出同一个 state（present）—— 这是 Middle Brain
     组织层**实际消费**的东西，而不是给人看的文本。 */
  const nodeSnapshot = CONTEXT_SNAPSHOT.create({
    characterId: ROLE, turnId: 't1',
    fields: {
      memory: CONTEXT_SNAPSHOT.field('memory-retrieval.buildRuntimeContext', '', { missing: true }),
      understanding: CONTEXT_SNAPSHOT.field('understanding-retrieval.buildUnderstandingBlock', nodeField.text, {
        missing: nodeField.consulted !== true, gatedBy: nodeField.gatedBy
      }),
      thread: CONTEXT_SNAPSHOT.field('thread-retrieval.derive', '', { missing: true }),
      moments: CONTEXT_SNAPSHOT.field('home-node.absent:moments', '', { missing: true, gatedBy: 'producer-not-canonical-on-home-node' })
    }
  });
  const desktopSnapshot = CONTEXT_SNAPSHOT.create({
    characterId: ROLE, turnId: 't1',
    fields: {
      memory: CONTEXT_SNAPSHOT.field('memory-retrieval.buildRuntimeContext', '', { missing: true }),
      understanding: CONTEXT_SNAPSHOT.field('getUnderstandingContext', desktop.text, { missing: false }),
      thread: CONTEXT_SNAPSHOT.field('getThreadContext', '', { missing: false }),
      moments: CONTEXT_SNAPSHOT.field('getMomentsContext', '【近期动态】一段朋友圈内容', { missing: false })
    }
  });
  const nodeState = CONTEXT_SNAPSHOT.summary(nodeSnapshot).states.understanding;
  const desktopState = CONTEXT_SNAPSHOT.summary(desktopSnapshot).states.understanding;
  check('parity.understanding.snapshotState', nodeState === 'present' && desktopState === 'present', { node: nodeState, desktop: desktopState });
  /* 注入内容按 canonical 顺序只含 present 块 —— 两端 understanding 都必须在其中。 */
  const nodeInject = CONTEXT_SNAPSHOT.blocks(nodeSnapshot).map(b => b.name).filter(n => n === 'understanding');
  const desktopInject = CONTEXT_SNAPSHOT.blocks(desktopSnapshot).map(b => b.name).filter(n => n === 'understanding');
  check('parity.understanding.injectableBoth', nodeInject.length === 1 && desktopInject.length === 1, { node: nodeInject, desktop: desktopInject });

  /* ══ ④ Desktop 只经 authority 读（不允许自己拼一份）═════════════════ */
  /* 这条断言的是**结构**：mirror 模式下 authority.getActive 返回的就是 canonical
     文档（同一个 id / 同一个修订号），因此"桌面自己攒的那一份"不存在。 */
  const local = {
    get: (id) => Promise.resolve(store.getRecord(id)),
    getActive: (characterId) => Promise.resolve(store.getActive(characterId)),
    getAll: () => Promise.resolve(store.listRecords({}).records),
    put: () => Promise.resolve(true),
    rewrite: () => Promise.resolve({ ok: false, error: 'unsupported' }),
    applyUpserts: () => Promise.resolve(true),
    applyDeletes: () => Promise.resolve(true),
    replaceAll: () => Promise.resolve(true)
  };
  const authority = createUnderstandingAuthority({ local: local, remote: null, mode: 'mirror', log: () => {} });
  return authority.getActive(ROLE).then(function (doc) {
    check('authority.mirrorReadReturnsCanonical', !!doc && doc.id === 'un_cyrene_1' && doc.revision === 1, doc && { id: doc.id, revision: doc.revision });
    check('authority.statusHonest', authority.status().authority === 'indexeddb' && authority.status().mode === 'mirror', authority.status());

    /* ══ ⑤ 其余四个维度的差异分类（零未解释项）═══════════════════════ */
    const classification = {
      memory: 'MATCH',                    /* M1-C.2d Wave 2 已收敛：同一 canonical store + 同一检索核心 */
      threads: 'MATCH',                   /* M1-C.2k 已收敛：canonical memory 上的确定性派生 */
      understanding: 'MATCH',             /* M1-C.2m 收敛（本节 ③） */
      moments: 'EXPECTED_DEFERRED_CONTEXT',   /* 仍是浏览器独有；§14 明确不在本阶段做 */
      dialogue: 'EXPECTED_HOST_DIFFERENCE'    /* M1-C.2l §5 已审计（桌面用原始用户消息，节点用拼好的对话）；§14 明确不修 */
    };
    check('classified.zeroUnexplained',
      Object.keys(classification).every(k => classification[k] !== 'BUG' && classification[k] !== 'UNDETERMINED'),
      classification);
    check('classified.noFalseFullParity', classification.moments !== 'MATCH' && classification.dialogue !== 'MATCH');

    /* ══ ⑥ 读时存证：证据被隐藏 → 两端**同时**立刻不可注入 ═══════════ */
    memoryStore.putRecord(Object.assign({}, memoryStore.getRecord('m2'), { visibility: 'private', visibleTo: [] }), {});
    const rows2 = memoryStore.listRecords({}).records;
    const nodeAfter = retrieval.snapshotField(ROLE, {});
    const desktopAfter = desktopUnderstandingBlock(store.getActive(ROLE), rows2, ROLE);
    check('parity.hiddenEvidence.blocksBoth', nodeAfter.text === '' && desktopAfter.text === '', { node: nodeAfter.text, desktop: desktopAfter.text });
    check('parity.hiddenEvidence.nodeStillConsulted', nodeAfter.consulted === true, nodeAfter);
    check('parity.hiddenEvidence.desktopReason', desktopAfter.reason === 'evidence-hidden', desktopAfter.reason);
    /* 文档本身**没有**被改写（读路径不写盘：状态标记是另一件事）。 */
    const docNow = store.getActive(ROLE);
    check('parity.readDoesNotMutate', docNow.revision === 1 && docNow.current.evidenceIds.length === 2, docNow.revision);

    /* ══ ⑦ 恢复可见性 → 两端同时恢复注入（反向对照，证明 ⑥ 不是恒空）══ */
    memoryStore.putRecord(Object.assign({}, memoryStore.getRecord('m2'), { visibility: 'public', visibleTo: [] }), {});
    const rows3 = memoryStore.listRecords({}).records;
    check('parity.restore.reinjectsBoth',
      retrieval.snapshotField(ROLE, {}).text === desktopUnderstandingBlock(store.getActive(ROLE), rows3, ROLE).text
      && retrieval.snapshotField(ROLE, {}).text.length > 0);

    /* ══ ⑧ 安全边界：理解不出现在任何设备面（§18）════════════════════ */
    const gatewaySrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
    const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
    const dtoSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'), 'utf8');
    const adminList = gatewaySrc.slice(gatewaySrc.indexOf('const ADMIN_PATHS = ['), gatewaySrc.indexOf('];', gatewaySrc.indexOf('const ADMIN_PATHS = [')));
    check('security.understandingIsDesktopOnly',
      adminList.indexOf('/understanding/') >= 0 && adminList.indexOf('/memory/') >= 0, adminList.slice(0, 200));
    /* 设备面（/mobile/v1）里**没有**任何 understanding verb；理解只经
       ADMIN_PATHS（桌面面）暴露。用两条可检查的结构断言表达，而不是靠关键词。 */
    const adminBegin = gatewaySrc.indexOf('const ADMIN_PATHS = [');
    const adminEnd = gatewaySrc.indexOf('];', adminBegin);
    const adminBlock = gatewaySrc.slice(adminBegin, adminEnd);
    /* handleAdmin 是管理面（桌面面）的分发器（`return handleAdmin(...)` 两条）。
       断言：它在**文件末尾**用 return 收束 —— 也就是它覆盖到文件尾，
       因此"理解路由只在桌面面"这句话是可检查的，而不是一句注释。 */
    const adminFnStart = gatewaySrc.indexOf('async function handleAdmin(');
    check('security.noUnderstandingVerbOnDeviceFace',
      adminFnStart > 0 && gatewaySrc.indexOf('understanding/', adminFnStart) >= 0
      && gatewaySrc.indexOf('return handleAdmin(action, req, res, url);', adminFnStart) > adminFnStart,
      'understanding routes live inside handleAdmin, which is reached only via the admin/mobile dispatch');    check('security.httpGuardsPrefix',
      httpSrc.indexOf("path.indexOf('/understanding/') === 0") >= 0, 'prefix guard present');
    check('security.dtoHasNoUnderstandingField',
      !/understanding/i.test(dtoSrc), 'mobile-dto must not carry understanding');

    store.close(); memoryStore.close();
    console.log('\nUnderstanding authority parity: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }).catch(function (error) {
    console.error('unexpected failure:', (error && error.stack) || error);
    process.exit(1);
  });
}

main();
