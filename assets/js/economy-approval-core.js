/* ====================================================================
   IB · Economy Approval UI — core（P22-15）
   --------------------------------------------------------------------
   本文件是"待决定"页面的**纯层**，它做且只做四件事：

     1. 把 canonical 只读面的三个答案合成为一份**视图模型**
        （GET /economy/intents · /economy/approvals · /economy/products）；
     2. 把 canonical 的状态词与 reasonCode 映射成**用户文案**；
     3. 构造 P22-13 seam 的请求体（恰好三个字段）；
     4. 把 seam 的回答归类成"这张卡片现在该说什么"。

   ── 它**不**做什么（逐条对着 §6 / §15）───────────────────────────────
   · 不碰 DOM（没有 document / window 访问）。DOM 全在
     assets/js/economy-approval.js 里，因此这一层可以在 Node 里用真实
     数据形状直接测。
   · 不发请求（transport 由调用方注入）。
   · **不判定任何经济事实**：余额够不够、预算剩余多少、自主裁决是什么、
     批准是否有效、报价是否过期、购买是否成功 —— 这六件事一个都不在
     这里算。它只**呈现**读面已经给出的结论字段
     （authorityOutcome / authorityReasonCode / approval.status /
      approval.expiredByTime / purchaseId / 各 expiresAt）。
     读面没给的，缺着；不推、不猜、不兜 0。
   · 不做二次映射：状态词与 reasonCode 直接取自 canonical 值，本文件的
     词表是**展示名**，不是第二套状态机。任何未知词都落到一个诚实的
     兜底（保留原词 + 中性文案），而不是被硬塞进某一个已知桶。

   ── 身份：浏览器只发三个字段（§15）──────────────────────────────────
   buildDecisionRequest() 是**唯一**的请求体构造点，它的输出键恰好是
   approvalId / decision / idempotencyKey。它**没有**接受额外字段的入口：
   没有 ...spread、没有可选参数、没有"附加信息"参数。因此
   consumerId / userId / authority / approved / autoAllow / amountMinor /
   currency / productId / quoteId / purchaseId 在结构上送不出去 ——
   不是"记得别传"，而是没有那个位置。

   ── 金额展示（唯一一处"看起来像计算"的地方）────────────────────────
   canonical 金额是 minor 整数 + 币种 id，scale 与展示名属于**契约**。
   scaleOf() / currencyDisplayName() 是这两张表的只读镜像，只为把
   12345 IB_CREDIT 写成 "123.45 IB Credit"。
   ★ 它们**不参与任何判定**（没有比较、没有加总、没有余额运算），
     而测试会逐字断言这两张表与 services/home-node/economy-contract.js
     的 CURRENCY_SCALE / CURRENCY_DISPLAY **完全一致** ——
     未来有人给契约加一种币，这里会因为"少一个键"而红，不会静默显示错。
   ==================================================================== */
