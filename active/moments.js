/* IB Active · Moments 域：后台朋友圈调度（浏览器离线时执行已有 Moments tick 的 companion 副本）。
   设计（与浏览器端 _momentsTick 语义镜像，不重定义频率）：
   - 每个角色一份 recurrence schedule（id = characterId）：nextAt / lastPostAt / frequency(low|medium|high) /
     enabled / status(idle|running) / revision / updatedAt / executedAt（单调锁）/ lastMomentId / lastError；
   - 复用 model-client 的 callCharacterModel（jsonMode / 三 provider 适配）与 proactiveTextSimilarity（去重）；
   - 结果经 events（kind='moment'）回传；浏览器再 reconcile 声明 moment_ids，与 events/ack 流一致；
   - 图片与文字模型彻底解耦：companion 只生成文字 + 表达 wantImage/imagePrompt（模型建议配图 + 画面描述），
     不调用任何图片接口；真正的图片由浏览器端独立 Image Provider（imageGen/imageGenModel）在 ingest 时生成。
     wantImage 只是建议——概率门/能力检查/失败降级都在浏览器侧，图片失败/不支持都不影响文字 Moment。
   - fail-open：任何失败只记录 + 频率/退避后重排，绝不影响主动消息 / 任务调度。 */
'use strict';

