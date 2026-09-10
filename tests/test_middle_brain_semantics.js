/* ====================================================================
   P11-3 · Middle Brain Runtime Semantics Closure · 专项测试（静态、零依赖、无浏览器）
   --------------------------------------------------------------------
   本阶段不改 Middle Brain 能力，只修 Runtime Participation Audit 暴露出的三处语义：
     A. UI/runtime 状态一致性：编辑态 toggle 不再冒充 runtime 启用；
     B. 注入来源三态契约：astra / local / bypass（local 语义闭合）；
     C. 不扩公共 API、不动 Judge / OOC Guard 默认值。
   做法（不重新实现生产逻辑）：
     · A 段把生产层 assets/js/middle-brain-config.js 原样加载进沙箱（复用 P14 折叠测试的
       DOM / IndexedDB 桩，见 test_middle_brain_collapse.js），断言真实状态机；
     · B 段把 communication.js 里的 _mbInjectable 原文抽出来做纯函数表驱动验证
       （payload 安全注入契约就在这一个函数里，不在测试里复刻第二份）。
   运行：node test_middle_brain_semantics.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const readUtf8 = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');

/* ── 复用 P14 折叠测试的沙箱（真实 config 层 + IndexedDB / document 桩）── */
const sbHarness = fs.readFileSync(path.join(__dirname, 'test_middle_brain_collapse.js'), 'utf8');
const sbBoundary = sbHarness.indexOf('(async function main() {');
if (sbBoundary < 0) { console.error('  FAIL  harness.boundary  -> test_middle_brain_collapse.js 结构变化'); process.exit(1); }
const { loadSandbox, settle, CFG_COMPLETE } = new Function('require', '__dirname',
  sbHarness.slice(0, sbBoundary) + '\nreturn {loadSandbox, settle, CFG_COMPLETE};')(require, __dirname);

const badge = sbx => sbx.dom.byId.get('mb-collapse-badge').textContent;
const badgeEl = sbx => sbx.dom.byId.get('mb-collapse-badge');
const toggle = sbx => sbx.dom.byId.get('mb-enabled-toggle');
const status = sbx => sbx.dom.byId.get('mb-save-status').textContent;
const runtimeEnabled = sbx => sbx.MBC.config.isMiddleBrainEnabled();
const writesTo = (sbx, id) => sbx.dbWrites.filter(w => w.id === id).length;
const setToggle = (sbx, on) => { const t = toggle(sbx); t.checked = !!on; t.dispatchEvent({ type: 'change' }); };
async function booted(opts) {
  const sbx = loadSandbox(opts);
  await sbx.MBC.config.loadMiddleBrainConfigUI();
  return sbx;
}

/* 未保存的编辑不该产生任何写入：记录基线计数，供各步比较 */
const MB_WRITES = sbx => writesTo(sbx, 'middle_brain');

