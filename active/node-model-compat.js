/* ====================================================================
   IB Active · Node Model Compatibility Layer (Phase 5B)
   --------------------------------------------------------------------
   ModelPort 之上的最小 execution compatibility layer，为未来 Proactive
   使用 Node ModelPort 做准备。它只做两件事：
     1. 兼容性重试（callCharacterModel 现有的两种，仅此两种）：
        - OpenAI max_tokens ↔ max_completion_tokens 协商
        - jsonMode(response_format) 被拒 → 降级重试
     2. legacy `<thinking>` 输出归一（responseParts 语义逐字一致）

   明确边界：
   - 不放 isCharacterModelReady（属 Character/Proactive Domain 业务校验）
   - 不放 scheduler / plan-domain / DND / dedup / fallback / 状态机 / Proactive prompt
   - 不新增 retry / streaming / continuation / cache；不改 provider 行为
   - 不修改 model-client.js（responseParts/contentText 在此为忠实副本，供本层复用）

   结构：
     compat.run(request, options)
        ├─ modelPort.run(request)              （attempt 1）
        ├─ 特定兼容失败 → modelPort.run(调整后) （attempt 2，仅一次）
        └─ responseParts(result.text, result.reasoning)
           → { content, reasoning_content }
   ==================================================================== */
'use strict';

/* ---- legacy thinking 归一：与 active/model-client.js 的 contentText/responseParts 逐字一致 ---- */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (part) {
      if (typeof part === 'string') return part;
      return (part && (part.text || part.content)) || '';
    }).join('');
  }
  return content == null ? '' : String(content);
}

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

function createNodeModelCompat(deps) {
  deps = deps || {};
  const modelPort = deps.modelPort;
  if (!modelPort || typeof modelPort.run !== 'function') {
    throw new Error('NodeModelCompat: modelPort with .run() is required');
  }
  const _contentText = deps.contentText || contentText;
  const _responseParts = deps.responseParts || responseParts;

  /* 单次 attempt：委托 modelPort.run（ModelPort 每次只执行一次） */
  async function _attempt(request, options) {
    return await modelPort.run(request, options);
  }

  /* 兼容性重试判定（仅还原 callCharacterModel 现有两种）：jsonMode 优先，其次 max_completion_tokens */
  async function _retry(request, options, error) {
    const msg = String((error && error.message) || '');
    if (request && request.jsonMode && /response_format|json[ _-]?mode|json_object/i.test(msg)) {
      return await _attempt(Object.assign({}, request, { jsonMode: false }), options);
    }
    if (/max_completion_tokens/i.test(msg) && /max_tokens|unsupported|not supported/i.test(msg)) {
      return await _attempt(Object.assign({}, request, { tokenParam: 'max_completion_tokens' }), options);
    }
    /* MiMo(Xiaomi) 端点：报错文案不可依赖（MiMo 可能只含 max_tokens 而不含 max_completion_tokens）。
       按 provider 或 endpoint 判定并直接切参数重试一次，与 node-model-port 的确定性修正同源。已切过则不再重试。 */
    if (request && request.spec
        && ((String(request.spec.provider || '').toLowerCase() === 'mimo') || /xiaomimimo\.com/i.test(String(request.spec.endpoint || '')))
        && !(request.tokenParam === 'max_completion_tokens')) {
      return await _attempt(Object.assign({}, request, { tokenParam: 'max_completion_tokens' }), options);
    }
    throw error; /* 不可恢复：传播 */
  }

  async function run(request, options) {
    options = options || {};
    let result;
    try {
      result = await _attempt(request, options);
    } catch (error) {
      result = await _retry(request, options, error); /* _retry 内部对不可恢复错误 throw */
    }
    /* legacy 归一（若后续想用自定义 responseParts，经 deps.responseParts 注入） */
    const rp = _responseParts(result && result.text, result && result.reasoning);
    return { content: rp.content, reasoning_content: rp.reasoning_content };
  }

  return { run: run };
}

module.exports = createNodeModelCompat;
