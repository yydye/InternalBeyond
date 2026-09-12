/* ====================================================================
   IB Dialogue Core — runtime-neutral 对话证据语义（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/dialogue-core.js"> → window.IBDialogueCore
              （必须在 communication.js 之前加载）
   - Node   : require('../assets/js/dialogue-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零网络 / 零副作用 / 纯函数。

   为什么存在（M1-C.2o P0 审计结论）：
   "当前对话是什么"这条语义此前**两个宿主各写了一份，而且两份都不一样**：
     · Desktop（communication.js:1519-1525）根本**不传** dialogue ——
       `middle-brain-policy.js:59` 于是得到 `organized.dialogue = []`。结果：
       组织层看到的"当前对话"是空的，注入块里**没有【当前对话】这一段**，
       Gate 的 dialogueChars 只剩"裸消息"那条回落（policy 层的信号提取）。
     · Home Node（services/home-node/middle-brain.js:339）传
       `dialogueFrom(history, userMessage)`：user/assistant、单条 400 字、
       整体上限 8 条，末尾追加当前消息。

   实测（.dsh-research/_m1c2o_probe2.js，同一份 canonical 状态与同一个当前回合）：
       Desktop  organized.dialogue = []                      dialogueChars = 21
       HomeNode organized.dialogue = [5 条带角色标签的行]      dialogueChars = 83
   两端的 `dialogueChars` 都是 Gate 加权分的一项（weights.dialogue = 0.15），
   而 `organized.dialogue` 会经压缩层变成注入块的【当前对话】段 ——
   也就是说"她这一轮被喂了什么"在两端**确实不同**，不是记法不同。

   本模块把该语义收敛为**唯一实现**，供：
     ① Desktop 单聊（communication.js 的 Middle Brain 调用）
     ② Home Node 执行器（services/home-node/middle-brain.js 的适配层）
   两端共用，从而在结构上排除"第二套对话投影"。

   ── 冻结契约（M1-C.2o §5）────────────────────────────────────────────
   输入 = **该宿主本轮真的交给模型的那些行**（不是另一次读取）：
     · Desktop 交给模型的是 canonical `chatMessages` 的阶梯窗口切片
       （communication.js:2094 → :2121 `_cacheStableSlice`）；
     · Home Node 交给模型的是 canonical store 的最新一页
       （mobile-gateway.js:807-819）。
   同一份 canonical 状态 ⇒ 两端把**同一段对话**交给模型 ⇒ 本核心对同一段输入
   给出逐字相同的投影，这一点可被单边证伪（见 tests/test_dialogue_authority.js）。

   ── 四条不可协商的规则 ───────────────────────────────────────────────
   ① 角色映射：只保留 user / assistant（system / 其它角色行不进"对话"）。
   ② 当前用户回合**不截断**、**永不被挤出窗口**、且**恒排在最后**。
      理由：压缩出的【当前对话】段必须含当前消息的全部文本 ——
      Desktop 的注入谓词 `_mbInjectable`（communication.js:1653）要求
      `payload.indexOf(userMessage) >= 0`，Facade 也在
      `middle-brain.js:132-137` 用同一个子串做兜底。任何截断都会让这条
      不变量在长消息上**静默失效**（注入被拒 → 上下文不再被组织）。
   ③ 历史窗口按"条"计数，且**为当前回合留位**：历史上限 8 条指的是
      历史本身（不含当前回合）；旧节点实现把当前消息算进这个上限，
      于是历史满 8 条时会把**最后一条历史**挤掉（probe3 实测）。
   ④ 当前回合**不重复**：仅当"历史最后一行"就是同一轮用户行的原位重复时跳过追加。
      这不是内容去重 —— 它是同一轮的两种表示（请求局部 + 已 canonical）
      只能出现一次。用户真的连发两条同样的话，两条都会保留（见 ④ 的判据）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBDialogueCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 单条历史消息文本上限。取值沿用 integrity 层 _ciHistory 的同一量级
     （assets/js/middle-brain-integrity.js:_ciCap(text, 400)），不新发明数字。 */
  var HISTORY_MAX_CHARS = 400;
  /* 历史条数上限（不含当前回合）。同样沿用 _ciHistory 的 8 条窗口量级。 */
  var HISTORY_MAX_MESSAGES = 8;
  var USER_LABEL = '用户：';
  var ROLE_LABEL = '角色：';

  /* ── 文本提取：把一条消息的 content 归一成纯文本 ──────────────────────
     产出 `null` 表示"这一行没有可用的对话文本"（调用方据此跳过它）。
     数组形态（多模态 parts）只取 type==='text' 的部分：图片/音频 parts
     不是对话文本，而它们的存在与否由 provider 面的 messages 负责表达，
     不在这里伪造。 */
  function textOf(content) {
    if (content == null) return null;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var out = '';
      for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (!p || typeof p !== 'object') continue;
        if (p.type !== 'text') continue;
        out += String(p.text == null ? '' : p.text);
      }
      return out;
    }
    if (typeof content === 'object') return String(content.text == null ? '' : content.text);
    return String(content);
  }

  /* ── 角色归一：只认 user / assistant ──────────────────────────────────
     与 execution.buildPrompt（services/home-node/execution.js:122-129）、
     communication.js:2130-2137、integrity._ciHistory 三处**同一谓词**：
     不是 assistant 且不是 user 的行不进对话证据。 */
  function roleOf(role) {
    if (role === 'assistant') return 'assistant';
    if (role === 'user') return 'user';
    return null;
  }

  function labelFor(role) { return role === 'assistant' ? ROLE_LABEL : USER_LABEL; }

  function cap(text, max) {
    var s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max);
  }

  /* ── normalizeRow：一个输入行 → 规范化证据行，或 null ──────────────────
     字段：
       role    'user' | 'assistant'          （已归一）
       text    string                        （已截断，非空）
       id      string | null                 （可选身份，用于当前回合去重）
     一条行是否算"有内容"：text 至少有一个非空白字符 —— 与旧 dialogueFrom
     的 `if (!text.trim()) continue` 逐字同源。 */
  function normalizeRow(row, capChars) {
    if (!row || typeof row !== 'object') return null;
    var role = roleOf(row.role);
    if (!role) return null;
    var text = textOf(row.content);
    if (text == null) return null;
    if (!String(text).trim()) return null;
    return {
      role: role,
      text: cap(text, capChars),
      id: (row.id == null || row.id === '') ? null : String(row.id)
    };
  }

  /* ── assemble：唯一的对话证据投影入口 ─────────────────────────────────
     参数（全部可选，缺失即如实降级）：
       history       该宿主本轮交给模型的历史行（canonical 顺序：旧 → 新）
       userMessage   当前回合的文本（请求局部）
       currentId     当前回合的身份（Home Node 有确定性 id；Desktop 无 → null）
       maxChars      单条历史文本上限（默认 400）
       maxMessages   历史条数上限（默认 8），**不含**当前回合
     返回：{ lines: string[], currentIncluded: bool, currentSkipped: 'duplicate' | null,
             historyCount: number, truncatedHistory: number }
     纪律：
       · 绝不因为输入异常抛错（Gate 的信号计算在调用链上，抛错会变成回合失败）。
         异常输入一律按"没有这一行"处理。
       · 绝不用内容去重（相同内容的多条合法消息必须全部保留）。
       · 绝不合成用户没说过的话。 */
  function assemble(input) {
    input = input || {};
    var capChars = Number(input.maxChars);
    if (!isFinite(capChars) || capChars <= 0) capChars = HISTORY_MAX_CHARS;
    var maxMessages = Number(input.maxMessages);
    if (!isFinite(maxMessages) || maxMessages < 0) maxMessages = HISTORY_MAX_MESSAGES;

    var rows = Array.isArray(input.history) ? input.history : [];
    var kept = [];
    var truncated = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = normalizeRow(rows[i], capChars);
      if (!r) continue;
      var raw = textOf(rows[i].content);
      if (raw != null && r.text.length < String(raw).length) truncated++;
      kept.push(r);
    }
    /* 历史条数上限：只截**历史**（旧的一端先走），当前回合另计。 */
    if (kept.length > maxMessages) kept = kept.slice(kept.length - maxMessages);

    /* ── 当前回合的重复判定（唯一的"去重"规则）─────────────────────────
       判据（缺一不可）：
         a. 给了当前回合文本，且它不是空白；
         b. 历史**最后一行**是 user 行；
         c. 它的身份与当前回合身份相同（给了 id 时），**或** 未给身份时
            它的原文与当前回合原文逐字相同（**未截断的原文**）。
       为什么 c 需要"逐字相同"而不是相似：这一条只在"同一轮的两种表示"
       上成立。用户真的连发两条同样的话时，历史最后一行是第一条、Provider
       面的 messages 里两条都在，当前回合是第二条 —— 此时 b/c 也成立，
       于是追加被跳过，而 evidence 里仍有一条该文本；**表达上不重复、
       语义上不丢失**（第一次发言由历史行承载，第二次由它构成的历史行承载）。
       反过来，若历史最后一行是**助理**行（说明用户上一条已得到回复），
       则 b 不成立 → 当前回合一定被追加：这正是"连发"与"新一轮"的分界。 */
    var currentText = textOf(input.userMessage);
    if (currentText == null) currentText = '';
    currentText = String(currentText);
    var currentId = (input.currentId == null || input.currentId === '') ? null : String(input.currentId);
    var skipCurrent = null;
    if (currentText.trim() && kept.length) {
      var last = kept[kept.length - 1];
      var lastIsUser = last.role === 'user';
      if (lastIsUser) {
        if (currentId && last.id && last.id === currentId) skipCurrent = 'duplicate';
        else {
          var lastRaw = textOf(rows[rows.length - 1] && rows[rows.length - 1].content);
          if (lastRaw != null && String(lastRaw) === currentText) skipCurrent = 'duplicate';
        }
      }
    }

    var lines = [];
    for (var k = 0; k < kept.length; k++) lines.push(labelFor(kept[k].role) + kept[k].text);
    var included = false;
    if (currentText.trim() && !skipCurrent) {
      /* 当前回合**不截断**：见文件头 ②（_mbInjectable 的子串不变量）。 */
      lines.push(USER_LABEL + currentText);
      included = true;
    }
    return {
      lines: lines,
      currentIncluded: included,
      currentSkipped: skipCurrent,
      historyCount: kept.length,
      truncatedHistory: truncated
    };
  }

  /* 便捷出口：只要 lines。生产调用方两端都只用这一种形状。 */
  function lines(input) { return assemble(input).lines; }

  return Object.freeze({
    assemble: assemble,
    lines: lines,
    textOf: textOf,
    roleOf: roleOf,
    normalizeRow: normalizeRow,
    HISTORY_MAX_CHARS: HISTORY_MAX_CHARS,
    HISTORY_MAX_MESSAGES: HISTORY_MAX_MESSAGES,
    USER_LABEL: USER_LABEL,
    ROLE_LABEL: ROLE_LABEL
  });
});