(async function main() {
  console.log('P11-3 · Middle Brain runtime semantics closure（UI/runtime + local fallback）\n');

  /* ═══════════ A. UI / runtime 状态一致性 ═══════════ */
  const s1 = await booted({ mbConfig: CFG_COMPLETE });
  check('A1.loadedIsClean', badge(s1) === 'Enabled' && toggle(s1).checked === true
    && (await runtimeEnabled(s1)) === true && !badgeEl(s1).classList.contains('is-dirty') && status(s1) === '',
    JSON.stringify({ badge: badge(s1), rt: await runtimeEnabled(s1), status: status(s1) }));
  check('A2.loadWritesNothing', MB_WRITES(s1) === 0, '加载配置只读，实际写入 ' + MB_WRITES(s1));

  /* toggle → 未保存：runtime 不变、徽标进入 Unsaved、零写入 */
  setToggle(s1, false);
  check('A3.unsavedToggleNotEffective', badge(s1) === 'Unsaved' && badgeEl(s1).classList.contains('is-dirty')
    && !badgeEl(s1).classList.contains('is-on') && (await runtimeEnabled(s1)) === true && MB_WRITES(s1) === 0,
    JSON.stringify({ badge: badge(s1), rt: await runtimeEnabled(s1), writes: MB_WRITES(s1) }));
  check('A4.unsavedStatusShown', status(s1) === '未保存' && String(badgeEl(s1).title).indexOf('Runtime: Enabled') === 0,
    status(s1) + ' / ' + badgeEl(s1).title);

  /* 未保存的 endpoint / API Key 编辑同样只改 dirty 显示 */
  s1.dom.byId.get('mb-endpoint').value = 'https://edited.example.com/v1/responses';
  s1.dom.byId.get('mb-endpoint').dispatchEvent({ type: 'input' });
  check('A5.unsavedEndpointNotEffective', badge(s1) === 'Unsaved' && (await runtimeEnabled(s1)) === true && MB_WRITES(s1) === 0,
    JSON.stringify({ badge: badge(s1), rt: await runtimeEnabled(s1), writes: MB_WRITES(s1) }));
  s1.dom.byId.get('mb-endpoint').value = CFG_COMPLETE.endpoint;
  s1.dom.byId.get('mb-endpoint').dispatchEvent({ type: 'input' });

  /* 保存 → runtime 才改变；徽标回到 runtime 真值 */
  await s1.MBC.config.saveMiddleBrainConfigUI();
  const saved = s1.store.apiSettings.middle_brain;
  check('A6.saveMakesRuntimeEffective', saved.enabled === false && (await runtimeEnabled(s1)) === false
    && badge(s1) === 'Disabled' && !badgeEl(s1).classList.contains('is-dirty') && MB_WRITES(s1) >= 1,
    JSON.stringify({ saved: saved.enabled, rt: await runtimeEnabled(s1), badge: badge(s1), writes: MB_WRITES(s1) }));
  check('A7.saveStatusShown', status(s1) === '已保存', status(s1));

  /* reload → UI 与 runtime 完全一致（enabled=false 态） */
  await s1.MBC.config.loadMiddleBrainConfigUI();
  check('A8.reloadConsistentOff', toggle(s1).checked === false && badge(s1) === 'Disabled'
    && (await runtimeEnabled(s1)) === false && !badgeEl(s1).classList.contains('is-dirty'),
    JSON.stringify({ checked: toggle(s1).checked, badge: badge(s1), rt: await runtimeEnabled(s1) }));

  /* 打开 → 未保存 → 保存 → reload：同一序列在 enabled=true 方向必须对称 */
  setToggle(s1, true);
  const midOn = { badge: badge(s1), rt: await runtimeEnabled(s1) };
  await s1.MBC.config.saveMiddleBrainConfigUI();
  await s1.MBC.config.loadMiddleBrainConfigUI();
  check('A9.reloadConsistentOn', midOn.badge === 'Unsaved' && midOn.rt === false
    && toggle(s1).checked === true && badge(s1) === 'Enabled' && (await runtimeEnabled(s1)) === true,
    JSON.stringify({ midOn: midOn, checked: toggle(s1).checked, badge: badge(s1), rt: await runtimeEnabled(s1) }));

  /* enabled=true 但 endpoint 缺失：runtime 确实是关的，徽标不得显示 Enabled */
  const s2 = await booted({ mbConfig: { enabled: true, endpoint: '', model: 'gpt-6-astra', apiKey: '' } });
  check('A10.incompleteNotClaimedEnabled', toggle(s2).checked === true && badge(s2) === 'Disabled'
    && (await runtimeEnabled(s2)) === false && !badgeEl(s2).classList.contains('is-dirty'),
    JSON.stringify({ checked: toggle(s2).checked, badge: badge(s2), rt: await runtimeEnabled(s2) }));

  /* 全新安装（无配置）：默认关闭且不显示 Unsaved */
  const s3 = await booted({});
  check('A11.freshInstallCleanDisabled', badge(s3) === 'Disabled' && toggle(s3).checked === false
    && (await runtimeEnabled(s3)) === false && !badgeEl(s3).classList.contains('is-dirty') && status(s3) === '',
    JSON.stringify({ badge: badge(s3), status: status(s3) }));

  /* 不扩公共 API / 层契约：新状态机符号必须全部留在 config 层内部 */
  const cfgKeys = Object.keys(s3.MBC.config);
  check('A12.noContractExpansion', ['_mbDirty', '_mbBadgeState', '_mbCaptureSaved', '_mbRuntimeEnabled', '_mbSaved', '_mbRuntime']
    .every(k => cfgKeys.indexOf(k) < 0), '编辑态/runtime 状态机符号泄漏进 config 契约: ' + cfgKeys.join(','));
  check('A13.singleRuntimePredicate', readUtf8('assets/js/middle-brain-config.js').indexOf('_mbRuntimeEnabled(await getMiddleBrainConfig())') >= 0,
    'isMiddleBrainEnabled 未复用唯一的 runtime 谓词（UI 与 runtime 会再次漂移）');

  /* ═══════════ B. 注入来源三态契约（local payload 安全注入） ═══════════ */
  const comText = readUtf8('assets/js/communication.js');
  const fnSrc = comText.match(/function _mbInjectable\(res,userMessage\)\s*\{[\s\S]*?\n\}/);
  check('B1.contractExists', !!fnSrc, 'communication.js 缺少 _mbInjectable 注入契约');
  const injectable = fnSrc ? new Function(fnSrc[0] + '\n;return _mbInjectable;')() : () => false;
  const ASTRA_OK = { source: 'astra', compressedContext: 'ASTRA_CTX', stats: { empty: false } };
  const LOCAL_OK = { source: 'local', compressedContext: '【当前对话】\nUSER_MSG', stats: { empty: false } };
  const CASES = [
    /* [名称, seam 返回值, 当前用户消息, 期望] —— 只列举具名来源；其它一律 bypass */
    ['astra+非空 payload → 注入', ASTRA_OK, 'USER_MSG', true],
    ['astra 不含当前消息 → 仍注入（Astra 成功路径行为不变）', ASTRA_OK, 'NOT_PRESENT', true],
    ['local+含当前消息 → 注入', LOCAL_OK, 'USER_MSG', true],
    ['local 不含当前消息 → bypass（本地输出契约反证）', { source: 'local', compressedContext: 'X', stats: { empty: false } }, 'USER_MSG', false],
    ['local+空 payload → bypass', { source: 'local', compressedContext: '', stats: { empty: false } }, 'USER_MSG', false],
    ['local+纯空白 payload → bypass', { source: 'local', compressedContext: '   \n ', stats: { empty: false } }, 'USER_MSG', false],
    ['local+非字符串 payload → bypass', { source: 'local', compressedContext: { a: 1 } }, 'USER_MSG', false],
    ['stats.empty=true（全空兜底回声）→ bypass', { source: 'local', compressedContext: 'USER_MSG', stats: { empty: true } }, 'USER_MSG', false],
    ['未具名来源 "" → bypass', { source: '', compressedContext: 'X' }, 'USER_MSG', false],
    ['未知来源 "runtime" → bypass（白名单，不是 truthy）', { source: 'runtime', compressedContext: 'X' }, 'USER_MSG', false],
    ['大小写漂移 "ASTRA" → bypass', { source: 'ASTRA', compressedContext: 'X' }, 'USER_MSG', false],
    ['bypass 显式标记 → bypass', { source: 'bypass', compressedContext: 'X' }, 'USER_MSG', false],
    ['null（未启用）→ bypass', null, 'USER_MSG', false],
    ['undefined → bypass', undefined, 'USER_MSG', false],
    ['字符串（非法形状）→ bypass', 'local', 'USER_MSG', false]
  ];
  let bad = [];
  for (const [name, res, msg, want] of CASES) {
    const got = injectable(res, msg) === true;
    if (got !== want) bad.push(name + ' → ' + got);
  }
  check('B2.contractTable', bad.length === 0, bad.join(' | '));
  check('B3.contractIsPrivate', !/window\._mbInjectable\s*=/.test(comText)
    && !/_mbInjectable\s*[:=]/.test(readUtf8('assets/js/middle-brain.js')),
    '_mbInjectable 不得成为新的全局/门面符号（只能在 communication.js 的 IIFE 内私有）');

  /* 三态 trace 字段：consumer 侧必须把来源写成具名三态（astra / local / bypass） */
  check('B4.traceTriState', /_mbSource=String\(\(_mbRes&&_mbRes\.source\)\|\|''\)\|\|'bypass'/.test(comText)
    && /_mbTrSink\.note\(cfg\.id,'source',_mbSource\)/.test(comText),
    'consumer 未把注入来源写成 astra / local / bypass 三态');
  check('B5.seamMarksBypass', /_mbTraceNote\(characterId, 'source', 'bypass'\)/.test(readUtf8('assets/js/middle-brain.js')),
    '执行缝返回 null 时未把 trace 来源标记为 bypass');

  /* ═══════════ C. 默认值不被本阶段改动 ═══════════ */
  const cfgText = readUtf8('assets/js/middle-brain-config.js');
  check('C1.judgeStillDefaultOff', /middleBrainJudgeEnabled:\s*false/.test(cfgText), 'Judge 默认值被改动');
  check('C2.oocGuardStillDefaultOff', /characterIntegrityEnabled:\s*false/.test(cfgText)
    && /characterIntegrityRewrite:\s*false/.test(cfgText) && /characterIntegrityVerify:\s*false/.test(cfgText),
    'Character Integrity（OOC Guard）默认值被改动');
  check('C3.middleBrainStillDefaultOff', /^\s*enabled:\s*false,/m.test(cfgText), 'Middle Brain 默认启用状态被改动');

  console.log('\n' + (failures ? '✖ ' + failures + ' 项失败' : '✔ 全部通过'));
  if (failures) process.exitCode = 1;
})().catch(e => { console.error(e && (e.stack || e)); process.exitCode = 1; });
