/* Expression Pack management and manual per-message display.
 * Images, pack bindings, and message selections are persisted on apiConfigs. */
(function (window) {
  'use strict';

  var Core = window.IBExpressionPackCore;
  var DIALOG_ID = 'ib-expression-pack-dialog';
  var _roleId = '';
  var _config = null;
  var _dialog = null;

  function byId(id) { return document.getElementById(id); }
  function allConfigs() {
    return (Array.isArray(window.apiConfigs) ? window.apiConfigs : []).concat(Array.isArray(window.archivedConfigs) ? window.archivedConfigs : []);
  }
  function findConfig(id) {
    var rows = allConfigs(), key = String(id || '');
    for (var i = 0; i < rows.length; i++) if (String(rows[i] && rows[i].id || '') === key) return rows[i];
    return null;
  }
  function makeId(prefix) {
    var uuid = '';
    try { uuid = window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : ''; } catch (e) { }
    return String(prefix || 'expr') + '_' + (uuid || (Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12)));
  }
  function ensureDialog() {
    if (_dialog && document.body.contains(_dialog)) return _dialog;
    _dialog = document.createElement('div');
    _dialog.id = DIALOG_ID;
    _dialog.className = 'ib-expression-dialog';
    _dialog.setAttribute('role', 'dialog');
    _dialog.setAttribute('aria-modal', 'true');
    _dialog.setAttribute('aria-labelledby', 'ib-expression-title');
    _dialog.hidden = true;
    _dialog.innerHTML = '<section class="ib-expression-panel">'
      + '<header class="ib-expression-head"><div><span class="ib-expression-eyebrow">EXPRESSION PACK</span><h2 id="ib-expression-title">角色表情</h2><p id="ib-expression-role-name"></p></div>'
      + '<button type="button" class="btn ib-expression-close" data-expression-close aria-label="关闭表情管理">关闭</button></header>'
      + '<div class="ib-expression-pack-row"><label for="ib-expression-pack-select">当前绑定</label><select id="ib-expression-pack-select"></select>'
      + '<button type="button" class="btn" id="ib-expression-delete-pack">删除表情包</button></div>'
      + '<div class="ib-expression-grid" id="ib-expression-items"></div>'
      + '<section class="ib-expression-defaults"><div><h3>Expression Defaults</h3><p>按客户端状态显示，不会分析消息情绪。</p></div>'
      + '<div class="ib-expression-default-grid">'
      + '<label for="ib-expression-default-neutralExpression">默认状态</label><select id="ib-expression-default-neutralExpression"></select>'
      + '<label for="ib-expression-default-greetingExpression">进入聊天</label><select id="ib-expression-default-greetingExpression"></select>'
      + '<label for="ib-expression-default-typingExpression">输入中</label><select id="ib-expression-default-typingExpression"></select>'
      + '<label for="ib-expression-default-voiceExpression">播放语音</label><select id="ib-expression-default-voiceExpression"></select>'
      + '<label for="ib-expression-default-errorExpression">异常状态（可选）</label><select id="ib-expression-default-errorExpression"></select>'
      + '</div><button type="button" class="btn" id="ib-expression-save-defaults">保存默认表情</button></section>'
      + '<section class="ib-expression-runtime-settings"><div><h3>自动表现</h3><p>只用本地规则与可选标记，不增加模型调用。</p></div>'
      + '<label class="ib-expression-setting"><input type="checkbox" id="ib-expression-auto-enabled"><span>允许自动表情与可选标记</span></label>'
      + '<label class="ib-expression-setting"><input type="checkbox" id="ib-expression-motion-enabled"><span>允许轻量表情动作</span></label></section>'
      + '<div class="ib-expression-upload"><div class="ib-expression-upload-title">添加表情</div>'
      + '<div class="ib-expression-add-row"><input type="text" id="ib-expression-name" maxlength="48" placeholder="表情名称，例如：开心">'
      + '<button type="button" class="btn btn-primary" id="ib-expression-upload-btn">选择图片</button>'
      + '<input type="file" id="ib-expression-file" accept="image/*" hidden></div>'
      + '<p class="ib-expression-hint">支持图片；保存时会缩放到 256px 并压缩，表情只保存在角色配置中。</p></div>'
      + '<div class="ib-expression-create"><label for="ib-expression-new-pack">新建表情包</label>'
      + '<div class="ib-expression-add-row"><input type="text" id="ib-expression-new-pack" maxlength="40" placeholder="表情包名称">'
      + '<button type="button" class="btn" id="ib-expression-create-pack">创建并绑定</button></div></div>'
      + '<p class="ib-expression-status" id="ib-expression-status" role="status" aria-live="polite"></p>'
      + '</section>';
    document.body.appendChild(_dialog);
    _dialog.addEventListener('click', function (event) {
      if (event.target === _dialog || event.target.closest('[data-expression-close]')) close();
      var remove = event.target.closest('[data-expression-delete]');
      if (remove) removeExpression(remove.dataset.expressionDelete);
    });
    byId('ib-expression-pack-select').addEventListener('change', selectPack);
    byId('ib-expression-delete-pack').addEventListener('click', deletePack);
    byId('ib-expression-create-pack').addEventListener('click', createPack);
    byId('ib-expression-new-pack').addEventListener('input', updateCreatePackButton);
    byId('ib-expression-save-defaults').addEventListener('click', saveExpressionDefaults);
    byId('ib-expression-auto-enabled').addEventListener('change', saveExpressionSettings);
    byId('ib-expression-motion-enabled').addEventListener('change', saveExpressionSettings);
    byId('ib-expression-upload-btn').addEventListener('click', function () { byId('ib-expression-file').click(); });
    byId('ib-expression-file').addEventListener('change', uploadExpression);
    _dialog.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    return _dialog;
  }
  function setStatus(message, error) {
    var status = byId('ib-expression-status');
    if (status) {
      status.textContent = String(message || '');
      status.classList.toggle('is-error', !!error);
    }
  }
  function currentPack() { return Core.activePack(_config); }
  function defaultSelectorId(state) { return 'ib-expression-default-' + state; }
  function renderDefaultSelectors() {
    var defaults = _config && _config.expressionDefaults || {};
    Core.DEFAULT_STATES.forEach(function (state) {
      var select = byId(defaultSelectorId(state));
      if (!select) return;
      select.innerHTML = '';
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '不设置'; select.appendChild(empty);
      Core.packsOf(_config).forEach(function (pack) {
        Core.expressionsOf(pack).forEach(function (expression) {
          var option = document.createElement('option');
          option.value = JSON.stringify({ packId: pack.id, expressionId: expression.id });
          option.textContent = String(pack.name || '表情包') + ' · ' + String(expression.name || '未命名');
          var ref = defaults[state];
          option.selected = !!(ref && String(ref.packId || '') === String(pack.id) && String(ref.expressionId || '') === String(expression.id));
          select.appendChild(option);
        });
      });
    });
  }
  function renderExpressionSettings() {
    var settings = Core.settingsOf(_config);
    var automatic = byId('ib-expression-auto-enabled'), motion = byId('ib-expression-motion-enabled');
    if (automatic) automatic.checked = settings.enabled;
    if (motion) motion.checked = settings.microMotion;
  }
  function saveExpressionSettings() {
    var automatic = byId('ib-expression-auto-enabled'), motion = byId('ib-expression-motion-enabled');
    mutate(function (current) {
      return Core.setSettings(current, {
        enabled: !!(automatic && automatic.checked),
        microMotion: !!(motion && motion.checked)
      });
    }).then(function () { renderDialog(); setStatus('角色自动表现设置已保存。'); }, reportError);
  }
  function updateCreatePackButton() {
    if (!_dialog) return;
    var packs = Core.packsOf(_config), input = byId('ib-expression-new-pack'), button = byId('ib-expression-create-pack');
    if (button) button.disabled = packs.length >= Core.MAX_PACKS || !String(input && input.value || '').trim();
  }
  function renderDialog() {
    if (!_dialog || !_config || !Core) return;
    var packs = Core.packsOf(_config), active = currentPack();
    var select = byId('ib-expression-pack-select'), grid = byId('ib-expression-items');
    var title = byId('ib-expression-role-name');
    if (title) title.textContent = String(_config && (_config.nickname || _config.model) || '角色');
    select.innerHTML = '';
    if (!packs.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '尚未创建表情包'; select.appendChild(empty);
    } else {
      packs.forEach(function (pack) {
        var option = document.createElement('option'); option.value = pack.id; option.textContent = String(pack.name || '未命名表情包');
        option.selected = !!(active && pack.id === active.id); select.appendChild(option);
      });
    }
    select.disabled = !packs.length;
    byId('ib-expression-delete-pack').disabled = !active;
    var expressions = Core.expressionsOf(active);
    byId('ib-expression-upload-btn').disabled = !active || active.expressions.length >= Core.MAX_EXPRESSIONS_PER_PACK;
    grid.innerHTML = '';
    if (!active) {
      var emptyNote = document.createElement('p'); emptyNote.className = 'ib-expression-empty'; emptyNote.textContent = '先创建一个表情包，再添加角色表情。'; grid.appendChild(emptyNote);
    } else if (!expressions.length) {
      var emptyPack = document.createElement('p'); emptyPack.className = 'ib-expression-empty'; emptyPack.textContent = '这个表情包还没有图片。'; grid.appendChild(emptyPack);
    } else {
      expressions.forEach(function (expression) {
        var item = document.createElement('article'); item.className = 'ib-expression-item';
        var image = document.createElement('img'); image.src = expression.dataUrl; image.alt = String(expression.name || '角色表情'); image.loading = 'lazy';
        var name = document.createElement('span'); name.className = 'ib-expression-item-name'; name.textContent = String(expression.name || '未命名');
        var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn ib-expression-remove';
        remove.dataset.expressionDelete = expression.id; remove.textContent = '删除'; remove.setAttribute('aria-label', '删除表情 ' + String(expression.name || ''));
        item.appendChild(image); item.appendChild(name); item.appendChild(remove); grid.appendChild(item);
      });
    }
    renderDefaultSelectors();
    renderExpressionSettings();
    updateCreatePackButton();
  }
  function reloadConfigs() {
    return Promise.resolve(typeof window.loadApiConfigs === 'function' ? window.loadApiConfigs() : null).then(function () {
      return findConfig(_roleId);
    });
  }
  function save(next) {
    if (!next || !next.id || typeof window._persistApiConfig !== 'function') return Promise.reject(new Error('角色配置保存入口不可用'));
    return Promise.resolve(window._persistApiConfig(next)).then(function (result) {
      if (result && result.idb && typeof window.dbGet === 'function') return window.dbGet('apiConfigs', next.id);
      return next;
    }).then(function (persisted) {
      if (!persisted || String(persisted.id || '') !== String(next.id)) persisted = next;
      return Promise.resolve(typeof window.loadApiConfigs === 'function' ? window.loadApiConfigs() : null).then(function () {
        _config = findConfig(_roleId) || persisted;
        return _config;
      });
    });
  }
  function mutate(mutator) {
    return reloadConfigs().then(function (current) {
      if (!current) throw new Error('找不到这个角色配置');
      var next = mutator(current);
      if (!next) throw new Error('表情包设置无效或已达到数量上限');
      return save(next);
    });
  }
  function selectPack() {
    var id = String(byId('ib-expression-pack-select').value || '');
    mutate(function (current) { return Core.setActivePack(current, id); }).then(function () { renderDialog(); setStatus('已切换当前表情包。'); }, reportError);
  }
  function saveExpressionDefaults() {
    var defaults = {};
    Core.DEFAULT_STATES.forEach(function (state) {
      var select = byId(defaultSelectorId(state)), value = String(select && select.value || '');
      if (!value) return;
      try { defaults[state] = JSON.parse(value); } catch (e) { }
    });
    mutate(function (current) { return Core.setExpressionDefaults(current, defaults); }).then(function () {
      renderDialog(); setStatus('默认表情已保存到角色配置。');
    }, reportError);
  }
  function createPack() {
    var input = byId('ib-expression-new-pack'), name = String(input.value || '').trim();
    if (!name) { setStatus('先填写表情包名称。', true); return; }
    mutate(function (current) { return Core.addPack(current, makeId('pack'), name); }).then(function () {
      input.value = ''; renderDialog(); setStatus('表情包已创建并绑定到这个角色。');
    }, reportError);
  }
  function deletePack() {
    var pack = currentPack();
    if (!pack || !window.confirm('删除表情包“' + String(pack.name || '') + '”及其中的表情？')) return;
    mutate(function (current) { return Core.removePack(current, pack.id); }).then(function () { renderDialog(); setStatus('表情包已删除。'); }, reportError);
  }
  function removeExpression(expressionId) {
    var pack = currentPack(); if (!pack) return;
    mutate(function (current) { return Core.removeExpression(current, pack.id, expressionId); }).then(function () { renderDialog(); setStatus('表情已删除。'); }, reportError);
  }
  function readImage(file) {
    if (!file || !/^image\//i.test(String(file.type || '')) || Number(file.size) > 10 * 1024 * 1024) {
      return Promise.reject(new Error('请选择 10MB 以内的图片。'));
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('图片读取失败。')); };
      reader.onload = function () {
        var image = new Image();
        image.onerror = function () { reject(new Error('无法解码这张图片。')); };
        image.onload = function () {
          var width = Number(image.naturalWidth || image.width), height = Number(image.naturalHeight || image.height);
          if (!width || !height || width > 12000 || height > 12000) { reject(new Error('图片尺寸无效或过大。')); return; }
          var scale = Math.min(1, 256 / Math.max(width, height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
          var context = canvas.getContext('2d');
          if (!context) { reject(new Error('当前浏览器无法处理图片。')); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          var output = canvas.toDataURL('image/webp', 0.82);
          if (output.length > Core.MAX_IMAGE_DATA_URL_LENGTH) {
            canvas.width = Math.max(1, Math.round(canvas.width * 0.75)); canvas.height = Math.max(1, Math.round(canvas.height * 0.75));
            context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
            output = canvas.toDataURL('image/webp', 0.68);
          }
          if (output.length > Core.MAX_IMAGE_DATA_URL_LENGTH || !/^data:image\/(?:png|jpeg|webp);base64,/.test(output)) {
            reject(new Error('压缩后的图片仍然过大，请换一张较小的图片。')); return;
          }
          resolve(output);
        };
        image.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }
  function uploadExpression(event) {
    var input = event && event.target, file = input && input.files && input.files[0], pack = currentPack();
    if (!file) return;
    if (!pack) { setStatus('请先创建表情包。', true); input.value = ''; return; }
    if (pack.expressions.length >= Core.MAX_EXPRESSIONS_PER_PACK) { setStatus('这个表情包已达到数量上限。', true); input.value = ''; return; }
    var nameInput = byId('ib-expression-name');
    var fallbackName = String(file.name || '角色表情').replace(/\.[^.]+$/, '').slice(0, 48);
    var name = String(nameInput.value || fallbackName).trim().slice(0, 48);
    setStatus('正在读取图片…');
    readImage(file).then(function (dataUrl) {
      return mutate(function (current) {
        return Core.addExpression(current, pack.id, { id: makeId('expression'), name: name || fallbackName || '表情', dataUrl: dataUrl });
      });
    }).then(function () { renderDialog(); nameInput.value = ''; setStatus('表情已添加到角色配置。'); }, reportError)
      .finally(function () { input.value = ''; });
  }
  function reportError(error) {
    setStatus(String(error && error.message || '保存失败，请重试。'), true);
  }
  function open(roleId) {
    _roleId = String(roleId || '');
    if (!_roleId) return Promise.resolve(false);
    ensureDialog(); _dialog.hidden = false; _dialog.classList.add('is-open'); document.body.classList.add('ib-expression-dialog-open');
    setStatus('');
    return reloadConfigs().then(function (config) {
      if (!config) { close(); throw new Error('找不到这个角色配置'); }
      _config = config; renderDialog(); byId('ib-expression-pack-select').focus(); return true;
    }).catch(function (error) { reportError(error); return false; });
  }
  function close() {
    if (!_dialog) return;
    _dialog.hidden = true; _dialog.classList.remove('is-open'); document.body.classList.remove('ib-expression-dialog-open');
  }
  function reloadForRole(roleId) {
    return Promise.resolve(typeof window.loadApiConfigs === 'function' ? window.loadApiConfigs() : null).then(function () {
      var rows = allConfigs(), id = String(roleId || '');
      for (var i = 0; i < rows.length; i++) if (String(rows[i] && rows[i].id || '') === id) return rows[i];
      return null;
    });
  }
  function persistMessageExpression(roleId, messageId, packId, expressionId) {
    return reloadForRole(roleId).then(function (current) {
      if (!current) throw new Error('角色配置已不可用');
      var next = Core.setMessageExpression(current, messageId, packId, expressionId);
      if (!next) throw new Error('表情选择无效');
      return Promise.resolve(window._persistApiConfig(next)).then(function (result) {
        if (result && result.idb && typeof window.dbGet === 'function') return window.dbGet('apiConfigs', next.id);
        return next;
      }).then(function (saved) {
        return Promise.resolve(typeof window.loadApiConfigs === 'function' ? window.loadApiConfigs() : null).then(function () {
          return findConfig(roleId) || saved || next;
        });
      });
    });
  }
  var _transientSelections = Object.create(null);
  var _transientTexts = Object.create(null);
  var _transientSelectionOrder = [];
  var MAX_TRANSIENT_SELECTIONS = 800;
  function transientKey(roleId, messageId) { return String(roleId || '') + '\u0000' + String(messageId || ''); }
  function touchTransientKey(key) {
    _transientSelectionOrder = _transientSelectionOrder.filter(function (item) { return item !== key; });
    _transientSelectionOrder.push(key);
    while (_transientSelectionOrder.length > MAX_TRANSIENT_SELECTIONS) {
      var old = _transientSelectionOrder.shift(); delete _transientSelections[old]; delete _transientTexts[old];
    }
  }
  function rememberMessageExpression(roleId, messageId, ref) {
    var key = transientKey(roleId, messageId), cfg = findConfig(roleId);
    if (!roleId || !messageId || !cfg || !ref || !Core || typeof Core.packById !== 'function') return false;
    var pack = Core.packById(cfg, ref.packId), expression = pack && Core.expressionsOf(pack).find(function (item) {
      return String(item.id || '') === String(ref.expressionId || '');
    });
    if (!expression) return false;
    _transientSelections[key] = { packId: String(pack.id), expressionId: String(expression.id) };
    touchTransientKey(key);
    return true;
  }
  function rememberMessageText(roleId, messageId, value) {
    var key = transientKey(roleId, messageId);
    if (!roleId || !messageId || typeof value !== 'string') return false;
    _transientTexts[key] = value.slice(0, 5000); touchTransientKey(key); return true;
  }
  function parseReply(roleId, value) {
    return Core.parseReplyExpressions(String(value == null ? '' : value), findConfig(roleId));
  }
  function promptHint(roleId) {
    var cfg = findConfig(roleId), settings = cfg && Core.settingsOf(cfg), active = cfg && Core.activePack(cfg);
    if (!cfg || !settings || !settings.enabled || settings.modelTags === false || !active || !Core.expressionsOf(active).length) return '';
    return '【可选角色表情标记】表情完全可选，不要为每条回复添加。只有确有帮助时，才可在对应消息开头单独写一个标记：[[expression:happy]]、[[expression:sad]]、[[expression:surprised]]、[[expression:thinking]]、[[expression:shy]] 或 [[expression:laugh]]。只在自然时使用；标记不会显示给用户。没有合适的表情就不写。';
  }
  function prefersReducedMotion() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      var root = document.documentElement, body = document.body;
      return !!((root && (root.dataset.reducedMotion === 'true' || root.dataset.motion === 'off'))
        || (body && (body.dataset.reducedMotion === 'true' || body.dataset.motion === 'off')));
    } catch (e) { return false; }
  }
  function decorateMessage(roleId, messageId, messageElement, options) {
    var cfg = options && options.config || findConfig(roleId), msgId = String(messageId || '');
    if (!Core || !cfg || !msgId || !messageElement) return false;
    var packs = Core.packsOf(cfg), manualSelection = Core.messageExpression(cfg, msgId);
    var key = transientKey(roleId, msgId), transient = _transientSelections[key] || null;
    var rawText = options && Object.prototype.hasOwnProperty.call(options, 'text') ? String(options.text || '') : _transientTexts[key];
    if (typeof rawText === 'string') { _transientTexts[key] = rawText.slice(0, 5000); touchTransientKey(key); }
    var stateOverride = String(options && options.stateOverride || '');
    var selected = Core.resolveMessageExpression(cfg, {
      messageId: msgId, stateOverride: stateOverride, modelExpressionRef: transient,
      text: rawText || ''
    });
    var selectedKey = selected ? String(selected.pack.id) + ':' + String(selected.expression.id) : '';
    if (stateOverride && selected && selected.source === 'state') messageElement.dataset.ibExpressionStateRoleId = String(roleId || '');
    else if (messageElement.dataset) delete messageElement.dataset.ibExpressionStateRoleId;
    var previous = messageElement.querySelector('.ib-expression-message-tools');
    if (previous) previous.remove();
    var priorDisplay = messageElement.querySelector('.ib-expression-message-display');
    var priorKey = priorDisplay && priorDisplay.dataset.expressionKey || '';
    if (!selected || priorKey !== selectedKey) { if (priorDisplay) priorDisplay.remove(); priorDisplay = null; }
    if (!packs.length && !selected) return false;
    var contentHost = options && options.contentHost || messageElement;
    if (selected) {
      var display = priorDisplay || document.createElement('div');
      display.className = 'ib-expression-message-display';
      display.dataset.expressionKey = selectedKey;
      display.dataset.expressionState = stateOverride && selected.source === 'state'
        ? stateOverride : (selected.source || 'neutralExpression');
      display.dataset.expressionSource = String(selected.source || 'neutralExpression');
      display.dataset.expressionRoleId = String(roleId || '');
      var canAnimate = Core.settingsOf(cfg).microMotion && !prefersReducedMotion();
      if (canAnimate && selected.action) display.dataset.action = selected.action;
      else delete display.dataset.action;
      if (!priorDisplay) {
        var image = document.createElement('img'); image.src = selected.expression.dataUrl;
        image.alt = String(selected.expression.name || '角色表情'); image.loading = 'lazy';
        image.decoding = 'async'; image.className = 'ib-expression-message-image'; display.appendChild(image);
        var caption = document.createElement('span'); caption.className = 'ib-expression-message-caption';
        caption.textContent = String(selected.expression.name || ''); display.appendChild(caption);
        contentHost.appendChild(display);
      }
    }
    var tools = document.createElement('div'); tools.className = 'ib-expression-message-tools';
    var trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'btn ib-expression-message-trigger'; trigger.textContent = '表情';
    trigger.setAttribute('aria-expanded', 'false');
    var picker = document.createElement('div'); picker.className = 'ib-expression-message-picker'; picker.hidden = true;
    var active = Core.activePack(cfg);
    if (!active) {
      var noPack = document.createElement('span'); noPack.className = 'ib-expression-empty'; noPack.textContent = '当前没有绑定表情包。'; picker.appendChild(noPack);
    } else if (!Core.expressionsOf(active).length) {
      var noExpressions = document.createElement('span'); noExpressions.className = 'ib-expression-empty'; noExpressions.textContent = '这个表情包还没有表情。'; picker.appendChild(noExpressions);
    } else {
      Core.expressionsOf(active).forEach(function (expression) {
        var choice = document.createElement('button'); choice.type = 'button'; choice.className = 'ib-expression-choice';
        choice.title = String(expression.name || '角色表情'); choice.setAttribute('aria-label', '显示表情：' + String(expression.name || ''));
        var thumb = document.createElement('img'); thumb.src = expression.dataUrl; thumb.alt = ''; thumb.loading = 'lazy';
        choice.appendChild(thumb);
        var label = document.createElement('span'); label.textContent = String(expression.name || ''); choice.appendChild(label);
        choice.addEventListener('click', function () {
          trigger.disabled = true;
          persistMessageExpression(roleId, msgId, active.id, expression.id).then(function (saved) {
            if (document.documentElement.contains(messageElement)) decorateMessage(roleId, msgId, messageElement, { config: saved, contentHost: contentHost });
          }).catch(function (error) { picker.hidden = false; trigger.disabled = false; setMessageError(picker, error); });
        });
        picker.appendChild(choice);
      });
    }
    if (manualSelection) {
      var clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn ib-expression-clear'; clear.textContent = '清除';
      clear.addEventListener('click', function () {
        trigger.disabled = true;
        persistMessageExpression(roleId, msgId, '', '').then(function (saved) {
          if (document.documentElement.contains(messageElement)) decorateMessage(roleId, msgId, messageElement, { config: saved, contentHost: contentHost });
        }).catch(function (error) { picker.hidden = false; trigger.disabled = false; setMessageError(picker, error); });
      });
      picker.appendChild(clear);
    }
    if (!active || !Core.expressionsOf(active).length) {
      var manage = document.createElement('button'); manage.type = 'button'; manage.className = 'btn ib-expression-open-manager'; manage.textContent = '管理表情包';
      manage.addEventListener('click', function () { open(roleId); }); picker.appendChild(manage);
    }
    trigger.addEventListener('click', function () {
      var willOpen = picker.hidden;
      Array.prototype.forEach.call(document.querySelectorAll('.ib-expression-message-picker:not([hidden])'), function (other) {
        if (other !== picker) other.hidden = true;
      });
      picker.hidden = !willOpen; trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    tools.appendChild(trigger); tools.appendChild(picker); contentHost.appendChild(tools);
    return true;
  }
  function setMessageError(picker, error) {
    var note = document.createElement('span'); note.className = 'ib-expression-status is-error';
    note.textContent = String(error && error.message || '保存失败。'); picker.appendChild(note);
  }
  function clearRoleState(host, roleId) {
    if (!host || !host.querySelectorAll) return;
    var id = roleId == null ? '' : String(roleId);
    Array.prototype.forEach.call(host.querySelectorAll('.ib-expression-state'), function (node) {
      if (!id || String(node.getAttribute('data-expression-role-id') || '') === id) node.remove();
    });
    var messageRoleId = String(host.dataset && host.dataset.ibExpressionStateRoleId || '');
    var messageId = String(host.dataset && host.dataset.msgId || '');
    if (messageRoleId && messageId && (!id || id === messageRoleId)) {
      delete host.dataset.ibExpressionStateRoleId;
      decorateMessage(messageRoleId, messageId, host);
    }
  }
  function applyRoleState(roleId, state, host) {
    var id = String(roleId || ''), cfg = findConfig(id);
    if (!Core || !cfg || !host || !host.appendChild) return false;
    var resolved = Core.expressionForState(cfg, String(state || ''));
    if (host.classList && host.classList.contains('chat-msg') && host.dataset && host.dataset.msgId) {
      if (!resolved) { clearRoleState(host, id); return false; }
      host.dataset.ibExpressionStateRoleId = id;
      return decorateMessage(id, host.dataset.msgId, host, { config: cfg, stateOverride: String(state || '') });
    }
    var existing = null;
    Array.prototype.forEach.call(host.querySelectorAll ? host.querySelectorAll('.ib-expression-state') : [], function (node) {
      if (String(node.getAttribute('data-expression-role-id') || '') === id) existing = node;
    });
    if (!resolved) { if (existing) existing.remove(); return false; }
    var labels = { neutralExpression: '默认状态', greetingExpression: '进入聊天', typingExpression: '输入中', voiceExpression: '播放语音', errorExpression: '异常状态' };
    var badge = existing || document.createElement('span');
    badge.className = 'ib-expression-state'; badge.dataset.expressionRoleId = id; badge.dataset.expressionState = String(state || '');
    if (Core.settingsOf(cfg).microMotion && !prefersReducedMotion()) {
      badge.dataset.action = state === 'typingExpression' ? 'blink' : (state === 'voiceExpression' ? 'sway' : 'transition');
    }
    else delete badge.dataset.action;
    var image = badge.querySelector('img');
    if (!image) { image = document.createElement('img'); badge.appendChild(image); }
    if (image.getAttribute('src') !== resolved.expression.dataUrl) image.src = resolved.expression.dataUrl;
    image.alt = String(cfg.nickname || cfg.model || '角色') + ' · ' + String(labels[state] || '角色状态');
    image.title = image.alt;
    if (!existing) host.appendChild(badge);
    return true;
  }
  function applyChatGreeting(roleId) {
    var id = String(roleId || ''), miniName = byId('chat-header-name'), fullName = byId('chat-context-title');
    clearRoleState(miniName); clearRoleState(fullName);
    applyRoleState(id, 'greetingExpression', miniName);
    applyRoleState(id, 'greetingExpression', fullName);
  }
  document.addEventListener('click', function (event) {
    var trigger = event.target && event.target.closest ? event.target.closest('[data-expression-role-id]') : null;
    if (trigger) {
      event.preventDefault(); event.stopPropagation();
      open(trigger.dataset.expressionRoleId);
      return;
    }
    if (!event.target.closest || !event.target.closest('.ib-expression-message-tools')) {
      Array.prototype.forEach.call(document.querySelectorAll('.ib-expression-message-picker:not([hidden])'), function (picker) { picker.hidden = true; });
      Array.prototype.forEach.call(document.querySelectorAll('.ib-expression-message-trigger[aria-expanded="true"]'), function (button) { button.setAttribute('aria-expanded', 'false'); });
    }
  }, true);

  window.IBExpressionPacks = Object.freeze({
    open: open,
    close: close,
    decorateMessage: decorateMessage,
    parseReply: parseReply,
    promptHint: promptHint,
    rememberMessageExpression: rememberMessageExpression,
    rememberMessageText: rememberMessageText,
    applyRoleState: applyRoleState,
    clearRoleState: clearRoleState,
    applyChatGreeting: applyChatGreeting
  });
})(window);
