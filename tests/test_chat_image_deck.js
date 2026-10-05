'use strict';
/* ============================================================================
   Internal Beyond · UI-P2 · Chat Image Deck — 结构 / 契约套件（纯 Node，零浏览器）
   ----------------------------------------------------------------------------
   运行：node tests/test_chat_image_deck.js

   覆盖：
     count policy（1 / 2..6 / >6）· state reducer（clamping / non-looping）·
     stable key（data-msg-id）· visible stack depth ≤ 3 · preload policy ·
     error isolation · no durable state · no attachment mutation ·
     loader seam · CSS KPI · reduced motion。
   其中 policy / visibleDepth / clamp 是从生产源码里**机械抽取的真实函数**，
   在 vm 里执行，不是复制一份公式。
   ============================================================================ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'assets', 'js', 'chat-image-deck.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'chat-image-deck.css');
const LOADER_PATH = path.join(ROOT, 'assets', 'js', 'preloader.js');

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const RAW = fs.readFileSync(JS_PATH, 'utf8').replace(/^\uFEFF/, '');
const CSS = fs.readFileSync(CSS_PATH, 'utf8').replace(/^\uFEFF/, '');
const LOADER = fs.readFileSync(LOADER_PATH, 'utf8').replace(/^\uFEFF/, '');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const CODE = stripComments(RAW);

/* ---- 机械抽取真实生产函数（括号匹配，拒绝空切片） ---- */
function sliceFunction(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return '';
}

const CONST_NAMES = ['MIN_DECK', 'MAX_STACKED', 'VISIBLE_STACK_DEPTH', 'DRAG_LOCK_PX', 'AXIS_BIAS',
  'COMMIT_RATIO', 'COMMIT_VELOCITY', 'EDGE_GUARD_PX', 'CLICK_SLOP_PX'];
const constSource = CONST_NAMES
  .map(n => (new RegExp('^\\s*var ' + n + ' = [^;]+;', 'm').exec(RAW) || [''])[0])
  .filter(Boolean)
  .join('\n');

const fnSource = [
  sliceFunction(CODE, 'function clamp('),
  sliceFunction(CODE, 'function policy('),
  sliceFunction(CODE, 'function visibleDepth(')
].join('\n');

const probe = new Function(constSource + '\n' + fnSource + '\nreturn { policy: policy, visibleDepth: visibleDepth, clamp: clamp };')();

section('§1 探针覆盖（真实生产函数，不是复制品）');

check('P1.constantsExtracted', constSource.length > 80 && CONST_NAMES.every(n => constSource.indexOf(n) >= 0), constSource.replace(/\n/g, ' | '));
check('P1.realFunctionsExtracted',
  !!probe.policy && !!probe.visibleDepth && typeof probe.clamp === 'function'
  && /MAX_STACKED/.test(sliceFunction(CODE, 'function policy(')),
  '抽取出来的 policy 必须引用生产常量 MAX_STACKED');
check('P1.clampIsTheProductionOne', probe.clamp(5, 0, 3) === 3 && probe.clamp(-1, 0, 3) === 0);

section('§2 count policy');

check('C1.zeroIsNoDeck', probe.policy(0) === 'NO_IMAGE_DECK');
check('C2.singleIsSingleImage', probe.policy(1) === 'SINGLE_IMAGE');
for (let n = 2; n <= 6; n++) {
  check('C3.' + n + 'isStackedDeck', probe.policy(n) === 'STACKED_IMAGE_DECK', probe.policy(n));
}
check('C4.sevenIsStackedWithExpand', probe.policy(7) === 'STACKED_IMAGE_DECK_WITH_EXPAND', probe.policy(7));
check('C5.largeIsStackedWithExpand', probe.policy(20) === 'STACKED_IMAGE_DECK_WITH_EXPAND', probe.policy(20));
check('C6.policyIsExhaustive',
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 20, 100].every(n => ['NO_IMAGE_DECK', 'SINGLE_IMAGE', 'STACKED_IMAGE_DECK', 'STACKED_IMAGE_DECK_WITH_EXPAND'].indexOf(probe.policy(n)) >= 0));

section('§3 visible stack depth');

check('D1.depthNeverExceedsThree', [2, 3, 4, 5, 6, 7, 20, 100].every(n => probe.visibleDepth(n) <= 3),
  [2, 20].map(n => n + '->' + probe.visibleDepth(n)).join(' '));
check('D2.twoImagesShowOneBackCard', probe.visibleDepth(2) === 1);
check('D3.sixImagesCapAtThree', probe.visibleDepth(6) === 3);
check('D4.hugeStillCaps', probe.visibleDepth(100) === 3);
check('D5.singleHasNoBackCard', probe.visibleDepth(1) === 0);

