/* IB Puppet Studio: editable source projects compile to the existing Puppet v1 runtime package. */
(function (window) {
  'use strict';
  var Core = window.IBPuppetStudioCore;
  if (!Core) return;

  var root = null, overlay = null, project = null, configs = [], selectedConfigId = '';
  var selectedLayerId = '', selectedBoneId = 'root', selectedActionId = 'nod', selectedKeyframeIndex = -1;
  var activePane = 'layers', editMode = 'view', selection = null, gesture = null;
  var previewCall = null, previewToken = 0, previewTimer = 0, previewResult = null;
  var projectInput = null, referenceInput = null, psdInput = null, maskState = null, maskGesture = false;
  var built = false, aiBusy = false, projectBusy = false, aiProgressUnlisten = null, aiComponentReady = false, aiComponentInstalled = false, historyPast = [], historyFuture = [], historyTarget = null;

  function byId(id) { return overlay && overlay.querySelector('#' + id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]; }); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function say(message, error) {
    var node = byId('puppet-studio-status');
    if (node) { node.textContent = String(message || ''); node.classList.toggle('is-error', !!error); }
  }
  function safeStem(value) { return String(value || 'layer').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'layer'; }
  function projectBytes() {
    if (!project) return 0;
    var size = String(project.reference && project.reference.dataUrl || '').length;
    Object.keys(project.assets || {}).forEach(function (id) { size += String(project.assets[id] || '').length; });
    return size;
  }
  function snapshotProject() {
    return {
      schema: project.schema, version: project.version, id: project.id, name: project.name, updatedAt: project.updatedAt,
      reference: Object.assign({}, project.reference), view: Object.assign({}, project.view), assets: Object.assign({}, project.assets),
      canvas: Object.assign({}, project.canvas), bones: project.bones.map(function (bone) { return Object.assign({}, bone); }),
      layers: project.layers.map(function (layer) { return Object.assign({}, layer, { viewBox: layer.viewBox && Object.assign({}, layer.viewBox), mesh: layer.mesh && Object.assign({}, layer.mesh) }); }),
      motions: clone(project.motions), characterEngine: project.characterEngine, bundleId: project.bundleId, roleId: project.roleId,
      aiDraft: project.aiDraft && clone(project.aiDraft)
    };
  }
  function markProject(renderAll) {
    if (!project) return;
    project.updatedAt = new Date().toISOString();
    if (projectBytes() > Core.MAX_PROJECT_BYTES) say('工程超过 160 MB。请缩小参考图或移除不需要的图层。', true);
    else say('工程草稿已更新；保存工程后可在以后继续编辑。');
    if (renderAll) { renderEditor(); renderCanvas(); }
    updateButtons(); schedulePreview();
  }
  function ensureProject() {
    if (!project) project = Core.createProject('DeepSeek 女仆');
    return project;
  }
  function bindMountButton() {
    var actions = root && root.querySelector('.diy-workshop-actions');
    if (!actions || actions.querySelector('[data-puppet-studio-open]')) return;
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'btn mini primary'; button.setAttribute('data-puppet-studio-open', '');
    button.textContent = '角色动画工作室'; button.title = '导入参考图、制作并编辑 IB Puppet 角色';
    actions.appendChild(button);
  }
  function mount(workshopRoot) {
    root = workshopRoot || document.getElementById('ib-diy-workshop');
    if (!root) return false;
    bindMountButton();
    if (built) return true;
    overlay = document.createElement('div');
    overlay.className = 'ib-puppet-studio-overlay'; overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = [
      '<section class="ib-puppet-studio" role="dialog" aria-modal="true" aria-labelledby="puppet-studio-title">',
      ' <header class="ips-head">',
      '  <div class="ips-brand"><span class="ips-mark">P</span><div><p>DIY WORKSHOP · CHARACTER</p><h2 id="puppet-studio-title">IB Puppet Studio</h2></div></div>',
      '  <label class="ips-project-name">工程名<input id="puppet-project-name" maxlength="80" value="DeepSeek 女仆"></label>',
      '  <div class="ips-head-actions"><button type="button" data-ips="import-psd">导入分层 PSD</button><button type="button" data-ips="new">新工程</button><button type="button" data-ips="open">导入工程</button><button type="button" data-ips="save">保存工程</button><button type="button" data-ips="export-project">导出工程</button><button type="button" data-ips="export">导出运行包</button><button type="button" class="ips-close" data-ips="close" aria-label="关闭 Character Studio">×</button></div>',
      ' </header>',
      ' <input id="puppet-project-file" type="file" accept=".ibpuppet-project.json,.json,application/json" hidden>',
      ' <input id="puppet-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>',
      ' <input id="puppet-psd-file" type="file" accept=".psd,application/octet-stream" hidden>',
      ' <div class="ips-flow"><span class="is-active"><b>01</b> 参考图</span><i></i><span><b>02</b> 分层修正</span><i></i><span><b>03</b> 动作</span><i></i><span><b>04</b> 运行包</span></div>',
      ' <div class="ips-body">',
      '  <aside class="ips-source">',
      '   <section class="ips-card"><div class="ips-card-head"><div><small>REFERENCE</small><h3>角色结构参考</h3></div><button type="button" data-ips="reference-file">上传立绘</button></div>',
      '    <p class="ips-hint">三视图用于识别外观与结构，不会直接变成可动画的分层模型。先选定一个视角作为动画画布。</p>',
      '    <div class="ips-file-summary" id="puppet-reference-summary">尚未导入参考图</div>',
      '    <div class="ips-row"><label>视觉分析 Provider<select id="puppet-ai-provider"><option value="">选择现有 API 配置</option></select></label></div>',
      '    <div class="ips-row ips-ai-buttons"><button type="button" data-ips="analyze" disabled>分析结构与分层建议</button><button type="button" data-ips="motions-ai" disabled>生成动作草稿</button></div>',
      '    <small class="ips-consent-note">只在点击分析时把当前参考图发送到选定 Provider。结果仅为可修正草稿，不会自动调用图片生成。</small>',
      '    <section class="ips-local-ai" aria-labelledby="puppet-local-ai-title"><div class="ips-subhead"><span id="puppet-local-ai-title">本地 AI 分层（可选）</span><span id="puppet-ai-version">未安装</span></div><p class="ips-local-ai-note" id="puppet-ai-status">未安装本地组件；上传立绘、导入 PSD 和手动套索可独立使用。</p><div class="ips-local-ai-actions"><button type="button" data-ips="ai-install">选择目录并安装 / 检查</button><button type="button" data-ips="ai-run" disabled>生成可编辑 PSD 候选</button><button type="button" data-ips="ai-uninstall" disabled>卸载组件</button><button type="button" data-ips="ai-clear-cache" disabled>清理临时缓存</button></div><small class="ips-local-ai-note">See-through 源码 Apache-2.0；LayerDiff / Marigold 权重另受 OpenRAIL 条款和基模型许可约束。下载权重不转移其发行许可。输出素材仍遵循输入作品许可。</small><label class="ips-check"><input id="puppet-ai-license-ack" type="checkbox">我已阅读模型使用限制；理解权重和生成素材不能自动随 IB 发行</label><label class="ips-check"><input id="puppet-ai-remove-venv" type="checkbox">卸载时删除仅由 IB 创建的 Python venv（所选现有环境会保留）</label><label class="ips-check"><input id="puppet-ai-remove-models" type="checkbox">清理时同时删除两份本地权重（约 5.3 GiB）</label><progress id="puppet-ai-progress" max="100" value="0"></progress><small id="puppet-ai-progress-label">模型权重只存入我选择的目录，不随 IB 安装包分发。</small></section>',
      '    <div class="ips-subhead">视角建议 <span id="puppet-view-count">0</span></div><div class="ips-suggestion-list" id="puppet-view-suggestions"><p class="ips-empty">导入后可手动框选正面画布，或先运行视觉分析。</p></div>',
      '    <div class="ips-subhead">图层建议 <span id="puppet-part-count">0</span></div><div class="ips-suggestion-list" id="puppet-part-suggestions"><p class="ips-empty">模型给出的部件建议会显示在这里；你确认后才会从原图建立图层。</p></div>',
      '  </section>',
      '  <section class="ips-card ips-library-card"><div class="ips-card-head"><div><small>LOCAL LIBRARY</small><h3>工程与 Puppet 素材</h3></div><button type="button" data-ips="refresh-library">刷新</button></div>',
      '   <div class="ips-subhead">可编辑工程 <button type="button" data-ips="refresh-projects">刷新列表</button></div><select id="puppet-project-library"><option value="">读取本机已保存工程</option></select><button type="button" class="ips-wide" data-ips="load-project" disabled>打开已保存工程</button><small>工程文件保存在本机用户数据目录，与运行包分开；不包含聊天或角色密钥。</small>',
      '   <div class="ips-subhead">运行包</div><select id="puppet-runtime-library"><option value="">选择要重新编辑的运行包</option></select><button type="button" class="ips-wide" data-ips="import-runtime">导入运行包到工程</button><small>运行包只读取已导入的 Puppet 文件，不读取 Chat、Memory 或角色 API。</small></section>',
      '  </aside>',
      '  <main class="ips-editor">',
      '   <div class="ips-toolbar"><div class="ips-tool-mode"><button type="button" data-ips-mode="view" class="is-active">框选角色视角</button><button type="button" data-ips-mode="layer">套索分层</button></div><div class="ips-canvas-actions"><label class="ips-check"><input id="puppet-remove-background" type="checkbox" checked>移除连通白底</label><label>容差<input id="puppet-background-tolerance" type="range" min="8" max="100" value="28"><output id="puppet-tolerance-label">28</output></label><button type="button" data-ips="use-full-view">整图作为画布</button><button type="button" data-ips="use-selection" disabled>使用当前选区</button><button type="button" data-ips="add-layer" disabled>从选区建立图层</button></div></div>',
      '   <div class="ips-canvas-wrap" id="puppet-canvas-wrap"><canvas id="puppet-source-canvas" aria-label="角色参考图编辑画布"></canvas><div class="ips-canvas-empty" id="puppet-canvas-empty"><span>＋</span><b>导入角色设定图</b><small>PNG · JPG · WebP / 单张上限 18 MB</small></div></div>',
      '   <div class="ips-canvas-foot"><span id="puppet-selection-readout">选择正面视图，之后用套索从真实像素建立图层。</span><span id="puppet-canvas-size">—</span></div>',
      '   <section class="ips-preview-card"><div class="ips-preview-head"><div><small>LIVE PREVIEW · IB PUPPET v1.1</small><span>编辑预览直接使用通话 Puppet 引擎</span></div><button type="button" data-ips="preview" disabled>刷新预览</button></div><div class="ips-puppet-preview" id="puppet-runtime-preview"><div class="ips-preview-placeholder">建立图层后，这里会使用 IB Puppet 实际渲染</div></div></section>',
      '  </main>',
      '  <aside class="ips-inspector">',
      '   <div class="ips-inspector-tabs"><button type="button" data-ips-pane="layers" class="is-active">图层</button><button type="button" data-ips-pane="bones">骨骼</button><button type="button" data-ips-pane="motion">动作</button></div>',
      '   <section class="ips-inspector-pane" data-ips-pane-view="layers"><div class="ips-list-head"><h3>图层树</h3><span id="puppet-layer-count">0</span></div><div class="ips-layer-list" id="puppet-layer-list"><p class="ips-empty">图层是从参考图裁取的原始像素。</p></div><div id="puppet-layer-properties"></div>',
      '    <div class="ips-editor-actions"><button type="button" data-ips="layer-up" disabled>上移</button><button type="button" data-ips="layer-down" disabled>下移</button><button type="button" data-ips="delete-layer" disabled>删除图层</button></div>',
      '    <div class="ips-ai-fill"><b>遮挡补全</b><p id="puppet-fill-route">可选：使用 Image Router 当前的编辑路由。生成会单独确认，结果先预览再采纳。</p><button type="button" data-ips="fill-layer" disabled>为选中图层生成补全部件…</button></div>',
      '   </section>',
      '   <section class="ips-inspector-pane" data-ips-pane-view="bones" hidden><div class="ips-list-head"><h3>骨骼层级</h3><button type="button" data-ips="add-bone">＋ 骨骼</button></div><div class="ips-bone-list" id="puppet-bone-list"></div><div id="puppet-bone-properties"></div><button type="button" class="ips-wide" data-ips="accept-ai-bones" disabled>采纳 AI 骨骼草稿</button></section>',
      '   <section class="ips-inspector-pane" data-ips-pane-view="motion" hidden><div class="ips-list-head"><h3>Motion Studio</h3><div><button type="button" data-ips="add-custom-action">＋ 自定义</button><button type="button" data-ips="add-default-motions">添加基础动作</button></div></div><div class="ips-action-list" id="puppet-action-list"></div><div class="ips-ai-motions" id="puppet-ai-motions" hidden><span>AI 动作草稿已生成，可编辑后采纳。</span><button type="button" data-ips="accept-ai-motions">采纳动作草稿</button></div><div class="ips-timeline"><label>播放头 <output id="puppet-playhead-label">0.00 s</output></label><input id="puppet-playhead" type="range" min="0" max="1" step="0.01" value="0"><div class="ips-row"><label>动作名称<input id="puppet-action-name" maxlength="24"></label><label>时长<input id="puppet-action-duration" type="number" min="0.15" max="60" step="0.05"></label></div><div class="ips-row"><label>动画目标<select id="puppet-motion-target"></select></label><label>插值<select id="puppet-key-easing"><option value="smooth">平滑</option><option value="linear">线性</option><option value="easeIn">加速</option><option value="easeOut">减速</option><option value="easeInOut">缓入缓出</option></select></label><button type="button" data-ips="add-keyframe">添加关键帧</button></div><div class="ips-keyframe-list" id="puppet-keyframe-list"></div><div id="puppet-keyframe-properties"></div><button type="button" class="ips-wide" data-ips="play-action" disabled>在预览中播放动作</button></div>',
      '    <div class="ips-physiology"><div class="ips-subhead">基础表现</div><label>呼吸骨骼<select id="puppet-breath-bone"></select></label><div class="ips-row"><label>呼吸幅度<input id="puppet-breath-amplitude" type="number" min="0" max="80" step="0.1" value="2"></label><label>呼吸周期<input id="puppet-breath-period" type="number" min="1" max="30" step="0.1" value="4"></label></div>',
      '     <div class="ips-subhead">独立眨眼</div><div class="ips-row"><label>左眼睁开<select id="puppet-blink-open-l"></select></label><label>左眼闭合<select id="puppet-blink-closed-l"></select></label></div><div class="ips-row"><label>右眼睁开<select id="puppet-blink-open-r"></select></label><label>右眼闭合<select id="puppet-blink-closed-r"></select></label><button type="button" data-ips="set-blink">设置眨眼</button></div><small id="puppet-blink-summary">眨眼需要真实分开的闭眼图层；缺少闭眼素材时不伪造图层。</small>',
      '     <div class="ips-subhead">口型与头部微动</div><div class="ips-row"><label>闭嘴图层<select id="puppet-mouth-closed"></select></label><label>张嘴图层<select id="puppet-mouth-open"></select></label><button type="button" data-ips="set-mouth">设置口型</button></div><div class="ips-row"><label>微转头骨骼<select id="puppet-turn-bone"></select></label><label>摆动周期<input id="puppet-turn-period" type="number" min="1.5" max="30" step="0.1" value="6"></label><label>转头幅度<input id="puppet-turn-amplitude" type="number" min="0" max="0.35" step="0.005" value="0.02"></label></div><small id="puppet-turn-summary">头部微动与网格弹簧由现有 IB Puppet 渲染器驱动。</small></div>',
      '   </section>',
      '   <div class="ips-inspector-foot"><button type="button" data-ips="undo" disabled>撤销</button><button type="button" data-ips="redo" disabled>重做</button><span id="puppet-history-status">历史记录 · 0</span></div>',
      '  </aside>',
      ' </div>',
      ' <div class="ips-mask-modal" id="puppet-mask-modal" hidden><div class="ips-mask-window"><header><div><small>PIXEL MASK · MANUAL CORRECTION</small><h3>图层透明边缘修正</h3></div><button type="button" data-ips="mask-cancel" aria-label="关闭修正窗口">×</button></header><div class="ips-mask-toolbar"><button type="button" data-ips="mask-erase" class="is-active">擦除背景</button><button type="button" data-ips="mask-restore">恢复像素</button><label>笔刷 <input id="puppet-mask-brush" type="range" min="6" max="128" value="34"><output id="puppet-mask-brush-value">34 px</output></label><button type="button" data-ips="mask-reset">重置遮罩</button></div><div class="ips-mask-canvas-wrap"><canvas id="puppet-mask-canvas"></canvas></div><footer><span>擦除只修改透明度；恢复使用原始裁切像素。取消不会改变工程。</span><div><button type="button" data-ips="mask-cancel">取消</button><button type="button" class="is-primary" data-ips="mask-save">保存边缘修正</button></div></footer></div></div>',
      ' <footer class="ips-foot"><span id="puppet-studio-status" role="status" aria-live="polite">导入参考图以开始。三视图本身不会被当成动画角色层。</span><div><label>绑定角色<select id="puppet-bind-role"><option value="">不绑定</option></select></label><button type="button" data-ips="bind-role" disabled>绑定到 IB 角色…</button></div></footer>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    projectInput = byId('puppet-project-file'); referenceInput = byId('puppet-reference-file'); psdInput = byId('puppet-psd-file');
    root.addEventListener('click', function (event) { if (event.target.closest('[data-puppet-studio-open]')) open(); });
    bindEvents(); refreshProviderList(); refreshRoleList(); refreshRuntimeLibrary(); renderEmpty(); refreshLocalAiStatus();
    built = true;
    refreshProjectLibrary();
    return true;
  }
  function open() { if (!overlay) mount(root || document.getElementById('ib-diy-workshop')); overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false'); document.body.classList.add('ib-puppet-studio-open'); if (!project) newProject(); refreshProviderList(); refreshRoleList(); refreshRuntimeLibrary(); refreshProjectLibrary(); refreshFillRoute(); refreshLocalAiStatus(); }
  function close() { if (!overlay) return; overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); document.body.classList.remove('ib-puppet-studio-open'); destroyPreview(); }
  function newProject() {
    if (project && (project.layers.length || project.reference.dataUrl) && !window.confirm('当前工程尚未导出。新建工程会丢弃此页未保存的更改，继续吗？')) return;
    project = Core.createProject('DeepSeek 女仆'); selectedLayerId = ''; selectedBoneId = 'root'; selectedActionId = ''; selection = null; editMode = 'view'; stateFillCandidate = null;
    historyPast.length = 0; historyFuture.length = 0; selectedKeyframeIndex = -1;
    project.bones = Core.defaultBones();
    var title = byId('puppet-project-name'); if (title) title.value = project.name;
    renderEmpty(); renderEditor(); schedulePreview(); say('新工程已建立。先导入参考图并选择一个视角。');
  }
  function renderEmpty() {
    var canvas = byId('puppet-source-canvas'), empty = byId('puppet-canvas-empty');
    if (canvas) { canvas.width = 1; canvas.height = 1; canvas.style.display = 'none'; }
    if (empty) { empty.hidden = false; empty.querySelector('b').textContent = project && project.layers.length ? '这个运行包工程没有原始参考图' : '导入角色设定图'; empty.querySelector('small').textContent = project && project.layers.length ? '可继续编辑图层、骨骼和动作；裁切需要重新导入参考图' : 'PNG · JPG · WebP / 单张上限 18 MB'; }
    var summary = byId('puppet-reference-summary'); if (summary) summary.textContent = project && project.reference.name ? project.reference.name : '尚未导入参考图';
  }
  function bindEvents() {
    overlay.addEventListener('click', function (event) {
      var openStudio = event.target.closest('[data-puppet-studio-open]');
      if (openStudio) { open(); return; }
      var button = event.target.closest('[data-ips]');
      if (button) { handleAction(button.getAttribute('data-ips'), button); return; }
      var mode = event.target.closest('[data-ips-mode]');
      if (mode) { setMode(mode.getAttribute('data-ips-mode')); return; }
      var pane = event.target.closest('[data-ips-pane]');
      if (pane) { setPane(pane.getAttribute('data-ips-pane')); return; }
      var suggestion = event.target.closest('[data-ips-suggestion]');
      if (suggestion) { selectSuggestion(suggestion.getAttribute('data-ips-suggestion-kind'), Number(suggestion.getAttribute('data-ips-suggestion'))); return; }
      var layer = event.target.closest('[data-ips-layer]');
      if (layer) { selectedLayerId = layer.getAttribute('data-ips-layer'); renderEditor(); renderCanvas(); return; }
      var bone = event.target.closest('[data-ips-bone]');
      if (bone) { selectedBoneId = bone.getAttribute('data-ips-bone'); renderEditor(); return; }
      var action = event.target.closest('[data-ips-action]');
      if (action) { selectedActionId = action.getAttribute('data-ips-action'); selectedKeyframeIndex = -1; renderEditor(); return; }
      var keyframe = event.target.closest('[data-ips-keyframe]');
      if (keyframe) { selectKeyframe(Number(keyframe.getAttribute('data-ips-keyframe'))); return; }
      var keyDelete = event.target.closest('[data-ips-key-delete]');
      if (keyDelete) { deleteKeyframe(Number(keyDelete.getAttribute('data-ips-key-delete'))); return; }
      var suggestionView = event.target.closest('[data-ips-view]');
      if (suggestionView) { chooseViewSuggestion(Number(suggestionView.getAttribute('data-ips-view'))); return; }
    });
    overlay.addEventListener('input', handleInput);
    overlay.addEventListener('change', handleChange);
    var canvas = byId('puppet-source-canvas');
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerCancel);
    var maskCanvas = byId('puppet-mask-canvas');
    maskCanvas.addEventListener('pointerdown', maskPointerDown); maskCanvas.addEventListener('pointermove', maskPointerMove); maskCanvas.addEventListener('pointerup', maskPointerUp); maskCanvas.addEventListener('pointercancel', maskPointerUp);
    byId('puppet-mask-brush').addEventListener('input', function () { byId('puppet-mask-brush-value').textContent = this.value + ' px'; });
    projectInput.addEventListener('change', function () { if (projectInput.files && projectInput.files[0]) openProjectFile(projectInput.files[0]); projectInput.value = ''; });
    referenceInput.addEventListener('change', function () { if (referenceInput.files && referenceInput.files[0]) openReferenceFile(referenceInput.files[0]); referenceInput.value = ''; });
    psdInput.addEventListener('change', function () { if (psdInput.files && psdInput.files[0]) openSeeThroughPsd(psdInput.files[0]); psdInput.value = ''; });
  }
  function handleAction(name, button) {
    if (name === 'close') close();
    else if (name === 'import-psd') psdInput.click();
    else if (name === 'new') newProject();
    else if (name === 'reference-file') referenceInput.click();
    else if (name === 'open') projectInput.click();
    else if (name === 'save') saveProject();
    else if (name === 'export-project') exportProjectFile();
    else if (name === 'load-project') loadSavedProject();
    else if (name === 'refresh-projects') refreshProjectLibrary();
    else if (name === 'export') exportRuntime();
    else if (name === 'preview') refreshPreview();
    else if (name === 'analyze') analyzeReference();
    else if (name === 'motions-ai') generateAiMotions();
    else if (name === 'ai-install') installLocalAi();
    else if (name === 'ai-run') runLocalAiLayering();
    else if (name === 'ai-uninstall') uninstallLocalAi();
    else if (name === 'ai-clear-cache') clearLocalAiCache();
    else if (name === 'use-full-view') useFullImage();
    else if (name === 'use-selection') useSelectionAsView();
    else if (name === 'add-layer') addLayerFromSelection();
    else if (name === 'layer-up') moveLayer(-1);
    else if (name === 'layer-down') moveLayer(1);
    else if (name === 'delete-layer') deleteLayer();
    else if (name === 'refresh-library') refreshRuntimeLibrary();
    else if (name === 'import-runtime') importRuntimeBundle();
    else if (name === 'add-bone') addBone();
    else if (name === 'accept-ai-bones') acceptAiBones();
    else if (name === 'add-default-motions') addDefaultMotions();
    else if (name === 'add-custom-action') addCustomAction();
    else if (name === 'accept-ai-motions') acceptAiMotions();
    else if (name === 'add-keyframe') addKeyframe();
    else if (name === 'play-action') playAction();
    else if (name === 'set-blink') setBlinkMapping();
    else if (name === 'set-mouth') setMouthMapping();
    else if (name === 'delete-bone') deleteBone();
    else if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'bind-role') bindToRole();
    else if (name === 'fill-layer') proposeFill();
    else if (name === 'apply-fill') applyFill();
    else if (name === 'discard-fill') discardFill();
    else if (name === 'mask-layer') openMaskEditor();
    else if (name === 'mask-erase') setMaskMode('erase');
    else if (name === 'mask-restore') setMaskMode('restore');
    else if (name === 'mask-reset') resetMask();
    else if (name === 'mask-save') saveMask();
    else if (name === 'mask-cancel') closeMaskEditor();
  }
  function setMode(mode) {
    if (mode !== 'view' && mode !== 'layer') return;
    if (mode === 'layer' && !(project && project.view.assetId && project.assets[project.view.assetId])) { say('先框选并应用一个正面或单张立绘画布。', true); mode = 'view'; }
    editMode = mode; selection = null;
    overlay.querySelectorAll('[data-ips-mode]').forEach(function (button) { button.classList.toggle('is-active', button.getAttribute('data-ips-mode') === mode); });
    updateCanvasHelp(); renderCanvas(); updateButtons();
  }
  function setPane(pane) {
    if (['layers', 'bones', 'motion'].indexOf(pane) < 0) return;
    activePane = pane;
    overlay.querySelectorAll('[data-ips-pane]').forEach(function (button) { button.classList.toggle('is-active', button.getAttribute('data-ips-pane') === pane); });
    overlay.querySelectorAll('[data-ips-pane-view]').forEach(function (section) { section.hidden = section.getAttribute('data-ips-pane-view') !== pane; });
  }
  function handleInput(event) {
    var target = event.target;
    if (!project) return;
    if (target.id === 'puppet-background-tolerance') { byId('puppet-tolerance-label').textContent = target.value; return; }
    if (target.id === 'puppet-playhead') { byId('puppet-playhead-label').textContent = Number(target.value).toFixed(2) + ' s'; if (previewCall && window.IBCallPuppet && window.IBCallPuppet.seekAction) window.IBCallPuppet.seekAction(previewCall, selectedActionId, Number(target.value)); return; }
    if (target.dataset && target.dataset.projectField) {
      recordInputHistory(target);
      var layer = findLayer(selectedLayerId), bone = findBone(selectedBoneId);
      if (target.dataset.projectField === 'layer' && layer) {
        var key = target.dataset.key, value = target.dataset.kind === 'number' ? Number(target.value) : target.value;
        layer[key] = value; schedulePreview();
        if (key === 'bone' || key === 'name') renderLayerList();
      } else if (target.dataset.projectField === 'bone' && bone) {
        var boneValue = target.dataset.kind === 'number' ? Number(target.value) : (target.value || null);
        if (target.dataset.key === 'parent' && boneValue && wouldCycle(bone.id, boneValue)) { say('该父级会形成循环层级，已保留原设置。', true); renderProperties(); return; }
        bone[target.dataset.key] = boneValue; schedulePreview(); renderBoneList();
      }
      markProject(false);
    }
    if (target.hasAttribute('data-layer-mesh-field')) {
      var meshLayer = findLayer(selectedLayerId); if (!meshLayer) return;
      recordInputHistory(target); meshLayer.mesh = meshLayer.mesh || defaultMesh(); meshLayer.mesh[target.dataset.layerMeshField] = Number(target.value); schedulePreview(); markProject(false);
    }
    if (target.hasAttribute('data-keyframe-field')) {
      var currentAction = findAction(selectedActionId), frameIndex = Number(target.getAttribute('data-keyframe-index'));
      var frame = currentAction && currentAction.keyframes[frameIndex]; if (!frame) return;
      recordInputHistory(target); var field = target.dataset.keyframeField;
      if (target.dataset.kind === 'number') frame[field] = target.value === '' ? undefined : (field === 'at' ? Core.clamp(target.value, 0, currentAction.durationSeconds, 0) : Number(target.value));
      else frame[field] = target.value;
      schedulePreview(); markProject(false);
    }
    if (target.hasAttribute('data-layer-notes')) {
      var noteLayer = findLayer(selectedLayerId); if (noteLayer) { recordInputHistory(target); noteLayer.notes = target.value.slice(0, 220); markProject(false); }
    }
    if (target.id === 'puppet-action-duration') {
      var action = findAction(selectedActionId); if (action) { recordInputHistory(target); action.durationSeconds = Core.clamp(target.value, .15, 60, 1); renderActionList(); updateTimeline(); schedulePreview(); markProject(false); }
    }
    if (target.id === 'puppet-action-name') { var namedAction = findAction(selectedActionId); if (namedAction) { recordInputHistory(target); namedAction.label = String(target.value || namedAction.id).slice(0, 24); renderActionList(); markProject(false); } }
    if (target.id === 'puppet-action-name') { var namedAction = findAction(selectedActionId); if (namedAction) { recordInputHistory(target); namedAction.label = String(target.value || namedAction.id).slice(0, 24); renderActionList(); markProject(false); } }
    if (target.id === 'puppet-project-name') { recordInputHistory(target); project.name = String(target.value || '未命名角色').slice(0, 80); markProject(false); }
    if (target.id === 'puppet-breath-amplitude' || target.id === 'puppet-breath-period') {
      recordInputHistory(target);
      var breathBone = byId('puppet-breath-bone').value;
      if (breathBone) {
        project.motions.breath = { boneId: breathBone, amplitudeY: Number(byId('puppet-breath-amplitude').value) || 0, periodSeconds: Number(byId('puppet-breath-period').value) || 4, scaleY: .006 };
        schedulePreview(); markProject(false);
      }
    }
    if (target.id === 'puppet-turn-amplitude' || target.id === 'puppet-turn-period') {
      recordInputHistory(target);
      var turnBone = byId('puppet-turn-bone').value;
      if (turnBone) {
        project.motions.headTurn = { boneId: turnBone, amplitudeRotation: Number(byId('puppet-turn-amplitude').value) || 0,
          periodSeconds: Number(byId('puppet-turn-period').value) || 6, amplitudeX: project.motions.headTurn ? project.motions.headTurn.amplitudeX : .35 };
        schedulePreview(); markProject(false);
      }
    }
  }
  function handleChange(event) {
    var target = event.target;
    if (!project) return;
    if (target === projectInput) { if (target.files && target.files[0]) loadProjectFile(target.files[0]); target.value = ''; return; }
    if (target === referenceInput) { if (target.files && target.files[0]) loadReferenceFile(target.files[0]); target.value = ''; return; }
    if (target.id === 'puppet-ai-provider') { selectedConfigId = target.value; return; }
    if (target.id === 'puppet-project-library') { updateButtons(); return; }
    if (target.id === 'puppet-background-tolerance') { byId('puppet-tolerance-label').textContent = target.value; return; }
    if (target.id === 'puppet-bind-role') { project.roleId = target.value; updateButtons(); return; }
    if (target.id === 'puppet-motion-target') { return; }
    if (target.id === 'puppet-breath-bone') { recordInputHistory(target); var breath = project.motions.breath || { periodSeconds: 4, amplitudeY: 2, scaleY: .006 }; breath.boneId = target.value || ''; project.motions.breath = target.value ? breath : null; schedulePreview(); markProject(false); return; }
    if (target.id === 'puppet-turn-bone') { recordInputHistory(target); var turn = project.motions.headTurn || { periodSeconds: 6, amplitudeRotation: .02, amplitudeX: .35 }; turn.boneId = target.value || ''; project.motions.headTurn = target.value ? turn : null; schedulePreview(); markProject(false); return; }
    if (target.hasAttribute('data-layer-visible')) { var visibleLayer = findLayer(target.dataset.layerVisible); if (visibleLayer) { pushHistory(); visibleLayer.visible = target.checked; markProject(true); } return; }
    if (target.hasAttribute('data-layer-mesh')) { var meshLayer = findLayer(selectedLayerId); if (meshLayer) { pushHistory(); meshLayer.mesh = target.checked ? (meshLayer.mesh || defaultMesh()) : null; renderProperties(); schedulePreview(); } return; }
    if (/^puppet-blink-(?:open|closed)-[lr]$/.test(target.id)) { return; }
    if (target.id === 'puppet-mouth-open' || target.id === 'puppet-mouth-closed') { return; }
    if (target.hasAttribute('data-keyframe-target')) {
      var targetAction = findAction(selectedActionId), targetIndex = Number(target.getAttribute('data-keyframe-index')), targetFrame = targetAction && targetAction.keyframes[targetIndex];
      if (!targetFrame) return;
      pushHistory(); delete targetFrame.boneId; delete targetFrame.layerId;
      if (target.value.indexOf('b:') === 0) targetFrame.boneId = target.value.slice(2); else targetFrame.layerId = target.value.slice(2);
      markProject(true); return;
    }
    if (target.hasAttribute('data-keyframe-field')) { recordInputHistory(target); handleInput({ target: target }); finishInputHistory(target); renderTimeline(); return; }
    if (target.dataset && target.dataset.projectField) { recordInputHistory(target); handleInput({ target: target }); finishInputHistory(target); }
    if (target.hasAttribute('data-keyframe-field') || target.hasAttribute('data-layer-mesh-field') || target.hasAttribute('data-layer-notes')) {
      recordInputHistory(target); handleInput({ target: target }); finishInputHistory(target);
      if (target.hasAttribute('data-keyframe-field')) renderTimeline();
      if (target.dataset && target.dataset.projectField) renderLayerList();
    }
    if (target.id === 'puppet-action-name' || target.id === 'puppet-action-duration') finishInputHistory(target);
    if (target.id === 'puppet-action-name' || target.id === 'puppet-action-duration') finishInputHistory(target);
    if (target.id === 'puppet-turn-amplitude' || target.id === 'puppet-turn-period') finishInputHistory(target);
    if (target.id === 'puppet-playhead') { byId('puppet-playhead-label').textContent = Number(target.value).toFixed(2) + ' s'; if (previewCall && window.IBCallPuppet && window.IBCallPuppet.seekAction) window.IBCallPuppet.seekAction(previewCall, selectedActionId, Number(target.value)); }
  }
  function pointerCoords(event) {
    var canvas = byId('puppet-source-canvas'), rect = canvas.getBoundingClientRect();
    return { x: Core.clamp((event.clientX - rect.left) * canvas.width / Math.max(1, rect.width), 0, canvas.width, 0), y: Core.clamp((event.clientY - rect.top) * canvas.height / Math.max(1, rect.height), 0, canvas.height, 0) };
  }
  function pointerDown(event) {
    if (!project || !currentCanvasSource()) return;
    event.preventDefault();
    var point = pointerCoords(event); gesture = { pointerId: event.pointerId, points: [point], start: point };
    byId('puppet-source-canvas').setPointerCapture(event.pointerId); renderCanvas();
  }
  function pointerMove(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    var point = pointerCoords(event), last = gesture.points[gesture.points.length - 1];
    var distance = Math.hypot(point.x - last.x, point.y - last.y);
    if (editMode === 'view') gesture.points[1] = point;
    else if (distance >= 4) gesture.points.push(point);
    renderCanvas();
  }
  function pointerUp(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (editMode === 'view') {
      var end = gesture.points[1] || gesture.start;
      selection = rectPolygon(gesture.start, end);
    } else {
      if (gesture.points.length >= 3) selection = gesture.points.slice();
      else selection = null;
    }
    gesture = null; renderCanvas(); updateButtons(); updateCanvasHelp();
  }
  function pointerCancel() { gesture = null; renderCanvas(); }
  function rectPolygon(a, b) {
    return [
      { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) }
    ];
  }
  function currentCanvasSource() {
    if (!project) return '';
    if (editMode === 'view') return project.reference.dataUrl || '';
    return project.view.assetId && project.assets[project.view.assetId] || '';
  }
  function renderCanvas() {
    if (!overlay || !project) return;
    var canvas = byId('puppet-source-canvas'), empty = byId('puppet-canvas-empty'), source = currentCanvasSource();
    if (!source) { renderEmpty(); return; }
    Core.loadImage(source).then(function (image) {
      if (!canvas.isConnected || currentCanvasSource() !== source) return;
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.style.display = 'block';
      if (empty) empty.hidden = true;
      var context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
      if (editMode === 'view' && project.aiDraft) {
        project.aiDraft.views.forEach(function (view, index) {
          var box = view.box; drawRect(context, box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height, index === selectedSuggestionIndex('view') ? '#63d5eb' : '#8ba3d6', String(view.label || '视角'));
        });
      }
      if (editMode === 'layer' && project.aiDraft && project.view.width && project.view.height) {
        project.aiDraft.parts.filter(function (part) { return part.viewId === activeViewId(); }).forEach(function (part, index) {
          var box = part.box; drawRect(context, box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height, '#c6a5f2', String(part.label || '图层建议'));
        });
      }
      var active = gesture ? (editMode === 'view' ? rectPolygon(gesture.start, gesture.points[1] || gesture.start) : gesture.points) : selection;
      if (active && active.length > 2) drawPolygon(context, active, editMode === 'view' ? '#55d8e8' : '#ffcc79');
      if (editMode === 'layer') {
        project.layers.forEach(function (layer) {
          if (layer.viewBox) drawRect(context, layer.viewBox.x * canvas.width, layer.viewBox.y * canvas.height, layer.viewBox.width * canvas.width, layer.viewBox.height * canvas.height, layer.id === selectedLayerId ? '#ffe29b' : 'rgba(235,244,255,.65)', layer.name);
        });
      }
      byId('puppet-canvas-size').textContent = canvas.width + ' × ' + canvas.height;
    }).catch(function () { say('参考图片无法解码。', true); });
  }
  function drawRect(context, x, y, width, height, color, label) {
    context.save(); context.strokeStyle = color; context.lineWidth = Math.max(2, context.canvas.width / 600); context.setLineDash([8, 5]); context.strokeRect(x, y, width, height); context.setLineDash([]);
    context.font = '600 ' + Math.max(14, context.canvas.width / 90) + 'px sans-serif'; context.fillStyle = color; context.fillText(String(label || ''), x + 4, Math.max(16, y - 6)); context.restore();
  }
  function drawPolygon(context, points, color) {
    context.save(); context.beginPath(); context.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
    context.closePath(); context.fillStyle = color + '25'; context.fill(); context.strokeStyle = color; context.lineWidth = Math.max(3, context.canvas.width / 420); context.stroke(); context.restore();
  }
  function updateCanvasHelp() {
    var help = byId('puppet-selection-readout');
    if (help) help.textContent = editMode === 'view'
      ? '在整张参考图上框选一个视角；三视图只作结构参考。'
      : '用套索围住真实图像区域。白底只会移除与选区边缘连通的像素。';
  }
  function updateButtons() {
    if (!overlay) return;
    var hasReference = !!(project && project.reference.dataUrl), hasView = !!(project && project.view.assetId && project.assets[project.view.assetId]);
    var useView = overlay.querySelector('[data-ips="use-selection"]'), addLayerButton = overlay.querySelector('[data-ips="add-layer"]');
    if (useView) useView.disabled = !(hasReference && editMode === 'view' && selection && selection.length >= 3);
    if (addLayerButton) addLayerButton.disabled = !(hasView && editMode === 'layer' && selection && selection.length >= 3);
    overlay.querySelector('[data-ips="analyze"]').disabled = !hasReference || aiBusy;
    overlay.querySelector('[data-ips="motions-ai"]').disabled = !project || !project.layers.length || aiBusy;
    var aiRun = overlay.querySelector('[data-ips="ai-run"]');
    if (aiRun) aiRun.disabled = aiBusy || !hasReference || !(window.IB && window.IB.host && window.IB.host.puppetAi && window.IB.host.puppetAi.available && aiComponentReady);
    var aiInstall = overlay.querySelector('[data-ips="ai-install"]'); if (aiInstall) aiInstall.disabled = aiBusy;
    var aiUninstall = overlay.querySelector('[data-ips="ai-uninstall"]'); if (aiUninstall) aiUninstall.disabled = aiBusy || !aiComponentInstalled;
    var aiClear = overlay.querySelector('[data-ips="ai-clear-cache"]'); if (aiClear) aiClear.disabled = aiBusy || !aiComponentInstalled;
    overlay.querySelector('[data-ips="preview"]').disabled = !project || !project.layers.length;
    overlay.querySelector('[data-ips="export-project"]').disabled = !project || projectBusy;
    overlay.querySelector('[data-ips="export"]').disabled = !project || !project.layers.length || projectBusy;
    overlay.querySelector('[data-ips="bind-role"]').disabled = !project || !project.bundleId || !project.roleId || projectBusy;
    overlay.querySelector('[data-ips="fill-layer"]').disabled = !findLayer(selectedLayerId) || projectBusy;
    overlay.querySelector('[data-ips="accept-ai-bones"]').disabled = !(project && project.aiDraft && project.aiDraft.bones && project.aiDraft.bones.length);
    overlay.querySelector('[data-ips="accept-ai-motions"]').disabled = !(project && project.aiDraft && project.aiDraft.motions && project.aiDraft.motions.actions && project.aiDraft.motions.actions.length);
    overlay.querySelector('[data-ips="undo"]').disabled = !historyPast.length;
    overlay.querySelector('[data-ips="redo"]').disabled = !historyFuture.length;
    var savedSelect = byId('puppet-project-library'), savedOpen = overlay.querySelector('[data-ips="load-project"]');
    if (savedOpen) savedOpen.disabled = projectBusy || !savedSelect || !savedSelect.value || !(window.IB && window.IB.host && window.IB.host.puppetProjects && window.IB.host.puppetProjects.available);
  }
  function selectedSuggestionIndex(kind) { return kind === 'view' ? stateSelection.view : stateSelection.part; }
  var stateSelection = { view: -1, part: -1 };
  function activeViewId() { return project && project.aiDraft ? String(project.aiDraft.activeViewId || 'front') : 'front'; }
  function selectedConfig() { return configs.find(function (config) { return config && config.id === selectedConfigId && !config.archived; }) || null; }
  function refreshProviderList() {
    var select = byId('puppet-ai-provider');
    if (!select) return Promise.resolve([]);
    return Promise.resolve(typeof window.dbGetAll === 'function' ? window.dbGetAll('apiConfigs') : window.apiConfigs || []).then(function (rows) {
      configs = (Array.isArray(rows) ? rows : []).filter(function (config) { return config && typeof config.id === 'string' && !config.archived && !config._group; });
      var selected = selectedConfigId || select.value;
      select.innerHTML = '<option value="">选择现有视觉 API 配置</option>' + configs.map(function (config) {
        var provider = String(config.provider || 'compatible'), name = String(config.nickname || config.model || config.id);
        return '<option value="' + esc(config.id) + '">' + esc(name + ' · ' + provider + ' · ' + String(config.model || '自动')) + '</option>';
      }).join('');
      select.value = configs.some(function (config) { return config.id === selected; }) ? selected : '';
      selectedConfigId = select.value;
      var hint = overlay.querySelector('.ips-consent-note');
      if (hint) hint.textContent = configs.length ? '选择视觉 API 配置后，只有点击“分析”或“生成动作草稿”时才会通过现有 callApiChat 发出请求。API Key 仍由 Credential Vault 解析。' : '当前没有可用 API 配置。你仍可手动裁切、分层、编辑骨骼与动作。';
      return configs;
    }).catch(function () { configs = []; return []; });
  }
  function refreshRoleList() {
    var select = byId('puppet-bind-role'); if (!select) return Promise.resolve([]);
    return Promise.resolve(typeof window.dbGetAll === 'function' ? window.dbGetAll('apiConfigs') : window.apiConfigs || []).then(function (rows) {
      var roles = (Array.isArray(rows) ? rows : []).filter(function (row) { return row && row.id && !row.archived && !row._group; });
      select.innerHTML = '<option value="">不绑定角色</option>' + roles.map(function (row) { return '<option value="' + esc(row.id) + '">' + esc(row.nickname || row.model || row.id) + '</option>'; }).join('');
      select.value = project && project.roleId || '';
      return roles;
    }).catch(function () { return []; });
  }
  function refreshRuntimeLibrary() {
    var select = byId('puppet-runtime-library'); if (!select) return Promise.resolve([]);
    var api = window.IB && window.IB.host && window.IB.host.characterPuppets;
    if (!api || !api.available) { select.innerHTML = '<option value="">仅 Tauri 桌面版提供本机运行包库</option>'; return Promise.resolve([]); }
    return api.list().then(function (bundles) {
      select.innerHTML = '<option value="">选择要重新编辑的运行包</option>' + bundles.map(function (bundle) { return '<option value="' + esc(bundle.bundleId) + '">' + esc(bundle.name) + ' · ' + Number(bundle.layerCount || 0) + ' 层</option>'; }).join('');
      return bundles;
    }).catch(function () { select.innerHTML = '<option value="">本机运行包库暂不可用</option>'; return []; });
  }
  function refreshProjectLibrary() {
    var select = byId('puppet-project-library'); if (!select) return Promise.resolve([]);
    var api = window.IB && window.IB.host && window.IB.host.puppetProjects;
    if (!api || !api.available) {
      select.innerHTML = '<option value="">本机工程库需要 Windows Tauri 桌面版</option>';
      updateButtons(); return Promise.resolve([]);
    }
    var selected = select.value;
    return api.list().then(function (items) {
      items = Array.isArray(items) ? items : [];
      select.innerHTML = '<option value="">选择本机可编辑工程</option>' + items.map(function (item) {
        var date = String(item.updatedAt || '').slice(0, 10);
        return '<option value="' + esc(item.projectId) + '">' + esc(item.name || '未命名角色') + (date ? ' · ' + esc(date) : '') + '</option>';
      }).join('');
      select.value = items.some(function (item) { return item.projectId === selected; }) ? selected : '';
      updateButtons(); return items;
    }).catch(function () {
      select.innerHTML = '<option value="">本机工程列表暂不可用</option>';
      updateButtons(); return [];
    });
  }
  function setLocalAiProgress(value, message) {
    var progress = byId('puppet-ai-progress'), label = byId('puppet-ai-progress-label');
    if (progress) progress.value = Math.max(0, Math.min(100, Number(value) || 0));
    if (label && message) label.textContent = String(message);
  }
  async function listenLocalAiProgress() {
    if (aiProgressUnlisten) return;
    var events = window.__TAURI__ && window.__TAURI__.event;
    if (!events || typeof events.listen !== 'function') return;
    aiProgressUnlisten = await events.listen('ib-puppet-ai-progress', function (event) {
      var payload = event && event.payload || {};
      setLocalAiProgress(payload.progress, payload.message || payload.task || '本地 AI 正在运行…');
    });
  }
  function localAiError(error) {
    var value = String(error && error.message || error || '未知错误');
    var messages = [
      [/PUPPET_AI_LICENSE_ACK_REQUIRED/, '请先确认已阅读模型许可和 OpenRAIL 使用限制。'],
      [/PUPPET_AI_DEPENDENCIES_MISSING:([\s\S]*)/, function (_, list) { return '所选 Python 环境缺少依赖：' + list + '。请在独立环境安装 See-through requirements 后重试。'; }],
      [/PUPPET_AI_CUDA_REQUIRED/, '当前 Python 环境没有可用的 CUDA GPU；See-through 此 NF4 工作流需要 CUDA。'],
      [/PUPPET_AI_MODEL_DISK_SPACE_LOW/, '所选模型目录所在磁盘可用空间不足 8 GiB，取消权重下载。'],
      [/PUPPET_AI_SOURCE_INVALID/, '源码目录不是有效的 See-through 仓库。'],
      [/PUPPET_AI_PYTHON_NOT_FOUND/, '找不到所选 Python 可执行文件。'],
      [/PUPPET_AI_MODEL_DIRECTORY_UNAVAILABLE/, '无法访问所选模型目录。'],
      [/PUPPET_AI_MODELS_MISSING/, '本地模型不完整；请重新安装/修复组件。'],
      [/PUPPET_AI_INFERENCE_FAILED|PUPPET_AI_PROCESS_FAILED/, 'See-through 推理失败。原工程未改动；可查看组件任务日志后重试。'],
      [/PUPPET_AI_NOT_INSTALLED/, '尚未安装本地 AI 组件；可继续使用 PSD 导入与手动分层。']
    ];
    for (var i = 0; i < messages.length; i++) {
      var match = value.match(messages[i][0]);
      if (match) return typeof messages[i][1] === 'function' ? messages[i][1].apply(null, match) : messages[i][1];
    }
    return value.slice(0, 260);
  }
  async function refreshLocalAiStatus() {
    var api = window.IB && window.IB.host && window.IB.host.puppetAi;
    var statusNode = byId('puppet-ai-status'), versionNode = byId('puppet-ai-version');
    if (!api || !api.available) {
      aiComponentInstalled = false; aiComponentReady = false;
      if (statusNode) statusNode.textContent = '本地 AI 组件仅在 Tauri 桌面版可选；上传立绘、导入分层 PSD 和手动套索仍可用。';
      if (versionNode) versionNode.textContent = '可选';
      updateButtons(); return null;
    }
    try {
      var status = await api.status();
      aiComponentInstalled = !!status.installed; aiComponentReady = !!status.ready;
      if (statusNode) {
        statusNode.textContent = status.installed
          ? String(status.message || '') + (status.gpuName ? ' · ' + status.gpuName : '') + (status.sourceRevision ? ' · source ' + String(status.sourceRevision).slice(0, 9) : '') + (status.layerdiffRevision ? ' · LayerDiff ' + String(status.layerdiffRevision).slice(0, 8) : '') + (status.marigoldRevision ? ' · Marigold ' + String(status.marigoldRevision).slice(0, 8) : '')
          : '未安装本地组件；上传立绘、导入 PSD 和手动套索可独立使用。';
      }
      if (versionNode) versionNode.textContent = status.installed ? 'v' + String(status.version || '?') + (status.ready ? ' · 就绪' : ' · 待修复') : '未安装';
      updateButtons(); return status;
    } catch (error) {
      aiComponentInstalled = false; aiComponentReady = false;
      if (statusNode) statusNode.textContent = '组件状态读取失败：' + localAiError(error);
      if (versionNode) versionNode.textContent = '状态错误';
      updateButtons(); return null;
    }
  }
  async function installLocalAi() {
    var api = window.IB && window.IB.host && window.IB.host.puppetAi;
    if (!api || !api.available) { say('本地 AI 组件只在 Windows Tauri 桌面版提供。', true); return; }
    if (!byId('puppet-ai-license-ack').checked) { say('安装前请阅读并确认模型权重的 OpenRAIL 使用限制。', true); return; }
    aiBusy = true; updateButtons(); setLocalAiProgress(0, '请选择组件目录、See-through 源码、Python 3.12 和模型目录；若依赖未就绪，会在组件目录创建独立 venv。');
    try {
      await listenLocalAiProgress();
      var componentRoot = await api.pickPath('component'); if (!componentRoot) return;
      var sourceRoot = await api.pickPath('source'); if (!sourceRoot) return;
      var pythonExecutable = await api.pickPath('python'); if (!pythonExecutable) return;
      var modelDirectory = await api.pickPath('models'); if (!modelDirectory) return;
      setLocalAiProgress(2, '正在检查依赖、CUDA 和模型目录…');
      var status = await api.install({ componentRoot: componentRoot, sourceRoot: sourceRoot, pythonExecutable: pythonExecutable, modelDirectory: modelDirectory, licenseAcknowledged: true });
      aiComponentInstalled = !!status.installed; aiComponentReady = !!status.ready;
      setLocalAiProgress(100, status.message || '本地 AI 组件已安装。');
      say(status.ready ? '本地 AI 组件已安装并验证；模型与 Python 环境仍留在所选目录。' : String(status.message || '组件安装后仍有依赖待补齐。'), !status.ready);
    } catch (error) {
      setLocalAiProgress(0, localAiError(error)); say('AI 组件安装未完成：' + localAiError(error), true);
    } finally { aiBusy = false; updateButtons(); await refreshLocalAiStatus(); }
  }
  async function uninstallLocalAi() {
    var api = window.IB && window.IB.host && window.IB.host.puppetAi;
    if (!api || !api.available || !aiComponentInstalled) return;
    var removeManagedEnvironment = !!byId('puppet-ai-remove-venv').checked;
    if (!window.confirm('卸载 IB 的本地 AI 组件注册与管理记录？外置 See-through 源码、模型权重和已生成 PSD 会保留。' + (removeManagedEnvironment ? '同时只删除 IB 创建的 Python venv。' : 'Python 环境也会保留。'))) return;
    aiBusy = true; updateButtons();
    try { await api.uninstall({ removeManagedEnvironment: removeManagedEnvironment }); byId('puppet-ai-remove-venv').checked = false; aiComponentReady = false; aiComponentInstalled = false; setLocalAiProgress(0, '组件已卸载；模型、源码和生成结果已保留。'); say('本地 AI 组件已卸载；现有工程、PSD 导入和手动编辑不受影响。'); }
    catch (error) { say('卸载组件失败：' + localAiError(error), true); }
    finally { aiBusy = false; updateButtons(); await refreshLocalAiStatus(); }
  }
  async function clearLocalAiCache() {
    var api = window.IB && window.IB.host && window.IB.host.puppetAi;
    if (!api || !api.available || !aiComponentInstalled) return;
    var removeModels = !!byId('puppet-ai-remove-models').checked;
    var prompt = removeModels
      ? '将清除 IB 临时缓存，并从所选模型目录移除 See-through 的两组模型权重（约 5.3 GiB）。其他模型和任务结果会保留。继续吗？'
      : '将清除 IB 创建的临时推理缓存，不删除 Python 环境、模型权重或生成 PSD。继续吗？';
    if (!window.confirm(prompt)) return;
    aiBusy = true; updateButtons();
    try { var bytes = await api.clearCache(removeModels); byId('puppet-ai-remove-models').checked = false; setLocalAiProgress(0, '清理完成' + (bytes ? ' · 释放 ' + (bytes / 1073741824).toFixed(2) + ' GiB 模型缓存' : ' · 未删除模型权重')); say('本地 AI 缓存清理完成。'); }
    catch (error) { say('缓存清理失败：' + localAiError(error), true); }
    finally { aiBusy = false; updateButtons(); await refreshLocalAiStatus(); }
  }
  async function runLocalAiLayering() {
    var api = window.IB && window.IB.host && window.IB.host.puppetAi;
    if (!api || !api.available || !aiComponentReady) { say('先安装并验证本地 AI 组件；其余 Studio 功能不依赖 AI。', true); return; }
    if (!project || !project.reference || !project.reference.dataUrl) { say('先上传角色立绘或设定图。', true); return; }
    if (project.layers.length && !window.confirm('AI 结果会以新的可编辑候选工程替换当前页面。已保存的旧工程不会删除。继续？')) return;
    var projectBeforeAi = JSON.stringify(snapshotProject());
    var input = project.view && project.view.assetId && project.assets[project.view.assetId] || project.reference.dataUrl;
    aiBusy = true; updateButtons(); setLocalAiProgress(2, '正在启动本地 See-through；源图不会发送到 Provider。');
    try {
      await listenLocalAiProgress();
      var result = await api.run({ sourceDataUrl: input, inputName: project.reference.name || 'puppet-front-view' });
      setLocalAiProgress(96, '分层完成，正在读取 PSD 并导入可编辑候选工程…');
      var parts = [], offset = 0;
      while (offset < Number(result.bytes)) {
        var chunk = await api.readResultChunk(result.jobId, offset, 262144);
        var bytes = Uint8Array.from(chunk.bytes || []);
        if (!bytes.length || Number(chunk.offset) !== offset || Number(chunk.totalSize) !== Number(result.bytes)) throw new Error('AI 结果分块不完整。');
        parts.push(bytes); offset += bytes.length;
      }
      if (JSON.stringify(snapshotProject()) !== projectBeforeAi
        && !window.confirm('推理期间当前工程被修改。导入 AI 候选会替换页面中的未保存修改，继续导入吗？')) {
        setLocalAiProgress(100, 'PSD 候选已保存在组件任务目录；当前工程保持不变。');
        say('当前工程保持不变；可从 AI 任务目录手动导入刚生成的 PSD。');
        return;
      }
      var file = new File([new Blob(parts, { type: 'application/octet-stream' })], String(result.fileName || 'see-through-candidate.psd'), { type: 'application/octet-stream' });
      var accepted = await openSeeThroughPsd(file, true);
      if (!accepted) throw new Error('生成 PSD 未能导入；原工程仍保留，可从 AI 组件任务目录重试。');
      setLocalAiProgress(100, '已导入为候选工程，请检查断层、缺层与透明边缘后再导出。');
      say('See-through 分层已作为可编辑候选导入；请确认遮挡与边缘，不会自动视为成品。');
    } catch (error) {
      setLocalAiProgress(0, localAiError(error)); say('本地 AI 分层未完成：' + localAiError(error) + ' 原有工程保持不变。', true);
    } finally { aiBusy = false; updateButtons(); await refreshLocalAiStatus(); }
  }
  function openReferenceFile(file) {
    Core.readFileDataUrl(file).then(function (dataUrl) { return Core.loadImage(dataUrl).then(function (image) { return { dataUrl: dataUrl, image: image }; }); }).then(function (result) {
      pushHistory(); project = project || Core.createProject('DeepSeek 女仆');
      var assetId = Core.createId('reference');
      project.reference = { assetId: assetId, name: String(file.name || '角色参考图').slice(0, 160), width: result.image.naturalWidth, height: result.image.naturalHeight, dataUrl: result.dataUrl };
      project.view = { label: '整张参考图', rect: { x: 0, y: 0, width: 1, height: 1 }, assetId: '', width: 0, height: 0 };
      project.aiDraft = null;
      if (projectInput) projectInput.value = '';
      var summary = byId('puppet-reference-summary'); if (summary) summary.textContent = project.reference.name + ' · ' + result.image.naturalWidth + ' × ' + result.image.naturalHeight;
      var title = byId('puppet-project-name'); if (title) title.value = project.name;
      editMode = 'view'; selection = null; setMode('view'); renderCanvas(); updateButtons();
      say('参考图已载入。请框选一个正面视角作为动画画布，或让已选 Provider 给出可修正的结构建议。');
      markProject();
    }).catch(function (error) { say(String(error && error.message || '读取参考图失败。'), true); });
  }
  function openReferenceFileFromInput() { if (referenceInput && referenceInput.files && referenceInput.files[0]) openReferenceFile(referenceInput.files[0]); }
  function imageDataPngUrl(imageData) {
    if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height) || !imageData.data) throw new Error('PSD 图层没有有效像素数据。');
    var canvas = document.createElement('canvas'); canvas.width = imageData.width; canvas.height = imageData.height;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    var pixels = context.createImageData(imageData.width, imageData.height); pixels.data.set(imageData.data); context.putImageData(pixels, 0, 0);
    var result = canvas.toDataURL('image/png'); canvas.width = 1; canvas.height = 1; return result;
  }
  function seeThroughLabel(part) {
    var labels = {
      'objects': '对象与版面（默认隐藏）', 'front hair': '前发', 'back hair': '后发', 'headwear': '头饰',
      'face': '面部', 'nose': '鼻子', 'mouth_open': '张嘴', 'mouth_close': '闭嘴（自动差分）',
      'neck': '颈部', 'topwear': '上身服装', 'bottomwear': '裙摆', 'legwear': '腿部与丝袜',
      'footwear': '鞋', 'handwear_l': '左臂与手', 'handwear_r': '右臂与手',
      'eye_close_l': '左眼闭合（自动差分）', 'eye_close_r': '右眼闭合（自动差分）'
    };
    if (labels[part.name]) return labels[part.name];
    var side = /_([lr])$/.exec(part.name || ''), base = side ? part.name.slice(0, -2) : part.name;
    var sideName = side ? (side[1] === 'l' ? '左' : '右') : '';
    var partNames = { eyewhite: '眼白', irides: '虹膜', eyelash: '睫毛', eyebrow: '眉毛', ears: '耳朵' };
    return (sideName ? sideName + partNames[base] : (partNames[base] || part.name || '图层'));
  }
  function openSeeThroughPsd(file, replaceConfirmed) {
    if (!file) return Promise.resolve(false);
    if (Number(file.size) > 128 * 1024 * 1024) { say('PSD 超过 128 MB，请先缩小图层尺寸。', true); return Promise.resolve(false); }
    if (!window.agPsd || !window.Rigger || !window.GenericParts) { say('自动 Rig 组件没有加载；请确认 ag-psd、rigger 与 GenericParts 脚本已安装。', true); return Promise.resolve(false); }
    if (project && (project.layers.length || project.reference.dataUrl)
      && !replaceConfirmed && !window.confirm('导入 PSD 会切换当前页面工程；已有的本机工程记录不会删除。请先保存未保存修改，继续导入吗？')) return Promise.resolve(false);
    projectBusy = true; updateButtons(); say('正在解析分层 PSD，并从真实图层推断骨骼、锚点与动作…');
    return file.arrayBuffer().then(function (buffer) {
      var psd = window.agPsd.readPsd(new Uint8Array(buffer), { useImageData: true, skipThumbnail: true, skipCompositeImageData: false });
      window.Rigger.validatePsd(psd);
      if (!psd.imageData) throw new Error('PSD 缺少合成参考图，请在图像编辑器中重新保存后再导入。');
      var generic = { eyeL: window.GenericParts.get('eyeL'), eyeR: window.GenericParts.get('eyeR'), mouth: window.GenericParts.get('mouth') };
      var rig = window.Rigger.buildRig(psd, { generic: generic });
      if (!rig.layers || !rig.layers.length) throw new Error('PSD 没有可用的角色图层。');
      var next = Core.createProject(String(file.name || 'DeepSeek 女仆鲸鱼娘').replace(/\.psd$/i, '') || 'DeepSeek 女仆鲸鱼娘');
      var referenceId = Core.createId('reference'), referenceUrl = imageDataPngUrl(psd.imageData);
      next.canvas = { width: rig.canvas.w, height: rig.canvas.h };
      next.reference = { assetId: referenceId, name: String(file.name || '角色 PSD').slice(0, 160), width: rig.canvas.w, height: rig.canvas.h, dataUrl: referenceUrl };
      next.assets[referenceId] = referenceUrl;
      next.view = { label: 'See-through 正面图层', rect: { x: 0, y: 0, width: 1, height: 1 }, assetId: referenceId, width: rig.canvas.w, height: rig.canvas.h, viewId: 'front' };

      var handR = rig.layers.find(function (part) { return part.source === 'handwear-r' || (part.name === 'handwear_r'); });
      var handL = rig.layers.find(function (part) { return part.source === 'handwear-l' || (part.name === 'handwear_l'); });
      function shoulder(part, side) {
        if (!part) return { x: rig.anchors.face.cx + (side === 'L' ? 54 : -54), y: rig.anchors.neckPivot.cy + 25 };
        return { x: part.x + part.w * (side === 'R' ? .88 : .12), y: part.y + part.h * .12 };
      }
      var rightShoulder = shoulder(handR, 'R'), leftShoulder = shoulder(handL, 'L');
      var headPivot = rig.anchors.neckPivot || { cx: rig.anchors.face.cx, cy: rig.anchors.face.y1 };
      next.bones = [
        { id: 'root', name: 'Root', parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { id: 'body', name: '身体', parent: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { id: 'head', name: '头部', parent: 'body', x: headPivot.cx, y: headPivot.cy, rotation: 0, scaleX: 1, scaleY: 1 },
        { id: 'left-arm', name: '左臂', parent: 'body', x: leftShoulder.x, y: leftShoulder.y, rotation: 0, scaleX: 1, scaleY: 1 },
        { id: 'right-arm', name: '右臂', parent: 'body', x: rightShoulder.x, y: rightShoulder.y, rotation: 0, scaleX: 1, scaleY: 1 }
      ];
      var pivots = { body: { x: 0, y: 0 }, head: { x: headPivot.cx, y: headPivot.cy }, 'left-arm': leftShoulder, 'right-arm': rightShoulder };
      var rigLayerIds = Object.create(null);
      var missingBottomwear = !rig.layers.some(function (part) { return part.name === 'bottomwear'; });
      rig.layers.forEach(function (part, index) {
        var assetId = Core.createId('raster'), dataUrl = imageDataPngUrl(part.img), side = String(part.side || '').toUpperCase();
        next.assets[assetId] = dataUrl;
        var bone = part.group === 'head' ? 'head' : 'body';
        if (/^handwear/.test(part.name) || /^handwear-/.test(part.source || '')) bone = side === 'L' || /(?:_|-)l$/.test(part.name) || /-l$/.test(part.source || '') ? 'left-arm' : 'right-arm';
        var pivot = pivots[bone] || pivots.body;
        var mesh = null;
        if (part.phys === 'hair' && Array.isArray(part.strands) && part.strands.length) {
          mesh = { columns: Math.max(3, Math.min(12, part.strands.length + 1)), rows: Math.max(8, Math.min(20, Math.round(part.h / 24))),
            pinY: .14, swayX: part.name === 'front hair' ? 2.8 : 5.5, swayY: 1.2, frequency: part.name === 'front hair' ? 1.1 : .82,
            phase: Number(part.z || index) * .19, stiffness: 25, damping: 8.5 };
        }
        var label = seeThroughLabel(part), note = 'See-through PSD；本地 Anime2.5DRig MIT 自动 Rig。锚点按透明轮廓与部件边界估计，导出前请逐层检查。';
        if (part.source === 'objects') note = '版面文字与装饰对象，不属于角色；默认隐藏，可在图层树中检查。';
        if (part.source === 'topwear') note = missingBottomwear
          ? 'See-through 将围裙/上身与裙摆分离，腰部有断层。请用补画修复并拆出裙摆层；禁止用网格移动掩盖。'
          : '检查上身服装与裙摆连接、遮挡和透明边缘；需要时在补画层中修复。';
        if (part.source === 'legwear') note = missingBottomwear
          ? '当前主要是腿部/丝袜；PSD 的 bottomwear 为空。裙摆需在人工补画流程中重建。'
          : '检查腿部与服装的遮挡和连接；确认关节枢轴后再添加网格。';
        if (part.unknown) note += ' 图层名称未自动识别，已保留为可编辑层并设为刚性跟随。';
        if (part.phys === 'hair' && mesh) note += ' 已生成沿发根固定、分列弹簧的局部网格。';
        var id = Core.createId('layer'); rigLayerIds[part.name] = id;
        next.layers.push({ id: id, name: label, assetId: assetId, rawAssetId: assetId, bone: bone,
          x: part.x + part.w / 2 - pivot.x, y: part.y + part.h / 2 - pivot.y, rotation: 0, anchorX: .5, anchorY: .5,
          scaleX: 1, scaleY: 1, alpha: Number.isFinite(Number(part.opacity)) ? Number(part.opacity) : 1,
          zIndex: Number.isFinite(Number(part.z)) ? Number(part.z) : index, visible: part.source !== 'objects', viewBox: null,
          confidence: part.synthetic ? .55 : (part.unknown ? .35 : .78), notes: note, mesh: mesh });
      });
      var leftBlink = { id: 'blink-left', side: 'L', openLayerIds: ['eyewhite_l','irides_l','eyelash_l'].map(function (name) { return rigLayerIds[name]; }).filter(Boolean), closedLayerId: rigLayerIds.eye_close_l };
      var rightBlink = { id: 'blink-right', side: 'R', openLayerIds: ['eyewhite_r','irides_r','eyelash_r'].map(function (name) { return rigLayerIds[name]; }).filter(Boolean), closedLayerId: rigLayerIds.eye_close_r };
      var blinkPairs = [leftBlink, rightBlink].filter(function (pair) { return pair.openLayerIds.length && pair.closedLayerId; });
      var mouthOpen = rigLayerIds.mouth_open, mouthClosed = rigLayerIds.mouth_close;
      next.motions = {
        breath: { boneId: 'body', periodSeconds: 4.2, amplitudeY: .6, scaleY: .003 },
        gaze: { boneId: 'head', periodSeconds: 5.8, amplitudeX: .7, amplitudeY: .45 },
        headTurn: { boneId: 'head', periodSeconds: 7, amplitudeX: .35, amplitudeRotation: .014 },
        blink: blinkPairs.length ? { openLayerId: blinkPairs[0].openLayerIds[0], closedLayerId: blinkPairs[0].closedLayerId, pairs: blinkPairs, minIntervalSeconds: 2.8, maxIntervalSeconds: 5.2, durationSeconds: .18 } : null,
        mouth: mouthOpen && mouthClosed ? { openLayerId: mouthOpen, closedLayerId: mouthClosed, sensitivity: 1 } : null,
        actions: [{ id: 'look', label: '轻微转头', durationSeconds: 3.6, fadeInSeconds: .16, fadeOutSeconds: .2,
          keyframes: [{ boneId: 'head', at: 0, rotation: 0, easing: 'smooth' }, { boneId: 'head', at: .9, rotation: -.045, easing: 'easeInOut' }, { boneId: 'head', at: 1.8, rotation: .04, easing: 'easeInOut' }, { boneId: 'head', at: 2.7, rotation: -.025, easing: 'easeInOut' }, { boneId: 'head', at: 3.6, rotation: 0, easing: 'smooth' }] }]
      };
      return Core.normalizeProject(next);
    }).then(function (next) {
      project = next; selectedLayerId = project.layers[0] && project.layers[0].id || ''; selectedBoneId = 'head'; selectedActionId = 'look'; selectedKeyframeIndex = -1;
      historyPast.length = 0; historyFuture.length = 0; stateFillCandidate = null; stateSelection = { view: -1, part: -1 };
      byId('puppet-project-name').value = project.name; byId('puppet-reference-summary').textContent = file.name + ' · ' + project.canvas.width + ' × ' + project.canvas.height + ' · ' + project.layers.length + ' 个 Rig 图层';
      editMode = 'view'; selection = null; activePane = 'layers';
      renderEditor(); renderCanvas(); updateButtons(); schedulePreview(); markProject(false);
      var hasBlink = project.motions.blink && project.motions.blink.pairs && project.motions.blink.pairs.length === 2;
      say('PSD 自动 Rig 完成：' + project.layers.length + ' 层、' + project.bones.length + ' 骨骼' + (hasBlink ? '、左右眼独立眨眼' : '') + (project.motions.mouth ? '、TTS 口型' : '') + '。' + (project.layers.some(function (layer) { return layer.name === '上身服装'; }) ? '腰部断层已标注为补画问题。' : ''));
      return true;
    }).catch(function (error) { say('PSD 自动 Rig 失败：' + String(error && error.message || error).slice(0, 220), true); return false; })
      .finally(function () { projectBusy = false; updateButtons(); });
  }
  function openProjectFile(file) {
    if (!file || Number(file.size) > Core.MAX_PROJECT_BYTES) { say('工程文件超过 160 MB。', true); return; }
    file.text().then(function (text) {
      var raw = JSON.parse(text), next = Core.normalizeProject(raw);
      pushHistory(); project = next; selectedLayerId = ''; selectedBoneId = project.bones[0] && project.bones[0].id || 'root'; selectedActionId = project.motions.actions[0] && project.motions.actions[0].id || '';
      historyPast.length = 0; historyFuture.length = 0; selectedKeyframeIndex = -1; stateFillCandidate = null;
      var title = byId('puppet-project-name'); if (title) title.value = project.name;
      var summary = byId('puppet-reference-summary'); if (summary) summary.textContent = project.reference.name || '工程含可编辑分层素材';
      stateSelection = { view: -1, part: -1 }; selection = null;
      renderEditor(); renderCanvas(); updateButtons(); schedulePreview();
      say('工程已打开。图层、骨骼、动作与参考图均可继续修改。');
    }).catch(function (error) { say('工程未能打开：' + String(error && error.message || error), true); });
  }
  function saveProject() {
    if (!project) { say('还没有可保存的工程。', true); return; }
    try {
      if (projectBytes() > Core.MAX_PROJECT_BYTES) throw new Error('工程素材总量超过 160 MB。');
      project.name = String(byId('puppet-project-name').value || project.name || '未命名角色').slice(0, 80);
      var content = JSON.stringify(Core.normalizeProject(project), null, 2), filename = safeStem(project.name) + '.ibpuppet-project.json';
      var projectStore = window.IB && window.IB.host && window.IB.host.puppetProjects;
      if (projectStore && projectStore.available) {
        projectBusy = true; updateButtons(); say('正在保存到本机可编辑工程库…');
        projectStore.save(content).then(function (record) {
          return refreshProjectLibrary().then(function () {
            var select = byId('puppet-project-library'); if (select && record && record.projectId) select.value = record.projectId;
            updateButtons(); markProject(false);
            say('可编辑工程已保存在本机用户数据中，可从左侧工程列表重新打开。');
          });
        }).catch(function (error) { say('工程保存失败：' + String(error && error.message || error).slice(0, 160), true); })
          .finally(function () { projectBusy = false; updateButtons(); });
        return;
      }
      var fileHost = window.IB && window.IB.host && window.IB.host.files;
      if (fileHost && typeof fileHost.saveText === 'function') {
        Promise.resolve(fileHost.saveText(filename, content, { types: [{ description: 'IB Puppet Editable Project', accept: { 'application/json': ['.json'] } }] })).then(function (result) {
          if (result && result.ok === false) { say(result.cancelled ? '已取消工程保存。' : '工程保存失败：' + String(result.error || '本机文件写入失败'), !result.cancelled); return; }
          say('可编辑工程文件已保存；文件包含原始参考图与图层源像素。');
        }).catch(function (error) { say('工程保存失败：' + String(error && error.message || error).slice(0, 160), true); });
        return;
      }
      saveBlob(new Blob([content], { type: 'application/json' }), filename);
      say('可编辑工程文件已导出；文件包含原始参考图与图层源像素。');
    } catch (error) { say('工程未能保存：' + String(error && error.message || error), true); }
  }
  async function loadSavedProject() {
    var store = window.IB && window.IB.host && window.IB.host.puppetProjects, select = byId('puppet-project-library'), projectId = select && select.value;
    if (!store || !store.available) { say('本机可编辑工程库需要 Windows Tauri 桌面版。', true); return; }
    if (!projectId) { say('先从工程列表中选择一个可编辑工程。', true); return; }
    projectBusy = true; updateButtons(); say('正在从本机工程库打开…');
    try {
      var content = await store.load(projectId), loaded = importProjectData(content);
      if (!loaded || loaded.ok !== true) throw new Error(loaded && loaded.reason || '工程文件无法解析。');
      var restored = Core.normalizeProject(JSON.parse(content));
      stateSelection = { view: -1, part: -1 }; selection = null; stateFillCandidate = null;
      byId('puppet-project-name').value = restored.name;
      byId('puppet-reference-summary').textContent = restored.reference.name || '工程含可编辑分层素材';
      say('工程已从本机用户数据重新打开；图层、骨骼、动作和遮罩都已恢复。');
    } catch (error) { say('工程未能打开：' + String(error && error.message || error).slice(0, 180), true); }
    finally { projectBusy = false; updateButtons(); }
  }
  async function exportProjectFile() {
    if (!project) { say('还没有可导出的工程。', true); return; }
    var content;
    try {
      if (projectBytes() > Core.MAX_PROJECT_BYTES) throw new Error('工程素材总量超过 160 MB。');
      project.name = String(byId('puppet-project-name').value || project.name || '未命名角色').slice(0, 80);
      content = JSON.stringify(Core.normalizeProject(project), null, 2);
    } catch (error) { say('工程无法导出：' + String(error && error.message || error), true); return; }
    var projectStore = window.IB && window.IB.host && window.IB.host.puppetProjects;
    if (projectStore && projectStore.available) {
      projectBusy = true; updateButtons(); say('正在导出独立可编辑工程文件…');
      try {
        var result = await projectStore.export(content);
        say('工程文件已导出：' + String(result && result.path || result && result.fileName || '本机 Puppet Projects 导出目录') + '。可通过“导入工程”重新打开。');
      } catch (error) { say('工程导出失败：' + String(error && error.message || error).slice(0, 180), true); }
      finally { projectBusy = false; updateButtons(); }
      return;
    }
    var fileHost = window.IB && window.IB.host && window.IB.host.files, filename = safeStem(project.name) + '.ibpuppet-project.json';
    if (fileHost && typeof fileHost.saveText === 'function') {
      try {
        var saved = await fileHost.saveText(filename, content, { types: [{ description: 'IB Puppet Editable Project', accept: { 'application/json': ['.json'] } }] });
        if (saved && saved.ok === false) { say(saved.cancelled ? '已取消工程导出。' : '工程导出失败：' + String(saved.error || ''), !saved.cancelled); return; }
        say('工程文件已导出，可通过“导入工程”重新打开。');
      } catch (error) { say('工程导出失败：' + String(error && error.message || error).slice(0, 180), true); }
      return;
    }
    saveBlob(new Blob([content], { type: 'application/json' }), filename); say('工程文件已导出，可通过“导入工程”重新打开。');
  }
  function saveBlob(blob, filename) {
    var link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = filename; link.style.display = 'none'; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  function pushHistory() {
    if (!project) return;
    try {
      historyTarget = null;
      historyPast.push(snapshotProject());
      if (historyPast.length > 30) historyPast.shift();
      historyFuture.length = 0;
      if (overlay) { byId('puppet-history-status').textContent = '历史记录 · ' + historyPast.length; updateButtons(); }
    } catch (_) {}
  }
  function recordInputHistory(target) { if (historyTarget === target) return; pushHistory(); historyTarget = target; }
  function finishInputHistory(target) { if (historyTarget === target) historyTarget = null; }
  function undo() {
    if (!historyPast.length || !project) return;
    try {
      historyFuture.push(snapshotProject()); project = Core.normalizeProject(historyPast.pop());
      selectedLayerId = project.layers[0] && project.layers[0].id || ''; selectedBoneId = project.bones[0] && project.bones[0].id || 'root';
      selectedActionId = project.motions.actions[0] && project.motions.actions[0].id || '';
      byId('puppet-project-name').value = project.name; renderEditor(); renderCanvas(); schedulePreview();
      byId('puppet-history-status').textContent = '历史记录 · ' + historyPast.length; updateButtons(); say('已撤销一步。');
    } catch (_) { say('无法撤销当前编辑。', true); }
  }
  function redo() {
    if (!historyFuture.length || !project) return;
    try {
      historyPast.push(snapshotProject()); project = Core.normalizeProject(historyFuture.pop());
      selectedLayerId = project.layers[0] && project.layers[0].id || ''; selectedBoneId = project.bones[0] && project.bones[0].id || 'root';
      selectedActionId = project.motions.actions[0] && project.motions.actions[0].id || '';
      byId('puppet-project-name').value = project.name; renderEditor(); renderCanvas(); schedulePreview();
      byId('puppet-history-status').textContent = '历史记录 · ' + historyPast.length; updateButtons(); say('已重做一步。');
    } catch (_) { say('无法重做当前编辑。', true); }
  }
  function optimizedReference(dataUrl, maxEdge) {
    return Core.loadImage(dataUrl).then(function (image) {
      var scale = Math.min(1, (maxEdge || 1536) / Math.max(image.naturalWidth, image.naturalHeight));
      var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', .84);
    });
  }
  function providerSupportsVision(config) {
    if (!config) return false;
    var provider = String(config.provider || '').toLowerCase(), model = String(config.model || '').toLowerCase();
    if (provider === 'openai' || provider === 'gemini' || provider === 'anthropic') return true;
    if (provider === 'deepseek') return !!config.vision || /vision/.test(model);
    return config.vision !== false || /vision|vl|multimodal/.test(model);
  }
  function parseJsonResponse(raw) {
    raw = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) throw new Error('Provider 没有返回 JSON 结构建议。');
    return JSON.parse(raw.slice(first, last + 1));
  }
  async function analyzeReference() {
    if (!project || !project.reference.dataUrl) { say('先导入一张角色设定图。', true); return; }
    var config = selectedConfig();
    if (!config) { say('请先选择视觉 API 配置。没有选定 Provider 时不会发送参考图。', true); return; }
    if (!providerSupportsVision(config)) { say('所选模型未标注视觉能力。请改选视觉模型；本轮不会发送图片。', true); return; }
    aiBusy = true; updateButtons(); say('正在请求视觉结构建议…参考图只发给你选定的 Provider。');
    try {
      var aiImage = await optimizedReference(project.reference.dataUrl, 1536);
      var messages = [
        { role: 'system', content: 'You are a visual planning helper for a manual 2D puppet editor. Return JSON only. Do not claim that pixels have been segmented or hidden regions completed. Analyze the uploaded character sheet and propose approximate normalized view boxes and independent part boxes for the front view only. Every box is {x,y,width,height} with values 0..1 relative to the entire uploaded image for views and relative to the chosen front view for parts. Include confidence 0..1 and short occlusion notes. Do not propose empty/duplicated parts. Keep parts to visible coherent regions that can be corrected by a human. Bone x/y coordinates are pixels on the selected view canvas for root; child x/y values are parent-local pixels. Schema: {"views":[{"id":"front","label":"正面","box":{"x":0,"y":0,"width":1,"height":1},"confidence":0.7,"note":"..."}],"parts":[{"id":"hair","label":"头发","viewId":"front","box":{"x":0,"y":0,"width":0.2,"height":0.2},"boneId":"head","anchorX":0.5,"anchorY":0.5,"zIndex":4,"confidence":0.5,"occlusion":"..."}],"bones":[{"id":"root","name":"Root","parent":null,"x":0,"y":0,"rotation":0}],"notes":["..."]}. Prefer a few honest suggestions over confident guesses.' },
        { role: 'user', content: [
          { type: 'text', text: 'IB_PUPPET_STUDIO_ANALYSIS. 分析这张 DeepSeek 女仆角色设定图。区分正面、侧面、背面和细节格。只建议正面视角里可以实际裁取的可见部件；不要把三视图当成可直接动画的分层模型。给出可编辑的近似框选坐标，明确标注遮挡或不确定区域。' },
          { type: '_image', mime: 'image/jpeg', base64: aiImage.slice(aiImage.indexOf(',') + 1) }
        ] }
      ];
      var requestConfig = Object.assign({}, config, { streaming: false, thinkingEnabled: false, promptCache: false, webSearch: false });
      var response = await window.callApiChat(requestConfig, messages, {
        _ibConsumer: 'ib_puppet_studio_analysis', _ibSensitiveMedia: true, disableTools: true, autoContinue: false,
        _noWebSearch: true, jsonMode: true, wantThinking: false, wantMeta: false, maxTokens: 3000, timeoutMs: 120000
      });
      var raw = typeof response === 'string' ? response : (response && typeof response.text === 'string' ? response.text : '');
      var parsed = Core.normalizeAiDraft(parseJsonResponse(raw));
      parsed.providerId = config.id; parsed.createdAt = new Date().toISOString();
      parsed.activeViewId = parsed.views.some(function (view) { return view.id === 'front'; }) ? 'front' : (parsed.views[0] && parsed.views[0].id || 'front');
      pushHistory(); project.aiDraft = parsed;
      stateSelection.view = -1; stateSelection.part = -1;
      renderSuggestions(); renderCanvas(); updateButtons();
      say('视觉草稿已到达。建议框尚未成为图层；检查正面视角与遮挡说明后，再逐项建立真实像素图层。');
    } catch (error) {
      say('结构建议失败，工程和图层未改变：' + String(error && error.message || error).slice(0, 200), true);
    } finally { aiBusy = false; updateButtons(); }
  }
  function generateAiMotions() {
    if (!project || !project.layers.length) { say('先建立可见图层，再生成可编辑动作草稿。', true); return; }
    var config = selectedConfig();
    if (!config) { say('请先选择现有动作 Provider。没有选定 Provider 时不会发送请求。', true); return; }
    aiBusy = true; updateButtons(); say('正在生成关键帧草稿…');
    var context = { canvas: project.canvas, bones: project.bones.map(function (bone) { return { id: bone.id, parent: bone.parent, x: bone.x, y: bone.y }; }), layers: project.layers.map(function (layer) { return { id: layer.id, name: layer.name, bone: layer.bone }; }) };
    var messages = [
      { role: 'system', content: 'Return JSON only. Propose editable keyframes for this existing IB Puppet rig. Do not add new layer IDs or bones. Use only existing boneId/layerId targets. Keep timing within each duration. Schema: {"actions":[{"id":"nod","label":"点头","durationSeconds":0.8,"fadeInSeconds":0.12,"fadeOutSeconds":0.16,"keyframes":[{"boneId":"head","at":0,"rotation":0,"easing":"smooth"}]}],"notes":["..."]}. Do not claim to produce image assets.' },
      { role: 'user', content: 'IB_PUPPET_STUDIO_MOTION. 为这个角色生成自然的点头和挥手动作草稿，动作要短、平滑并可手工编辑。Rig: ' + JSON.stringify(context) }
    ];
    window.callApiChat(Object.assign({}, config, { streaming: false, promptCache: false, webSearch: false }), messages, {
      _ibConsumer: 'ib_puppet_studio_motion', disableTools: true, autoContinue: false, _noWebSearch: true, jsonMode: true,
      wantThinking: false, wantMeta: false, maxTokens: 2400, timeoutMs: 90000
    }).then(function (response) {
      var raw = typeof response === 'string' ? response : (response && typeof response.text === 'string' ? response.text : ''), parsed = parseJsonResponse(raw);
      var draft = Core.normalizeAiDraft({ providerId: config.id, motions: { actions: parsed.actions || [] }, notes: parsed.notes || [] });
      pushHistory(); project.aiDraft = project.aiDraft || Core.normalizeAiDraft({}); project.aiDraft.motions = draft.motions; project.aiDraft.motionNotes = draft.notes;
      renderEditor(); markProject(false); say('AI 动作草稿已就绪。先采纳到时间轴，再编辑关键帧；现有动作没有被覆盖。');
    }).catch(function (error) { say('动作生成失败，原有动作保持不变：' + String(error && error.message || error).slice(0, 200), true); })
      .finally(function () { aiBusy = false; updateButtons(); });
  }
  function acceptAiMotions() {
    var proposed = project && project.aiDraft && project.aiDraft.motions && project.aiDraft.motions.actions;
    if (!Array.isArray(proposed) || !proposed.length) { say('当前没有可采纳的 AI 动作草稿。', true); return; }
    pushHistory();
    var merged = project.motions.actions.slice();
    proposed.forEach(function (action) {
      var index = merged.findIndex(function (item) { return item.id === action.id; });
      if (index >= 0) merged[index] = action; else merged.push(action);
    });
    var normalized = Core.normalizeProject(Object.assign({}, project, { motions: Object.assign({}, project.motions, { actions: merged }) }));
    project.motions = normalized.motions; selectedActionId = proposed[0].id;
    project.aiDraft.motions = { actions: [], notes: project.aiDraft.motionNotes || [] };
    renderEditor(); schedulePreview(); markProject(false); say('AI 动作草稿已合并到时间轴。每帧仍可手工修改。');
  }
  function renderSuggestions() {
    var views = byId('puppet-view-suggestions'), parts = byId('puppet-part-suggestions');
    if (!views || !parts) return;
    var draft = project && project.aiDraft;
    if (!draft) {
      views.innerHTML = '<p class="ips-empty">导入后可手动框选正面画布，或先运行视觉分析。</p>';
      parts.innerHTML = '<p class="ips-empty">模型给出的部件建议会显示在这里；你确认后才会从原图建立图层。</p>';
      byId('puppet-view-count').textContent = '0'; byId('puppet-part-count').textContent = '0'; return;
    }
    byId('puppet-view-count').textContent = String(draft.views.length); byId('puppet-part-count').textContent = String(draft.parts.length);
    views.innerHTML = draft.views.map(function (view, index) {
      return '<article class="ips-suggestion ' + (stateSelection.view === index ? 'is-selected' : '') + '"><div><b>' + esc(view.label) + '</b><small>可信度 ' + Math.round(view.confidence * 100) + '% · ' + esc(view.note || '框选建议') + '</small></div><button type="button" data-ips-suggestion="' + index + '" data-ips-suggestion-kind="view">预览框</button><button type="button" data-ips-view="' + index + '">设为画布</button></article>';
    }).join('') || '<p class="ips-empty">Provider 未识别到稳定的视角框。可手动拖动画布。</p>';
    parts.innerHTML = draft.parts.map(function (part, index) {
      return '<article class="ips-suggestion ' + (stateSelection.part === index ? 'is-selected' : '') + '"><div><b>' + esc(part.label) + '</b><small>可信度 ' + Math.round(part.confidence * 100) + '% · ' + esc(part.occlusion || '建议区域需要人工检查') + '</small></div><button type="button" data-ips-suggestion="' + index + '" data-ips-suggestion-kind="part">预览框</button><button type="button" data-ips-suggestion="' + index + '" data-ips-suggestion-kind="add-part">建立此层</button></article>';
    }).join('') || '<p class="ips-empty">还没有分层建议。可用套索手工创建。遮挡区域不会自动复制或填白。</p>';
    if (draft.notes && draft.notes.length) parts.insertAdjacentHTML('beforeend', '<p class="ips-notes">' + draft.notes.map(esc).join('<br>') + '</p>');
  }
  function selectSuggestion(kind, index) {
    if (!project || !project.aiDraft) return;
    if (kind === 'view') {
      stateSelection.view = index; stateSelection.part = -1; setMode('view');
      var view = project.aiDraft.views[index]; selection = rectPolygon({ x: view.box.x * byId('puppet-source-canvas').width, y: view.box.y * byId('puppet-source-canvas').height }, { x: (view.box.x + view.box.width) * byId('puppet-source-canvas').width, y: (view.box.y + view.box.height) * byId('puppet-source-canvas').height });
    } else {
      stateSelection.part = index;
      var part = project.aiDraft.parts[index], viewIndex = project.aiDraft.views.findIndex(function (item) { return item.id === part.viewId; });
      if (part.viewId !== activeViewId() && viewIndex >= 0) {
        chooseViewSuggestion(viewIndex).then(function () {
          setMode('layer'); suggestionToSelection(index); renderCanvas(); updateButtons(); renderSuggestions();
          if (kind === 'add-part') addLayerFromSelection(index);
        });
        return;
      }
      setMode('layer'); suggestionToSelection(index);
      if (kind === 'add-part') { addLayerFromSelection(index); renderSuggestions(); return; }
    }
    renderSuggestions(); renderCanvas(); updateButtons();
  }
  function chooseViewSuggestion(index) {
    if (!project || !project.aiDraft || !project.aiDraft.views[index]) return;
    stateSelection.view = index; selection = null;
    var view = project.aiDraft.views[index], rect = view.box;
    return setViewRect({ x: rect.x * project.reference.width, y: rect.y * project.reference.height, width: rect.width * project.reference.width, height: rect.height * project.reference.height }, view.label, view.id);
  }
  function suggestionToSelection(index) {
    if (!project || !project.aiDraft || !project.aiDraft.parts[index] || !project.view.width) return;
    var box = project.aiDraft.parts[index].box, canvas = byId('puppet-source-canvas');
    selection = rectPolygon({ x: box.x * canvas.width, y: box.y * canvas.height }, { x: (box.x + box.width) * canvas.width, y: (box.y + box.height) * canvas.height });
  }
  function useFullImage() {
    if (!project || !project.reference.dataUrl) { say('先导入参考图。', true); return; }
    setViewRect({ x: 0, y: 0, width: project.reference.width, height: project.reference.height }, '整图视角', 'full');
  }
  function useSelectionAsView() {
    if (!project || !selection || editMode !== 'view') return;
    var points = selection, left = Math.min.apply(Math, points.map(function (p) { return p.x; })), top = Math.min.apply(Math, points.map(function (p) { return p.y; }));
    var right = Math.max.apply(Math, points.map(function (p) { return p.x; })), bottom = Math.max.apply(Math, points.map(function (p) { return p.y; }));
    setViewRect({ x: left, y: top, width: right - left, height: bottom - top }, '手动选择视角', 'manual-' + Date.now().toString(36));
  }
  function setViewRect(rect, label, viewId) {
    if (!project || !project.reference.dataUrl) return;
    return Core.cropSource(project.reference.dataUrl, rect).then(function (cropped) {
      pushHistory();
      var assetId = Core.createId('view'); project.assets[assetId] = cropped.dataUrl;
      project.view = {
        label: String(label || '角色视角').slice(0, 32),
        rect: { x: cropped.sourceRect.x / project.reference.width, y: cropped.sourceRect.y / project.reference.height, width: cropped.sourceRect.width / project.reference.width, height: cropped.sourceRect.height / project.reference.height },
        assetId: assetId, width: cropped.width, height: cropped.height, viewId: String(viewId || 'front')
      };
      project.canvas = { width: Math.max(256, Math.min(4096, cropped.width)), height: Math.max(256, Math.min(4096, cropped.height)) };
      project.aiDraft = project.aiDraft || null;
      if (project.aiDraft) project.aiDraft.activeViewId = project.view.viewId;
      editMode = 'layer'; selection = null; stateSelection.part = -1;
      overlay.querySelectorAll('[data-ips-mode]').forEach(function (button) { button.classList.toggle('is-active', button.getAttribute('data-ips-mode') === 'layer'); });
      renderSuggestions(); renderEditor(); renderCanvas(); markProject();
      say('已将「' + project.view.label + '」设为动画画布。之后的图层来自你选择的实际像素。');
    }).catch(function (error) { say('视角裁切失败：' + String(error && error.message || error), true); });
  }
  function addLayerFromSelection(suggestionIndex) {
    if (!project || !project.view.assetId || !selection || selection.length < 3) { say('先在工作画布围出一个部件选区。', true); return; }
    var source = project.assets[project.view.assetId], suggestion = Number.isInteger(suggestionIndex) && project.aiDraft ? project.aiDraft.parts[suggestionIndex] : null;
    var tolerance = Number(byId('puppet-background-tolerance').value) || 28, removeBackground = !!byId('puppet-remove-background').checked;
    projectBusy = true; updateButtons(); say('正在从选区提取真实像素…');
    Core.cutoutPolygon(source, selection.slice(), { removeBackground: removeBackground, tolerance: tolerance, keyColor: [255, 255, 255] }).then(function (cutout) {
      pushHistory();
      var id = Core.createId('layer'), assetId = Core.createId('raster'), rawAssetId = Core.createId('raw'), canvas = byId('puppet-source-canvas');
      project.assets[assetId] = cutout.dataUrl; project.assets[rawAssetId] = cutout.sourceDataUrl;
      var rect = { x: cutout.box.x / canvas.width, y: cutout.box.y / canvas.height, width: cutout.box.width / canvas.width, height: cutout.box.height / canvas.height };
      var boneId = suggestion && project.bones.some(function (bone) { return bone.id === suggestion.boneId; }) ? suggestion.boneId : 'root';
      var desiredWorld = { x: cutout.box.x + cutout.box.width / 2, y: cutout.box.y + cutout.box.height / 2, rotation: 0, scaleX: 1, scaleY: 1 };
      var local = localLayerTransformFromWorld({ bone: boneId }, desiredWorld, boneWorldTransforms(project.bones)[boneId] || { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
      project.layers.push({
        id: id, name: suggestion ? suggestion.label : '图层 ' + (project.layers.length + 1), assetId: assetId, rawAssetId: rawAssetId,
        bone: boneId, x: local.x, y: local.y, rotation: local.rotation,
        anchorX: .5, anchorY: .5, scaleX: local.scaleX, scaleY: local.scaleY, alpha: 1, zIndex: suggestion ? suggestion.zIndex : project.layers.length,
        visible: true, viewBox: rect, confidence: suggestion ? suggestion.confidence : 0,
        notes: suggestion ? String(suggestion.occlusion || 'AI 框选建议已裁取原图像素；遮挡补全部件仍需手工或显式 AI 编辑。') : '由用户手工套索裁取原图像素。', mesh: null
      });
      selectedLayerId = id; selection = null; renderEditor(); renderCanvas(); schedulePreview();
      say('图层「' + project.layers[project.layers.length - 1].name + '」已由参考图像素建立；请在预览和属性面板检查边缘、锚点与遮挡。');
    }).catch(function (error) { say('图层提取失败：' + String(error && error.message || error), true); })
      .finally(function () { projectBusy = false; updateButtons(); });
  }
  function selectedSuggestionView() { return project && project.aiDraft && project.aiDraft.views.find(function (view) { return view.id === activeViewId(); }); }
  function findLayer(id) { return project && project.layers.find(function (layer) { return layer.id === id; }) || null; }
  function findBone(id) { return project && project.bones.find(function (bone) { return bone.id === id; }) || null; }
  function findAction(id) { return project && project.motions.actions.find(function (action) { return action.id === id; }) || null; }
  function renderEditor() {
    if (!overlay || !project) return;
    var title = byId('puppet-project-name'); if (title && title.value !== project.name) title.value = project.name;
    var roleSelect = byId('puppet-bind-role'); if (roleSelect && project.roleId && Array.from(roleSelect.options).some(function (option) { return option.value === project.roleId; })) roleSelect.value = project.roleId;
    renderSuggestions(); renderLayerList(); renderBoneList(); renderActionList(); renderProperties(); renderFillCandidate(); renderMotionTargets(); renderPhysiology(); renderTimeline(); updateButtons();
    var aiMotionBox = byId('puppet-ai-motions'); if (aiMotionBox) aiMotionBox.hidden = !(project.aiDraft && project.aiDraft.motions && Array.isArray(project.aiDraft.motions.actions) && project.aiDraft.motions.actions.length);
    setPane(activePane);
  }
  function renderLayerList() {
    var list = byId('puppet-layer-list'), count = byId('puppet-layer-count');
    if (!list || !project) return;
    if (count) count.textContent = String(project.layers.length);
    if (!project.layers.length) { list.innerHTML = '<p class="ips-empty">图层由参考图裁切或从已有运行包导入，不会用空白图片代替。</p>'; return; }
    list.innerHTML = project.layers.slice().sort(function (a, b) { return Number(b.zIndex) - Number(a.zIndex); }).map(function (layer) {
      return '<div class="ips-layer-row ' + (layer.id === selectedLayerId ? 'is-selected' : '') + '"><input type="checkbox" data-layer-visible="' + esc(layer.id) + '" ' + (layer.visible ? 'checked' : '') + ' aria-label="显示 ' + esc(layer.name) + '"><button type="button" data-ips-layer="' + esc(layer.id) + '">' + esc(layer.name) + '</button><small>' + esc(layer.bone) + '</small></div>';
    }).join('');
  }
  function renderBoneList() {
    var list = byId('puppet-bone-list'); if (!list || !project) return;
    list.innerHTML = project.bones.map(function (bone) {
      return '<div class="ips-bone-row ' + (bone.id === selectedBoneId ? 'is-selected' : '') + '"><span class="ips-bone-dot">◉</span><button type="button" data-ips-bone="' + esc(bone.id) + '">' + esc(bone.name) + '</button><small>' + esc(bone.parent || '根') + '</small></div>';
    }).join('') || '<p class="ips-empty">尚无骨骼。</p>';
  }
  function renderActionList() {
    var list = byId('puppet-action-list'); if (!list || !project) return;
    list.innerHTML = project.motions.actions.map(function (action) {
      return '<div class="ips-action-row ' + (action.id === selectedActionId ? 'is-selected' : '') + '"><span>◌</span><button type="button" data-ips-action="' + esc(action.id) + '">' + esc(action.label) + '</button><small>' + Number(action.durationSeconds).toFixed(2) + 's</small></div>';
    }).join('') || '<p class="ips-empty">先添加点头、挥手示例，或用视觉 Provider 生成可编辑草稿。</p>';
  }
  function optionsForBones(selected) {
    return project.bones.map(function (bone) { return '<option value="' + esc(bone.id) + '" ' + (bone.id === selected ? 'selected' : '') + '>' + esc(bone.name) + '</option>'; }).join('');
  }
  function optionsForLayers(selected, excluded) {
    return project.layers.filter(function (layer) { return layer.id !== excluded; }).map(function (layer) { return '<option value="' + esc(layer.id) + '" ' + (layer.id === selected ? 'selected' : '') + '>' + esc(layer.name) + '</option>'; }).join('');
  }
  function renderProperties() {
    if (!project) return;
    var layerHost = byId('puppet-layer-properties'), boneHost = byId('puppet-bone-properties');
    var layer = findLayer(selectedLayerId), bone = findBone(selectedBoneId);
    if (layerHost) layerHost.innerHTML = layer ? renderLayerProperties(layer) : '<p class="ips-empty">选择一层来调整名称、骨骼、锚点、变形与深度。</p>';
    if (boneHost) boneHost.innerHTML = bone ? renderBoneProperties(bone) : '<p class="ips-empty">选择骨骼以编辑父级、锚点位置与局部变换。</p>';
    var layerUp = overlay.querySelector('[data-ips="layer-up"]'), layerDown = overlay.querySelector('[data-ips="layer-down"]'), del = overlay.querySelector('[data-ips="delete-layer"]');
    if (layerUp) layerUp.disabled = !layer; if (layerDown) layerDown.disabled = !layer; if (del) del.disabled = !layer;
  }
  function renderLayerProperties(layer) {
    var mesh = layer.mesh;
    var parentOptions = project.bones.map(function (bone) { return '<option value="' + esc(bone.id) + '" ' + (bone.id === layer.bone ? 'selected' : '') + '>' + esc(bone.name) + '</option>'; }).join('');
    var fields = [
      ['name', '图层名称', layer.name, 'text'], ['x', '局部 X', layer.x, 'number'], ['y', '局部 Y', layer.y, 'number'],
      ['rotation', '旋转 · 弧度', layer.rotation, 'number'], ['scaleX', '水平缩放', layer.scaleX, 'number'], ['scaleY', '垂直缩放', layer.scaleY, 'number'],
      ['anchorX', '锚点 X', layer.anchorX, 'number'], ['anchorY', '锚点 Y', layer.anchorY, 'number'], ['alpha', '透明度', layer.alpha, 'number'], ['zIndex', '层级排序', layer.zIndex, 'number']
    ];
    return '<div class="ips-layer-props"><label>图层名称<input data-project-field="layer" data-key="name" data-kind="text" value="' + esc(layer.name) + '"></label>' +
      '<label>绑定骨骼<select data-project-field="layer" data-key="bone" data-kind="text">' + parentOptions + '</select></label>' +
      '<div class="ips-prop-grid">' + fields.slice(1).map(function (field) { return '<label><span>' + esc(field[1]) + '</span><input type="number" step="' + (field[0] === 'zIndex' ? '1' : '.01') + '" data-project-field="layer" data-key="' + field[0] + '" data-kind="number" value="' + esc(field[2]) + '"></label>'; }).join('') + '</div>' +
      '<label class="ips-mesh-toggle"><input type="checkbox" data-layer-mesh ' + (mesh ? 'checked' : '') + '> 启用局部网格形变</label>' +
      (mesh ? '<div class="ips-prop-grid">' + [['columns','列数',mesh.columns],['rows','行数',mesh.rows],['pinY','固定高度',mesh.pinY],['swayX','水平摆幅',mesh.swayX],['swayY','垂直摆幅',mesh.swayY],['frequency','频率',mesh.frequency],['stiffness','弹性',mesh.stiffness],['damping','阻尼',mesh.damping]].map(function (field) { return '<label><span>' + field[1] + '</span><input type="number" step=".1" data-layer-mesh-field="' + field[0] + '" value="' + esc(field[2]) + '"></label>'; }).join('') + '</div>' : '<small>适合头发、衣摆等需要轻微摆动的部件。</small>') +
      '<button type="button" class="ips-wide" data-ips="mask-layer">手工修正透明边缘…</button><label>遮挡与手工修正说明<textarea data-layer-notes>' + esc(layer.notes || '') + '</textarea></label><small>来源图层像素 · 可信度 ' + Math.round((layer.confidence || 0) * 100) + '%</small></div>';
  }
  function renderBoneProperties(bone) {
    return '<div class="ips-bone-props"><label>名称<input data-project-field="bone" data-key="name" data-kind="text" value="' + esc(bone.name) + '"></label>' +
      '<label>父骨骼<select data-project-field="bone" data-key="parent" data-kind="text"><option value="">根骨骼</option>' + project.bones.filter(function (item) { return item.id !== bone.id; }).map(function (item) { return '<option value="' + esc(item.id) + '" ' + (bone.parent === item.id ? 'selected' : '') + '>' + esc(item.name) + '</option>'; }).join('') + '</select></label>' +
      '<div class="ips-prop-grid">' + [['x','局部 X'],['y','局部 Y'],['rotation','旋转'],['scaleX','缩放 X'],['scaleY','缩放 Y']].map(function (field) { return '<label><span>' + field[1] + '</span><input type="number" step=".01" data-project-field="bone" data-key="' + field[0] + '" data-kind="number" value="' + esc(bone[field[0]]) + '"></label>'; }).join('') + '</div>' +
      '<small>骨骼位置相对父级。姿势可用时间轴动作继续修改。</small><button type="button" class="ips-wide" data-ips="delete-bone">删除选中骨骼</button></div>';
  }
  function renderMotionTargets() {
    var select = byId('puppet-motion-target'); if (!select || !project) return;
    var target = select.value;
    select.innerHTML = '<optgroup label="骨骼">' + project.bones.map(function (bone) { return '<option value="b:' + esc(bone.id) + '">' + esc(bone.name) + '</option>'; }).join('') + '</optgroup>' +
      '<optgroup label="图层">' + project.layers.map(function (layer) { return '<option value="l:' + esc(layer.id) + '">' + esc(layer.name) + '</option>'; }).join('') + '</optgroup>';
    if (target && Array.from(select.options).some(function (option) { return option.value === target; })) select.value = target;
  }
  function renderPhysiology() {
    if (!project) return;
    var breathBone = byId('puppet-breath-bone');
    if (breathBone) { var selected = project.motions.breath && project.motions.breath.boneId || 'body'; breathBone.innerHTML = '<option value="">关闭呼吸</option>' + optionsForBones(selected); breathBone.value = project.motions.breath ? selected : ''; }
    var openL = byId('puppet-blink-open-l'), closedL = byId('puppet-blink-closed-l'), openR = byId('puppet-blink-open-r'), closedR = byId('puppet-blink-closed-r');
    var mouthOpen = byId('puppet-mouth-open'), mouthClosed = byId('puppet-mouth-closed');
    [openL, closedL, openR, closedR, mouthOpen, mouthClosed].forEach(function (select) { if (select) select.innerHTML = '<option value="">未设置</option>' + optionsForLayers(''); });
    var pairs = project.motions.blink && Array.isArray(project.motions.blink.pairs) ? project.motions.blink.pairs : [];
    pairs.forEach(function (pair, index) {
      var side = String(pair.side || (index === 0 ? 'L' : 'R')).toUpperCase(), openIds = pair.openLayerIds || [pair.openLayerId], openId = openIds[0] || '';
      if (side === 'L' && openL) { openL.value = openId; if (closedL) closedL.value = pair.closedLayerId; }
      if (side === 'R' && openR) { openR.value = openId; if (closedR) closedR.value = pair.closedLayerId; }
    });
    if (!pairs.length && project.motions.blink) { if (openL) openL.value = project.motions.blink.openLayerId || ''; if (closedL) closedL.value = project.motions.blink.closedLayerId || ''; }
    if (project.motions.mouth) { if (mouthOpen) mouthOpen.value = project.motions.mouth.openLayerId; if (mouthClosed) mouthClosed.value = project.motions.mouth.closedLayerId; }
    if (byId('puppet-breath-amplitude')) byId('puppet-breath-amplitude').value = project.motions.breath ? project.motions.breath.amplitudeY : 2;
    if (byId('puppet-breath-period')) byId('puppet-breath-period').value = project.motions.breath ? project.motions.breath.periodSeconds : 4;
    var turnBone = byId('puppet-turn-bone');
    if (turnBone) { var turnSelected = project.motions.headTurn && project.motions.headTurn.boneId || 'head'; turnBone.innerHTML = '<option value="">关闭头部微动</option>' + optionsForBones(turnSelected); turnBone.value = project.motions.headTurn ? turnSelected : ''; }
    if (byId('puppet-turn-amplitude')) byId('puppet-turn-amplitude').value = project.motions.headTurn ? project.motions.headTurn.amplitudeRotation : .02;
    if (byId('puppet-turn-period')) byId('puppet-turn-period').value = project.motions.headTurn ? project.motions.headTurn.periodSeconds : 6;
    var blinkSummary = byId('puppet-blink-summary');
    if (blinkSummary) blinkSummary.textContent = pairs.length > 1 ? '左右眼已独立绑定；运行时每侧分别计时，闭合时隐藏该侧眼白、虹膜与睫毛。' : (pairs.length ? '已绑定一组眨眼；补齐左右两组即可独立眨眼。' : '眨眼需要真实分开的闭眼图层；缺少闭眼素材时不伪造图层。');
    var turnSummary = byId('puppet-turn-summary');
    if (turnSummary) turnSummary.textContent = project.motions.headTurn ? '自动头部微动已启用；动作时间轴可另行播放点头或转头动作。' : '头部微动已关闭。';
  }
  function renderTimeline() {
    var action = findAction(selectedActionId), list = byId('puppet-keyframe-list');
    var durationInput = byId('puppet-action-duration'), nameInput = byId('puppet-action-name'), playhead = byId('puppet-playhead');
    if (!action) { if (list) list.innerHTML = '<p class="ips-empty">选择一个动作来编辑关键帧。</p>'; var frameProps = byId('puppet-keyframe-properties'); if (frameProps) frameProps.innerHTML = ''; return; }
    if (durationInput) durationInput.value = action.durationSeconds;
    if (nameInput && document.activeElement !== nameInput) nameInput.value = action.label;
    if (selectedKeyframeIndex >= action.keyframes.length) selectedKeyframeIndex = -1;
    if (playhead) { playhead.max = action.durationSeconds; playhead.value = Math.min(Number(playhead.value) || 0, action.durationSeconds); }
    if (list) list.innerHTML = action.keyframes.map(function (frame, index) {
      var targetLabel = frame.boneId ? (findBone(frame.boneId) || {}).name || frame.boneId : (findLayer(frame.layerId) || {}).name || frame.layerId;
      var value = frame.rotation != null ? '旋转 ' + Number(frame.rotation).toFixed(2) : (frame.x != null ? 'X ' + Number(frame.x).toFixed(1) : (frame.y != null ? 'Y ' + Number(frame.y).toFixed(1) : '变换'));
      return '<div class="ips-keyframe ' + (index === selectedKeyframeIndex ? 'is-selected' : '') + '"><button type="button" data-ips-keyframe="' + index + '">' + Number(frame.at).toFixed(2) + 's</button><span>' + esc(targetLabel) + ' · ' + esc(value) + ' · ' + esc(frame.easing || 'smooth') + '</span><button type="button" data-ips-key-delete="' + index + '">×</button></div>';
    }).join('') || '<p class="ips-empty">此动作还没有关键帧。</p>';
    renderKeyframeProperties(action.keyframes[selectedKeyframeIndex]);
    var playButton = overlay.querySelector('[data-ips="play-action"]'); if (playButton) playButton.disabled = !action.keyframes.length || !previewCall;
  }
  function renderKeyframeProperties(frame) {
    var host = byId('puppet-keyframe-properties'); if (!host) return;
    if (!frame) { host.innerHTML = '<p class="ips-empty">选择时间轴关键帧后可编辑时间、目标与变换值。</p>'; return; }
    var target = frame.boneId ? 'b:' + frame.boneId : 'l:' + frame.layerId;
    host.innerHTML = '<div class="ips-prop-grid"><label>关键帧时间<input type="number" min="0" max="60" step=".01" data-keyframe-field="at" data-keyframe-index="' + selectedKeyframeIndex + '" data-kind="number" value="' + esc(frame.at) + '"></label>' +
      '<label>作用目标<select data-keyframe-target data-keyframe-index="' + selectedKeyframeIndex + '"><optgroup label="骨骼">' + project.bones.map(function (bone) { return '<option value="b:' + esc(bone.id) + '" ' + (target === 'b:' + bone.id ? 'selected' : '') + '>' + esc(bone.name) + '</option>'; }).join('') + '</optgroup><optgroup label="图层">' + project.layers.map(function (layer) { return '<option value="l:' + esc(layer.id) + '" ' + (target === 'l:' + layer.id ? 'selected' : '') + '>' + esc(layer.name) + '</option>'; }).join('') + '</optgroup></select></label>' +
      ['x','y','rotation','scaleX','scaleY','alpha'].map(function (key) { var value = frame[key] == null ? '' : frame[key]; return '<label>' + key + '<input type="number" step=".01" data-keyframe-field="' + key + '" data-keyframe-index="' + selectedKeyframeIndex + '" data-kind="number" value="' + esc(value) + '"></label>'; }).join('') +
      '<label>插值<select data-keyframe-field="easing" data-keyframe-index="' + selectedKeyframeIndex + '" data-kind="text">' + ['smooth','linear','easeIn','easeOut','easeInOut'].map(function (easing) { return '<option value="' + easing + '" ' + ((frame.easing || 'smooth') === easing ? 'selected' : '') + '>' + easing + '</option>'; }).join('') + '</select></label></div>';
  }
  function renderActionListAndPreview() { renderActionList(); renderTimeline(); schedulePreview(); }
  function selectKeyframe(index) {
    var action = findAction(selectedActionId), frame = action && action.keyframes[index]; if (!frame) return;
    selectedKeyframeIndex = index;
    byId('puppet-playhead').value = frame.at; byId('puppet-playhead-label').textContent = Number(frame.at).toFixed(2) + ' s';
    var target = frame.boneId ? 'b:' + frame.boneId : 'l:' + frame.layerId;
    if (Array.from(byId('puppet-motion-target').options).some(function (option) { return option.value === target; })) byId('puppet-motion-target').value = target;
    renderTimeline();
  }
  function renderSuggestionsIntoPane() { renderSuggestions(); }
  function defaultMesh() { return { columns: 6, rows: 10, pinY: .15, swayX: 5, swayY: 1.5, frequency: .8, phase: 0, stiffness: 36, damping: 9 }; }
  function wouldCycle(boneId, parentId) {
    var current = findBone(parentId), visited = new Set();
    while (current) { if (current.id === boneId || visited.has(current.id)) return true; visited.add(current.id); current = current.parent ? findBone(current.parent) : null; }
    return false;
  }
  function boneWorldTransforms(bones) {
    var byId = Object.create(null), out = Object.create(null), visiting = Object.create(null);
    (bones || []).forEach(function (bone) { byId[bone.id] = bone; });
    function resolve(id) {
      if (out[id]) return out[id];
      var bone = byId[id]; if (!bone || visiting[id]) return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
      visiting[id] = true;
      var parent = bone.parent ? resolve(bone.parent) : null, result;
      if (parent) {
        var lx = (Number(bone.x) || 0) * parent.scaleX, ly = (Number(bone.y) || 0) * parent.scaleY, cosine = Math.cos(parent.rotation), sine = Math.sin(parent.rotation);
        result = { x: parent.x + cosine * lx - sine * ly, y: parent.y + sine * lx + cosine * ly, rotation: parent.rotation + (Number(bone.rotation) || 0), scaleX: parent.scaleX * (Number(bone.scaleX) || 1), scaleY: parent.scaleY * (Number(bone.scaleY) || 1) };
      } else result = { x: Number(bone.x) || 0, y: Number(bone.y) || 0, rotation: Number(bone.rotation) || 0, scaleX: Number(bone.scaleX) || 1, scaleY: Number(bone.scaleY) || 1 };
      visiting[id] = false; out[id] = result; return result;
    }
    (bones || []).forEach(function (bone) { resolve(bone.id); });
    return out;
  }
  function layerWorldPosition(layer, boneWorld) {
    var joint = boneWorld[layer.bone] || { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
    var lx = layer.x * joint.scaleX, ly = layer.y * joint.scaleY, cosine = Math.cos(joint.rotation), sine = Math.sin(joint.rotation);
    return { x: joint.x + cosine * lx - sine * ly, y: joint.y + sine * lx + cosine * ly, rotation: joint.rotation + layer.rotation, scaleX: joint.scaleX * layer.scaleX, scaleY: joint.scaleY * layer.scaleY };
  }
  function localLayerTransformFromWorld(layer, world, joint) {
    var dx = world.x - joint.x, dy = world.y - joint.y, cosine = Math.cos(joint.rotation), sine = Math.sin(joint.rotation);
    return { x: (cosine * dx + sine * dy) / Math.max(.01, joint.scaleX), y: (-sine * dx + cosine * dy) / Math.max(.01, joint.scaleY), rotation: world.rotation - joint.rotation, scaleX: world.scaleX / Math.max(.01, joint.scaleX), scaleY: world.scaleY / Math.max(.01, joint.scaleY) };
  }
  function addBone() {
    pushHistory();
    var id = Core.createId('bone'), parent = findBone(selectedBoneId) ? selectedBoneId : 'root';
    var bone = { id: id, name: '新骨骼 ' + (project.bones.length + 1), parent: parent, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
    project.bones.push(bone); selectedBoneId = id; renderEditor(); schedulePreview(); markProject(false); say('已添加子骨骼；可在右侧调整父级和局部变换。');
  }
  function deleteBone() {
    var bone = findBone(selectedBoneId); if (!bone) return;
    if (bone.id === 'root') { say('Root 骨骼是运行包坐标根，不能删除。', true); return; }
    if (project.bones.some(function (item) { return item.parent === bone.id; }) || project.layers.some(function (layer) { return layer.bone === bone.id; })) {
      say('这个骨骼仍被子骨骼或图层使用。请先重新绑定这些项目。', true); return;
    }
    pushHistory(); project.bones = project.bones.filter(function (item) { return item.id !== bone.id; }); selectedBoneId = 'root';
    renderEditor(); schedulePreview(); markProject(false);
  }
  function acceptAiBones() {
    if (!project || !project.aiDraft || !project.aiDraft.bones.length) { say('当前草稿没有骨骼建议。', true); return; }
    var overlaps = project.aiDraft.bones.filter(function (draft) { return project.bones.some(function (bone) { return bone.id === draft.id; }); });
    if (overlaps.length && !window.confirm('AI 草稿与当前 ' + overlaps.length + ' 根骨骼同名。采纳会更新这些骨骼的坐标和父级关系；图层绑定不变。继续？')) return;
    var beforeWorld = boneWorldTransforms(project.bones), layerWorld = project.layers.map(function (layer) { return { id: layer.id, world: layerWorldPosition(layer, beforeWorld) }; });
    pushHistory();
    project.aiDraft.bones.forEach(function (draft) {
      var existing = findBone(draft.id), bone = Object.assign({ scaleX: 1, scaleY: 1 }, existing || {}, draft);
      if (bone.parent && !project.bones.some(function (item) { return item.id === bone.parent; }) && !project.aiDraft.bones.some(function (item) { return item.id === bone.parent; })) bone.parent = null;
      if (existing) Object.assign(existing, bone); else project.bones.push(bone);
    });
    project.bones.forEach(function (bone) { if (bone.parent && wouldCycle(bone.id, bone.parent)) bone.parent = null; });
    var afterWorld = boneWorldTransforms(project.bones);
    layerWorld.forEach(function (saved) {
      var layer = findLayer(saved.id), joint = layer && afterWorld[layer.bone]; if (!layer || !joint) return;
      var local = localLayerTransformFromWorld(layer, saved.world, joint);
      layer.x = local.x; layer.y = local.y; layer.rotation = local.rotation; layer.scaleX = local.scaleX; layer.scaleY = local.scaleY;
    });
    renderEditor(); schedulePreview(); markProject(false); say('骨骼草稿已合并。父子关系仍可逐项修改。');
  }
  function addDefaultMotions() {
    if (!project) return;
    pushHistory();
    var head = findBone('head') ? 'head' : project.bones.find(function (bone) { return /头|head/i.test(bone.name + ' ' + bone.id); })?.id;
    var arm = findBone('left-arm') ? 'left-arm' : project.bones.find(function (bone) { return /臂|arm/i.test(bone.name + ' ' + bone.id); })?.id;
    if (head && !findAction('nod')) project.motions.actions.push({ id: 'nod', label: '点头', durationSeconds: .82, fadeInSeconds: .14, fadeOutSeconds: .18, keyframes: [{ boneId: head, at: 0, rotation: 0, easing: 'smooth' }, { boneId: head, at: .22, rotation: -.12, easing: 'easeOut' }, { boneId: head, at: .48, rotation: .075, easing: 'easeInOut' }, { boneId: head, at: .82, rotation: 0, easing: 'easeOut' }] });
    if (arm && !findAction('wave')) project.motions.actions.push({ id: 'wave', label: '挥手', durationSeconds: .92, fadeInSeconds: .12, fadeOutSeconds: .18, keyframes: [{ boneId: arm, at: 0, rotation: 0 }, { boneId: arm, at: .18, rotation: -.72, easing: 'easeOut' }, { boneId: arm, at: .38, rotation: -.22, easing: 'easeInOut' }, { boneId: arm, at: .58, rotation: -.67, easing: 'easeInOut' }, { boneId: arm, at: .78, rotation: -.18, easing: 'easeInOut' }, { boneId: arm, at: .92, rotation: 0, easing: 'easeOut' }] });
    var torso = findBone('body') ? 'body' : project.bones[0].id;
    project.motions.breath = project.motions.breath || { boneId: torso, periodSeconds: 4, amplitudeY: 1.8, scaleY: .006 };
    selectedActionId = findAction('nod') ? 'nod' : project.motions.actions[0] && project.motions.actions[0].id || ''; selectedKeyframeIndex = -1;
    renderEditor(); schedulePreview(); markProject(false);
    say(head || arm ? '已添加可编辑的呼吸、点头和挥手草稿。预览实际读取当前骨骼动作。' : '已添加呼吸。建议先给头部和手臂建立骨骼，再添加对应动作。');
  }
  function addCustomAction() {
    pushHistory(); var id = Core.createId('motion');
    project.motions.actions.push({ id: id, label: '自定义动作', durationSeconds: 1, fadeInSeconds: .12, fadeOutSeconds: .16, keyframes: [] });
    selectedActionId = id; selectedKeyframeIndex = -1; renderEditor(); markProject(false);
  }
  function addKeyframe() {
    var action = findAction(selectedActionId), target = String(byId('puppet-motion-target').value || ''), at = Number(byId('puppet-playhead').value) || 0;
    if (!action || !target) { say('先选择动作和关键帧目标。', true); return; }
    pushHistory();
    var frame = { at: Math.min(action.durationSeconds, Math.max(0, at)), easing: byId('puppet-key-easing').value || 'smooth' };
    if (target.indexOf('b:') === 0) { var bone = findBone(target.slice(2)); if (!bone) return; frame.boneId = bone.id; frame.rotation = bone.rotation; }
    else { var layer = findLayer(target.slice(2)); if (!layer) return; frame.layerId = layer.id; frame.x = layer.x; frame.y = layer.y; frame.rotation = layer.rotation; frame.scaleX = layer.scaleX; frame.scaleY = layer.scaleY; frame.alpha = layer.alpha; }
    var existing = action.keyframes.findIndex(function (item) { return item.boneId === frame.boneId && item.layerId === frame.layerId && Math.abs(Number(item.at) - frame.at) < .005; });
    if (existing >= 0) action.keyframes[existing] = frame; else action.keyframes.push(frame);
    action.keyframes.sort(function (a, b) { return a.at - b.at; });
    selectedKeyframeIndex = action.keyframes.indexOf(frame); renderTimeline(); schedulePreview(); markProject(false);
  }
  function deleteKeyframe(index) {
    var action = findAction(selectedActionId); if (!action || !action.keyframes[index]) return;
    pushHistory(); action.keyframes.splice(index, 1); selectedKeyframeIndex = -1; renderTimeline(); schedulePreview(); markProject(false);
  }
  function playAction() {
    if (!previewCall || !window.IBCallPuppet || !selectedActionId) return;
    var ok = window.IBCallPuppet.playAction(previewCall, selectedActionId);
    if (!ok) say('请先刷新预览，确保动作已载入。', true);
  }
  function setBlinkMapping() {
    var pairs = [];
    [['L', 'puppet-blink-open-l', 'puppet-blink-closed-l'], ['R', 'puppet-blink-open-r', 'puppet-blink-closed-r']].forEach(function (entry) {
      var side = entry[0], open = byId(entry[1]).value, closed = byId(entry[2]).value;
      if (!open || !closed || open === closed) return;
      var prefix = side === 'L' ? '左' : '右';
      var openIds = project.layers.filter(function (layer) {
        return layer.id === open || (layer.name.indexOf(prefix) === 0 && /眼白|虹膜|睫毛/.test(layer.name));
      }).map(function (layer) { return layer.id; });
      pairs.push({ id: 'blink-' + side.toLowerCase(), side: side, openLayerIds: Array.from(new Set(openIds)), closedLayerId: closed });
    });
    if (!pairs.length) { project.motions.blink = null; say('请选择至少一侧的睁眼和闭眼图层。', true); renderPhysiology(); return; }
    pushHistory(); project.motions.blink = { openLayerId: pairs[0].openLayerIds[0], closedLayerId: pairs[0].closedLayerId, pairs: pairs,
      minIntervalSeconds: 2.8, maxIntervalSeconds: 5.2, durationSeconds: .18 };
    schedulePreview(); markProject(false); renderPhysiology(); say(pairs.length === 2 ? '左右眼已独立绑定；每侧按自己的时序眨眼。' : '已绑定一侧眨眼；另一侧可独立添加。');
  }
  function setMouthMapping() {
    var open = byId('puppet-mouth-open').value, closed = byId('puppet-mouth-closed').value;
    if (!open || !closed || open === closed) { project.motions.mouth = null; say('请选择不同的张嘴与闭嘴图层。', true); renderPhysiology(); return; }
    pushHistory(); project.motions.mouth = { openLayerId: open, closedLayerId: closed, sensitivity: 1 }; schedulePreview(); markProject(false); say('口型已绑定；通话时由 VoiceCall 的 TTS 音频电平驱动。');
  }
  function moveLayer(direction) {
    var layer = findLayer(selectedLayerId); if (!layer) return;
    var sorted = project.layers.slice().sort(function (a, b) { return Number(a.zIndex) - Number(b.zIndex); }), index = sorted.indexOf(layer), next = sorted[index + direction];
    if (!next) return;
    pushHistory(); var z = layer.zIndex; layer.zIndex = next.zIndex; next.zIndex = z; renderEditor(); schedulePreview(); markProject(false);
  }
  function deleteLayer() {
    var layer = findLayer(selectedLayerId); if (!layer) return;
    if (!window.confirm('删除「' + layer.name + '」图层？工程中的该裁切会移除。')) return;
    pushHistory(); project.layers = project.layers.filter(function (item) { return item.id !== layer.id; });
    project.motions.actions.forEach(function (action) { action.keyframes = action.keyframes.filter(function (frame) { return frame.layerId !== layer.id; }); });
    if (project.motions.blink && (project.motions.blink.openLayerId === layer.id || project.motions.blink.closedLayerId === layer.id)) project.motions.blink = null;
    if (project.motions.mouth && (project.motions.mouth.openLayerId === layer.id || project.motions.mouth.closedLayerId === layer.id)) project.motions.mouth = null;
    if (!project.layers.some(function (item) { return item.assetId === layer.assetId; })) delete project.assets[layer.assetId];
    if (layer.rawAssetId && !project.layers.some(function (item) { return item.rawAssetId === layer.rawAssetId; })) delete project.assets[layer.rawAssetId];
    selectedLayerId = project.layers[0] && project.layers[0].id || ''; renderEditor(); renderCanvas(); schedulePreview(); markProject(false);
  }
  function buildManifestForPreview() {
    var manifest = Core.toRuntimeManifest(project);
    manifest.layers.forEach(function (layer) {
      var sourceLayer = findLayer(layer.id);
      if (sourceLayer && project.assets[sourceLayer.assetId]) layer.src = project.assets[sourceLayer.assetId];
    });
    return manifest;
  }
  function destroyPreview() {
    if (!previewCall) return;
    if (window.IBCallPuppet && typeof window.IBCallPuppet.destroy === 'function') window.IBCallPuppet.destroy(previewCall);
    previewCall = null; previewResult = null;
  }
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () { previewTimer = 0; refreshPreview(); }, 180);
  }
  async function refreshPreview() {
    var host = byId('puppet-runtime-preview'); if (!host) return;
    if (!project || !project.layers.length) { destroyPreview(); host.innerHTML = '<div class="ips-preview-placeholder">建立图层后，这里会使用 IB Puppet 实际渲染</div>'; return; }
    if (!window.IBCallPuppet || typeof window.IBCallPuppet.attachManifest !== 'function') { say('IB Puppet 引擎尚未加载。请重新打开 DIY 工作坊后再预览。', true); return; }
    var token = ++previewToken;
    destroyPreview(); host.replaceChildren();
    var call = { state: 'connected', role: {}, destroyed: false, _voiceTtsAudioLevel: 0, _live2dAudioLevel: 0, speakerMuted: false };
    previewCall = call;
    var role = { characterEngine: 'puppet', puppetFrameRate: '60', avatar: '' };
    try {
      previewResult = await window.IBCallPuppet.attachManifest(host, buildManifestForPreview(), call, role);
      if (token !== previewToken || previewCall !== call) { window.IBCallPuppet.destroy(call); return; }
      if (!previewResult || !previewResult.ok) say('预览加载失败：' + String(previewResult && (previewResult.error || previewResult.reason) || '未知错误'), true);
      else { renderTimeline(); say('实时预览使用 IB Puppet v1.1 渲染引擎。动作按钮会经过相同的淡入、混合与清理流程。'); }
    } catch (error) { if (token === previewToken) say('实时预览失败：' + String(error && error.message || error), true); }
  }
  function packageFiles() {
    var manifest = Core.toRuntimeManifest(project), files = [{ path: 'puppet.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }], seen = new Set();
    manifest.layers.forEach(function (layer) {
      if (seen.has(layer.src)) return;
      seen.add(layer.src);
      var sourceLayer = findLayer(layer.id), asset = sourceLayer && project.assets[sourceLayer.assetId];
      if (!asset) throw new Error('图层“' + layer.name + '”缺少图像素材。');
      var decoded = Core.dataUrlBytes(asset);
      files.push({ path: layer.src, bytes: decoded.bytes });
    });
    return files;
  }
  function bindChunks(api, importId, path, bytes) {
    var chunkSize = 256 * 1024, total = bytes.length, offset = 0;
    function next() {
      if (offset >= total) return Promise.resolve();
      var end = Math.min(total, offset + chunkSize), chunk = Array.from(bytes.subarray(offset, end)), current = offset;
      offset = end;
      return api.writeChunk({ importId: importId, relativePath: path, offset: current, totalSize: total, chunk: chunk }).then(next);
    }
    return next();
  }
  async function exportRuntime() {
    if (!project || !project.layers.length) { say('先建立至少一个真实图层。', true); return; }
    projectBusy = true; updateButtons();
    var importId = '', api = window.IB && window.IB.host && window.IB.host.characterPuppets, compiled = null;
    try {
      if (api && api.available) {
        var installed, compiler = window.IB.host && window.IB.host.puppetProjects;
        if (compiler && compiler.available && typeof compiler.compileRuntime === 'function') {
          project = Core.normalizeProject(snapshotProject());
          project.name = String(byId('puppet-project-name').value || project.name || '未命名角色').slice(0, 80);
          if (projectBytes() > Core.MAX_PROJECT_BYTES) throw new Error('工程素材总量超过 160 MB。');
          await compiler.save(JSON.stringify(project));
          compiled = await compiler.compileRuntime(project.id);
          installed = compiled && compiled.bundle;
          if (!installed || !installed.bundleId) throw new Error('Rust Core 没有返回有效运行包。');
        } else {
          var files = packageFiles(), zip = Core.zipStore(files);
          importId = await api.begin('zip');
          var zipBytes = new Uint8Array(await zip.arrayBuffer());
          await bindChunks(api, importId, 'import.zip', zipBytes);
          installed = await api.finish(importId); importId = '';
        }
        project.bundleId = installed.bundleId;
        await refreshRuntimeLibrary();
        await refreshFillRoute();
        markProject(false); updateButtons();
        if (typeof api.export === 'function') {
          try {
            var exported = await api.export(installed.bundleId);
            var elapsed = compiled && Number.isFinite(Number(compiled.elapsedMs)) ? '；Rust Core ' + Number(compiled.elapsedMs) + ' ms' : '';
            say('运行包已安装到本机 Puppet 库并导出：' + String(exported && exported.path || exported && exported.fileName || installed.name) + ' · ' + installed.layerCount + ' 层' + elapsed + '。可编辑工程仍单独保存。');
          } catch (exportError) {
            say('运行包已安装到本机 Puppet 库；独立 ZIP 导出失败：' + String(exportError && exportError.message || exportError).slice(0, 140), true);
          }
        }
      } else {
        var files = packageFiles(), zip = Core.zipStore(files);
        saveBlob(zip, safeStem(project.name) + '.ibpuppet.zip');
        say('运行包 ZIP 已下载。将来在 Tauri 桌面版可安装到本机角色素材库。');
      }
    } catch (error) {
      if (importId && api && api.available) { try { await api.abort(importId); } catch (_) {} }
      say('运行包导出失败：' + String(error && error.message || error).slice(0, 200), true);
    } finally { projectBusy = false; updateButtons(); }
  }
  function dataUrlFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader(); reader.onload = function () { resolve(String(reader.result || '')); }; reader.onerror = function () { reject(new Error('图层素材读取失败。')); }; reader.readAsDataURL(blob);
    });
  }
  async function importRuntimeBundle() {
    var api = window.IB && window.IB.host && window.IB.host.characterPuppets, select = byId('puppet-runtime-library'), bundleId = select && select.value;
    if (!api || !api.available) { say('读取角色素材库需要 Windows Tauri 桌面版。', true); return; }
    if (!bundleId) { say('先选择一个已导入的运行包。', true); return; }
    projectBusy = true; updateButtons(); say('正在读取运行包图层以建立可编辑工程…');
    try {
      var url = await api.resolve(bundleId), response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('运行包清单读取失败。');
      var manifest = window.IBCallPuppet.validateManifest(await response.json()), next = Core.createProject(manifest.name);
      next.bundleId = bundleId; next.canvas = { width: manifest.canvas.width, height: manifest.canvas.height };
      next.bones = manifest.bones.map(function (bone) { return { id: bone.id, name: bone.name || bone.id, parent: bone.parent || null, x: bone.x || 0, y: bone.y || 0, rotation: bone.rotation || 0, scaleX: bone.scaleX || 1, scaleY: bone.scaleY || 1 }; });
      for (var i = 0; i < manifest.layers.length; i++) {
        var sourceLayer = manifest.layers[i], assetUrl = new URL(sourceLayer.src, url).href, imageResponse = await fetch(assetUrl, { credentials: 'omit', cache: 'no-store' });
        if (!imageResponse.ok) throw new Error('图层素材缺失：' + sourceLayer.name);
        var blob = await imageResponse.blob(), dataUrl = await dataUrlFromBlob(blob), assetId = Core.createId('raster');
        next.assets[assetId] = dataUrl;
        next.layers.push({ id: sourceLayer.id, name: sourceLayer.name || sourceLayer.id, assetId: assetId, rawAssetId: assetId, bone: sourceLayer.bone,
          x: sourceLayer.x || 0, y: sourceLayer.y || 0, rotation: sourceLayer.rotation || 0, anchorX: sourceLayer.anchorX == null ? .5 : sourceLayer.anchorX,
          anchorY: sourceLayer.anchorY == null ? .5 : sourceLayer.anchorY, scaleX: sourceLayer.scaleX || 1, scaleY: sourceLayer.scaleY || 1,
          alpha: sourceLayer.alpha == null ? 1 : sourceLayer.alpha, zIndex: sourceLayer.zIndex || 0, visible: true, mesh: sourceLayer.mesh || null, notes: '从本机运行包导入；该工程没有原始参考图。', confidence: 0, viewBox: null });
      }
      next.motions = manifest.motions || Core.defaultMotions();
      project = Core.normalizeProject(next); selectedLayerId = project.layers[0] && project.layers[0].id || ''; selectedBoneId = project.bones[0] && project.bones[0].id || 'root'; selectedActionId = project.motions.actions[0] && project.motions.actions[0].id || '';
      byId('puppet-project-name').value = project.name; byId('puppet-reference-summary').textContent = '运行包工程 · 未包含原始参考图';
      renderEditor(); renderCanvas(); schedulePreview(); say('运行包已转换为可编辑工程。没有原始参考图，因此可调整层级和动画；重新裁切需另导入参考图。');
    } catch (error) { say('运行包未能打开：' + String(error && error.message || error).slice(0, 180), true); }
    finally { projectBusy = false; updateButtons(); }
  }
  async function bindToRole() {
    var roleId = String(byId('puppet-bind-role').value || ''), selected = project && project.bundleId;
    if (!roleId || !selected) { say('先安装运行包并选择一个 IB 角色。', true); return; }
    if (typeof window.editApi !== 'function' || typeof window.saveCurrentApi !== 'function') { say('现有角色 API 编辑器未就绪。', true); return; }
    projectBusy = true; updateButtons();
    try {
      if (typeof window.navTo === 'function') window.navTo('api');
      await Promise.resolve(window.editApi(roleId));
      var deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        var editor = document.getElementById('api-editor');
        if (editor && editor.style.display !== 'none') break;
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
      }
      var reference = document.getElementById('api-puppet-bundle-ref'), engine = document.getElementById('api-character-engine'), save = document.querySelector('button[onclick*="saveCurrentApi"]');
      if (!reference || !engine || !save) throw new Error('现有角色形象设置未打开。');
      await window.IBPuppetModels.refresh(selected);
      reference.value = selected; engine.value = 'puppet'; engine.dispatchEvent(new Event('change', { bubbles: true }));
      await window.saveCurrentApi(save);
      project.roleId = roleId; markProject(false);
      say('运行包已通过现有角色设置绑定并保存。'); close();
    } catch (error) { say('角色绑定失败：' + String(error && error.message || error).slice(0, 180), true); }
    finally { projectBusy = false; updateButtons(); }
  }
  async function refreshFillRoute() {
    var node = byId('puppet-fill-route'); if (!node) return;
    var api = window.IB && window.IB.imageRouterConfig;
    if (!api || typeof api.describe !== 'function') { node.textContent = '图片编辑路由未就绪。可在 API → Image Router 配置。'; return; }
    try {
      var info = await api.describe(), status = info && info.status && info.status.editing;
      if (status && status.ok) node.textContent = '当前编辑路由：' + (status.apiConfigLabel || status.provider || 'Image Router') + ' · ' + (status.model || '自动模型') + '。点击后才会提交编辑请求。';
      else node.textContent = '当前没有可用的 Image Router 编辑路由。请先在 API → Image Router 选择 Provider；未配置时不会发送请求。';
    } catch (_) { node.textContent = '无法读取 Image Router 状态。'; }
  }
  async function proposeFill() {
    var layer = findLayer(selectedLayerId), router = window.IB && window.IB.imageRouter;
    if (!layer || !router || !router.available) { say('当前选中图层或 Image Router 不可用。', true); return; }
    var routeText = (byId('puppet-fill-route').textContent || '').trim();
    if (!window.confirm('即将把选中图层和参考图提交到当前 Image Router 图片编辑 Provider，可能产生 API 费用。只会生成待审阅候选，不会自动改动图层。继续？\n\n' + routeText)) return;
    projectBusy = true; updateButtons(); say('正在请求遮挡补全部件候选…');
    try {
      var result = await router.routeImageRequest({ operation: 'edit', source: 'puppet_studio', characterId: project.roleId || 'puppet-studio', userInitiated: true, background: false,
        cfg: selectedConfig() || undefined,
        prompt: '请基于角色结构参考图，补全这个被遮挡或分离的角色部件。只返回干净的部件图，保持角色原有颜色、画风、比例和细节；不要添加新的部件、文字、水印或边框。当前部件：' + layer.name + '。结果将由用户审阅后决定是否加入图层。',
        previousImage: { dataUrl: project.assets[layer.assetId], base64: String(project.assets[layer.assetId]).split(',')[1] || '', mime: Core.mimeFromDataUrl(project.assets[layer.assetId]), name: layer.name + '.png' },
        referenceImages: project.reference.dataUrl ? [{ dataUrl: project.reference.dataUrl, name: project.reference.name, mime: Core.mimeFromDataUrl(project.reference.dataUrl) }] : []
      });
      if (!result || !result.ok || !result.dataUrl || !Core.mimeFromDataUrl(result.dataUrl)) throw new Error(result && (result.reason || result.code) || '图片编辑没有返回有效候选。');
      stateFillCandidate = { layerId: layer.id, dataUrl: result.dataUrl, model: result.model || '', prompt: '基于当前图层和角色参考图生成的补全候选。' };
      renderProperties(); renderFillCandidate(); say('补全候选已生成。请对比检查后再手动采纳；原图层仍保留。');
    } catch (error) { say('遮挡补全失败，原图层未改变：' + String(error && error.message || error).slice(0, 200), true); }
    finally { projectBusy = false; updateButtons(); }
  }
  var stateFillCandidate = null;
  function renderFillCandidate() {
    var host = overlay && overlay.querySelector('.ips-ai-fill'); if (!host) return;
    var prior = host.querySelector('.ips-fill-preview'); if (prior) prior.remove();
    if (!stateFillCandidate) return;
    var box = document.createElement('div'); box.className = 'ips-fill-preview';
    var image = document.createElement('img'); image.alt = '遮挡补全候选预览'; image.src = stateFillCandidate.dataUrl; box.appendChild(image);
    var caption = document.createElement('small'); caption.textContent = (stateFillCandidate.model || '图片编辑候选') + ' · 尚未采纳'; box.appendChild(caption);
    var actions = document.createElement('div'); actions.innerHTML = '<button type="button" data-ips="apply-fill">作为新图层采纳</button><button type="button" data-ips="discard-fill">丢弃</button>'; box.appendChild(actions); host.appendChild(box);
  }
  function applyFill() {
    if (!stateFillCandidate || !project) return;
    var image = stateFillCandidate;
    pushHistory();
    var layer = findLayer(image.layerId), assetId = Core.createId('raster'), id = Core.createId('filled');
    project.assets[assetId] = image.dataUrl;
    project.layers.push({ id: id, name: (layer ? layer.name : '部件') + ' · 补全候选', assetId: assetId, rawAssetId: assetId, bone: layer ? layer.bone : 'root',
      x: layer ? layer.x : project.canvas.width / 2, y: layer ? layer.y : project.canvas.height / 2, rotation: 0, anchorX: .5, anchorY: .5, scaleX: 1, scaleY: 1, alpha: 1, zIndex: project.layers.length, visible: true, viewBox: null, confidence: 0, notes: '图片编辑 Provider 生成；用户手动采纳。请检查边缘、透明度和画风。', mesh: null });
    selectedLayerId = id; stateFillCandidate = null; renderEditor(); renderCanvas(); schedulePreview(); markProject(false); say('候选已作为独立图层加入工程，原始图层仍保留。');
  }
  function discardFill() { stateFillCandidate = null; renderProperties(); renderFillCandidate(); say('补全候选已丢弃，工程未改变。'); }
  function openMaskEditor() {
    var layer = findLayer(selectedLayerId); if (!layer || !project.assets[layer.assetId]) return;
    var rawSource = project.assets[layer.rawAssetId] || project.assets[layer.assetId];
    Promise.all([Core.loadImage(rawSource), Core.loadImage(project.assets[layer.assetId])]).then(function (images) {
      var image = images[0], currentImage = images[1], pixels = image.naturalWidth * image.naturalHeight;
      if (pixels > 4 * 1024 * 1024) throw new Error('该图层超过 4 百万像素。请先缩小裁切区域再编辑遮罩。');
      var canvas = byId('puppet-mask-canvas'), mask = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; mask.width = image.naturalWidth; mask.height = image.naturalHeight;
      var maskContext = mask.getContext('2d', { willReadFrequently: true });
      var currentCanvas = document.createElement('canvas'); currentCanvas.width = mask.width; currentCanvas.height = mask.height;
      currentCanvas.getContext('2d').drawImage(currentImage, 0, 0, mask.width, mask.height);
      var currentPixels = currentCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mask.width, mask.height), alphaMask = maskContext.createImageData(mask.width, mask.height);
      for (var i = 0; i < currentPixels.data.length; i += 4) { alphaMask.data[i] = 255; alphaMask.data[i + 1] = 255; alphaMask.data[i + 2] = 255; alphaMask.data[i + 3] = currentPixels.data[i + 3]; }
      maskContext.putImageData(alphaMask, 0, 0);
      maskState = { layerId: layer.id, assetId: layer.assetId, rawAssetId: layer.rawAssetId || layer.assetId, image: image, canvas: canvas, context: canvas.getContext('2d'), mask: mask, maskContext: maskContext, initialMask: maskContext.getImageData(0, 0, mask.width, mask.height), mode: 'erase' };
      byId('puppet-mask-modal').hidden = false; setMaskMode('erase'); renderMaskPreview();
    }).catch(function (error) { say('无法打开遮罩编辑器：' + String(error && error.message || error), true); });
  }
  function maskPosition(event) {
    var rect = maskState.canvas.getBoundingClientRect();
    return { x: Core.clamp((event.clientX - rect.left) * maskState.canvas.width / Math.max(1, rect.width), 0, maskState.canvas.width, 0), y: Core.clamp((event.clientY - rect.top) * maskState.canvas.height / Math.max(1, rect.height), 0, maskState.canvas.height, 0) };
  }
  function paintMask(point, previous) {
    if (!maskState) return;
    var ctx = maskState.maskContext, brush = Number(byId('puppet-mask-brush').value) || 34;
    ctx.save(); ctx.globalCompositeOperation = maskState.mode === 'erase' ? 'destination-out' : 'source-over'; ctx.strokeStyle = 'rgba(255,255,255,1)'; ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush;
    if (previous) { ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(point.x, point.y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(point.x, point.y, brush / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); renderMaskPreview();
  }
  function maskPointerDown(event) {
    if (!maskState) return;
    event.preventDefault(); maskGesture = true; maskState.canvas.setPointerCapture(event.pointerId); maskState.lastPoint = maskPosition(event); paintMask(maskState.lastPoint, null);
  }
  function maskPointerMove(event) {
    if (!maskGesture || !maskState) return;
    var point = maskPosition(event); paintMask(point, maskState.lastPoint); maskState.lastPoint = point;
  }
  function maskPointerUp() { maskGesture = false; if (maskState) maskState.lastPoint = null; }
  function renderMaskPreview() {
    if (!maskState) return;
    var ctx = maskState.context, canvas = maskState.canvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(maskState.image, 0, 0);
    ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(maskState.mask, 0, 0); ctx.globalCompositeOperation = 'source-over';
  }
  function setMaskMode(mode) {
    if (!maskState || (mode !== 'erase' && mode !== 'restore')) return;
    maskState.mode = mode;
    overlay.querySelectorAll('[data-ips^="mask-"]').forEach(function (button) { button.classList.toggle('is-active', (mode === 'erase' && button.getAttribute('data-ips') === 'mask-erase') || (mode === 'restore' && button.getAttribute('data-ips') === 'mask-restore')); });
  }
  function resetMask() {
    if (!maskState) return;
    maskState.maskContext.putImageData(maskState.initialMask, 0, 0); renderMaskPreview();
  }
  function closeMaskEditor() { var modal = byId('puppet-mask-modal'); if (modal) modal.hidden = true; maskState = null; maskGesture = false; }
  function saveMask() {
    if (!maskState) return;
    var layer = findLayer(maskState.layerId); if (!layer) { closeMaskEditor(); return; }
    var dataUrl = maskState.canvas.toDataURL('image/png');
    pushHistory(); project.assets[maskState.assetId] = dataUrl; closeMaskEditor(); renderProperties(); schedulePreview(); markProject(false); say('透明遮罩已保存到当前图层。需要时可撤销或再次手工修正。');
  }
  function getProject() { return project ? Core.normalizeProject(snapshotProject()) : null; }
  function exportProjectData() { return project ? JSON.stringify(Core.normalizeProject(snapshotProject()), null, 2) : ''; }
  function previewMetrics() { return previewCall && window.IBCallPuppet && typeof window.IBCallPuppet.peek === 'function' ? window.IBCallPuppet.peek(previewCall) : null; }
  function importProjectData(value) {
    try {
      var next = Core.normalizeProject(typeof value === 'string' ? JSON.parse(value) : value);
      project = next; historyPast.length = 0; historyFuture.length = 0; selectedLayerId = project.layers[0] && project.layers[0].id || '';
      selectedBoneId = project.bones[0] && project.bones[0].id || 'root'; selectedActionId = project.motions.actions[0] && project.motions.actions[0].id || '';
      byId('puppet-project-name').value = project.name; renderEditor(); renderCanvas(); schedulePreview();
      return { ok: true, layerCount: project.layers.length, name: project.name };
    } catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  }
  window.IBPuppetStudio = Object.freeze({
    mount: mount, open: open, close: close, getProject: getProject, exportProjectData: exportProjectData,
    importProjectData: importProjectData, preview: refreshPreview, refreshLibrary: refreshRuntimeLibrary,
    getPreviewMetrics: previewMetrics, analyzeReference: analyzeReference, exportRuntime: exportRuntime
  });
})(window);
