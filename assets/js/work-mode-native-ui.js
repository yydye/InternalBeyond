(function (root) {
  'use strict';
  var syntheticDev = root.__IB_DEV_MODE__ === true && root.__IB_DEV_SYNTHETIC__ === true;
  var productionTauri = root.__IB_TAURI_HOST__ === true && root.__IB_DEV_MODE__ !== true;
  // Dev still requires the Synthetic opt-in. Production mounts only in the
  // native Tauri Host and must obtain its pinned UI URL from Home Node.
  if (!root.document || (!syntheticDev && !productionTauri)) return;
  var page = root.document.getElementById('page-work-mode');
  if (!page || root.document.getElementById('wm-native-candidate')) return;
  var nativeWork = page.querySelector('.wm-page');
  if (!nativeWork) return;
  var toolbar = root.document.createElement('div');
  toolbar.className = 'wm-native-switch';
  toolbar.setAttribute('aria-label', 'Work UI 候选界面');
  toolbar.innerHTML = '<button type="button" class="btn" id="wm-use-dsh" aria-pressed="true">工作台</button>' +
    '<button type="button" class="btn" id="wm-use-native" aria-pressed="false">高级执行详情</button>' +
    '<button type="button" class="btn" id="wm-dsh-reload" hidden>重试工作台</button>' +
    '<button type="button" class="btn" id="wm-dsh-runtime-manage" aria-pressed="false">Runtime 管理</button>' +
    '<details class="wm-native-dev-detail wm-native-dsh-debug"><summary>开发者详情</summary>' +
    '<div class="wm-native-dev-detail-body" id="wm-native-dev-detail-body">DSH 状态检查尚未完成</div></details>';
  var candidate = root.document.createElement('section');
  candidate.id = 'wm-native-candidate';
  candidate.hidden = true;
  candidate.innerHTML = '<header class="wm-native-header"><div><span class="wm-native-label">归墟 Work</span>' +
    '<p>你的授权、文件范围和结果始终保存在本机</p></div></header>' +
    '<p id="wm-native-status" role="status">正在准备工作台…</p>' +
    '<section class="wm-dsh-install" id="wm-dsh-install" hidden aria-labelledby="wm-dsh-install-title">' +
    '<div class="wm-dsh-install-copy"><span class="wm-dsh-install-kicker">OPTIONAL RUNTIME</span>' +
    '<h2 id="wm-dsh-install-title">安装 DSH Runtime</h2>' +
    '<p>归墟主程序可独立运行。选择本机的 DSH Runtime ZIP 后，Home Node 会校验兼容性与 SHA-256，再安装到独立扩展目录。</p>' +
    '<p class="wm-dsh-install-version" id="wm-dsh-install-version">适用于当前 Windows 版本</p></div>' +
    '<div class="wm-dsh-online-runtime"><div class="wm-dsh-online-runtime-copy"><h3>在线获取与更新</h3>' +
    '<p id="wm-dsh-online-status" role="status" aria-live="polite">签名清单会先通过 Ed25519 校验，再下载兼容 Runtime。</p></div>' +
    '<div class="wm-dsh-online-runtime-actions"><button type="button" class="btn" id="wm-dsh-runtime-discover">检查在线版本</button>' +
    '<select id="wm-dsh-runtime-version" aria-label="选择兼容的 DSH Runtime 版本" disabled></select>' +
    '<button type="button" class="btn btn-primary" id="wm-dsh-runtime-online-install" disabled>下载并安装</button>' +
    '<button type="button" class="btn" id="wm-dsh-runtime-cancel" hidden>取消下载</button>' +
    '<button type="button" class="btn" id="wm-dsh-runtime-back" hidden>返回工作台</button></div></div>' +
    '<input id="wm-dsh-install-file" type="file" accept=".zip,application/zip" hidden>' +
    '<button type="button" class="btn btn-primary" id="wm-dsh-install-select">选择本地 ZIP</button>' +
    '<progress class="wm-dsh-install-progress" id="wm-dsh-install-progress" max="100" value="0" hidden></progress>' +
    '<p class="wm-dsh-install-progress-label" id="wm-dsh-install-progress-label" role="status" aria-live="polite"></p>' +
    '<p class="wm-dsh-install-error" id="wm-dsh-install-error" role="alert" hidden></p></section>' +
    '<iframe id="wm-dsh-frame" title="归墟 Work 工作台" referrerpolicy="origin"></iframe>';
  nativeWork.prepend(toolbar);
  nativeWork.append(candidate);
  // 旧原生 Work UI 降级为"高级执行详情"：把现有的头部带与工作台主网格整体
  // 挪进一个默认折叠的 <details> 里（DOM 移动，不删除——68 个 wm-* ID 原样
  // 保留，满足既有契约），DSH 主导时折叠，原生回退/手动切换时强制展开并
  // 去掉披露外观，看起来和过去的全页原生 UI 完全一致。
  var advanced = root.document.getElementById('wm-native-advanced');
  if (!advanced) {
    advanced = root.document.createElement('details');
    advanced.id = 'wm-native-advanced';
    advanced.className = 'wm-native-advanced';
    var advancedSummary = root.document.createElement('summary');
    advancedSummary.textContent = '高级执行详情（归墟 Work UI）';
    advanced.appendChild(advancedSummary);
    var toMove = [];
    Array.prototype.forEach.call(nativeWork.children, function (child) {
      if (child !== toolbar && child !== candidate) toMove.push(child);
    });
    toMove.forEach(function (child) { advanced.appendChild(child); });
    candidate.after(advanced);
  }
  var frame = root.document.getElementById('wm-dsh-frame');
  var status = root.document.getElementById('wm-native-status');
  var reloadButton = root.document.getElementById('wm-dsh-reload');
  var installPanel = root.document.getElementById('wm-dsh-install');
  var installInput = root.document.getElementById('wm-dsh-install-file');
  var installButton = root.document.getElementById('wm-dsh-install-select');
  var installProgress = root.document.getElementById('wm-dsh-install-progress');
  var installProgressLabel = root.document.getElementById('wm-dsh-install-progress-label');
  var installError = root.document.getElementById('wm-dsh-install-error');
  var installVersion = root.document.getElementById('wm-dsh-install-version');
  var runtimeManageButton = root.document.getElementById('wm-dsh-runtime-manage');
  var runtimeDiscoverButton = root.document.getElementById('wm-dsh-runtime-discover');
  var runtimeVersionSelect = root.document.getElementById('wm-dsh-runtime-version');
  var runtimeOnlineInstallButton = root.document.getElementById('wm-dsh-runtime-online-install');
  var runtimeCancelButton = root.document.getElementById('wm-dsh-runtime-cancel');
  var runtimeBackButton = root.document.getElementById('wm-dsh-runtime-back');
  var runtimeOnlineStatus = root.document.getElementById('wm-dsh-online-status');
  runtimeManageButton.hidden = !productionTauri;
  var devDetail = toolbar.querySelector('.wm-native-dsh-debug');
  var devDetailBody = root.document.getElementById('wm-native-dev-detail-body');
  var url = null;
  var devServiceConfig = root.__IB_DEV_SERVICE_CONFIG__;
  var frameOrigin = String(devServiceConfig && devServiceConfig.dshWebOrigin || '');
  var lastTheme = null;
  var activeP1SessionId = '';
  var activeP1Operation = null;
  var lastP1StatusReadAt = 0;
  var p1HistoryCacheSessionId = '';
  var p1HistoryCacheKey = '';
  var p1HistoryCache = [];
  var p1TaskPrompts = Object.create(null);
  var nativePresetBySession = Object.create(null);
  var onlineReleaseRows = [];
  var onlineInstallPolling = false;
  var onlineDiscoveryPending = false;
  var workModeUi = root.IB && root.IB.workMode && root.IB.workMode.ui;
  var workRunRemote = root.IB && root.IB.homeNode && root.IB.homeNode.workRuns;
  var workModeRuntime = root.IB && root.IB.workMode && root.IB.workMode.runtime;
  function theme() { return root.document.body.classList.contains('theme-infernal') ? 'dark' : 'light'; }
  // 归墟 token → DSH 自己的 --dsw-alias-* 变量。DSH 是独立文档，CSS 变量不会跨 iframe
  // 继承；这里复用已有效的 ib-dsh-p0-theme 通道，把当前主题下已解析的 token 数值
  // 一并发给 client.js，由它 setProperty 到自己的 document 上，随每次明暗切换更新。
  var DSW_ALIAS_TOKEN_MAP = {
    '--dsw-alias-border-l1': '--ib-token-boundary-subtle', '--dsw-alias-border-l2': '--ib-token-boundary-default',
    '--dsw-alias-border-l3': '--ib-token-boundary-strong', '--dsw-alias-border-l4': '--ib-token-boundary-strong',
    '--dsw-alias-container-fill-l1': '--ib-token-surface-elevated', '--dsw-alias-container-fill-l2': '--ib-token-canvas-subtle',
    '--dsw-alias-container-fill-l3': '--ib-token-surface',
    '--dsw-alias-bg-layer-1': '--ib-token-canvas', '--dsw-alias-bg-layer-2': '--ib-token-canvas-subtle',
    '--dsw-alias-bg-layer-3': '--ib-token-surface-elevated',
    '--dsw-alias-label-primary': '--ib-token-content-primary', '--dsw-alias-label-tertiary': '--ib-token-content-muted',
    '--dsw-alias-caption': '--ib-token-content-muted', '--dsw-alias-color-danger': '--ib-token-status-danger',
    '--dsw-alias-brand-primary': '--ib-token-accent-brand', '--dsw-alias-interactive-bg-hover': '--ib-token-surface-interactive'
  };
  function resolvedTokens() {
    // 暗色覆盖值挂在 body.theme-infernal，不是 :root，必须从 body 读取已解析样式。
    var styles = root.getComputedStyle(root.document.body);
    var out = {};
    Object.keys(DSW_ALIAS_TOKEN_MAP).forEach(function (dswVar) {
      var value = styles.getPropertyValue(DSW_ALIAS_TOKEN_MAP[dswVar]);
      if (value) out[dswVar] = value.trim();
    });
    return out;
  }
  function sendTheme() {
    if (!frame.contentWindow || !url) return;
    frame.contentWindow.postMessage({ type: 'ib-dsh-p0-theme', theme: theme(), tokens: resolvedTokens() }, frameOrigin);
  }
  function safeDshDiagnostic(error) {
    var message = String(error && error.message || error || '');
    var known = message.match(/home-node-dsh-status-unavailable|production-dsh-runtime-disabled|production-dsh-web-host-failed(?::[A-Za-z0-9._,-]+)*|production-dsh-web-host-not-ready|unexpected-production-dsh-host|dev-service-config-unavailable|host-not-ready|unexpected-host/i);
    return known ? known[0].slice(0, 100) : 'production-dsh-connect-failed';
  }
  function showDshDiagnostic(code) {
    if (reloadButton) reloadButton.hidden = false;
    if (devDetail) devDetail.hidden = false;
    if (devDetailBody) devDetailBody.textContent = 'DSH 连接错误码：' + String(code || 'production-dsh-connect-failed');
  }
  function clearDshDiagnostic() {
    if (reloadButton) reloadButton.hidden = true;
    if (devDetailBody) devDetailBody.textContent = 'DSH 已就绪；执行仍由 Home Node Run 管理。';
  }
  function showRuntimeInstall(hostState, topLevelState) {
    frame.hidden = true;
    installPanel.hidden = false;
    var available = !!(hostState && hostState.runtimeInstallAvailable === true
      && workRunRemote && typeof workRunRemote.installDshRuntime === 'function');
    installButton.disabled = !available;
    status.textContent = hostState && hostState.runtimeInstalled === true
      ? 'DSH Runtime 管理与更新。' : (available ? 'DSH Runtime 尚未安装。' : 'DSH Runtime 安装入口暂不可用。');
    var installation = topLevelState && topLevelState.runtimeInstallation
      || hostState && hostState.runtimeInstallation;
    if (installVersion) installVersion.textContent = 'Runtime ' + String(installation && installation.runtimeVersion
      || hostState && hostState.dshRevision || 'DSH') + ' · Windows x64 · Home Node 管理运行与权限';
    var progressState = installation && installation.install;
    var onlineState = installation && installation.online;
    var onlineProgress = onlineState && onlineState.install;
    if (progressState && ['uploading', 'verifying', 'extracting', 'committing'].indexOf(progressState.phase) >= 0) {
      showRuntimeInstallProgress(progressState);
    } else if (onlineProgress && ['discovering', 'downloading', 'verifying', 'extracting', 'committing', 'health-check'].indexOf(onlineProgress.phase) >= 0) {
      showRuntimeInstallProgress(onlineProgress);
      runtimeCancelButton.hidden = !onlineState.canCancel;
      runtimeOnlineInstallButton.disabled = true;
      runtimeOnlineStatus.textContent = '正在安装 DSH ' + String(onlineProgress.runtimeVersion || '') + '。';
    } else if (available) {
      installProgress.hidden = true;
      installProgressLabel.textContent = '只从归墟发布的 Runtime ZIP 安装；校验失败会回滚临时文件。';
    }
    var installErrorCode = String(installation && (installation.installError
      || installation.install && installation.install.error) || '');
    if (!available && installError) {
      installError.hidden = false;
      installError.textContent = installErrorCode ? '安装状态：' + installErrorCode : '请重启归墟后重试。';
    }
    runtimeBackButton.hidden = !(hostState && hostState.runtimeInstalled === true);
    runtimeManageButton.setAttribute('aria-pressed', String(!runtimeBackButton.hidden));
    if (!onlineDiscoveryPending && !onlineReleaseRows.length && onlineState && onlineState.configured) {
      void discoverRuntimeReleases();
    }
  }
  function showRuntimeInstallProgress(value) {
    value = value || {};
    installProgress.hidden = false;
    installProgress.value = Math.max(0, Math.min(100, Number(value.percent) || 0));
    var phaseText = {
      uploading: '正在上传 ZIP', verifying: '正在校验兼容性与 SHA-256',
      discovering: '正在验证签名版本清单', downloading: '正在通过 HTTPS 下载',
      extracting: '正在展开 Runtime', committing: '正在完成安装',
      'health-check': '正在检查升级后的 Host'
    };
    var extra = Number(value.filesTotal) > 0
      ? ' · ' + String(Number(value.filesDone) || 0) + '/' + String(value.filesTotal) + ' 个文件' : '';
    installProgressLabel.textContent = String(phaseText[value.phase] || '正在安装')
      + ' · ' + String(installProgress.value) + '%' + extra;
  }
  function runtimeInstallFailure(code) {
    var messages = {
      'package-product-version-incompatible': '此 Runtime 与当前归墟版本不兼容；临时文件已回滚。',
      'package-node-version-incompatible': '此 Runtime 与内置 Node 版本不兼容；临时文件已回滚。',
      'runtime-extension-conflict-preserved': '扩展目录已有 Runtime；归墟保留了现有文件。',
      'runtime-install-already-running': '另一项 Runtime 安装正在进行。',
      'runtime-package-pin-unavailable': '归墟 Runtime 安装清单不可用；请修复或重新安装归墟主程序。',
      'runtime-upload-size-limit-exceeded': 'ZIP 超过允许大小；临时文件已回滚。',
      'runtime-archive-sha256-mismatch': '下载包 SHA-256 与已签名版本清单不一致；现有 Runtime 未更改。',
      'runtime-downgrade-denied': '所选版本低于当前版本；现有 Runtime 未更改。',
      'runtime-upgrade-health-check-failed': '新 Runtime 未通过 Host 启动检查，已回退到上一版本。',
      'runtime-upgrade-busy': '当前有 Home Node Run 或工作区回写；结束后再升级。',
      'runtime-release-version-not-found': '所选版本已从签名清单移除；请重新检查在线版本。'
    };
    return messages[code] || ('Runtime 安装失败（' + String(code || 'unknown') + '）；临时文件已回滚。');
  }

  function onlineReleaseFailure(code) {
    var messages = {
      'runtime-release-signature-verification-failed': '版本清单签名校验失败；没有下载 Runtime。',
      'runtime-release-signing-key-untrusted': '签名密钥不在归墟信任列表中。',
      'runtime-release-index-expired-or-invalid': '版本清单已过期或时间范围无效。',
      'runtime-download-https-required': '版本清单或 Runtime 地址未使用 HTTPS。',
      'runtime-release-network-failed': '无法连接版本清单；现有 Runtime 可离线使用。',
      'runtime-release-trust-unavailable': '在线签名信任配置不可用；可继续选择本地 ZIP。'
    };
    return messages[code] || ('在线版本检查失败（' + String(code || 'unknown') + '）。可重试或选择本地 ZIP。');
  }

  async function discoverRuntimeReleases() {
    if (!workRunRemote || typeof workRunRemote.dshRuntimeReleases !== 'function') {
      runtimeOnlineStatus.textContent = '在线版本检查不可用；仍可选择本地 ZIP。';
      return;
    }
    onlineDiscoveryPending = true;
    runtimeDiscoverButton.disabled = true;
    runtimeOnlineStatus.textContent = '正在检查 HTTPS 版本清单并验证 Ed25519 签名…';
    var result;
    try { result = await workRunRemote.dshRuntimeReleases(); } catch (_) { result = null; }
    onlineDiscoveryPending = false;
    runtimeDiscoverButton.disabled = false;
    if (!result || result.ok !== true) {
      onlineReleaseRows = [];
      runtimeVersionSelect.replaceChildren();
      runtimeVersionSelect.disabled = true;
      runtimeOnlineInstallButton.disabled = true;
      runtimeOnlineStatus.textContent = onlineReleaseFailure(result && result.error);
      return;
    }
    onlineReleaseRows = Array.isArray(result.releases) ? result.releases : [];
    runtimeVersionSelect.replaceChildren();
    onlineReleaseRows.forEach(function (release) {
      var option = root.document.createElement('option');
      option.value = String(release.runtimeVersion || '');
      var sizeMiB = Math.max(1, Math.round(Number(release.archiveBytes || 0) / (1024 * 1024)));
      option.textContent = 'DSH ' + option.value + ' · ' + String(sizeMiB) + ' MiB';
      runtimeVersionSelect.appendChild(option);
    });
    runtimeVersionSelect.disabled = !onlineReleaseRows.length;
    runtimeOnlineInstallButton.disabled = !onlineReleaseRows.length;
    runtimeOnlineInstallButton.textContent = '下载并安装';
    if (result.upToDate) runtimeOnlineStatus.textContent = '当前 DSH Runtime 已是兼容的最新版本。';
    else if (onlineReleaseRows.length) runtimeOnlineStatus.textContent = '签名有效 · ' + String(onlineReleaseRows.length)
      + ' 个兼容版本 · Ed25519 ' + String(result.keyId || '');
    else runtimeOnlineStatus.textContent = '没有适用于当前归墟与 Node 版本的新 Runtime。';
  }

  async function pollOnlineInstall() {
    if (onlineInstallPolling || !workRunRemote || typeof workRunRemote.dshStatus !== 'function') return;
    onlineInstallPolling = true;
    runtimeOnlineInstallButton.disabled = true;
    runtimeCancelButton.hidden = false;
    while (onlineInstallPolling) {
      var result = await workRunRemote.dshStatus().catch(function () { return null; });
      var installation = result && result.runtimeInstallation;
      var online = installation && installation.online;
      var state = online && online.install;
      if (!state) { onlineInstallPolling = false; break; }
      showRuntimeInstallProgress(state);
      if (state.phase === 'complete') {
        onlineInstallPolling = false;
        runtimeCancelButton.hidden = true;
        runtimeOnlineStatus.textContent = '签名、SHA-256 与文件清单校验通过 · DSH ' + String(state.runtimeVersion || '') + ' 已安装。';
        await new Promise(function (resolve) { root.setTimeout(resolve, 300); });
        void connect(true);
        return;
      }
      if (state.phase === 'failed' || state.phase === 'cancelled') {
        onlineInstallPolling = false;
        runtimeCancelButton.hidden = true;
        runtimeOnlineInstallButton.disabled = !runtimeVersionSelect.value;
        runtimeOnlineInstallButton.textContent = '重试安装';
        runtimeOnlineStatus.textContent = state.phase === 'cancelled'
          ? '下载已取消；现有 Runtime 保持原样。可以重试。'
          : runtimeInstallFailure(state.error) + ' 可以重试。';
        return;
      }
      runtimeCancelButton.hidden = !online.canCancel;
      await new Promise(function (resolve) { root.setTimeout(resolve, 600); });
    }
    runtimeCancelButton.hidden = true;
    runtimeOnlineInstallButton.disabled = !runtimeVersionSelect.value;
  }

  async function installOnlineRuntime() {
    if (!workRunRemote || typeof workRunRemote.installDshRuntimeOnline !== 'function') {
      runtimeOnlineStatus.textContent = 'Home Node 在线安装接口不可用。';
      return;
    }
    var version = String(runtimeVersionSelect.value || '');
    if (!version) return;
    runtimeOnlineInstallButton.disabled = true;
    runtimeDiscoverButton.disabled = true;
    installError.hidden = true;
    installProgress.hidden = false;
    installProgress.value = 0;
    installProgressLabel.textContent = '正在提交已验证的 Runtime 版本…';
    var started;
    try { started = await workRunRemote.installDshRuntimeOnline(version); } catch (_) { started = null; }
    runtimeDiscoverButton.disabled = false;
    if (!started || started.ok !== true) {
      runtimeOnlineInstallButton.disabled = false;
      runtimeOnlineStatus.textContent = runtimeInstallFailure(started && started.error);
      return;
    }
    if (started.alreadyInstalled === true) {
      runtimeOnlineStatus.textContent = '所选 Runtime 已安装；正在打开工作台。';
      void connect(true);
      return;
    }
    runtimeOnlineStatus.textContent = 'Home Node 已接受下载；可以随时取消。';
    void pollOnlineInstall();
  }

  async function cancelOnlineRuntimeInstall() {
    if (!workRunRemote || typeof workRunRemote.cancelDshRuntimeOnlineInstall !== 'function') return;
    runtimeCancelButton.disabled = true;
    runtimeOnlineStatus.textContent = '正在取消下载并清理临时文件…';
    try { await workRunRemote.cancelDshRuntimeOnlineInstall(); } catch (_) {}
    runtimeCancelButton.disabled = false;
  }

  function showRuntimeManager() {
    select(true, true);
    frame.hidden = true;
    installPanel.hidden = false;
    runtimeBackButton.hidden = false;
    runtimeManageButton.setAttribute('aria-pressed', 'true');
    if (workRunRemote && typeof workRunRemote.dshStatus === 'function') {
      workRunRemote.dshStatus().then(function (result) {
        if (result && result.host && result.runtimeInstallation) showRuntimeInstall(result.host, result);
        runtimeBackButton.hidden = false;
      }).catch(function () {});
    }
  }

  function returnToDshWork() {
    installPanel.hidden = true;
    runtimeBackButton.hidden = true;
    runtimeManageButton.setAttribute('aria-pressed', 'false');
    void connect(true);
  }
  async function uploadRuntimeZip(file) {
    if (!file || !/\.zip$/i.test(String(file.name || '')) || !Number(file.size)
      || Number(file.size) > 1024 * 1024 * 1024) {
      installError.hidden = false;
      installError.textContent = '请选择不超过 1 GiB 的 DSH Runtime ZIP。';
      return;
    }
    if (!workRunRemote || typeof workRunRemote.installDshRuntime !== 'function') {
      installError.hidden = false;
      installError.textContent = 'Home Node 安装接口不可用；归墟主程序状态保持不变。';
      return;
    }
    installButton.disabled = true;
    installInput.disabled = true;
    installError.hidden = true;
    installProgress.hidden = false;
    installProgress.value = 0;
    installProgressLabel.textContent = '正在准备本地 ZIP…';
    var polling = true;
    var pollTimer = 0;
    function pollInstallation() {
      if (!polling || !workRunRemote || typeof workRunRemote.dshStatus !== 'function') return;
      Promise.resolve(workRunRemote.dshStatus()).then(function (result) {
        var host = result && result.host;
        var installation = result && result.runtimeInstallation || host && host.runtimeInstallation;
        if (installation && installation.install) showRuntimeInstallProgress(installation.install);
      }).catch(function () {});
    }
    pollTimer = root.setInterval(pollInstallation, 600);
    var result;
    try {
      result = await workRunRemote.installDshRuntime(file, function (progress) {
        if (progress && progress.lengthComputable && Number(progress.total) > 0) {
          showRuntimeInstallProgress({ phase: 'uploading', percent: Math.floor((progress.loaded / progress.total) * 39) });
        }
      });
    } catch (_) { result = null; }
    polling = false;
    if (pollTimer) root.clearInterval(pollTimer);
    installInput.disabled = false;
    if (!result || result.ok !== true) {
      installButton.disabled = false;
      installError.hidden = false;
      installError.textContent = runtimeInstallFailure(result && result.error);
      installProgressLabel.textContent = '未安装；再次尝试不会影响归墟数据或现有 Runtime。';
      return;
    }
    installProgress.value = 100;
    installProgressLabel.textContent = result.alreadyInstalled
      ? '检测到已安装的 Runtime；正在直接启动。'
      : '校验通过 · DSH ' + String(result.runtimeVersion || '') + ' · SHA-256 ' + String(result.archiveSha256 || '').slice(0, 16) + '…';
    installButton.disabled = true;
    await new Promise(function (resolve) { root.setTimeout(resolve, 250); });
    await connect(true);
  }
  async function connect(reload) {
    if (reload && candidate.hidden) select(true, true);
    status.textContent = '正在准备工作台…';
    try {
      if (productionTauri) {
        if (!workRunRemote || typeof workRunRemote.dshStatus !== 'function') throw new Error('home-node-dsh-status-unavailable');
        var deadline = Date.now() + 60000;
        var readyState = null;
        var lastState = null;
        while (Date.now() < deadline) {
          lastState = await workRunRemote.dshStatus().catch(function () { return null; });
          var hostState = lastState && lastState.host;
          var webState = lastState && lastState.webUi;
          if (hostState && hostState.runtimeInstalled === false) {
            showRuntimeInstall(hostState, lastState);
            return;
          }
          if (hostState && hostState.enabled !== true) throw new Error('production-dsh-runtime-disabled');
          if (webState && webState.mode === 'production' && webState.synthetic === false && webState.ready === true) {
            readyState = webState;
            break;
          }
          if (hostState && hostState.webUi && hostState.webUi.phase === 'failed') {
            throw new Error('production-dsh-web-host-failed:' + String(hostState.webUi.error || 'unknown'));
          }
          await new Promise(function (resolve) { root.setTimeout(resolve, 500); });
        }
        if (!readyState || !readyState.launchUrl || readyState.revision !== 'd743267388641bc76f17c45ce8b4c231aed1d32c') {
          throw new Error('production-dsh-web-host-not-ready');
        }
        var productionUrl = new URL(readyState.launchUrl);
        if (productionUrl.protocol !== 'http:' || productionUrl.hostname !== '127.0.0.1'
          || productionUrl.pathname !== '/' || !productionUrl.searchParams.has('token')
          || productionUrl.searchParams.get('ib_parent_origin') !== root.location.origin
          || productionUrl.origin !== String(readyState.origin || '')) throw new Error('unexpected-production-dsh-host');
        frameOrigin = productionUrl.origin;
        url = productionUrl.href;
        frame.hidden = false;
        installPanel.hidden = true;
        runtimeBackButton.hidden = true;
        runtimeManageButton.setAttribute('aria-pressed', 'false');
        if (!frame.getAttribute('src') || reload) frame.src = url;
        status.textContent = '已就绪，可以继续提问或创建 APP。';
        clearDshDiagnostic();
        if (devDetailBody) devDetailBody.textContent = 'DeepSeek Harness ' + readyState.revision.slice(0, 12) + ' · Home Node Run';
        return;
      }
      if (!devServiceConfig || !devServiceConfig.dshControlUrl || !frameOrigin
        || !devServiceConfig.sessionToken || !devServiceConfig.instanceId) throw new Error('dev-service-config-unavailable');
      var response = await fetch(devServiceConfig.dshControlUrl + '/status', { cache: 'no-store',
        headers: { 'X-IB-Dev-Session': String(devServiceConfig.sessionToken), 'X-IB-Dev-Instance': String(devServiceConfig.instanceId) },
        signal: AbortSignal.timeout(5000) });
      var value = await response.json();
      if (!value.ok || value.synthetic !== true || value.revision !== 'd743267388641bc76f17c45ce8b4c231aed1d32c'
        || value.phase !== 'ready' || value.environment !== 'synthetic'
        || value.devInstanceId !== devServiceConfig.instanceId || !value.launchUrl) throw new Error('host-not-ready');
      var parsed = new URL(value.launchUrl);
      if (parsed.origin !== frameOrigin || parsed.pathname !== '/') throw new Error('unexpected-host');
      url = parsed.href;
      frame.hidden = false;
      installPanel.hidden = true;
      runtimeBackButton.hidden = true;
      runtimeManageButton.setAttribute('aria-pressed', 'false');
      if (!frame.getAttribute('src') || reload) frame.src = url;
      status.textContent = '已就绪，可以继续提问或创建 APP。';
      clearDshDiagnostic();
      if (devDetailBody) devDetailBody.textContent = 'instance ' + String(devServiceConfig.instanceId || '')
        + ' · revision ' + value.revision.slice(0, 12);
    } catch (error) {
      status.textContent = '工作台暂时无法连接，已为你切换到备用界面。';
      showDshDiagnostic(safeDshDiagnostic(error));
      select(false);
    }
  }
  function sendP1(sessionId, phase, detail) {
    if (!frame.contentWindow || !sessionId) return;
    var payload = Object.assign({}, detail || {});
    if (!payload.executorSelection && workModeUi) {
      var selectionState = workModeUi.getState();
      var pinnedSelection = selectionState.run && selectionState.run.executorSelection;
      var nativeSelection = nativePresetBySession[sessionId];
      payload.executorSelection = {
        roleId: pinnedSelection && pinnedSelection.roleId || selectionState.executorSelection && selectionState.executorSelection.roleId || '',
        profileRef: pinnedSelection && pinnedSelection.profileRef || selectionState.profileRef || '',
        presetId: pinnedSelection && pinnedSelection.presetId || nativeSelection && nativeSelection.presetId
          || selectionState.executorSelection && selectionState.executorSelection.presetId || 'general'
      };
    }
    var pendingTask = p1TaskPrompts[sessionId];
    if (pendingTask && pendingTask.runId && String(payload.runId || '') === pendingTask.runId && pendingTask.taskPrompt) {
      if (!payload.tracePrompt) payload.tracePrompt = pendingTask.taskPrompt;
      if (payload.authorization && !payload.authorization.taskPrompt) payload.authorization.taskPrompt = pendingTask.taskPrompt;
    }
    frame.contentWindow.postMessage(Object.assign({
      type: 'ib-dsh-p1-run-state', sessionId: sessionId, phase: phase
    }, payload), frameOrigin);
    if (['completed', 'failed', 'cancelled'].indexOf(phase) >= 0 && pendingTask
      && String(payload.runId || '') === pendingTask.runId) {
      root.setTimeout(function () { if (p1TaskPrompts[sessionId] === pendingTask) delete p1TaskPrompts[sessionId]; }, 3000);
    }
  }
  function acknowledgeDshRunCreation(sessionId, input, created, error, runId) {
    var submissionId = String(input && input.submissionId || '');
    if (!/^work-mode-(?:general|coding|research|app-builder)-[A-Za-z0-9-]{1,80}$/.test(submissionId) || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'ib-dsh-p3-run-created', sessionId: sessionId,
      submissionId: submissionId, created: created === true, runId: String(runId || ''), error: String(error || '') }, frameOrigin);
  }
  function sendAppExportState(sessionId, requestId, kind, version, ok, message) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'ib-dsh-app-export-state', sessionId: sessionId, requestId: requestId,
      kind: kind, version: version, ok: ok === true, message: String(message || '') }, frameOrigin);
  }
  function appExportFilename(name, version, suffix) {
    var base = String(name || 'Generated-App');
    if (typeof base.normalize === 'function') base = base.normalize('NFKC');
    base = base.replace(/[^A-Za-z0-9\u3400-\u9fff._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
    if (!base || base === '.' || base === '..') base = 'Generated-App';
    return base + '-v' + String(version) + suffix;
  }
  async function exportP1AppDraftVersion(sessionId, data) {
    var requestId = String(data && data.requestId || '');
    var kind = String(data && data.kind || '');
    var draftRef = String(data && data.draftRef || '');
    var version = Number(data && data.version);
    function fail(message) { sendAppExportState(sessionId, requestId, kind, version, false, message); }
    if (activeP1SessionId !== sessionId || !/^app-export-[A-Za-z0-9-]{1,80}$/.test(requestId)
      || !['source-zip', 'web-app'].includes(kind) || !/^ad_[A-Fa-f0-9-]{36}$/.test(draftRef)
      || !Number.isSafeInteger(version) || version < 0 || !workModeUi || !workRunRemote) {
      fail('导出请求无效；当前草稿和已安装 APP 未更改。'); return;
    }
    var current = workModeUi.getState();
    if (!current || !current.run || current.executor !== 'dsh' || current.dshSessionId !== sessionId
      || current.run.workflowId !== 'app.builder' || current.run.appDraftRef !== draftRef
      || typeof workRunRemote.getAppDraft !== 'function' || typeof workRunRemote.getAppDraftVersion !== 'function') {
      fail('当前会话无法读取该 APP 草稿；未更改草稿或安装状态。'); return;
    }
    try {
      var latest = await workRunRemote.getAppDraft(draftRef, current.run.projectRef, current.run.runId);
      var history = latest && latest.ok === true && latest.draft && latest.draft.history;
      if (!Array.isArray(history) || !history.some(function (item) { return item && item.version === version; })) {
        fail('所选版本已不可用；未更改草稿或安装状态。'); return;
      }
      var response = await workRunRemote.getAppDraftVersion(draftRef, current.run.projectRef, version);
      var snapshot = response && response.ok === true && response.version;
      if (!snapshot || snapshot.draftRef !== draftRef || snapshot.projectRef !== current.run.projectRef
        || snapshot.version !== version || !root.IBAppBuilderCore
        || typeof root.IBAppBuilderCore.normalizeDraft !== 'function') {
        fail('无法读取所选的已提交版本；未更改草稿或安装状态。'); return;
      }
      var packageDraft = root.IBAppBuilderCore.normalizeDraft({ draftRef: snapshot.draftRef, projectRef: snapshot.projectRef,
        name: snapshot.name, version: snapshot.version, files: snapshot.files });
      if (!packageDraft) { fail('所选版本的源码不完整或不符合导出策略。'); return; }
      var file, filename, mime;
      if (kind === 'source-zip') {
        file = root.IBAppBuilderCore.buildSourceZip(packageDraft);
        filename = appExportFilename(packageDraft.name, version, '-source.zip');
        mime = 'application/zip';
      } else {
        file = root.IBAppBuilderCore.buildStandaloneHtml(packageDraft);
        filename = appExportFilename(packageDraft.name, version, '.html');
        mime = 'text/html;charset=utf-8';
      }
      if (!file || !file.length) { fail('生成导出文件失败；草稿保持不变。'); return; }
      var blob = new Blob([file], { type: mime });
      var objectUrl = root.URL.createObjectURL(blob);
      var anchor = root.document.createElement('a');
      anchor.href = objectUrl; anchor.download = filename; anchor.rel = 'noopener'; anchor.style.display = 'none';
      root.document.body.appendChild(anchor); anchor.click(); anchor.remove();
      root.setTimeout(function () { try { root.URL.revokeObjectURL(objectUrl); } catch (_) {} }, 60000);
      sendAppExportState(sessionId, requestId, kind, version, true,
        '已开始下载 ' + filename + '。草稿、历史版本和已安装 APP 未更改。');
    } catch (_) { fail('读取或生成导出文件失败；草稿、历史版本和已安装 APP 未更改。'); }
  }
  function sendExecutorState(sessionId, error) {
    if (!frame.contentWindow || !sessionId || !workModeUi) return;
    Promise.resolve(typeof root.loadApiConfigs === 'function' ? root.loadApiConfigs() : null).catch(function () {}).then(async function () {
      if (activeP1SessionId !== sessionId) return;
      var core = root.IBWorkModeExecutor;
      var routeCore = root.IBWorkModeProviderRoute;
      var current = workModeUi.getState();
      var profiles = Array.isArray(root.apiConfigs) ? root.apiConfigs : [];
      var roles = core && typeof core.roleCatalog === 'function' ? core.roleCatalog(profiles, routeCore) : [];
      var modelProfiles = core && typeof core.profileCatalog === 'function' ? core.profileCatalog(profiles, routeCore) : [];
      var terminal = !!(current.run && ['completed', 'failed', 'cancelled'].indexOf(current.run.status) >= 0);
      var draftList = [];
      if (current.selectedProjectRef && workRunRemote && typeof workRunRemote.listAppDrafts === 'function') {
        try { var listedDrafts = await workRunRemote.listAppDrafts(current.selectedProjectRef); if (listedDrafts && listedDrafts.ok === true) draftList = listedDrafts.drafts || []; } catch (_) {}
      }
      var snapshot = current.run && current.run.executorSelection && !terminal ? current.run.executorSelection : null;
      var nativePreset = nativePresetBySession[sessionId];
      var selection = snapshot ? {
        roleId: snapshot.roleId, profileRef: snapshot.profileRef, presetId: snapshot.presetId
      } : {
        roleId: current.executorSelection && current.executorSelection.roleId || '',
        profileRef: current.profileRef || '',
        presetId: nativePreset && nativePreset.presetId || current.executorSelection && current.executorSelection.presetId || 'general'
      };
      frame.contentWindow.postMessage({
        type: 'ib-dsh-p3-executor-state', sessionId: sessionId,
        roles: roles, profiles: modelProfiles, selection: selection,
        appDrafts: draftList,
        locked: !!snapshot && !terminal,
        error: String(error || '')
      }, frameOrigin);
    });
  }
  function applyNativePresetState(sessionId, data) {
    var map = { 'synthetic-p0': 'general', general: 'general', coding: 'coding', research: 'research', 'app-builder': 'app-builder' };
    var nativePresetId = String(data && data.nativePresetId || '');
    var presetId = map[nativePresetId];
    if (!sessionId || !presetId || String(data.presetId || '') !== presetId) return;
    nativePresetBySession[sessionId] = { nativePresetId: nativePresetId, presetId: presetId };
    if (Object.keys(nativePresetBySession).length > 64) {
      Object.keys(nativePresetBySession).slice(0, 16).forEach(function (id) {
        if (id !== activeP1SessionId && id !== sessionId) delete nativePresetBySession[id];
      });
    }
    if (activeP1SessionId !== sessionId || !workModeUi || !root.IBWorkModeExecutor) return;
    Promise.resolve(typeof root.loadApiConfigs === 'function' ? root.loadApiConfigs() : null).catch(function () {}).then(async function () {
      if (activeP1SessionId !== sessionId) return;
      var current = workModeUi.getState();
      if (current.run && ['queued', 'running', 'cancel_requested'].indexOf(current.run.status) >= 0) {
        var pinned = current.run.executorSelection && current.run.executorSelection.presetId;
        if (current.dshSessionId === sessionId && pinned && pinned !== presetId) {
          sendExecutorState(sessionId, '当前 DSH Session 的原生模式与已固定 Run 不一致；Run 未改动。');
          return;
        }
        sendExecutorState(sessionId, '当前 Home Node Run 已固定模式；请先完成或取消后再选择。');
        return;
      }
      if (current.profileRef) {
        var core = root.IBWorkModeExecutor;
        var choice = core.normalizeChoice({ roleId: current.executorSelection && current.executorSelection.roleId || '',
          profileRef: current.profileRef, presetId: presetId });
        if (!choice) { sendExecutorState(sessionId, '当前角色或模型 Profile 不可用。'); return; }
        var selected = await workModeUi.setExecutorSelection(choice);
        if (!selected || selected.ok !== true) {
          sendExecutorState(sessionId, String(selected && selected.error || '原生 Agent 模式未同步到 Home Node。'));
          return;
        }
        var executor = await workModeUi.setExecutor('dsh');
        if (!executor || executor.ok !== true) {
          sendExecutorState(sessionId, String(executor && executor.error || 'DSH Host 尚不可用。'));
          return;
        }
      }
      sendExecutorState(sessionId, '');
      sendP1(sessionId, 'needs-run', { executorSelection: {
        roleId: current.executorSelection && current.executorSelection.roleId || '',
        profileRef: current.profileRef || '', presetId: presetId
      } });
    }).catch(function () { sendExecutorState(sessionId, '原生 Agent 模式同步失败。'); });
  }
  function applyExecutorSelection(sessionId, data) {
    if (activeP1SessionId !== sessionId || !workModeUi || !data || !root.IBWorkModeExecutor
      || typeof root.IBWorkModeExecutor.normalizeChoice !== 'function') return;
    Promise.resolve(typeof root.loadApiConfigs === 'function' ? root.loadApiConfigs() : null).catch(function () {}).then(async function () {
      if (activeP1SessionId !== sessionId) return;
      var profiles = Array.isArray(root.apiConfigs) ? root.apiConfigs : [];
      var core = root.IBWorkModeExecutor;
      var routeCore = root.IBWorkModeProviderRoute;
      var selectionKind = String(data.selectionKind || '');
      var current = workModeUi.getState();
      var roleId = selectionKind === 'role' ? String(data.roleId || '')
        : String(current.executorSelection && current.executorSelection.roleId || '');
      var role = roleId ? profiles.find(function (item) { return item && !item.archived && String(item.id || '') === roleId; }) : null;
      var presetId = nativePresetBySession[sessionId] && nativePresetBySession[sessionId].presetId
        || current.executorSelection && current.executorSelection.presetId || 'general';
      var profileRef = selectionKind === 'profile' ? String(data.profileRef || '')
        : (role ? core.roleProfileRef(role) : String(current.profileRef || ''));
      var profileRows = core.profileCatalog(profiles, routeCore);
      var roles = core.roleCatalog(profiles, routeCore);
      var profile = profiles.find(function (item) { return item && !item.archived && String(item.id || '') === profileRef; });
      var choice = core.normalizeChoice({ roleId: roleId, profileRef: profileRef, presetId: presetId });
      if (!choice || !profile || !profile.credentialRef
        || !profileRows.some(function (item) { return item.profileRef === profileRef; })
        || (roleId && (!role || !roles.some(function (item) { return item.roleId === roleId; })))) {
        sendExecutorState(sessionId, '角色或模型 Profile 不可用；未更改当前 Run。');
        return;
      }
      var selected = await workModeUi.setExecutorSelection(choice);
      if (!selected || selected.ok !== true) {
        sendExecutorState(sessionId, selected && selected.error === 'run-executor-selection-locked'
          ? '当前 Run 的角色、模型 Profile、原生模式和工具权限已固定；结束后可为新的 Run 选择。'
          : String(selected && selected.error || '执行者配置未应用。'));
        return;
      }
      var executor = await workModeUi.setExecutor('dsh');
      if (!executor || executor.ok !== true) {
        sendExecutorState(sessionId, String(executor && executor.error || 'DSH Host 尚不可用。'));
        return;
      }
      sendExecutorState(sessionId, '');
      current = workModeUi.getState();
      var appBuilder = presetId === 'app-builder';
      sendP1(sessionId, 'needs-run', { executorSelection: { roleId: roleId, profileRef: profileRef, presetId: presetId },
        error: current.run && current.run.status === 'queued' ? '' : (current.selectedProjectRef
          ? (appBuilder ? '执行者已固定。直接在 DSH 输入框描述 APP 任务并发送。'
            : '角色与模型 Profile 已应用；Agent 模式由 DSH 原生入口选择。')
          : '请先选择 Workspace 项目与任务范围。') });
      if (current.run && current.run.status === 'queued') {
        lastP1StatusReadAt = 0;
        restoreP1Session(sessionId);
      }
    }).catch(function () { sendExecutorState(sessionId, '执行者配置读取失败。'); });
  }
  function createDshRun(sessionId, input) {
    input = input || {};
    if (activeP1Operation || activeP1SessionId !== sessionId || !workModeUi) {
      acknowledgeDshRunCreation(sessionId, input, false, '当前任务仍在处理中，请稍候后重试。');
      return;
    }
    var current = workModeUi.getState();
    var sessionPreset = nativePresetBySession[sessionId];
    if (sessionPreset && current.executorSelection && current.executorSelection.presetId !== sessionPreset.presetId) {
      var mismatch = 'DSH 原生 Agent 模式与 Home Node 选择不一致；Run 未创建。请重新选择模式或刷新会话。';
      sendP1(sessionId, 'needs-run', { error: mismatch });
      acknowledgeDshRunCreation(sessionId, input, false, mismatch);
      return;
    }
    if (current.run && ['completed', 'failed', 'cancelled'].indexOf(current.run.status) < 0) {
      sendP1(sessionId, current.run.status === 'queued' && current.executor === 'dsh' ? 'needs-binding' : 'needs-run',
        { error: '先完成或取消当前 Home Node Run；本 DSH Session 不会覆盖现有任务。' });
      acknowledgeDshRunCreation(sessionId, input, false, '请先完成或取消当前任务，再提交下一条需求。');
      return;
    }
    if (!current.selectedProjectRef || !current.profileRef) {
      sendP1(sessionId, 'needs-run', { error: current.executorSelection && current.executorSelection.presetId === 'app-builder'
        ? (!current.selectedProjectRef ? '请先选择 APP 所属的 Workspace 项目；模型可通过上方执行者选择器设置。'
          : '请通过上方执行者选择器绑定可用模型。')
        : '请先在工作台选择 Workspace 项目、文件范围和模型。' });
      acknowledgeDshRunCreation(sessionId, input, false, current.executorSelection && current.executorSelection.presetId === 'app-builder'
        ? (!current.selectedProjectRef ? '请先选择 APP 所属的 Workspace 项目；需求仍保留在输入框中。'
          : '请通过上方执行者选择器绑定可用模型；需求仍保留在输入框中。')
        : '请先完成任务配置；需求仍保留在输入框中。');
      return;
    }
    var appBuilder = !!(current.executorSelection && current.executorSelection.presetId === 'app-builder');
    var coding = !!(current.executorSelection && current.executorSelection.presetId === 'coding');
    var taskPrompt = String(input.taskPrompt || '').trim();
    if ((appBuilder || coding) && (!taskPrompt || taskPrompt.length > 2400 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskPrompt))) {
      var promptError = coding ? '请描述要创建或修改的 Workspace 文件（最多 2400 个字符）。' : '请描述要生成或修改的 APP（最多 2400 个字符）。';
      sendP1(sessionId, 'needs-run', { error: promptError });
      acknowledgeDshRunCreation(sessionId, input, false, promptError);
      return;
    }
    var draftRef = String(input.draftRef || '');
    var createdRunId = '';
    var workRuns = root.IB && root.IB.homeNode && root.IB.homeNode.workRuns;
    var createOrFindDraft = Promise.resolve(null);
    if (appBuilder) {
      if (!workRuns || typeof workRuns.createAppDraft !== 'function' || typeof workRuns.getAppDraft !== 'function'
        || typeof workRuns.queueAppDraftRun !== 'function') {
        sendP1(sessionId, 'needs-run', { error: 'Home Node App Draft 接口不可用。' });
        acknowledgeDshRunCreation(sessionId, input, false, 'APP 草稿服务暂不可用；需求仍保留在输入框中。');
        return;
      }
      createOrFindDraft = draftRef
        ? Promise.resolve(workRuns.getAppDraft(draftRef, current.selectedProjectRef)).then(function (result) {
          if (!result || result.ok !== true || !result.draft || result.draft.projectRef !== current.selectedProjectRef) {
            throw new Error('所选 APP 草稿不属于当前 Workspace 项目。');
          }
          return result.draft;
        })
        : Promise.resolve(workRuns.createAppDraft({ projectRef: current.selectedProjectRef, name: 'Todo App' })).then(function (result) {
          if (!result || result.ok !== true || !result.draft) throw new Error(String(result && result.error || 'App Draft 创建失败。'));
          return result.draft;
        });
    }
    activeP1Operation = createOrFindDraft.then(function (draft) {
      return workModeUi.createRun(current.selectedProjectRef, appBuilder
        ? { workflowId: 'app.builder', appDraftRef: draft.draftRef }
        : (coding ? { workflowId: 'coding.workspace' } : undefined)).then(function (created) {
        if (!created || created.ok !== true || !created.run || !created.run.executorSelection) {
          throw new Error(String(created && created.error || 'Home Node Run 未保存执行者配置。'));
        }
        if (!appBuilder) return created;
        return Promise.resolve(workRuns.queueAppDraftRun(created.run.runId, {
          draftRef: draft.draftRef, projectRef: current.selectedProjectRef, instruction: taskPrompt
        })).then(function (queued) {
          if (!queued || queued.ok !== true) throw new Error(String(queued && queued.error || 'App Draft Run 绑定失败。'));
          return created;
        });
      });
    }).then(function (created) {
      if (!created || created.ok !== true || !created.run || !created.run.executorSelection) {
        throw new Error(String(created && created.error || 'Home Node Run 未保存执行者配置。'));
      }
      createdRunId = created.run.runId;
      if (coding) p1TaskPrompts[sessionId] = { runId: created.run.runId, taskPrompt: taskPrompt };
      return workModeUi.setExecutor('dsh');
    }).then(function (selected) {
      if (!selected || selected.ok !== true) throw new Error(String(selected && selected.error || 'DSH executor unavailable.'));
      return bindP1Session(sessionId, true).then(function (bound) {
        if (!bound) throw new Error('DSH Session binding did not complete.');
        acknowledgeDshRunCreation(sessionId, input, true, '', createdRunId);
        sendExecutorState(sessionId, '');
      });
    }).catch(function (error) {
      var message = String(error && error.message || 'Home Node Run 创建失败。');
      sendP1(sessionId, 'needs-run', { error: message });
      acknowledgeDshRunCreation(sessionId, input, false, message + '；需求仍保留在输入框中。');
    }).finally(function () { activeP1Operation = null; lastP1StatusReadAt = 0; restoreP1Session(sessionId); });
  }
  function executionEvents(state) {
    return (state && Array.isArray(state.runEvents) ? state.runEvents : []).slice(-512).map(function (item) {
      return { sequence: item.sequence, runId: String(item.runId || state.run && state.run.runId || ''),
        event: item.executionEvent || item.event || item.eventType, path: item.path || '', code: item.code || '',
        toolName: item.toolName || '', call: item.call, fileId: item.fileId,
        actionTrace: item.actionTrace && typeof item.actionTrace === 'object' ? {
          schemaVersion: item.actionTrace.schemaVersion,
          actionId: item.actionTrace.actionId,
          requestId: item.actionTrace.requestId,
          runId: item.actionTrace.runId,
          status: item.actionTrace.status,
          authorityResult: item.actionTrace.authorityResult
        } : null,
        dshEvent: item.dshEvent && typeof item.dshEvent === 'object' ? item.dshEvent : null };
    });
  }
  function traceRouteFields(run) {
    var scope = run && run.executorSelection && run.executorSelection.providerScope || {};
    return { traceProvider: String(scope.provider || ''), traceModel: String(scope.model || ''),
      traceAt: Number(run && run.updatedAt) || Date.now() };
  }
  function dshMemorySummary(record) {
    var payload = record && record.payload || {};
    if (typeof payload.statement === 'string') return payload.statement.slice(0, 1200);
    if (typeof payload.summary === 'string') return String(payload.name || '') + ' · ' + payload.summary.slice(0, 1200);
    if (typeof payload.name === 'string') return payload.name.slice(0, 1200);
    return '';
  }
  function persistedP1Result(saved) {
    var report = saved && saved.ok === true && saved.result && saved.result.report;
    if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) return null;
    return { report: report, status: saved.status || saved.result.status || '' };
  }
  async function appDraftArtifact(run, runId) {
    if (!run || !run.appDraftRef || !workRunRemote || typeof workRunRemote.getAppDraft !== 'function') return null;
    var result;
    try { result = await workRunRemote.getAppDraft(run.appDraftRef, run.projectRef, runId || run.runId); }
    catch (_) { result = null; }
    if (!result || result.ok !== true || !result.draft) return null;
    var core = root.IBAppBuilderCore;
    var previewSrcdoc = core && typeof core.buildSrcdoc === 'function' ? core.buildSrcdoc(result.draft) : '';
    var installed = !!(root.IB && root.IB.apps && typeof root.IB.apps.isGeneratedInstalled === 'function'
      && root.IB.apps.isGeneratedInstalled(result.draft.draftRef, result.draft.version));
    return { draft: result.draft, previewSrcdoc: previewSrcdoc, installed: installed };
  }
  async function p1SessionHistory(result) {
    var bindings = result && Array.isArray(result.runs) ? result.runs : [];
    if (!bindings.length && result && result.run && result.binding) bindings = [{ run: result.run, binding: result.binding }];
    bindings = bindings.slice(0, 16);
    var key = bindings.map(function (item) { return item.run && [item.run.runId, item.run.status, item.run.version].join(':'); }).join('|');
    if (p1HistoryCacheSessionId === String(result && result.binding && result.binding.sessionId || '') && p1HistoryCacheKey === key) {
      return p1HistoryCache.slice();
    }
    var history = await Promise.all(bindings.map(async function (item) {
      var run = item && item.run;
      if (!run) return null;
      var summary = '';
      var draftVersion = null;
      if (run.status === 'completed' && workModeRuntime && typeof workModeRuntime.getResult === 'function') {
        try {
          var saved = await workModeRuntime.getResult(run.runId);
          var persisted = persistedP1Result(saved);
          summary = persisted && persisted.report && String(persisted.report.summary || '').slice(0, 240) || '';
        } catch (_) {}
      }
      if (run.workflowId === 'app.builder' && run.appDraftRef && workRunRemote && typeof workRunRemote.getAppDraft === 'function') {
        try {
          var draftRecord = await workRunRemote.getAppDraft(run.appDraftRef, run.projectRef, run.runId);
          var versions = draftRecord && draftRecord.ok === true && draftRecord.draft && draftRecord.draft.history;
          var version = Array.isArray(versions) && versions.find(function (entry) { return entry.runId === run.runId; });
          if (version) draftVersion = version.version;
        } catch (_) {}
      }
      return { runId: run.runId, workflowId: run.workflowId, status: run.status, createdAt: run.createdAt,
        updatedAt: run.updatedAt, summary: summary, draftVersion: draftVersion };
    }));
    p1HistoryCacheSessionId = String(result && result.binding && result.binding.sessionId || '');
    p1HistoryCacheKey = key;
    p1HistoryCache = history.filter(Boolean);
    return p1HistoryCache.slice();
  }
  async function listP1AppDrafts(projectRef) {
    if (!projectRef || !workRunRemote || typeof workRunRemote.listAppDrafts !== 'function') return [];
    try {
      var listed = await workRunRemote.listAppDrafts(projectRef);
      return listed && listed.ok === true && Array.isArray(listed.drafts) ? listed.drafts : [];
    } catch (_) { return []; }
  }
  function restoreP1Session(sessionId, taskPrompt) {
    taskPrompt = typeof taskPrompt === 'string' ? taskPrompt.trim().slice(0, 2400) : '';
    if (taskPrompt && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskPrompt)) {
      var existingTask = p1TaskPrompts[sessionId];
      if (!existingTask || !existingTask.runId || existingTask.taskPrompt === taskPrompt) {
        p1TaskPrompts[sessionId] = { runId: existingTask && existingTask.runId || '', taskPrompt: taskPrompt };
      }
    }
    if (activeP1Operation && activeP1SessionId === sessionId) return;
    if (activeP1SessionId === sessionId && Date.now() - lastP1StatusReadAt < 1000) return;
    activeP1SessionId = sessionId;
    lastP1StatusReadAt = Date.now();
    if (!workRunRemote || typeof workRunRemote.getDshSession !== 'function' || !workModeUi) {
      sendP1(sessionId, 'error', { error: 'Home Node DSH Session binding API is unavailable.' });
      return;
    }
    Promise.resolve(workRunRemote.getDshSession(sessionId)).then(async function (result) {
      if (activeP1SessionId !== sessionId) return;
      if (!result || result.ok !== true || result.found !== true || !result.binding || !result.run) {
        var empty = workModeUi.getState();
        var phase = empty.run && empty.run.status === 'queued' && empty.executor === 'dsh' ? 'needs-binding' : 'needs-run';
        var appBuilderNeedsRun = empty.executorSelection && empty.executorSelection.presetId === 'app-builder';
        var codingNeedsRun = empty.executorSelection && empty.executorSelection.presetId === 'coding';
        var modeLabel = empty.executorSelection && empty.executorSelection.presetId === 'research' ? 'Research 研究问题'
          : (codingNeedsRun ? 'Coding 文件任务' : (appBuilderNeedsRun ? 'App Builder APP 需求' : 'General 任务'));
        sendP1(sessionId, phase, { error: phase === 'needs-binding'
          ? '绑定只保存会话对应关系；授权仍需在本工作台确认。'
          : ('在下方 DSH 输入框描述' + modeLabel + '并发送；Home Node 会按当前原生模式创建 Run，权限仍需单独确认。'
            + (codingNeedsRun ? ' 先选择 Workspace 文件范围。' : '')) });
        return;
      }
      var sessionHistory = await p1SessionHistory(result);
      var current = workModeUi.getState();
      if (!current.run || current.run.runId !== result.run.runId) {
        if (current.run && ['queued', 'running', 'cancel_requested'].indexOf(current.run.status) >= 0) {
          sendP1(sessionId, 'error', { error: '当前会话与已选中的活动 Run 不匹配；请先完成或取消该 Run。' });
          return;
        }
        var selected = await workModeUi.selectRun(result.run.runId);
        if (!selected || selected.ok !== true) {
          sendP1(sessionId, 'error', { error: '无法恢复绑定的 Home Node Run。' });
          return;
        }
      }
      workModeUi.bindDshSession(sessionId);
      var viewState = workModeUi.getState();
      await workModeUi.refreshRunEvents(result.run.runId);
      viewState = workModeUi.getState();
      if (result.run.status === 'completed' && workModeRuntime && typeof workModeRuntime.getResult === 'function') {
        var saved = await workModeRuntime.getResult(result.run.runId);
        var persistedResult = persistedP1Result(saved);
        var artifact = result.run.workflowId === 'app.builder' ? await appDraftArtifact(result.run, result.run.runId) : null;
        var appDrafts = result.run.workflowId === 'app.builder' ? await listP1AppDrafts(result.run.projectRef) : [];
        sendP1(sessionId, persistedResult ? 'completed' : 'error', { runId: result.run.runId,
          result: persistedResult, events: executionEvents(viewState), draft: artifact && artifact.draft || null,
          previewSrcdoc: artifact && artifact.previewSrcdoc || '', appInstalled: artifact && artifact.installed === true,
          history: sessionHistory, drafts: appDrafts,
          ...traceRouteFields(result.run), traceSummary: persistedResult && persistedResult.report.summary || '',
          error: persistedResult ? '' : 'Home Node Result unavailable.' });
        sendExecutorState(sessionId, '');
      } else if (result.run.status === 'failed' || result.run.status === 'cancelled') {
        var failedArtifact = result.run.workflowId === 'app.builder' ? await appDraftArtifact(result.run, result.run.runId) : null;
        var failedDrafts = result.run.workflowId === 'app.builder' ? await listP1AppDrafts(result.run.projectRef) : [];
        sendP1(sessionId, result.run.status, { runId: result.run.runId, events: executionEvents(viewState),
          draft: failedArtifact && failedArtifact.draft || null, previewSrcdoc: failedArtifact && failedArtifact.previewSrcdoc || '',
          appInstalled: failedArtifact && failedArtifact.installed === true, history: sessionHistory, drafts: failedDrafts,
          ...traceRouteFields(result.run),
          error: result.run.status === 'failed' ? '本次修改未提交；上一已保存版本仍可预览和继续编辑。' : '' });
        sendExecutorState(sessionId, '');
      } else if (result.run.status === 'running' || result.run.status === 'cancel_requested') {
        sendP1(sessionId, 'running', { runId: result.run.runId, events: executionEvents(viewState), history: sessionHistory,
          ...traceRouteFields(result.run) });
      } else {
        var preview = await workModeUi.previewAuthorization();
        if (!preview || preview.ok !== true) {
          sendP1(sessionId, 'needs-consent', { runId: result.run.runId, events: executionEvents(workModeUi.getState()),
            error: 'Native Work UI 无法重新核对项目与 Provider；Consent 未开始。' });
          return;
        }
        viewState = workModeUi.getState();
        if (viewState.consentId && viewState.consent && viewState.consent.status === 'active'
          && String(result.binding.consentId || '') !== viewState.consentId) {
          var consentLink = await workRunRemote.bindDshSession(result.run.runId, {
            sessionId: sessionId, consentId: viewState.consentId, expectedVersion: result.run.version
          });
          if (!consentLink || consentLink.ok !== true) {
            sendP1(sessionId, 'error', { runId: result.run.runId, error: String(consentLink && consentLink.error || 'dsh-session-consent-bind-failed') });
            return;
          }
          result.binding = consentLink.binding;
        }
        var selectedFileIds = viewState.consent && viewState.consent.status === 'active'
          ? viewState.consentFileIds : viewState.fileIds;
        var selectedFiles = (preview.files || []).filter(function (file) { return selectedFileIds.indexOf(file.fileId) >= 0; })
          .map(function (file) { return { fileId: file.fileId, path: file.path, size: file.size }; });
        var agent = (preview.providers || []).find(function (item) { return item.destination === 'agent'; });
        var review = (preview.providers || []).find(function (item) { return item.destination === 'middle_brain'; });
        var memoryRecords = viewState.memoryRecall && Array.isArray(viewState.memoryRecall.records)
          ? viewState.memoryRecall.records.map(function (record) {
            return { memoryId: record.memoryId, type: record.type, revision: record.revision,
              summary: dshMemorySummary(record), selected: viewState.memorySelectedIds.indexOf(record.memoryId) >= 0 };
          }) : [];
        var appBuilder = result.run.workflowId === 'app.builder';
        var coding = result.run.workflowId === 'coding.workspace';
        var taskState = p1TaskPrompts[sessionId];
        if (coding && taskState && taskState.taskPrompt) taskState.runId = result.run.runId;
        var appDraft = appBuilder ? await appDraftArtifact(result.run, result.run.runId) : null;
        var appDrafts = [];
        if (viewState.selectedProjectRef && workRunRemote && typeof workRunRemote.listAppDrafts === 'function') {
          try { var listedAppDrafts = await workRunRemote.listAppDrafts(viewState.selectedProjectRef); if (listedAppDrafts && listedAppDrafts.ok === true) appDrafts = listedAppDrafts.drafts || []; } catch (_) {}
        }
        var authorization = {
          runId: result.run.runId, projectRef: result.run.projectRef, workflowId: result.run.workflowId,
          appDraftRef: result.run.appDraftRef || '', taskPrompt: appDraft && appDraft.draft.request || (coding && taskState ? taskState.taskPrompt : ''),
          appDraftName: appDraft && appDraft.draft.name || '', appDraftVersion: appDraft && appDraft.draft.version || 0,
          appDrafts: appDrafts, files: selectedFiles,
          executorSelection: result.run.executorSelection ? {
            roleId: result.run.executorSelection.roleId,
            roleName: result.run.executorSelection.roleName,
            profileRef: result.run.executorSelection.profileRef,
            presetId: result.run.executorSelection.presetId,
            presetLabel: root.IBWorkModeExecutor && root.IBWorkModeExecutor.preset(result.run.executorSelection.presetId)
              ? root.IBWorkModeExecutor.preset(result.run.executorSelection.presetId).label : result.run.executorSelection.presetId,
            allowedTools: result.run.executorSelection.allowedTools.slice()
          } : null,
          agent: agent ? { provider: agent.provider, model: agent.model, endpointLabel: agent.endpointLabel } : null,
          review: review ? { provider: review.provider, model: review.model, endpointLabel: review.endpointLabel } : null,
          workspaceWriteConfirmed: !!(viewState.consent && viewState.consent.workspaceWriteConfirmed === true),
          memory: { records: memoryRecords, selectedIds: viewState.memorySelectedIds.slice(),
            selectedCount: viewState.memorySnapshot && viewState.memorySnapshot.recordCount || 0,
            contextChars: viewState.memorySnapshot && viewState.memorySnapshot.contextChars || 0,
            contextHash: viewState.memorySnapshot && viewState.memorySnapshot.contextHash || '' },
          expiresInMs: 15 * 60 * 1000, previewKey: String(viewState.previewKey || '')
        };
        var hasConsent = !!(viewState.consentId && viewState.consentId === String(result.binding.consentId || '')
          && viewState.consent && viewState.consent.status === 'active');
        var error = appBuilder ? '' : (selectedFiles.length ? '' : '请切回 Native Work UI 明确选择至少一个项目文件。');
        if (!authorization.agent || (!appBuilder && !coding && !authorization.review)) error = 'Provider 路由不可用；请在 Native Work UI 重新核对。';
        else if (!hasConsent && !error) error = '逐项核对权限预览并分别确认外发和 Result 保存风险。';
        sendP1(sessionId, hasConsent ? 'ready' : 'needs-consent', { runId: result.run.runId,
          events: executionEvents(viewState), authorization: authorization, error: error,
          draft: appDraft && appDraft.draft || null, previewSrcdoc: appDraft && appDraft.previewSrcdoc || '',
          appInstalled: appDraft && appDraft.installed === true, history: sessionHistory });
        if ((appBuilder || coding) && hasConsent && result.run.status === 'queued') {
          root.setTimeout(function () { runP1Session(sessionId, coding && taskState ? taskState.taskPrompt : ''); }, 0);
        }
      }
    }).catch(function () { sendP1(sessionId, 'error', { error: 'Home Node Session binding read failed.' }); });
  }
  function bindP1Session(sessionId, forceActive) {
    if (forceActive === true) activeP1SessionId = sessionId;
    if ((activeP1SessionId !== sessionId && forceActive !== true)
      || !workRunRemote || typeof workRunRemote.bindDshSession !== 'function' || !workModeUi) return Promise.resolve(false);
    var current = workModeUi.getState();
    if (!current.run || current.run.status !== 'queued' || current.executor !== 'dsh') {
      sendP1(sessionId, 'needs-run', { error: '请在当前工作台创建或选择一条待授权 Run。' });
      return Promise.resolve(false);
    }
    return Promise.resolve(workRunRemote.bindDshSession(current.run.runId, {
      sessionId: sessionId, consentId: current.consentId || '', expectedVersion: current.run.version
    })).then(function (binding) {
      if (!binding || binding.ok !== true) throw new Error(String(binding && binding.error || 'dsh-session-bind-failed'));
      var local = workModeUi.bindDshSession(sessionId);
      if (!local || local.ok !== true) throw new Error(String(local && local.error || 'dsh-session-bind-failed'));
      lastP1StatusReadAt = 0;
      restoreP1Session(sessionId);
      return true;
    }).catch(function (error) {
      sendP1(sessionId, 'error', { error: String(error.message || 'dsh-session-bind-failed') });
      return false;
    });
  }
  function setP1MemorySelection(sessionId, data) {
    if (activeP1SessionId !== sessionId || !workModeUi || !data || typeof workModeUi.setMemorySelection !== 'function') return;
    var current = workModeUi.getState();
    if (!current.run || current.run.runId !== String(data.runId || '') || current.run.status !== 'queued'
      || current.executor !== 'dsh' || current.dshSessionId !== sessionId) {
      sendP1(sessionId, 'error', { error: 'Run or Session changed; Memory Recall selection was not applied.' });
      return;
    }
    var memoryIds = Array.isArray(data.memoryIds) ? data.memoryIds.map(String).sort() : [];
    if (memoryIds.length > 12 || memoryIds.some(function (id, index) {
      return !/^am_[A-Za-z0-9-]{36}$/.test(id) || (index > 0 && id === memoryIds[index - 1]);
    })) {
      sendP1(sessionId, 'error', { error: 'Invalid project Agent Memory Recall selection.' });
      return;
    }
    Promise.resolve(workModeUi.setMemorySelection(memoryIds)).then(function (result) {
      if (!result || result.ok !== true) throw new Error(String(result && result.error || 'memory-selection-failed'));
      lastP1StatusReadAt = 0;
      restoreP1Session(sessionId);
    }).catch(function (error) { sendP1(sessionId, 'error', { error: String(error.message || 'memory-selection-failed') }); });
  }
  function runP1Session(sessionId, taskPrompt) {
    if (activeP1Operation || activeP1SessionId !== sessionId) {
      sendP1(sessionId, 'error', { error: '当前已有 Home Node DSH Run 执行，或 Session 未选中。' });
      return;
    }
    var current = workModeUi && workModeUi.getState();
    if (!current || !current.run || current.executor !== 'dsh' || current.run.status !== 'queued'
      || !current.dshSessionId || current.dshSessionId !== sessionId
      || !current.consentId || !current.consent || current.consent.status !== 'active') {
      sendP1(sessionId, 'needs-consent', { error: '需要一条已绑定、已授权且未启动的 DSH Run。' });
      return;
    }
    sendP1(sessionId, 'running', { runId: current.run.runId, events: executionEvents(current), ...traceRouteFields(current.run) });
    var timer = root.setInterval(function () {
      if (activeP1SessionId !== sessionId) return;
      var latest = workModeUi.getState();
      sendP1(sessionId, 'running', { runId: current.run.runId, events: executionEvents(latest), ...traceRouteFields(latest.run || current.run) });
    }, 650);
    taskPrompt = typeof taskPrompt === 'string' ? taskPrompt : '';
    activeP1Operation = Promise.resolve(workModeUi.start({ taskPrompt: taskPrompt })).then(async function (result) {
      var latest = workModeUi.getState();
      if (result && result.ok === true && workModeRuntime && typeof workModeRuntime.getResult === 'function') {
        var saved = await workModeRuntime.getResult(current.run.runId);
        var persistedResult = persistedP1Result(saved);
        var artifact = current.run.workflowId === 'app.builder' ? await appDraftArtifact(current.run, current.run.runId) : null;
        var sessionSnapshot = null;
        try { sessionSnapshot = await workRunRemote.getDshSession(sessionId); } catch (_) {}
        var history = sessionSnapshot && sessionSnapshot.ok === true ? await p1SessionHistory(sessionSnapshot) : [];
        var drafts = current.run.workflowId === 'app.builder' ? await listP1AppDrafts(current.run.projectRef) : [];
        sendP1(sessionId, persistedResult ? 'completed' : 'error', { runId: current.run.runId,
          result: persistedResult, events: executionEvents(latest), draft: artifact && artifact.draft || null,
          previewSrcdoc: artifact && artifact.previewSrcdoc || '', appInstalled: artifact && artifact.installed === true,
          history: history, drafts: drafts, ...traceRouteFields(latest.run || current.run),
          traceSummary: persistedResult && persistedResult.report.summary || '',
          error: persistedResult ? '' : 'Home Node Result could not be read.' });
        sendExecutorState(sessionId, '');
      } else {
        var cancellation = ['cancelled', 'execution-cancelled'].indexOf(String(result && result.error || '')) >= 0
          || !!(latest.run && ['cancelled', 'cancel_requested'].indexOf(latest.run.status) >= 0);
        var terminalArtifact = current.run.workflowId === 'app.builder' ? await appDraftArtifact(current.run, current.run.runId) : null;
        var terminalSession = null;
        try { terminalSession = await workRunRemote.getDshSession(sessionId); } catch (_) {}
        var terminalHistory = terminalSession && terminalSession.ok === true ? await p1SessionHistory(terminalSession) : [];
        var terminalDrafts = current.run.workflowId === 'app.builder' ? await listP1AppDrafts(current.run.projectRef) : [];
        sendP1(sessionId, cancellation ? 'cancelled' : 'failed', {
          runId: current.run.runId, events: executionEvents(latest), draft: terminalArtifact && terminalArtifact.draft || null,
          previewSrcdoc: terminalArtifact && terminalArtifact.previewSrcdoc || '', appInstalled: terminalArtifact && terminalArtifact.installed === true,
          history: terminalHistory, drafts: terminalDrafts, ...traceRouteFields(latest.run || current.run),
          error: cancellation ? '' : String(result && result.error || 'Home Node Run failed.') });
        sendExecutorState(sessionId, '');
      }
    }).catch(function () { sendP1(sessionId, 'failed', Object.assign({ runId: current.run.runId, error: 'Home Node Run failed.' }, traceRouteFields(current.run))); })
      .finally(function () { root.clearInterval(timer); activeP1Operation = null; lastP1StatusReadAt = 0; restoreP1Session(sessionId); });
  }
  function grantP1Consent(sessionId, data) {
    if (activeP1SessionId !== sessionId || !workModeUi || !workRunRemote || !data
      || data.ackEgress !== true || data.ackStorage !== true || data.expiresInMs !== 900000) return;
    Promise.resolve((async function () {
      var state = workModeUi.getState();
      if (!state.run || state.run.runId !== data.runId || state.run.status !== 'queued'
        || state.executor !== 'dsh' || state.dshSessionId !== sessionId) throw new Error('Run or Session changed.');
      var preview = await workModeUi.previewAuthorization();
      state = workModeUi.getState();
      var files = Array.isArray(data.fileIds) ? data.fileIds.map(String).slice().sort() : [];
      var memoryIds = Array.isArray(data.memoryIds) ? data.memoryIds.map(String).slice().sort() : [];
      if (!preview || preview.ok !== true || String(state.previewKey || '') !== String(data.previewKey || '')
        || JSON.stringify(state.fileIds.slice().sort()) !== JSON.stringify(files)
        || JSON.stringify(state.memorySelectedIds.slice().sort()) !== JSON.stringify(memoryIds)) {
        lastP1StatusReadAt = 0;
        restoreP1Session(sessionId);
        return;
      }
      if (memoryIds.length && (data.ackMemory !== true || data.ackMemoryReview !== true || data.ackMemoryResult !== true)) {
        throw new Error('Project Agent Memory, Review egress and memory-derived Result require separate confirmation.');
      }
      if (memoryIds.length) {
        var memory = await workModeUi.confirmMemoryScope(true);
        if (!memory || memory.ok !== true) throw new Error(String(memory && memory.error || 'Agent Memory Recall confirmation failed.'));
      }
      var codingRun = state.run.workflowId === 'coding.workspace';
      if (codingRun && data.ackWorkspaceWrite !== true) throw new Error('Coding Workspace 写入需要单独确认。');
      if (codingRun) {
        var writeConsent = await workModeUi.confirmWorkspaceWrite(true);
        if (!writeConsent || writeConsent.ok !== true) throw new Error('Coding Workspace 写入确认失败。');
        state = workModeUi.getState();
      }
      var storage = await workModeUi.confirmStorageRisk(true);
      if (!storage || storage.ok !== true) throw new Error('Result storage confirmation failed.');
      if (memoryIds.length) {
        var reviewMemory = await workModeUi.confirmMemoryDerivedConsent('review', true);
        if (!reviewMemory || reviewMemory.ok !== true) throw new Error(String(reviewMemory && reviewMemory.error || 'Memory-derived Review confirmation failed.'));
        var resultMemory = await workModeUi.confirmMemoryDerivedConsent('result', true);
        if (!resultMemory || resultMemory.ok !== true) throw new Error(String(resultMemory && resultMemory.error || 'Memory-derived Result confirmation failed.'));
      }
      var egress = workModeUi.confirmScope(true);
      if (!egress || egress.ok !== true) throw new Error('Project/file Consent check failed.');
      var grant = await workModeUi.grant(data.expiresInMs, true);
      if (!grant || grant.ok !== true || !grant.consent) throw new Error(String(grant && grant.error || 'Consent grant failed.'));
      var link = await workRunRemote.bindDshSession(state.run.runId, {
        sessionId: sessionId, consentId: grant.consent.consentId, expectedVersion: state.run.version
      });
      if (!link || link.ok !== true) throw new Error(String(link && link.error || 'Session/Consent binding failed.'));
      lastP1StatusReadAt = 0;
      // The DSH-native permission dialog is the user's confirmation/start
      // action. Home Node grants and binds Consent first; only then may its
      // authoritative Run transition to running.
      var prompt = String(data.taskPrompt || (p1TaskPrompts[sessionId] && p1TaskPrompts[sessionId].taskPrompt) || '');
      if (codingRun && (!prompt || prompt.length > 2400)) throw new Error('Coding task prompt unavailable; the Run was not started.');
      runP1Session(sessionId, prompt);
    })()).catch(function (error) {
      sendP1(sessionId, 'needs-consent', { error: String(error.message || 'Consent grant failed.') });
    });
  }
  function cancelP1Session(sessionId) {
    if (!workModeUi || activeP1SessionId !== sessionId) return;
    var current = workModeUi.getState();
    if (!current.run || current.dshSessionId !== sessionId) return;
    Promise.resolve(workModeUi.cancel(current.run.runId)).then(function (result) {
      if (!result || result.ok !== true) sendP1(sessionId, 'error', { error: String(result && result.error || 'Run cancel failed.') });
      var latest = workModeUi.getState();
      var cancelledRun = result && result.run || latest && latest.run;
      if (current.run.workflowId === 'app.builder' && cancelledRun && cancelledRun.status === 'cancelled'
        && workRunRemote && typeof workRunRemote.finishAppDraftRun === 'function') {
        return workRunRemote.finishAppDraftRun(current.run.runId, {
          draftRef: current.run.appDraftRef, projectRef: current.run.projectRef, status: 'cancelled'
        }).then(function (finished) {
          if (!finished || finished.ok !== true) sendP1(sessionId, 'error', {
            error: String(finished && finished.error || 'App Draft cancellation cleanup failed.')
          });
          lastP1StatusReadAt = 0;
          restoreP1Session(sessionId);
        });
      }
      return undefined;
    }).catch(function () { sendP1(sessionId, 'error', { error: 'Run cancel failed.' }); });
  }
  function select(dsh, deferConnect) {
    candidate.hidden = !dsh;
    nativeWork.classList.toggle('wm-native-mounted', dsh);
    page.classList.toggle('wm-native-selected', dsh);
    advanced.open = !dsh;
    advanced.classList.toggle('wm-native-advanced--full', !dsh);
    root.document.getElementById('wm-use-dsh').setAttribute('aria-pressed', String(dsh));
    root.document.getElementById('wm-use-native').setAttribute('aria-pressed', String(!dsh));
    if (dsh && !deferConnect) { if (!url) void connect(false); else sendTheme(); }
  }
  function handleAppStorageRequest(sessionId, data) {
    var current = workModeUi && workModeUi.getState();
    var core = root.IBAppBuilderCore;
    if (!current || !current.run || current.executor !== 'dsh' || current.run.workflowId !== 'app.builder'
      || current.dshSessionId !== sessionId || current.run.appDraftRef !== String(data.draftRef || '')
      || !core || typeof core.appIdForDraft !== 'function') return;
    var key = String(data.key || ''), action = String(data.action || ''), appId = core.appIdForDraft(current.run.appDraftRef);
    var response = { type: 'ib-dsh-app-storage-response', sessionId: sessionId, draftRef: current.run.appDraftRef,
      requestId: String(data.requestId || ''), ok: false };
    try {
      if (!appId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key) || !['get', 'set', 'remove'].includes(action)) throw new Error('storage-scope-denied');
      var storageKey = 'ib_app_' + appId + '_' + key;
      if (action === 'get') {
        var raw = root.localStorage.getItem(storageKey);
        response.value = raw == null ? null : JSON.parse(raw);
      } else if (action === 'remove') root.localStorage.removeItem(storageKey);
      else {
        var serialized = JSON.stringify(data.value);
        if (serialized === undefined || serialized.length > 32768) throw new Error('storage-value-denied');
        root.localStorage.setItem(storageKey, serialized);
      }
      response.ok = true;
    } catch (error) { response.error = String(error && error.message || 'storage-operation-denied').slice(0, 48); }
    try { frame.contentWindow.postMessage(response, frameOrigin); } catch (_) {}
  }
  async function confirmAppInstall(sessionId, data) {
    var current = workModeUi && workModeUi.getState();
    var draftRef = String(data.draftRef || '');
    if (activeP1SessionId !== sessionId || data.confirmed !== true || !current || !current.run
      || ['completed', 'failed', 'cancelled'].indexOf(current.run.status) < 0 || current.run.workflowId !== 'app.builder'
      || current.run.appDraftRef !== draftRef || !workRunRemote || typeof workRunRemote.getAppDraft !== 'function'
      || !root.IB.apps || typeof root.IB.apps.installGeneratedApp !== 'function') {
      sendP1(sessionId, 'completed', { installError: '当前 Result/Draft 不匹配；未安装。' }); return;
    }
    var result;
    try { result = await workRunRemote.getAppDraft(draftRef, current.run.projectRef, current.run.runId); } catch (_) { result = null; }
    var draft = result && result.ok === true ? result.draft : null;
    if (!draft || Number(draft.version) !== Number(data.version) || !root.IBAppBuilderCore.validFiles(draft.files)) {
      sendP1(sessionId, 'completed', { installError: '草稿版本已变化或内容不完整；请刷新后重新检查。' }); return;
    }
    var installed = root.IB.apps.installGeneratedApp(draft, { confirmed: true });
    if (!installed || installed.ok !== true) {
      sendP1(sessionId, 'completed', { installError: String(installed && installed.error || 'App Store 安装失败。') }); return;
    }
    try { if (typeof root.renderAppStore === 'function') root.renderAppStore(); } catch (_) {}
    try { if (typeof root.navTo === 'function') root.navTo('apps'); } catch (_) {}
    try { frame.contentWindow.postMessage({ type: 'ib-dsh-app-install-state', sessionId: sessionId, draftRef: draftRef,
      installed: true, appId: installed.appId, version: installed.version }, frameOrigin); } catch (_) {}
  }
  async function restoreAppDraftVersion(sessionId, data) {
    var current = workModeUi && workModeUi.getState();
    var draftRef = String(data.draftRef || ''), version = Number(data.version);
    var invalid = activeP1SessionId !== sessionId ? 'session-inactive'
      : data.confirmed !== true ? 'confirmation-required'
        : !current || !current.run ? 'run-unavailable'
          : ['completed', 'failed', 'cancelled'].indexOf(current.run.status) < 0 ? 'run-not-terminal'
            : current.run.workflowId !== 'app.builder' ? 'workflow-mismatch'
              : current.run.appDraftRef !== draftRef ? 'draft-mismatch'
                : !Number.isSafeInteger(version) || version < 0 ? 'version-invalid'
                  : !workRunRemote || typeof workRunRemote.restoreAppDraftVersion !== 'function' ? 'restore-api-unavailable' : '';
    if (invalid) {
      try { frame.contentWindow.postMessage({ type: 'ib-dsh-app-restore-state', sessionId: sessionId,
        error: '当前 Run 或草稿不匹配；未恢复版本。(' + invalid + ')' }, frameOrigin); } catch (_) {}
      return;
    }
    var result;
    try { result = await workRunRemote.restoreAppDraftVersion(draftRef, current.run.projectRef, version); }
    catch (_) { result = null; }
    if (!result || result.ok !== true || !result.draft) {
      try { frame.contentWindow.postMessage({ type: 'ib-dsh-app-restore-state', sessionId: sessionId,
        error: String(result && result.error || '草稿版本恢复失败。') }, frameOrigin); } catch (_) {}
      return;
    }
    lastP1StatusReadAt = 0;
    restoreP1Session(sessionId);
  }
  root.document.getElementById('wm-use-dsh').addEventListener('click', function () { select(true); });
  root.document.getElementById('wm-use-native').addEventListener('click', function () { select(false); });
  runtimeManageButton.addEventListener('click', showRuntimeManager);
  runtimeDiscoverButton.addEventListener('click', function () { void discoverRuntimeReleases(); });
  runtimeOnlineInstallButton.addEventListener('click', function () { void installOnlineRuntime(); });
  runtimeCancelButton.addEventListener('click', function () { void cancelOnlineRuntimeInstall(); });
  runtimeBackButton.addEventListener('click', returnToDshWork);
  installButton.addEventListener('click', function () { installInput.click(); });
  installInput.addEventListener('change', function () {
    var file = installInput.files && installInput.files[0];
    if (file) void uploadRuntimeZip(file);
    installInput.value = '';
  });
  reloadButton.addEventListener('click', function () {
    select(true, true);
    void connect(true);
  });
  function receiveMessage(event) {
    if (event.origin !== frameOrigin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === 'ib-dsh-p0-ready') sendTheme();
    if (event.data.type === 'ib-dsh-p0-theme-applied') lastTheme = event.data.theme;
    var data = event.data;
    if (data.type === 'ib-dsh-p1-session-open' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) {
      restoreP1Session(data.sessionId, data.taskPrompt);
      sendExecutorState(data.sessionId, '');
      if (nativePresetBySession[data.sessionId]) applyNativePresetState(data.sessionId, nativePresetBySession[data.sessionId]);
    }
    if (data.type === 'ib-dsh-p1-session-status' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) {
      restoreP1Session(data.sessionId);
    }
    if (data.type === 'ib-dsh-p1-bind' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) bindP1Session(data.sessionId);
    if (data.type === 'ib-dsh-p2-memory-selection' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) setP1MemorySelection(data.sessionId, data);
    if (data.type === 'ib-dsh-p1-consent' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) grantP1Consent(data.sessionId, data);
    if (data.type === 'ib-dsh-p1-execute' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) runP1Session(data.sessionId);
    if (data.type === 'ib-dsh-p1-cancel' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) cancelP1Session(data.sessionId);
    if (data.type === 'ib-dsh-p3-agent-preset-state' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) applyNativePresetState(data.sessionId, data);
    if (data.type === 'ib-dsh-p3-catalog-request' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) sendExecutorState(data.sessionId, '');
    if (data.type === 'ib-dsh-p3-executor-selection' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) applyExecutorSelection(data.sessionId, data);
    if (data.type === 'ib-dsh-p3-create-run' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) createDshRun(data.sessionId, data);
    if (data.type === 'ib-dsh-p3-task-appended' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))
      && p1TaskPrompts[data.sessionId] && p1TaskPrompts[data.sessionId].runId === String(data.runId || '')) restoreP1Session(data.sessionId);
    if (data.type === 'ib-dsh-app-storage-request' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) handleAppStorageRequest(data.sessionId, data);
    if (data.type === 'ib-dsh-app-export-request' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) void exportP1AppDraftVersion(data.sessionId, data);
    if (data.type === 'ib-dsh-app-install-confirm' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) void confirmAppInstall(data.sessionId, data);
    if (data.type === 'ib-dsh-app-version-restore-confirm' && /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(data.sessionId || ''))) void restoreAppDraftVersion(data.sessionId, data);
  }
  root.addEventListener('message', receiveMessage);
  frame.addEventListener('load', sendTheme);
  var observer = new MutationObserver(sendTheme);
  observer.observe(root.document.body, { attributes: true, attributeFilter: ['class'] });
  var routeObserver = null;
  root.addEventListener('pagehide', function () {
    observer.disconnect();
    if (routeObserver) routeObserver.disconnect();
  }, { once: true });
  root.IB = root.IB || {};
  root.IB.workMode = root.IB.workMode || {};
  root.IB.workMode.nativeCandidate = {
    select: select, refresh: function () { return connect(true); }, appliedTheme: function () { return lastTheme; },
    dispose: function () {
      observer.disconnect(); if (routeObserver) routeObserver.disconnect(); root.removeEventListener('message', receiveMessage);
      Array.prototype.slice.call(advanced.children).forEach(function (child) {
        if (child.tagName !== 'SUMMARY') nativeWork.appendChild(child);
      });
      advanced.remove();
      nativeWork.classList.remove('wm-native-mounted'); page.classList.remove('wm-native-selected');
      toolbar.remove(); candidate.remove();
    }
  };
  if (productionTauri) {
    select(false);
    var workPageWasActive = false;
    var activateWorkPage = function () {
      var active = page.classList.contains('active');
      if (active && !workPageWasActive) select(true);
      workPageWasActive = active;
    };
    routeObserver = new MutationObserver(activateWorkPage);
    routeObserver.observe(root.document.body, { subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden'] });
    activateWorkPage();
  } else {
    select(true);
  }
})(typeof window !== 'undefined' ? window : globalThis);