(function (NS) {
'use strict';

var CORE_VERSION = 'p22-15-1';

var ID = Object.freeze({
  /* 页面容器（InternalBeyond.html 里的空容器；卡片由本模块渲染） */
  HOST: 'economy-requests',
  /* 决定面（P22-13）—— **不是** /economy/* 下的一条路径。 */
  DECISION_PATH: '/internal/economy/approval-decision'
});

/* 只读面：四条既有 GET，本阶段不新增任何读路径。
   ★ 第四条是 `/security`（P11-3A 起就有的自述面）：它逐字回答"这条决定
     路径现在是不是开的"。于是"凭据没配"这件事可以在**进入页面时**就说
     出来，而不是等用户点了按钮才用一次失败告诉他。 */
var READS = Object.freeze({
  INTENTS: '/economy/intents',
  APPROVALS: '/economy/approvals',
  PRODUCTS: '/economy/products',
  SECURITY: '/security'
});

/* 决定词：canonical 只有两个，而浏览器能发出的也只有这两个。 */
var DECISION = Object.freeze({ APPROVE: 'APPROVE', REJECT: 'REJECT' });
var DECISIONS = Object.freeze([DECISION.APPROVE, DECISION.REJECT]);

/* 请求体键：恰好三个。 */
var REQUEST_KEYS = Object.freeze(['approvalId', 'decision', 'idempotencyKey']);

/* canonical 状态词（镜像，不新增）。 */
/* 批准面的两个词在 intent 面**没有**对应项（intent 没有 APPROVED /
   REJECTED 状态），因此 effectiveStatus 在那些分支上用的是**批准面自己的
   词**。两个词表都在这里，谁也不冒充谁。 */
var APPROVAL_STATE_PENDING = 'PENDING';
var INTENT_STATE = Object.freeze({
  PROPOSED: 'PROPOSED',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED'
});
var APPROVAL_STATUS = Object.freeze({
  PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED', CONSUMED: 'CONSUMED'
});
var AUTHORITY_OUTCOME = Object.freeze({
  ALLOW: 'ALLOW', AUTO_ALLOW: 'AUTO_ALLOW', DENY: 'DENY', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL'
});
var QUOTE_KIND = Object.freeze({ PURCHASE: 'PURCHASE', GIFT: 'GIFT', COMPUTE_GRANT: 'COMPUTE_GRANT' });
var PRODUCT_KIND = Object.freeze({
  DIGITAL_ITEM: 'DIGITAL_ITEM', CONSUMABLE: 'CONSUMABLE', API_QUOTA: 'API_QUOTA',
  COMPUTE_CREDIT: 'COMPUTE_CREDIT', SERVICE: 'SERVICE'
});

/* 币种镜像（展示用；测试逐字比对契约）。 */
var CURRENCY_SCALE = Object.freeze({
  IB_CREDIT: 100, ACTIVITY_POINT: 100,
  COMPUTE_STANDARD: 1, COMPUTE_PREMIUM: 1, IMAGE_CREDIT: 1, VOICE_CREDIT: 1
});
var CURRENCY_LABEL = Object.freeze({
  IB_CREDIT: 'IB Credit', ACTIVITY_POINT: 'Activity Point',
  COMPUTE_STANDARD: 'Standard Compute Credit', COMPUTE_PREMIUM: 'Premium Compute Credit',
  IMAGE_CREDIT: 'Image Credit', VOICE_CREDIT: 'Voice Credit'
});

/* ══════════════════════════════════════════════════════════════════
   文案层：canonical 词 → 用户能读的一句话
   ------------------------------------------------------------------
   ★ 这里**没有**任何词是"用户界面自己发明的状态"。每个键都是
     economy-contract.js 里存在的值；未知值走 fallback（保留原词）。
   ══════════════════════════════════════════════════════════════════ */

/* 待决定那条主线上，角色在做什么。 */
var ASK_LABEL = Object.freeze({
  PURCHASE: '想购买一项内容',
  GIFT: '想送出一份礼物',
  COMPUTE_GRANT: '想补充一些算力'
});

/* 状态徽标：label 是给用户看的，code 只出现在技术详情里。 */
var STATUS_FACE = Object.freeze({
  WAITING_APPROVAL: { tone: 'waiting', label: '等待你的决定' },
  EXECUTING: { tone: 'progress', label: '已允许 · 正在继续' },
  COMPLETED: { tone: 'done', label: '已完成' },
  DENIED: { tone: 'denied', label: '没有通过' },
  EXPIRED: { tone: 'expired', label: '已过期' },
  FAILED: { tone: 'failed', label: '没能完成' },
  PROPOSED: { tone: 'progress', label: '正在解析' },
  /* 批准面自己的两个词：它们描述的是**许可**，不是购买。 */
  APPROVED: { tone: 'progress', label: '已允许 · 等待继续' },
  REJECTED: { tone: 'denied', label: '已拒绝' },
  CONSUMED: { tone: 'done', label: '已完成' },
  PENDING: { tone: 'waiting', label: '等待你的决定' }
});

var PRODUCT_KIND_LABEL = Object.freeze({
  DIGITAL_ITEM: '数字内容',
  CONSUMABLE: '消耗品',
  API_QUOTA: '接口额度',
  COMPUTE_CREDIT: '算力额度',
  SERVICE: '服务'
});

/* IB_CREDIT 等词不进正文（§4：底层 code 只在 detail 层）。 */
var CURRENCY_LABEL_ZH = Object.freeze({
  IB_CREDIT: 'IB Credit',
  ACTIVITY_POINT: '活动点',
  COMPUTE_STANDARD: '标准算力额度',
  COMPUTE_PREMIUM: '高级算力额度',
  IMAGE_CREDIT: '图像额度',
  VOICE_CREDIT: '语音额度'
});

/* ══════════════════════════════════════════════════════════════════
   reasonCode → 一句人话
   ------------------------------------------------------------------
   §14：用户不该看到 AMOUNT_EXCEEDS_PER_TRANSACTION。
   ★ 这张表的**语义**来自 canonical 词表本身（每个键都在
     economy-contract.js 的 DENY_REASON 里），而句子是按"用户该做什么"
     分组的：钱不够 / 额度不够 / 商品没了 / 报价过期 / 规则没配。
     把"拆单或换商品"与"等窗口滚动"写成同一句话，会让用户只能猜。
   ══════════════════════════════════════════════════════════════════ */
var REASON_TEXT = Object.freeze({
  INSUFFICIENT_BALANCE: '余额不够了',
  INSUFFICIENT_AVAILABLE_BALANCE: '余额被其它预留占住了，可用部分不够',
  INSUFFICIENT_COMPUTE_CREDIT: '算力额度不够了',
  INSUFFICIENT_INVENTORY: '这件内容暂时没有了',
  PER_TX_LIMIT: '这次金额超过了单笔上限',
  AMOUNT_EXCEEDS_PER_TRANSACTION: '这次金额超过了单笔上限',
  DAILY_LIMIT: '今天的额度已经用完',
  WEEKLY_LIMIT: '这周的额度已经用完',
  MONTHLY_LIMIT: '这个月的额度已经用完',
  CATEGORY_LIMIT: '这一类内容的额度已经用完',
  RECIPIENT_LIMIT: '给这个对象的额度已经用完',
  AUTONOMY_LIMIT: '超出了她可以自己决定的额度',
  AUTONOMY_NOT_PERMITTED: '这件事不在她可以自己决定的范围内',
  AMOUNT_EXCEEDS_APPROVAL_THRESHOLD: '金额超过了可以自己决定的上限，所以要问你',
  COOLDOWN_ACTIVE: '刚刚才买过，还需要等一会儿',
  EMERGENCY_RESERVE: '会动到预留的底线',
  WALLET_NOT_READY: '这边的钱包状态还没准备好',
  PRODUCT_DISABLED: '这件内容现在不能买',
  PRODUCT_NOT_FOUND: '这件内容已经不在目录里了',
  PRODUCT_OUT_OF_STOCK: '这件内容暂时缺货',
  STORE_NOT_FOUND: '这个货架已经不在了',
  QUOTE_EXPIRED: '报价已经过期了',
  QUOTE_MISMATCH: '报价和这件内容对不上',
  RESERVATION_EXPIRED: '预留已经过期了',
  POLICY_NOT_FOUND: '还没有为这个范围配置规则',
  POLICY_TERM_EXPIRED: '配置的规则已经到期',
  POLICY_INPUT_NOT_STRUCTURED: '规则本身没有配置完整',
  INVALID_CURRENCY: '币种对不上',
  INVALID_AMOUNT: '金额不是一个有效的数',
  DUPLICATE_REQUEST: '这是一次重复的请求',
  TRANSITION_NOT_ALLOWED: '这一步现在不能做',
  PURCHASE_REQUIRES_APPROVAL: '这件事需要你先确认',
  PURCHASE_NOT_SUPPORTED: '这种购买方式还不支持',
  APPROVAL_NOT_FOUND: '这条请求对应的许可已经找不到了',
  APPROVAL_MISMATCH: '这条许可与要买的东西对不上',
  APPROVAL_NOT_CONSUMED: '这条许可没有被用掉',
  APPROVAL_EXPIRED: '这条许可已经过期了',
  APPROVAL_REQUIRED: '需要你先确认',
  MODEL_SUPPLIED_ECONOMIC_FACT: '这次请求里出现了不该由它给出的经济事实',
  INTENT_EXPIRED: '这条请求已经过期了',
  INTENT_NOT_EXECUTABLE: '这条请求现在不能继续了',
  LEDGER_UNBALANCED: '账目对不上，已停止',
  EFFECT_NOT_ALLOWED: '这项效果不被允许',
  PARTY_NOT_ALLOWED: '这个对象不能被扣款或收款',
  ACCOUNT_NOT_ALLOWED: '这个账户不能用',
  EXCHANGE_RATE_UNKNOWN: '汇率未知',
  EXCHANGE_ROUNDS_TO_ZERO: '换算后金额为零',
  EXCHANGE_CROSS_DOMAIN_FORBIDDEN: '不允许跨域换算',
  CATALOG_INPUT_NOT_STRUCTURED: '目录数据不完整',
  INVENTORY_INPUT_NOT_STRUCTURED: '库存数据不完整'
});

/* 决定面自己的拒绝码（P22-13 REFUSAL）。 */
var DECISION_REFUSAL_TEXT = Object.freeze({
  ECONOMY_APPROVAL_DECISION_NOT_CONFIGURED: '这个入口还没有打开',
  ECONOMY_APPROVAL_DECISION_DESKTOP_TOKEN_NOT_CONFIGURED: '这台设备还没有配置访问凭据',
  ECONOMY_APPROVAL_DECISION_NOT_LOOPBACK: '只能在本机操作',
  ECONOMY_APPROVAL_DECISION_MISSING_DESKTOP_CREDENTIAL: '这次操作没有带上凭据',
  ECONOMY_APPROVAL_DECISION_WRONG_DESKTOP_CREDENTIAL: '凭据不正确',
  ECONOMY_APPROVAL_DECISION_MALFORMED_ENVELOPE: '请求格式不对',
  ECONOMY_APPROVAL_DECISION_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT: '请求里带了不该由它声明的身份',
  ECONOMY_APPROVAL_DECISION_MISSING_APPROVAL_ID: '缺少要处理的请求',
  ECONOMY_APPROVAL_DECISION_APPROVAL_ID_NOT_CANONICAL: '请求标识不是规范形态',
  ECONOMY_APPROVAL_DECISION_UNEXPECTED_ENVELOPE_KEYS: '请求里带了多余的字段',
  ECONOMY_APPROVAL_DECISION_MISSING_DECISION: '缺少决定',
  ECONOMY_APPROVAL_DECISION_UNKNOWN: '决定词不被接受',
  ECONOMY_APPROVAL_DECISION_MISSING_IDEMPOTENCY_KEY: '缺少请求标识',
  ECONOMY_APPROVAL_DECISION_REQUEST_ID_CONFLICT: '这个请求标识已经用于另一个决定',
  ECONOMY_APPROVAL_DECISION_RESUME_HANDLE_NOT_BOUND: '这里还不能继续执行',
  ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE: '这条请求当前不接受这个决定',
  ECONOMY_APPROVAL_CONTINUATION_REFUSED: '允许了，但后续步骤没有通过'
});

/* transport 层的错误分类（home-node-client.js 的词表）。 */
var TRANSPORT_TEXT = Object.freeze({
  'home-node-unreachable': '连接不上本机节点',
  'home-node-transport-error': '与本机节点通信失败',
  timeout: '本机节点没有及时回应',
  'invalid-response': '本机节点返回了无法识别的回答'
});

/* ══════════════════════════════════════════════════════════════════
   小工具（全部是纯的、对坏输入不抛）
   ══════════════════════════════════════════════════════════════════ */
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isPlainObject(v) { return isObject(v); }
function str(v) { return v == null ? null : String(v); }
function trimmed(v) {
  var s = str(v);
  if (s == null) return null;
  s = s.trim();
  return s === '' ? null : s;
}
function finiteNumber(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function objectList(v) { return Array.isArray(v) ? v.filter(isObject) : []; }

/* HTML 转义：DOM 层用 textContent 写文本，但产品名 / 理由来自数据，
   任何一处要拼进 innerHTML 时都必须先过这里。 */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ══════════════════════════════════════════════════════════════════
   金额：minor 整数 + 币种 → 展示串。**只格式化，不比较。**
   ══════════════════════════════════════════════════════════════════ */
function formatAmount(minor, currency) {
  var n = finiteNumber(minor);
  if (n == null) return null;
  var scale = Number(CURRENCY_SCALE[String(currency)]);
  if (!Number.isFinite(scale)) return null;
  /* canonical 金额是非负安全整数；负数在这里**不**被兜成 0，而是拒绝
     格式化（宁可不显示，也不显示一个错的数）。 */
  if (!Number.isInteger(n) || n < 0) return null;
  var s = String(n);
  if (scale === 1) return s;
  if (scale === 100) {
    var whole = s.length > 2 ? s.slice(0, s.length - 2) : '0';
    var frac = ('00' + s.slice(-2)).slice(-2);
    return whole + '.' + frac;
  }
  return s; /* 未知 scale 不该发生（上面已拦），到这里只如实回原数 */
}
function currencyLabel(currency) {
  var c = str(currency);
  if (c == null) return '';
  return CURRENCY_LABEL_ZH[c] || CURRENCY_LABEL[c] || c;
}
function amountText(minor, currency) {
  var a = formatAmount(minor, currency);
  if (a == null) return null;
  return a + ' ' + currencyLabel(currency);
}

/* ══════════════════════════════════════════════════════════════════
   时间：只做"距现在多久"的展示换算（不是任何判定）
   ══════════════════════════════════════════════════════════════════ */
function relativeTime(atMs, nowMs) {
  var at = finiteNumber(atMs);
  var now = finiteNumber(nowMs);
  if (at == null || now == null) return null;
  var diff = at - now;
  var abs = Math.abs(diff);
  if (abs < 45 * 1000) return '刚刚';
  var mins = Math.round(abs / 60000);
  var text;
  if (mins < 60) text = mins + ' 分钟';
  else if (mins < 60 * 36) text = Math.round(mins / 60) + ' 小时';
  else text = Math.round(mins / (60 * 24)) + ' 天';
  return diff >= 0 ? ('还有 ' + text) : (text + '前');
}

/* ══════════════════════════════════════════════════════════════════
   词 → 面
   ══════════════════════════════════════════════════════════════════ */
function statusFace(code) {
  var key = str(code);
  if (key && Object.prototype.hasOwnProperty.call(STATUS_FACE, key)) {
    return { tone: STATUS_FACE[key].tone, label: STATUS_FACE[key].label, code: key, known: true };
  }
  /* 未知词：保留原词，给中性面。绝不硬塞进某个已知桶。 */
  return { tone: 'progress', label: '状态未知', code: key || null, known: false };
}
function askLabel(quoteKind) {
  var k = str(quoteKind);
  return ASK_LABEL[k] || '想买一项内容';
}
function productKindLabel(kind) {
  var k = str(kind);
  if (k == null) return null;
  return PRODUCT_KIND_LABEL[k] || k;
}
function reasonText(code) {
  var c = str(code);
  if (c == null) return null;
  return REASON_TEXT[c] || null;
}
function decisionRefusalText(code) {
  var c = str(code);
  if (c == null) return null;
  return DECISION_REFUSAL_TEXT[c] || null;
}
function transportText(code) {
  var c = str(code);
  if (c == null) return null;
  return TRANSPORT_TEXT[c] || null;
}
/* 经济裁决的词 → 一句人话。**唯一**一处映射：徽标、事实行、结果行都从这里取，
   因此同一个 canonical 词不会在一张卡片上有两种说法。 */
function authorityFace(code) {
  var c = str(code);
  if (c == null) return null;
  if (c === AUTHORITY_OUTCOME.REQUIRE_APPROVAL) return '需要你确认';
  if (c === AUTHORITY_OUTCOME.DENY) return '没有通过';
  if (c === AUTHORITY_OUTCOME.ALLOW || c === AUTHORITY_OUTCOME.AUTO_ALLOW) return '已放行';
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   终态：这条 intent（或它对应的批准）现在该显示成什么
   ------------------------------------------------------------------
   ★ 输入只有 canonical 字段。这里**不**推导"买成了没有" ——
     purchaseId 有就是有，没有就是没有。
   ══════════════════════════════════════════════════════════════════ */
function effectiveStatus(intent, approval) {
  var state = str(intent && intent.state);
  var appr = str(approval && approval.status);
  /* 批准先到期：intent 可能还停在 WAITING_APPROVAL，而它等的那条许可
     已经过期。此时"等待你的决定"是**错**的。 */
  if (state === INTENT_STATE.WAITING_APPROVAL && !approval) return { code: 'UNKNOWN', kind: 'orphan' };
  if (approval && appr === APPROVAL_STATUS.EXPIRED) return { code: INTENT_STATE.EXPIRED, kind: 'terminal' };
  if (state === INTENT_STATE.WAITING_APPROVAL) {
    if (approval.expiredByTime === true) return { code: INTENT_STATE.EXPIRED, kind: 'terminal' };
    if (appr === APPROVAL_STATUS.PENDING) return { code: INTENT_STATE.WAITING_APPROVAL, kind: 'waiting' };
    /* 许可已批、intent 还没被推进：读作"已允许 · 等待继续"（批准面自己的词）。 */
    if (appr === APPROVAL_STATUS.APPROVED) return { code: APPROVAL_STATUS.APPROVED, kind: 'progress' };
    if (appr === APPROVAL_STATUS.CONSUMED) return { code: INTENT_STATE.COMPLETED, kind: 'done' };
    /* 批准被拒但 intent 还没推进（另一个进程还没跑到）：如实说"已拒绝"。
       ★ 这里的 code 用的是**批准面自己的词**：PURCHASE_INTENT_STATE 里
         没有 REJECTED，而"这条 intent 等的那条许可被拒了"正是一个批准
         事实。开发期实测踩到的一次真实缺陷：这一支一度只给了 kind 没给
         code，于是卡片上的状态码是 undefined —— 一张写着"状态未知"的
         卡片，而它其实有一个确切的答案。 */
    if (appr === APPROVAL_STATUS.REJECTED) return { code: APPROVAL_STATUS.REJECTED, kind: 'terminal' };
    return { code: state, kind: 'progress' };
  }
  /* ★ intent 已经**在跑**是更强的信息：许可批了、续做真的开始了 ——
     这张卡片该说"正在继续"，而不是停在"等待继续"。 */
  if (state === INTENT_STATE.EXECUTING) return { code: state, kind: 'progress' };
  /* ★ 许可被拒是**更强的**事实：用户刚刚拒绝的那条请求，即使 intent 随后
     被推进到 DENIED，读起来也应该是"已拒绝"而不是"没有通过"。开发期实测
     踩到的一次真实缺陷：这里一度让 intent 的 DENIED 盖过批准的 REJECTED，
     于是用户点下"拒绝"之后卡片显示的是"没有通过"—— 同一件事的两种说法里
     丢了"是谁决定的"。 */
  if (appr === APPROVAL_STATUS.REJECTED) return { code: APPROVAL_STATUS.REJECTED, kind: 'terminal' };
  if (state === INTENT_STATE.COMPLETED) return { code: state, kind: 'done' };
  if (state === INTENT_STATE.DENIED || state === INTENT_STATE.EXPIRED || state === INTENT_STATE.FAILED) {
    return { code: state, kind: 'terminal' };
  }
  if (state === INTENT_STATE.EXECUTING) return { code: state, kind: 'progress' };
  if (state === INTENT_STATE.PROPOSED) return { code: state, kind: 'progress' };
  return { code: state, kind: 'progress' };
}

/* 卡片右侧那句"接下来会怎样"。 */
function statusNote(kind, intent, approval) {
  var state = str(intent && intent.state);
  var appr = str(approval && approval.status);
  if (kind === 'orphan') return '这条请求对应的许可记录已经找不到了';
  if (kind === 'waiting') {
    var exp = approval && approval.expiresAt;
    var rel = relativeTime(exp, Date.now());
    return rel ? ('这条决定 ' + rel + ' 失效') : '等你决定';
  }
  if (kind === 'progress') {
    if (state === INTENT_STATE.PROPOSED) return '还没走到需要你决定的那一步';
    return '允许之后仍要由预算与报价自己放行';
  }
  if (kind === 'done') return '已经完成';
  /* ★ 终态里的一句关键区分（§5）：**用户已经允许了**、而这件事仍然没有
     通过 —— 那是经济侧的裁决，不是用户没点头。开发期实测踩到的一次真实
     缺陷：这一支一度什么都不说，于是"你允许了但预算没放行"与"这件事自己
     过期了"在读面上长得一样。 */
  if (appr === APPROVAL_STATUS.APPROVED) return '你已经允许了她继续，但经济侧没有放行';
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   视图模型
   ------------------------------------------------------------------
   buildView({intents, approvals, products}) → 纯数据
   三个输入都是**读面原样**的数组（或坏形状 —— 本函数对坏形状不抛）。
   ══════════════════════════════════════════════════════════════════ */
var HISTORY_LIMIT = 12;

function indexBy(list, key) {
  var map = Object.create(null);
  var rows = objectList(list);
  for (var i = 0; i < rows.length; i++) {
    var k = trimmed(rows[i][key]);
    if (k && map[k] === undefined) map[k] = rows[i];
  }
  return map;
}

function buildFacts(intent, approval, product, nowMs) {
  var facts = [];
  var expiry = finiteNumber(approval && approval.expiresAt);
  if (expiry != null && str(approval && approval.status) === APPROVAL_STATE_PENDING) {
    facts.push({ key: 'approval-expires', label: '决定有效期', value: relativeTime(expiry, nowMs) });
  }
  /* 经济裁决：读面给了才显示，且走 **AUTHORITY_FACE** 这张唯一的展示表
     —— 于是同一个词在所有地方都是同一句人话（开发期实测踩到的一次真实
     缺陷：这里一度自己拼一句"未通过"，而徽标那边说"没有通过"，同一件事
     在一张卡片上有两种说法）。 */
  var outcome = str(intent && intent.authorityOutcome);
  if (outcome != null) {
    facts.push({ key: 'authority', label: '经济裁决', value: authorityFace(outcome), code: outcome });
  }
  var authReason = str(intent && intent.authorityReasonCode) || str(intent && intent.reasonCode);
  var authReasonText = reasonText(authReason);
  if (authReasonText) facts.push({ key: 'authority-reason', label: '原因', value: authReasonText, code: authReason });
  if (str(intent && intent.purchaseId)) facts.push({ key: 'purchase', label: '结果', value: '已生成一笔购买' });
  return facts.filter(function (f) { return f.value != null; });
}

function buildItem(intent, approval, product, nowMs) {
  var eff = effectiveStatus(intent, approval);
  var face = statusFace(eff.code);
  var units = finiteNumber(intent && intent.units);
  var productName = trimmed(product && product.name) || null;
  var binding = isObject(approval && approval.binding) ? approval.binding : null;
  var amountMinor = (approval && approval.amountMinor != null)
    ? approval.amountMinor
    : (binding && binding.amountMinor != null ? binding.amountMinor : null);
  var currency = trimmed(approval && approval.currency) || trimmed(binding && binding.currency) || null;
  var recipientId = trimmed(intent && intent.recipientId);
  var selfDirected = intent && intent.selfDirected === true;

  return {
    /* ── 身份（默认**不**展示；只进技术详情）── */
    intentId: trimmed(intent && intent.agentIntentId),
    approvalId: trimmed(intent && intent.approvalId),
    productId: trimmed(intent && intent.productId),
    quoteId: trimmed(intent && intent.quoteId),
    purchaseId: trimmed(intent && intent.purchaseId),
    /* ── 角色 ── */
    agentId: trimmed(intent && intent.agentId),
    agentType: trimmed(intent && intent.agentType),
    /* ── 她想要什么 ── */
    ask: askLabel(approval && approval.quoteKind),
    productName: productName,
    productDescription: trimmed(product && product.description),
    productKind: productKindLabel(product && product.kind),
    /* 原词留给渲染层选图标：图标是**展示**，判断走的是 canonical kind。 */
    productKindRaw: trimmed(product && product.kind),
    productMissing: productName == null,
    units: units,
    reason: trimmed(intent && intent.reason),
    reasonIsAuthority: false,
    recipientId: recipientId,
    selfDirected: selfDirected,
    /* ── 权威事实（只读展示）── */
    amountMinor: amountMinor,
    amountText: amountText(amountMinor, currency),
    currency: currency,
    facts: buildFacts(intent, approval, product, nowMs),
    /* ── 状态 ── */
    statusCode: eff.code,
    statusLabel: face.label,
    statusTone: face.tone,
    statusKnown: face.known,
    statusNote: statusNote(eff.kind, intent, approval),
    kind: eff.kind,
    /* ── 排序与去重用的时间 ── */
    createdAt: finiteNumber(intent && intent.createdAt),
    updatedAt: finiteNumber(intent && intent.updatedAt) || finiteNumber(intent && intent.createdAt),
    expiredByTime: !!(approval && approval.expiredByTime === true),
    /* 由 buildView 在需要时叠上（描述**这一次操作**的结局，不是持久属性）。 */
    decisionNote: null
  };
}

function statusRank(item) {
  switch (item.statusCode) {
    case 'WAITING_APPROVAL': return 0;
    case 'PENDING': return 0;
    case 'EXECUTING': return 1;
    case 'APPROVED': return 1;
    case 'PROPOSED': return 2;
    default: return 3;
  }
}

function buildView(input, options) {
  var o = isObject(input) ? input : {};
  var opts = isObject(options) ? options : {};
  var nowMs = finiteNumber(opts.now);
  if (nowMs == null) nowMs = Date.now();
  var historyLimit = finiteNumber(opts.historyLimit);
  if (historyLimit == null) historyLimit = HISTORY_LIMIT;

  var intents = objectList(o.intents);
  var approvalIndex = indexBy(o.approvals, 'approvalId');
  var productIndex = indexBy(o.products, 'productId');

  var decisionIndex = isObject(opts.decisions) ? opts.decisions : null;

  var waiting = [];
  var history = [];
  var seen = Object.create(null);
  for (var i = 0; i < intents.length; i++) {
    var intent = intents[i];
    var intentId = trimmed(intent.agentIntentId);
    if (intentId == null || seen[intentId]) continue;
    seen[intentId] = true;
    var approvalId = trimmed(intent.approvalId);
    var approval = approvalId && approvalIndex[approvalId] ? approvalIndex[approvalId] : null;
    var productId = trimmed(intent.productId);
    var product = productId && productIndex[productId] ? productIndex[productId] : null;
    var item = buildItem(intent, approval, product, nowMs);
    /* 决定面刚给出的回答（如果有）：它描述的是**这一次操作**的结局，
       而不是一个持久属性，因此只作为备注叠上去，不覆盖 canonical 状态。 */
    if (decisionIndex && item.approvalId && decisionIndex[item.approvalId]) {
      item.decisionNote = decisionIndex[item.approvalId];
    }
    if (item.kind === 'waiting') waiting.push(item); else history.push(item);
  }
  waiting.sort(function (a, b) { return statusRank(a) - statusRank(b) || (a.createdAt || 0) - (b.createdAt || 0); });
  history.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

  return {
    waiting: waiting,
    history: history.slice(0, historyLimit),
    historyTotal: history.length,
    historyTruncated: history.length > historyLimit,
    /* 读面自己说的三句（若调用方把信封一起传进来）。 */
    counts: { intents: intents.length, approvals: objectList(o.approvals).length, products: objectList(o.products).length }
  };
}

/* ══════════════════════════════════════════════════════════════════
   请求体：恰好三个字段（§15）
   ══════════════════════════════════════════════════════════════════ */
function buildDecisionRequest(approvalId, decision, idempotencyKey) {
  var id = trimmed(approvalId);
  var word = trimmed(decision);
  var key = trimmed(idempotencyKey);
  if (id == null) return { ok: false, error: 'approval-id-required' };
  if (DECISIONS.indexOf(word) < 0) return { ok: false, error: 'decision-not-in-closed-set' };
  if (key == null) return { ok: false, error: 'idempotency-key-required' };
  /* 构造式：结果是**新**对象，键恰好是 REQUEST_KEYS 三个。 */
  var body = {
    approvalId: id,
    decision: word,
    idempotencyKey: key
  };
  return { ok: true, body: body, keys: Object.keys(body) };
}

/* 幂等键：一次用户手势 = 一个身份；重试**复用**同一个身份。
   字符集限定在 [a-z0-9-]（canonical 的幂等键只接受这一族）。 */
function newIdempotencyKey(seed) {
  var s = str(seed);
  if (s == null || s === '') s = '';
  var rand = '';
  try {
    rand = Math.random().toString(36).slice(2, 10);
  } catch (e) { rand = '00000000'; }
  var t = '';
  try { t = Date.now().toString(36); } catch (e) { t = '0'; }
  var raw = (s + '-' + t + '-' + rand).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return ('ui-' + raw).replace(/^-+|-+$/g, '').slice(0, 96);
}

/* ══════════════════════════════════════════════════════════════════
   回答归类：一次决定之后这张卡片该说什么
   ------------------------------------------------------------------
   ★ §5 的核心：APPROVED ≠ PURCHASED。
     · 决定被拒（refused）→ needAttention，卡片保持原状 + 一句原因；
     · 决定落库（decisionRecorded）→ 结论是"许可"，而**续做**的结局
       单独说：没通过就是没通过，买了就是买了，重放就是重放。
   ══════════════════════════════════════════════════════════════════ */
function classifyDecisionResponse(res) {
  if (!isObject(res)) {
    return { outcome: 'transport-error', ok: false, text: '没有收到本机节点的回答' };
  }
  if (res.ok === true && res.status !== undefined && res.status >= 400) {
    /* 极少见：信封说 ok 而传输说不 ok。按不 ok 处理。 */
    res = Object.assign({}, res, { ok: false });
  }
  if (res.ok === true && res.refused !== true) {
    var decision = str(res.decision);
    if (decision === DECISION.REJECT) {
      return {
        outcome: 'rejected', ok: true, decision: decision,
        text: '已拒绝',
        detail: '这条请求到此结束，没有产生任何经济动作。'
      };
    }
    var purchaseExists = res.purchaseExists === true;
    var continuation = str(res.continuation);
    var intentState = str(res.continuedIntentState);
    if (continuation === 'refused') {
      var cr = decisionRefusalText(res.continuationReasonCode)
        || reasonText(res.continuationReasonCode)
        || '后续步骤没有通过';
      return {
        outcome: 'approved-not-continued', ok: true, decision: decision,
        text: '已允许',
        detail: '允许之后仍要由预算与报价自己放行 —— 这一次它们没有放行：' + cr + '。你自己已经允许过了。'
      };
    }
    if (purchaseExists) {
      return {
        outcome: 'approved-completed', ok: true, decision: decision,
        text: '已允许',
        detail: res.purchaseCreatedNow === true
          ? '她这件事已经完成了。'
          : '她这件事之前就已经完成了（这一次是重放）。'
      };
    }
    if (intentState === INTENT_STATE.DENIED) {
      return {
        outcome: 'approved-not-continued', ok: true, decision: decision,
        text: '已允许',
        detail: '允许之后仍要由预算与报价自己放行 —— 这一次它们没有放行。你自己已经允许过了。'
      };
    }
    return {
      outcome: 'approved-continuing', ok: true, decision: decision,
      text: '已允许',
      detail: '已经允许她继续，结果以经济侧的裁决为准。'
    };
  }
  /* 被拒。区分"决定没落库"与"落库了但后续没通过"。 */
  var code = str(res.reasonCode);
  var downstream = str(res.downstreamReasonCode);
  var said = decisionRefusalText(code) || reasonText(code) || '这次决定没有生效';
  var because = reasonText(downstream) || decisionRefusalText(downstream);
  var recorded = res.decisionRecorded === true;
  return {
    outcome: recorded ? 'decided-but-refused' : 'refused',
    ok: false,
    decision: str(res.decision),
    reasonCode: code,
    downstreamReasonCode: downstream,
    status: finiteNumber(res.status),
    text: said,
    detail: because ? ('原因：' + because + '。') : null
  };
}

/* 决定面现在是不是开的。
   ★ 判定**不在这里**：这是 `/security` 的 `economyPolicy.approvalDecision.open`
     这一个字段的只读搬运。读不到那个字段时回答 null（= 不知道），
     而不是猜成 false —— "不知道"与"关着"在界面上是两件事。 */
function decisionGate(security) {
  var econ = isObject(security) ? security.economyPolicy : null;
  var seam = isObject(econ) ? econ.approvalDecision : null;
  if (!isObject(seam)) return null;
  return { open: seam.open === true, implemented: seam.implemented === true };
}

/* 读面加载失败的归类。transport 层已经把网络错误分类成词表里的码。 */
function classifyReadFailure(error) {
  var code = str(error);
  if (code == null) return { kind: 'unknown', text: '读取失败' };
  var t = transportText(code);
  if (t) return { kind: 'transport', code: code, text: t };
  return { kind: 'unknown', code: code, text: '读取失败（' + code + '）' };
}

NS.economyApprovalCore = Object.freeze({
  version: CORE_VERSION,
  ID: ID,
  READS: READS,
  DECISION: DECISION,
  DECISIONS: DECISIONS,
  REQUEST_KEYS: REQUEST_KEYS,
  INTENT_STATE: INTENT_STATE,
  APPROVAL_STATUS: APPROVAL_STATUS,
  AUTHORITY_OUTCOME: AUTHORITY_OUTCOME,
  QUOTE_KIND: QUOTE_KIND,
  PRODUCT_KIND: PRODUCT_KIND,
  CURRENCY_SCALE: CURRENCY_SCALE,
  CURRENCY_LABEL: CURRENCY_LABEL,
  STATUS_FACE: STATUS_FACE,
  REASON_TEXT: REASON_TEXT,
  DECISION_REFUSAL_TEXT: DECISION_REFUSAL_TEXT,
  TRANSPORT_TEXT: TRANSPORT_TEXT,
  PRODUCT_KIND_LABEL: PRODUCT_KIND_LABEL,
  HISTORY_LIMIT: HISTORY_LIMIT,
  decisionGate: decisionGate,
  isPlainObject: isPlainObject,
  escapeHtml: escapeHtml,
  formatAmount: formatAmount,
  currencyLabel: currencyLabel,
  amountText: amountText,
  relativeTime: relativeTime,
  statusFace: statusFace,
  askLabel: askLabel,
  productKindLabel: productKindLabel,
  reasonText: reasonText,
  decisionRefusalText: decisionRefusalText,
  transportText: transportText,
  authorityFace: authorityFace,
  effectiveStatus: effectiveStatus,
  buildView: buildView,
  buildDecisionRequest: buildDecisionRequest,
  newIdempotencyKey: newIdempotencyKey,
  classifyDecisionResponse: classifyDecisionResponse,
  classifyReadFailure: classifyReadFailure
});
})(window.IB || (window.IB = {}));
