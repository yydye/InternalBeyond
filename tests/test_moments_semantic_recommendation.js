'use strict';

/* Internal Beyond · P25-2B · Moments Semantic Recommendation 测试
   （static 组：纯 Node、零浏览器、零网络；运行：
     node tests/test_moments_semantic_recommendation.js）

   P25-2B 把"一次模型调用同时返回 publish + content"收敛成"一次模型调用返回
   结构化 recommendation + draft"，并且：

     模型只**推荐**（post / skip），Autonomy 才**裁决**（allow / deny / defer），
     Executor 才**写**（createMoment）。recommendation:'post' 绝不等于 ALLOW。

   这一条测试覆盖 MS1–MS50：
     ① semantic 输出契约（闭集 recommendation / reasonCode / 禁推理字段 / draft 形状）
     ② topic identity（normalize → deterministic fingerprint；改措辞不改指纹）
     ③ 唯一 parser（旧 publish 契约只作为一处兼容 seam 投影进新契约）
     ④ 真实 adapter 组合（semantic → finalize candidate → runMomentAutonomy → executor）
     ⑤ 边界（scheduler / P23 / P24 / Autonomy Core / Memory / MB / writer 都不动） */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

const Sem = require(path.join(ROOT, 'assets', 'js', 'moments-semantic-core.js'));
const Core = require(path.join(ROOT, 'assets', 'js', 'autonomy-core.js'));
const MA = require(path.join(ROOT, 'assets', 'js', 'moments-autonomy.js'));
const createMomentsAuthority = require(path.join(ROOT, 'assets', 'js', 'moments-authority.js')).createMomentsAuthority;
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));
const MOMENTS_VIS = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));
/* 真实 JSON 提取器：浏览器 `_activeParsePlanJson` 的逐字孪生（Node 侧唯一实现）。 */
const PLAN_DOMAIN = require(path.join(ROOT, 'active', 'plan-domain.js'))({ getState: () => ({}), armedUsers: new Set(), saveNow: () => {} });
const PARSE = { parseJson: PLAN_DOMAIN.parsePlanJson };

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 360))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;
/* 语义评估函数的**代码切片**：只到下一个顶层函数为止（P25-2C 之后紧跟的是
   autonomy adapter 解析点；此后才是管线与 legacy wrapper）。 */
function semanticFnSlice(src) {
  const body = stripComments(src);
  const start = body.indexOf('async function evaluateRoleMomentSemantic(');
  if (start < 0) return '';
  const stops = ['function _momentsAutonomyAdapter(', 'async function generateRoleMoment(']
    .map(m => body.indexOf(m, start)).filter(i => i > start);
  return body.slice(start, stops.length ? Math.min.apply(null, stops) : body.length);
}
/* 任意顶层 async function 的代码切片：从它自己到**下一个**顶层 async function。 */
function fnSlice(src, name) {
  const body = stripComments(src);
  const start = body.indexOf('async function ' + name + '(');
  if (start < 0) return '';
  const next = body.indexOf('\nasync function ', start + 1);
  return body.slice(start, next > start ? next : body.length);
}

/* 冻结基线（P25-2B 开工前实测） */
const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8',
  'assets/js/active-diary.js': 'EEAC85AB0CB215723AD641D416606B941C2EBABBE99CB373A6DA1661A6964E26',
  'active/moments.js': 'C29341FFABB0AC3C1AFD1A896122F754F1E226248ED185F8119BCA38B326B3D2'
};

const FIXED_NOW = 1770000000000;
const ACTOR = 'role_semantic';
const PREFS_OK = { enabled: true, autoPublish: true, frequency: 'medium' };
const TRIGGER_REF = 'tick:2026-09-19T10:00Z';
const EMPTY_DIAG = { stage: '' };

const v2Post = (patch) => Object.assign({
  recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window',
  draft: { content: '今天把窗台擦干净了，外面一直在下雨。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }
}, patch || {});
const v2Skip = (patch) => Object.assign({ recommendation: 'skip', reasonCode: 'nothing-to-share' }, patch || {});
const parse = (raw, opts) => Sem.parseMomentSemanticOutput(raw, Object.assign({}, PARSE, opts || {}));
const parseObj = (obj, opts) => parse(JSON.stringify(obj), opts);
const legacyView = (obj) => Sem.parseMomentOutputLegacy(JSON.stringify(obj), PARSE);

const tempDirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibsem-')); tempDirs.push(dir); return dir; }
process.on('exit', () => { for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } } });

const MOMENTS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments.js'), 'utf8').replace(/^\uFEFF/, '');
const SEMANTIC_CORE_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments-semantic-core.js'), 'utf8').replace(/^\uFEFF/, '');
const AUTONOMY_CORE_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'autonomy-core.js'), 'utf8').replace(/^\uFEFF/, '');
const AUTONOMY_ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments-autonomy.js'), 'utf8').replace(/^\uFEFF/, '');
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const VOICE_CORE = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));

function makeLocalDriver(rows) {
  return {
    get: (id) => Promise.resolve(rows.get(String(id)) || null),
    getAll: () => Promise.resolve(Array.from(rows.values())),
    getByOwner: (roleId) => Promise.resolve(Array.from(rows.values()).filter(r => String(r.roleId) === String(roleId))),
    put: (row) => { if (!row || row.id == null) return Promise.resolve(false); rows.set(String(row.id), row); return Promise.resolve(true); },
    remove: (id) => { rows.delete(String(id)); return Promise.resolve(true); },
    replaceAll: (list) => { rows.clear(); (list || []).forEach(r => rows.set(String(r.id), r)); return Promise.resolve(true); },
    markMigrated: () => Promise.resolve({ ok: true }),
    deliveryState: () => Promise.resolve(null),
    saveDeliveryState: () => Promise.resolve(true)
  };
}
function makeStoreRemote(store) {
  return {
    health: () => Promise.resolve({ ok: true }),
    list: () => Promise.resolve({ ok: true, records: [], revision: 0 }),
    changes: () => Promise.resolve({ ok: true, upserts: [], deletes: [], cursor: 0, revision: 0 }),
    ack: () => Promise.resolve({ ok: true }),
    visible: () => Promise.resolve({ ok: true, moments: [] }),
    put: (record, options) => Promise.resolve(store.put(record, { requestId: options && options.requestId, expectedRev: options && options.expectedRev })),
    remove: (id, options) => Promise.resolve(store.remove(id, { requestId: options && options.requestId, expectedRev: options && options.expectedRev })),
    migrateBatch: () => Promise.resolve({ ok: true }),
    migrationState: () => Promise.resolve({ ok: true }),
    markMigration: () => Promise.resolve({ ok: true })
  };
}
/* 真实 moments.js 沙箱（与 P25-2A 测试同一策略：canonical 后端是真实 store，
   只有 HTTP 传输被替换；dbPut 守卫复刻 home-node-bootstrap 的语义）。 */
