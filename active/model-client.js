/* IB Active · 模型客户端：主动消息 prompt 构建、三种 provider 适配（anthropic/gemini/openai）、
   重试与相似度校验、角色化兜底、Windows 气泡通知。从 active-message-service.js 提取为工厂。
   state 经 getState() 注入（recentProactiveMessages 读 history）；trimText / finiteTimestamp /
   mergeRecentProactiveMessages 与两个 PROACTIVE_* 常量经依赖注入。原逻辑逐字不变。 */
'use strict';

const { spawn } = require('child_process');

function createModelClient(deps) {
  const getState = deps.getState;
  const trimText = deps.trimText;
  const finiteTimestamp = deps.finiteTimestamp;
  const mergeRecentProactiveMessages = deps.mergeRecentProactiveMessages;
  const maxAttempts = deps.maxAttempts;
  const similarityLimit = deps.similarityLimit;

  function proactiveLog(step, detail) {
    console.log(`[ProactiveMessage] ${step}`, detail || '');
  }

  /* ── 消息内容适配（v5 图片注入）：朋友圈/回复链注入的 _image part → 各 provider 格式；
     纯文本消息原样返回（与旧行为完全一致，零回退风险） ── */
  function adaptMessageParts(fmt, content) {
    if (typeof content === 'string' || !Array.isArray(content)) return content;
    return content.map(p => {
      if (p && p.type === '_image' && p.base64) {
        if (fmt === 'anthropic') return { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: p.base64 } };
        if (fmt === 'gemini') return { inlineData: { mimeType: p.mime || 'image/jpeg', data: p.base64 } };
        return { type: 'image_url', image_url: { url: 'data:' + (p.mime || 'image/jpeg') + ';base64,' + p.base64 } };
      }
      return { type: 'text', text: String((p && p.text) || '') };
    });
  }
  function geminiParts(content) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content || '') }];
    return adaptMessageParts('gemini', content);
  }

  function currentTimeText(setting, currentTime) {
    const timezone = setting && setting.schedule && setting.schedule.timezone;
    const options = timezone && timezone !== 'local' ? { timeZone: timezone } : {};
    try {
      return new Date(currentTime || Date.now()).toLocaleString('zh-CN', {
        ...options,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return new Date(currentTime || Date.now()).toLocaleString('zh-CN');
    }
  }

  function elapsedText(timestamp, now) {
    const elapsed = Number(now || Date.now()) - Number(timestamp || 0);
    if (!timestamp || !Number.isFinite(elapsed) || elapsed < 0) return '未知';
    if (elapsed < 60 * 1000) return '不到 1 分钟';
    if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60000)} 分钟`;
    if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时`;
    return `${Math.floor(elapsed / 86400000)} 天`;
  }

  function recentProactiveMessages(task) {
    const setting = task && task.setting || {};
    const userId = String(setting.user_id || '');
    const characterId = String(setting.character_id || '');
    const durable = Object.values(getState().history).filter(item =>
      item && item.status === 'sent' && item.content &&
      String(item.user_id || '') === userId && String(item.character_id || '') === characterId
    ).map(item => ({
      content: item.content,
      sent_at: item.sent_at || item.completed_at || 0,
      generatedByFallback: !!item.generatedByFallback
    }));
    return mergeRecentProactiveMessages(task && task.recent_proactive_messages || [], durable);
  }

  function proactiveModeGuide(mode) {
    return ({
      greeting: '从此刻真实情境出发自然开口，不套用“早上好”“在吗”“今天过得怎么样”“记得休息”等固定问候。',
      memory: '从相关长期记忆中选择值得延续的一件事自然提起，不要说自己读取了 Memory。',
      time: '结合当前日期、星期与时段开启此刻才适合的话题，不编造天气、新闻或用户行程。',
      random: '带一点偶发地想起对方的感觉；可以由另一位角色触发联想，但绝不替其他角色发言。'
    })[mode] || '根据角色设定、当前时间和最近上下文自然开启一次私聊。';
  }

  function buildProactivePrompt(task, options) {
    const opts = options || {};
    const setting = task.setting || {};
    const character = task.character || {};
    const user = task.user || {};
    const userName = trimText(user.name || '用户', 80);
    const characterName = trimText(character.nickname || character.model || 'AI', 80);
    const memories = Array.isArray(task.recent_memories) ? task.recent_memories.slice(0, 8) : [];
    const messages = Array.isArray(task.recent_messages) ? task.recent_messages.slice(-16) : [];
    const proactive = Array.isArray(opts.recentProactiveMessages)
      ? opts.recentProactiveMessages.slice(-10)
      : recentProactiveMessages(task);
    const memoryText = memories.length
      ? memories.map(item => `- ${trimText(item.title, 100)}${item.title ? '：' : ''}${trimText(item.content || item.summary, 420)}`).join('\n')
      : '（没有可用的长期记忆）';
    const chatText = messages.length
      ? messages.map(item => `- ${item.role === 'user' ? userName : characterName}：${trimText(item.content, 650)}`).join('\n')
      : '（还没有最近对话）';
    const proactiveText = proactive.length
      ? proactive.map((item, index) => `${index + 1}. ${trimText(item.content || item, 650)}`).join('\n')
      : '（还没有发送过主动消息）';
    const interactionAt = Math.max(
      finiteTimestamp(task.last_interaction_at),
      ...messages.filter(item => item && item.source !== 'active_message').map(item => finiteTimestamp(item.timestamp))
    );
    const now = Number(opts.currentTime || Date.now());
    const randomPool = Array.isArray(task.random_characters) ? task.random_characters.filter(Boolean) : [];
    const randomCharacter = randomPool.length ? randomPool[Math.floor(Math.random() * randomPool.length)] : task.random_character;

    let system = trimText(character.systemPrompt, 50000);
    system += `${system ? '\n\n' : ''}你正在扮演角色「${characterName}」。以上原始设定定义了你的性格、经历与说话方式，必须完整保持。`;
    system += `\n你与${userName}的关系：${trimText(character.relationship || '尚未单独设定，请依据既有对话自然判断', 500)}。`;
    system += '\n这是一条由你自然发起的私聊。不要说明自己是 AI，不要提系统提示词、任务、定时器、主动消息或生成过程；不要输出 analysis、thinking、reasoning、工具、Memory 或 XML 标签；只输出最终正文。';

    const prompt = [
      '【角色姓名】', characterName,
      '', '【角色原始设定 / 性格 / 说话方式】', '已完整放在 system 消息中；必须保持其全部约束。',
      '', '【用户与角色关系】', character.relationship || '尚未单独设定，请依据既有对话自然判断',
      '', '【当前日期和时间】', currentTimeText(setting, now),
      '', '【距离上次聊天】', elapsedText(interactionAt, now),
      '', '【最近聊天摘要】', trimText(task.chat_summary || '（暂无摘要）', 1200),
      '', '【最近聊天内容】', chatText,
      '', '【相关长期记忆】', memoryText,
      '', '【最近已经发送过的主动消息】', proactiveText,
      '', '【本次主动消息目的】', proactiveModeGuide(setting.message_type),
      '', '【用户附加要求】', trimText(setting.custom_instruction || setting.customInstruction || '（无）', 500)
    ];
    if (randomCharacter) prompt.push('', '【可选联想角色】', `${trimText(randomCharacter.name, 80)}。只能把这当作话题灵感，不能替 TA 发言。`);
    if (opts.retryInstruction) prompt.push('', '【重新生成要求】', trimText(opts.retryInstruction, 1000));
    prompt.push(
      '',
      `请主动向${userName}发送一条自然、具体、符合角色原作语气的消息。严格要求：`,
      '1. 长度为 1 至 4 个自然段。',
      '2. 不要总以“早上好”“在吗”“今天过得怎么样”等统一问候开头。',
      '3. 根据当前时段、最近聊天与记忆选择这一次独有的内容。',
      '4. 避免与最近主动消息相同的开头、话题、句式、问候或近义复述。',
      '5. 可以延续之前的话题，也可以自然开启新话题。',
      '6. 不要复读最近回复，只输出最终可见正文。'
    );

    return {
      system,
      messages: [{ role: 'user', content: prompt.join('\n') }],
      recentProactiveMessages: proactive
    };
  }

  function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part;
        return part && (part.text || part.content) || '';
      }).join('');
    }
    return content == null ? '' : String(content);
  }

  /* Native reasoning fields are authoritative; tag parsing exists only for legacy relays/models. */
  function responseParts(content, nativeReasoning) {
    let text = contentText(content);
    const native = contentText(nativeReasoning);
    if (native.trim()) return { content: text, reasoning_content: native };

    let thinking = '';
    const leadingClose = text.match(/^\s*<\/think(?:ing)?>\s*/i);
    if (leadingClose) {
      text = text.slice(leadingClose[0].length);
      const orphanClose = text.match(/<\/think(?:ing)?>/i);
      if (orphanClose && text.slice(orphanClose.index + orphanClose[0].length).trim()) {
        thinking = text.slice(0, orphanClose.index).replace(/^\s*(?:思考|thinking)\s*[:：]\s*/i, '').trim();
        text = text.slice(orphanClose.index + orphanClose[0].length);
      }
    }
    const opening = text.match(/^\s*<think(?:ing)?>/i);
    if (opening) {
      const rest = text.slice(opening[0].length);
      const closing = rest.match(/<\/think(?:ing)?>/i);
      if (closing) {
        thinking = rest.slice(0, closing.index).trim();
        text = rest.slice(closing.index + closing[0].length);
      } else {
        const splitAt = rest.search(/\n\s*\n/);
        if (splitAt > 0) {
          thinking = rest.slice(0, splitAt).trim();
          text = rest.slice(splitAt);
        } else {
          text = rest;
        }
      }
    }
    return { content: text.trim(), reasoning_content: thinking };
  }

  async function fetchJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch (_) {
        if (!response.ok) throw new Error(`${response.status}: ${trimText(raw, 1200)}`);
        throw new Error('API returned a non-JSON response');
      }
      if (!response.ok) {
        const detail = parsed && parsed.error
          ? (parsed.error.message || JSON.stringify(parsed.error))
          : raw;
        const error = new Error(`${response.status}: ${trimText(detail, 1200)}`);
        error.status = response.status;
        throw error;
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  function isLoopbackEndpoint(endpoint) {
    try {
      const parsed = new URL(String(endpoint || ''));
      const host = String(parsed.hostname || '').toLowerCase();
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
    } catch (_) {
      return false;
    }
  }

  function hasCharacterCredential(character) {
    return Boolean(character && (String(character.apiKey || '').trim() || isLoopbackEndpoint(character.endpoint)));
  }

  function isCharacterModelReady(character) {
    return Boolean(character && String(character.endpoint || '').trim() && String(character.model || '').trim() && hasCharacterCredential(character));
  }

  async function callCharacterModel(task, preparedPrompt, opts) {
    opts = opts || {};
    const character = task.character || {};
    if (!isCharacterModelReady(character)) {
      throw new Error('Character API configuration is incomplete');
    }
    const prompt = preparedPrompt || buildProactivePrompt(task);
    const provider = String(character.provider || 'custom').toLowerCase();

    if (provider === 'anthropic') {
      const body = {
        model: character.model,
        max_tokens: 512,
        system: prompt.system,
        messages: prompt.messages.map(m => ({ role: m.role, content: adaptMessageParts('anthropic', m.content) }))
      };
      /* AI 规划/朋友圈结构化输出：预填 JSON 前缀引导模型续写。前缀必须与目标 schema 一致
         （规划='{"action":'、动态='{"publish":'、回复链='{"publishReply":'}，
         否则模型被迫在两个 schema 间强行拼接，是 replyTo 残片漏进正文的诱因之一。 */
      if (opts.jsonMode) body.messages = body.messages.concat([{ role: 'assistant', content: opts.jsonPrefill || '{"action":' }]);
      if (Number.isFinite(Number(character.temperature))) body.temperature = Number(character.temperature);
      const data = await fetchJson(character.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': character.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      const blocks = Array.isArray(data.content) ? data.content : [];
      return responseParts(
        blocks.filter(block => block && block.type === 'text').map(block => block.text || '').join(''),
        blocks.filter(block => block && block.type === 'thinking').map(block => block.thinking || block.text || '').join('\n')
      );
    }

    if (provider === 'gemini') {
      let endpoint = String(character.endpoint);
      endpoint = endpoint.includes('{model}')
        ? endpoint.replace('{model}', encodeURIComponent(character.model))
        : endpoint;
      const url = new URL(endpoint);
      if (!url.searchParams.has('key')) url.searchParams.set('key', character.apiKey);
      const body = {
        system_instruction: { parts: [{ text: prompt.system }] },
        contents: prompt.messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: geminiParts(message.content)
        })),
        generationConfig: { maxOutputTokens: 512 }
      };
      if (opts.jsonMode) body.generationConfig.responseMimeType = 'application/json';
      if (Number.isFinite(Number(character.temperature))) body.generationConfig.temperature = Number(character.temperature);
      const data = await fetchJson(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const candidate = data.candidates && data.candidates[0] || {};
      const parts = candidate.content && candidate.content.parts || [];
      return responseParts(
        parts.filter(part => !part.thought).map(part => part.text || '').join(''),
        parts.filter(part => part.thought).map(part => part.text || '').join('\n')
      );
    }

    const baseMessages = [{ role: 'system', content: prompt.system }, ...prompt.messages.map(m => ({ role: m.role, content: adaptMessageParts('openai', m.content) }))];
    const body = {
      model: character.model,
      messages: baseMessages,
      max_tokens: 512
    };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };/* AI 规划：结构化 JSON 输出（不支持时降级重试） */
    if (Number.isFinite(Number(character.temperature))) body.temperature = Number(character.temperature);
    const request = tokenParam => {
      const payload = { ...body };
      if (tokenParam === 'max_completion_tokens') {
        delete payload.max_tokens;
        payload.max_completion_tokens = 512;
      }
      return fetchJson(character.endpoint, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, character.apiKey ? { Authorization: `Bearer ${character.apiKey}` } : {}),
        body: JSON.stringify(payload)
      });
    };

    let data;
    try {
      data = await request('max_tokens');
    } catch (error) {
      if (opts.jsonMode && /response_format|json[ _-]?mode|json_object/i.test(String(error.message))) {
        opts.jsonMode = false; /* 端点不认 JSON 模式 → 降级为提示词 + 容错解析 */
        delete body.response_format;
        data = await request('max_tokens');
      } else if (/max_completion_tokens/i.test(String(error.message)) && /max_tokens|unsupported|not supported/i.test(String(error.message))) {
        data = await request('max_completion_tokens');
      } else {
        throw error;
      }
    }
    const choice = data.choices && data.choices[0] || {};
    const message = choice.message || {};
    return responseParts(message.content, message.reasoning_content || message.reasoning || message.analysis || message.thinking || '');
  }

  function visibleProactiveReply(output) {
    let text = contentText(output && output.content).trim();
    /* Native reasoning was already separated by the provider adapter. Tag removal is only a
     * compatibility fallback for legacy relays that incorrectly place reasoning in content. */
    text = text.replace(/<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi, '').trim();
    text = text.replace(/^\s*<\/(?:think|thinking|analysis)>\s*/i, '').trim();
    return text;
  }

  function proactiveTextKey(value) {
    return String(value || '').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  function proactiveTextSimilarity(left, right) {
    const a = proactiveTextKey(left);
    const b = proactiveTextKey(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = value => {
      if (value.length < 2) return [value];
      const out = [];
      for (let index = 0; index < value.length - 1; index += 1) out.push(value.slice(index, index + 2));
      return out;
    };
    const pool = new Map();
    grams(a).forEach(gram => pool.set(gram, (pool.get(gram) || 0) + 1));
    let overlap = 0;
    const bGrams = grams(b);
    bGrams.forEach(gram => {
      const count = pool.get(gram) || 0;
      if (!count) return;
      overlap += 1;
      pool.set(gram, count - 1);
    });
    return 2 * overlap / (grams(a).length + bGrams.length);
  }

  function validateProactiveReply(content, recent) {
    const text = String(content || '').trim();
    const key = proactiveTextKey(text);
    if (!key) return { ok: false, reason: '模型返回空内容或只有标点' };
    if (/<\/?(?:think|thinking|analysis|reasoning)\b/i.test(text) ||
        /^\s*(?:analysis|thinking|reasoning|思考)\s*[:：]/i.test(text)) {
      return { ok: false, reason: '模型返回了 thinking 或 analysis，而不是纯最终正文' };
    }
    const rows = Array.isArray(recent) ? recent : [];
    for (const item of rows) {
      const old = String(item && item.content != null ? item.content : item || '').trim();
      if (!old) continue;
      const similarity = proactiveTextSimilarity(text, old);
      if (similarity >= similarityLimit) {
        return { ok: false, reason: `与最近主动消息相似度过高（${Math.round(similarity * 100)}%）` };
      }
      const opening = key.slice(0, 12);
      if (opening.length >= 8 && proactiveTextKey(old).startsWith(opening)) {
        return { ok: false, reason: '与最近主动消息使用了相同开头' };
      }
    }
    return { ok: true, reason: '' };
  }

  function proactiveFallbackMessage(character, recent, currentTime) {
    const profile = `${character && character.nickname || ''} ${character && character.systemPrompt || ''}`.toLocaleLowerCase();
    const hour = new Date(currentTime || Date.now()).getHours();
    const timeWord = hour < 6 ? '这个安静得过分的时刻' : hour < 12 ? '上午这段时间' : hour < 18 ? '午后' : '今晚';
    let variants;
    if (/(活泼|元气|开朗|歌|音乐|陪伴|可爱)/u.test(profile)) {
      variants = [`${timeWord}忽然冒出一个想和你分享的小念头。等你有空时，来告诉我此刻最想听见什么吧。`, `我刚刚想到你啦——${timeWord}有没有哪件小事，让你忍不住想哼两句？`];
    } else if (/(研究|学者|实验|理性|高傲|冷静|科学)/u.test(profile)) {
      variants = [`${timeWord}我想到一个值得观察的问题：最近有什么细节，悄悄改变了你的判断？`, `我暂时从手边的思绪里分出一点注意力给你。若要记录${timeWord}最有价值的一个发现，你会选什么？`];
    } else if (/(安静|疏离|故事|温和|沉静|寡言)/u.test(profile)) {
      variants = [`${timeWord}很安静，我便想起了你。若你愿意，可以把今天尚未说完的一小段故事留在这里。`, `有些话不必急着说完。${timeWord}如果你正好想找个人听，我在。`];
    } else {
      variants = [`${timeWord}我忽然想起了你。等你有空，告诉我最近最值得记住的一件小事吧。`, `刚才有个念头拐到了你这里。${timeWord}你若想聊点什么，我愿意听。`];
    }
    const recentKeys = new Set((recent || []).map(item => proactiveTextKey(item && item.content || item)));
    return variants.find(item => !recentKeys.has(proactiveTextKey(item))) || variants[0];
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function generateProactiveMessage(task, options) {
    const opts = options || {};
    const character = task.character || {};
    const setting = task.setting || {};
    const recent = recentProactiveMessages(task);
    const currentTime = Number(opts.currentTime || Date.now());
    let lastError = null;
    let retryInstruction = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const preparedPrompt = buildProactivePrompt(task, {
        currentTime,
        recentProactiveMessages: recent,
        retryInstruction
      });
      proactiveLog('requesting model', {
        taskId: setting.id || '',
        characterId: character.id || setting.character_id || '',
        provider: character.provider || 'custom',
        model: character.model || '',
        attempt
      });
      try {
        const output = await callCharacterModel(task, preparedPrompt);
        const content = visibleProactiveReply(output);
        const check = validateProactiveReply(content, recent);
        if (check.ok) {
          proactiveLog('generated successfully', {
            taskId: setting.id || '',
            characterId: character.id || setting.character_id || '',
            provider: character.provider || 'custom',
            model: character.model || '',
            attempt
          });
          return {
            content,
            reasoning_content: '',
            generatedByFallback: false,
            generationAttempts: attempt,
            provider: character.provider || 'custom',
            model: character.model || ''
          };
        }
        lastError = new Error(check.reason);
        retryInstruction = `${check.reason}。上一条被拒绝的正文是：${trimText(content, 600)}。请换一个开头、话题和句式，完整重写，不要解释原因。`;
      } catch (error) {
        lastError = error;
        retryInstruction = '上一次模型调用失败或没有产生可用正文。请重新生成，只返回最终消息。';
        console.warn('[ProactiveMessage] model attempt failed', {
          taskId: setting.id || '',
          characterId: character.id || setting.character_id || '',
          provider: character.provider || 'custom',
          model: character.model || '',
          attempt,
          error: trimText(error && error.message || error, 300)
        });
      }
      if (attempt < maxAttempts) await delay(250 * attempt);
    }
    const generationError = trimText(lastError && lastError.message || lastError || 'unknown', 500);
    console.warn('[ProactiveMessage] using fallback after model attempts failed', {
      taskId: setting.id || '',
      characterId: character.id || setting.character_id || '',
      provider: character.provider || 'custom',
      model: character.model || '',
      error: generationError
    });
    return {
      content: proactiveFallbackMessage(character, recent, currentTime),
      reasoning_content: '',
      generatedByFallback: true,
      generationAttempts: maxAttempts,
      generationError,
      provider: character.provider || 'custom',
      model: character.model || ''
    };
  }

  function windowsNotify(title, body) {
    if (process.platform !== 'win32' || process.env.IB_ACTIVE_DISABLE_NOTIFICATIONS === '1') return;
    const quote = value => String(value || '').replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n=New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon=[System.Drawing.SystemIcons]::Information',
      `$n.BalloonTipTitle='${quote(trimText(title, 64))}'`,
      `$n.BalloonTipText='${quote(trimText(body, 220))}'`,
      '$n.Visible=$true',
      '$n.ShowBalloonTip(7000)',
      'Start-Sleep -Seconds 8',
      '$n.Dispose()'
    ].join(';');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      }).unref();
    } catch (_) {
      // The message remains in the durable queue even if an OS notification fails.
    }
  }

  return {
    proactiveLog, currentTimeText, elapsedText, recentProactiveMessages, proactiveModeGuide,
    buildProactivePrompt, contentText, responseParts, fetchJson, isLoopbackEndpoint,
    hasCharacterCredential, isCharacterModelReady, callCharacterModel, visibleProactiveReply,
    proactiveTextKey, proactiveTextSimilarity, validateProactiveReply, proactiveFallbackMessage,
    delay, generateProactiveMessage, windowsNotify
  };
}

module.exports = createModelClient;
