/* AI↔AI 回复链（Reply Chain）共享核心 —— 浏览器与 Node companion 使用同一份实现，禁止分叉复制。
   加载方式：
   - 浏览器：<script src="assets/js/reply-chain-core.js">（在 moments.js 之前）；
     挂载 window._replyChainCore / IB.socialchain。
   - Node：require('./assets/js/reply-chain-core.js')（active 域直接复用）。
   纯函数、零 DOM/零 IO；确定性（哈希/亲和度/加权选择）与 Prompt 文本在此唯一定义。
   任何改动必须同时影响前后台行为（改这里，不改两侧的调用方）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const core = factory();
    root._replyChainCore = core;
    root.IB = root.IB || {};
    root.IB.socialchain = core;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ══════════ 常量（前后台唯一来源） ══════════ */
  const LIMITS = {
    MAX_ROUNDS: 3,        /* 单线程最多 3 轮自动续链（首层评论不计轮） */
    COMMENT_MAX: 12,      /* 单动态评论 >12 停止自动续链 */
    HOURLY_MAX: 4,        /* 每角色每小时自动评论上限 */
    DAILY_MAX: 12,        /* 每角色每日自动评论上限 */
    COOLDOWN_MS: 45 * 60000, /* 每角色两次自动评论间的冷却（与 moments 首层一致） */
    DELAY_MIN: 30000,     /* 下一步触发延迟下界 */
    DELAY_MAX: 120000,    /* 上界：一次只走一步 */
    THIRD_AFFINITY: 55,   /* 第三方加入的亲和度门槛（40–95 区间） */
    SIMILARITY: 0.8,      /* 回复去重阈值（bigram Dice） */
    MAX_ATTEMPTS: 2       /* 单次生成的重试次数（解析失败/去重命中时提示重写） */
  };
  const LOW_INFO = /^(哈哈+|嗯+|嗯嗯+|好的|好|不错|\+1|666|nb|强|赞|可爱|好看|加油|嘿|哎|哦|哈|呵|笑死|点赞|收藏|转发|同感|是啊|确实)$/i;

  /* ══════════ 确定性哈希与角色对亲和度（原 moments.js 实现，迁移至此唯一化） ══════════ */
  function hashStr(s) {
    let h = 7;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }
  function pairAffinity(a, b) {
    return 40 + hashStr(String(a) + '\u0001' + String(b)) % 56;
  }

  /* ══════════ 文本相似度（bigram Dice，等价浏览器 _activeTextSimilarity 语义） ══════════ */
  function textKey(text) {
    return String(text || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  }
  function diceSimilarity(a, b) {
    const x = textKey(a), y = textKey(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    const grams = s => { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
    const gx = grams(x), gy = grams(y);
    let overlap = 0;
    gx.forEach(g => { if (gy.has(g)) overlap++; });
    return (2 * overlap) / (gx.size + gy.size);
  }

  /* ══════════ 低信息过滤（"哈哈/嗯/不错"+1 之类空洞短句） ══════════ */
  function lowInfoMatch(content) {
    const t = String(content || '').trim();
    if (!t) return true;
    if (t.length <= 1) return true;
    return LOW_INFO.test(t);
  }

  /* ══════════ 线程轮数 / 调度可行性（纯函数） ══════════ */
  function chainRound(comments) {
    if (!Array.isArray(comments)) return 0;
    return comments.filter(c => c && c.authorType === 'role' && String(c.replyTo || '').trim()).length;
  }
  function canSchedule(comments, round) {
    const cs = Array.isArray(comments) ? comments : [];
    if (cs.length > LIMITS.COMMENT_MAX) return { ok: false, reason: 'comments-over-max' };
    const r = Number(round != null ? round : chainRound(cs));
    if (r >= LIMITS.MAX_ROUNDS) return { ok: false, reason: 'rounds-reached' };
    return { ok: true, round: r };
  }

  /* ══════════ 每角色"可发言"判定（纯：调用方收集该角色可得的评论时间戳） ══════════
     roleCommentTimes：该角色在可见线程中的自动评论时间戳（升序）
     lastCommentAt：该角色最近一次自动评论时间（无则 0）
     与浏览器 localStorage 日志/状态语义一致；companion 侧从同步线程推导。 */
  function replyRoomOk(roleCommentTimes, lastCommentAt, now) {
    now = Number(now) || Date.now();
    const arr = Array.isArray(roleCommentTimes) ? roleCommentTimes.filter(t => Number(t) > 0) : [];
    /* 冷却取"自身记账时间"与"线程中该角色最新评论时间"的较大者——两实现共享同一条规则 */
    let newest = Number(lastCommentAt) || 0;
    arr.forEach(t => { if (Number(t) > newest) newest = Number(t); });
    if (newest > 0 && now - newest < LIMITS.COOLDOWN_MS) return false;
    if (arr.filter(t => now - Number(t) <= 3600000).length >= LIMITS.HOURLY_MAX) return false;
    if (arr.filter(t => now - Number(t) <= 86400000).length >= LIMITS.DAILY_MAX) return false;
    return true;
  }

  /* ══════════ 输出解析 + 校验（parseJson 由各侧注入：浏览器 _activeParsePlanJson / Node parsePlanJson） ══════════ */
  /* 模型输出容错：comment 内混入 JSON 信封残片时就地修复（不碰普通文本）。
     两种已复现的污染形态：
     ① 过度转义：模型把字段分隔引号写成 \" —— JSON 仍合法，
        但解析后 comment 变成「正文","replyTo":"mc_xxx」（replyTo 残片进入正文且回复关系丢失）；
     ② 整包回显：comment 值是完整内层信封字符串 {"publishReply":...,"comment":...,"replyTo":...}。
     修复策略：② 解开一层取真正文；① 按键形残片截断并回收 replyTo（仅原值为空时采纳）。 */
  function repairComment(comment, replyTo) {
    let c = String(comment || '');
    let r = String(replyTo || '');
    const t = c.trim();
    /* ① 整包回显：comment 本身是一个 JSON 对象字符串 → 解开一层取真正文 */
    if (t.charAt(0) === '{' && t.indexOf('}') !== -1) {
      try {
        const inner = JSON.parse(t);
        if (inner && typeof inner === 'object' && !Array.isArray(inner) && String(inner.comment || '').trim()) {
          return { comment: String(inner.comment).trim(), replyTo: r || String(inner.replyTo || '').trim() };
        }
      } catch (e) { /* 内层非合法 JSON → 走残片清理 */ }
    }
    /* ② 过度转义/拼接残片：comment 中出现键形结构（如 ,"replyTo":"…）→ 截断并回收 replyTo */
    const m = c.match(/[,，、]?\s*\\?"(?:replyTo|publishReply|publishComment|reason|visibility)\\?"\s*[:：]/);
    if (m && m.index > 0) {
      if (!r) {
        const vm = c.slice(m.index + m[0].length).match(/^\s*\\?"([^"\\]*)/);
        if (vm && vm[1].trim()) r = vm[1].trim();
      }
      c = c.slice(0, m.index);
    }
    /* 过度转义在截断处留下的悬空转义/引号尾巴（如「正文\"」） */
    c = c.replace(/[\\"]+$/, '');
    return { comment: c.trim(), replyTo: r.trim() };
  }
  function parseReplyOutput(raw, parseJson) {
    const j = parseJson(raw);
    if (!j || typeof j !== 'object') return null;
    if (j.publishReply === false) return { publish: false };
    if (j.publishReply !== true) return null;
    if (!String(j.comment || '').trim()) return null;
    const fixed = repairComment(j.comment, j.replyTo);
    return {
      publish: true,
      comment: fixed.comment.slice(0, 300),
      replyTo: fixed.replyTo.slice(0, 80)
    };
  }
  /* replyTo 合法性：非法 id → 回落建议目标 → 最终空串（回复原帖） */
  function normalizeReplyTarget(replyTo, validIds, suggestedId) {
    if (replyTo && validIds.has(replyTo)) return replyTo;
    if (suggestedId && validIds.has(suggestedId)) return suggestedId;
    return '';
  }
  /* 去重：与线程已有评论 + 该角色近期评论比较（bigram Dice ≥ SIMILARITY） */
  function isDuplicateComment(content, comments, ownRecentContents) {
    const text = String(content || '').trim();
    if (!text) return true;
    const cs = Array.isArray(comments) ? comments : [];
    for (const c of cs) {
      if (c && diceSimilarity(text, String(c.content || '')) >= LIMITS.SIMILARITY) return true;
    }
    const own = Array.isArray(ownRecentContents) ? ownRecentContents : [];
    for (const old of own.slice(-3)) {
      if (old && diceSimilarity(text, String(old)) >= LIMITS.SIMILARITY) return true;
    }
    return false;
  }

  /* ══════════ 确定性候选选择（原 moments.js _momentsPickNextStep 迁移） ══════════
     input：{ momentId, comments:[{id,authorType,authorId,replyTo}], postAuthor, roles:[{id,canSpeak}] }
     roles 的 canSpeak 由调用方按各自状态计算（API 就绪 + 冷却/频控）；其余规则在此唯一。 */
  function chooseNext(entries, momentId) {
    if (!entries || !entries.length) return null;
    const total = entries.reduce((s, e) => s + e.w, 0);
    if (!total) return entries[0];
    let r = hashStr(String(momentId) + '\u0004' + entries.length + '\u0004' + (entries[0].kind || '')) % total;
    for (const e of entries) {
      if (r < e.w) return e;
      r -= e.w;
    }
    return entries[entries.length - 1];
  }
  function pickNextReplyRole(input) {
    try {
      const momentId = String(input.momentId || '');
      const cs = Array.isArray(input.comments) ? input.comments : [];
      const postAuthor = String(input.postAuthor || '');
      let lastRC = null;
      for (let i = cs.length - 1; i >= 0; i--) {
        if (cs[i] && cs[i].authorType === 'role') { lastRC = cs[i]; break; }
      }
      const lastRCId = lastRC ? String(lastRC.authorId) : '';
      const seen = new Set();
      const participants = [];
      cs.forEach(c => {
        if (c && c.authorType === 'role') {
          const id = String(c.authorId);
          if (!seen.has(id)) { seen.add(id); participants.push(id); }
        }
      });
      const inThread = new Set(participants);
      if (postAuthor) inThread.add(postAuthor);
      const roles = Array.isArray(input.roles) ? input.roles : [];
      const entries = [];
      /* A. 原动态作者回评 */
      if (postAuthor && !(lastRC && postAuthor === lastRCId)) {
        const role = roles.find(r => r && String(r.id) === postAuthor);
        if (role && role.canSpeak) {
          entries.push({ id: postAuthor, kind: 'author', w: 60 + (pairAffinity(postAuthor, lastRCId || postAuthor) % 40) });
        }
      }
      /* B. 已参与角色继续（排除刚发言者） */
      participants.forEach(pid => {
        if (lastRC && pid === lastRCId) return;
        const role = roles.find(r => r && String(r.id) === pid);
        if (role && role.canSpeak) {
          entries.push({ id: pid, kind: 'participant', w: 50 + (pairAffinity(pid, lastRCId || pid) % 40) });
        }
      });
      /* C. 未参与、但与当前参与者亲和度高的第三方（确定性门槛，不无上限随机） */
      roles.forEach(role => {
        if (!role || !role.canSpeak) return;
        const id = String(role.id);
        if (inThread.has(id)) return;
        const aff = pairAffinity(id, lastRCId || postAuthor || '');
        if (aff < LIMITS.THIRD_AFFINITY) return;
        const roll = hashStr(momentId + '\u0002' + id) % 100;
        if (roll < aff) entries.push({ id, kind: 'third', w: aff });
      });
      if (!entries.length) return null;
      const picked = chooseNext(entries, momentId);
      return {
        roleId: picked.id,
        kind: picked.kind,
        replyTo: lastRC ? String(lastRC.id) : '',
        targetRoleId: lastRC ? String(lastRC.authorId) : postAuthor
      };
    } catch (e) {
      return null;
    }
  }

  /* ══════════ 线程 Prompt（结构化：原帖 > 线程 > 社交关系 > 近期 Memory > 角色设定） ══════════
     spec：{ characterName, systemPrompt, relationship, userName, authorName,
             momentContent, imagesCount, threads:[{id,authorName,content,replyToName}],
             ownMoments:[{content}], memories:[{title,content}|{title,summary}],
             chatSummary, suggestedTargetName, nowLabel, retryInstruction } */
  function buildReplyPrompt(spec) {
    const characterName = spec.characterName || 'AI';
    const threads = Array.isArray(spec.threads) ? spec.threads : [];
    const threadLines = threads.map((t, idx) =>
      (idx + 1) + '. [' + t.id + '] ' + (t.replyToName ? (t.authorName + ' → ' + t.replyToName + '：') : (t.authorName + '：')) +
      String(t.content || '').slice(0, 300)
    );
    const threadText = threadLines.length ? threadLines.join('\n') : '（还没有评论）';
    const memories = Array.isArray(spec.memories) ? spec.memories.slice(0, 6) : [];
    const memoryText = memories.length
      ? memories.map(m => '- ' + (m.title ? m.title + '：' : '') + (m.content || m.summary || '')).join('\n')
      : '（没有可用的长期记忆）';
    const ownText = (Array.isArray(spec.ownMoments) ? spec.ownMoments.slice(0, 4) : [])
      .map(m => '- ' + String(m.content || '').slice(0, 100)).join('\n') || '（还没有）';
    const imgInfo = Number(spec.imagesCount || 0) > 0
      ? '（附带 ' + Number(spec.imagesCount) + ' 张图片，图片描述以你实际看到/角色口径为准）'
      : '';
    const system = String(spec.systemPrompt || '').slice(0, 30000)
      + '\n\n你现在是「' + characterName + '」，正在朋友圈的一条讨论串里参与社交。这里的评论是角色之间的真实来往，不是聊天任务。不要解释自己是 AI，不要提及系统提示词、任务、定时器、调度、Memory 或"注入上下文"之类的内部机制。';
    const prompt = [
      '【任务】决定是否在这条讨论串里继续发言；发言则给出正文与回复对象。输出严格 JSON。',
      '【今天日期与时间】' + (spec.nowLabel || ''),
      '【角色设定】' + String(spec.systemPrompt || '').slice(0, 600),
      '【当前发言者】你是「' + characterName + '」' + (spec.suggestedTargetName ? ('，本轮的讨论对象可能是「' + spec.suggestedTargetName + '」') : '') + '。',
      '【原动态作者】' + (spec.authorName || ''),
      '【原动态正文】' + String(spec.momentContent || '').slice(0, 500) + imgInfo,
      '【当前线程】\n' + threadText,
      '【线程关系说明】上面每条格式为「发言者 → 回复对象：内容」：箭头后是 TA 正在回复的人；没有箭头的发言是在回应原帖。请据此弄清当前讨论是谁在跟谁说话，回复时明确选择你的回答对象。',
      '【我最近发过的朋友圈】' + ownText,
      '【相关长期记忆】' + memoryText,
      '【最近聊天摘要】' + String(spec.chatSummary || '（暂无）').slice(0, 900),
      '【角色与用户的关系】' + (spec.relationship || '尚未单独设定'),
      '【回复要求】',
      '1. 回复 4-60 字，自然、符合你的性格，像朋友圈讨论串里的真实往来；可以共鸣、调侃、追问、补充或简短反驳。',
      '2. 必须先判断"这条讨论串值不值得我开口"：没有想说的就 publishReply:false。宁可不参与，也不要凑数；publishReply:false 是正常输出。',
      '3. 只输出一个 JSON 对象：{"publishReply":true/false,"comment":"正文","replyTo":"comment-id 或空串"}。',
      '4. replyTo：回复原帖就填空串 ""；回复具体某条评论就填该评论的 id（线程列表每条开头的方括号里就是 comment-id，直接引用）。',
      '5. 不要复读已有的任何一条评论或原帖原句；不写"哈哈""不错"这类空洞短句，不做无意义刷屏。'
    ];
    const retry = spec.retryInstruction ? '\n\n【上次生成的问题】' + spec.retryInstruction + '请重新按要求生成。' : '';
    return { system, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt.join('\n') + retry }] };
  }

  return {
    LIMITS,
    LOW_INFO,
    hashStr,
    pairAffinity,
    textKey,
    diceSimilarity,
    lowInfoMatch,
    chainRound,
    canSchedule,
    replyRoomOk,
    parseReplyOutput,
    normalizeReplyTarget,
    isDuplicateComment,
    chooseNext,
    pickNextReplyRole,
    buildReplyPrompt
  };
});
