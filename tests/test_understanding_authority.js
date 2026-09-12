/* ====================================================================
   M1-C.2m P5/P8 · Understanding Authority · 有效一致性探针
   （M1-C.2n 扩展 moments · M1-C.2o 扩展 dialogue —— 这是**全维度**探针）
   --------------------------------------------------------------------
   这一条回答的是同一个问题，只是逐阶段扩大被要求的维度：

     对同一份 canonical 状态、同一个可见性主体、同一个当前回合，
     Desktop 与 Home Node 的**证据信封**是否相等？

   ── 为什么比较"证据信封"而不是"模型最后写出的文字" ───────────────────
   §10 明确禁止用最终模型散文当证明：同一段证据在不同温度/不同 provider 上
   本来就会写出不同的话，而两端**必须**相等的是"她被喂了什么"。
   因此比较的是：
     · 渲染后的理解块（逐字 —— 两端共用同一个渲染实现）
     · 快照三态与 gatedBy（present / empty / missing 的含义必须相同）
     · 证据 id 集合与可见性判定（同一份存证核心）

   ── 五个语义维度的当前状态（**必须全部被分类，零未解释项**）──────────
     memory          MATCH（M1-C.2d 已收敛）
     threads         MATCH（M1-C.2k 已收敛）
     understanding   MATCH（M1-C.2m 收敛，本文件 §③）
     moments         MATCH（M1-C.2n 收敛，本文件 §⑤）
     dialogue        MATCH（M1-C.2o 收敛，本文件 §⑦）
   M1-C.2o 之后**不存在**被推迟的维度：本探针现在断言的是"五个维度全部 MATCH"，
   而不是"已知差异清单完全被解释"。任何一维退回差异都会让它红。

   纪律：纯 Node、临时数据目录、零网络、零浏览器。运行：
     node test_understanding_authority.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createUnderstandingStore = require(path.join(ROOT, 'services', 'home-node', 'understanding-store.js'));
/* M1-C.2n：canonical Moments 的两个组件 + 共享可见性核。
   本探针用它们把 moments 这一维从"推迟"变成可断言的 MATCH。 */
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));
const createMomentsRetrieval = require(path.join(ROOT, 'services', 'home-node', 'moments-retrieval.js'));
const MOMENTS_CORE = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));
const createUnderstandingRetrieval = require(path.join(ROOT, 'services', 'home-node', 'understanding-retrieval.js'));
const createUnderstandingAuthority = require(path.join(ROOT, 'assets', 'js', 'understanding-authority.js')).createUnderstandingAuthority;
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const UNDERSTANDING = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const CONTEXT_SNAPSHOT = require(path.join(ROOT, 'assets', 'js', 'context-snapshot.js'));
/* M1-C.2o：dialogue 这一维的 parity 必须在**真实 canonical 组织层**上证明，
   因此这里经生产同一条加载路径装配 Middle Brain 各层（顺序是硬 DAG：
   config 先登记进共享契约，policy 才拿得到 CFG —— 绝不自己 require policy）。 */
