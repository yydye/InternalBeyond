/* ====================================================================
   IB · P21-R4-PROD-1.1 · Cognitive Runtime Settings（产品控制面 UI）
   --------------------------------------------------------------------
   位置：Settings Center → 「记忆与认知」→ 按角色配置区。

   ── 它是什么 ────────────────────────────────────────────────────────
   一个**自挂载**的小模块：在 `#settings-memory-content` 里追加一个克制的 `api-section`，
   按角色读取/写入两个既有认知开关：
       自动解释（autoInterpretationEnabled）· 预测与行为（autoExpectationEnabled）
   BehaviorEffect（行为影响）**没有开关**：它是确定性投影，+0 次模型调用。

   ── 它不是权威（结构性）──────────────────────────────────────────────
   · 不持有 token、不拼请求：每次读/写都经**既有**的已认证客户端
     （IB.homeNode.runtime.runCognitivePolicy → home-node-client `_request`）。
   · 不写 localStorage / IndexedDB / 文件：本模块**只有** DOM 与一次服务端往返。
   · 不乐观：toggle 点击后先进入 saving，最终状态**只**来自服务端返回
     （set 的响应即服务端持久化后的状态；链尾再做一次权威 readback）。
   · 不做第二个成本位、不发第三个 bit。
   · 状态矩阵由**服务端**权威层裁决（OFF/ON 会被拒）；本模块只做同样规则下的
     友好联动（关 I 时若 E 在开，一次原子写 I=false,E=false），并且永远以
     服务端返回为准。

   ── 可测性 ──────────────────────────────────────────────────────────
   纯状态机（planToggle / needsConfirmation / dependencyNotice / errorText）
   在 Node 里可直接 require 测试；DOM 层可通过注入 deps（doc/win/client）驱动。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else {
    root.IB = root.IB || {};
    root.IB.CognitiveRuntimeSettings = factory();
    /* 自挂载：页面只需要多一行 `<script src>`，不需要新的 mount markup
       （§21：HTML 只允许最小 script include）。DOM 未就绪时 autoMount 自己等
       DOMContentLoaded；失败一律静默（设置面消失，不影响任何其它功能）。 */
    try { root.IB.CognitiveRuntimeSettings.autoMount(); } catch (_) { }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var SECTION_ID = 'cognitive-runtime-section';
  var MAX_EXTRA_CALLS_PER_TURN = 2;

  /* ── 纯状态机：UI 意图 → 一次原子 mutation 的载荷 ──────────────────
     规则（与 server 的冻结矩阵同构）：
       · 开/关「自动解释」：只改 I；**关** I 时若 E 在开，则一次原子写 I=false,E=false
         （否则会形成非法 OFF/ON）——绝不连发两次写请求。
       · 开「预测与行为」：要求 I=ON（UI 已 disabled；此处再挡一次），一次写 I=true,E=true。
       · 关「预测与行为」：只改 E。
     返回 { ok:true, next:{autoInterpretationEnabled, autoExpectationEnabled} }
     或 { ok:false, reason:'expectation-requires-interpretation' }。 */
  function planToggle(current, which, next) {
    var i = !!(current && current.autoInterpretationEnabled);
    var e = !!(current && current.autoExpectationEnabled);
    if (which === 'interpretation') {
      if (next === true) return { ok: true, next: { autoInterpretationEnabled: true, autoExpectationEnabled: e } };
      return { ok: true, next: { autoInterpretationEnabled: false, autoExpectationEnabled: false } };
    }
    if (which === 'expectation') {
      if (next === true) {
        if (!i) return { ok: false, reason: 'expectation-requires-interpretation' };
        return { ok: true, next: { autoInterpretationEnabled: true, autoExpectationEnabled: true } };
      }
      return { ok: true, next: { autoInterpretationEnabled: i, autoExpectationEnabled: false } };
    }
    return { ok: false, reason: 'unknown-toggle' };
  }

  /* 「预测与行为」在 I=OFF 时必须 disabled（UI 不偷偷联动开启 I）。 */
  function expectationDisabled(current) { return !(current && current.autoInterpretationEnabled); }

  /* 成本确认只针对 **OFF → ON** 这一次显式启用操作。 */
  function needsConfirmation(current, which, next) {
    if (next !== true) return false;
    if (which === 'interpretation') return !(current && current.autoInterpretationEnabled);
    if (which === 'expectation') return !(current && current.autoExpectationEnabled);
    return false;
  }
  function confirmationText(which) {
    if (which === 'interpretation') return '自动解释最多会增加 1 次模型调用 / 角色回合。确认开启？';
    return '预测与行为最多会再增加 1 次模型调用 / 角色回合。完整认知模式最多 +2 次。确认开启？';
  }
  /* 关 I 而 E 在开：一次依赖确认（随后一次原子写 I=false,E=false）。 */
  function dependencyNotice(current, which, next) {
    if (which === 'interpretation' && next === false && current && current.autoExpectationEnabled) {
      return '关闭自动解释也会关闭预测与行为。确认关闭？';
    }
    return null;
  }

  /* 成本口径：永远"最多"，绝不承诺"每回合一定调用几次"。 */
  function statusText(state) {
    if (!state) return '载入中…';
    if (state.autoInterpretationEnabled && state.autoExpectationEnabled) {
      return '已启用：自动解释 + 预测与行为（最多 +' + MAX_EXTRA_CALLS_PER_TURN + ' 次模型调用 / 角色回合）';
    }
    if (state.autoInterpretationEnabled) return '已启用：自动解释（最多 +1 次模型调用 / 角色回合）';
    return '已关闭（不会产生额外的认知模型调用）';
  }

  function errorText(res) {
    var code = String((res && (res.error || res.reasonCode)) || '');
    if (code === 'unauthenticated' || code === 'remote-admin-disabled' || code === 'desktop-token-required') {
      return 'Home Node 桌面凭据不可用，未保存。';
    }
    if (code === 'illegal-cognitive-state') return '状态不合法：预测与行为需要自动解释先开启。未保存。';
    if (code === 'request-field-forbidden') return '请求被拒绝（闭集契约），未保存。';
    if (code === 'policy-file-unusable') return '策略文件不可用，未保存。请检查 Home Node 上的 runtime-policy.json。';
    if (code === 'invalid-character-id') return '角色无效，未保存。';
    if (code === 'invalid-value' || code === 'invalid-operation') return '请求形状无效，未保存。';
    if (code === 'runtime-remote-missing' || code === 'network' || !code) return 'Home Node 不可用，未保存。';
    return '保存失败（' + code + '），未保存。';
  }
  function readErrorText(res) {
    var code = String((res && (res.reasonCode && (res.reasonCode.interpretation || res.reasonCode.expectation))) || '');
    if (res && res.readable === false) return '策略文件不可用，当前显示为安全的默认值（关闭）。';
    if (code && code !== 'policy-file-missing' && code !== 'expectation-section-missing' && code !== 'global-default') {
      return '读取异常（' + code + '）。';
    }
    return null;
  }

  /* ── DOM 层 ──────────────────────────────────────────────────────── */
  function mount(deps) {
    var d = deps || {};
    var doc = d.doc || (typeof document !== 'undefined' ? document : null);
    var win = d.win || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return null;
    var host = doc.getElementById('settings-memory-content') || doc.getElementById('page-api');
    if (!host) return null;
    if (doc.getElementById(SECTION_ID)) return null;   /* 幂等：自挂载只做一次 */

    var client = d.client || function (input, options) {
      var rt = win.IB && win.IB.homeNode && win.IB.homeNode.runtime;
      if (!rt || typeof rt.runCognitivePolicy !== 'function') {
        return Promise.resolve({ ok: false, error: 'runtime-remote-missing', reasonCode: 'runtime-remote-missing' });
      }
      return rt.runCognitivePolicy(input, options);
    };
    var listCharacters = d.listCharacters || function () {
      try {
        if (typeof win.dbGetAll === 'function') {
          return Promise.resolve(win.dbGetAll('apiConfigs')).then(function (rows) {
            return (Array.isArray(rows) ? rows : []).map(function (r) { return { id: String((r && r.id) || ''), name: String((r && (r.nickname || r.name || r.id)) || '') }; })
              .filter(function (r) { return !!r.id; });
          }, function () { return []; });
        }
      } catch (_) { }
      return Promise.resolve([]);
    };
    var confirmFn = d.confirm || function (msg) { return win.confirm ? win.confirm(msg) : true; };
    var toast = d.toast || function (msg) { try { if (typeof win.toast === 'function') win.toast(msg); } catch (_) { } };

    var el = function (tag, attrs, text) {
      var n = doc.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'for') n.setAttribute('for', attrs[k]);
        else if (k === 'hidden') { if (attrs[k]) n.setAttribute('hidden', ''); }
        else n.setAttribute(k, attrs[k]);
      });
      if (text != null) n.textContent = String(text);
      return n;
    };

    var section = el('div', { class: 'api-section api-paper', id: SECTION_ID });
    section.appendChild(el('h3', {}, '高级认知'));
    section.appendChild(el('p', { class: 'settings-description' },
      '按角色控制认知运行时。下面两项显示的都是**最多**的模型调用上界：零记忆、通道不合格、解释/期望校验失败、重放、凭据不可用都会让实际值降到 0。'));

    var charRow = el('div', { class: 'api-form-group' });
    charRow.appendChild(el('label', { for: 'cognitive-runtime-character' }, '角色'));
    var charSel = el('select', { id: 'cognitive-runtime-character' });
    charRow.appendChild(charSel);
    section.appendChild(charRow);

    function rowToggle(id, title, hint) {
      var wrap = el('div', { class: 'api-form-group' });
      var label = el('label', { class: 'form-check-row', for: id });
      var input = el('input', { type: 'checkbox', id: id, class: 'u-native-check' });
      label.appendChild(input);
      label.appendChild(doc.createTextNode(' ' + title));
      wrap.appendChild(label);
      wrap.appendChild(el('div', { class: 'field-hint' }, hint));
      return { wrap: wrap, input: input };
    }
    var iRow = rowToggle('cognitive-runtime-interpretation', '自动解释',
      '回合后形成对已召回记忆的主观解释 · 最多 +1 次模型调用 / 角色回合');
    var eRow = rowToggle('cognitive-runtime-expectation', '预测与行为',
      '形成预期，并有限影响后续回合的行为 · 最多再 +1 次模型调用 / 角色回合');
    var eNote = el('div', { class: 'field-hint', id: 'cognitive-runtime-expectation-note', hidden: true }, '需要先开启自动解释');
    eRow.wrap.appendChild(eNote);
    section.appendChild(iRow.wrap);
    section.appendChild(eRow.wrap);

    var beRow = el('div', { class: 'api-form-group' });
    beRow.appendChild(el('div', {}, '行为影响：自动'));
    beRow.appendChild(el('div', { class: 'field-hint' }, '确定性 · 不调用模型 · 没有独立开关'));
    section.appendChild(beRow);

    var status = el('div', { class: 'field-hint', id: 'cognitive-runtime-status', role: 'status' });
    status.setAttribute('aria-live', 'polite');
    status.textContent = '载入中…';
    section.appendChild(status);

    host.appendChild(section);

    /* ── 运行时状态：**没有**任何持久化；权威永远来自服务端返回 ────────── */
    var state = {
      characterId: '',
      autoInterpretationEnabled: false,
      autoExpectationEnabled: false,
      loaded: false,
      busy: false
    };
    var gen = 0;              /* generation guard：晚返回不得覆盖新页面（§17/§18） */
    var chain = Promise.resolve();   /* per-section mutation serialization */

    function render(extra) {
      iRow.input.checked = !!state.autoInterpretationEnabled;
      eRow.input.checked = !!state.autoExpectationEnabled;
      var dis = expectationDisabled(state) || state.busy || !state.loaded;
      eRow.input.disabled = dis;
      eNote.hidden = !expectationDisabled(state);
      iRow.input.disabled = state.busy || !state.loaded;
      status.textContent = extra || statusText(state);
    }

    function setBusy(on) { state.busy = !!on; render(on ? '保存中…' : null); }

    function readFor(characterId) {
      var myGen = ++gen;
      state.characterId = characterId;
      state.loaded = false;
      state.busy = false;
      render('载入中…');
      return Promise.resolve(client({ operation: 'read', characterId: characterId })).then(function (res) {
        if (myGen !== gen) return null;                      /* 已被更新的角色/操作取代 */
        if (!res || res.ok !== true) {
          state.loaded = false;
          state.autoInterpretationEnabled = false;
          state.autoExpectationEnabled = false;
          render(errorText(res) || '读取失败。');
          return res;
        }
        state.loaded = true;
        state.autoInterpretationEnabled = res.autoInterpretationEnabled === true;
        state.autoExpectationEnabled = res.autoExpectationEnabled === true;
        render(readErrorText(res) || statusText(state));      /* §16：坏文件 = OFF/OFF **并且** 明说异常 */
        return res;
      }, function () {
        if (myGen !== gen) return null;
        state.loaded = false;
        render('Home Node 不可用，读取失败。');
        return null;
      });
    }

    function mutate(which, next) {
      if (!state.loaded) return Promise.resolve(null);
      var plan = planToggle(state, which, next);
      if (!plan.ok) { status.textContent = '需要先开启自动解释。'; return Promise.resolve(null); }
      if (needsConfirmation(state, which, next) && !confirmFn(confirmationText(which))) { render(); return Promise.resolve(null); }
      var notice = dependencyNotice(state, which, next);
      if (notice && !confirmFn(notice)) { render(); return Promise.resolve(null); }
      /* 写请求串行化；每次都以**最新权威状态**重算载荷，避免旧意图覆盖新状态 */
      chain = chain.then(function () {
        var myGen = ++gen;
        setBusy(true);
        var payload = Object.assign({ operation: 'set', characterId: state.characterId }, plan.next);
        return Promise.resolve(client(payload)).then(function (res) {
          if (myGen !== gen) return null;                    /* 被更新的操作取代 */
          if (!res || res.ok !== true) {
            /* 非乐观：失败 ⇒ 回到**服务端权威**的上一状态，并明说"未保存" */
            setBusy(false);
            status.textContent = errorText(res);
            toast(errorText(res));
            return null;
          }
          state.autoInterpretationEnabled = res.autoInterpretationEnabled === true;
          state.autoExpectationEnabled = res.autoExpectationEnabled === true;
          setBusy(false);
          render('已保存 · ' + statusText(state));
          return res;
        }, function () {
          if (myGen !== gen) return null;
          setBusy(false);
          status.textContent = 'Home Node 不可用，未保存。';
          return null;
        });
      });
      return chain.then(function () {
        /* 链尾 readback：最终 UI **只**由服务端当前状态决定 */
        return readFor(state.characterId);
      });
    }

    iRow.input.addEventListener('change', function () { mutate('interpretation', iRow.input.checked); });
    eRow.input.addEventListener('change', function () {
      if (expectationDisabled(state)) { eRow.input.checked = false; status.textContent = '需要先开启自动解释。'; return; }
      mutate('expectation', eRow.input.checked);
    });
    charSel.addEventListener('change', function () { readFor(charSel.value); });

    function fillCharacters() {
      return Promise.resolve(listCharacters()).then(function (rows) {
        charSel.textContent = '';
        rows.forEach(function (r) {
          var opt = doc.createElement('option');
          opt.value = r.id;
          opt.textContent = r.name || r.id;
          charSel.appendChild(opt);
        });
        var preferred = String((win.activeFriendId || (win.opts && win.opts.characterId) || '') || '');
        var pick = rows.some(function (r) { return r.id === preferred; }) ? preferred : (rows[0] ? rows[0].id : '');
        if (pick) charSel.value = pick;
        return pick;
      });
    }

    var handle = {
      VERSION: VERSION,
      SECTION_ID: SECTION_ID,
      state: state,
      refresh: function () { return fillCharacters().then(function (id) { return id ? readFor(id) : null; }); },
      element: section
    };
    render('载入中…');
    handle.refresh();
    return handle;
  }

  /* 自挂载：DOM 就绪后挂一次；并在设置页每次打开时刷新（包装现有全局入口，
     不修改任何其它模块的源码 —— §23 的纪律）。 */
  function autoMount(deps) {
    var d = deps || {};
    var win = d.win || (typeof window !== 'undefined' ? window : null);
    var doc = d.doc || (typeof document !== 'undefined' ? document : null);
    if (!win || !doc) return null;
    var handle = null;
    function ensure() {
      if (!handle) handle = mount(d);
      return handle;
    }
    function boot() {
      ensure();
      try {
        if (typeof win.loadApiSettingsUI === 'function' && !win.loadApiSettingsUI.__ibCognitiveWrapped) {
          var orig = win.loadApiSettingsUI;
          var wrapped = function () {
            var r = orig.apply(this, arguments);
            try { var h = ensure(); if (h) h.refresh(); } catch (_) { }
            return r;
          };
          wrapped.__ibCognitiveWrapped = true;
          win.loadApiSettingsUI = wrapped;
        }
      } catch (_) { }
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
    return { ensure: ensure, boot: boot };
  }

  return {
    VERSION: VERSION,
    SECTION_ID: SECTION_ID,
    MAX_EXTRA_CALLS_PER_TURN: MAX_EXTRA_CALLS_PER_TURN,
    planToggle: planToggle,
    expectationDisabled: expectationDisabled,
    needsConfirmation: needsConfirmation,
    confirmationText: confirmationText,
    dependencyNotice: dependencyNotice,
    statusText: statusText,
    errorText: errorText,
    readErrorText: readErrorText,
    mount: mount,
    autoMount: autoMount
  };
});
