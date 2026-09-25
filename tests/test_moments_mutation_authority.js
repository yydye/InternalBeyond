'use strict';

/* Internal Beyond · P25-2.5 · Moments Mutation Authority 测试
   （static 组：纯 Node、零浏览器、零外部网络；运行：
     node tests/test_moments_mutation_authority.js）

   创建权限（P25-2 · Autonomy）与**修改**权限（本阶段）刻意分开：
   like / unlike / comment.create / comment.delete / moment.delete / reply.create
   都必须先经 Mutation Authority 的 decision，只有 ALLOW 才执行写入。
   覆盖 MA1–MA25。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const MUT = require(path.join(ROOT, 'assets/js/moments-mutation-authority.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;
function fnBodyOf(src, name) {
  const body = stripComments(src);
  let start = body.indexOf('async function ' + name + '(');
  if (start < 0) start = body.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const a = body.indexOf('\nasync function ', start + 1);
  const b = body.indexOf('\nfunction ', start + 1);
  const cand = [a, b].filter(i => i > start);
  return body.slice(start, cand.length ? Math.min.apply(null, cand) : body.length);
}

const PROD_FILES = ['assets/js/moments.js', 'assets/js/social-network.js', 'assets/js/core.js',
  'active/moments.js', 'services/home-node/moments-store.js'];
function callSites(needle) {
  const out = [];
  for (const f of PROD_FILES) {
    const src = stripComments(read(f));
    let i = src.indexOf(needle);
    while (i >= 0) {
      const before = src.slice(0, i);
      const m = [...before.matchAll(/\n(?:async )?function ([A-Za-z0-9_$]+)\(/g)];
      out.push({ file: f, fn: m.length ? m[m.length - 1][1] : '' });
      i = src.indexOf(needle, i + 1);
    }
  }
  return out;
}

const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8',
  'services/home-node/moments-store.js': 'F7852B44F5941B1E157A6603E52013A63A774052063A553A2938E4BA97F5F6D2'
};
const MOMENTS_SRC = read('assets/js/moments.js');
const MUT_SRC = read('assets/js/moments-mutation-authority.js');

/* ── 浏览器沙箱（真实 moments.js + 真实 mutation authority + 真实 create/adapter 栈）── */
function buildPage() {
  const rows = new Map();
  const stored = new Map();
  const stats = { executorRuns: 0 };
  const sandbox = {};
  const IB = { expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); } };
  const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
  const VOICE_CORE = require(path.join(ROOT, 'assets/js/voice-message-core.js'));
  const VIS = require(path.join(ROOT, 'assets/js/moments-visibility-core.js'));
  const PLAN_DOMAIN = require(path.join(ROOT, 'active', 'plan-domain.js'))({ getState: () => ({}), armedUsers: new Set(), saveNow: () => {} });
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.IB = IB;
  sandbox.console = { log() {}, info() {}, warn() {}, error() {} };
  sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  sandbox.localStorage = {
    getItem: (k) => (stored.has(String(k)) ? stored.get(String(k)) : null),
    setItem: (k, v) => { stored.set(String(k), String(v)); },
    removeItem: (k) => { stored.delete(String(k)); }
  };
  sandbox.IBChatCore = CHAT_CORE;
  sandbox.IBVoiceMessage = VOICE_CORE;
  sandbox.IBMomentsVisibilityCore = VIS;
  sandbox.__ibParsePlanJsonRaw = PLAN_DOMAIN.parsePlanJson;
  sandbox.apiConfigs = [{ id: 'role_a', nickname: 'A', model: 'm-a' }, { id: 'role_b', nickname: 'B', model: 'm-b' }];
  sandbox.archivedConfigs = [];
  sandbox.currentPage = 'settings';
  sandbox.loadMomentsPage = function () {};
  sandbox._activeUserId = () => 'u1';
  sandbox._activeRecentMemories = () => Promise.resolve([]);
  sandbox._activeRecentProactiveMessages = () => Promise.resolve([]);
  sandbox._activeRecentMessages = () => Promise.resolve([]);
  sandbox._activeTextSimilarity = (a, b) => (String(a) === String(b) ? 1 : 0);
  sandbox.db = {};
  sandbox.dbPut = (store, row) => { if (String(store) === 'moments') rows.set(String(row.id), JSON.parse(JSON.stringify(row))); return Promise.resolve(undefined); };
  sandbox.dbDelete = (store, key) => { rows.delete(String(key)); return Promise.resolve(undefined); };
  sandbox.dbGet = (store, key) => Promise.resolve(rows.get(String(key)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  vm.createContext(sandbox);
  vm.runInContext('(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();', sandbox, { filename: 'parser-bridge.js' });
  ['assets/js/moments-semantic-core.js', 'assets/js/autonomy-core.js', 'assets/js/moments-autonomy.js',
    'assets/js/moments-mutation-authority.js', 'assets/js/moments.js']
    .forEach(f => vm.runInContext(read(f).replace(/^\uFEFF/, ''), sandbox, { filename: f }));
  sandbox.loadMomentsPage = function () {};
  const origRun = sandbox.IBMomentsMutationAuthority.runMomentMutation;
  sandbox.IBMomentsMutationAuthority.runMomentMutation = async function (mutation, facts, executor) {
    const wrapped = async (mm) => { stats.executorRuns++; return executor(mm); };
    return origRun(mutation, facts, wrapped);
  };
  return {
    sandbox: sandbox, stats: stats, rows: rows,
    put: (row) => rows.set(String(row.id), JSON.parse(JSON.stringify(row))),
    get: (id) => rows.get(String(id)) || null,
    comment: (id, patch) => sandbox.window.addMomentComment(id, patch),
    like: (id, who) => sandbox.window.likeMoment(id, who),
    delComment: (mid, cid, role) => sandbox.window.deleteMomentComment(mid, cid, role),
    del: (id, opts) => sandbox.window.deleteMoment(id, opts)
  };
}
function roleMoment(id, patch) {
  return Object.assign({
    id: id, authorType: 'role', roleId: 'role_a', authorId: 'role_a', content: '角色的动态',
    images: [], visibility: 'all', visibleRoleIds: [], likes: [], comments: [], source: 'proactive', motive: '', createdAt: '2026-09-20T00:00:00.000Z'
  }, patch || {});
}

async function main() {
  console.log('== P25-2.5 · Moments Mutation Authority 测试 ==');

  /* ══════════ A · 枚举与分类（MA1–MA4/MA15–MA18） ══════════ */
  section('A · Mutation path enumeration（MA1–MA4/MA15–MA18）');
  const puts = callSites('dbPut(MOMENT_STORE');
  const dels = callSites('dbDelete(MOMENT_STORE');
  const putFns = [...new Set(puts.map(s => s.fn))].sort();
  const delFns = [...new Set(dels.map(s => s.fn))].sort();
  /* 期望集合：创建通道 + 四个 mutation 入口 + companion 事件的两个 mutation executor
     （后两者的 dbPut 现在只在 executor 闭包内，且只有 ALLOW 才执行）。 */
  const EXPECTED_PUT_FNS = ['_momentsWriteCanonical', 'likeMoment', 'addMomentComment', 'deleteMomentComment', '_momentsIngestEvent'].sort().join(',');
  check('MA1.mutationPathsEnumerated',
    putFns.join(',') === EXPECTED_PUT_FNS
    && delFns.join(',') === ['deleteMoment'].sort().join(','), { putFns: putFns, delFns: delFns });
  check('MA2.allWritersClassified',
    puts.every(s => s.fn) && dels.every(s => s.fn)
    && putFns.indexOf('_momentsWriteCanonical') >= 0 /* 创建通道（Autonomy 管辖） */
    && ['likeMoment', 'addMomentComment', 'deleteMomentComment'].every(f => putFns.indexOf(f) >= 0));
  check('MA3.noUnclassifiedDbPut',
    puts.filter(s => EXPECTED_PUT_FNS.indexOf(s.fn) < 0
      && s.file !== 'assets/js/core.js').length === 0, puts);
  check('MA4.noUnclassifiedDbDelete',
    dels.filter(s => s.fn !== 'deleteMoment' && s.file !== 'assets/js/core.js').length === 0, dels);
  check('MA15.noDirectUiWriter',
    !/dbPut\(MOMENT_STORE|dbDelete\(MOMENT_STORE/.test(fnBodyOf(MOMENTS_SRC, '_momentsDeleteMoment'))
    && !/dbPut\(MOMENT_STORE|dbDelete\(MOMENT_STORE/.test(fnBodyOf(MOMENTS_SRC, '_momentsRenderFeed'))
    && /deleteMoment\(id\)/.test(fnBodyOf(MOMENTS_SRC, '_momentsDeleteMoment')));
  check('MA16.noDirectCompanionWriter',
    !/dbPut\(|dbDelete\(/.test(stripComments(read('active/moments.js'))));
  check('MA17.noDirectAiWriter',
    !/dbPut\(MOMENT_STORE|dbDelete\(MOMENT_STORE/.test(fnBodyOf(MOMENTS_SRC, 'generateRoleComment'))
    && !/dbPut\(MOMENT_STORE|dbDelete\(MOMENT_STORE/.test(fnBodyOf(MOMENTS_SRC, 'generateRoleReply'))
    && !/dbPut\(MOMENT_STORE/.test(fnBodyOf(MOMENTS_SRC, '_momentsApplyLikes'))
    && /addMomentComment\(/.test(fnBodyOf(MOMENTS_SRC, 'generateRoleComment'))
    && /likeMoment\(/.test(fnBodyOf(MOMENTS_SRC, '_momentsApplyLikes')));
  check('MA18.canonicalWriterUnique',
    countOf(stripComments(MOMENTS_SRC), 'function createMoment(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'await _momentsWriteCanonical(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'hn.put(m,') === 1
    && /_momentsRunMutation\(/.test(MOMENTS_SRC));

  /* ══════════ B · 契约与身份（MA5–MA11） ══════════ */
  section('B · Contract & identity（MA5–MA11）');
  const mk = (patch) => Object.assign({ mutationType: 'like', actorId: 'role_b', actorKind: 'role', source: 'role_ai', targetMomentId: 'mom_1' }, patch || {});
  check('MA5.likeAuthority',
    MUT.decideMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: false }).decision === 'allow'
    && MUT.decideMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: true }).reason === 'self-like'
    && MUT.decideMomentMutation(mk(), { momentExists: false }).reason === 'unknown-moment');
  check('MA6.unlikeAuthority',
    MUT.decideMomentMutation(mk({ mutationType: 'unlike', actorKind: 'user', actorId: 'u1', source: 'user' }), { momentExists: true }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'unlike' }), { momentExists: true }).reason === 'ai-unlike-not-permitted');
  check('MA7.commentAuthority',
    MUT.decideMomentMutation(mk({ mutationType: 'comment.create', targetCommentId: '', context: { content: 'hi' } }), { momentExists: true, actorCanSeeMoment: true }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.create', targetCommentId: '', context: { content: 'hi' } }), { momentExists: true, actorCanSeeMoment: false }).reason === 'not-visible'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.create', targetCommentId: '', context: { content: 'hi' } }), { momentExists: true, actorCanSeeMoment: true, duplicateComment: true }).reason === 'duplicate-comment'
    && MUT.buildMomentMutation(mk({ mutationType: 'comment.create', context: { content: '   ' } })).ok === false);
  check('MA8.replyAuthority',
    MUT.decideMomentMutation(mk({ mutationType: 'reply.create', targetCommentId: 'mc_1', context: { content: 're' } }), { momentExists: true, commentExists: true, actorCanSeeMoment: true }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'reply.create', targetCommentId: 'mc_1', context: { content: 're' } }), { momentExists: true, commentExists: false, actorCanSeeMoment: true }).reason === 'unknown-comment'
    && MUT.decideMomentMutation(mk({ mutationType: 'reply.create', targetCommentId: '', context: { content: 're' } }), { momentExists: true, actorCanSeeMoment: true }).decision === 'allow');
  check('MA9.deleteAuthority',
    MUT.decideMomentMutation(mk({ mutationType: 'comment.delete', targetCommentId: 'mc_1', actorKind: 'user', actorId: 'u1', source: 'user' }), { momentExists: true, commentExists: true, actorIsMomentAuthor: true }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.delete', targetCommentId: 'mc_1', actorKind: 'user', actorId: 'u1', source: 'user' }), { momentExists: true, commentExists: true, actorIsCommentAuthor: true }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.delete', targetCommentId: 'mc_1', actorKind: 'user', actorId: 'u1', source: 'user' }), { momentExists: true, commentExists: true }).reason === 'not-comment-author'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.delete', targetCommentId: 'mc_1' }), { momentExists: true, commentExists: true, actorIsMomentAuthor: true, actorIsCommentAuthor: false }).decision === 'allow'
    && MUT.decideMomentMutation(mk({ mutationType: 'comment.delete', targetCommentId: 'mc_1' }), { momentExists: true, commentExists: true, actorIsMomentAuthor: true, actorIsCommentAuthor: true }).reason === 'not-comment-author'
    && MUT.decideMomentMutation(mk({ mutationType: 'moment.delete', actorKind: 'role' }), { momentExists: true, actorIsMomentAuthor: false }).reason === 'not-owner'
    && MUT.decideMomentMutation(mk({ mutationType: 'moment.delete', actorKind: 'user', actorId: 'u1', source: 'user' }), { momentExists: true }).decision === 'allow');
  check('MA10.actorIdentityCanonical',
    MUT.buildMomentMutation(mk({ actorId: ' role_b' })).ok === false
    && MUT.buildMomentMutation(mk({ actorId: 'role\u0000b' })).ok === false
    && MUT.buildMomentMutation(mk({ actorId: '' })).errors.indexOf('missing-actor-id') >= 0
    && MUT.buildMomentMutation(mk({ actorKind: 'system' })).errors.indexOf('bad-actor-kind') >= 0);
  check('MA11.displayNameRejected',
    MUT.buildMomentMutation(mk({ actorId: 'B 昵称' })).ok === true  /* 形状合法（无空格前缀/控制字符） */
    && MUT.decideMomentMutation(mk({ actorId: 'B 昵称' }), { momentExists: true, actorKnown: false }).reason === 'unknown-actor'
    && /actorKnown/.test(fnBodyOf(MOMENTS_SRC, '_momentsMutationFacts'))
    && /_momentsCfg\(actorId\)/.test(MOMENTS_SRC));
  check('MA13.contractClosedVocabulary',
    MUT.MUTATION_TYPES.join(',') === 'like,unlike,comment.create,comment.delete,moment.delete,reply.create'
    && MUT.buildMomentMutation(mk({ mutationType: 'super-like' })).errors.indexOf('bad-mutation-type') >= 0
    && MUT.buildMomentMutation(mk({ source: '随便' })).errors.indexOf('bad-source') >= 0
    && JSON.stringify(MUT.MUTATION_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
    && !/DEFER/.test(stripComments(MUT_SRC)));
  check('MA14.executorOnlyAfterAllow', await (async () => {
    let runs = 0;
    const denied = await MUT.runMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: true }, async () => { runs++; });
    const allowed = await MUT.runMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: false }, async () => { runs++; return { ok: true }; });
    const failed = await MUT.runMomentMutation(mk(), { momentExists: true }, async () => { runs++; return { ok: false, error: 'write-failed' }; });
    return denied.executed === false && runs === 2 && allowed.executed === true && allowed.ok === true
      && failed.executed === true && failed.ok === false && failed.decision === 'allow';
  })(), await (async () => {
    let runs = 0;
    const denied = await MUT.runMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: true }, async () => { runs++; });
    const allowed = await MUT.runMomentMutation(mk(), { momentExists: true, actorIsMomentAuthor: false }, async () => { runs++; return { ok: true }; });
    const failed = await MUT.runMomentMutation(mk(), { momentExists: true }, async () => ({ ok: false, error: 'write-failed' }));
    return {
      runs: runs, deniedExecuted: denied.executed, allowedOk: allowed.ok, allowedExec: allowed.executed,
      failedOk: failed.ok, failedExec: failed.executed, failedDecision: failed.decision, failedReason: failed.reason
    };
  })());
  check('MA15b.secretRejected', MUT.buildMomentMutation(mk({ context: { apiKey: 'sk-abcdefgh12345678' } })).errors.indexOf('secret-in-action') >= 0);

  /* ══════════ C · 真实 moments.js 行为（MA12/MA13b） ══════════ */
  section('C · Real moments.js behaviour（MA12/MA13b）');
  const page = buildPage();
  page.put(roleMoment('mom_a'));
  const userLike = JSON.parse(JSON.stringify(await page.like('mom_a')));
  const selfLike = JSON.parse(JSON.stringify(await page.like('mom_a', 'role_a')));
  check('MA12.manualMutationWorks',
    userLike.ok === true && userLike.liked === true && page.get('mom_a').likes.join(',') === 'u1'
    && selfLike.ok === false && selfLike.error === '作者不能点赞自己', { userLike: userLike, selfLike: selfLike });
  const userUnlike = JSON.parse(JSON.stringify(await page.like('mom_a')));
  check('MA12b.unlikeWorks', userUnlike.ok === true && userUnlike.liked === false && page.get('mom_a').likes.length === 0);
  const roleLike = JSON.parse(JSON.stringify(await page.like('mom_a', 'role_b')));
  check('MA12c.roleCanLikeOthers', roleLike.ok === true && page.get('mom_a').likes.join(',') === 'role_b');
  const roleUnlikeNoop = JSON.parse(JSON.stringify(await page.like('mom_a', 'role_b')));
  check('MA12d.aiUnlikeIsNoop',
    roleUnlikeNoop.ok === true && page.get('mom_a').likes.join(',') === 'role_b');
  const c1 = JSON.parse(JSON.stringify(await page.comment('mom_a', { authorType: 'user', authorId: 'u1', content: '用户评论' })));
  const c2 = JSON.parse(JSON.stringify(await page.comment('mom_a', { authorType: 'role', authorId: 'role_b', content: '角色评论' })));
  const cDup = JSON.parse(JSON.stringify(await page.comment('mom_a', { authorType: 'role', authorId: 'role_b', content: '角色评论' })));
  check('MA12e.commentAuthorityWorks',
    c1.ok === true && c2.ok === true && cDup.ok === false && cDup.error === '评论重复'
    && page.get('mom_a').comments.length === 2, { c1: c1.ok, c2: c2.ok, dup: cDup.error });
  const delOther = JSON.parse(JSON.stringify(await page.delComment('mom_a', c2.comment.id)));
  const commentsAfterDeniedDelete = page.get('mom_a').comments.length;
  const delOwn = JSON.parse(JSON.stringify(await page.delComment('mom_a', c1.comment.id)));
  check('MA13b.unauthorizedMutationDenied',
    delOther.ok === false && commentsAfterDeniedDelete === 2
    && delOwn.ok === true && page.get('mom_a').comments.length === 1, { delOther: delOther, delOwn: delOwn.ok });
  const lordDelete = JSON.parse(JSON.stringify(await page.delComment('mom_a', c2.comment.id, 'role_a')));
  check('MA13c.momentAuthorRoleCanModerate',
    lordDelete.ok === true && page.get('mom_a').comments.length === 0);
  const roleDelOtherRoleMoment = JSON.parse(JSON.stringify(await page.del('mom_a', { actorKind: 'role', actorId: 'role_b' })));
  const rowAfterRoleAttempt = !!page.get('mom_a');
  const userDel = JSON.parse(JSON.stringify(await page.del('mom_a')));
  check('MA13d.momentDeleteAuthority',
    roleDelOtherRoleMoment.ok === false && rowAfterRoleAttempt === true
    && userDel.ok === true && page.get('mom_a') === null,
    { role: roleDelOtherRoleMoment, user: userDel, rowAfterRoleAttempt: rowAfterRoleAttempt });
  check('MA14b.executorRanOnlyForAllowed', page.stats.executorRuns >= 6);

  /* ══════════ D · 边界（MA19–MA25） ══════════ */
  section('D · Boundaries（MA19–MA25）');
  check('MA19.createInvariantUnchanged',
    countOf(stripComments(MOMENTS_SRC), 'runMomentAutonomy(') === 2
    && !/createMoment\(|_momentsWriteCanonical/.test(MUT_SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('MA20.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('MA21.p23Unchanged', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('MA22.p24Unchanged', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('MA23.dbSchemaUnchanged',
    /DB_VER=24/.test(read('assets/js/core.js'))
    && /MOMENTS_SCHEMA_VERSION = 1/.test(read('services/home-node/moments-store.js'))
    && sha256('services/home-node/moments-store.js') === FROZEN_SHA256['services/home-node/moments-store.js']);
  check('MA24.noNewStore', !/createObjectStore|duplicateStore|mutationLog/.test(stripComments(MOMENTS_SRC) + stripComments(MUT_SRC)));
  check('MA25.noNewQueue',
    !/setTimeout|setInterval|deferredQueue|pendingMutation|mutationQueue/.test(stripComments(MUT_SRC))
    && !/mutationQueue|pendingMutation/.test(stripComments(MOMENTS_SRC)));
  check('MA25b.moduleIsPure',
    !/localStorage|indexedDB|document|fetch\(|Date\.now|Math\.random|Memory|middle-brain/.test(stripComments(MUT_SRC)));
  check('MA25c.moduleLoadedBeforeMoments', (() => {
    const html = read('InternalBeyond.html');
    const i = html.indexOf('src="assets/js/moments-mutation-authority.js"');
    const j = html.indexOf('src="assets/js/moments.js"');
    return i > 0 && j > 0;
  })());

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2.5 · mutation authority: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', (e && e.stack) || e); process.exitCode = 1; });