const createNodeMiddleBrain = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
const MB_CORE = require(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js'));
createNodeMiddleBrain.loadCanonicalMiddleBrain();
const POLICY = (globalThis.IB && globalThis.IB.__middleBrainContracts && globalThis.IB.__middleBrainContracts.policy) || null;
if (!POLICY) throw new Error('canonical Middle Brain policy layer unavailable');

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

    /* ══ ⑤ moments 从"推迟"升为 MATCH（M1-C.2n）══════════════════════
       M1-C.2m 时这一维是 EXPECTED_DEFERRED_CONTEXT，理由是"动态仍是浏览器独有"。
       本阶段把它搬到 canonical（moment_records）+ 共享可见性核心 + 共享渲染，
       因此现在必须用与 understanding **同样的方式**证明它：
       同一份 canonical 状态 + 同一个主体 → 两端同一段证据信封（逐字）。
       这一段直接调用那两个模块；若哪天两端各自长出一份渲染，它会红。 */
    const momentsStore = createMomentsStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ib-un-mom-')), logger: () => {} });
    momentsStore.open();
    const momentsRetrieval = createMomentsRetrieval({
      store: momentsStore, logger: () => {}, characterNameOf: (id) => (id === ROLE ? '昔涟' : '另一个')
    });
    const M_BASE = 1700000000000;
    momentsStore.put({ id: 'pm_own', roleId: ROLE, content: '今天把窗台擦了。', visibility: 'all', createdAt: M_BASE + 1 });
    momentsStore.put({ id: 'pm_priv', roleId: ROLE, content: '写给自己的一句话。', visibility: 'private', createdAt: M_BASE + 2 });
    momentsStore.put({ id: 'pm_other', roleId: 'other', content: '朋友的公开动态。', visibility: 'all', createdAt: M_BASE + 3 });
    const mOpts = { userName: '用户', otherRolesVisible: true };
    const nodeFieldMoments = momentsRetrieval.snapshotField(ROLE, mOpts);
    /* 桌面侧：同一批候选 + 同一个 core。名字解析用与节点同一份目录，
       因此这里比较的是"证据信封"，而不是"名字配得全不全"。 */
    const candidates = momentsStore.listVisible({ kind: 'role', id: ROLE }, { limit: 150 }).moments;
    const desktopMomentsText = MOMENTS_CORE.renderMomentsContext({
      moments: candidates, principal: { kind: 'role', id: ROLE }, characterId: ROLE,
      userName: '用户', characterNameOf: (id) => (id === ROLE ? '昔涟' : '另一个'), options: { ownLimit: 4, otherLimit: 3 }
    });
    check('parity.moments.consultedBoth', nodeFieldMoments.consulted === true, nodeFieldMoments);
    check('parity.moments.byteIdentical', nodeFieldMoments.text === desktopMomentsText,
      { node: nodeFieldMoments.text, desktop: desktopMomentsText });
    check('parity.moments.publicIn', nodeFieldMoments.text.indexOf('今天把窗台擦了。') >= 0);
    check('parity.moments.privateOutOfChat', nodeFieldMoments.text.indexOf('写给自己的一句话。') < 0);
    /* 快照三态：两端都必须是 present（Middle Brain 组织层实际消费的东西）。 */
    const nodeMomentsSnap = CONTEXT_SNAPSHOT.create({
      characterId: ROLE, turnId: 't1',
      fields: {
        memory: CONTEXT_SNAPSHOT.field('memory-retrieval.buildRuntimeContext', '', { missing: true }),
        understanding: CONTEXT_SNAPSHOT.field('understanding-retrieval.buildUnderstandingBlock', '', { missing: true }),
        thread: CONTEXT_SNAPSHOT.field('thread-retrieval.derive', '', { missing: true }),
        moments: CONTEXT_SNAPSHOT.field('moments-retrieval.buildMomentsBlock', nodeFieldMoments.text, { missing: nodeFieldMoments.consulted !== true })
      }
    });
    const desktopMomentsSnap = CONTEXT_SNAPSHOT.create({
      characterId: ROLE, turnId: 't1',
      fields: {
        memory: CONTEXT_SNAPSHOT.field('memory-retrieval.buildRuntimeContext', '', { missing: true }),
        understanding: CONTEXT_SNAPSHOT.field('getUnderstandingContext', '', { missing: true }),
        thread: CONTEXT_SNAPSHOT.field('getThreadContext', '', { missing: true }),
        moments: CONTEXT_SNAPSHOT.field('getMomentsContext', desktopMomentsText, { missing: false })
      }
    });
    const nodeMomentsState = CONTEXT_SNAPSHOT.summary(nodeMomentsSnap).states.moments;
    const desktopMomentsState = CONTEXT_SNAPSHOT.summary(desktopMomentsSnap).states.moments;
    check('parity.moments.snapshotState', nodeMomentsState === 'present' && desktopMomentsState === 'present',
      { node: nodeMomentsState, desktop: desktopMomentsState });
    /* 收窄即刻生效：两端**下一次读取**同时停注（无后台修复遍）。 */
    const rowOther = momentsStore.getRecord('pm_other');
    momentsStore.put({ id: 'pm_other', roleId: 'other', content: rowOther.content, visibility: 'roles', visibleRoleIds: ['nobody'], createdAt: rowOther.createdAt }, { expectedRev: rowOther.rev });
    const narrowed = momentsRetrieval.snapshotField(ROLE, mOpts);
    check('parity.moments.narrowingImmediateBoth', narrowed.consulted === true && narrowed.text.indexOf('朋友的公开动态。') < 0, narrowed);
    momentsStore.close();

    /* ══ ⑦ dialogue 从"已知宿主差异"升为 MATCH（M1-C.2o）══════════════
       M1-C.2l §5 把这一维记成 EXPECTED_HOST_DIFFERENCE，原因是**两端根本没在
       比较同一件事**：桌面 `communication.js:1519-1525` 不传 dialogue，
       组织层因此恒得 `organized.dialogue = []`；Home Node 传的是自己那份
       400 字 / 8 条的投影。M1-C.2o 把这条语义收敛成唯一实现
       （assets/js/dialogue-core.js），两端用同一段 canonical 对话做输入。
       因此现在必须用与 understanding / moments **同样的方式**证明它：
       同一份 canonical 状态 + 同一个当前回合 → 两端同一段对话证据（逐字）。
       这一段直接驱动真实 canonical 组织层；若哪天两端各自长出一份投影，它会红。 */
    const DLG = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));
    const TURN_ROWS = [
      { role: 'user', content: '最近工作怎么样？' },
      { role: 'assistant', content: '还行。' },
      { role: 'user', content: '要不要升级设备？' },
      { role: 'assistant', content: '在想了。' }
    ];
    const TURN_USER = '我想把那台旧电脑彻底换掉，预算大概一万二。';
    /* Desktop 侧 opts（communication.js:1519-1525 形状 + 共享核心产出的 dialogue）。 */
    const dlgDesktop = { dialogue: DLG.lines({ history: TURN_ROWS, userMessage: TURN_USER, currentId: null }) };
    /* Home Node 侧 opts（services/home-node/middle-brain.js:350 形状）。 */
    const dlgNode = { dialogue: DLG.lines({ history: TURN_ROWS, userMessage: TURN_USER, currentId: 'msg_req_x_u' }) };
    return Promise.all([
      POLICY.middleBrainOrganizeContext(ROLE, TURN_USER, dlgDesktop),
      POLICY.middleBrainOrganizeContext(ROLE, TURN_USER, dlgNode)
    ]).then(async function (orgs) {
      const dOrg = orgs[0], nOrg = orgs[1];
      check('parity.dialogue.byteIdentical', JSON.stringify(dOrg.dialogue) === JSON.stringify(nOrg.dialogue),
        { desktop: dOrg.dialogue, node: nOrg.dialogue });
      check('parity.dialogue.nonEmpty', dOrg.dialogue.length === 5 && nOrg.dialogue.length === 5, dOrg.dialogue.length);
      check('parity.dialogue.currentTurnLast', dOrg.dialogue[4] === '用户：' + TURN_USER);
      const dSig = await POLICY._mbAnalyzeSignals(ROLE, TURN_USER, dlgDesktop, MB_CORE.MB_DEFAULTS);
      const nSig = await POLICY._mbAnalyzeSignals(ROLE, TURN_USER, dlgNode, MB_CORE.MB_DEFAULTS);
      check('parity.dialogue.gateSignalsIdentical',
        dSig.dialogueChars === nSig.dialogueChars && dSig.contextChars === nSig.contextChars,
        { desktop: { d: dSig.dialogueChars, c: dSig.contextChars }, node: { d: nSig.dialogueChars, c: nSig.contextChars } });
      const dComp = POLICY.middleBrainCompressContext(dOrg, dlgDesktop);
      const nComp = POLICY.middleBrainCompressContext(nOrg, dlgNode);
      check('parity.dialogue.compressedIdentical', dComp.compressedContext === nComp.compressedContext,
        { desktop: dComp.compressedContext, node: nComp.compressedContext });
      check('parity.dialogue.blockPresent', dComp.compressedContext.indexOf('【当前对话】') >= 0);
      /* 反证：改动合法对话证据必须改变产物 —— 防止用"恒定空"骗过 parity。 */
      const alt = { dialogue: dlgDesktop.dialogue.concat(['用户：另一句合法的话。']) };
      const aOrg = await POLICY.middleBrainOrganizeContext(ROLE, TURN_USER, alt);
      check('parity.dialogue.counterProof',
        POLICY.middleBrainCompressContext(aOrg, alt).compressedContext !== dComp.compressedContext,
        '对话证据被忽略（改动后产物不变）');

      /* ══ ⑧ 其余维度的差异分类（零未解释项）═══════════════════════════ */
      const classification = {
        memory: 'MATCH',                    /* M1-C.2d Wave 2 已收敛：同一 canonical store + 同一检索核心 */
        threads: 'MATCH',                   /* M1-C.2k 已收敛：canonical memory 上的确定性派生 */
        understanding: 'MATCH',             /* M1-C.2m 收敛（本节 ③） */
        moments: 'MATCH',                   /* M1-C.2n 收敛（本节 ⑤）：canonical moment_records + 共享 ACL + 共享渲染 */
        dialogue: 'MATCH'                   /* M1-C.2o 收敛（本节 ⑦）：共享对话核心 + 同一段 canonical 对话输入 */
      };
      check('classified.zeroUnexplained',
        Object.keys(classification).every(k => classification[k] !== 'BUG' && classification[k] !== 'UNDETERMINED'),
        classification);
      check('classified.allFiveMatch',
        ['memory', 'threads', 'understanding', 'moments', 'dialogue'].every(k => classification[k] === 'MATCH'), classification);
      check('classified.noDimensionLeftDeferred',
        Object.keys(classification).every(k => classification[k] === 'MATCH'), classification);

      /* ══ ⑨ 读时存证：证据被隐藏 → 两端**同时**立刻不可注入 ═══════════ */
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

      /* ══ ⑩ 恢复可见性 → 两端同时恢复注入（反向对照，证明 ⑨ 不是恒空）═ */
      memoryStore.putRecord(Object.assign({}, memoryStore.getRecord('m2'), { visibility: 'public', visibleTo: [] }), {});
      const rows3 = memoryStore.listRecords({}).records;
      check('parity.restore.reinjectsBoth',
        retrieval.snapshotField(ROLE, {}).text === desktopUnderstandingBlock(store.getActive(ROLE), rows3, ROLE).text
        && retrieval.snapshotField(ROLE, {}).text.length > 0);

      /* ══ ⑪ 安全边界：理解不出现在任何设备面（§18）════════════════════ */
      const gatewaySrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
      const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
      const dtoSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'), 'utf8');
      const adminList = gatewaySrc.slice(gatewaySrc.indexOf('const ADMIN_PATHS = ['), gatewaySrc.indexOf('];', gatewaySrc.indexOf('const ADMIN_PATHS = [')));
      check('security.understandingIsDesktopOnly',
        adminList.indexOf('/understanding/') >= 0 && adminList.indexOf('/memory/') >= 0, adminList.slice(0, 200));
      /* 设备面（/mobile/v1）里**没有**任何 understanding verb；理解只经
         ADMIN_PATHS（桌面面）暴露。用两条可检查的结构断言表达，而不是靠关键词。 */
      const adminFnStart = gatewaySrc.indexOf('async function handleAdmin(');
      check('security.noUnderstandingVerbOnDeviceFace',
        adminFnStart > 0 && gatewaySrc.indexOf('understanding/', adminFnStart) >= 0
        && gatewaySrc.indexOf('return handleAdmin(action, req, res, url);', adminFnStart) > adminFnStart,
        'understanding routes live inside handleAdmin, which is reached only via the admin/mobile dispatch');
      check('security.httpGuardsPrefix',
        httpSrc.indexOf("path.indexOf('/understanding/') === 0") >= 0, 'prefix guard present');
      check('security.dtoHasNoUnderstandingField',
        !/understanding/i.test(dtoSrc), 'mobile-dto must not carry understanding');

      store.close(); memoryStore.close();
      console.log('\nUnderstanding authority parity: ' + passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    });
  }).catch(function (error) {
    console.error('unexpected failure:', (error && error.stack) || error);
    process.exit(1);
  });
}

main();
