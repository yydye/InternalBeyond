/* Role-bound Live2D model library. User-selected model files are copied into
   the Tauri app-data directory through the narrow IB.host import capability. */
(function (NS) {
  'use strict';

  var CHUNK_BYTES = 256 * 1024;
  var models = [];
  var runtimeAvailable = null;

  function byId(id) { return document.getElementById(id); }
  function host() { return window.IB && window.IB.host && window.IB.host.live2dModels; }
  function setStatus(message, error) {
    var node = byId('api-live2d-status');
    if (!node) return;
    node.textContent = String(message || '');
    node.classList.toggle('is-error', !!error);
    node.classList.toggle('is-success', !error && !!message);
  }
  function explainError(error) {
    var code = String(error && (error.code || error.message) || error || '');
    var map = {
      LIVE2D_NATIVE_STORAGE_UNAVAILABLE: '请在 Windows Tauri 桌面版中导入模型。',
      LIVE2D_APP_DATA_UNAVAILABLE: '无法访问应用用户数据目录。',
      LIVE2D_STORAGE_UNAVAILABLE: '无法创建 Live2D 模型库。',
      LIVE2D_MODEL_JSON_NOT_FOUND: '所选内容中没有找到 .model3.json。',
      LIVE2D_MODEL_FILES_NOT_FOUND: '没有找到可用的模型资源文件。',
      LIVE2D_MODEL_JSON_INVALID: '模型配置 JSON 无法读取。',
      LIVE2D_MODEL_REFERENCES_MISSING: '模型配置缺少资源索引。',
      LIVE2D_MODEL_MOC_MISSING: '模型缺少 MOC3 文件。',
      LIVE2D_MODEL_RESOURCE_MISSING: '模型引用的贴图、动作或物理文件不完整。',
      LIVE2D_FILE_TYPE_UNSUPPORTED: '模型目录里含不支持的文件类型。请保留模型、贴图、动作及物理文件后重试。',
      LIVE2D_REFERENCE_TYPE_UNSUPPORTED: '模型引用了暂不支持的资源类型。',
      LIVE2D_PATH_REJECTED: '模型资源路径不安全，已取消导入。',
      LIVE2D_ARCHIVE_INVALID: 'ZIP 文件无效或已损坏。',
      LIVE2D_IMPORT_LIMIT_EXCEEDED: '模型包超过大小或文件数量上限。',
      LIVE2D_IMPORT_INCOMPLETE: '模型文件传输未完成，请重试。',
      LIVE2D_STORAGE_WRITE_FAILED: '写入应用用户数据目录失败。'
    };
    for (var key in map) if (code.indexOf(key) >= 0) return map[key];
    return code.indexOf('live2d-') >= 0 ? 'Live2D 模型服务暂不可用，请重启应用后重试。' : 'Live2D 导入失败，请确认模型文件完整后重试。';
  }
  function allowedFile(file) {
    var name = String(file && file.name || '').toLowerCase();
    return name.endsWith('.model3.json') || /\.(json|moc3|png|jpe?g|webp)$/i.test(name);
  }
  function relativePath(file) {
    var value = String(file && (file.webkitRelativePath || file.name) || '').replace(/\\/g, '/');
    return value.split('/').filter(Boolean).join('/');
  }
  function setProgress(done, total) {
    var mb = (done / 1048576).toFixed(1), all = (total / 1048576).toFixed(1);
    setStatus('正在导入模型资源 · ' + mb + ' / ' + all + ' MB');
  }
  async function transferFile(api, importId, file, targetPath, sentRef) {
    var total = Number(file.size) || 0;
    if (!total) return;
    for (var offset = 0; offset < total; offset += CHUNK_BYTES) {
      var buffer = await file.slice(offset, Math.min(total, offset + CHUNK_BYTES)).arrayBuffer();
      var bytes = Array.from(new Uint8Array(buffer));
      await api.writeChunk({ importId: importId, relativePath: targetPath, offset: offset, totalSize: total, chunk: bytes });
      sentRef.value += bytes.length;
      if (sentRef.value === total || sentRef.value % (5 * 1024 * 1024) < CHUNK_BYTES) setProgress(sentRef.value, sentRef.total);
    }
  }
  function renderModelOptions(selected) {
    var select = byId('api-live2d-model-ref');
    if (!select) return;
    select.replaceChildren();
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '选择角色的 Live2D 模型';
    select.appendChild(empty);
    models.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.modelRef;
      option.textContent = item.name + ' · ' + Number(item.textures || 0) + ' 贴图 · ' + Number(item.motionGroups || 0) + ' 组动作';
      select.appendChild(option);
    });
    if (selected && !models.some(function (item) { return item.modelRef === selected; })) {
      var missing = document.createElement('option');
      missing.value = selected;
      missing.textContent = '现有绑定不可用';
      select.appendChild(missing);
    }
    select.value = selected || '';
  }
  async function refreshLibrary(selected) {
    var api = host();
    if (!api || !api.available) {
      models = [];
      renderModelOptions(selected);
      setStatus('模型会保存到本机用户数据目录；请在 Tauri 桌面版中导入。', true);
      return [];
    }
    try {
      var result = await Promise.all([api.list(), api.runtimeUrl().then(function () { return true; }, function () { return false; })]);
      models = result[0];
      runtimeAvailable = result[1];
      renderModelOptions(selected);
      if (models.length && !runtimeAvailable) setStatus('模型已保存在本机，但此安装版未包含 Cubism Core；通话会使用角色立绘。完成 SDK 发行许可后可启用模型渲染。', true);
      else if (!models.length) setStatus('模型保存在本机用户数据目录。此角色也可继续使用现有静态立绘。');
      else setStatus('本机模型库 · ' + models.length + ' 个模型，可按角色分别绑定。');
      return models;
    } catch (error) {
      setStatus(explainError(error), true);
      return [];
    }
  }
  function syncControls() {
    var engine = byId('api-character-engine'), mode = byId('api-live2d-mode'), selected = engine && engine.value || (mode && mode.value) || 'auto';
    var model = byId('api-live2d-model-ref'), scale = byId('api-live2d-scale'), x = byId('api-live2d-offset-x'), y = byId('api-live2d-offset-y');
    var active = selected === 'live2d' || selected === 'auto';
    [model, scale, x, y].forEach(function (node) { if (node) node.disabled = !active; });
    var scaleValue = byId('api-live2d-scale-value'), xValue = byId('api-live2d-offset-x-value'), yValue = byId('api-live2d-offset-y-value');
    if (scaleValue && scale) scaleValue.textContent = scale.value + '%';
    if (xValue && x) xValue.textContent = x.value + '%';
    if (yValue && y) yValue.textContent = y.value + '%';
  }
  async function importSelected(kind, input) {
    var api = host(), files = Array.from(input && input.files || []), importId = '';
    if (!api || !api.available) { setStatus('模型导入需要 Windows Tauri 桌面版。', true); if (input) input.value = ''; return; }
    if (!files.length) return;
    if (kind === 'zip') {
      if (files.length !== 1 || !/\.zip$/i.test(files[0].name)) { setStatus('请选择一个 ZIP 模型包。', true); input.value = ''; return; }
    } else {
      files = files.filter(allowedFile);
      if (!files.some(function (file) { return String(file.name).toLowerCase().endsWith('.model3.json'); })) {
        setStatus('所选文件夹中没有 .model3.json。', true); input.value = ''; return;
      }
    }
    var transfer = files.map(function (file) { return { file: file, path: kind === 'zip' ? 'import.zip' : relativePath(file) }; });
    var total = transfer.reduce(function (sum, item) { return sum + (Number(item.file.size) || 0); }, 0);
    if (total > 768 * 1024 * 1024) { setStatus('模型包大于 768 MB，已取消导入。', true); input.value = ''; return; }
    var progress = { value: 0, total: total };
    try {
      setStatus('准备导入 · ' + transfer.length + ' 个资源文件');
      importId = await api.begin(kind);
      for (var i = 0; i < transfer.length; i++) {
        await transferFile(api, importId, transfer[i].file, transfer[i].path, progress);
      }
      setStatus('正在验证模型索引、贴图与动作文件…');
      var result = await api.finish(importId);
      importId = '';
      var imported = Array.isArray(result && result.models) ? result.models : [];
      if (!imported.length) throw new Error('LIVE2D_MODEL_JSON_NOT_FOUND');
      await refreshLibrary(imported[0].modelRef);
      var mode = byId('api-live2d-mode'); if (mode) mode.value = 'live2d';
      var engine = byId('api-character-engine'); if (engine) engine.value = 'live2d';
      syncControls();
      setStatus(runtimeAvailable===false
        ?'已导入 ' + imported.length + ' 个模型并保存在本机。此安装版未包含 Cubism Core，通话会使用角色立绘。'
        :'已导入 ' + imported.length + ' 个模型，保存角色配置后生效。模型仅保存在本机用户数据目录。',runtimeAvailable===false);
    } catch (error) {
      if (importId) { try { await api.abort(importId); } catch (_) {} }
      setStatus(explainError(error), true);
    } finally {
      if (input) input.value = '';
    }
  }
  function loadRoleEditor(config) {
    config = config || {};
    var legacy = config.live2dModelUrl || config.live2dModelPath || (typeof config.live2dModel === 'string' ? config.live2dModel : '') || '';
    var mode = byId('api-live2d-mode');
    if (mode) mode.value = ['auto', 'live2d', 'portrait'].indexOf(config.live2dMode) >= 0 ? config.live2dMode : (config.live2dModelRef || legacy ? 'live2d' : 'auto');
    var engine = byId('api-character-engine');
    if (engine) {
      var configured = ['auto', 'puppet', 'live2d', 'portrait'].indexOf(config.characterEngine) >= 0 ? config.characterEngine : '';
      engine.value = configured || (config.live2dMode === 'portrait' ? 'portrait' : ((config.live2dModelRef || legacy) ? 'live2d' : (config.puppetRef ? 'puppet' : 'auto')));
      if (mode) mode.value = engine.value === 'portrait' ? 'portrait' : (engine.value === 'live2d' ? 'live2d' : 'auto');
    }
    var url = byId('api-live2d-model-url'); if (url) url.value = String(legacy || '');
    var scale = byId('api-live2d-scale'); if (scale) scale.value = String(Math.max(75, Math.min(135, Number(config.live2dScale) || 100)));
    var x = byId('api-live2d-offset-x'); if (x) x.value = String(Math.max(-20, Math.min(20, Number(config.live2dOffsetX) || 0)));
    var y = byId('api-live2d-offset-y'); if (y) y.value = String(Math.max(-30, Math.min(20, Number(config.live2dOffsetY) || 0)));
    var ref = String(config.live2dModelRef || '');
    syncControls();
    refreshLibrary(ref);
  }
  function readRoleEditor(existing) {
    existing = existing || {};
    var selected = byId('api-live2d-model-ref'), ref = String(selected && selected.value || '').trim();
    var engine = byId('api-character-engine'), engineValue = engine && ['auto', 'puppet', 'live2d', 'portrait'].indexOf(engine.value) >= 0 ? engine.value : '';
    return {
      characterEngine: engineValue || existing.characterEngine || (existing.live2dMode === 'portrait' ? 'portrait' : ((existing.live2dModelRef || existing.live2dModelUrl) ? 'live2d' : (existing.puppetRef ? 'puppet' : 'auto'))),
      live2dMode: engineValue === 'portrait' ? 'portrait' : (engineValue === 'live2d' ? 'live2d' : String(byId('api-live2d-mode') && byId('api-live2d-mode').value || existing.live2dMode || 'auto')),
      live2dModelRef: ref,
      live2dModelUrl: ref ? '' : String(byId('api-live2d-model-url') && byId('api-live2d-model-url').value || '').trim(),
      live2dScale: Math.max(75, Math.min(135, Number(byId('api-live2d-scale') && byId('api-live2d-scale').value) || 100)),
      live2dOffsetX: Math.max(-20, Math.min(20, Number(byId('api-live2d-offset-x') && byId('api-live2d-offset-x').value) || 0)),
      live2dOffsetY: Math.max(-30, Math.min(20, Number(byId('api-live2d-offset-y') && byId('api-live2d-offset-y').value) || 0))
    };
  }
  function init() {
    var mode = byId('api-live2d-mode'); if (mode) mode.addEventListener('change', syncControls);
    var engine = byId('api-character-engine'); if (engine) engine.addEventListener('change', function () {
      var legacyMode = byId('api-live2d-mode');
      if (legacyMode) legacyMode.value = engine.value === 'portrait' ? 'portrait' : (engine.value === 'live2d' ? 'live2d' : 'auto');
      syncControls();
    });
    ['api-live2d-scale', 'api-live2d-offset-x', 'api-live2d-offset-y'].forEach(function (id) {
      var input = byId(id); if (input) input.addEventListener('input', syncControls);
    });
  }
  var api = { loadRoleEditor: loadRoleEditor, readRoleEditor: readRoleEditor, refreshLibrary: refreshLibrary, importSelected: importSelected };
  window.IBLive2DModels = api;
  NS.live2dModels = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})(window.IB || (window.IB = {}));
