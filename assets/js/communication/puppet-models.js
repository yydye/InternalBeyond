/* Per-role IB Puppet bundle management. Bundles contain only a declarative
   puppet.json and raster layers; the Tauri host validates paths and stores the
   files under the existing app-owned avatar data root. */
(function (NS) {
  'use strict';

  var CHUNK_BYTES = 256 * 1024;
  var bundles = [];

  function byId(id) { return document.getElementById(id); }
  function host() { return window.IB && window.IB.host && window.IB.host.characterPuppets; }
  function setStatus(message, error) {
    var node = byId('api-puppet-status');
    if (!node) return;
    node.textContent = String(message || '');
    node.classList.toggle('is-error', !!error);
    node.classList.toggle('is-success', !error && !!message);
  }
  function explainError(error) {
    var code = String(error && (error.code || error.message) || error || '');
    var map = {
      PUPPET_NATIVE_STORAGE_UNAVAILABLE: '请在 Windows Tauri 桌面版中导入分层素材。',
      PUPPET_APP_DATA_UNAVAILABLE: '无法访问应用用户数据目录。',
      PUPPET_STORAGE_UNAVAILABLE: '无法创建 IB Puppet 素材库。',
      PUPPET_MANIFEST_NOT_FOUND: '素材包中必须包含一个 puppet.json。',
      PUPPET_MANIFEST_INVALID: 'puppet.json 格式无效或字段无法读取。',
      PUPPET_SCHEMA_UNSUPPORTED: '此 puppet.json 使用了不支持的版本。',
      PUPPET_ASSET_MISSING: 'puppet.json 引用的图层图片缺失。',
      PUPPET_FILE_TYPE_UNSUPPORTED: '只支持 puppet.json 和 PNG、JPG、WebP 图片。',
      PUPPET_PATH_REJECTED: '素材包包含不安全路径，已取消导入。',
      PUPPET_ARCHIVE_INVALID: 'ZIP 文件无效或已损坏。',
      PUPPET_IMPORT_LIMIT_EXCEEDED: '素材包超过大小或文件数量上限。',
      PUPPET_IMPORT_INCOMPLETE: '素材传输未完成，请重试。',
      PUPPET_STORAGE_WRITE_FAILED: '写入应用用户数据目录失败。',
      PUPPET_BONE_CYCLE: '骨骼层级存在循环引用。',
      PUPPET_MOTION_INVALID: '眨眼、呼吸或嘴型配置超出允许范围。',
      PUPPET_ACTION_INVALID: '动作关键帧无效或超出允许范围。'
    };
    for (var key in map) if (code.indexOf(key) >= 0) return map[key];
    return 'IB Puppet 导入失败：' + code.slice(0, 100);
  }
  function relativePath(file) {
    return String(file && (file.webkitRelativePath || file.name) || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  }
  function allowedFile(file) {
    var name = String(file && file.name || '').toLowerCase();
    return name === 'puppet.json' || /\.(png|jpe?g|webp)$/i.test(name);
  }
  function setProgress(done, total) {
    setStatus('正在保存分层素材 · ' + (done / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
  }
  async function transferFile(api, importId, file, path, progress) {
    var total = Number(file.size) || 0;
    for (var offset = 0; offset < total; offset += CHUNK_BYTES) {
      var bytes = new Uint8Array(await file.slice(offset, Math.min(total, offset + CHUNK_BYTES)).arrayBuffer());
      await api.writeChunk({ importId: importId, relativePath: path, offset: offset, totalSize: total, chunk: Array.from(bytes) });
      progress.value += bytes.length;
      if (progress.value === progress.total || progress.value % (2 * 1024 * 1024) < CHUNK_BYTES) setProgress(progress.value, progress.total);
    }
  }
  function renderOptions(selected) {
    var select = byId('api-puppet-bundle-ref');
    if (!select) return;
    select.replaceChildren();
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '选择已导入的分层动画';
    select.appendChild(empty);
    bundles.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.bundleId;
      option.textContent = item.name + ' · ' + Number(item.layerCount || 0) + ' 个图层';
      select.appendChild(option);
    });
    if (selected && !bundles.some(function (item) { return item.bundleId === selected; })) {
      var missing = document.createElement('option');
      missing.value = selected;
      missing.textContent = '原绑定素材当前不可用';
      select.appendChild(missing);
    }
    select.value = selected || '';
  }
  async function refresh(selected) {
    var api = host();
    if (!api || !api.available) {
      bundles = [];
      renderOptions(selected);
      setStatus('模型与图层保存在本机用户数据目录；素材导入需要 Tauri 桌面版。', true);
      return [];
    }
    try {
      bundles = await api.list();
      renderOptions(selected);
      setStatus(bundles.length ? '本机动画库 · ' + bundles.length + ' 套分层角色素材。' : '尚未导入分层角色动画。可继续使用 DIY 立绘或 Live2D。');
      return bundles;
    } catch (error) {
      setStatus(explainError(error), true);
      return [];
    }
  }
  async function importSelected(kind, input) {
    var api = host(), files = Array.from(input && input.files || []), importId = '';
    if (!api || !api.available) { setStatus('IB Puppet 素材导入需要 Windows Tauri 桌面版。', true); if (input) input.value = ''; return; }
    if (!files.length) return;
    if (kind === 'zip') {
      if (files.length !== 1 || !/\.zip$/i.test(files[0].name)) { setStatus('请选择一个 ZIP 动画包。', true); input.value = ''; return; }
    } else {
      files = files.filter(allowedFile);
      if (!files.some(function (file) { return String(file.name).toLowerCase() === 'puppet.json'; })) {
        setStatus('所选文件夹中没有 puppet.json。', true); input.value = ''; return;
      }
    }
    var transfer = files.map(function (file) { return { file: file, path: kind === 'zip' ? 'import.zip' : relativePath(file) }; });
    var total = transfer.reduce(function (sum, item) { return sum + (Number(item.file.size) || 0); }, 0);
    if (total > 768 * 1024 * 1024) { setStatus('分层素材包大于 768 MB，已取消导入。', true); input.value = ''; return; }
    var progress = { value: 0, total: total };
    try {
      setStatus('准备导入 · ' + transfer.length + ' 个分层资源');
      importId = await api.begin(kind);
      for (var i = 0; i < transfer.length; i++) await transferFile(api, importId, transfer[i].file, transfer[i].path, progress);
      setStatus('正在验证骨骼、动作与图层引用…');
      var imported = await api.finish(importId);
      importId = '';
      await refresh(imported.bundleId);
      var ref = byId('api-puppet-bundle-ref'); if (ref) ref.value = imported.bundleId;
      var engine = byId('api-character-engine'); if (engine) { engine.value = 'puppet'; engine.dispatchEvent(new Event('change', { bubbles: true })); }
      setStatus('已导入「' + String(imported.name || '角色') + '」· ' + Number(imported.layerCount || 0) + ' 个图层。保存角色设置后即可在视频通话中使用。');
    } catch (error) {
      if (importId) { try { await api.abort(importId); } catch (_) {} }
      setStatus(explainError(error), true);
    } finally {
      if (input) input.value = '';
    }
  }
  function loadRoleEditor(config) {
    config = config || {};
    var scale = byId('api-puppet-scale'), x = byId('api-puppet-offset-x'), y = byId('api-puppet-offset-y');
    var frameRate = byId('api-puppet-frame-rate');
    if (scale) scale.value = String(Math.max(75, Math.min(135, Number(config.puppetScale) || 100)));
    if (x) x.value = String(Math.max(-20, Math.min(20, Number(config.puppetOffsetX) || 0)));
    if (y) y.value = String(Math.max(-30, Math.min(20, Number(config.puppetOffsetY) || 0)));
    if (frameRate) frameRate.value = ['auto', '30', '60', '120'].indexOf(String(config.puppetFrameRate || 'auto')) >= 0 ? String(config.puppetFrameRate || 'auto') : 'auto';
    syncControls();
    refresh(String(config.puppetRef || ''));
  }
  function readRoleEditor(existing) {
    existing = existing || {};
    var selected = byId('api-puppet-bundle-ref');
    return {
      puppetRef: String(selected && selected.value || '').trim(),
      puppetScale: Math.max(75, Math.min(135, Number(byId('api-puppet-scale') && byId('api-puppet-scale').value) || 100)),
      puppetOffsetX: Math.max(-20, Math.min(20, Number(byId('api-puppet-offset-x') && byId('api-puppet-offset-x').value) || 0)),
      puppetOffsetY: Math.max(-30, Math.min(20, Number(byId('api-puppet-offset-y') && byId('api-puppet-offset-y').value) || 0)),
      puppetFrameRate: ['auto', '30', '60', '120'].indexOf(String(byId('api-puppet-frame-rate') && byId('api-puppet-frame-rate').value || 'auto')) >= 0
        ? String(byId('api-puppet-frame-rate') && byId('api-puppet-frame-rate').value || 'auto') : 'auto'
    };
  }
  function syncControls() {
    var engine = byId('api-character-engine'), selected = engine && engine.value || 'auto';
    var ref = byId('api-puppet-bundle-ref'), scale = byId('api-puppet-scale'), x = byId('api-puppet-offset-x'), y = byId('api-puppet-offset-y'), frameRate = byId('api-puppet-frame-rate');
    var active = selected === 'puppet' || selected === 'auto';
    [ref, scale, x, y, frameRate].forEach(function (node) { if (node) node.disabled = !active; });
    var scaleValue = byId('api-puppet-scale-value'), xValue = byId('api-puppet-offset-x-value'), yValue = byId('api-puppet-offset-y-value');
    if (scaleValue && scale) scaleValue.textContent = scale.value + '%';
    if (xValue && x) xValue.textContent = x.value + '%';
    if (yValue && y) yValue.textContent = y.value + '%';
  }
  function init() {
    ['api-puppet-scale', 'api-puppet-offset-x', 'api-puppet-offset-y', 'api-puppet-frame-rate'].forEach(function (id) {
      var input = byId(id); if (input) input.addEventListener('input', syncControls);
    });
  }
  var api = { loadRoleEditor: loadRoleEditor, readRoleEditor: readRoleEditor, refresh: refresh, importSelected: importSelected };
  window.IBPuppetModels = api;
  NS.puppetModels = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})(window.IB || (window.IB = {}));