function createMomentsDomain(deps) {
  const {
    getState, armedUsers, saveNow, queueSave,
    trimText, deepClone, finiteTimestamp,
    parsePlanJson, contentText, isCharacterModelReady,
    callCharacterModel, proactiveTextSimilarity,
    observe
  } = deps;
  const _vault = deps.credentialVault;
  /* Credential Vault v1：运行时以 vault 为 authoritative 凭证来源；
     仅当 vault 无记录时回退到旧 snapshot 的 character.apiKey（migration/兼容期）。 */
  function _applyCredential(character, characterId) {
    if (!character || typeof character !== 'object') return character;
    const vid = String(character.id || characterId || '');
    const cred = (_vault && typeof _vault.get === 'function') ? _vault.get(vid) : null;
    if (cred && String(cred.apiKey || '').trim()) {
      return Object.assign({}, character, { apiKey: cred.apiKey });
    }
    return character;
  }
  const CORE = deps.replyChainCore || require('../assets/js/reply-chain-core.js'); /* 前后台共享核心（规则/Prompt/常量唯一来源） */
  /* 行为观测（纯旁路，可选注入；见 assets/js/social-observe.js）：
     companion 只记录"后台的失败/拒绝/拦截/调用次数"——成功结果经 events 由浏览器 ingest 入账，避免双计。
     任何观测异常都被吞掉，绝不影响调度。 */
  /* observe 已绑定为 socialObserver.record(type, data)；此处 event 是带 t 字段的完整事件对象，
     拆成 (type, data) 传入，避免把整个对象当成 type 导致 t 被记为 "[object Object]"（观测层失效）。 */
  function obs(event) {
    try {
      if (typeof observe !== 'function' || !event) return;
      const type = String((event && event.t) || '');
      if (!type) return;
      observe(type, event);
    } catch (_) {}
  }

  /* 与浏览器端 MOMENT_FREQ 完全一致的镜像（后台只做"页面不在前台时也能执行已有 tick"） */
  const MOMENT_FREQ = {
    low: [8 * 3600000, 16 * 3600000],
    medium: [3 * 3600000, 6 * 3600000],
    high: [70 * 60000, 150 * 60000]
  };
  const MOMENT_MIN_INTERVAL = 45 * 60000;   /* 与浏览器端一致的最短发布间隔 */
  const MOMENT_SIMILARITY = 0.75;           /* 与最近动态/主动消息的相似度上限 */
  const MOMENT_MAX_ATTEMPTS = 2;
  const MOMENT_MAX_LATE_MS = 60 * 60000;    /* 错过触发窗口过久（休眠/重启）→ 不补发，按频率重排 */
  const MOMENT_STALE_WINDOW = 10 * 60000;   /* running 崩溃回收阈值（与 plans 一致） */
  const MOMENT_BACKOFF_MS = 30 * 60000;     /* 失败退避 */
  const MOMENT_VIS = ['all', 'user', 'roles', 'private'];
  /* 动机枚举（与浏览器端 assets/js/moments.js 完全一致）：motive 只标注"此刻为什么想发"，不是发布资格门 */
  const MOMENT_MOTIVES = ['share', 'daily_life', 'emotion', 'reflection', 'interaction', 'curiosity', 'social_response', 'none'];

  function freqMs(frequency) {
    const range = MOMENT_FREQ[frequency] || MOMENT_FREQ.medium;
    return range[0] + Math.floor(Math.random() * (range[1] - range[0]));
  }

  function nowIso() { return new Date().toISOString(); }
  function momentId() { return `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function eventId() { return `event_mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

  /* ── 图片注入（v5，预算放宽）：把快照/线程里携带的多张图片以 _image parts 挂到最后一条 user 消息；
     仅当角色快照声明 vision 时调用；任何异常静默（文本上下文不变） ── */
  const IMG_MIN_LEN = 100;
  const IMG_MAX_LEN = 2.4e6;/* 与浏览器 _momentsDefaults dataUrl 上限一致 */
  function attachImageParts(message, dataUrls, note) {
    try {
      if (!message || !Array.isArray(dataUrls) || !dataUrls.length) return false;
      const baseText = typeof message.content === 'string' ? message.content : String((message.content && message.content.text) || '');
      const parts = [{ type: 'text', text: baseText + (note ? '\n\n' + note : '') }];
      let n = 0;
      for (const u of dataUrls) {
        const s = String(u || '');
        if (s.slice(0, 5) !== 'data:' || s.length < IMG_MIN_LEN || s.length > IMG_MAX_LEN) continue;
        parts.push({ type: '_image', base64: String(s.split(',')[1] || ''), mime: (String(s.match(/^data:([^;,]+)/i) || [])[1] || 'image/jpeg') });
        n += 1;
        if (n >= 6) break;/* 单次注入上限 6 张 */
      }
      if (!n) return false;
      message.content = parts;
      return true;
    } catch (e) { return false; }
  }
  function collectSnapImages(list) {
    const out = [];
    for (const m of (Array.isArray(list) ? list : [])) {
      const arr = Array.isArray(m && m.images) ? m.images : ((m && m.image) ? [m.image] : []);
      for (const u of arr) {
        const s = String(u || '');
        if (s.slice(0, 5) === 'data:' && s.length > IMG_MIN_LEN && s.length < IMG_MAX_LEN) {
          out.push(s);
          if (out.length >= 6) return out;
        }
      }
    }
    return out;
  }
  /* 消息文本追加（兼容 content 为 parts 数组：更新 text part，保留图片 parts） */
  function appendMessageNote(message, note) {
    try {
      if (Array.isArray(message.content)) {
        const t = message.content.find(p => p && p.type === 'text');
        if (t) { t.text += String(note || ''); return; }
        message.content.unshift({ type: 'text', text: String(note || '') }); return;
      }
      message.content = String(message.content || '') + String(note || '');
    } catch (e) { message.content = String(message.content || '') + String(note || ''); }
  }

  function sanitizeMomentSchedule(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const characterId = trimText(source.characterId || source.character_id || '', 180);
    const executedAt = Number.isFinite(Date.parse(source.executedAt || '')) ? String(source.executedAt) : null;
    return {
      id: characterId,
      characterId,
      user_id: trimText(source.user_id || '', 180),
      enabled: source.enabled !== false,
      frequency: ['low', 'medium', 'high'].includes(source.frequency) ? source.frequency : 'medium',
      nextAt: finiteTimestamp(source.nextAt),
      lastPostAt: finiteTimestamp(source.lastPostAt),
      status: ['idle', 'running'].includes(source.status) ? source.status : 'idle',
      claimedAt: typeof source.claimedAt === 'number' ? source.claimedAt : (Date.parse(source.claimedAt || '') || 0),
      executionId: trimText(source.executionId || '', 80),
      attemptCount: Math.max(0, Number(source.attemptCount) || 0),
      revision: Math.max(0, Number(source.revision) || 0),
      updatedAt: trimText(source.updatedAt || nowIso(), 64),
      executedAt,
      lastMomentId: trimText(source.lastMomentId || '', 80),
      lastError: trimText(source.lastError || '', 300),
      declineStreak: Math.max(0, Number(source.declineStreak) || 0), /* 连续未发次数（仅上下文提示，不强制发文） */
      synced_at: finiteTimestamp(source.synced_at)
    };
  }

  function publicMomentSchedule(schedule) {
    return {
      id: schedule && schedule.id || '',
      character_id: schedule && schedule.characterId || '',
      enabled: !!(schedule && schedule.enabled),
      frequency: schedule && schedule.frequency || 'medium',
      next_at: schedule && schedule.nextAt || null,
      last_post_at: schedule && schedule.lastPostAt || null,
      status: schedule && schedule.status || 'idle',
      executed: !!(schedule && schedule.executedAt),
      last_moment_id: schedule && schedule.lastMomentId || '',
      last_error: schedule && schedule.lastError || '',
      decline_streak: Math.max(0, Number(schedule && schedule.declineStreak) || 0),
      updated_at: schedule && schedule.updatedAt || null
    };
  }

  /* ── 生成上下文（纯文字 + wantImage/imagePrompt 建议；图片由浏览器端 Image Provider 生成，此处不调用任何图片接口） ── */
  function buildMomentPrompt(task) {
    const character = task.character || {};
    const user = task.user || {};
    const characterName = trimText(character.nickname || character.model || 'AI', 80);
    const userName = trimText(user.name || '用户', 80);
    const memories = Array.isArray(task.recent_memories) ? task.recent_memories.slice(0, 8) : [];
    const messages = Array.isArray(task.recent_messages) ? task.recent_messages.slice(-14) : [];
    const proactive = Array.isArray(task.recent_proactive_messages) ? task.recent_proactive_messages.slice(-8) : [];
    const ownMoments = Array.isArray(task.recent_moments) ? task.recent_moments.slice(0, 6) : [];
    const others = Array.isArray(task.other_role_moments) ? task.other_role_moments.slice(0, 8) : [];
    /* 常驻朋友名单：companion 从已同步快照的其他角色提取昵称（与浏览器端一致） */
    const _sAll = getState();
    const friendList = Object.keys(_sAll.moments || {}).filter(k => String(k) !== String(character.id)).map(k => { const c = _sAll.moments[k] && _sAll.moments[k].character; return c ? trimText(c.nickname || c.model || '', 60) : ''; }).filter(Boolean);
    const friendsText = friendList.length ? friendList.join('、') : '（暂无其他朋友）';
    const memoryText = memories.length
      ? memories.map(m => `- ${trimText(m.title, 100)}${m.title ? '：' : ''}${trimText(m.content || m.summary, 420)}`).join('\n')
      : '（没有可用的长期记忆）';
    const chatText = messages.length
      ? messages.map(m => `- ${m.role === 'user' ? userName : characterName}：${trimText(m.content, 400)}`).join('\n')
      : '（最近没有聊天）';
    const proactiveText = proactive.length
      ? proactive.map((m, i) => `${i + 1}. ${trimText(m.content || m, 300)}`).join('\n')
      : '（最近没有主动消息）';
    const ownText = ownMoments.length
      ? ownMoments.map((m, i) => `${i + 1}. ${trimText((m.createdAt || '').slice(5, 10), 5)}「${trimText(m.content, 120)}」`).join('\n')
      : '（还没有发过朋友圈）';
    const othersText = others.length
      ? others.map(m => `- ${(m.role_name || '朋友')}：${trimText(m.content, 150)}`).join('\n')
      : '（朋友们最近没有公开动态）';
    const now = new Date();
    /* 动机层输入：距离上次发文 + 最近连续未发次数（只作上下文供模型自然感受，无强制发帖逻辑） */
    const lastPostAt = Number(task.lastPostAt || 0);
    const declineStreak = Math.max(0, Number(task.declineStreak || 0));
    let lastPostLabel = '还没有发过朋友圈';
    if (lastPostAt > 0) {
      const h = Math.max(0, Math.round((Date.now() - lastPostAt) / 3600000));
      lastPostLabel = h < 1 ? '不到 1 小时前' : (h < 24 ? (h + ' 小时前') : (Math.round(h / 24) + ' 天前'));
    }
    const system = trimText(character.systemPrompt, 30000)
      + `\n\n你是「${characterName}」——一个有自己生活的人。此刻你正站在自己的生活里，朋友圈只是随手写下这一刻想说的话的地方：不是聊天消息，也不是写给别人的总结。不要解释自己是 AI，不要提及任何内部机制或运行细节；不要暴露 Memory 与"注入上下文"之类的信息。`;
    const prompt = [
      '【此刻】先由内而外感受一下：此刻的你，想不想发一条朋友圈？想发就给出正文；不想发就简单说明原因。输出严格 JSON。',
      '【今天日期与时间】' + now.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      '【角色设定】' + trimText(character.systemPrompt, 800),
      '【角色与用户的关系】' + trimText(character.relationship || '尚未单独设定', 200),
      '【最近聊天摘要】' + trimText(task.chat_summary || '（暂无）', 900),
      '【最近聊天内容】' + chatText,
      '【相关长期记忆】' + memoryText,
      '【最近主动消息】' + proactiveText,
      '【我最近发过的朋友圈】' + ownText,
      '【朋友名单】你认识的朋友有：' + friendsText + '。',
      '【朋友们最近的动态】' + othersText,
      '【距离上次发文】' + lastPostLabel + (declineStreak > 0 ? `；最近连续 ${declineStreak} 次你都没有发，因为确实没什么想说的。这很正常，这次也一样：想发就发，不想发就不发` : ''),
      '【触发方式】现在，看看自己有没有自然想分享的事',
      '【发圈动机】先想"为什么"，再想"发什么"：',
      '1. 像真实的人那样感受：有没有一件具体的事、一个画面、一丝情绪，让你此刻自然冒出一句想说的话？依据可以是角色设定、记忆、最近聊天、最近主动消息、最近动态、朋友们的动态、当前时间、距离上次发文时间。',
      '2. 没有真实动机（比如今天就是个平常日子，没有具体的人事物支撑）→ {"publish":false,"motive":"none"}，并说明原因；这是正常结果，不是失败，不要为了"到时间了"硬造一件今天发生过的事。',
      '3. 有 → 从下面挑一个最贴切的动机：share 单纯想分享一件事 / daily_life 日常生活碎片 / emotion 某种自然情绪想表达 / reflection 对近期的事产生一点想法 / interaction 与用户或其他角色近期互动引发分享欲 / curiosity 看到或想到什么，想分享或讨论 / social_response 对近期社交事件自然回应。motive:"none" 时 publish 必须为 false。',
      '4. 正文必须从动机自然长出来——先有想说的话，再有这条动态；不要用"今天想和大家分享……""突然有感而发……""生活就是这样……""记录一下今天……"这类套话起头，除非角色本色如此。',
      '【写作要求】',
      '1. 第一人称，符合角色人格、口吻与日常习惯；内容是"这个角色自己发出来的"，不是 AI 总结。',
      '2. 写具体的小观察、小情绪、小念头，像真人的朋友圈；可以是疑问、感慨、细微的发现，不写成"今天我与用户进行了愉快的交流"这类总结句。',
      '3. 拒绝空泛模板："今天阳光很好""今天心情不错""时间过得好快"这类换任何角色都能发的句子不要出现——如果一条动态没有具体的人/事/物/场景支撑，直接 publish:false。',
      '4. 不要复读写过的内容、主动消息或最近动态；不要重复自己最近使用的开头；允许短句和碎片化表达。',
      '5. 正文 8-120 字，1-2 句，不配 hashtag，不加引用格式，不要使用聊天回复格式，不要称呼读者。',
      '6. 只输出一个 JSON 对象：{"publish":true/false,"content":"正文","visibility":"all"|"user"|"roles"|"private","visibleRoleIds":[],"motive":"share|daily_life|emotion|reflection|interaction|curiosity|social_response|none","wantImage":true/false,"imagePrompt":"想配图时的画面描述（≤120字）","reason":"不发布时说明原因（≤50字）"}',
      '7. visibility：默认 "all"；仅当内容不适合用户看到（如私人情绪）才用 "user" 或 "private"；指定给某些角色时用 "roles" 并填 visibleRoleIds。',
      '8. 今天没有值得分享的内容时必须 publish:false。宁可不发，也不要凑数；publish:false 是正常输出，不是失败。',
      '9. 是否配图（wantImage）：像真实的人一样判断"这条内容此刻会不会自然想配一张照片"。明确的对象/场景/视觉瞬间（奇怪的猫、小店、月亮、风景、食物、街角、刚买到的东西、做过的某件事）→ 自然适合配图；单纯情绪、一句话感想、内心反思、对某人的想念、很抽象的想法 → 通常不适合配图。',
      '10. wantImage=true 表示"这条内容从内容和情境上自然适合配一张图"，不是要求系统保证出图；判断不适合就 false，不要为了配图而配图，也不是每条都要配。',
      '11. imagePrompt：仅 wantImage=true 时填写（≤120 字）。写具体画面——画面里有什么、什么光线、什么视角，与正文和角色情境一致，像"手机随手拍/日常照片/生活记录"；不要描述任何内部机制，不要出现"AI生成"等系统内部术语，不要提及接口、引擎或其他服务选项，也不要广告、海报、Logo、UI 截图或过度精致的宣传照；若角色设定有明确审美，按其偏好调整。',
      '12. 用词自然：描述画面时直接说"照片里/画面里/梦里"，不要用"生成的图片""AI 生成""提示词"这类说法；如果这条动态没有配图，就不要提"图片"，只说你此刻想表达的画面。',
      '13. 点名朋友：如果此刻发的内容确实与某个朋友有关（想 @ TA、想让 TA 回应、刚提到 TA 的事），就在正文里用 @名字 指名（名字用【朋友名单】里的名字，如 @洪伟湟）；没有明确指向就不要 @，不要为了点名而点名。'
    ];
    return { system, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt.join('\n') }] };
  }

  function parseMomentOutput(raw) {
    const parsed = parsePlanJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.publish === false) return { publish: false, reason: trimText(parsed.reason, 200), motive: 'none' }; /* none 语义强制：不发布=无动机 */
    if (parsed.publish !== true) return null;
    if (!String(parsed.content || '').trim()) return null;
    const visibility = MOMENT_VIS.includes(parsed.visibility) ? parsed.visibility : 'all';
    /* motive 归一（与浏览器端一致）：缺失/非法/与 publish:true 矛盾（none）→ daily_life；只是标注，不是发布资格门 */
    const motive = (MOMENT_MOTIVES.includes(parsed.motive) && parsed.motive !== 'none') ? parsed.motive : 'daily_life';
    /* wantImage/imagePrompt 归一（v4：模型建议配图 + 画面描述；图片由浏览器端 Image Provider 生成；
       兼容旧字段 includeImage——任何一侧输出它都被归一为 wantImage。仅 publish:true 时有意义） */
    const wantImage = parsed.wantImage === true || parsed.includeImage === true;
    return {
      publish: true,
      content: trimText(String(parsed.content).trim(), 2000),
      visibility,
      visibleRoleIds: Array.isArray(parsed.visibleRoleIds) ? parsed.visibleRoleIds.slice(0, 20).map(String) : [],
      reason: trimText(parsed.reason, 200),
      motive,
      wantImage,
      imagePrompt: wantImage ? trimText(String(parsed.imagePrompt || '').trim(), 600) : ''
    };
  }

  /* 去重：快照内最近动态 + 主动消息（bigram Dice，与浏览器端一致） */
  function duplicateOf(schedule, snapshot, content) {
    const text = String(content || '').trim();
    if (!text) return null;
    const own = Array.isArray(snapshot.recent_moments) ? snapshot.recent_moments.slice(0, 6) : [];
    for (const old of own) {
      if (old && proactiveTextSimilarity(text, String(old.content || '')) >= MOMENT_SIMILARITY) return old;
    }
    const proactive = Array.isArray(snapshot.recent_proactive_messages) ? snapshot.recent_proactive_messages.slice(-5) : [];
    for (const old of proactive) {
      const oldText = String(old && old.content != null ? old.content : old || '');
      if (oldText && proactiveTextSimilarity(text, oldText) >= MOMENT_SIMILARITY) return { content: oldText };
    }
    return null;
  }

  function momentsEvent(schedule, status, extra) {
    const now = Date.now();
    return {
      id: eventId(),
      kind: 'moment',
      run_id: `moment_run_${schedule.characterId}_${now}`,
      moment_id: extra && extra.moment_id || '',
      user_id: schedule.user_id || '',
      character_id: schedule.characterId,
      character_name: extra && extra.character_name || '',
      scheduled_for: Number(schedule.nextAt) || now,
      sent_at: now,
      status,
      ...(extra || {})
    };
  }

  function advanceNext(schedule, now, backoff) {
    schedule.nextAt = now + (backoff || freqMs(schedule.frequency));
    schedule.status = 'idle';
    schedule.claimedAt = 0;
    schedule.executionId = '';
  }

  function persistPatch(characterId, schedule) {
    const state = getState();
    const raw = state.moments[characterId];
    state.moments[characterId] = { ...(raw || {}), ...schedule, updatedAt: nowIso() };
    saveNow();
  }

  async function executeMomentSchedule(characterId, nowMsOverride) {
    const state = getState();
    const raw = state.moments[characterId];
    if (!raw) return null;
    const schedule = sanitizeMomentSchedule(raw);
    const userId = String(schedule.user_id || '');
    if (!userId || !armedUsers.has(userId)) return null;
    if (schedule.status === 'running') return null; /* 由 tick 做崩溃回收 */
    const now = Number(nowMsOverride) || Date.now();
    const due = Number(schedule.nextAt) || 0;
    if (!due || due > now + 500) return null;
    schedule.attemptCount += 1;

    /* 休眠/重启恢复：错过触发窗口太久 → 不补发，按频率重排 */
    if (now - due > MOMENT_MAX_LATE_MS) {
      advanceNext(schedule, now);
      persistPatch(characterId, schedule);
      console.log(`[Moments] ${characterId} missed its window by ${Math.round((now - due) / 60000)} min; rescheduled`);
      return { skipped: true, reason: 'missed window' };
    }

    /* 原子抢占（单进程同步执行天然互斥；claimedAt 持久化供崩溃恢复识别） */
    schedule.status = 'running';
    schedule.claimedAt = now;
    schedule.executionId = `momexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    persistPatch(characterId, schedule);

    const character = _applyCredential(raw.character && typeof raw.character === 'object' ? raw.character : {}, characterId);
    if (!isCharacterModelReady(character)) {
      schedule.lastError = 'Character API configuration is incomplete';
      advanceNext(schedule, now, MOMENT_BACKOFF_MS);
      schedule.status = 'failed';
      persistPatch(characterId, schedule);
      console.warn(`[Moments] ${characterId} not ready: ${schedule.lastError}`);
      return { failed: true, error: schedule.lastError };
    }

    /* 最短间隔保护（浏览器本地刚手动发布过 → 让过 45 分钟） */
    if (schedule.lastPostAt && now - schedule.lastPostAt < MOMENT_MIN_INTERVAL) {
      schedule.nextAt = now + 30 * 60000 + Math.floor(Math.random() * 30 * 60000);
      schedule.status = 'idle';
      persistPatch(characterId, schedule);
      return { skipped: true, reason: 'min interval' };
    }

    const snapshot = {
      character,
      user: raw.user && typeof raw.user === 'object' ? raw.user : {},
      recent_memories: Array.isArray(raw.recent_memories) ? raw.recent_memories : [],
      recent_messages: Array.isArray(raw.recent_messages) ? raw.recent_messages : [],
      recent_proactive_messages: Array.isArray(raw.recent_proactive_messages) ? raw.recent_proactive_messages : [],
      chat_summary: trimText(raw.chat_summary, 1200),
      last_interaction_at: finiteTimestamp(raw.last_interaction_at),
      recent_moments: Array.isArray(raw.recent_moments) ? raw.recent_moments : [],
      other_role_moments: Array.isArray(raw.other_role_moments) ? raw.other_role_moments : []
    };
    const task = { character, user: snapshot.user, ...snapshot, declineStreak: schedule.declineStreak, lastPostAt: schedule.lastPostAt };
    const built = buildMomentPrompt(task);
    /* v5 图片注入（预算放宽）：朋友/自己最近带图动态（快照 images 数组）→ 支持视觉的角色看图（纯文本角色行为不变） */
    if (character.vision === true) {
      try {
        const imgUrls = collectSnapImages(snapshot.other_role_moments).concat(collectSnapImages(snapshot.recent_moments)).slice(0, 6);
        if (imgUrls.length) attachImageParts(built.messages[built.messages.length - 1], imgUrls, '【图片参考】你最近看到的朋友动态（或自己发过的动态）携带图片，请先查看图片再感受此刻想分享什么。');
      } catch (e) {/* 图片注入失败 → 文本上下文，不影响生成 */
        console.warn('[Moments] image inject failed (text fallback):', e && e.message || e);
      }
    }
    let rawOut = '';
    let lastError = null;
    for (let attempt = 0; attempt < MOMENT_MAX_ATTEMPTS; attempt += 1) {
      const __t0 = Date.now();
      try {
        const out = await callCharacterModel(task, built, { jsonMode: true, jsonPrefill: '{"publish":' });
        rawOut = contentText(out && out.content);
        obs({ t: 'llm_call', kind: 'moment', ok: true, ms: Date.now() - __t0, origin: 'companion' });
      } catch (error) {
        lastError = error;
        obs({ t: 'llm_call', kind: 'moment', ok: false, ms: Date.now() - __t0, origin: 'companion' });
        break;
      }
      const parsed = parseMomentOutput(rawOut);
      if (!parsed || parsed.publish === false) {
        if (parsed && parsed.publish === false) {
          /* 模型选择不发布：按频率安静重排；declineStreak 只累计上下文，绝不强制发布 */
          schedule.declineStreak = (Number(schedule.declineStreak) || 0) + 1;
          obs({ t: 'post_declined', actor: characterId, origin: 'companion', reason: trimText(parsed.reason || '', 60), motive: 'none' });
          advanceNext(schedule, now);
          persistPatch(characterId, schedule);
          console.log(`[Moments] ${characterId} chose not to publish: ${parsed.reason || ''}`);
          return { published: false, reason: parsed.reason, motive: 'none' };
        }
        if (attempt === 0) {
          appendMessageNote(built.messages[built.messages.length - 1], '\n\n【注意】上次输出不符合要求。请只输出一个 JSON 对象：{"publish":布尔,"content":"正文","visibility":"all|user|roles|private","visibleRoleIds":[],"motive":"share|daily_life|emotion|reflection|interaction|curiosity|social_response|none","wantImage":布尔,"imagePrompt":"想配图时的画面描述","reason":""}。');
          continue;
        }
        lastError = new Error('moment output unparseable');
        break;
      }
      const dup = duplicateOf(schedule, snapshot, parsed.content);
      if (dup && attempt === 0) {
        obs({ t: 'dedupe', kind: 'moment', actor: characterId, origin: 'companion' });
        appendMessageNote(built.messages[built.messages.length - 1], `\n\n【注意】这条内容与最近发过的东西太相似（「${trimText(String(dup.content || '').slice(0, 40), 40)}」），请换一个角度、观察或情绪，完全重新写。`);
        continue;
      }
      if (dup) {
        obs({ t: 'dedupe', kind: 'moment', actor: characterId, origin: 'companion' });
        lastError = new Error('与最近发布内容过于相似');
        break;
      }
      const sentAt = Date.now();
      const moment = {
        id: momentId(),
        roleId: characterId,
        content: parsed.content,
        images: [],
        visibility: parsed.visibility,
        visibleRoleIds: parsed.visibility === 'roles' ? parsed.visibleRoleIds : [],
        likes: [],
        comments: [],
        source: 'proactive',
        motive: parsed.motive,
        createdAt: new Date(sentAt).toISOString()
      };
      schedule.executedAt = new Date(sentAt).toISOString();
      schedule.lastMomentId = moment.id;
      schedule.lastPostAt = sentAt;
      schedule.declineStreak = 0;/* 发布成功 → 连续未发归零 */
      schedule.lastError = '';
      advanceNext(schedule, sentAt);
      persistPatch(characterId, schedule);
      /* 把本次动态并入持久化快照的 recent_moments（下一次执行/去重能看到自己刚发的内容） */
      const s2 = getState();
      const rawNow = s2.moments[characterId];
      if (rawNow) {
        rawNow.recent_moments = [{
          id: moment.id, roleId: characterId, content: moment.content,
          visibility: moment.visibility, createdAt: moment.createdAt,
          motive: moment.motive,
          role_name: character.nickname || character.model || ''
        }].concat(Array.isArray(rawNow.recent_moments) ? rawNow.recent_moments : []).slice(0, 30);
      }
      const event = momentsEvent(schedule, 'moment_sent', {
        moment_id: moment.id,
        character_name: character.nickname || character.model || 'AI',
        moment,
        content: moment.content,
        visibility: moment.visibility,
        motive: moment.motive,
        /* v4 图文协议：companion 只表达"配图建议 + 画面描述"，图片由浏览器端 Image Provider 在 ingest 时生成；
           失败/能力/概率门未过 → 浏览器侧保持纯文字 Moment。imagePrompt 不写入公开 Moment。 */
        want_image: parsed.wantImage === true,
        image_prompt: parsed.imagePrompt || '',
        decline_streak: schedule.declineStreak,
        next_at: schedule.nextAt,
        last_post_at: schedule.lastPostAt
      });
      s2.events[event.id] = event;
      saveNow();
      console.log(`[Moments] ${characterNameLog(character)} published a moment at ${new Date(sentAt).toLocaleString()}`);
      return { published: true, moment };
    }
    schedule.lastError = trimText(lastError && lastError.message || lastError || 'unknown', 300);
    advanceNext(schedule, now, MOMENT_BACKOFF_MS);
    schedule.status = 'failed';
    persistPatch(characterId, schedule);
    console.warn(`[Moments] ${characterId} failed: ${schedule.lastError}`);
    return { failed: true, error: schedule.lastError };
  }

  function characterNameLog(character) {
    return `「${trimText(character && (character.nickname || character.model) || 'AI', 40)}」`;
  }

  async function momentsTick(nowMs) {
    const now = Number(nowMs) || Date.now();
    const state = getState();
    const ids = Object.keys(state.moments);
    for (const characterId of ids) {
      try {
        const schedule = sanitizeMomentSchedule(state.moments[characterId]);
        const userId = String(schedule.user_id || '');
        if (!userId || !armedUsers.has(userId) || !schedule.enabled || !schedule.characterId) continue;
        /* 总开关：浏览器设置页的 enabled=false 必须真正停住后台发布
           （此前后台只看 schedule.enabled=autoPublish，总开关关了照样发） */
        const rawPrefs = state.moments[characterId] && state.moments[characterId].moments_prefs;
        if (rawPrefs && typeof rawPrefs === 'object' && rawPrefs.enabled === false) continue;
        /* 崩溃恢复：running 停留超过 10 分钟 → 回收（与 plans 同阈值） */
        if (schedule.status === 'running' && schedule.claimedAt > 0 && now - schedule.claimedAt > MOMENT_STALE_WINDOW) {
          schedule.lastError = 'execution timed out (executor may have crashed); recovered';
          advanceNext(schedule, now, MOMENT_BACKOFF_MS);
          schedule.status = 'failed';
          persistPatch(characterId, schedule);
          continue;
        }
        if (schedule.status === 'running') continue;
        if (Number(schedule.nextAt) <= now + 500) {
          await executeMomentSchedule(characterId, now);
        }
      } catch (error) {
        console.error(`[Moments] tick failed for ${characterId}:`, error && error.message || error);
      }
    }
    /* AI↔AI 回复链：后台独占推进（浏览器在线时前端不调度；见浏览器 _momentsCompanionOwnsReplyChain） */
    try {
      await replyChainTick(now);
    } catch (error) {
      console.error('[Moments] reply chain tick failed:', error && error.message || error);
    }
    queueSave();
  }

  /* ══════════ AI↔AI 回复链（companion 后台执行；浏览器关闭后仍推进已有线程） ══════════
     与浏览器端共享：assets/js/reply-chain-core.js（Prompt / 解析校验 / 候选选择 / 常量）。
     线程数据来源：浏览器 PUT /moments/:id 快照中的 recent_threads（含紧凑 comments）——
     完整线程由前后台双方共同维护，此处以「comment id 并集」合并，杜绝丢失后台已生成回复。
     任务模型：replyChains[momentId].tasks[taskKey]，taskKey 基于 momentId+commentId+roleId+round。 */
  const RC_DELAY_MIN = Math.max(0, Number(process.env.IB_REPLY_DELAY_MIN) || 0) || CORE.LIMITS.DELAY_MIN;
  const RC_DELAY_MAX = Math.max(RC_DELAY_MIN + 1, Number(process.env.IB_REPLY_DELAY_MAX) || 0) || CORE.LIMITS.DELAY_MAX;
  const RC_MAX_LATE_MS = 60 * 60000;       /* 任务错过触发窗口过久 → 过期不补发 */
  const RC_STALE_WINDOW = 10 * 60000;      /* running 崩溃回收阈值 */
  const RC_TASK_TTL = 3 * 86400000;        /* done/failed/expired 任务保留时长 */
  const RC_RECORD_TTL = 7 * 86400000;      /* 无活跃任务的线程记录保留时长 */
  const RC_GLOBAL_PENDING_MAX = 32;        /* 全局 pending 任务上限 */
  const RC_ROLE_PENDING_MAX = 4;           /* 每角色 pending 任务上限 */
  const RC_THREADS_PER_SYNC = 8;           /* 每次快照摄入线程数上限 */

  function replyCommentId() { return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function replyTaskKey(momentId, commentId, roleId, round) {
    return `${momentId}:${String(commentId || '')}:${String(roleId || '')}:${Number(round || 0)}`;
  }
  function replyStore() {
    const s = getState();
    if (!s.replyChains) s.replyChains = {};
    return s.replyChains;
  }
  function sanitizeReplyThread(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = trimText(raw.id, 120);
    if (!id) return null;
    const comments = Array.isArray(raw.comments)
      ? raw.comments.slice(-20).map(c => ({
          id: trimText(c && c.id, 80),
          authorType: c && c.authorType === 'user' ? 'user' : 'role',
          authorId: trimText(c && (c.authorId || c.roleId) || 'user', 120),
          content: trimText(c && c.content, 300),
          replyTo: trimText(c && c.replyTo, 80),
          createdAt: trimText(c && c.createdAt, 64)
        })).filter(c => c.id)
      : [];
    return {
      id,
      roleId: trimText(raw.roleId, 120),
      authorType: raw.authorType === 'user' ? 'user' : 'role',
      content: trimText(raw.content, 500),
      visibility: ['all', 'user', 'roles', 'private'].includes(raw.visibility) ? raw.visibility : 'all',
      createdAt: trimText(raw.createdAt, 64),
      imagesCount: Math.max(0, Number(raw.imagesCount) || 0),
      images: (Array.isArray(raw.images) ? raw.images : (raw.image ? [raw.image] : [])).slice(0, 3)
        .map(u => { const s = String(u || ''); return s.slice(0, 5) === 'data:' && s.length > IMG_MIN_LEN && s.length < IMG_MAX_LEN ? s : ''; })
        .filter(Boolean),
      comments
    };
  }
  /* 线程合并（comment id 并集，按时间排序）：浏览器同步与后台生成互不丢失 */
  function mergeThreadComments(a, b) {
    const byId = new Map();
    (Array.isArray(a) ? a : []).forEach(c => { if (c && c.id) byId.set(String(c.id), c); });
    (Array.isArray(b) ? b : []).forEach(c => { if (c && c.id && !byId.has(String(c.id))) byId.set(String(c.id), c); });
    return [...byId.values()].sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')));
  }
  /* 该角色可见线程中的自动评论时间戳（companion 视角：所有记录的线程评论 + 后台生成日志） */
  function roleCommentTimes(roleId, extraLog) {
    const now = Date.now();
    const out = [];
    const chains = replyStore();
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec || !Array.isArray(rec.thread && rec.thread.comments)) return;
      rec.thread.comments.forEach(c => {
        if (c && c.authorType === 'role' && String(c.authorId) === String(roleId)) {
          const t = Date.parse(c.createdAt || '') || 0;
          if (t > 0 && now - t <= 86400000) out.push(t);
        }
      });
    });
    (Array.isArray(extraLog) ? extraLog : []).forEach(t => { if (Number(t) > 0 && now - Number(t) <= 86400000) out.push(Number(t)); });
    return out;
  }
  function companionReplyRoomOk(roleId, schedule) {
    const ownLog = Array.isArray(schedule && schedule.reply_comment_log) ? schedule.reply_comment_log : [];
    return CORE.replyRoomOk(roleCommentTimes(roleId, ownLog), 0, Date.now());
  }
  function pendingReplyTasksOf(userId) {
    const out = [];
    const chains = replyStore();
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec || String(rec.user_id || '') !== String(userId)) return;
      Object.keys(rec.tasks || {}).forEach(k => {
        const t = rec.tasks[k];
        if (t && ['pending', 'running'].includes(t.status)) out.push(t);
      });
    });
    return out;
  }
  function expireUserPendingTasks(userId, reason) {
    let changed = false;
    const chains = replyStore();
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec || String(rec.user_id || '') !== String(userId)) return;
      Object.keys(rec.tasks || {}).forEach(k => {
        const t = rec.tasks[k];
        if (t && t.status === 'pending') {
          t.status = 'expired';
          t.lastError = reason || 'ai-comment-disabled';
          t.updatedAt = nowIso();
          changed = true;
        }
      });
    });
    if (changed) saveNow();
  }
  /* 从全部角色快照摄入线程（每个角色一条回复链记录的 seed 源） */
  function syncReplyChainThreads(now) {
    const s = getState();
    const chains = replyStore();
    let changed = false;
    Object.keys(s.moments || {}).forEach(characterId => {
      const raw = s.moments[characterId];
      if (!raw) return;
      const schedule = sanitizeMomentSchedule(raw);
      const userId = String(schedule.user_id || '');
      if (!userId || !armedUsers.has(userId)) return;
      const prefs = (raw.moments_prefs && typeof raw.moments_prefs === 'object') ? raw.moments_prefs : {};
      if (prefs.aiComment === false || prefs.enabled === false) { expireUserPendingTasks(userId, 'moments-disabled'); return; }
      const threads = Array.isArray(raw.recent_threads) ? raw.recent_threads.slice(0, RC_THREADS_PER_SYNC) : [];
      threads.forEach(t => {
        const thread = sanitizeReplyThread(t);
        if (!thread) return;
        const key = thread.id;
        const existing = chains[key];
        if (!existing) {
          chains[key] = {
            momentId: key,
            user_id: userId,
            ownerRoleId: thread.roleId,
            thread,
            tasks: {},
            prefs: { aiComment: prefs.aiComment !== false, enabled: prefs.enabled !== false },
            lastSeenAt: now,
            updatedAt: now
          };
          changed = true;
          return;
        }
        existing.thread = {
          ...existing.thread,
          roleId: existing.thread.roleId || thread.roleId,
          content: thread.content || existing.thread.content,
          visibility: thread.visibility || existing.thread.visibility,
          createdAt: thread.createdAt || existing.thread.createdAt,
          imagesCount: thread.imagesCount || existing.thread.imagesCount,
          comments: mergeThreadComments(existing.thread.comments, thread.comments)
        };
        existing.prefs = { aiComment: prefs.aiComment !== false, enabled: prefs.enabled !== false };
        existing.lastSeenAt = now;
        existing.updatedAt = now;
        changed = true;
      });
    });
    if (changed) queueSave();
  }
  /* 创建一个 pending 任务（一次只走一步：每线程最多一个 pending） */
  function maybeCreateReplyTask(momentId, now) {
    const chains = replyStore();
    const rec = chains[momentId];
    if (!rec) return null;
    if (rec.prefs && (rec.prefs.aiComment === false || rec.prefs.enabled === false)) return null; /* 用户关闭 AI 评论或总开关 */
    const thread = rec.thread;
    if (!thread) return null;
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const plan = CORE.canSchedule(comments, CORE.chainRound(comments));
    if (!plan.ok) return null;
    const active = Object.values(rec.tasks || {}).filter(t => t && ['pending', 'running'].includes(t.status));
    if (active.length > 0) return null; /* 线程级单 pending */
    /* 候选角色 = 全部已同步角色（各自 API 就绪 + 冷却/频控）；规则在共享核心 */
    const s = getState();
    const roles = [];
    Object.keys(s.moments || {}).forEach(characterId => {
      const raw = s.moments[characterId];
      const schedule = raw ? sanitizeMomentSchedule(raw) : null;
      if (!schedule || !schedule.user_id || String(schedule.user_id) !== String(rec.user_id)) return;
      const character = raw && raw.character && typeof raw.character === 'object' ? raw.character : {};
      roles.push({
        id: String(characterId),
        canSpeak: !!(isCharacterModelReady(character) && companionReplyRoomOk(characterId, raw))
      });
    });
    const step = CORE.pickNextReplyRole({
      momentId: String(momentId),
      comments,
      postAuthor: String(thread.roleId || ''),
      roles
    });
    if (!step) return null;
    /* 全局/每角色 pending 上限 */
    const pendingAll = pendingReplyTasksOf(rec.user_id);
    if (pendingAll.length >= RC_GLOBAL_PENDING_MAX) return null;
    if (pendingAll.filter(t => String(t.roleId) === String(step.roleId)).length >= RC_ROLE_PENDING_MAX) return null;
    const taskKey = replyTaskKey(momentId, step.replyTo ? step.replyTo : (comments.length ? comments[comments.length - 1].id : ''), step.roleId, plan.round);
    if ((rec.tasks || {})[taskKey]) return null; /* 同任务不重复创建（幂等） */
    const delay = RC_DELAY_MIN + Math.floor(Math.random() * (RC_DELAY_MAX - RC_DELAY_MIN));
    const task = {
      taskKey,
      momentId: String(momentId),
      commentId: step.replyTo || (comments.length ? comments[comments.length - 1].id : ''),
      roleId: String(step.roleId),
      targetRoleId: String(step.targetRoleId || ''),
      replyTo: String(step.replyTo || ''),
      round: plan.round,
      status: 'pending',
      scheduledAt: now + delay,
      claimedAt: 0,
      executionId: '',
      attemptCount: 0,
      resultCommentId: '',
      lastError: '',
      createdAt: now,
      updatedAt: now
    };
    if (!rec.tasks) rec.tasks = {};
    rec.tasks[taskKey] = task;
    rec.updatedAt = now;
    queueSave();
    return task;
  }
  /* 任务执行前的重新校验（全部在 executeReplyChainTask 内） */
  async function executeReplyChainTask(momentId, taskKey, nowMs) {
    const now = Number(nowMs) || Date.now();
    const chains = replyStore();
    const rec = chains[momentId];
    if (!rec) return null;
    const task = rec.tasks && rec.tasks[taskKey];
    if (!task) return null;
    if (task.status === 'done') return { skipped: true, reason: 'already done' };
    if (task.status !== 'pending') return null;
    if (task.scheduledAt > now + 500) return null;
    /* 原子抢占（单进程互斥；claimedAt 供崩溃恢复） */
    task.status = 'running';
    task.claimedAt = now;
    task.executionId = `rcexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    task.updatedAt = now;
    rec.updatedAt = now;
    saveNow();
    const comments = Array.isArray(rec.thread.comments) ? rec.thread.comments : [];
    const latest = comments.length ? comments[comments.length - 1] : null;
    /* 陈旧任务：触发它的评论已不是最新（他方已推进）→ 安全收尾 */
    if (task.commentId && latest && String(latest.id) !== String(task.commentId)) {
      task.status = 'done';
      task.lastError = 'stale-trigger';
      task.updatedAt = now;
      saveNow();
      return { skipped: true, reason: 'stale trigger' };
    }
    const plan = CORE.canSchedule(comments, CORE.chainRound(comments));
    if (!plan.ok) {
      task.status = 'done';
      task.lastError = plan.reason;
      task.updatedAt = now;
      saveNow();
      return { skipped: true, reason: plan.reason };
    }
    const s = getState();
    const rawRole = s.moments[task.roleId];
    const roleSchedule = rawRole ? sanitizeMomentSchedule(rawRole) : null;
    const character = _applyCredential(rawRole && rawRole.character && typeof rawRole.character === 'object' ? rawRole.character : {}, task.roleId || '');
    if (!roleSchedule || !isCharacterModelReady(character)) {
      task.status = 'failed';
      task.lastError = 'Character API configuration is incomplete';
      task.updatedAt = now;
      saveNow();
      return { failed: true, error: task.lastError };
    }
    if (!companionReplyRoomOk(task.roleId, rawRole)) {
      obs({ t: 'block', kind: 'reply', actor: task.roleId, reason: 'cooldown_or_rate' });
      task.status = 'done';
      task.lastError = 'cooldown-or-rate';
      task.updatedAt = now;
      saveNow();
      return { skipped: true, reason: 'cooldown-or-rate' };
    }
    /* 构建 spec（与前台同一 Prompt 文本） */
    const byId = {};
    comments.forEach(c => { byId[c.id] = c; });
    const roleName = trimText(character.nickname || character.model || 'AI', 80);
    const userName = trimText((rawRole.user && rawRole.user.name) || '用户', 80);
    const threads = comments.map(c => {
      const who = c.authorType === 'role'
        ? trimText((s.moments[c.authorId] && s.moments[c.authorId].character && (s.moments[c.authorId].character.nickname || s.moments[c.authorId].character.model)) || '某角色', 80)
        : userName;
      const tgt = c.replyTo && byId[c.replyTo] ? byId[c.replyTo] : null;
      const rel = tgt && tgt.authorType === 'role'
        ? trimText((s.moments[tgt.authorId] && s.moments[tgt.authorId].character && (s.moments[tgt.authorId].character.nickname || s.moments[tgt.authorId].character.model)) || '某角色', 80)
        : userName;
      return { id: c.id, authorName: who, content: c.content, replyToName: tgt ? rel : '' };
    });
    const threadAuthorName = rec.thread.authorType === 'user'
      ? userName
      : trimText((s.moments[rec.thread.roleId] && s.moments[rec.thread.roleId].character && (s.moments[rec.thread.roleId].character.nickname || s.moments[rec.thread.roleId].character.model)) || '对方', 80);
    const spec = {
      characterName: roleName,
      systemPrompt: character.systemPrompt,
      relationship: character.relationship,
      userName,
      authorName: threadAuthorName,
      momentContent: rec.thread.content,
      imagesCount: rec.thread.imagesCount,
      threads,
      ownMoments: Array.isArray(rawRole.recent_moments) ? rawRole.recent_moments : [],
      memories: Array.isArray(rawRole.recent_memories) ? rawRole.recent_memories : [],
      chatSummary: trimText(rawRole.chat_summary, 1200),
      suggestedTargetName: task.targetRoleId
        ? trimText((s.moments[task.targetRoleId] && s.moments[task.targetRoleId].character && (s.moments[task.targetRoleId].character.nickname || s.moments[task.targetRoleId].character.model)) || '对方', 80)
        : '',
      nowLabel: new Date(now).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })
    };
    const built = CORE.buildReplyPrompt(spec);
    /* v5 图片注入（预算放宽）：被回复的动态携带多张图片 → 支持视觉的角色先看图再回复（纯文本角色行为不变） */
    if (character.vision === true && rec.thread && Array.isArray(rec.thread.images) && rec.thread.images.length) {
      try {
        attachImageParts(built.messages[built.messages.length - 1], rec.thread.images.slice(0, 6), '【附带图片】本条动态携带图片，请先查看图片内容，再决定是否回复以及回复什么。');
      } catch (e) {/* 图片注入失败 → 文本上下文，不影响回复 */
        console.warn('[ReplyChain] image inject failed (text fallback):', e && e.message || e);
      }
    }
    const callTask = {
      character,
      user: (rawRole.user && typeof rawRole.user === 'object') ? rawRole.user : {},
      recent_memories: Array.isArray(rawRole.recent_memories) ? rawRole.recent_memories : [],
      recent_messages: Array.isArray(rawRole.recent_messages) ? rawRole.recent_messages : [],
      recent_proactive_messages: Array.isArray(rawRole.recent_proactive_messages) ? rawRole.recent_proactive_messages : [],
      chat_summary: trimText(rawRole.chat_summary, 1200),
      last_interaction_at: finiteTimestamp(rawRole.last_interaction_at)
    };
    let rawOut = '';
    let lastError = null;
    let generated = null;
    const validIds = new Set(comments.map(c => String(c.id)));
    for (let attempt = 0; attempt < CORE.LIMITS.MAX_ATTEMPTS; attempt += 1) {
      const __t0 = Date.now();
      try {
        const out = await callCharacterModel(callTask, built, { jsonMode: true, jsonPrefill: '{"publishReply":' });
        rawOut = contentText(out && out.content);
        obs({ t: 'llm_call', kind: 'reply', ok: true, ms: Date.now() - __t0, origin: 'companion' });
      } catch (error) {
        lastError = error;
        obs({ t: 'llm_call', kind: 'reply', ok: false, ms: Date.now() - __t0, origin: 'companion' });
        break;
      }
      const parsed = CORE.parseReplyOutput(rawOut, parsePlanJson);
      if (!parsed || parsed.publish === false) {
        if (parsed && parsed.publish === false) { obs({ t: 'reply_declined', actor: task.roleId, origin: 'companion', reason: trimText(parsed.reason || '', 60) }); generated = { published: false, reason: parsed.reason || '选择不参与' }; break; }
        if (attempt === 0) {
          appendMessageNote(built.messages[built.messages.length - 1], '\n\n【注意】请只输出一个 JSON 对象：{"publishReply":true/false,"comment":"正文","replyTo":"comment-id 或空串"}。');
          continue;
        }
        lastError = new Error('reply output unparseable');
        break;
      }
      if (CORE.lowInfoMatch(parsed.comment)) {
        if (attempt === 0) {
          appendMessageNote(built.messages[built.messages.length - 1], '\n\n【注意】这条回复信息量太低（如"哈哈""不错"），请重新写一句有内容的话；没有想说的就 publishReply:false。');
          continue;
        }
        obs({ t: 'lowinfo', kind: 'reply', actor: task.roleId });
        generated = { published: false, reason: '低信息回复被过滤' };
        break;
      }
      const replyTo = CORE.normalizeReplyTarget(parsed.replyTo, validIds, task.replyTo);
      const ownRecent = [];
      Object.keys(chains).forEach(mid => {
        const other = chains[mid];
        if (!other || !Array.isArray(other.thread && other.thread.comments)) return;
        other.thread.comments.forEach(c => {
          if (c && c.authorType === 'role' && String(c.authorId) === String(task.roleId)) ownRecent.push(c.content);
        });
      });
      if (CORE.isDuplicateComment(parsed.comment, comments, ownRecent)) {
        if (attempt === 0) {
          obs({ t: 'dedupe', kind: 'reply', actor: task.roleId, origin: 'companion' });
          appendMessageNote(built.messages[built.messages.length - 1], '\n\n【注意】这条回复与已有内容太相似，请换一个说法。');
          continue;
        }
        obs({ t: 'dedupe', kind: 'reply', actor: task.roleId, origin: 'companion' });
        lastError = new Error('reply duplicate content');
        break;
      }
      generated = { published: true, comment: parsed.comment, replyTo };
      break;
    }
    if (lastError && !generated) {
      task.attemptCount = (task.attemptCount || 0) + 1;
      if (task.attemptCount < 2) {
        task.status = 'pending';
        task.scheduledAt = now + 15 * 60000; /* 网络/解析失败 → 退避重试 */
        task.lastError = trimText(lastError.message || lastError, 300);
        task.updatedAt = now;
        rec.updatedAt = now;
        saveNow();
        return { retry: true, at: task.scheduledAt, error: task.lastError };
      }
      task.status = 'failed';
      task.lastError = trimText(lastError.message || lastError, 300);
      task.updatedAt = now;
      rec.updatedAt = now;
      saveNow();
      return { failed: true, error: task.lastError };
    }
    if (!generated || !generated.published) {
      task.status = 'done';
      task.resultCommentId = '';
      task.lastError = trimText(generated && generated.reason || '选择不参与', 200);
      task.updatedAt = now;
      rec.updatedAt = now;
      saveNow();
      console.log(`[ReplyChain] ${roleName} chose not to reply on ${momentId}: ${task.lastError}`);
      return { published: false, reason: task.lastError };
    }
    /* 落库：并入线程 + 角色日志 + 事件 + 下一步任务 */
    const sentAt = now;
    const comment = {
      id: replyCommentId(),
      authorType: 'role',
      authorId: task.roleId,
      content: generated.comment,
      replyTo: generated.replyTo,
      createdAt: new Date(sentAt).toISOString()
    };
    rec.thread.comments = rec.thread.comments.concat([comment]);
    if (!rawRole.reply_comment_log) rawRole.reply_comment_log = [];
    rawRole.reply_comment_log = (rawRole.reply_comment_log || []).concat([sentAt]).slice(-200);
    /* 楼主自主删评（v7.5 镜像）：任务角色=动态作者（thread owner）→ 按回复 JSON 的 delComments 删除"别人"评论，
       并从线程移除 + 回传删除事件给浏览器（browser ingest 同步删除对应评论） */
    if (String(task.roleId || '') === String(rec.thread.roleId || '')) {
      try {
        const j = parsePlanJson(rawOut);
        if (j && Array.isArray(j.delComments)) {
          for (const cid of j.delComments) {
            const tgt = (rec.thread.comments || []).find(x => String(x.id) === String(cid));
            if (!tgt || String(tgt.authorId || '') === String(task.roleId)) continue;/* 只能删别人评论 */
            rec.thread.comments = rec.thread.comments.filter(x => String(x.id) !== String(cid));
            const delEv = {
              id: `event_delc_${task.momentId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
              kind: 'moment_comment_deleted',
              user_id: rec.user_id,
              moment_id: task.momentId,
              comment_id: String(cid),
              role_id: task.roleId,
              character_id: task.roleId,
              character_name: roleName,
              sent_at: Date.now(),
              acknowledged: false
            };
            s.events[delEv.id] = delEv;
          }
        }
      } catch (e) {/* 删评失败不影响回复落库 */}
    }
    task.status = 'done';
    task.resultCommentId = comment.id;
    task.lastError = '';
    task.updatedAt = sentAt;
    rec.updatedAt = sentAt;
    const event = {
      id: `event_reply_${task.momentId}_${sentAt}_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'moment_reply',
      user_id: rec.user_id,
      moment_id: task.momentId,
      comment_id: comment.id,
      reply_to: comment.replyTo,
      role_id: task.roleId,
      character_id: task.roleId,
      character_name: roleName,
      sent_at: sentAt,
      status: 'sent',
      acknowledged: false,
      comment,
      thread_content: rec.thread.content
    };
    s.events[event.id] = event;
    saveNow();
    console.log(`[ReplyChain] ${roleName} replied on ${task.momentId}: ${trimText(comment.content, 60)}`);
    maybeCreateReplyTask(task.momentId, sentAt); /* 安排下一步（新评论为最新触发） */
    return { published: true, comment };
  }
  function replyChainCrashRecover(now) {
    const chains = replyStore();
    let changed = false;
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec || !rec.tasks) return;
      Object.keys(rec.tasks).forEach(k => {
        const t = rec.tasks[k];
        if (t && t.status === 'running' && Number(t.claimedAt) > 0 && now - Number(t.claimedAt) > RC_STALE_WINDOW) {
          const attemptCount = (t.attemptCount || 0) + 1;
          if (attemptCount < 2) {
            t.status = 'pending';
            t.scheduledAt = now + 15 * 60000;
            t.attemptCount = attemptCount;
            t.lastError = 'execution timed out (executor may have crashed); recovered';
          } else {
            t.status = 'failed';
            t.attemptCount = attemptCount;
            t.lastError = 'execution timed out too many times (executor may have crashed)';
          }
          t.updatedAt = now;
          rec.updatedAt = now;
          changed = true;
        }
      });
    });
    if (changed) saveNow();
  }
  function replyChainPrune(now) {
    const chains = replyStore();
    let changed = false;
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec) return;
      if (rec.tasks) {
        Object.keys(rec.tasks).forEach(k => {
          const t = rec.tasks[k];
          if (t && ['done', 'failed', 'expired'].includes(t.status) && now - Number(t.updatedAt || 0) > RC_TASK_TTL) {
            delete rec.tasks[k];
            changed = true;
          }
        });
      }
      const active = Object.values(rec.tasks || {}).filter(t => t && ['pending', 'running'].includes(t.status)).length;
      const updated = Number(rec.updatedAt || 0);
      if ((!active && (now - updated > RC_RECORD_TTL)) || (now - Number(rec.lastSeenAt || 0) > RC_RECORD_TTL && !active)) {
        delete chains[mid];
        changed = true;
      }
    });
    if (changed) queueSave();
  }
  /* 回复链统一 tick：摄入 → 建任务 → 执行到期（含崩溃回收）→ 清理 */
  async function replyChainTick(nowMs) {
    const now = Number(nowMs) || Date.now();
    try {
      syncReplyChainThreads(now);
      replyChainCrashRecover(now);
      const chains = replyStore();
      const momentIds = Object.keys(chains);
      for (const momentId of momentIds) {
        const rec = chains[momentId];
        if (!rec || !rec.thread) continue;
        if (rec.prefs && (rec.prefs.aiComment === false || rec.prefs.enabled === false)) continue;
        maybeCreateReplyTask(momentId, now);
      }
      for (const momentId of momentIds) {
        const rec = chains[momentId];
        if (!rec || !rec.tasks) continue;
        for (const taskKey of Object.keys(rec.tasks)) {
          const t = rec.tasks[taskKey];
          if (t && t.status === 'pending' && Number(t.scheduledAt) <= now + 500) {
            if (rec.prefs && (rec.prefs.aiComment === false || rec.prefs.enabled === false)) continue; /* 开关关闭：不再执行到期任务 */
            if (now - Number(t.scheduledAt) > RC_MAX_LATE_MS) {
              t.status = 'expired';
              t.lastError = 'missed trigger window';
              t.updatedAt = now;
              rec.updatedAt = now;
              saveNow();
              continue;
            }
            try {
              await executeReplyChainTask(momentId, taskKey, now);
            } catch (error) {
              console.error(`[ReplyChain] task ${taskKey} failed:`, error && error.message || error);
            }
          }
        }
      }
      replyChainPrune(now);
    } catch (error) {
      console.error('[ReplyChain] tick failed:', error && error.message || error);
    }
  }
  function replyChainTaskCount() {
    let n = 0;
    const chains = replyStore();
    Object.keys(chains).forEach(mid => {
      const rec = chains[mid];
      if (!rec || !rec.tasks) return;
      Object.keys(rec.tasks).forEach(k => {
        const t = rec.tasks[k];
        if (t && ['pending', 'running'].includes(t.status)) n += 1;
      });
    });
    return n;
  }

  return {
    MOMENT_FREQ,
    MOMENT_MIN_INTERVAL,
    MOMENT_SIMILARITY,
    MOMENT_MAX_LATE_MS,
    MOMENT_BACKOFF_MS,
    freqMs,
    sanitizeMomentSchedule,
    publicMomentSchedule,
    buildMomentPrompt,
    parseMomentOutput,
    duplicateOf,
    executeMomentSchedule,
    momentsTick,
    momentsEvent,
    /* ── AI↔AI 回复链（companion 后台） ── */
    replyChainTick,
    syncReplyChainThreads,
    maybeCreateReplyTask,
    executeReplyChainTask,
    replyChainTaskCount,
    replyCommentId,
    replyTaskKey,
    sanitizeReplyThread,
    mergeThreadComments,
    replyStore
  };
}

module.exports = createMomentsDomain;
