'use strict';

/* ====================================================================
   PROVIDER DIRECTORY —— 唯一 canonical provider metadata 源
   --------------------------------------------------------------------
   · 唯一一份 PROVIDERS 字面量 + providerFormat() 归约在此。
   · social.js（浏览器 window.PROVIDERS 兼容暴露）与
     ib-model-core.js（runtime-neutral UMD）都从这里取数，
     不再各自维护第二份 provider metadata 字面量。
   · 这里**只**承载 provider metadata / PROVIDERS / providerFormat。
     绝不塞入 request builder、response parser、API client、
     streaming handler、auth、ModelAdapter 等架构。

   加载方式:
     - Node   : const { PROVIDERS, providerFormat } = require('./assets/js/provider-directory.js');
     - Browser: 先于 social.js 用 <script> 加载 → window.PROVIDERS_DIR
   ==================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PROVIDERS_DIR = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 唯一 canonical provider 目录（照搬自 browser social.js window.PROVIDERS 字面量，
     逐字段一致，不改变任何 provider 元数据）。 */
  var PROVIDERS = {
    anthropic: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6', format: 'anthropic', vision: true, streaming: true },
    openai: { name: 'GPT', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', format: 'openai', vision: true, streaming: true },
    grok: { name: 'Grok', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4', format: 'openai', vision: true, streaming: true },
    deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', format: 'openai', vision: true, streaming: true, showThinking: true },
    gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-2.0-flash', format: 'gemini', vision: true, streaming: true },
    glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', format: 'openai', vision: true, streaming: true, showThinking: false },
    qwen: { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', format: 'openai', vision: true, streaming: true },
    doubao: { name: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-seed-2-0-lite', format: 'openai', vision: true, streaming: true },
    moonshot: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6', format: 'openai', vision: true, streaming: true },
    mimo: { name: 'MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5', format: 'openai', vision: true, streaming: true, showThinking: true },
    minimax: { name: 'MiniMax', endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2', model: 'MiniMax-Text-01', format: 'openai', vision: false, streaming: true },
    yi: { name: '零一万物', endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions', model: 'yi-lightning', format: 'openai', vision: false, streaming: true },
    baichuan: { name: '百川', endpoint: 'https://api.baichuan-ai.com/v1/chat/completions', model: 'Baichuan4', format: 'openai', vision: false, streaming: true },
    mistral: { name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', format: 'openai', vision: false, streaming: true },
    custom: { name: 'Custom', endpoint: '', model: '', format: 'openai', vision: true, streaming: true }
  };

  /* provider → wire format（model-client 分支保持一致：anthropic/gemini/else-openai） */
  function providerFormat(provider) {
    return (PROVIDERS[provider] && PROVIDERS[provider].format) || 'openai';
  }

  return {
    PROVIDERS: PROVIDERS,
    providerFormat: providerFormat
  };
});