function buildPage(opts) {
  opts = opts || {};
  const rows = new Map();
  const stats = { directPut: 0, directPutBlocked: 0, directPutOk: 0, timers: 0 };
  const stored = new Map();
  const sandbox = {};
  const IB = { expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); } };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.IB = IB;
  sandbox.console = { log() {}, info() {}, warn() {}, error() {} };
  sandbox.setTimeout = function () { stats.timers++; return 0; };
  sandbox.clearTimeout = function () {};
  sandbox.localStorage = {
    getItem: (k) => (stored.has(String(k)) ? stored.get(String(k)) : null),
    setItem: (k, v) => { stored.set(String(k), String(v)); },
    removeItem: (k) => { stored.delete(String(k)); }
  };
  sandbox.IBMomentsVisibilityCore = MOMENTS_VIS;
  sandbox.IBChatCore = CHAT_CORE;
  sandbox.IBVoiceMessage = VOICE_CORE;
  /* 真实 JSON 提取器（active/plan-domain.js 的 parsePlanJson = 浏览器
     `_activeParsePlanJson` 的逐字孪生）。这里在**沙箱内部**包一层 realm 归一：
     跨 realm 得到的普通对象在 vm 里不满足 `Object.getPrototypeOf(x)===Object.prototype`，
     而它与浏览器里"同一个 realm 的 JSON.parse 结果"是同一件事。 */
  sandbox.__ibParsePlanJsonRaw = PLAN_DOMAIN.parsePlanJson;
  sandbox.apiConfigs = [];
  sandbox.archivedConfigs = [];
  sandbox.currentPage = 'settings';
  sandbox.loadMomentsPage = function () {};
  sandbox._activeUserId = () => 'user_local';
  /* 页面全局（active-diary.js 提供）：上下文读取与相似度。测试里以最小实现代替，
     让"语义评估接缝"跑在真实 moments.js 代码上而不去碰浏览器存储。 */
  sandbox._activeRecentMemories = () => Promise.resolve([]);
  sandbox._activeRecentProactiveMessages = () => Promise.resolve([]);
  sandbox._activeRecentMessages = () => Promise.resolve([]);
  sandbox._activeTextSimilarity = (a, b) => (String(a) === String(b) ? 1 : 0);
  sandbox._activeParsePlanJson = null;
  sandbox.dbPut = function (store, row) {
    return new Promise((resolve, reject) => {
      if (String(store) === 'moments') {
        stats.directPut++;
        if (opts.authorityEffective) {
          stats.directPutBlocked++;
          const e = new Error('moments 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
          e.code = 'moments-write-closed';
          reject(e);
          return;
        }
        rows.set(String(row.id), row); stats.directPutOk++; resolve(undefined); return;
      }
      resolve(undefined);
    });
  };
  sandbox.dbDelete = function (store, key) { rows.delete(String(key)); return Promise.resolve(undefined); };
  sandbox.dbGet = (store, key) => Promise.resolve(rows.get(String(key)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  vm.createContext(sandbox);
  vm.runInContext(
    '(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();',
    sandbox, { filename: 'parse-plan-json-bridge.js' });
  /* 语义核在**沙箱内部**加载：它的 root 就是页面全局，因此
     `_activeParsePlanJson` / `IBChatCore` / `IBMomentsVisibilityCore` 都按页面规则解析
     （这正是浏览器里的解析方式；把 Node 侧实例塞进去会跨 realm 而看不到页面全局）。 */
  vm.runInContext(SEMANTIC_CORE_SRC, sandbox, { filename: 'moments-semantic-core.js' });
  /* P25-2C：autonomous 触发的裁决层现在真的在页面里（autonomy-core + adapter），
     沙箱必须与页面同构，否则管线会 fail closed 成 autonomy-adapter-missing。 */
  vm.runInContext(AUTONOMY_CORE_SRC, sandbox, { filename: 'autonomy-core.js' });
  vm.runInContext(AUTONOMY_ADAPTER_SRC, sandbox, { filename: 'moments-autonomy.js' });
  vm.runInContext(MOMENTS_SRC, sandbox, { filename: 'moments.js' });
  sandbox.loadMomentsPage = function () {};
  let store = null;
  if (opts.authorityEffective) {
    store = createMomentsStore({ dataDir: tempDir(), logger: () => {} });
    store.open();
    const authority = createMomentsAuthority({
      remote: makeStoreRemote(store), local: makeLocalDriver(rows),
      mode: 'canonical', fileOrigin: false, log: function () {}
    });
    IB.homeNode = {
      moments: {
        instance: authority, available: true, authority: authority,
        status: function () { return authority.status(); },
        put: function (record, options) { return authority.put(record, options || {}); },
        remove: function (id, options) { return authority.remove(id, options || {}); }
      }
    };
  }
  return {
    sandbox, stats, rows, store,
    createMoment: (data, options) => sandbox.window.createMoment(data, options),
    liveCount: () => (store ? store.countLive() : rows.size),
    canonicalRow: (id) => (store ? store.getRecord(id) : rows.get(String(id)) || null)
  };
}

async function main() {
  console.log('== P25-2B · Moments Semantic Recommendation 测试 ==');

  /* ══════════ A · Semantic contract（MS2–MS9 / MS19–MS23） ══════════ */
  section('A · Semantic output contract（MS2–MS9 / MS19–MS23）');
  const post = parseObj(v2Post());
  check('MS2.postContractValid',
    post.ok === true && post.contract === Sem.CONTRACT_ID
    && post.recommendation.recommendation === 'post' && post.recommendation.reasonCode === 'meaningful-moment'
    && post.recommendation.topicKey === 'rainy-window' && /^mt_[0-9a-z]+$/.test(post.recommendation.topicFingerprint)
    && post.draft.content === '今天把窗台擦干净了，外面一直在下雨。' && post.draft.visibility === 'all', post);
  const skip = parseObj(v2Skip());
  check('MS3.skipContractValid',
    skip.ok === true && skip.recommendation.recommendation === 'skip' && skip.draft === null
    && skip.recommendation.reasonCode === 'nothing-to-share', skip);
  check('MS4.unknownRecommendationRejected',
    parseObj(v2Post({ recommendation: 'allow' })).error === 'unknown-recommendation'
    && parseObj(v2Post({ recommendation: 'publish' })).stage === 'schema-unknown-recommendation'
    && parseObj(v2Post({ recommendation: 'maybe' })).ok === false);
  check('MS5.missingRecommendationRejected',
    parseObj({ reasonCode: 'meaningful-moment', topicKey: 'x', draft: { content: 'y' } }).error === 'missing-recommendation'
    && parseObj({ recommendation: '', reasonCode: 'meaningful-moment' }).ok === false);
  check('MS6.reasonCodeClosed',
    JSON.stringify(Sem.MOMENT_SEMANTIC_POST_REASONS) === JSON.stringify([
      'meaningful-moment', 'personal-feeling', 'reflection-on-recent', 'interaction-followup', 'curiosity-share', 'social-response'])
    && JSON.stringify(Sem.MOMENT_SEMANTIC_SKIP_REASONS) === JSON.stringify([
      'nothing-to-share', 'too-similar-recent', 'low-substance', 'no-context', 'unsuitable-content'])
    && Sem.MOMENT_SEMANTIC_POST_REASONS.every(c => parseObj(v2Post({ reasonCode: c })).ok === true)
    && Sem.MOMENT_SEMANTIC_SKIP_REASONS.every(c => parseObj(v2Skip({ reasonCode: c })).ok === true)
    && parseObj(v2Post({ reasonCode: 'whatever' })).error === 'unknown-reason-code');
  check('MS7.postWithSkipReasonRejected',
    parseObj(v2Post({ reasonCode: 'nothing-to-share' })).error === 'reason-code-direction-mismatch'
    && parseObj(v2Post({ reasonCode: 'nothing-to-share' })).stage === 'schema-reason-direction');
  check('MS8.skipWithPostReasonRejected',
    parseObj(v2Skip({ reasonCode: 'meaningful-moment' })).error === 'reason-code-direction-mismatch');
  check('MS9.forbiddenReasoningFieldRejected',
    ['thinking', 'reasoning', 'analysis', 'rationale', 'explanation', 'chain_of_thought', 'cot', 'scratchpad', 'steps']
      .every(f => parseObj(v2Post(Object.assign({}, { [f]: '因为……' }))).error === 'forbidden-reasoning-field')
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { thinking: 'x' }) })).error === 'forbidden-reasoning-field');
  check('MS10.noCotStored',
    JSON.stringify(post).indexOf('因为') < 0 && !('thinking' in post) && !('reasoning' in post)
    && stripComments(read('assets/js/moments-semantic-core.js')).indexOf('thinking') >= 0 /* 只出现在禁词表里 */);
  check('MS19.visibilityClosed',
    ['all', 'user', 'private'].every(v => parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: v }) })).ok === true)
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: 'roles', visibleRoleIds: ['role_b'] }) })).ok === true
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: 'everyone' }) })).error === 'invalid-visibility'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: '' }) })).draft.visibility === 'all');
  check('MS20.rolesRequiresVisibleRoleIds',
    parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: 'roles', visibleRoleIds: ['role_b'] }) })).draft.visibleRoleIds.join(',') === 'role_b'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { visibility: 'roles', visibleRoleIds: [] }) })).error === 'roles-without-visible-role-ids');
  check('MS21.motiveUsesExistingEnum',
    Sem.MOMENT_SEMANTIC_MOTIVES.join(',') === 'share,daily_life,emotion,reflection,interaction,curiosity,social_response,none'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { motive: 'reflection' }) })).draft.motive === 'reflection'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { motive: 'none' }) })).draft.motive === 'daily_life'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { motive: 'brag' }) })).error === 'invalid-motive'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { motive: '' }) })).draft.motive === 'daily_life');
  check('MS22.wantImagePreserved',
    parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { wantImage: true, imagePrompt: '窗台上的水痕' }) })).draft.wantImage === true
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { wantImage: true, imagePrompt: '窗台上的水痕' }) })).draft.imagePrompt === '窗台上的水痕'
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { wantImage: false }) })).draft.wantImage === false);
  check('MS23.imagePromptPreserved',
    parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { wantImage: true, imagePrompt: 'x'.repeat(900) }) })).draft.imagePrompt.length === 600);
  check('MS18.contentMaxPreserved',
    parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { content: 'x'.repeat(2000) }) })).draft.content.length === 2000
    && parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { content: 'x'.repeat(2001) }) })).error === 'draft-content-too-long');
  check('MS16.postRequiresNonemptyDraft',
    parseObj(v2Post({ draft: { content: '   ', visibility: 'all' } })).error === 'empty-draft-content'
    && parseObj(v2Post({ draft: undefined })).error === 'missing-draft');
  check('MS17.skipAllowsNoDraftAndIgnoresDraft', (() => {
    const noDraft = parseObj(v2Skip());
    const withDraft = parseObj(v2Skip({ draft: { content: '草稿看起来很好。', visibility: 'all' } }));
    return noDraft.ok === true && noDraft.draft === null
      && withDraft.ok === true && withDraft.draft === null && withDraft.ignoredDraft === true;
  })());
  check('MS19b.conflictingContractsRejected',
    parseObj({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'x', publish: true, content: 'y', draft: { content: 'y' } }).error === 'conflicting-contract');

  /* ══════════ B · Topic identity（MS11–MS15） ══════════ */
  section('B · Topic identity / fingerprint（MS11–MS15）');
  check('MS11.postRequiresTopicIdentity',
    parseObj(v2Post({ topicKey: undefined })).error === 'missing-topic-key'
    && parseObj(v2Post({ topicKey: '' })).error === 'missing-topic-key');
  check('MS12.topicNormalizedDeterministically', (() => {
    const a = Sem.normalizeTopicKey('  Rainy   Window  ');
    const b = Sem.normalizeTopicKey('Rainy   Window');
    const c = Sem.normalizeTopicKey('rainy-window');
    return a.ok && a.topicKey === 'Rainy-Window' && b.topicKey === a.topicKey && c.topicKey === 'rainy-window'
      && Sem.momentTopicFingerprint(a.topicKey) === Sem.momentTopicFingerprint(b.topicKey)
      && Sem.momentTopicFingerprint('rainy-window') === Sem.momentTopicFingerprint('rainy-window');
  })());
  check('MS13.topicMustNotBeDraft',
    Sem.normalizeTopicKey('今天把窗台擦干净了，外面一直在下雨。', '今天把窗台擦干净了，外面一直在下雨。').error === 'topic-key-looks-like-draft'
    && Sem.normalizeTopicKey('今天把窗台擦干净了，外面一直在下雨。').error === 'topic-key-looks-like-draft'
    && Sem.normalizeTopicKey('x'.repeat(80)).error === 'topic-key-too-long');
  check('MS14.paraphraseKeepsFingerprint', (() => {
    const first = parseObj(v2Post());
    const second = parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { content: '窗外还在下雨，我把窗台擦干净了。' }) }));
    return first.ok && second.ok && first.recommendation.topicFingerprint === second.recommendation.topicFingerprint
      && first.draft.content !== second.draft.content;
  })());
  check('MS15.differentTopicDifferentFingerprint',
    parseObj(v2Post()).recommendation.topicFingerprint !== parseObj(v2Post({ topicKey: 'sunny-balcony' })).recommendation.topicFingerprint
    && parseObj(v2Skip()).recommendation.topicFingerprint === '');
  check('MS12b.cjkTopicSupported',
    Sem.normalizeTopicKey('雨天的窗台').topicKey === '雨天的窗台'
    && Sem.momentTopicFingerprint('雨天的窗台') !== Sem.momentTopicFingerprint('晴天的阳台'));
  check('MS12c.noClockNoRandom',
    !/\bDate\.now\b/.test(stripComments(read('assets/js/moments-semantic-core.js')))
    && !/\bMath\.random\b/.test(stripComments(read('assets/js/moments-semantic-core.js'))));

  /* ══════════ C · Legacy compatibility seam（MS28/MS29 + 旧测试契约） ══════════ */
  section('C · Legacy publish compatibility（MS28/MS29）');
  const legacyPost = legacyView({ publish: true, content: '今天出去走了走。' });
  check('MS29.legacyPublishMapsToRecommendation',
    legacyPost && legacyPost.publish === true && legacyPost.content === '今天出去走了走。'
    && legacyPost.motive === 'daily_life'
    && JSON.stringify(Object.keys(legacyPost).sort()) === JSON.stringify(['content', 'imagePrompt', 'motive', 'publish', 'reason', 'visibility', 'visibleRoleIds', 'wantImage']),
    legacyPost);
  check('MS28.legacyPublishIsNotPermission', (() => {
    const semantic = parseObj({ publish: true, content: '今天出去走了走。' });
    const rec = Sem.toAdapterRecommendation(semantic);
    /* 旧契约只投影成 recommendation:'post'，绝不产生决策词（allow/deny/defer）。 */
    return semantic.ok === true && semantic.recommendation.source === 'legacy'
      && rec.recommendation === 'post' && rec.reasonCode === 'meaningful-moment'
      && ['allow', 'deny', 'defer'].indexOf(rec.recommendation) < 0
      && !('decision' in rec) && !('permission' in rec);
  })());
  check('MS29b.legacyDeclineKeepsRawReason',
    (() => {
      const v = legacyView({ publish: false, reason: '没什么想说的' });
      const s = parseObj({ publish: false, reason: '没什么想说的' });
      return v.publish === false && v.reason === '没什么想说的' && v.motive === 'none' && v.wantImage === undefined
        && s.recommendation.recommendation === 'skip' && s.legacyReason === '没什么想说的'
        && s.recommendation.topicFingerprint === '';
    })());
  check('MS29c.legacyFieldsNormalized',
    legacyView({ publish: true, content: 'x', wantImage: true, imagePrompt: 'desc' }).wantImage === true
    && legacyView({ publish: true, content: 'y', includeImage: true, imagePrompt: 'desc' }).wantImage === true
    && legacyView({ publish: true, content: 'z', visibility: 'everyone' }) === null
    && legacyView({ publish: 'true', content: 'x' }) === null
    && legacyView({ publish: true, content: '' }) === null);
  check('MS29d.legacyMotiveMapsToSemanticReason',
    parseObj({ publish: true, content: 'x', motive: 'emotion' }).recommendation.reasonCode === 'personal-feeling'
    && parseObj({ publish: true, content: 'x', motive: 'reflection' }).recommendation.reasonCode === 'reflection-on-recent'
    && parseObj({ publish: true, content: 'x', motive: 'none' }).recommendation.reasonCode === 'meaningful-moment'
    && parseObj({ publish: true, content: 'x', motive: 'bogus' }).recommendation.reasonCode === 'meaningful-moment');
  check('MS29e.legacyJsonExtractionUnchanged',
    Sem.parseMomentOutputLegacy('```json\n' + JSON.stringify({ publish: true, content: 'F' }) + '\n```', PARSE).publish === true
    && Sem.parseMomentOutputLegacy('好的：\n' + JSON.stringify({ publish: true, content: 'S' }) + '\n以上。', PARSE).publish === true
    && Sem.parseMomentOutputLegacy('{"publish":true,"content":"截断', PARSE) === null
    && Sem.parseMomentOutputLegacy('', PARSE) === null
    && Sem.parseMomentOutputLegacy(null, PARSE) === null);
  check('MS5b.emptyInputRejected',
    parse('').stage === 'empty-output' && parse('   ').stage === 'empty-output'
    && parse('今天出去走了走，天气还不错。').stage === 'no-json-object'
    && parse('{"recommendation":"post"').stage === 'json-parse-failed');
  check('MS30.noJsonExtractorFailsClosed',
    Sem.parseMomentSemanticOutput(JSON.stringify(v2Post()), { parseJson: null }).error === 'no-json-extractor'
    && !/function\s+_activeParsePlanJson/.test(read('assets/js/moments-semantic-core.js')));

  /* ══════════ D · Adapter integration（MS33–MS38） ══════════ */
  section('D · Adapter integration（MS33–MS38）');
  const semanticPost = parseObj(v2Post());
  const adapterRec = Sem.toAdapterRecommendation(semanticPost);
  const finalSeed = { actorId: ACTOR, source: 'schedule', triggerRef: TRIGGER_REF };
  const finalized = MA.finalizeMomentCandidate(finalSeed, adapterRec);
  check('MS33.adapterStillModelFree', (() => {
    const src = stripComments(read('assets/js/moments-autonomy.js'));
    return !/generateRoleMoment|_momentsModelCall|buildMomentPrompt|IB\.runtime\.instance\.execute|callApiChat|fetch\s*\(/.test(src)
      && !/setInterval|setTimeout|localStorage|indexedDB/.test(src);
  })());
  check('MS33b.adapterAcceptsSemanticReasonVocabulary',
    Sem.MOMENT_SEMANTIC_POST_REASONS.every(c => MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: c, topicFingerprint: 'mt_x', draft: 'd' }).ok === true)
    && Sem.MOMENT_SEMANTIC_SKIP_REASONS.every(c => MA.normalizeMomentRecommendation({ recommendation: 'skip', reasonCode: c, topicFingerprint: 'mt_x' }).ok === true)
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'scheduled-window', topicFingerprint: 'mt_x', draft: 'd' }).ok === true,
    MA.MOMENT_CONTRACT_VERSION);
  check('MS34.semanticPostReachesExplicitPolicy', (() => {
    return finalized.ok === true && finalized.candidate.topicFingerprint === semanticPost.recommendation.topicFingerprint;
  })(), finalized);
  const writer = { calls: 0, fn: (payload) => { writer.calls++; return Promise.resolve({ ok: true, moment: Object.assign({ id: payload.id }, payload) }); } };
  const allowRun = await MA.runMomentAutonomy(Object.assign({}, finalSeed, { topicFingerprint: adapterRec.topicFingerprint, draft: adapterRec.draft }), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: adapterRec, writeMoment: writer.fn
  });
  check('MS38.postPlusAllowExecutesOnce',
    allowRun.decision === 'allow' && allowRun.executed === true && allowRun.ok === true && writer.calls === 1
    && allowRun.candidateId === finalized.candidate.candidateId, { decision: allowRun.decision, calls: writer.calls });
  const skipWriter = { calls: 0, fn: () => { skipWriter.calls++; return Promise.resolve({ ok: true }); } };
  const skipFrozen = Sem.toAdapterRecommendation(parseObj(v2Skip({ topicKey: 'quiet-day' })));
  const skipRun = await MA.runMomentAutonomy(Object.assign({}, finalSeed, { topicFingerprint: skipFrozen.topicFingerprint }), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: skipFrozen, writeMoment: skipWriter.fn
  });
  check('MS35.semanticSkipExecutesZero',
    skipRun.decision === 'deny' && skipRun.reason === 'recommendation-skip' && skipWriter.calls === 0 && skipRun.written === false);
  const denyWriter = { calls: 0, fn: () => { denyWriter.calls++; return Promise.resolve({ ok: true }); } };
  const denyRun = await MA.runMomentAutonomy(Object.assign({}, finalSeed, { topicFingerprint: adapterRec.topicFingerprint, draft: adapterRec.draft }), {
    now: FIXED_NOW, prefs: { enabled: false, autoPublish: true, frequency: 'medium' },
    recommendation: adapterRec, writeMoment: denyWriter.fn
  });
  check('MS36.postPlusPolicyDenyExecutesZero',
    denyRun.decision === 'deny' && denyRun.reason === 'prefs-disabled' && denyWriter.calls === 0);
  const deferWriter = { calls: 0, fn: () => { deferWriter.calls++; return Promise.resolve({ ok: true }); } };
  const deferRun = await MA.runMomentAutonomy(Object.assign({}, finalSeed, { topicFingerprint: adapterRec.topicFingerprint, draft: adapterRec.draft }), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: adapterRec, writeMoment: deferWriter.fn,
    extraPolicy: () => ({ decision: 'defer' })
  });
  check('MS37.postPlusPolicyDeferExecutesZero',
    deferRun.decision === 'defer' && deferRun.reason === 'policy-defer' && deferWriter.calls === 0);

  /* ══════════ E · Candidate finalization（MS39–MS41） ══════════ */
  section('E · Candidate Seed → Final Candidate（MS39–MS41）');
  const seedA = { actorId: ACTOR, source: 'schedule', triggerRef: TRIGGER_REF };
  const finalA = MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(parseObj(v2Post())));
  const finalB = MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(parseObj(v2Post({
    draft: Object.assign({}, v2Post().draft, { content: '窗外还在下雨，我把窗台擦干净了。' })
  }))));
  const finalC = MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(parseObj(v2Post({ topicKey: 'sunny-balcony' }))));
  const finalD = MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(parseObj(v2Skip({ topicKey: 'quiet-day' }))));
  check('MS39.sameTopicDifferentWordingStableCandidateId',
    finalA.ok === true && finalB.ok === true && finalA.candidate.candidateId === finalB.candidate.candidateId
    && finalA.candidate.topicFingerprint === finalB.candidate.topicFingerprint);
  check('MS40.differentTopicDifferentCandidateId',
    finalC.ok === true && finalC.candidate.candidateId !== finalA.candidate.candidateId);
  check('MS41.rewriteDoesNotMintNewIdentity', (() => {
    /* 去重重写（同一话题换角度）→ 同一个 topicFingerprint；只有真的换话题才换身份。 */
    const rewritten = parseObj(v2Post({ reasonCode: 'nothing-to-share' }));
    const rewriteOk = parseObj(v2Post({ draft: Object.assign({}, v2Post().draft, { content: '雨停了，窗台的水痕还在。' }) }));
    return rewritten.ok === false && finalB.candidate.candidateId === finalA.candidate.candidateId && rewriteOk.ok === true
      && MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(rewriteOk)).candidate.candidateId === finalA.candidate.candidateId;
  })());
  check('MS41b.skipWithoutTopicHasNoCandidate',
    MA.finalizeMomentCandidate(seedA, Sem.toAdapterRecommendation(parseObj(v2Skip()))).ok === false
    && MA.finalizeMomentCandidate(seedA, null).ok === false
    && finalD.ok === true);
  check('MS41c.finalizeRejectsUserSource',
    MA.finalizeMomentCandidate({ actorId: ACTOR, source: 'user', triggerRef: TRIGGER_REF },
      Sem.toAdapterRecommendation(parseObj(v2Post()))).ok === false);
  check('MS41d.oneCandidateIdentityAuthority',
    countOf(stripComments(read('assets/js/moments-autonomy.js')), 'function finalizeMomentCandidate(') === 1
    && countOf(stripComments(read('assets/js/moments-semantic-core.js')), 'candidateId') === 0);

  /* ══════════ F · 真实 moments.js：语义评估接缝（MS1 / MS24–MS27） ══════════ */
  section('F · Real semantic seam in moments.js（MS1 / MS24–MS27）');
  const readyCfg = { id: ACTOR, nickname: 'N', model: 'm1', provider: 'openai', endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'k' };
  function modelPage(outputs, opts) {
    const page = buildPage(Object.assign({ authorityEffective: false }, opts || {}));
    page.sandbox.apiConfigs = [readyCfg];
    page.sandbox._ibApiReady = (cfg) => !!(cfg && cfg.endpoint && cfg.model);
    page.sandbox.runtimeExecuteEnabled = false;
    page.modelCalls = [];
    page.sandbox.callApiChat = function (cfg, messages, callOpts) {
      page.modelCalls.push({ cfg: cfg, messages: messages, opts: callOpts });
      const next = outputs.length > 1 ? outputs.shift() : outputs[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    };
    return page;
  }
  const v2PostRaw = JSON.stringify(v2Post());
  const v2SkipRaw = JSON.stringify(v2Skip({ topicKey: 'quiet-day' }));
  const oneCall = modelPage([v2PostRaw]);
  const semantic = JSON.parse(JSON.stringify(await oneCall.sandbox.window.evaluateRoleMomentSemantic(ACTOR, { trigger: 'manual' })));
  check('MS1.oneSemanticModelSeam', (() => {
    const body = stripComments(MOMENTS_SRC);
    const fn = semanticFnSlice(MOMENTS_SRC);
    const bridgeStart = body.indexOf('async function generateRoleMoment(');
    const bridgeEnd = body.indexOf('async function generateRoleComment(', bridgeStart);
    const bridge = body.slice(bridgeStart, bridgeEnd > bridgeStart ? bridgeEnd : bridgeStart + 4000);
    return countOf(fn, "_obsCall('moment'") === 1 && countOf(fn, '_obsCall(') === 1
      && countOf(bridge, '_obsCall(') === 0
      && oneCall.modelCalls.length === 1;
  })(), { calls: oneCall.modelCalls.length });
  check('MS1b.semanticResultShape',
    semantic.ok === true && semantic.recommendation.recommendation === 'post'
    && semantic.recommendation.reasonCode === 'meaningful-moment'
    && /^mt_[0-9a-z]+$/.test(semantic.recommendation.topicFingerprint)
    && semantic.recommendation.topicKey === 'rainy-window'
    && semantic.draft.content.indexOf('窗台') >= 0 && semantic.modelCalls === 1 && semantic.attempts === 1, semantic);
  const retryPage = modelPage(['{"recommendation":"post",', v2PostRaw]);
  const retried = JSON.parse(JSON.stringify(await retryPage.sandbox.window.evaluateRoleMomentSemantic(ACTOR, { trigger: 'manual' })));
  check('MS24.malformedRetriedOnce',
    retried.ok === true && retried.modelCalls === 2 && retried.attempts === 2 && retryPage.modelCalls.length === 2
    && retryPage.modelCalls[1].messages[1].content.indexOf('recommendation') >= 0
    && retryPage.modelCalls[1].messages[1].content.indexOf('topicKey') >= 0
    && retryPage.modelCalls[1].messages[1].content.indexOf('"publish"') < 0, { calls: retried.modelCalls });
  const badTwice = modelPage(['{"recommendation":"maybe"}']);
  const badTwiceRes = JSON.parse(JSON.stringify(await badTwice.sandbox.window.evaluateRoleMomentSemantic(ACTOR, { trigger: 'manual' })));
  check('MS25.secondMalformedFails',
    badTwiceRes.ok === false && /无法解析/.test(String(badTwiceRes.error)) && badTwiceRes.modelCalls === 2
    && badTwice.liveCount() === 0, badTwiceRes);
  const providerDown = modelPage([new Error('provider exploded')]);
  const providerRes = JSON.parse(JSON.stringify(await providerDown.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('MS26.providerFailureNoPublish',
    providerRes.ok === false && /provider exploded/.test(String(providerRes.error)) && providerDown.liveCount() === 0
    && providerDown.modelCalls.length === 1);
  const skipPage = modelPage([v2SkipRaw]);
  const skipPub = JSON.parse(JSON.stringify(await skipPage.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('MS27.noFallbackPost',
    skipPub.ok === true && skipPub.published === false && skipPub.reasonCode === 'nothing-to-share'
    && skipPage.liveCount() === 0 && skipPage.modelCalls.length === 1
    && badTwice.liveCount() === 0 && retried.ok === true);
  check('MS27b.skipNeverGeneratesImage', (() => {
    const body = stripComments(MOMENTS_SRC);
    /* P25-2C：图片生成从 legacy wrapper 移进 executor 的写入桥
       （`_momentsWriteApprovedMoment`）—— 语义评估段仍然零生图，
       而写入桥只能由 runMomentAutonomy 的 executor（ALLOW）调用。 */
    const writeAt = body.indexOf('async function _momentsWriteApprovedMoment(');
    const writeEnd = body.indexOf('async function _momentsRunAutonomousPost(');
    const bridge = (writeAt >= 0 && writeEnd > writeAt) ? body.slice(writeAt, writeEnd) : '';
    const generation = fnSlice(MOMENTS_SRC, 'generateRoleMoment');
    /* 语义评估段与 legacy wrapper 都**零生图**；唯一的自主生图点在 executor 的写入桥里
       （另一个 `await _momentsMakeImage(` 属 companion ingest，那条路径不经过这里）。 */
    return !/_momentsMakeImage/.test(semanticFnSlice(MOMENTS_SRC))
      && !/_momentsMakeImage/.test(generation)
      && countOf(bridge, 'await _momentsMakeImage(') === 1;
  })(), { inSemantic: /_momentsMakeImage/.test(semanticFnSlice(MOMENTS_SRC)), inWrapper: /_momentsMakeImage/.test(fnSlice(MOMENTS_SRC, 'generateRoleMoment')) });
  const publishPage = modelPage([v2PostRaw]);
  const published = JSON.parse(JSON.stringify(await publishPage.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('MS27c.postStillPublishesThroughLegacyBridge',
    published.ok === true && published.published === true && published.moment.content.indexOf('窗台') >= 0
    && published.reasonCode === 'meaningful-moment' && publishPage.liveCount() === 1
    && published.topicFingerprint === semantic.recommendation.topicFingerprint,
    { ok: published.ok, pub: published.published, live: publishPage.liveCount() });
  const declSt = JSON.parse(publishPage.sandbox.localStorage.getItem('ib_moments_state_v1') || '{}');
  const declineAgain = modelPage([v2SkipRaw]);
  await declineAgain.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' });
  const declineState = JSON.parse(declineAgain.sandbox.localStorage.getItem('ib_moments_state_v1') || '{}')[ACTOR] || {};
  check('MS27d.declineBookkeepingPreserved',
    Number(declineState.declineStreak) === 1 && Number((declSt[ACTOR] || {}).declineStreak || 0) === 0
    && declineAgain.liveCount() === 0, declineState);

  /* ══════════ G · End-to-end：semantic → candidate → Core → canonical writer ══════════ */
  section('G · End-to-end with real canonical writer（MS34 / MS38 / MS41）');
  const e2ePage = modelPage([v2PostRaw], { authorityEffective: true });
  const e2eSemantic = JSON.parse(JSON.stringify(await e2ePage.sandbox.window.evaluateRoleMomentSemantic(ACTOR, { trigger: 'schedule' })));
  const e2eRec = Sem.toAdapterRecommendation(e2eSemantic);
  const e2eSeed = { actorId: ACTOR, source: 'schedule', triggerRef: TRIGGER_REF };
  const e2eCandidate = MA.finalizeMomentCandidate(e2eSeed, e2eRec);
  const e2eRun = await MA.runMomentAutonomy(
    Object.assign({}, e2eSeed, { topicFingerprint: e2eRec.topicFingerprint, draft: e2eRec.draft }),
    {
      now: FIXED_NOW, prefs: PREFS_OK, recommendation: e2eRec,
      visibility: e2eSemantic.draft.visibility, motive: e2eSemantic.draft.motive, images: [],
      writeMoment: (payload, options) => e2ePage.createMoment(payload, options)
    });
  const e2eRow = e2ePage.canonicalRow(e2eRun.momentId);
  check('MS34b.semanticToCanonicalRowOnce',
    e2eCandidate.ok === true && e2eRun.decision === 'allow' && e2eRun.ok === true
    && e2eRun.executed === true && e2ePage.liveCount() === 1 && !!e2eRow
    && e2eRow.source === 'proactive' && e2eRow.roleId === ACTOR
    && e2eRun.momentId === MA.momentIdForCandidate(e2eCandidate.candidate.candidateId), {
      decision: e2eRun.decision, ok: e2eRun.ok, live: e2ePage.liveCount(), id: e2eRun.momentId
    });
  const e2eRetry = await MA.runMomentAutonomy(
    Object.assign({}, e2eSeed, { topicFingerprint: e2eRec.topicFingerprint, draft: e2eRec.draft }),
    {
      now: FIXED_NOW, prefs: PREFS_OK, recommendation: e2eRec,
      visibility: e2eSemantic.draft.visibility, motive: e2eSemantic.draft.motive, images: [],
      writeMoment: (payload, options) => e2ePage.createMoment(payload, options)
    });
  check('MS34c.retryStillOneCanonicalRow',
    e2eRetry.ok === true && e2eRetry.idempotent === true && e2ePage.liveCount() === 1
    && e2eRetry.momentId === e2eRun.momentId, { live: e2ePage.liveCount(), idem: e2eRetry.idempotent });
  const e2eSkipPage = modelPage([v2SkipRaw], { authorityEffective: true });
  const e2eSkipSemantic = JSON.parse(JSON.stringify(await e2eSkipPage.sandbox.window.evaluateRoleMomentSemantic(ACTOR, { trigger: 'schedule' })));
  const e2eSkipRec = Sem.toAdapterRecommendation(e2eSkipSemantic);
  const e2eSkipRun = await MA.runMomentAutonomy(
    Object.assign({}, e2eSeed, { topicFingerprint: e2eSkipRec.topicFingerprint }),
    { now: FIXED_NOW, prefs: PREFS_OK, recommendation: e2eSkipRec, writeMoment: (payload, options) => e2eSkipPage.createMoment(payload, options) });
  check('MS35b.semanticSkipWritesNoCanonicalRow',
    e2eSkipRun.decision === 'deny' && e2eSkipRun.reason === 'recommendation-skip'
    && e2eSkipPage.liveCount() === 0 && e2eSkipPage.stats.directPut === 0);

  /* ══════════ H · Prompt 契约（§41） ══════════ */
  section('H · Prompt contract（§41 / MS41e）');
  const promptPage = modelPage([v2PostRaw]);
  const promptBuilt = promptPage.sandbox.window.buildMomentPrompt({ character: { id: 'x', nickname: 'N', systemPrompt: '' }, context: {}, trigger: 'schedule' });
  const promptText = String(promptBuilt.messages[1].content);
  check('MS41e.promptRequiresJsonContract',
    /只输出一个 JSON 对象/.test(promptText) && /"recommendation":"post\|skip"/.test(promptText)
    && /"reasonCode"/.test(promptText) && /topicKey/.test(promptText) && /"draft"/.test(promptText));
  check('MS41f.promptReasonVocabularyMatchesCore',
    Sem.MOMENT_SEMANTIC_POST_REASONS.every(c => promptText.indexOf(c) >= 0)
    && Sem.MOMENT_SEMANTIC_SKIP_REASONS.every(c => promptText.indexOf(c) >= 0));
  check('MS41g.promptNoChainOfThought',
    /thinking/.test(promptText) && /reasoning/.test(promptText) && /analysis/.test(promptText)
    && /rationale/.test(promptText) && /explanation/.test(promptText)
    && /不要输出/.test(promptText));
  check('MS41h.promptHasNoPublishAuthority',
    !/publish/i.test(promptText) && !/allow|deny|defer/i.test(promptText.replace(/recommendation/g, '')));
  check('MS41i.promptKeepsAntiGenericRules',
    /拒绝空泛模板/.test(promptText) && /今天阳光很好/.test(promptText) && /碎片化/.test(promptText)
    && /recommendation:"skip" 是正常输出/.test(promptText) && /发圈动机/.test(promptText)
    && /"motive":"share\|daily_life\|emotion\|reflection\|interaction\|curiosity\|social_response\|none"/.test(promptText)
    && /不想发就给 recommendation:"skip"/.test(promptText));
  check('MS41j.promptKeepsImageGuidance',
    /wantImage/.test(promptText) && /imagePrompt/.test(promptText) && /不要为了配图而配图/.test(promptText)
    && /不会自然想配一张照片|自然适合配一张图/.test(promptText));
  check('MS41k.promptNoInternalMechanismWords',
    !/任务|定时|调度|API|模型|prompt|scheduler|timer|task|cron|autonomous|token/i.test(promptText.replace(/imagePrompt/g, '')));
  check('MS41l.correctionNoteUsesNewContract', (() => {
    const note = Sem.semanticCorrectionNote({ stage: 'schema-unknown-reason-code' });
    return note.indexOf('recommendation') >= 0 && note.indexOf('topicKey') >= 0
      && note.indexOf('"publish"') < 0 && note.indexOf('schema-unknown-reason-code') >= 0;
  })());

  /* ══════════ I · Boundaries（MS30–MS32 / MS42–MS50） ══════════ */
  section('I · Boundaries / source guards（MS30–MS32 / MS42–MS50）');
  const semBody = stripComments(MOMENTS_SRC);
  const semFn = semanticFnSlice(MOMENTS_SRC);
  const coreSrc = stripComments(read('assets/js/moments-semantic-core.js'));
  const adapterSrc = stripComments(read('assets/js/moments-autonomy.js'));
  check('MS30.semanticFunctionHasNoCreateMoment',
    !/createMoment\s*\(/.test(semFn) && oneCall.liveCount() === 0 && oneCall.stats.directPut === 0);
  check('MS31.semanticFunctionHasNoDbWrites',
    !/dbPut|dbDelete|MOMENT_STORE/.test(semFn));
  check('MS32.semanticFunctionHasNoAutonomyOrHomeNode',
    !/runMomentAutonomy|IBAutonomyCore|IBMomentsAutonomy|homeNode/.test(semFn));
  check('MS32b.semanticCoreIsPureLeaf',
    !/createMoment|dbPut|homeNode|localStorage|indexedDB|document|setTimeout|setInterval/.test(coreSrc)
    && !/Memory|memories|middle-brain|groupTurn/.test(coreSrc));
  check('MS49.noMemoryRefs', !/\bMemory\b|memories|memoryAuthority|disclosureFacts/.test(coreSrc + adapterSrc));
  check('MS50.noMiddleBrainRefs', !/middle-brain|middleBrain|middle_brain|astra/i.test(coreSrc + adapterSrc));
  check('MS42.manualPathUntouched', (() => {
    return /createMoment\(\{authorType:'user',authorId:_activeUserId\(\),content:text,images:imgs,source:'manual'/.test(MOMENTS_SRC)
      && !/evaluateRoleMomentSemantic/.test(read('assets/js/social-network.js'))
      && /source:'manual'/.test(read('assets/js/social-network.js'));
  })());
  /* P25-2C：调度骨架（频率 / 最短间隔 / 声明式 claim / 角色隔离）逐字保留，
     但 generateRoleMoment 已从"自己做权限"变成"走 autonomy 管线的兼容包装"。 */
  check('MS43.schedulerSkeletonKeptAndWrapperReRoutes', (() => {
    return sha256('assets/js/active-diary.js') === FROZEN_SHA256['assets/js/active-diary.js']
      && /_momentsLocalTick\(now\)/.test(MOMENTS_SRC)
      && /await generateRoleMoment\(key,\{trigger:'schedule'\}\)/.test(MOMENTS_SRC)
      && /LEGACY WRAPPER/.test(read('assets/js/moments.js'))
      && /_momentsRunAutonomousPost\(roleId,opts\)/.test(read('assets/js/moments.js'));
  })());
  check('MS44.schedulerDelegatesAndStaysDowngraded', (() => {
    const tick = fnSlice(MOMENTS_SRC, '_momentsTick');
    const local = fnSlice(MOMENTS_SRC, '_momentsLocalTick');
    /* 调度器只产生候选（转交给 generateRoleMoment）；它不解析 adapter、不裁决、
       不生图、不写库。adapter 的解析点在全文件里只有一处。 */
    const resolverAt = MOMENTS_SRC.indexOf('function _momentsAutonomyAdapter(');
    const resolverEnd = MOMENTS_SRC.indexOf('function buildMomentCandidateSeed(');
    const resolver = (resolverAt >= 0 && resolverEnd > resolverAt) ? MOMENTS_SRC.slice(resolverAt, resolverEnd) : '';
    return !/IBMomentsAutonomy|runMomentAutonomy|finalizeMomentCandidate|createMoment\(|_momentsMakeImage/.test(tick + local)
      && countOf(MOMENTS_SRC, 'IBMomentsAutonomy') === countOf(resolver, 'IBMomentsAutonomy');
  })(), (() => {
    const tick = fnSlice(MOMENTS_SRC, '_momentsTick');
    const local = fnSlice(MOMENTS_SRC, '_momentsLocalTick');
    const hits = ['IBMomentsAutonomy', 'runMomentAutonomy', 'finalizeMomentCandidate', 'createMoment(', '_momentsMakeImage']
      .filter(t => (tick + local).indexOf(t) >= 0);
    return { hits: hits, resolverCount: countOf(MOMENTS_SRC, 'IBMomentsAutonomy') };
  })());
  /* P25-2D：companion 域不再"逐字节不变" —— 它现在与桌面端**共用同一份语义契约**
     （require moments-semantic-core）。旧断言（hash 冻结）随契约迁移为收敛断言。 */
  check('MS45.activeCompanionDomainConverged',
    /require\('\.\.\/assets\/js\/moments-semantic-core\.js'\)/.test(read('active/moments.js'))
    && /parseMomentSemantic/.test(read('active/moments.js'))
    && !/createMoment\(|_momentsWriteCanonical/.test(stripComments(read('active/moments.js'))));
  check('MS46.p23Unchanged', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('MS47.p24Unchanged', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('MS48.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('MS33c.adapterReasonVocabularySingleSource',
    (() => {
      const v2 = MA.MOMENT_SEMANTIC_POST_REASONS_V2;
      const v2skip = MA.MOMENT_SEMANTIC_SKIP_REASONS_V2;
      return JSON.stringify(v2) === JSON.stringify(Sem.MOMENT_SEMANTIC_POST_REASONS)
        && JSON.stringify(v2skip) === JSON.stringify(Sem.MOMENT_SEMANTIC_SKIP_REASONS)
        && MA.MOMENT_CONTRACT_VERSION === 'moment-recommendation/v2'
        && MA.MOMENTS_AUTONOMY_CONTRACT.version === 'moment-recommendation/v2';
    })());
  check('MS1c.semanticCoreLoadedBeforeMoments',
    (() => {
      const html = read('InternalBeyond.html');
      const i = html.indexOf('assets/js/moments-semantic-core.js');
      const j = html.indexOf('src="assets/js/moments.js"');
      return i > 0 && j > i;
    })());
  check('MS1d.legacyViewStillServedByMoments',
    promptPage.sandbox.window._momentsParseOutput(JSON.stringify({ publish: true, content: '旧契约。' })).publish === true
    && promptPage.sandbox.window._momentsParseOutput(JSON.stringify({ publish: false, reason: '不想发' })).reason === '不想发'
    && promptPage.sandbox.window._momentsDiagnoseOutput('').stage === 'empty-output'
    && promptPage.sandbox.window._momentsDiagnoseOutput('{"publish":"true","content":"x"}').stage === 'schema-publish-not-boolean'
    && promptPage.sandbox.window._momentsDiagnoseOutput('今天出去走了走。').stage === 'no-json-object');
  /* P25-2B 真实回归：UMD 工厂函数创建于全局作用域，看不见外层的 `root` 参数。
     早先语义核在浏览器里"指纹恒为空"（identity-core-missing）—— 因为 chat-core 是
     **延迟加载**（HTML 里位于 moments.js 之后），而 root 只能在调用时解析。
     这条用例在"模块先加载、依赖后出现"的时序下断言解析仍然成立。 */
  check('MS1e.lateLoadedDependencyStillResolves', (() => {
    const sb = {};
    sb.window = sb; sb.self = sb;
    sb.IBMomentsVisibilityCore = MOMENTS_VIS;
    sb.__ibParsePlanJsonRaw = PARSE.parseJson;
    vm.createContext(sb);
    vm.runInContext(
      '(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();',
      sb, { filename: 'late-deps-parser-bridge.js' });
    vm.runInContext(SEMANTIC_CORE_SRC, sb, { filename: 'sem-core-late-deps.js' });
    const before = sb.IBMomentsSemanticCore.momentTopicFingerprint('late-binding');
    sb.IBChatCore = CHAT_CORE;      /* chat-core 在语义核加载**之后**才出现（真实页面顺序） */
    const after = sb.IBMomentsSemanticCore.momentTopicFingerprint('late-binding');
    /* 走沙箱内的桥接 parser（默认解析路径）—— 浏览器里 parser 与语义核同 realm，
       这正是 `opts.parseJson` 注入只在 Node 集成里需要的理由。 */
    const legacyAfter = sb.IBMomentsSemanticCore.parseMomentOutputLegacy(JSON.stringify({ publish: true, content: '晚绑定。', visibility: 'all' }));
    return before === '' && /^mt_[0-9a-z]+$/.test(after) && !!legacyAfter && legacyAfter.publish === true;
  })());
  check('MS1f.rootPassedIntoFactory',
    /factory\(root, root\.IBChatCore/.test(read('assets/js/moments-semantic-core.js'))
    && /factory\(\s*null,\s*require/.test(read('assets/js/moments-semantic-core.js'))
    && /function \(root, factory\)/.test(read('assets/js/moments-autonomy.js'))
    && /function globalRoot\(\)/.test(read('assets/js/moments-semantic-core.js'))
    && /function globalRoot\(\)/.test(read('assets/js/moments-autonomy.js')));

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2B · semantic recommendation: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', (e && e.stack) || e); process.exitCode = 1; });