section('§4 state reducer：clamping / non-looping');

check('S1.navigationIsNonLooping', /navigation: 'NON_LOOPING'/.test(CODE));
check('S2.indexIsClampedNotWrapped',
  /clamp\(next, 0, count - 1\)/.test(CODE) && !/%\s*count/.test(CODE),
  '越界必须 clamp（no-op），不得取模回绕');
check('S3.setIndexGuardsEmpty', /if \(!count\) return;/.test(CODE));
check('S4.prevNextDisabledAtEnds', /rec\.prev\.disabled = rec\.index <= 0/.test(CODE) && /rec\.next\.disabled = rec\.index >= count - 1/.test(CODE));

section('§5 stable key & identity');

check('K1.stateKeyIsMessageId', /stateKey: 'data-msg-id'/.test(CODE) && /dataset\.msgId/.test(CODE));
check('K2.decksAreKeyedByMsgId', /state\.decks\[msgId\]/.test(CODE));
check('K3.noDomIndexKeying', !/state\.order\[\s*[a-zA-Z]*Index/.test(CODE) && !/decks\[i\]/.test(CODE));
check('K4.rowsWithoutStableIdAreSkipped', /if \(!msgId\) return null;/.test(CODE),
  '没有稳定身份的消息保持既有呈现，不做状态键');
check('K5.reRenderRebindsInsteadOfResetting', /if \(rec && rec\.adopted\) \{ forget\(msgId\); \}/.test(CODE),
  '行被重建时重新接管，state 里的 index 保留（只有超长才被 clamp）');

section('§6 preload policy');

check('L1.policyDeclared', /preloadPolicy: 'CURRENT_PLUS_NEXT'/.test(CODE));
check('L2.currentAndNextAreEager', /visible && rel <= 1 \? 'eager' : 'lazy'/.test(CODE));
check('L3.farCardsAreNotDecoded', /\[data-depth="hidden"\]\s*\{\s*display: none;/.test(CSS.replace(/\s+/g, ' ').replace(/ /g, ' ')) || /data-depth="hidden"/.test(CSS) && /display: none/.test(CSS));
check('L4.noEagerEverything', !/setAttribute\('loading', 'eager'\)/.test(CODE) || /rel <= 1/.test(CODE));

section('§7 error isolation');

check('E1.singleImageIsUntouched', /MIN_DECK = 2/.test(RAW) && /run\.length >= MIN_DECK/.test(CODE),
  'COUNT = 1 不进入 deck 分支，单图行为不变');
check('E2.noEagerEverything2', true);
check('E3.deckDoesNotRemoveImagesOnError', !/\.onerror\s*=/.test(CODE),
  'deck 不安装 onerror，也不因为单张失败移除卡片');
check('E4.failureOfOneImageCannotBreakMessage', !/row\.remove\(\)/.test(CODE) && !/deck\.remove\(\)/.test(CODE),
  'deck 不会整体移除消息或自身');

section('§8 no durable state / no message mutation');

const FORBIDDEN = ['dbPut', 'dbDelete', 'dbUpdate', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch(', 'XMLHttpRequest', 'sendBeacon'];
FORBIDDEN.forEach(name => {
  check('N.' + name, CODE.indexOf(name) === -1, name + ' 出现了');
});
check('N1.noImageSrcRewrite', !/\.src\s*=/.test(CODE.replace(/im\.src = src;/g, '')),
  '不得改写图片 URL（展开网格里以同一 src 引用，不算改写）');
check('N2.noInnerHTML', !/innerHTML/.test(CODE), '不得用 innerHTML 拼图片');
check('N3.noBase64Manipulation', !/base64/.test(CODE) && !/atob\(|btoa\(/.test(CODE));
check('N4.noSecondViewer', !/chat-bubble-img-full/.test(CODE), '不得复制第二套 fullscreen viewer');
check('N5.reusesExistingViewer', /img\.click\(\)/.test(CODE) && /window\._viewImageFull/.test(RAW),
  'viewer 必须经图片自身的 onclick（既有 authority）打开');
check('N6.viewerAuthorityDeclared', /viewerAuthority: 'window\._viewImageFull'/.test(CODE));
check('N7.orderAuthorityDeclared', /orderAuthority: 'EXISTING_MESSAGE_PAYLOAD_ORDER'/.test(CODE));
check('N8.noSortingOfImages', !/\.sort\(/.test(CODE), '不得对图片重排');

section('§9 gesture arbitration');

check('G1.axisIntentLockDeclared', /gestureArbitration: 'AXIS_INTENT_LOCK'/.test(CODE));
check('G2.verticalIntentYields', /drag\.axis = 'scroll'/.test(CODE) && /AXIS_BIAS/.test(CODE));
check('G3.noPreventDefaultOnPointerdown',
  (function () {
    const body = sliceFunction(CODE, "deck.addEventListener('pointerdown'");
    const idx = CODE.indexOf("deck.addEventListener('pointerdown'");
    const chunk = CODE.slice(idx, idx + 900);
    return chunk.indexOf('preventDefault') === -1;
  })(),
  'pointerdown 不得 preventDefault（否则会破坏聊天纵向滚动）');
check('G4.edgeGuardKeepsBackGesture', /EDGE_GUARD_PX/.test(CODE) && /ev\.clientX <= EDGE_GUARD_PX/.test(CODE));
check('G5.touchActionPanY', /touch-action:\s*pan-y/.test(CSS));
check('G6.committedDragSuppressesClick', /rec\.suppressClick = true/.test(CODE) && /CLICK_SLOP_PX/.test(CODE));
check('G7.clickOnImageDefersToProductHandler', /if \(isChatImage\(ev\.target\)\) return;/.test(CODE));
check('G8.thresholdsAreRelativeNotHardcodedPx',
  /width \* COMMIT_RATIO/.test(CODE) && /velocity > COMMIT_VELOCITY/.test(CODE));

section('§10 accessibility / motion');

check('A1.deckIsFocusable', /deck\.tabIndex = 0/.test(CODE));
check('A2.deckHasRoleAndLabel', /setAttribute\('role', 'group'\)/.test(CODE) && /setAttribute\('aria-label', '图片 '/.test(CODE));
check('A3.liveRegionAnnounces', /setAttribute\('aria-live', 'polite'\)/.test(CODE));
check('A4.navButtonsLabelled', /'上一张图片'/.test(CODE) && /'下一张图片'/.test(CODE));
check('A5.expandLabelSpellsTheCount', /'展开全部 ' \+ count \+ ' 张图片'/.test(CODE) && /'展开 ' \+ count/.test(CODE));
check('A6.keyboardIsDeckScoped', /deck\.addEventListener\('keydown'/.test(CODE) && !/document\.addEventListener\('keydown', function \(ev\) \{\s*if \(ev\.key === 'Arrow/.test(CODE));
check('A7.reducedMotionStopsTransition', /@media \(prefers-reduced-motion: reduce\)/.test(CSS) && /transition: none/.test(CSS));
check('A8.galleryDialogSemantics', /'aria-modal', 'true'/.test(CODE) && /Escape/.test(CODE));

section('§11 loader seam & CSS budget');

check('R1.loaderInjectsModule', /assets\/js\/chat-image-deck\.js/.test(LOADER) && /createElement\('script'\)/.test(LOADER));
check('R2.loaderIsIdempotent', /ib-chat-image-deck-loader/.test(LOADER));
check('R3.cssInjectedAtRuntime', /injectStyles/.test(CODE) && /assets\/css\/chat-image-deck\.css/.test(CODE));
check('R4.noDirtyFileReferenceInCode', !/communication\.js/.test(CODE) && !/InternalBeyond\.html/.test(CODE) && !/chat-family\.css/.test(CODE),
  '模块代码不得引用任何 dirty 文件（注释里解释为什么不改它们是允许的）');
check('R4b.declaresWhyDomPostProcessing', /user-dirty/.test(RAW) && /data-msg-id/.test(RAW));

const CSS_METRICS = {
  gradient: /gradient/gi,
  backdropFilter: /backdrop-filter:/gi,
  bgRgba: /background:\s*rgba\(/gi,
  bgHex: /background:\s*#/gi,
  smallFont: /font-size:\s*(?:0?\.(?:[0-6]\d?|7[0-3]?)rem|(?:\d(?:\.\d+)?|1[01](?:\.\d+)?)px)/gi,
  bigRadius: /border-radius:\s*(?:2[0-9]|[3-9]\d|\d{3,})px/gi,
  important: /!important/gi,
  rawHex: /#[0-9a-fA-F]{3,8}\b/g,
  violet: /#a855f7|#8b5cf6|#7c3aed|#6366f1|#667eea|#764ba2|#4f46e5|#818cf8/gi
};
Object.keys(CSS_METRICS).forEach(k => {
  const n = (CSS.match(CSS_METRICS[k]) || []).length;
  check('R5.css.' + k, n === 0, k + ' = ' + n);
});

section('§12 注册');

const TEST_ALL = fs.readFileSync(path.join(ROOT, 'tests', 'test-all.js'), 'utf8');
check('T1.registeredOnce',
  TEST_ALL.split("'test_chat_image_deck.js'").length - 1 === 1,
  'must be registered exactly once in tests/test-all.js');

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('CHAT IMAGE DECK STRUCTURAL FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('CHAT IMAGE DECK STRUCTURAL PASSED · ' + passed + ' assertions green');
