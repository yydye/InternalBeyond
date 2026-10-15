(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document || !root.IB) return;
  root.IB.workMode = root.IB.workMode || {};
  root.IB.workMode.createConsentUi = api.createController;
  var runtime = root.IB.workMode.runtime;
  var homeNode = root.IB.homeNode && root.IB.homeNode.workRuns;
  var agentMemory = root.IB.homeNode && root.IB.homeNode.agentMemory;
  var workspace = root.IB.workspace && root.IB.workspace.files;
  var core = root.IBWorkModeConsentCore || null;
  var controller = api.createController({
    runtime: runtime,
    homeNode: homeNode,
    agentMemory: agentMemory,
    memoryRecall: root.IB.workMode.memoryRecall,
    workspace: workspace,
    projectDraft: root.IB.workMode.projectDraft,
    requireFileSelection: true,
    requestProjectName: function (suggestedName) {
      if (typeof root.prompt !== 'function') return suggestedName;
      return root.prompt('为明确选择的文件创建 Workspace 项目名称：', suggestedName);
    },
    consentCore: core,
    requestId: function () {
      if (!root.crypto || typeof root.crypto.randomUUID !== 'function') throw new Error('secure-random-unavailable');
      return 'work-ui-' + root.crypto.randomUUID();
    },
    now: function () { return Date.now(); },
    onChange: function () { render(); }
  });
  root.IB.workMode.ui = controller;

  function byId(id) { return root.document.getElementById(id); }
  function syncWorkRouteChrome() {
    if (!root.document || !root.document.body) return;
    root.document.body.classList.toggle('wm-work-mode-active', !!(root.location && root.location.hash === '#work-mode'));
  }
  function setText(id, value) {
    var node = byId(id);
    if (node) node.textContent = String(value == null ? '' : value);
  }
  function appendText(parent, tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value == null ? '' : value);
    parent.appendChild(node);
    return node;
  }
  function resetChildren(node) { if (node) node.replaceChildren(); }
  function formatDate(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return new Date(Number(value)).toLocaleString();
  }
  function formatSize(value) {
    var bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function option(select, value, label) {
    var item = root.document.createElement('option');
    item.value = String(value);
    item.textContent = String(label);
    select.appendChild(item);
  }
  async function refreshAgentProfileOptions(profileSelect) {
    if (!profileSelect) return;
    if (typeof root.loadApiConfigs === 'function') {
      try { await root.loadApiConfigs(); } catch (_) {}
    }
    var selected = String(controller.getState().profileRef || profileSelect.value || '');
    resetChildren(profileSelect);
    option(profileSelect, '', '选择 Agent Provider Profile');
    var profiles = Array.isArray(root.apiConfigs) ? root.apiConfigs.filter(function (profile) {
      return profile && !profile.archived && profile.id && profile.credentialRef;
    }) : [];
    profiles.forEach(function (profile) {
      option(profileSelect, profile.id, (profile.name || profile.label || profile.id) + ' · ' + profile.provider + ' / ' + profile.model);
    });
    if (selected && profiles.some(function (profile) { return String(profile.id) === selected; })) {
      profileSelect.value = selected;
    }
  }
  function renderProviders(state) {
    var list = byId('wm-provider-targets');
    if (!list) return;
    resetChildren(list);
    var preview = state.preview;
    (preview && Array.isArray(preview.providers) ? preview.providers : []).forEach(function (provider) {
      var item = root.document.createElement('li');
      var title = provider.destination === 'middle_brain' ? 'Middle Brain' : 'Agent';
      appendText(item, 'strong', '', title);
      appendText(item, 'span', '', provider.provider + ' / ' + provider.model + ' · ' + provider.providerRef);
      appendText(item, 'code', '', provider.endpointLabel || 'Endpoint unavailable');
      list.appendChild(item);
    });
  }
  function renderFiles(state) {
    var list = byId('wm-file-list');
    if (!list) return;
    resetChildren(list);
    var preview = state.preview || state.projectSnapshot;
    var files = preview && Array.isArray(preview.files) ? preview.files : [];
    var fileStatus = byId('wm-project-file-status');
    var importFiles = byId('wm-import-files');
    var importFolder = byId('wm-import-folder');
    if (importFiles) importFiles.disabled = state.busy !== ''
      || !!state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0;
    if (importFolder) importFolder.disabled = state.busy !== ''
      || !!state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0;
    var projectSelect = byId('wm-project-select');
    var workspaceIsEmpty = !!(projectSelect && projectSelect.options.length === 1
      && /没有可选择的本地项目/.test(projectSelect.options[0].textContent || ''));
    if (fileStatus) {
      var projectPath = state.projectSnapshot && state.projectSnapshot.projectPath || '';
      var projectName = state.projectSnapshot && state.projectSnapshot.projectName || '';
      var projectLabel = state.selectedProjectRef
        ? '项目：' + (projectName || state.selectedProjectRef) + ' · ID：' + state.selectedProjectRef + ' · ' : '';
      var pathLabel = projectPath ? '路径：' + projectPath : (state.selectedProjectRef ? '路径未记录 · ' : '');
      if (!state.selectedProjectRef) fileStatus.textContent = workspaceIsEmpty
        ? 'Workspace 当前没有项目记录。明确选择一个项目文件夹可创建本地项目；绝对路径不会由浏览器猜测。'
        : '先选择一个 Workspace 项目；文件只会从你明确选择的文件或文件夹接入。';
      else if (state.projectSnapshotError) fileStatus.textContent = projectLabel + statusMessage(state.projectSnapshotError) + pathLabel;
      else if (!state.projectSnapshot) fileStatus.textContent = projectLabel + '正在读取 Workspace 文件索引… ' + pathLabel;
      else if (!files.length) fileStatus.textContent = projectLabel + pathLabel
        + '项目中没有可授权的文本文件。可明确选择文件或项目文件夹接入。';
      else fileStatus.textContent = projectLabel + pathLabel + '发现 ' + files.length
        + ' 个可预览文件；已选 ' + state.fileIds.length + ' 个，默认不授权。';
    }
    if (!files.length) {
      var emptyText = state.projectSnapshotError ? statusMessage(state.projectSnapshotError)
        : (!state.selectedProjectRef && workspaceIsEmpty
          ? '还没有 Workspace 项目。选择文件夹可按目录名创建项目并接入已选文本文件。'
          : (state.selectedProjectRef ? (state.projectSnapshot
          ? '当前项目暂无可授权文件；受限路径、敏感文件、非文本文件和超过单文件上限的文件不会纳入。'
          : '正在读取当前项目的文件索引。') : '选择项目后，这里会显示其 Workspace 文件。'));
      appendText(list, 'li', 'wm-file-empty', emptyText);
      return;
    }
    files.forEach(function (file) {
      var item = root.document.createElement('li');
      var label = root.document.createElement('label');
      var checkbox = root.document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.fileIds.indexOf(file.fileId) >= 0;
      checkbox.disabled = state.busy === 'granting' || state.busy === 'starting' || state.busy === 'importing';
      checkbox.addEventListener('change', function () {
        var next = state.fileIds.slice();
        if (checkbox.checked && next.indexOf(file.fileId) < 0) next.push(file.fileId);
        if (!checkbox.checked) next = next.filter(function (id) { return id !== file.fileId; });
        controller.setFileIds(next).then(render);
      });
      label.appendChild(checkbox);
      var detail = root.document.createElement('span');
      appendText(detail, 'span', 'wm-file-path', file.path);
      appendText(detail, 'span', 'wm-file-size', formatSize(file.size));
      label.appendChild(detail);
      item.appendChild(label);
      list.appendChild(item);
    });
  }
  function renderPermissionSummary(state) {
    var providers = byId('wm-permission-providers');
    var files = byId('wm-permission-files');
    if (!providers || !files) return;
    resetChildren(providers);
    resetChildren(files);
    var revision = state.dshStatus && state.dshStatus.dshRevision;
    setText('wm-permission-engine', state.executor === 'dsh'
      ? '执行器 · DSH' + (revision ? ' · ' + String(revision).slice(0, 7) : '')
        + (state.run && state.run.workflowId === 'coding.workspace' ? ' · Coding' : ' · 只读')
      : '执行器 · Native Work Runtime');
    var routeList = state.preview && Array.isArray(state.preview.providers) ? state.preview.providers : [];
    if (!routeList.length) appendText(providers, 'li', '', 'Provider · 选择配置后本地核对');
    routeList.forEach(function (route) {
      var role = route.destination === 'middle_brain' ? 'Review' : 'Agent';
      appendText(providers, 'li', '', role + ' · ' + String(route.provider || '') + ' / ' + String(route.model || ''));
    });
    var snapshot = state.preview || state.projectSnapshot;
    var available = snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
    var chosen = state.fileIds.map(function (fileId) {
      return available.find(function (file) { return file.fileId === fileId; }) || null;
    }).filter(Boolean);
    var projectName = state.projectSnapshot && state.projectSnapshot.projectName
      || state.run && state.run.projectRef || state.selectedProjectRef || '尚未选择';
    setText('wm-permission-project', '项目与文件 · ' + projectName + ' · 已选 ' + chosen.length + ' 项');
    if (!chosen.length) appendText(files, 'li', '', '尚未选择文件');
    chosen.forEach(function (file) {
      appendText(files, 'li', '', String(file.path || file.fileId) + ' · ' + formatSize(file.size)
        + (state.run && state.run.workflowId === 'coding.workspace' ? ' · 可修改' : ''));
    });
    if (state.run && state.run.workflowId === 'coding.workspace') {
      appendText(files, 'li', '', '新建文件限于以上文件所在目录；不开放 Shell、网络或任意路径。');
    }
    var retentionMs = Number(state.preview && state.preview.terms && state.preview.terms.resultRetentionMs)
      || 90 * 24 * 60 * 60 * 1000;
    setText('wm-permission-result', 'Result 保存 · Home Node SQLite 明文，最多 '
      + Math.floor(retentionMs / (24 * 60 * 60 * 1000)) + ' 天');
  }
  function memoryRecordText(record) {
    var payload = record && record.payload || {};
    if (typeof payload.statement === 'string') return payload.statement;
    if (typeof payload.summary === 'string' && typeof payload.name === 'string') return payload.name + '\n' + payload.summary;
    if (typeof payload.name === 'string') return payload.name + (Array.isArray(payload.steps) ? '\n' + payload.steps.join('\n') : '');
    return '';
  }
  function renderMemoryRecall(state) {
    var list = byId('wm-memory-records');
    if (!list) return;
    resetChildren(list);
    var recall = state.memoryRecall || { ok: false, records: [] };
    (Array.isArray(recall.records) ? recall.records : []).forEach(function (record) {
      var item = root.document.createElement('li');
      var label = root.document.createElement('label');
      var checkbox = root.document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.memorySelectedIds.indexOf(record.memoryId) >= 0;
      checkbox.disabled = !state.preview || state.busy === 'granting' || state.busy === 'starting'
        || state.memoryRecallBusy !== '';
      checkbox.addEventListener('change', function () {
        var next = state.memorySelectedIds.slice();
        if (checkbox.checked && next.indexOf(record.memoryId) < 0) next.push(record.memoryId);
        if (!checkbox.checked) next = next.filter(function (id) { return id !== record.memoryId; });
        controller.setMemorySelection(next).then(render);
      });
      label.appendChild(checkbox);
      var detail = root.document.createElement('span');
      appendText(detail, 'strong', '', record.type + ' · r' + record.revision);
      appendText(detail, 'span', 'wm-memory-record-content', memoryRecordText(record));
      (record.provenance || []).forEach(function (source) {
        var sourceText = source.sourceKind + (source.sourceRef ? ' · ' + source.sourceRef : '')
          + (source.sourceRevision ? ' · r' + source.sourceRevision : '');
        appendText(detail, 'span', 'wm-memory-source', sourceText);
      });
      label.appendChild(detail);
      item.appendChild(label);
      list.appendChild(item);
    });
    setText('wm-memory-count', recall.ok === true
      ? String(recall.records.length) + (recall.hasMore ? '+ active' : ' active')
      : (recall.error === 'agent-memory-query-failed' ? '读取失败' : '暂不可用'));
    setText('wm-memory-status', recall.ok === true
      ? (recall.records.length ? '以下内容来自当前项目的有效 Agent Memory，仅在本机预览。' : '当前项目没有可用于 Recall 的有效记忆。')
      : (recall.error === 'project-access-denied' ? '项目不在当前 Workspace 权限范围内。' : '本地 Recall 不可用；不会降级到其他项目或 Chat Memory。'));
    var snapshot = state.memorySnapshot;
    setText('wm-memory-context-size', '上下文：' + (snapshot ? snapshot.recordCount : 0) + ' 条 · '
      + (snapshot ? snapshot.contextChars : 0) + ' 字符 / ' + (root.IB.workMode.memoryRecall.MAX_CONTEXT_CHARS || 6000));
    var selected = !!(snapshot && snapshot.ok && snapshot.recordCount);
    var confirmationLabel = byId('wm-memory-consent-label');
    var confirmation = byId('wm-memory-consent-check');
    var confirmationText = byId('wm-memory-consent-text');
    if (confirmationLabel) confirmationLabel.hidden = !selected;
    if (confirmation) {
      confirmation.checked = state.memoryConfirmed === true;
      confirmation.disabled = !selected || !state.preview || state.memoryRecallBusy !== ''
        || state.busy === 'granting' || state.busy === 'starting';
    }
    if (confirmationText && selected) {
      var agent = state.preview && state.preview.providers && state.preview.providers.find(function (item) {
        return item.destination === 'agent';
      });
      confirmationText.textContent = '我明确授权将上述 ' + snapshot.recordCount + ' 条记忆（摘要 ' + snapshot.contextChars
        + ' 字符，SHA-256 ' + snapshot.contextHash.slice(0, 12) + '…）发送给 Agent Provider '
        + (agent ? agent.provider + ' / ' + agent.model + ' (' + agent.providerRef + ')' : '当前路由')
        + '。记忆可能影响整份报告草稿；下方会分别询问 Review 外发与 Result 明文持久化授权。';
    }
  }
  function renderMemoryDerivedConsent(state) {
    var identity = controller.memoryDerivedIdentity
      ? controller.memoryDerivedIdentity(state.preview, state.memorySnapshot) : null;
    var selected = !!identity;
    var reviewLabel = byId('wm-derived-review-label');
    var reviewCheck = byId('wm-derived-review-check');
    var reviewText = byId('wm-derived-review-text');
    var resultLabel = byId('wm-derived-result-label');
    var resultCheck = byId('wm-derived-result-check');
    var resultText = byId('wm-derived-result-text');
    if (reviewLabel) reviewLabel.hidden = !selected;
    if (resultLabel) resultLabel.hidden = !selected;
    if (reviewCheck) {
      var reviewKey = controller.memoryDerivedConfirmationKey('review', state.preview, state.memorySnapshot);
      reviewCheck.checked = state.memoryDerivedReviewConfirmed === true && state.memoryDerivedReviewKey === reviewKey;
      reviewCheck.disabled = !selected || state.busy === 'granting' || state.busy === 'starting';
    }
    if (resultCheck) {
      var resultKey = controller.memoryDerivedConfirmationKey('result', state.preview, state.memorySnapshot);
      resultCheck.checked = state.memoryDerivedResultConfirmed === true && state.memoryDerivedResultKey === resultKey;
      resultCheck.disabled = !selected || !state.storageRiskAccepted || state.busy === 'granting' || state.busy === 'starting';
    }
    if (selected && reviewText) {
      var middle = (state.preview.providers || []).find(function (item) { return item.destination === 'middle_brain'; });
      reviewText.textContent = '我单独授权将可能包含所选 Agent Memory 内容或推断的完整报告草稿发送给 Middle Brain Review Provider '
        + (middle ? middle.provider + ' / ' + middle.model + ' (' + middle.providerRef + ')' : '当前 Review 路由') + '。';
    }
    if (selected && resultText) {
      var days = Math.floor(identity.result.retentionMs / (24 * 60 * 60 * 1000));
      resultText.textContent = '我单独授权将整份 memory-derived 报告以明文保存到 Work Result（Home Node SQLite，最多 ' + days
        + ' 天）；逻辑删除可能仍留有 WAL、旧数据库页或备份残留。';
    }
  }
  function renderActiveRuns(state) {
    var list = byId('wm-active-runs');
    if (!list) return;
    resetChildren(list);
    setText('wm-active-count', String(state.activeRuns.length));
    state.activeRuns.forEach(function (run) {
      var item = root.document.createElement('li');
      var select = root.document.createElement('button');
      select.type = 'button';
      select.className = 'wm-task-open';
      select.setAttribute('aria-current', state.run && state.run.runId === run.runId ? 'true' : 'false');
      appendText(select, 'strong', '', run.projectRef);
      appendText(select, 'span', '', runStatusLabel(run.status) + ' · ' + run.runId.slice(-8));
      select.disabled = state.busy === 'starting' && (!state.run || state.run.runId !== run.runId);
      select.addEventListener('click', async function () {
        if (state.run && state.run.runId === run.runId) {
          await controller.refreshRunEvents(run.runId);
        } else {
          await controller.selectRun(run.runId);
          if (controller.getState().profileRef) await controller.previewAuthorization();
        }
        render();
      });
      item.appendChild(select);
      var cancel = root.document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'wm-task-cancel';
      cancel.textContent = '取消';
      cancel.addEventListener('click', function () {
        if (!root.confirm('取消此只读审计任务并撤销授权？')) return;
        controller.cancel(run.runId).then(render);
      });
      item.appendChild(cancel);
      list.appendChild(item);
    });
  }
  function runStatusLabel(status) {
    var labels = { queued: '等待授权', running: '执行中', cancel_requested: '取消中',
      completed: '已完成', failed: '失败', cancelled: '已取消' };
    return labels[status] || String(status || '未知');
  }
  /* 内部错误码 → 用户可理解的说明。
     只作用于展示层：state 里保留原始码，撤销/对比/重试逻辑与测试断言不受影响。
     未登记的错误码不原样外露，统一落到一句可读的兜底文案。 */
  var STATUS_CODES = {
    'home-node-unreachable': '未连接到本机 Home Node；Work 的读写都不会发生。',
    'home-node-unavailable': '本机 Home Node 暂不可用；Work 的读写都不会发生。',
    'work-run-api-unavailable': '任务服务暂不可用；未创建或修改任何 Run。',
    'work-run-create-failed': '未能在 Home Node 创建 Run；没有发生外发。',
    'work-run-start-failed': 'Run 未启动；授权将撤销，也不会自动重试。',
    'work-run-cancel-failed': '取消请求未被 Home Node 确认；Run 状态以 Home Node 为准。',
    'work-result-read-failed': '读取 Work Result 失败；未改动任何已保存结果。',
    'work-result-delete-failed': '删除 Work Result 未被 Home Node 确认；内容仍在。',
    'work-mode-failed': 'Work 操作未完成；没有发生外发。',
    'authorization-preview-failed': '未能核对 Provider 与项目范围；授权未创建。',
    'authorization-preview-changed': 'Provider、项目或文件范围已变化；需要重新核对后才能授权。',
    'consent-grant-failed': '授权未保存；外发不会开始。',
    'consent-scope-changed': '授权范围发生变化；运行未启动。',
    'explicit-consent-required': '先勾选外发确认与 Result 保存风险确认，再一次完成授权和启动。',
    'run-not-queued': '当前 Run 不处于等待授权状态；请从任务列表重新选择。',
    'consent-revoke-failed': '撤销未被确认；Run 仍不可启动。',
    'consent-no-longer-active': 'Home Node 未确认授权状态；没有发送模型请求。请查看具体原因并重新核对。',
    'consent-read-failed': '暂时无法从 Home Node 读取授权状态；旧授权未撤销，也没有发送模型请求。可重试。',
    'consent-record-not-found': 'Home Node 中没有找到这份授权；Run 尚未启动，请重新核对并确认。',
    'consent-already-revoked': 'Home Node 已撤销这份旧授权；Run 尚未启动，请重新确认权限。',
    'consent-expired': '这份授权已过期；Run 尚未启动，请重新确认权限。',
    'consent-run-mismatch': '授权属于另一条 Run；已拒绝继续，请重新核对当前任务。',
    'consent-project-mismatch': '授权所绑定的 Workspace 项目与当前 Run 不一致；请重新核对项目。',
    'consent-file-scope-mismatch': '授权文件范围与当前选择不一致；请重新选择文件并确认。',
    'consent-provider-mismatch': '授权 Provider 路由与当前配置不一致；请重新核对模型路由并确认。',
    'consent-terms-stale': '授权条款已更新；请重新阅读后确认。',
    'consent-memory-scope-mismatch': 'Agent Memory 选择与已授权范围不同；请重新核对 Memory 权限。',
    'consent-memory-derived-scope-mismatch': 'Memory 衍生内容的 Review 或 Result 权限已变化；请重新核对。',
    'consent-scope-invalid': 'Home Node 返回的授权范围无效；请刷新项目与 Provider 信息后重试。',
    'run-events-unavailable': '轨迹暂不可用；任务状态仍以 Home Node 为准。',
    'dsh-host-disabled': 'DSH 尚未在 Dev Home Node 启用；请用 Dev Launcher 的 --dsh 选项启动。',
    'dsh-host-unavailable': 'DSH Host 状态暂不可用；Run 未启动。',
    'dsh-memory-unsupported': 'DSH Agent Memory Recall 范围无效或未获得完整授权；请重新核对 Recall、Review 与 Result 权限。',
    'dsh-prompt-size-limit': '所选项目范围过大，无法安全传给 DSH；请缩小文件范围。',
    'dsh-execution-failed': 'DSH 执行未完成；Run 状态以 Home Node 为准。',
    'dsh-execution-timeout': 'DSH 执行超时；Home Node 已停止后续调用。',
    'execution-cancelled': 'DSH Run 已取消；Home Node 已停止后续调用。',
    'acp-child-exited': 'DSH 子进程异常退出；Home Node 已终止 Run，刷新后可读取最终状态。',
    'provider-route-changed': 'Provider 路由在执行中发生变化；Home Node 已阻断后续发送。',
    'consent-provider-mismatch': '当前 Provider 路由与已保存授权不一致；Run 未继续。',
    'agent-memory-authority-unavailable': 'Agent Memory 服务暂不可用；未读取也未写入。',
    'agent-memory-query-failed': '读取项目记忆失败；没有发送任何内容。',
    'agent-memory-write-failed': '未能写入 Agent Memory；未创建记录。',
    'agent-memory-retract-failed': '未能撤销该记忆写入；记录状态以 Agent Memory 为准。',
    'invalid-procedure-candidate': '请填写 Procedure 名称、至少一个步骤和适用场景，再预览候选。',
    'procedure-candidate-preview-required': '先预览 Procedure 候选，再勾选确认。',
    'explicit-memory-candidate-confirmation-required': '候选尚未确认；没有写入 Agent Memory。',
    'memory-candidate-not-current': '来源 Run 或 Result 已变化；请重新选择来源并创建候选。',
    'memory-candidate-in-progress': '当前还有未确认的候选草稿；请先完成、放弃或切换该草稿。',
    'invalid-record': 'Procedure 内容格式不符合 Agent Memory 规则，或包含不允许保存的敏感字段；没有写入。',
    'work-result-not-available': '来源 Work Result 已删除、过期或不可用；没有写入候选。',
    'work-result-reference-conflict': 'Run 与 Result 引用不匹配；请重新选择已完成的 Result。',
    'memory-selection-changed': '记忆选择已变化；需要重新逐项确认。',
    'memory-scope-changed': '记忆范围已变化；请重新核对授权。',
    'version-conflict': 'Agent Memory 已变化；请重新预览候选后再确认。',
    'project-access-denied': '当前 Workspace 不包含这个项目；已拒绝跨项目访问。',
    'project-not-found': '项目记录不存在或已被移除。',
    'workspace-unavailable': 'Workspace 本地项目或文件索引读取失败；不会将读取失败显示为空项目。',
    'workspace-integrity': 'Workspace 项目或文件记录不一致；已停止文件预览。',
    'project-file-limit': '项目中的候选文件超过 Work Mode 的读取上限。',
    'workspace-file-path-invalid': '文件路径无效；没有导入任何文件。',
    'workspace-file-conflict': '所选路径与现有文件冲突；原文件未覆盖。',
    'no-eligible-files': '所选内容没有符合 Work Mode 只读范围的文本文件。',
    'file-read-failed': '无法读取所选文件内容；没有导入该批文件。',
    'file-size-limit': '文件超过 Work Mode 的单文件上限。',
    'workspace-fingerprint-unavailable': '无法为当前文件生成变更校验；文件预览已停止。',
    'workspace-changed': 'Workspace 文件在核对后发生变化；旧授权不能继续使用。',
    'workspace-changed-snapshot': 'Workspace 文件与授权快照不一致；旧授权不能继续使用。',
    'workspace-import-partial': '部分文件已写入 Workspace；请刷新文件预览核对实际结果。',
    'no-files-selected': '没有选择文件。',
    'file-selection-required': '请先预览并选择至少一个文件范围。',
    'project-name-required': '已取消项目创建；Workspace 未写入空项目。',
    'invalid-project-name': '项目名称无效；请使用 60 个字符以内的名称。',
    'operation-busy': '当前本地 Workspace 操作尚未完成。'
  };
  function statusMessage(value) {
    var code = String(value == null ? '' : value);
    if (!code) return '';
    if (STATUS_CODES[code]) return STATUS_CODES[code];
    /* 已是中文说明（既有的 notice 文案）时原样显示 */
    if (/[\u4e00-\u9fff]/.test(code)) return code;
    return 'Work 未能完成上一步操作；没有发生外发。';
  }
  function displayState(state) {
    var run = state.run || (state.selectedResult && state.selectedResult.run) || null;
    if (run && ['queued', 'running', 'cancel_requested'].indexOf(run.status) >= 0) {
      return run.status === 'queued' ? 'authorization' : 'running';
    }
    if (state.selectedResult || run && ['completed', 'failed', 'cancelled'].indexOf(run.status) >= 0) return 'complete';
    return 'empty';
  }
  var reviewedResultKeys = Object.create(null);
  function resultMarkedReviewed(state) {
    var currentRun = state && (state.run || (state.selectedResult && state.selectedResult.run));
    var selectedRun = state && state.selectedResult && state.selectedResult.run;
    var reviewKey = selectedRun && currentRun && selectedRun.runId === currentRun.runId
      ? api.resultReviewKey(state.selectedResult) : '';
    return !!reviewKey && reviewedResultKeys[reviewKey] === true;
  }
  function renderWorkflowStatus(state) {
    var currentRun = state.run || (state.selectedResult && state.selectedResult.run) || null;
    var status = api.deriveWorkflowStatus(state, resultMarkedReviewed(state), Date.now());
    var rootStatus = byId('wm-workflow-status');
    var label = byId('wm-workflow-status-label');
    var detail = byId('wm-workflow-status-detail');
    var openResult = byId('wm-open-result');
    if (rootStatus) rootStatus.setAttribute('data-state', status.key);
    if (label) label.textContent = status.label;
    if (detail) detail.textContent = status.detail;
    if (openResult) {
      var run = currentRun;
      var selected = state.selectedResult && state.selectedResult.run;
      var resultIsOpen = !!(selected && run && selected.runId === run.runId);
      openResult.hidden = status.key !== 'waiting-review' || resultIsOpen || !run;
      openResult.disabled = state.ledgerLoading || state.busy !== '';
      openResult.onclick = function () {
        if (!run || !run.runId) return;
        controller.selectResult(run.runId).then(render);
      };
    }
  }
  function renderWorkRunSummary(state) {
    var section = byId('wm-run-summary');
    if (!section) return;
    var summary = api.deriveWorkRunSummary(state, resultMarkedReviewed(state), Date.now());
    section.setAttribute('data-state', summary.statusKey || 'unknown');
    setText('wm-summary-title', summary.title);
    setText('wm-summary-project', summary.project);
    setText('wm-summary-status', summary.status);
    setText('wm-summary-lifecycle', summary.lifecycle);
    setText('wm-summary-actions', summary.completedActionCount == null ? '—' : String(summary.completedActionCount));
    setText('wm-summary-actions-detail', summary.actionDetail);
    setText('wm-summary-memory', summary.memory);
    setText('wm-summary-result', summary.result);
    setText('wm-summary-review', summary.review);
    setText('wm-summary-reason', summary.reason);
  }
  function syncInspectorButton() {
    var inspector = byId('wm-inspector-details');
    var toggle = byId('wm-inspector-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', inspector && inspector.open ? 'true' : 'false');
  }
  function openInspector(disclosureId) {
    var inspector = byId('wm-inspector-details');
    var disclosure = disclosureId && byId(disclosureId);
    if (inspector) inspector.open = true;
    if (disclosure) disclosure.open = true;
    syncInspectorButton();
    if (disclosure) {
      var summary = disclosure.querySelector('summary');
      if (summary) summary.focus();
      disclosure.scrollIntoView({ block: 'nearest' });
    }
  }
  function renderRunEvents(state) {
    var list = byId('wm-run-events');
    if (!list) return;
    resetChildren(list);
    var activeRun = state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0;
    var selectedRunId = activeRun ? state.run.runId : (state.selectedResult && state.selectedResult.run
      ? state.selectedResult.run.runId : (state.run && state.run.runId || ''));
    if (selectedRunId && state.runEventsRunId !== selectedRunId) {
      setText('wm-events-status', '正在读取任务事件…');
      return;
    }
    if (state.runEventsStatus === 'loading') {
      setText('wm-events-status', '正在读取任务事件…');
      return;
    }
    if (state.runEventsStatus === 'unavailable' || (state.runEventsStatus !== 'ready' && selectedRunId)) {
      setText('wm-events-status', '事件读取不可用；任务状态仍以 Home Node 为准。');
      return;
    }
    if (!selectedRunId) {
      setText('wm-events-status', '选择任务后显示状态轨迹。');
      return;
    }
    if (!state.runEvents.length) {
      /* runEventsStatus 可能是 'ready'/'idle' 之类的状态词，也可能是 safeMessage
         写回的内部错误码——后者在这里投影为用户可理解的说明。 */
      var known = { ready: 1, idle: 1, loading: 1, unavailable: 1 };
      var eventsText = '尚未读取事件。';
      if (state.runEventsStatus === 'ready') eventsText = '暂无事件。';
      else if (!known[state.runEventsStatus]) eventsText = statusMessage(state.runEventsStatus);
      setText('wm-events-status', eventsText);
      return;
    }
    setText('wm-events-status', String(state.runEvents.length) + ' 个 Home Node Run / Action 事件');
    state.runEvents.forEach(function (event) {
      var item = root.document.createElement('li');
      appendText(item, 'span', 'wm-event-sequence', String(event.sequence).padStart(2, '0'));
      var detail = root.document.createElement('div');
      appendText(detail, 'strong', '', api.runEventLabel(event));
      appendText(detail, 'span', '', api.runEventDetail(event));
      item.appendChild(detail);
      appendText(item, 'time', '', formatDate(event.createdAt));
      list.appendChild(item);
    });
  }
  function renderMemoryProvenance(state) {
    var list = byId('wm-memory-provenance-records');
    if (!list) return;
    resetChildren(list);
    var run = state.run || (state.selectedResult && state.selectedResult.run) || null;
    var projection = state.memoryProvenance;
    if (!run) {
      setText('wm-memory-provenance-status', '—');
      setText('wm-memory-provenance-summary', '选择 Run 后显示 Memory 来源。');
      setText('wm-memory-provenance-purpose', '');
      setText('wm-memory-provenance-result', '');
      return;
    }
    if (!projection || projection.runId !== run.runId || projection.status === 'loading') {
      setText('wm-memory-provenance-status', '读取中');
      setText('wm-memory-provenance-summary', '正在读取该 Run 的 Consent Memory 引用与 Result 标记。');
      setText('wm-memory-provenance-purpose', '');
      setText('wm-memory-provenance-result', '');
      return;
    }
    if (projection.status !== 'ready') {
      setText('wm-memory-provenance-status', '不可用');
      setText('wm-memory-provenance-summary', '来源信息暂不可用；没有读取或展示 Memory 正文。');
      setText('wm-memory-provenance-purpose', '');
      setText('wm-memory-provenance-result', '');
      return;
    }
    var consent = projection.consent || {};
    var consentLabels = { active: '有效', revoked: '已撤销', expired: '已过期', not_found: '无授权记录' };
    var scope = consent.memoryScope || null;
    setText('wm-memory-provenance-status', consentLabels[consent.status] || '状态未知');
    if (!scope || !Array.isArray(projection.records) || projection.records.length === 0) {
      setText('wm-memory-provenance-summary', consent.status === 'not_found'
        ? '此 Run 没有可用的 Consent 记录。'
        : '此 Run 的 Consent 未包含 Agent Memory Recall。');
      setText('wm-memory-provenance-purpose', '没有自动选择 Memory；Chat Memory 不参与 Work Agent Recall。');
    } else {
      var purpose = '用途：将 Consent 明确选择的项目级 Agent Memory 引用作为 Work Agent 上下文；不读取 Chat Memory。';
      var generationEvents = state.runEventsRunId === run.runId && state.runEventsStatus === 'ready'
        ? state.runEvents.filter(function (event) {
          return event && event.actionTrace && event.actionTrace.runId === run.runId
            && event.actionTrace.actionId === 'ib.work.result.generate.v1';
        }) : null;
      if (generationEvents === null) purpose += ' Action Trace 未加载，实际调用次数未确认。';
      else {
        var successfulGenerations = generationEvents.filter(function (event) {
          return event.actionTrace.status === 'succeeded';
        }).length;
        purpose += successfulGenerations
          ? ' 已随 ' + successfulGenerations + ' 次成功的 Result Generation 调用提供。'
          : (generationEvents.length ? ' 尚无成功的 Result Generation 调用记录。' : ' 尚无 Result Generation 调用记录。');
      }
      setText('wm-memory-provenance-summary', '授权的 Memory 引用：' + projection.records.length
        + ' 条 · Project ' + String(scope.projectRef || '未知项目') + ' · Context ' + String(scope.contextChars || 0) + ' 字符');
      setText('wm-memory-provenance-purpose', purpose);
      projection.records.forEach(function (record) {
        var item = root.document.createElement('li');
        appendText(item, 'strong', '', String(record.memoryId || 'Memory 引用不可用'));
        var typeLabel = record.recordStatus === 'matched' ? String(record.type || '未标注')
          : (record.recordStatus === 'changed' ? '当前记录已变化；类型未核对' : '当前记录不可用；保留授权时引用');
        appendText(item, 'span', '', 'Project ' + String(record.projectRef || scope.projectRef || '')
          + ' · ' + typeLabel + ' · Revision ' + String(record.revision || '—'));
        appendText(item, 'code', '', 'SHA-256 ' + String(record.contentHash || '不可用'));
        list.appendChild(item);
      });
    }
    var derivedScope = consent.memoryDerivedScope || null;
    var result = projection.result;
    var resultText = !result
      ? 'Result 标记：尚无 Result Artifact。'
      : (result.memoryDerived === true
        ? 'Result 标记：memory-derived=true' + (scope && result.memoryContextHash === scope.contextHash
          ? ' · Context hash 与 Consent 引用匹配。' : ' · Context hash 未与当前 Consent 引用匹配。')
        : 'Result 标记：memory-derived=false。');
    if (derivedScope) {
      resultText += ' Consent sink：Review ' + (derivedScope.reviewConfirmed ? '已确认' : '未确认')
        + ' · Result ' + (derivedScope.resultConfirmed ? '已确认' : '未确认') + '。';
    }
    if (result && result.status === 'deleted') resultText += ' Result 已删除；Memory Provenance 仅保留已有标记。';
    setText('wm-memory-provenance-result', resultText);
  }
  function renderExecutionStages(state) {
    var list = byId('wm-execution-stage-list');
    if (!list) return;
    resetChildren(list);
    var selectedResultRun = state.selectedResult && state.selectedResult.run;
    var run = state.run || selectedResultRun || null;
    if (!run) {
      setText('wm-execution-stage-current', '—');
      setText('wm-execution-stage-summary', '选择任务后显示阶段投影。');
      return;
    }
    var eventStatus = state.runEventsStatus;
    var events = state.runEvents;
    if (state.runEventsRunId !== run.runId) {
      eventStatus = 'loading';
      events = [];
    } else if (eventStatus !== 'ready') {
      events = [];
    }
    var projection = api.deriveExecutionStages(run, events, eventStatus);
    var current = projection.currentStage && projection.stages.find(function (stage) {
      return stage.key === projection.currentStage;
    });
    var terminalLabel = run.status === 'completed' ? 'Completed'
      : (run.status === 'failed' ? 'Failed' : (run.status === 'cancelled' ? 'Cancelled' : ''));
    setText('wm-execution-stage-current', terminalLabel || (current ? 'Current · ' + current.label
      : (run.status === 'queued' ? 'Not started' : 'Stage unknown')));
    setText('wm-execution-stage-summary', projection.summary);
    projection.stages.forEach(function (stage) {
      var item = root.document.createElement('li');
      item.setAttribute('data-stage', stage.key);
      item.setAttribute('data-state', stage.status);
      var heading = root.document.createElement('div');
      appendText(heading, 'strong', '', stage.label);
      appendText(heading, 'span', 'wm-stage-state', stage.statusLabel);
      item.appendChild(heading);
      appendText(item, 'p', '', stage.detail);
      list.appendChild(item);
    });
  }
  function renderRuntimeDiagnostics(state) {
    var section = byId('wm-runtime-diagnostics');
    if (!section) return;
    var run = state.run || (state.selectedResult && state.selectedResult.run) || null;
    var eventStatus = state.runEventsRunId === (run && run.runId) ? state.runEventsStatus : 'loading';
    var events = eventStatus === 'ready' ? state.runEvents : [];
    var diagnostics = api.deriveRuntimeDiagnostics(run, events, eventStatus, state.memoryProvenance, Date.now(), state.consent);
    section.setAttribute('data-state', run ? String(run.status || 'unknown') : 'empty');
    setText('wm-diagnostics-state', diagnostics.stateLabel);
    setText('wm-diagnostics-summary', diagnostics.summary);
    setText('wm-diagnostics-current', diagnostics.currentPhase);
    setText('wm-diagnostics-current-detail', diagnostics.currentDetail);
    var completed = byId('wm-diagnostics-completed');
    if (completed) {
      resetChildren(completed);
      if (!diagnostics.completedSteps.length) {
        var emptyStepText = run && run.status === 'completed'
          ? '未记录细分 Action；Home Node 确认 Run 已完成。' : '暂无成功 Action 步骤记录。';
        appendText(completed, 'li', 'wm-diagnostics-empty', emptyStepText);
      }
      else diagnostics.completedSteps.forEach(function (step) { appendText(completed, 'li', '', step); });
    }
    setText('wm-diagnostics-failure', diagnostics.failure
      ? diagnostics.failure.location + ' · ' + diagnostics.failure.note
      : (run && run.status === 'failed' ? '未能从现有事件定位具体失败阶段。' : '没有已记录的失败位置。'));
    setText('wm-diagnostics-authority', diagnostics.authority);
    setText('wm-diagnostics-consent', diagnostics.consent);
    setText('wm-diagnostics-memory', diagnostics.memory);
    setText('wm-diagnostics-hint', diagnostics.hint);
  }
  function renderResults(state) {
    var list = byId('wm-results');
    if (!list) return;
    resetChildren(list);
    setText('wm-result-count', String(state.results.length));
    state.results.forEach(function (result) {
      var item = root.document.createElement('li');
      var view = root.document.createElement('button');
      view.type = 'button';
      view.className = 'wm-result-open';
      view.setAttribute('aria-current', state.selectedResult && state.selectedResult.run
        && state.selectedResult.run.runId === result.runId ? 'true' : 'false');
      appendText(view, 'strong', '', result.projectRef);
      appendText(view, 'span', '', result.resultStatus + ' · ' + formatDate(result.createdAt));
      if (result.memoryDerived === true) appendText(view, 'span', 'wm-derived-badge', 'memory-derived');
      view.disabled = result.resultStatus !== 'available' || Number(result.expiresAt) <= Date.now();
      view.addEventListener('click', function () { controller.selectResult(result.runId).then(render); });
      item.appendChild(view);
      if (result.resultStatus === 'available') {
        var remove = root.document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn wm-delete';
        remove.textContent = '删除 Result';
        remove.addEventListener('click', async function () {
          if (!root.confirm('删除这份只读审计 Result？此操作不会删除 Run 事件。')) return;
          await controller.deleteResult(result.runId, true);
          render();
        });
        item.appendChild(remove);
      }
      list.appendChild(item);
    });
  }
  function renderSelectedResult(result) {
    var target = byId('wm-result-view');
    if (!target) return;
    resetChildren(target);
    if (!result || !result.result) {
      var terminal = result && result.run && ['failed', 'cancelled'].indexOf(result.run.status) >= 0;
      appendText(target, 'p', 'wm-empty-state', terminal
        ? '此 Run 未提供可用报告；状态与事件以 Home Node 为准。'
        : '选择已完成的任务查看报告。');
      return;
    }
    var artifact = result.result;
    var runReference = result.run && [result.run.projectRef, result.run.runId].filter(function (value) {
      return typeof value === 'string' && value.trim();
    }).join(' · ');
    appendText(target, 'p', 'wm-result-run-ref', runReference || 'Run / Project 引用未提供');
    if (artifact && artifact.memoryDerived === true) {
      appendText(target, 'p', 'wm-derived-badge', 'memory-derived · 来源上下文 SHA-256 ' + String(artifact.memoryContextHash || '').slice(0, 12));
    }
    var reviewModel = api.buildResultReviewModel(artifact);
    var summarySection = root.document.createElement('section');
    summarySection.className = 'wm-review-section';
    appendText(summarySection, 'h3', '', 'Result 摘要');
    appendText(summarySection, 'p', 'wm-report-summary', reviewModel.hasSummary ? reviewModel.summary : 'Artifact 未提供摘要。');
    target.appendChild(summarySection);

    var findingsSection = root.document.createElement('section');
    findingsSection.className = 'wm-review-section';
    appendText(findingsSection, 'h3', '', 'Findings · ' + reviewModel.findings.length);
    var findingList = root.document.createElement('div');
    findingList.className = 'wm-review-findings';
    reviewModel.findings.forEach(function (finding) {
      var article = root.document.createElement('article');
      article.className = 'wm-review-finding';
      var heading = root.document.createElement('div');
      heading.className = 'wm-review-finding-heading';
      appendText(heading, 'span', 'wm-review-severity', finding.severity);
      appendText(heading, 'h4', '', finding.title);
      article.appendChild(heading);
      appendText(article, 'p', '', finding.detail);
      findingList.appendChild(article);
    });
    if (reviewModel.hasFindings) findingsSection.appendChild(findingList);
    else appendText(findingsSection, 'p', 'wm-review-empty', 'Result 没有 Findings。');
    target.appendChild(findingsSection);

    var evidenceSection = root.document.createElement('section');
    evidenceSection.className = 'wm-review-section';
    appendText(evidenceSection, 'h3', '', 'Evidence / 来源');
    if (reviewModel.hasFindings) {
      var evidenceList = root.document.createElement('ul');
      evidenceList.className = 'wm-review-evidence';
      reviewModel.findings.forEach(function (finding) {
        var item = root.document.createElement('li');
        appendText(item, 'strong', '', finding.title);
        if (finding.location) appendText(item, 'span', 'wm-finding-location', finding.location);
        if (finding.fileId) appendText(item, 'span', 'wm-review-file-id', 'File ID · ' + finding.fileId);
        if (!finding.hasSource) appendText(item, 'span', 'wm-review-source-missing', 'Artifact 未提供来源引用');
        evidenceList.appendChild(item);
      });
      evidenceSection.appendChild(evidenceList);
    } else {
      appendText(evidenceSection, 'p', 'wm-review-empty', '没有可列示的 Finding 来源。');
    }
    appendText(evidenceSection, 'p', 'wm-review-note', 'Artifact 保存来源文件引用与行号，不包含原文证据片段；请对照本地 Workspace 源文件核验。');
    target.appendChild(evidenceSection);

    var confirmationSection = root.document.createElement('section');
    confirmationSection.className = 'wm-review-section';
    appendText(confirmationSection, 'h3', '', '需要用户确认的项目');
    appendText(confirmationSection, 'p', 'wm-review-note', '请逐项核对 Finding 描述与来源位置。Artifact 不包含独立确认或批准字段；此处只展示，不会自动批准或写入。');
    if (reviewModel.hasFindings) {
      var confirmationList = root.document.createElement('ul');
      confirmationList.className = 'wm-review-confirmations';
      reviewModel.findings.forEach(function (finding) {
        var item = root.document.createElement('li');
        appendText(item, 'strong', '', finding.severity + ' · ' + finding.title);
        appendText(item, 'span', '', finding.location || '来源未提供；请结合当前 Workspace 范围核对。');
        confirmationList.appendChild(item);
      });
      confirmationSection.appendChild(confirmationList);
    } else {
      appendText(confirmationSection, 'p', 'wm-review-empty', 'Artifact 未提供单独的待确认项目。');
    }
    target.appendChild(confirmationSection);

    var resultIsAvailable = artifact.status === 'available'
      && (!Number.isFinite(Number(artifact.expiresAt)) || Number(artifact.expiresAt) > Date.now());
    if (result.run && result.run.status === 'completed' && resultIsAvailable) {
      var reviewKey = api.resultReviewKey(result);
      var actions = root.document.createElement('div');
      actions.className = 'wm-result-actions';
      if (reviewedResultKeys[reviewKey] !== true) {
        var reviewed = root.document.createElement('button');
        reviewed.type = 'button';
        reviewed.className = 'btn wm-result-review';
        reviewed.textContent = '标记审阅完成';
        reviewed.addEventListener('click', function () {
          reviewedResultKeys[reviewKey] = true;
          render();
        });
        actions.appendChild(reviewed);
      }
      var exportResult = root.document.createElement('button');
      exportResult.type = 'button';
      exportResult.className = 'btn wm-result-export';
      exportResult.textContent = '导出 Markdown';
      exportResult.addEventListener('click', function () { downloadSelectedResult(result); });
      actions.appendChild(exportResult);
      target.appendChild(actions);
      appendText(target, 'p', 'wm-export-note', '导出会在本机生成报告明文副本；下载前请检查报告内容和保存位置。');
      if (reviewModel.hasSummary || reviewModel.hasFindings) {
        var candidateActions = root.document.createElement('div');
        candidateActions.className = 'wm-result-actions wm-candidate-actions';
        if (reviewModel.hasSummary) appendMemoryCandidateAction(candidateActions, 'summary', '将摘要加入 Memory 候选');
        reviewModel.findings.forEach(function (finding) {
          appendMemoryCandidateAction(candidateActions, 'finding:' + finding.index,
            '将 Finding ' + (finding.index + 1) + ' 加入 Memory 候选');
        });
        target.appendChild(candidateActions);
        appendText(target, 'p', 'wm-review-note', 'Memory 候选入口沿用现有流程；创建候选不会写入 Memory，写入仍需独立确认。');
      }
    }
    if (result.run && result.run.status === 'completed' && artifact.status === 'available') {
      var state = controller.getState();
      var current = state.memoryCandidate;
      if (current && current.type === 'Procedure' && current.basedOn
        && current.basedOn.resultId === artifact.resultId && !current.committedRecord) {
        var edit = root.document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn wm-procedure-candidate-start';
        edit.textContent = current.procedureReviewed && !current.procedureEditing ? '修改 Procedure 候选' : '继续起草 Procedure 候选';
        edit.addEventListener('click', function () {
          if (current.procedureReviewed && !current.procedureEditing) controller.editProcedureCandidate().then(render);
          else controller.beginProcedureCandidate().then(render);
        });
        target.appendChild(edit);
      } else {
        var draft = root.document.createElement('button');
        draft.type = 'button';
        draft.className = 'btn wm-procedure-candidate-start';
        draft.textContent = '从此 Result 起草 Procedure 候选';
        draft.addEventListener('click', function () { controller.beginProcedureCandidate().then(render); });
        target.appendChild(draft);
      }
      appendText(target, 'p', 'wm-muted-line', 'Procedure 内容由你根据已完成的 Work Result 手动整理；此流程不调用模型，也不会自动写入。');
    }
  }
  function downloadSelectedResult(result) {
    var markdown = api.formatResultMarkdown(result);
    if (!markdown || !root.Blob || !root.URL || typeof root.URL.createObjectURL !== 'function') {
      setText('wm-export-status', '当前环境无法创建本地导出文件。');
      return false;
    }
    var objectUrl = '';
    try {
      var runId = result && result.run && result.run.runId || 'result';
      var safeId = String(runId).replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'result';
      objectUrl = root.URL.createObjectURL(new root.Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      var link = root.document.createElement('a');
      link.href = objectUrl;
      link.download = 'work-result-' + safeId + '.md';
      link.hidden = true;
      root.document.body.appendChild(link);
      link.click();
      if (typeof link.remove === 'function') link.remove();
      else root.document.body.removeChild(link);
      setText('wm-export-status', '已触发本地 Markdown 下载。');
      if (typeof root.setTimeout === 'function') root.setTimeout(function () {
        try { root.URL.revokeObjectURL(objectUrl); } catch (_) { /* local export cleanup only */ }
      }, 0);
      else root.URL.revokeObjectURL(objectUrl);
      return true;
    } catch (_) {
      if (objectUrl) {
        try { root.URL.revokeObjectURL(objectUrl); } catch (_) { /* local export cleanup only */ }
      }
      setText('wm-export-status', '导出未能启动；Result 保持不变。');
      return false;
    }
  }
  function appendMemoryCandidateAction(parent, selectionRef, label) {
    var button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = label;
    button.addEventListener('click', function () {
      controller.previewMemoryCandidate(selectionRef).then(render);
    });
    parent.appendChild(button);
  }
  function renderMemoryCandidate(state) {
    var section = byId('wm-memory-candidate');
    var target = byId('wm-memory-candidate-view');
    if (!section || !target) return;
    resetChildren(target);
    var candidate = state.memoryCandidate;
    var linked = Array.isArray(state.linkedMemoryRecords) ? state.linkedMemoryRecords : [];
    section.hidden = !candidate && !linked.length;
    linked.forEach(function (record) {
      var article = root.document.createElement('article');
      appendText(article, 'strong', '', record.type + ' · ' + record.status + ' · ' + record.memoryId);
      if (record.type === 'Procedure' && record.payload) {
        appendText(article, 'p', '', record.payload.name || 'Procedure');
        if (record.payload.whenToUse) appendText(article, 'p', '', '适用场景 · ' + record.payload.whenToUse);
        if (Array.isArray(record.payload.steps)) {
          var linkedSteps = root.document.createElement('ol');
          record.payload.steps.forEach(function (step) { appendText(linkedSteps, 'li', '', step); });
          article.appendChild(linkedSteps);
        }
      } else appendText(article, 'p', '', record.payload && record.payload.statement || '内容已清空或已过期。');
      var provenance = Array.isArray(record.provenance) ? record.provenance.find(function (item) {
        return item && item.sourceKind === 'work_result_ref';
      }) : null;
      if (provenance && provenance.sourceRunId) appendText(article, 'p', 'wm-memory-source', 'Source Run · ' + provenance.sourceRunId);
      if (record.status === 'active' && provenance) {
        var revoke = root.document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn wm-delete';
        revoke.textContent = '撤销此记忆写入';
        revoke.addEventListener('click', function () {
          if (!root.confirm('撤销这条来源于 Work Result 的 Agent Memory？撤销会清空内容，且保留历史墓碑。')) return;
          controller.retractMemoryRecord(record, true).then(render);
        });
        article.appendChild(revoke);
      }
      target.appendChild(article);
    });
    if (candidate) {
      var preview = root.document.createElement('article');
      var isProcedure = candidate.type === 'Procedure';
      appendText(preview, 'h3', '', candidate.committedRecord
        ? (isProcedure ? 'Procedure 已写入 Agent Memory' : 'Memory Candidate 已提交')
        : (isProcedure ? (candidate.procedureReviewed && !candidate.procedureEditing ? 'Procedure Candidate 预览' : 'Procedure Candidate 起草') : 'Memory Candidate 预览'));
      appendText(preview, 'p', '', 'Project · ' + candidate.projectRef);
      appendText(preview, 'p', '', 'Source Result · ' + candidate.basedOn.resultId + ' · Run ' + candidate.basedOn.runId);
      appendText(preview, 'p', '', 'Type · ' + candidate.type + (isProcedure ? ' · 长期 Procedure' : ' · Observation 默认有效期 30 天'));
      if (!isProcedure) {
        appendText(preview, 'p', '', 'Provenance · ' + candidate.provenance.sourceKind + ' / ' + candidate.provenance.sourceRef + ' / ' + candidate.provenance.selectionRef);
        appendText(preview, 'blockquote', 'wm-memory-candidate-content', candidate.payload.statement);
      }
      if (candidate.committedRecord) {
        appendText(preview, 'p', '', 'Memory · ' + candidate.committedRecord.memoryId + ' · ' + candidate.committedRecord.status);
      } else if (isProcedure && candidate.procedureEditing) {
        appendText(preview, 'p', '', '根据下方已完成的 Work Result 手动填写。预览只保存在当前页面；写入需再次明确确认。');
        var editor = root.document.createElement('div');
        editor.className = 'wm-procedure-editor';
        function field(labelText, value, multiline, maxLength) {
          var label = root.document.createElement('label');
          label.className = 'wm-procedure-field';
          appendText(label, 'span', 'ib-form-group__label', labelText);
          var control = root.document.createElement(multiline ? 'textarea' : 'input');
          if (!multiline) control.type = 'text';
          control.className = 'wm-procedure-input';
          control.maxLength = maxLength;
          if (multiline) control.rows = labelText.indexOf('steps') >= 0 || labelText.indexOf('步骤') >= 0 ? 7 : 3;
          control.value = value;
          label.appendChild(control);
          editor.appendChild(label);
          return control;
        }
        var nameField = field('Procedure name', String(candidate.payload.name || ''), false, 160);
        var stepsField = field('Steps · 每行一步', Array.isArray(candidate.payload.steps) ? candidate.payload.steps.join('\n') : '', true, 15000);
        var whenField = field('When to use', String(candidate.payload.whenToUse || ''), true, 600);
        appendText(editor, 'p', 'wm-muted-line', '1–30 步，每步最多 500 字；只提交这里预览的 name、steps 和 whenToUse。');
        var previewProcedure = root.document.createElement('button');
        previewProcedure.type = 'button';
        previewProcedure.className = 'btn';
        previewProcedure.textContent = '预览 Procedure Candidate';
        previewProcedure.addEventListener('click', function () {
          controller.previewProcedureCandidate({ name: nameField.value,
            steps: stepsField.value.split(/\r?\n/).map(function (step) { return step.trim(); }).filter(Boolean),
            whenToUse: whenField.value }).then(render);
        });
        editor.appendChild(previewProcedure);
        var discardDraft = root.document.createElement('button');
        discardDraft.type = 'button';
        discardDraft.className = 'btn wm-procedure-editor-action';
        discardDraft.textContent = '丢弃草稿';
        discardDraft.addEventListener('click', function () { controller.discardProcedureCandidate().then(render); });
        editor.appendChild(discardDraft);
        preview.appendChild(editor);
      } else if (isProcedure) {
        appendText(preview, 'p', '', 'Procedure · ' + String(candidate.payload.name || ''));
        if (candidate.payload.whenToUse) appendText(preview, 'p', '', '适用场景 · ' + candidate.payload.whenToUse);
        var steps = root.document.createElement('ol');
        (Array.isArray(candidate.payload.steps) ? candidate.payload.steps : []).forEach(function (step) {
          appendText(steps, 'li', '', step);
        });
        preview.appendChild(steps);
        appendText(preview, 'p', 'wm-memory-source', '来源 Work Run · ' + candidate.basedOn.runId + ' / Result · ' + candidate.basedOn.resultId);
        appendText(preview, 'p', '', '写入后保存在独立的明文 agent-memory.db；未勾选确认并提交前没有写入。');
        var editProcedure = root.document.createElement('button');
        editProcedure.type = 'button';
        editProcedure.className = 'btn wm-procedure-editor-action';
        editProcedure.textContent = '修改候选';
        editProcedure.addEventListener('click', function () { controller.editProcedureCandidate().then(render); });
        preview.appendChild(editProcedure);
        var discardPreview = root.document.createElement('button');
        discardPreview.type = 'button';
        discardPreview.className = 'btn wm-procedure-editor-action';
        discardPreview.textContent = '放弃候选';
        discardPreview.addEventListener('click', function () { controller.discardProcedureCandidate().then(render); });
        preview.appendChild(discardPreview);
      } else {
        appendText(preview, 'p', '', '保存后内容会留在明文 agent-memory.db；若另行创建或下载备份，该副本也为明文。仅提交这一条选中内容，不会导入整份报告。');
        var refreshCandidate = root.document.createElement('button');
        refreshCandidate.type = 'button';
        refreshCandidate.className = 'btn';
        refreshCandidate.textContent = '重新读取并预览';
        refreshCandidate.addEventListener('click', function () {
          controller.previewMemoryCandidate(candidate.provenance.selectionRef).then(render);
        });
        preview.appendChild(refreshCandidate);
      }
      target.appendChild(preview);
    }
    var confirmation = byId('wm-memory-candidate-confirm');
    var confirmationLabel = byId('wm-memory-candidate-confirm-label');
    var write = byId('wm-memory-candidate-write');
    var confirmationText = byId('wm-memory-candidate-confirm-text');
    var candidateReviewable = !!candidate && (!isProcedure || (candidate.procedureReviewed === true && candidate.procedureEditing !== true));
    if (confirmation) {
      confirmation.checked = state.memoryCandidateConfirmed === true;
      confirmation.disabled = !candidateReviewable || !!candidate.committedRecord || state.memoryCandidateBusy !== '';
    }
    if (confirmationLabel) confirmationLabel.hidden = !candidateReviewable || !!candidate.committedRecord;
    if (confirmationText) confirmationText.textContent = isProcedure
      ? '我已核对 Procedure 的 name、steps、适用场景与来源 Run/Result，并确认写入独立 Agent Memory。'
      : '我已核对项目、来源 Result、类型、位置与内容，并确认写入独立 Agent Memory。';
    if (write) write.disabled = !candidate || !!candidate.committedRecord
      || !candidateReviewable || state.memoryCandidateConfirmed !== true || state.memoryCandidateBusy !== '';
    if (write) write.textContent = isProcedure ? '确认写入 Procedure' : '确认写入 Agent Memory';
  }
  function render() {
    var state = controller.getState();
    var page = byId('page-work-mode');
    var workState = displayState(state);
    if (page) page.setAttribute('data-work-state', workState);
    ['empty', 'authorization', 'running'].forEach(function (name) {
      var panel = byId('wm-' + name + '-state');
      if (panel) panel.hidden = workState !== name;
    });
    var projectSelect = byId('wm-project-select');
    var profileSelect = byId('wm-profile-select');
    if (projectSelect) {
      projectSelect.value = state.selectedProjectRef || '';
      projectSelect.disabled = state.busy !== ''
        || (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0);
      var selectedProjectOption = projectSelect.options[projectSelect.selectedIndex];
      var selectedProjectLabel = selectedProjectOption ? selectedProjectOption.textContent : '';
      projectSelect.title = selectedProjectLabel;
      projectSelect.setAttribute('aria-label', '本地项目 · 当前选择' + (selectedProjectLabel ? ' · ' + selectedProjectLabel : ''));
    }
    if (profileSelect) {
      profileSelect.value = state.profileRef || '';
      profileSelect.disabled = state.busy !== '';
    }
    var executorSelect = byId('wm-executor-select');
    var executorStatus = byId('wm-executor-status');
    var dshEnabled = !!(state.dshStatus && state.dshStatus.enabled === true);
    var activeRun = !!(state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0);
    if (executorSelect) {
      executorSelect.value = state.executor === 'dsh' ? 'dsh' : 'native';
      executorSelect.disabled = state.busy !== '' || (activeRun && state.run.status !== 'queued');
      var dshOption = Array.prototype.find.call(executorSelect.options, function (item) { return item.value === 'dsh'; });
      if (dshOption) {
        dshOption.disabled = !dshEnabled && state.executor !== 'dsh';
        dshOption.textContent = dshEnabled ? 'DSH · Dev Runtime ' + String(state.dshStatus.dshRevision || '').slice(0, 7)
          : 'DSH · Dev Launcher 未开启';
      }
    }
    if (executorStatus) {
      var dshRunning = !!(state.run && state.activeDshRunIds.indexOf(state.run.runId) >= 0);
      executorStatus.textContent = state.executor === 'dsh'
        ? (dshRunning ? '正在执行，系统会记录每一步操作。'
          : '使用已授权的项目文件；项目记忆仅在单独选择并授权后发送。')
        : 'Native Work Runtime · 默认引擎';
    }
    var create = byId('wm-create-run');
    var candidateFiles = state.preview && Array.isArray(state.preview.files) ? state.preview.files
      : (state.projectSnapshot && Array.isArray(state.projectSnapshot.files) ? state.projectSnapshot.files : []);
    var canCreate = !!state.selectedProjectRef && !!candidateFiles.length && !!state.fileIds.length
      && !state.projectSnapshotError;
    if (create) create.disabled = state.busy !== '' || state.ledgerLoading || !canCreate
      || !state.selectedProjectRef
      || !!(state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0)
      || state.activeRuns.length > 0;
    var emptyCreate = byId('wm-empty-create-run');
    if (emptyCreate) {
      emptyCreate.textContent = candidateFiles.length ? (state.fileIds.length ? '创建 Run' : '选择范围')
        : (state.selectedProjectRef ? '接入文件' : '接入项目');
      emptyCreate.disabled = state.busy !== '' || state.ledgerLoading
        || !!(state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0)
        || state.activeRuns.length > 0;
      emptyCreate.title = candidateFiles.length
        ? (state.fileIds.length ? '按当前项目与选中文件创建待授权 Run' : '打开 Inspector 选择要预览的文件范围')
        : (state.selectedProjectRef ? '明确选择本地文件或项目文件夹接入当前 Workspace 项目'
          : '明确选择本地项目文件夹，在 Workspace 中创建项目并只接入所选文件');
    }
    var refreshPreviewButton = byId('wm-refresh-preview');
    if (refreshPreviewButton) refreshPreviewButton.disabled = !state.run || !state.profileRef
      || state.busy === 'granting' || state.busy === 'starting';
    var refreshEventsButton = byId('wm-refresh-events');
    if (refreshEventsButton) refreshEventsButton.disabled = !(state.run
      || (state.selectedResult && state.selectedResult.run));
    var resultRun = state.selectedResult && state.selectedResult.run;
    var shownRun = state.run || resultRun;
    setText('wm-run-heading', state.run
      ? (state.run.workflowId === 'coding.workspace' ? 'Coding Workspace Run' : '只读项目审计')
      : (resultRun ? (resultRun.workflowId === 'coding.workspace' ? 'Coding Result' : '审计结果') : '选择项目或任务'));
    renderWorkflowStatus(state);
    renderWorkRunSummary(state);
    setText('wm-run-status', shownRun ? runStatusLabel(shownRun.status) + ' · ' + shownRun.runId : '尚未创建 Run');
    setText('wm-run-project', shownRun ? shownRun.projectRef : '—');
    setText('wm-work-status', state.notice || statusMessage(state.error) || '尚未授权；尚未发生外发。');
    var providerAuthState = byId('wm-auth-provider-state');
    if (providerAuthState) {
      var routeCount = state.preview && Array.isArray(state.preview.providers) ? state.preview.providers.length : 0;
      providerAuthState.textContent = routeCount
        ? 'Provider 路由 · 已核对 ' + routeCount + ' 条路由' : 'Provider 路由 · 选择配置后本地核对';
      providerAuthState.setAttribute('data-state', routeCount ? 'ready' : 'pending');
    }
    var fileAuthState = byId('wm-auth-files-state');
    if (fileAuthState) {
      fileAuthState.textContent = state.fileIds.length
        ? '逐项文件范围 · 已选 ' + state.fileIds.length + ' 项，尚未授权' : '逐项文件范围 · 默认不选';
      fileAuthState.setAttribute('data-state', state.fileIds.length ? 'ready' : 'pending');
    }
    var consentState = byId('wm-consent-state');
    if (consentState) {
      var consentLabel = '尚未保存授权';
      if (state.revocationRequired) consentLabel = '正在确认撤销';
      else if (state.consent && state.consent.status === 'active') {
        consentLabel = Number(state.consent.expiresAt) <= Date.now()
          ? '授权已过期 · ' + formatDate(state.consent.expiresAt)
          : 'Home Node 已保存 · 有效至 ' + formatDate(state.consent.expiresAt);
      } else if (state.consent && state.consent.status) consentLabel = '授权' + state.consent.status;
      else if (state.consentRevoked) consentLabel = '旧授权已关闭 · 重新确认即可继续';
      else if (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) >= 0) consentLabel = '终态 Run · 授权已关闭';
      else if (state.run) consentLabel = '未加载授权；确认后由 Home Node 保存并启动';
      consentState.textContent = consentLabel;
    }
    renderProviders(state);
    renderFiles(state);
    renderPermissionSummary(state);
    renderMemoryRecall(state);
    renderMemoryDerivedConsent(state);
    renderActiveRuns(state);
    renderResults(state);
    renderRunEvents(state);
    renderRuntimeDiagnostics(state);
    renderMemoryProvenance(state);
    renderExecutionStages(state);
    var taskEmpty = byId('wm-task-empty');
    if (taskEmpty) taskEmpty.hidden = state.activeRuns.length > 0;
    var resultEmpty = byId('wm-result-empty');
    if (resultEmpty) resultEmpty.hidden = state.results.length > 0;
    var resultLimit = byId('wm-results-limit');
    if (resultLimit) resultLimit.hidden = state.resultsHasMore !== true;
    renderSelectedResult(state.selectedResult);
    renderMemoryCandidate(state);
    var memoryDisclosure = byId('wm-memory-disclosure');
    var inspector = byId('wm-inspector-details');
    if (memoryDisclosure && state.memorySnapshot && state.memorySnapshot.ok
      && state.memorySnapshot.recordCount > 0 && state.memorySelectedIds.length > 0) memoryDisclosure.open = true;
    if (inspector && state.memoryCandidate) {
      inspector.open = true;
      if (memoryDisclosure) memoryDisclosure.open = true;
    }
    syncInspectorButton();
    var confirm = byId('wm-consent-check');
    if (confirm) {
      if (state.confirmedKey !== state.currentGrantKey) confirm.checked = false;
      confirm.disabled = state.busy === 'granting' || state.busy === 'starting';
    }
    var codingRun = !!(state.run && state.run.workflowId === 'coding.workspace');
    var codingTaskLabel = byId('wm-coding-task-label');
    if (codingTaskLabel) codingTaskLabel.hidden = !codingRun;
    var writeLabel = byId('wm-workspace-write-label');
    var writeCheck = byId('wm-workspace-write-check');
    if (writeLabel) writeLabel.hidden = !codingRun;
    if (writeCheck) {
      writeCheck.checked = codingRun && state.workspaceWriteAccepted === true;
      writeCheck.disabled = !codingRun || state.busy === 'granting' || state.busy === 'starting';
    }
    var starts = byId('wm-start-run');
    var savedConsentActive = !!(state.consentId && state.consent && state.consent.status === 'active');
    var permissionReady = !!(state.preview && state.fileIds.length
      && state.confirmedKey && state.confirmedKey === state.currentGrantKey && state.storageRiskAccepted);
    if (starts) starts.disabled = state.busy === 'granting' || state.busy === 'starting'
      || !state.run || state.run.status !== 'queued' || state.revocationRequired
      || !state.storageRiskAccepted || (!savedConsentActive && !permissionReady)
      || (codingRun && !(state.consent && state.consent.workspaceWriteConfirmed === true)
        && state.workspaceWriteAccepted !== true)
      || (state.executor === 'dsh' && (!dshEnabled || typeof runtime.startDsh !== 'function'));
    if (starts) starts.textContent = savedConsentActive ? '启动已授权任务'
      : (codingRun ? '确认权限并启动 Coding Run'
        : (state.executor === 'dsh' ? '确认权限并启动 DSH' : '确认权限并启动 Native'));
    var cancels = byId('wm-cancel-run');
    if (cancels) cancels.disabled = !state.run || ['completed', 'failed', 'cancelled'].indexOf(state.run.status) >= 0;
    var revokes = byId('wm-revoke-consent');
    if (revokes) revokes.disabled = !state.consentId || state.busy === 'starting';
    var storageCheck = byId('wm-storage-check');
    if (storageCheck) {
      storageCheck.checked = state.storageRiskAccepted;
      storageCheck.disabled = state.busy === 'granting';
    }
  }
  async function mount() {
    var projectSelect = byId('wm-project-select');
    var profileSelect = byId('wm-profile-select');
    if (!projectSelect || !profileSelect) return;
    var projects = [], projectLoadFailed = false;
    try {
      if (workspace && typeof workspace.wsGetWorkModeProjects === 'function') {
        var projectResult = await workspace.wsGetWorkModeProjects();
        if (!projectResult || projectResult.ok !== true || !Array.isArray(projectResult.projects)) projectLoadFailed = true;
        else projects = projectResult.projects;
      } else {
        projects = await workspace.wsGetProjects();
        if (!Array.isArray(projects)) projectLoadFailed = true;
      }
    } catch (_) { projectLoadFailed = true; }
    resetChildren(projectSelect);
    option(projectSelect, '', projectLoadFailed ? 'Workspace 读取失败' : (projects.length ? '选择本地项目' : '没有可选择的本地项目'));
    projects.filter(function (project) { return project && project.id; }).forEach(function (project) {
      var name = typeof project.name === 'string' && project.name.trim() ? project.name.trim() : String(project.id);
      var projectPath = typeof project.path === 'string' && project.path.trim() ? project.path.trim() : '路径未记录';
      option(projectSelect, project.id, name + ' · ' + projectPath + ' · ' + project.id);
    });
    await controller.restoreProjectDraft();
    projectSelect.value = controller.getState().selectedProjectRef || '';
    await refreshAgentProfileOptions(profileSelect);
    var projectNav = byId('wm-project-nav');
    var inspector = byId('wm-inspector-details');
    if (root.matchMedia && root.matchMedia('(max-width: 760px)').matches) {
      if (projectNav) projectNav.open = false;
      if (inspector) inspector.open = false;
    }
    projectSelect.addEventListener('change', async function () {
      var projectRef = projectSelect.value;
      var selected = await controller.setSelectedProject(projectRef);
      if (selected && selected.ok) {
        await controller.refreshMemoryRecall(projectRef);
        openInspector('wm-files-disclosure');
      }
      render();
    });
    profileSelect.addEventListener('change', async function () {
      await controller.setProfileRef(profileSelect.value);
      if (controller.getState().run && profileSelect.value) await controller.previewAuthorization();
      render();
    });
    var executorSelect = byId('wm-executor-select');
    if (executorSelect) executorSelect.addEventListener('change', function () {
      controller.setExecutor(executorSelect.value).then(render);
    });
    async function createSelectedRun() {
      var created = await controller.createRun(projectSelect.value);
      if (created.ok && profileSelect.value) {
        await controller.setProfileRef(profileSelect.value);
        await controller.previewAuthorization();
      }
      render();
    }
    byId('wm-create-run').addEventListener('click', createSelectedRun);
    var emptyCreate = byId('wm-empty-create-run');
    if (emptyCreate) emptyCreate.addEventListener('click', function () {
      var state = controller.getState();
      var files = state.preview && state.preview.files || state.projectSnapshot && state.projectSnapshot.files || [];
      if (!files.length) {
        openInspector('wm-files-disclosure');
        var folderPicker = byId('wm-folder-picker');
        var filePicker = byId('wm-file-picker');
        if (folderPicker) folderPicker.click();
        else if (filePicker) filePicker.click();
      } else if (!state.fileIds.length) {
        openInspector('wm-files-disclosure');
      } else createSelectedRun();
    });
    function handleProjectImport(input) {
      var selectedFiles = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (!selectedFiles.length) return;
      controller.importProjectFiles(selectedFiles).then(function (result) {
        var state = controller.getState();
        if (result && result.projectRef && projectSelect
          && !Array.prototype.some.call(projectSelect.options, function (item) { return item.value === result.projectRef; })) {
          var projectName = state.projectSnapshot && state.projectSnapshot.projectName || result.projectRef;
          var projectPath = state.projectSnapshot && state.projectSnapshot.projectPath || '路径未记录';
          option(projectSelect, result.projectRef, projectName + ' · ' + projectPath + ' · ' + result.projectRef);
        }
        projectSelect.value = state.selectedProjectRef || '';
        openInspector('wm-files-disclosure');
        render();
      });
    }
    var filePicker = byId('wm-file-picker');
    var folderPicker = byId('wm-folder-picker');
    var pickFilesButton = byId('wm-import-files');
    var pickFolderButton = byId('wm-import-folder');
    if (pickFilesButton && filePicker) pickFilesButton.addEventListener('click', function () { filePicker.click(); });
    if (pickFolderButton && folderPicker) pickFolderButton.addEventListener('click', function () { folderPicker.click(); });
    if (filePicker) filePicker.addEventListener('change', function () { handleProjectImport(filePicker); });
    if (folderPicker) folderPicker.addEventListener('change', function () { handleProjectImport(folderPicker); });
    var inspectorToggle = byId('wm-inspector-toggle');
    if (inspectorToggle && inspector) {
      inspectorToggle.addEventListener('click', function () {
        inspector.open = !inspector.open;
        syncInspectorButton();
        if (inspector.open) {
          var summary = inspector.querySelector('summary');
          if (summary) summary.focus();
        }
      });
      inspector.addEventListener('toggle', syncInspectorButton);
      root.document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && inspector.open) {
          inspector.open = false;
          syncInspectorButton();
          inspectorToggle.focus();
        }
      });
    }
    var openAuthorization = byId('wm-open-authorization');
    if (openAuthorization) openAuthorization.addEventListener('click', function () {
      openInspector('wm-authorization-disclosure');
      var files = byId('wm-files-disclosure');
      if (files) files.open = true;
    });
    byId('wm-refresh-preview').addEventListener('click', function () { controller.previewAuthorization().then(render); });
    byId('wm-refresh-events').addEventListener('click', function () {
      var state = controller.getState();
      var activeRun = state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0;
      var runId = activeRun && state.run ? state.run.runId
        : (state.selectedResult && state.selectedResult.run && state.selectedResult.run.runId
          || state.run && state.run.runId);
      controller.refreshRunEvents(runId).then(render);
    });
    byId('wm-consent-check').addEventListener('change', function (event) { controller.confirmScope(event.target.checked); render(); });
    byId('wm-workspace-write-check').addEventListener('change', function (event) {
      controller.confirmWorkspaceWrite(event.target.checked).then(render);
    });
    byId('wm-memory-consent-check').addEventListener('change', function (event) {
      controller.confirmMemoryScope(event.target.checked);
      render();
    });
    byId('wm-derived-review-check').addEventListener('change', function (event) {
      controller.confirmMemoryDerivedConsent('review', event.target.checked).then(render);
    });
    byId('wm-derived-result-check').addEventListener('change', function (event) {
      controller.confirmMemoryDerivedConsent('result', event.target.checked).then(render);
    });
    byId('wm-storage-check').addEventListener('change', function (event) { controller.confirmStorageRisk(event.target.checked).then(render); });
    byId('wm-start-run').addEventListener('click', function () {
      controller.confirmAndStart(Number(byId('wm-expiry-select').value), {
        taskPrompt: String((byId('wm-coding-task') && byId('wm-coding-task').value) || '').trim()
      }).then(render);
    });
    byId('wm-cancel-run').addEventListener('click', function () {
      if (!root.confirm('取消此 Run 并撤销其授权？')) return;
      controller.cancel().then(render);
    });
    byId('wm-revoke-consent').addEventListener('click', function () {
      if (!root.confirm('立即撤销授权？运行中的 Run 将被取消。')) return;
      controller.revokeConsent().then(render);
    });
    byId('wm-refresh-ledger').addEventListener('click', function () { controller.refresh().then(render); });
    byId('wm-memory-candidate-confirm').addEventListener('change', function (event) {
      controller.confirmMemoryCandidate(event.target.checked);
      render();
    });
    byId('wm-memory-candidate-write').addEventListener('click', function () {
      controller.commitMemoryCandidate(true).then(render);
    });
    render();
    if (root.location && root.location.hash === '#work-mode') {
      await controller.refresh();
      render();
    }
  }
  function boot() {
    syncWorkRouteChrome();
    mount().catch(function () { setText('wm-work-status', 'Work Mode 暂不可用。'); });
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  root.addEventListener('hashchange', function () {
    syncWorkRouteChrome();
    if (root.location && root.location.hash === '#work-mode') {
      refreshAgentProfileOptions(byId('wm-profile-select')).then(function () {
        return controller.refresh();
      }).then(render);
    }
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function resultReviewKey(selectedResult) {
    var run = selectedResult && selectedResult.run;
    var result = selectedResult && selectedResult.result;
    return run && run.runId && result && result.resultId
      ? String(run.runId) + ':' + String(result.resultId) : '';
  }

  function isWorkspaceSnapshotChangeEvent(event) {
    if (!event || event.executor !== 'dsh' || event.toolName !== 'project.read_file') return false;
    var reason = String(event.reasonCode || event.reason || '');
    return event.code === 'workspace-changed-snapshot'
      || (event.code === 'workspace-changed' && reason === 'snapshot-mismatch');
  }

  function runEventLabel(event) {
    if (event && event.actionTrace) {
      var actionLabels = {
        'ib.work.plan.v1': '制定执行计划',
        'ib.project.inspect.v1': '检查授权项目结构',
        'ib.result.compare.v1': '比较 Result Artifact',
        'ib.workspace.read_file.v1': '读取 Workspace 文件',
        'ib.work.result.generate.v1': '生成结果',
        'ib.work.review_result.v1': '审阅结果',
        'ib.work.persist_result.v1': '保存结果'
      };
      var traceStatuses = { succeeded: '成功', failed: '失败', denied: '已拒绝' };
      return (actionLabels[event.actionTrace.actionId] || 'Action 调用') + ' · '
        + (traceStatuses[event.actionTrace.status] || String(event.actionTrace.status || '未知'));
    }
    if (event && event.executor === 'dsh') {
      if (isWorkspaceSnapshotChangeEvent(event)) return 'Workspace 快照已变化';
      var dshLabels = {
        'run-started': '任务已启动',
        'model-preflight': '权限与模型路由已复核',
        'model-send': '正在联系模型',
        'tool-call': '正在使用工具',
        'project-read': '文件读取完成',
        'tool-denied': '工具调用被拒绝',
        'run-cancel-requested': '收到取消请求',
        'run-completed': '结果已保存',
        'run-failed': '执行失败'
      };
      return dshLabels[event.executionEvent] || '执行事件';
    }
    var reasons = {
      runtime_started: 'Runtime 已启动', runtime_completed: '审计完成',
      runtime_failed: 'Runtime 失败', runtime_cancelled: 'Runtime 已取消',
      user_cancelled: '收到取消请求', runtime_interrupted: '重启后中断'
    };
    if (event && event.reasonCode && reasons[event.reasonCode]) return reasons[event.reasonCode];
    var statuses = {
      queued: '等待授权', running: '执行中', cancel_requested: '等待取消确认',
      completed: '已完成', failed: '失败', cancelled: '已取消'
    };
    return statuses[event && event.toStatus] || String(event && event.eventType || '状态变化');
  }

  function runEventDetail(event) {
    if (event && event.actionTrace) {
      var trace = event.actionTrace;
      var authorityLabels = { allowed: '已授权', denied: '未授权', not_checked: '未完成校验' };
      return [
        'Action ' + String(trace.actionId || ''),
        'Request ' + String(trace.requestId || ''),
        'Run ' + String(trace.runId || event.runId || ''),
        'Authority ' + (authorityLabels[trace.authorityResult] || '未知')
      ].join(' · ');
    }
    if (event && event.executor === 'dsh') {
      if (event.toolName === 'project.read_file') {
        if (isWorkspaceSnapshotChangeEvent(event)) {
          return [event.path || event.fileId || '', 'Workspace 与授权快照不一致'].filter(Boolean).join(' · ');
        }
        return [event.path || event.fileId || '', event.code || ''].filter(Boolean).join(' · ');
      }
      if (event.executionEvent === 'model-send') return '第 ' + String(event.call || '—') + ' 次模型请求';
      return event.code || event.reason || event.toStatus || '';
    }
    return (event.fromStatus ? event.fromStatus + ' → ' : '') + (event.toStatus || '');
  }

  var EXECUTION_STAGE_DEFINITIONS = [
    { key: 'planning', label: 'Planning', detail: '按任务范围形成执行计划。' },
    { key: 'workspace-read', label: 'Workspace Read', detail: '读取已授权 Workspace 范围内的文件。' },
    { key: 'processing', label: 'Processing', detail: '处理已读取内容并组织结果。' },
    { key: 'result-generation', label: 'Result Generation', detail: '生成并保存 Work Result。' },
    { key: 'review', label: 'Review', detail: 'Middle Brain 在 Run 完成前审阅结果。' }
  ];

  function deriveExecutionStages(run, events, eventStatus) {
    var status = String(run && run.status || '');
    var ordered = Array.isArray(events) ? events.filter(function (event) { return event && typeof event === 'object'; }).slice() : [];
    ordered.sort(function (left, right) {
      var timeDelta = (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
      return timeDelta || ((Number(left.sequence) || 0) - (Number(right.sequence) || 0));
    });
    var stageStates = Object.create(null);
    EXECUTION_STAGE_DEFINITIONS.forEach(function (stage) { stageStates[stage.key] = 'unrecorded'; });
    var currentStage = '';
    var lastObservedStage = '';
    var hasDetailedEvents = false;
    var hasLifecycleEvent = false;
    var currentReadDenied = false;
    var currentReadSnapshotChanged = false;

    if (status === 'queued') {
      EXECUTION_STAGE_DEFINITIONS.forEach(function (stage) { stageStates[stage.key] = 'pending'; });
      return {
        currentStage: '', precision: 'lifecycle', summary: 'Run 等待授权，尚未进入执行阶段。',
        stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage) {
          return { key: stage.key, label: stage.label, status: 'pending', statusLabel: '未开始', detail: stage.detail };
        })
      };
    }

    ordered.forEach(function (event) {
      var eventName = String(event.executionEvent || '').toLowerCase();
      var toolName = String(event.toolName || '');
      if (event.reasonCode === 'runtime_started' || event.toStatus === 'running') hasLifecycleEvent = true;
      if (event.executor !== 'dsh' && !eventName) return;
      hasDetailedEvents = true;

      if (eventName === 'run-started') {
        stageStates.planning = 'done';
        currentStage = 'processing';
        lastObservedStage = currentStage;
      } else if (eventName === 'model-preflight' || eventName === 'model-send') {
        stageStates.planning = 'done';
        if (stageStates.processing === 'unrecorded') stageStates.processing = 'active';
        currentStage = 'processing';
        lastObservedStage = currentStage;
      } else if (eventName === 'tool-call' && toolName === 'project.read_file') {
        if (stageStates.processing === 'active') stageStates.processing = 'done';
        stageStates['workspace-read'] = 'active';
        currentStage = 'workspace-read';
        lastObservedStage = currentStage;
        currentReadDenied = false;
        currentReadSnapshotChanged = false;
      } else if (eventName === 'project-read' && toolName === 'project.read_file') {
        stageStates['workspace-read'] = 'done';
        stageStates.processing = 'active';
        currentStage = 'processing';
        lastObservedStage = currentStage;
        currentReadDenied = false;
        currentReadSnapshotChanged = false;
      } else if (eventName === 'tool-denied' && toolName === 'project.read_file') {
        stageStates['workspace-read'] = 'failed';
        currentStage = 'workspace-read';
        lastObservedStage = currentStage;
        currentReadSnapshotChanged = isWorkspaceSnapshotChangeEvent(event);
        currentReadDenied = !currentReadSnapshotChanged;
      } else if (eventName === 'run-completed') {
        lastObservedStage = 'result-generation';
      }
    });

    if (status === 'completed') {
      EXECUTION_STAGE_DEFINITIONS.forEach(function (stage) { stageStates[stage.key] = 'done'; });
      return {
        currentStage: '', precision: hasDetailedEvents ? 'events' : 'lifecycle',
        summary: hasDetailedEvents
          ? 'Run 已完成；阶段轨迹来自现有 Run Event。'
          : 'Run 已完成；没有细分事件，阶段按 Home Node 终态展示。',
        stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage) {
          return { key: stage.key, label: stage.label, status: 'done', statusLabel: '已完成', detail: stage.detail };
        })
      };
    }

    if (status === 'running' || status === 'cancel_requested') {
      if (!hasDetailedEvents && hasLifecycleEvent) {
        stageStates.processing = 'active';
        return {
          currentStage: 'processing', precision: 'coarse',
          summary: 'Run 正在执行。现有 Run Event 只记录生命周期；Processing 是整体执行阶段，不代表具体子步骤。',
          stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage) {
            var state = stageStates[stage.key];
            return { key: stage.key, label: stage.label, status: state,
              statusLabel: state === 'active' ? '执行中' : '未记录',
              detail: state === 'active' ? '只读执行中；细分阶段没有单独事件。' : '现有 Run Event 未单独记录此阶段。' };
          })
        };
      }
      if (!hasDetailedEvents) {
        return {
          currentStage: '', precision: 'none',
          summary: eventStatus === 'loading' ? '正在读取 Run Event；暂不推断当前阶段。'
            : (eventStatus === 'unavailable' || eventStatus && eventStatus !== 'ready'
              ? 'Run Event 暂不可用；只显示 Run 状态，不推断细分阶段。'
              : '暂无阶段事件；只显示 Run 状态，不推断细分阶段。'),
          stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage) {
            return { key: stage.key, label: stage.label, status: 'unrecorded',
              statusLabel: '未记录', detail: '暂无可用于判断此阶段的 Run Event。' };
          })
        };
      }
      if (!currentStage && hasLifecycleEvent) {
        stageStates.processing = 'active';
        currentStage = 'processing';
      }
      var summary = currentStage
        ? '当前阶段依据最后一条相关 Run Event 投影；阶段列表不增加新的 Runtime 事件。'
        : 'Run Event 尚未记录可识别阶段；不推断当前子步骤。';
      return {
        currentStage: currentStage, precision: 'events', summary: summary,
        stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage, index) {
          var stageState = stageStates[stage.key];
          if (stage.key === currentStage && stageState !== 'failed') stageState = 'active';
          var labels = { active: '进行中', done: '已完成', failed: '读取被拒', pending: '等待中', unrecorded: '未记录' };
          var detail = stageState === 'unrecorded' ? '现有 Run Event 未单独记录此阶段。' : stage.detail;
          if (stage.key === 'review' && stageState === 'unrecorded') detail = 'Review 没有独立事件；以 Run 完成状态为准。';
          if (stage.key === 'workspace-read' && currentReadSnapshotChanged && stageState === 'failed') {
            detail = '授权快照与当前 Workspace 不一致；刷新快照并重新授权后再发起 Run。';
          } else if (stage.key === 'workspace-read' && currentReadDenied && stageState === 'failed') {
            detail = 'Home Node 记录了项目读取拒绝；具体错误见下方事件轨迹。';
          }
          return { key: stage.key, label: stage.label, status: stageState,
            statusLabel: stageState === 'failed' && stage.key === 'workspace-read' && currentReadSnapshotChanged
              ? '快照已变化' : (labels[stageState] || '未记录'), detail: detail };
        })
      };
    }

    var isFailed = status === 'failed';
    var isCancelled = status === 'cancelled';
    var terminalSummary = isFailed ? 'Run 已失败；最后可见阶段仅用于定位，不能据此判断故障原因。'
      : (isCancelled ? 'Run 已取消；阶段轨迹停留在最后一条可见事件。' : 'Run 尚无可识别的执行阶段。');
    var lastIndex = EXECUTION_STAGE_DEFINITIONS.findIndex(function (stage) { return stage.key === lastObservedStage; });
    return {
      currentStage: '', precision: hasDetailedEvents ? 'events' : 'none', summary: terminalSummary,
      stages: EXECUTION_STAGE_DEFINITIONS.map(function (stage, index) {
        var stageState = stageStates[stage.key];
        if (index === lastIndex && (isFailed || isCancelled)) {
          stageState = currentReadDenied || currentReadSnapshotChanged ? 'failed' : 'last-observed';
        }
        else if (lastIndex >= 0 && index < lastIndex && stageState === 'unrecorded') stageState = 'done';
        if (stageState === 'failed' && !currentReadDenied && !currentReadSnapshotChanged) stageState = 'last-observed';
        var labels = { done: '已完成', pending: '等待中', unrecorded: '未记录', failed: '读取被拒', 'last-observed': '最后可见' };
        var detail = stageState === 'unrecorded' ? '现有 Run Event 未单独记录此阶段。'
          : (stageState === 'last-observed' ? 'Run 终止前最后可见阶段；不是故障原因判定。' : stage.detail);
        if (stageState === 'failed' && stage.key === 'workspace-read' && currentReadSnapshotChanged) {
          detail = '授权快照与当前 Workspace 不一致；具体快照内容未进入事件轨迹。';
        } else if (stageState === 'failed' && stage.key === 'workspace-read') {
          detail = 'Home Node 记录了项目读取拒绝；具体错误见下方事件轨迹。';
        }
        return { key: stage.key, label: stage.label, status: stageState,
          statusLabel: stageState === 'failed' && stage.key === 'workspace-read' && currentReadSnapshotChanged
            ? '快照已变化' : (labels[stageState] || '未记录'),
          detail: detail };
      })
    };
  }

  var RUNTIME_DIAGNOSTIC_ACTIONS = {
    'ib.work.plan.v1': { stage: 'planning', step: 'Planning' },
    'ib.project.inspect.v1': { stage: 'workspace-read', step: 'Project Inspect' },
    'ib.result.compare.v1': { stage: 'review', step: 'Result Compare' },
    'ib.workspace.read_file.v1': { stage: 'workspace-read', step: 'Workspace Read' },
    'ib.work.result.generate.v1': { stage: 'result-generation', step: 'Result Generation' },
    'ib.work.review_result.v1': { stage: 'review', step: 'Review' },
    'ib.work.persist_result.v1': { stage: 'result-generation', step: 'Result 保存' }
  };

  function deriveRuntimeDiagnostics(run, events, eventStatus, memoryProvenance, nowMs, consentState) {
    if (!run) return {
      stateLabel: '暂无 Run', currentPhase: '—', currentDetail: '选择 Run 后显示运行诊断。',
      completedSteps: [], failure: null, authority: '未读取', consent: '未读取', memory: '未读取',
      summary: '诊断只读取当前 Run 已有事件与状态。', hint: '选择任务以查看阶段、授权状态和可操作提示。'
    };

    var runId = String(run.runId || '');
    var status = String(run.status || '');
    var ordered = Array.isArray(events) ? events.filter(function (event) {
      return event && typeof event === 'object';
    }).slice() : [];
    ordered.sort(function (left, right) {
      var timeDelta = (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
      if (timeDelta) return timeDelta;
      var leftSequence = Number(left.sequence);
      var rightSequence = Number(right.sequence);
      if (!Number.isFinite(leftSequence)) leftSequence = parseInt(String(left.sequence || '').replace(/^d/, ''), 10) || 0;
      if (!Number.isFinite(rightSequence)) rightSequence = parseInt(String(right.sequence || '').replace(/^d/, ''), 10) || 0;
      return leftSequence - rightSequence;
    });

    var traces = ordered.filter(function (event) {
      var trace = event.actionTrace;
      return trace && trace.runId === runId
        && (RUNTIME_DIAGNOSTIC_ACTIONS[trace.actionId]
          || (typeof trace.actionId === 'string' && /^ib\.[A-Za-z0-9_.-]{1,120}\.v[0-9]+$/.test(trace.actionId)))
        && ['succeeded', 'failed', 'denied'].indexOf(trace.status) >= 0
        && ['allowed', 'denied', 'not_checked'].indexOf(trace.authorityResult) >= 0;
    });
    var completedSteps = [];
    var completedKeys = Object.create(null);
    function addCompleted(key, label) {
      if (!completedKeys[key]) {
        completedKeys[key] = true;
        completedSteps.push(label);
      }
    }
    traces.forEach(function (event) {
      if (event.actionTrace.status === 'succeeded') {
        var definition = RUNTIME_DIAGNOSTIC_ACTIONS[event.actionTrace.actionId];
        addCompleted('action:' + event.actionTrace.actionId, definition.step);
      }
    });

    ordered.forEach(function (event) {
      if (event.executor !== 'dsh') return;
      if (event.executionEvent === 'model-preflight') addCompleted('dsh:preflight', '权限与模型路由复核');
      else if (event.executionEvent === 'project-read' && event.toolName === 'project.read_file') {
        addCompleted('action:ib.workspace.read_file.v1', 'Workspace Read');
      } else if (event.executionEvent === 'run-completed') addCompleted('dsh:result-saved', 'Result 保存');
    });

    var eventReady = eventStatus === 'ready';
    var stageProjection = deriveExecutionStages(run, ordered, eventStatus);
    var failure = null;
    var latestTrace = traces.length ? traces[traces.length - 1].actionTrace : null;
    var lastFailedTrace = latestTrace && (latestTrace.status === 'failed' || latestTrace.status === 'denied')
      ? latestTrace : null;
    if (lastFailedTrace) {
      var failedDefinition = RUNTIME_DIAGNOSTIC_ACTIONS[lastFailedTrace.actionId] || null;
      var failedStage = failedDefinition && EXECUTION_STAGE_DEFINITIONS.find(function (stage) {
        return stage.key === failedDefinition.stage;
      });
      var failureNote;
      if (lastFailedTrace.actionId === 'ib.project.inspect.v1') {
        failureNote = lastFailedTrace.status === 'denied'
          ? 'Project Inspect 被 Action Registry、Consent 或 Workspace 范围校验拒绝；Trace 不记录更细的拒绝原因。'
          : 'Project Inspect 未能生成安全结构摘要；Trace 不包含具体错误，需检查 Workspace 可访问性与授权快照。';
      } else if (lastFailedTrace.actionId === 'ib.result.compare.v1') {
        failureNote = lastFailedTrace.status === 'denied'
          ? 'Result Compare 被拒绝：Artifact 引用可能不可用，或不属于当前 Run 的项目范围。Trace 不包含 Artifact 内容。'
          : 'Result Compare 未能读取并比较 Artifact 元数据；Trace 不包含 Result 内容。';
      } else {
        failureNote = lastFailedTrace.authorityResult === 'denied'
          ? 'Action Trace 标记 Authority / Action gate 拒绝；未区分 Registry、Consent 与范围原因。'
          : (lastFailedTrace.status === 'denied'
            ? 'Action Trace 标记调用被拒绝；未记录具体拒绝方。'
            : 'Action Trace 标记执行失败；Trace 未包含详细错误内容。');
      }
      failure = {
        location: failedStage ? failedStage.label : 'Action 阶段未映射',
        basis: 'action_trace',
        note: failureNote,
        authorityDenied: lastFailedTrace.authorityResult === 'denied'
      };
    }
    if (!failure) {
      var lastReadOutcome = null;
      var dshFailure = null;
      ordered.forEach(function (event) {
        if (event.executor !== 'dsh') return;
        if ((event.executionEvent === 'tool-denied' || event.executionEvent === 'project-read')
          && event.toolName === 'project.read_file') {
          var snapshotMismatch = isWorkspaceSnapshotChangeEvent(event);
          lastReadOutcome = {
            snapshotMismatch: snapshotMismatch,
            denied: event.executionEvent === 'tool-denied' && !snapshotMismatch
          };
        }
        if (event.executionEvent === 'run-failed') dshFailure = event;
      });
      if (lastReadOutcome && lastReadOutcome.snapshotMismatch) {
        failure = { location: 'Workspace Read', basis: 'run_event', snapshotMismatch: true, authorityDenied: false,
          note: '授权快照与当前 Workspace 不一致；具体快照内容未进入事件轨迹。' };
      } else if (lastReadOutcome && lastReadOutcome.denied) {
        failure = { location: 'Workspace Read', basis: 'run_event',
          note: 'Home Node 记录了 Workspace Read 拒绝；详细事件可在下方执行轨迹查看。', authorityDenied: true };
      } else if (status === 'failed') {
        var lastObserved = stageProjection.stages.find(function (stage) {
          return stage.status === 'last-observed' || stage.status === 'failed';
        });
        if (lastObserved) failure = {
          location: lastObserved.label + '（最后可见阶段）', basis: 'last_observed',
          note: '现有事件只能标出最后可见阶段，不能确认它就是故障原因。', authorityDenied: false
        };
        else if (dshFailure) failure = {
          location: '具体阶段未记录', basis: 'run_event',
          note: 'Home Node 记录了执行失败，但现有事件未定位到具体 Action。', authorityDenied: false
        };
      }
    }

    var stateLabels = { queued: '等待授权', running: '执行中', cancel_requested: '等待取消确认',
      completed: '已完成', failed: '失败', cancelled: '已取消' };
    var currentPhase = stateLabels[status] || '状态未知';
    var currentDetail = '';
    if (status === 'failed') {
      currentPhase = failure ? failure.location : '失败 · 阶段未定位';
      currentDetail = failure ? failure.note : '没有可定位失败阶段的 Action Trace 或 Run Event。';
    } else if (status === 'running' || status === 'cancel_requested') {
      var currentStage = stageProjection.currentStage && EXECUTION_STAGE_DEFINITIONS.find(function (stage) {
        return stage.key === stageProjection.currentStage;
      });
      if (lastFailedTrace) {
        var activeFailureDefinition = RUNTIME_DIAGNOSTIC_ACTIONS[lastFailedTrace.actionId] || null;
        var activeFailureStage = EXECUTION_STAGE_DEFINITIONS.find(function (stage) {
          return activeFailureDefinition && stage.key === activeFailureDefinition.stage;
        });
        currentPhase = (activeFailureStage ? activeFailureStage.label : 'Action 阶段未映射')
          + (lastFailedTrace.status === 'denied' ? ' · 已拒绝' : ' · 失败');
        currentDetail = failure && failure.note || '';
      } else if (currentStage) {
        currentPhase = currentStage.label;
        currentDetail = stageProjection.summary;
      } else if (traces.length) {
        var latestAction = RUNTIME_DIAGNOSTIC_ACTIONS[traces[traces.length - 1].actionTrace.actionId];
        currentPhase = '执行中';
        currentDetail = '最近记录的 Action：' + latestAction.step + '；当前子阶段没有单独事件。';
      } else currentDetail = stageProjection.summary;
    } else if (status === 'completed') {
      currentDetail = eventReady && (traces.length || ordered.some(function (event) { return event.executor === 'dsh'; }))
        ? 'Home Node 确认 Run 已完成；下方步骤仅列出有成功事件的操作。'
        : 'Home Node 确认 Run 已完成；没有足够的细分事件还原完整 Action 路径。';
    } else if (status === 'queued') {
      currentDetail = 'Run 尚未进入执行阶段。';
    } else if (status === 'cancelled') {
      currentDetail = 'Run 已取消；阶段仅反映取消前可见的事件。';
    }

    var authority = '未记录 Action Authority 结果';
    if (!eventReady) authority = eventStatus === 'loading' ? 'Action Trace 读取中' : 'Action Trace 暂不可用';
    else if (traces.length) {
      var authorityCounts = { allowed: 0, denied: 0, not_checked: 0 };
      traces.forEach(function (event) { authorityCounts[event.actionTrace.authorityResult]++; });
      var latestAuthority = traces[traces.length - 1].actionTrace.authorityResult;
      var authorityLabels = { allowed: '已授权', denied: '未授权', not_checked: '未完成校验' };
      authority = '最近 Action：' + authorityLabels[latestAuthority] + ' · Trace ' + traces.length
        + ' 条（' + authorityCounts.allowed + ' 已授权 / ' + authorityCounts.denied + ' 拒绝 / '
        + authorityCounts.not_checked + ' 未校验）';
    }
    var dshDenialCount = eventReady ? ordered.filter(function (event) {
      return event.executor === 'dsh' && event.executionEvent === 'tool-denied'
        && !isWorkspaceSnapshotChangeEvent(event);
    }).length : 0;
    if (dshDenialCount) authority += (traces.length ? ' · ' : '')
      + 'DSH Host 记录 ' + dshDenialCount + ' 次工具拒绝（未细分 Consent 与工具范围）';

    var consent = 'Consent 状态未加载';
    var consentSource = memoryProvenance && memoryProvenance.status === 'ready' && memoryProvenance.consent
      || (consentState && consentState.runId === runId && typeof consentState.status === 'string' ? consentState : null);
    if (consentSource) {
      var consentStatus = String(consentSource.status || 'unknown');
      var nowValue = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      if (consentStatus === 'active' && Number(consentSource.expiresAt) > 0 && Number(consentSource.expiresAt) <= nowValue) {
        consentStatus = 'expired';
      }
      var consentLabels = { active: '有效', revoked: '已撤销', expired: '已过期', not_found: '无授权记录', unknown: '状态未知' };
      consent = consentLabels[consentStatus] || '状态未知';
    } else if (memoryProvenance && memoryProvenance.status === 'loading') consent = 'Consent 状态读取中';
    else if (memoryProvenance && memoryProvenance.status !== 'ready') consent = 'Consent 状态暂不可用';

    var memory = 'Memory Provenance 未加载';
    if (memoryProvenance && memoryProvenance.status === 'ready') {
      var memoryScope = memoryProvenance.consent && memoryProvenance.consent.memoryScope;
      var memoryCount = Array.isArray(memoryProvenance.records) ? memoryProvenance.records.length : 0;
      var resultMarker = memoryProvenance.result && typeof memoryProvenance.result.memoryDerived === 'boolean'
        ? (memoryProvenance.result.memoryDerived ? ' · Result memory-derived' : ' · Result 非 Memory 衍生')
        : ' · Result 标记未记录';
      memory = memoryScope ? 'Agent Memory 引用 ' + memoryCount + ' 条' + resultMarker : '未授权 Agent Memory Recall' + resultMarker;
    } else if (memoryProvenance) memory = memoryProvenance.status === 'loading'
      ? 'Memory Provenance 读取中' : 'Memory Provenance 暂不可用';

    var hint;
    if (failure && failure.snapshotMismatch) {
      hint = '刷新 Workspace 文件快照，并按现有流程为新 Run 重新核对和授权；当前 Run 不会沿用旧快照。';
    } else if (failure && failure.authorityDenied) {
      hint = failure.basis === 'run_event'
        ? '核对 Home Node Consent 与 Host 工具范围；需要重试时按现有流程创建并授权新 Run。'
        : '核对 Action Registry 映射、Home Node Consent 与请求范围；Trace 未指出具体拒绝源。需要重试时按现有流程创建并授权新 Run。';
    } else if (status === 'failed' && failure && failure.basis === 'action_trace') {
      hint = '查看该 Action 前后的执行轨迹；Trace 只记录阶段与 Authority 结果，不含详细错误正文。';
    } else if (status === 'failed') {
      hint = '查看 Home Node 执行轨迹和 Result 状态；当前事件不足以确认具体故障原因。';
    } else if (status === 'queued') {
      hint = '核对 Workspace、Provider 与 Result 风险范围，完成明确授权后再启动 Run。';
    } else if (status === 'running' || status === 'cancel_requested') {
      hint = eventReady ? '可刷新执行轨迹；当前阶段依据已记录事件投影。' : '事件暂不可用；刷新执行轨迹后再查看细分阶段。';
    } else if (status === 'completed') {
      hint = '可在 Result Review 中查看摘要、来源与待确认项目。';
    } else if (status === 'cancelled') {
      hint = '此 Run 不会自动恢复；继续工作时按现有流程创建新的 Run。';
    } else hint = '查看 Home Node 提供的 Run 状态与事件。';

    var summary = !eventReady
      ? (eventStatus === 'loading' ? 'Run Event 正在加载；诊断暂以生命周期状态为准。'
        : 'Run Event 暂不可用；诊断只展示当前可读的 Run、Consent 与 Memory 状态。')
      : '诊断由现有 Run Event、Action Trace、Consent 与 Memory Provenance 投影生成。';
    return {
      stateLabel: stateLabels[status] || '状态未知', currentPhase: currentPhase,
      currentDetail: currentDetail, completedSteps: completedSteps, failure: failure,
      authority: authority, consent: consent, memory: memory, summary: summary, hint: hint
    };
  }

  function deriveWorkflowStatus(state, reviewed, nowMs) {
    state = state || {};
    var selectedResult = state.selectedResult || null;
    var run = state.run || (selectedResult && selectedResult.run) || null;
    if (!run) return { key: 'not-started', label: '未开始', detail: '选择 Workspace 项目并创建任务。' };
    if (run.status === 'queued') return { key: 'not-started', label: '未开始', detail: 'Run 已创建；等待核对范围和明确授权后启动。' };
    if (run.status === 'running' || run.status === 'cancel_requested') {
      return { key: 'running', label: '执行中 · running', detail: '任务状态与执行事件由 Home Node 提供。' };
    }
    if (run.status === 'failed') return { key: 'failed', label: '失败 · failed', detail: '查看 Home Node 执行轨迹以了解失败阶段。' };
    if (run.status === 'cancelled') return { key: 'cancelled', label: '已取消', detail: 'Home Node 已确认任务取消；不会自动重启。' };
    if (run.status === 'completed') {
      var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      var matchingSelected = selectedResult && selectedResult.run && selectedResult.run.runId === run.runId
        ? selectedResult.result : null;
      var resultEntry = (Array.isArray(state.results) ? state.results : []).find(function (item) {
        return item && item.runId === run.runId;
      });
      var available = matchingSelected && matchingSelected.status === 'available'
        && (!Number.isFinite(Number(matchingSelected.expiresAt)) || Number(matchingSelected.expiresAt) > now);
      if (!available && resultEntry) available = resultEntry.resultStatus === 'available'
        && (!Number.isFinite(Number(resultEntry.expiresAt)) || Number(resultEntry.expiresAt) > now);
      if (available && reviewed === true) {
        return { key: 'completed', label: '已完成', detail: 'Result 已审阅；可下载本地 Markdown 副本。' };
      }
      if (available) return { key: 'waiting-review', label: '待审阅 · waiting review', detail: 'Result 已保存；打开报告并标记审阅完成，或导出本地副本。' };
      return { key: 'completed', label: '已完成', detail: 'Home Node 已完成 Run；当前没有可用 Result。请刷新或查看执行轨迹。' };
    }
    return { key: 'unknown', label: '状态待刷新', detail: '从 Home Node 刷新任务状态。' };
  }

  function summarySafeLabel(value, limit) {
    if (typeof value !== 'string') return '';
    var label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    label = label.replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
      '[凭据已隐藏]');
    label = label.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})\b/gi,
      '[凭据已隐藏]');
    label = label.replace(/\b[A-Z0-9_]*(?:API[_-]?(?:KEY|TOKEN)|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY)\b\s*[:=]\s*[^\s,;]{6,}/gi,
      '[凭据已隐藏]');
    return label.slice(0, limit || 100);
  }

  function deriveWorkRunSummary(state, reviewed, nowMs) {
    state = state || {};
    var selectedResult = state.selectedResult || null;
    var run = state.run || (selectedResult && selectedResult.run) || null;
    var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    var workflow = deriveWorkflowStatus(state, reviewed === true, now);
    if (!run) return {
      hasRun: false, title: '未选择任务', project: '—', status: workflow.label,
      statusKey: workflow.key, lifecycle: '—', completedActionCount: null,
      actionDetail: '尚未创建 Run。', memory: '未读取', result: '无 Result',
      resultAvailable: false, review: '尚未开始', reason: workflow.detail
    };

    var runId = String(run.runId || '');
    var workflowTitles = {
      'project.audit.readonly': '只读项目审计',
      'coding.workspace': 'Coding Workspace Run',
      'app.builder': 'App Builder Run'
    };
    var title = workflowTitles[String(run.workflowId || '')] || 'Work Run';
    var snapshot = state.projectSnapshot && state.projectSnapshot.projectRef === run.projectRef
      ? state.projectSnapshot : null;
    var projectName = snapshot && summarySafeLabel(snapshot.projectName, 80);
    var projectRef = summarySafeLabel(String(run.projectRef || ''), 120);
    var project = projectName ? projectName + (projectRef ? ' · ' + projectRef : '')
      : (projectRef || '项目引用未记录');

    var lifecycleLabels = {
      queued: 'Queued · 等待授权', running: 'Running · 执行中',
      cancel_requested: 'Cancel requested · 等待取消', completed: 'Completed · 已完成',
      failed: 'Failed · 失败', cancelled: 'Cancelled · 已取消'
    };
    var lifecycle = lifecycleLabels[String(run.status || '')] || '状态未知';
    var eventsMatch = state.runEventsRunId === runId;
    var eventStatus = eventsMatch ? String(state.runEventsStatus || 'idle') : 'loading';
    var eventsReady = eventStatus === 'ready' && Array.isArray(state.runEvents);
    var events = eventsReady ? state.runEvents.filter(function (event) {
      return event && typeof event === 'object';
    }) : [];
    var traceByRequest = Object.create(null);
    var traces = [];
    events.forEach(function (event) {
      var trace = event.actionTrace;
      if (!trace || trace.runId !== runId || typeof trace.requestId !== 'string'
        || !/^ib\.[A-Za-z0-9_.-]{1,120}\.v[0-9]+$/.test(String(trace.actionId || ''))
        || ['succeeded', 'failed', 'denied'].indexOf(trace.status) < 0
        || traceByRequest[trace.requestId]) return;
      traceByRequest[trace.requestId] = true;
      traces.push(trace);
    });
    var successfulActions = eventsReady ? traces.filter(function (trace) { return trace.status === 'succeeded'; }) : [];
    var completedActionCount = eventsReady ? successfulActions.length : null;
    var actionDetail = !eventsReady
      ? (eventStatus === 'loading' ? 'Action Trace 正在读取。' : 'Action Trace 暂不可用。')
      : (traces.length ? '共 ' + traces.length + ' 条 Action Trace。' : '暂无 Action Trace。');

    var resultEntry = (Array.isArray(state.results) ? state.results : []).find(function (entry) {
      return entry && entry.runId === runId;
    }) || null;
    var matchingResult = selectedResult && selectedResult.run && selectedResult.run.runId === runId
      && selectedResult.result ? selectedResult.result : null;
    function notExpired(item) {
      return item && (!Number.isFinite(Number(item.expiresAt)) || Number(item.expiresAt) > now);
    }
    var selectedResultAvailable = !!(matchingResult && matchingResult.status === 'available' && notExpired(matchingResult));
    var indexedResultAvailable = !!(resultEntry && resultEntry.resultStatus === 'available' && notExpired(resultEntry));
    var resultAvailable = selectedResultAvailable || indexedResultAvailable;
    var resultRawStatus = selectedResultAvailable ? 'available'
      : (indexedResultAvailable ? 'available'
        : (matchingResult && matchingResult.status || resultEntry && resultEntry.resultStatus || ''));
    if (!resultRawStatus && ['queued', 'running', 'cancel_requested'].indexOf(String(run.status || '')) >= 0) {
      resultRawStatus = 'not_generated';
    }
    if (resultRawStatus === 'available' && !resultAvailable) resultRawStatus = 'expired';
    var resultLabels = { available: '可用', expired: '已过期', deleted: '已删除',
      failed: '生成失败', unavailable: '不可用', not_generated: '尚未生成' };
    var resultLabel = resultLabels[resultRawStatus] || (resultRawStatus ? '状态未知' : '无 Result 记录');

    var memoryProvenance = state.memoryProvenance && state.memoryProvenance.runId === runId
      ? state.memoryProvenance : null;
    var memoryScope = memoryProvenance && memoryProvenance.status === 'ready'
      && memoryProvenance.consent && memoryProvenance.consent.memoryScope;
    var referenceCount = memoryScope && Array.isArray(memoryScope.refs) ? memoryScope.refs.length : 0;
    var resultMemoryDerived = matchingResult && typeof matchingResult.memoryDerived === 'boolean'
      ? matchingResult.memoryDerived
      : (resultEntry && typeof resultEntry.memoryDerived === 'boolean' ? resultEntry.memoryDerived
        : (memoryProvenance && memoryProvenance.result
          && typeof memoryProvenance.result.memoryDerived === 'boolean' ? memoryProvenance.result.memoryDerived : null));
    var generationCount = eventsReady ? successfulActions.filter(function (trace) {
      return trace.actionId === 'ib.work.result.generate.v1';
    }).length : null;
    var memory;
    if (!memoryProvenance || memoryProvenance.status !== 'ready') {
      memory = memoryProvenance && memoryProvenance.status === 'loading'
        ? 'Memory Provenance 正在读取。' : 'Memory Provenance 暂不可用。';
    } else if (!memoryScope) {
      memory = '未授权 Agent Memory Recall';
    } else {
      memory = '已授权 ' + referenceCount + ' 条 Recall 引用';
      if (generationCount === null) memory += ' · Action Trace 未加载';
      else memory += ' · 成功 Result Generation ' + generationCount + ' 次';
    }
    if (resultMemoryDerived !== null) memory += ' · Result memory-derived=' + (resultMemoryDerived ? 'true' : 'false');
    else if (memoryProvenance && memoryProvenance.status === 'ready') memory += ' · Result 标记未记录';

    var review;
    if (run.status === 'completed' && resultAvailable) {
      review = reviewed === true ? '已标记审阅（当前页面）' : '待审阅';
    } else if (run.status === 'completed') review = '无可审阅的 Result';
    else if (['failed', 'cancelled'].indexOf(String(run.status || '')) >= 0) review = '未进入 Review';
    else if (['queued', 'running', 'cancel_requested'].indexOf(String(run.status || '')) >= 0) review = 'Run 完成后可审阅';
    else review = '状态未记录';

    var consentState = state.consent && state.consent.runId === runId ? state.consent : null;
    var diagnostics = deriveRuntimeDiagnostics(run, events, eventStatus, memoryProvenance, now, consentState);
    var reason;
    if (diagnostics.failure) reason = diagnostics.failure.location + ' · ' + diagnostics.failure.note;
    else if (workflow.key === 'waiting-review') reason = workflow.detail;
    else if (run.status === 'queued') reason = diagnostics.hint;
    else if (!eventsReady) reason = diagnostics.summary;
    else if (run.status === 'failed') reason = diagnostics.currentDetail || '未能从现有数据定位失败原因。';
    else if (run.status === 'running' || run.status === 'cancel_requested') reason = diagnostics.hint;
    else if (run.status === 'cancelled') reason = diagnostics.hint;
    else reason = '无待处理事项。';

    return {
      hasRun: true, title: title, project: project,
      status: workflow.label, statusKey: workflow.key, lifecycle: lifecycle,
      completedActionCount: completedActionCount, actionDetail: actionDetail,
      memory: memory, result: resultLabel, resultAvailable: resultAvailable,
      review: review, reason: reason
    };
  }

  function buildResultReviewModel(artifact) {
    var report = artifact && artifact.report && typeof artifact.report === 'object' ? artifact.report : {};
    function displayText(value, limit) {
      if (typeof value !== 'string' && typeof value !== 'number') return '';
      return String(value).trim().slice(0, limit);
    }
    var summary = displayText(report.summary, 2000);
    var sourceFindings = Array.isArray(report.findings) ? report.findings : [];
    var findings = sourceFindings.map(function (value, index) {
      var finding = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      var path = displayText(finding.path, 240);
      var fileId = displayText(finding.fileId, 180);
      var line = Number.isSafeInteger(finding.line) && finding.line > 0 ? finding.line : null;
      var severity = displayText(finding.severity, 20);
      return {
        index: index,
        severity: severity || '未标注',
        title: displayText(finding.title, 120) || 'Artifact 未提供标题',
        detail: displayText(finding.detail, 500) || 'Artifact 未提供 Finding 描述。',
        path: path,
        fileId: fileId,
        line: line,
        hasSource: !!(path || fileId),
        location: path ? path + (line ? ':' + line : '') : (line ? '第 ' + line + ' 行' : '')
      };
    });
    return {
      summary: summary,
      hasSummary: !!summary,
      findings: findings,
      hasFindings: findings.length > 0,
      findingsWithoutSource: findings.filter(function (finding) { return !finding.hasSource; }).length,
      evidenceExcerptStored: false
    };
  }

  function formatResultMarkdown(selection) {
    if (!selection || !selection.run || !selection.result || selection.result.status !== 'available') return '';
    var run = selection.run;
    var artifact = selection.result;
    var report = artifact.report && typeof artifact.report === 'object' ? artifact.report : {};
    function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
    var lines = [
      '# Work Result',
      '',
      '- Project reference: ' + text(run.projectRef),
      '- Run: ' + text(run.runId),
      '- Result: ' + text(artifact.resultId),
      '',
      '## Summary',
      '',
      text(report.summary) || 'No summary available.',
      '',
      '## Findings',
      ''
    ];
    var findings = Array.isArray(report.findings) ? report.findings : [];
    findings.forEach(function (finding) {
      if (!finding || typeof finding !== 'object') return;
      var location = text(finding.path);
      if (finding.line != null && finding.line !== '') location += ':' + text(finding.line);
      lines.push('### ' + (text(finding.severity) || 'finding') + ' · ' + (text(finding.title) || 'Untitled finding'));
      if (location) lines.push('', 'Location: `' + location.replace(/`/g, '\\`') + '`');
      lines.push('', text(finding.detail), '');
    });
    if (!findings.length) lines.push('No findings.');
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
  }

  function createController(dependencies) {
    dependencies = dependencies || {};
    var runtime = dependencies.runtime || {};
    var homeNode = dependencies.homeNode || {};
    var agentMemory = dependencies.agentMemory || {};
    var memoryRecall = dependencies.memoryRecall || {};
    var workspace = dependencies.workspace || {};
    var core = dependencies.consentCore || {};
    var executorCore = dependencies.executorCore || (typeof module === 'object' && module.exports
      ? require('./work-mode-executor.js') : (typeof globalThis !== 'undefined' ? globalThis.IBWorkModeExecutor : null));
    var providerRouteCore = dependencies.providerRouteCore || (typeof module === 'object' && module.exports
      ? require('./work-mode-provider-route.js') : (typeof globalThis !== 'undefined' ? globalThis.IBWorkModeProviderRoute : null));
    var cryptoApi = dependencies.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    var getApiProfiles = typeof dependencies.getApiProfiles === 'function' ? dependencies.getApiProfiles : function () {
      return typeof globalThis !== 'undefined' && Array.isArray(globalThis.apiConfigs) ? globalThis.apiConfigs : [];
    };
    var loadApiProfiles = typeof dependencies.loadApiProfiles === 'function' ? dependencies.loadApiProfiles
      : (typeof globalThis !== 'undefined' && typeof globalThis.loadApiConfigs === 'function'
        ? globalThis.loadApiConfigs.bind(globalThis) : null);
    var projectDraft = dependencies.projectDraft || {};
    var requireFileSelection = dependencies.requireFileSelection === true;
    var TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];
    var requestProjectName = typeof dependencies.requestProjectName === 'function'
      ? dependencies.requestProjectName : null;
    var OBSERVATION_DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
    var MEMORY_DERIVED_RESULT_STORAGE = 'plaintext_home_node_sqlite';
    var now = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
    var makeRequestId = dependencies.requestId || function () {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return 'work-ui-' + crypto.randomUUID();
      throw new Error('secure-random-unavailable');
    };
    var onChange = typeof dependencies.onChange === 'function' ? dependencies.onChange : function () {};
    var state = {
      selectedProjectRef: '', projectSnapshot: null, projectSnapshotError: '',
      run: null, profileRef: '', executorSelection: { roleId: '', presetId: 'general' },
      executor: 'native', dshSessionId: '', dshStatus: null, activeDshRunIds: [], preview: null, previewKey: '',
      fileIds: [], consentId: '', consent: null, consentKey: '', consentFileIds: [], consentRevoked: false,
      confirmedKey: '', currentGrantKey: '', revocationRequired: false,
      activeRuns: [], results: [], resultsHasMore: false, selectedResult: null,
      runEvents: [], runEventsRunId: '', runEventsStatus: 'idle',
      memoryProvenance: null,
      memoryRecall: { ok: false, records: [], error: 'memory-recall-not-loaded' },
      memorySelectedIds: [], memorySnapshot: null, memoryRecallBusy: '', memoryConfirmed: false, memoryConfirmedKey: '',
      memoryDerivedReviewConfirmed: false, memoryDerivedReviewKey: '',
      memoryDerivedResultConfirmed: false, memoryDerivedResultKey: '',
      memoryCandidate: null, memoryCandidateConfirmed: false, memoryCandidateBusy: '', linkedMemoryRecords: [],
      busy: '', notice: '', error: '', ledgerLoading: false,
      storageRiskAccepted: false,
      workspaceWriteAccepted: false, workspaceWriteAcceptedKey: ''
    };
    var pendingGrant = null;
    var pendingStart = null;
    var pendingCreate = null;
    var pendingRefresh = null;
    var pendingEventReads = new Map();
    var pendingMemoryProvenanceReads = new Map();
    var recoveryAttempted = false;
    var pendingDelete = new Map();

    function changed() { onChange(getState()); }
    function safeMessage(result, fallback) { return String(result && result.error || fallback || 'work-mode-failed'); }
    function consentNotice(code) {
      var messages = {
        'consent-read-failed': 'Home Node 暂时无法读取授权状态；旧授权未撤销，也没有发送模型请求。检查连接后可重试。',
        'work-run-api-unavailable': '本机 Home Node 暂不可用；旧授权保持原样，没有发送模型请求。重新连接后可重试。',
        'consent-record-not-found': 'Home Node 中没有找到这份授权；Run 尚未启动，请重新核对并确认。',
        'consent-already-revoked': 'Home Node 已撤销这份旧授权；Run 尚未启动，请重新确认权限。',
        'consent-expired': '这份授权已过期；Run 尚未启动，请重新确认权限。',
        'consent-no-longer-active': 'Home Node 未确认一份仍有效的授权；Run 尚未启动。请查看范围并重新确认。',
        'consent-run-mismatch': '授权属于另一条 Run；已拒绝继续，请重新核对当前任务。',
        'consent-project-mismatch': '授权所绑定的 Workspace 项目与当前 Run 不一致；请重新核对项目。',
        'consent-file-scope-mismatch': '授权文件范围与当前选择不一致；请重新选择文件并确认。',
        'consent-provider-mismatch': '授权 Provider 路由与当前配置不一致；请重新核对模型路由并确认。',
        'consent-terms-stale': '授权条款已更新；请重新阅读后确认。',
        'consent-memory-scope-mismatch': 'Agent Memory 选择与已授权范围不同；请重新核对 Memory 权限。',
        'consent-memory-derived-scope-mismatch': 'Memory 衍生内容的 Review 或 Result 权限已变化；请重新核对。',
        'consent-scope-invalid': 'Home Node 返回的授权范围无效；刷新项目与 Provider 信息后重试。',
        'explicit-consent-required': '先勾选外发确认与 Result 保存风险确认，再一次完成授权和启动。',
        'storage-risk-acceptance-required': '先确认 Result 的本地明文保存风险，再继续。',
        'dsh-memory-unsupported': 'DSH Agent Memory Recall 范围无效或未获得完整授权；请重新核对 Recall、Review 与 Result 权限。',
        'dsh-session-binding-required': '先从 DSH UI 将 Session 绑定到当前 Home Node Run，再执行。',
        'run-not-queued': '当前 Run 不处于等待授权状态；请从任务列表重新选择。'
      };
      return messages[code] || '授权核对未完成；Run 未启动，也没有发送模型请求。';
    }
    async function refreshDshStatus() {
      if (typeof homeNode.dshStatus !== 'function') {
        state.dshStatus = { enabled: false, dshRevision: null, activeRuns: 0, activeRunIds: [] };
        state.activeDshRunIds = [];
        return { ok: false, error: 'dsh-status-unavailable' };
      }
      var result;
      try { result = await homeNode.dshStatus(); } catch (_) { result = null; }
      if (!result || result.ok !== true || !result.host || typeof result.host.enabled !== 'boolean') {
        state.dshStatus = { enabled: false, dshRevision: null, activeRuns: 0, activeRunIds: [] };
        state.activeDshRunIds = [];
        return result || { ok: false, error: 'dsh-status-unavailable' };
      }
      state.dshStatus = Object.assign({}, result.host);
      state.activeDshRunIds = Array.isArray(result.host.activeRunIds)
        ? result.host.activeRunIds.filter(function (runId) { return typeof runId === 'string'; }) : [];
      if (state.run && state.activeDshRunIds.indexOf(state.run.runId) >= 0) state.executor = 'dsh';
      return result;
    }
    function cloneState() {
      return {
        selectedProjectRef: state.selectedProjectRef,
        projectSnapshot: state.projectSnapshot && JSON.parse(JSON.stringify(state.projectSnapshot)),
        projectSnapshotError: state.projectSnapshotError,
        run: state.run && Object.assign({}, state.run),
        profileRef: state.profileRef,
        executorSelection: Object.assign({}, state.executorSelection),
        executor: state.executor,
        dshSessionId: state.dshSessionId,
        dshStatus: state.dshStatus && Object.assign({}, state.dshStatus),
        activeDshRunIds: state.activeDshRunIds.slice(),
        preview: state.preview && JSON.parse(JSON.stringify(state.preview)),
        previewKey: state.previewKey,
        fileIds: state.fileIds.slice(),
        consentId: state.consentId,
        consent: state.consent && JSON.parse(JSON.stringify(state.consent)),
        consentKey: state.consentKey,
        consentFileIds: state.consentFileIds.slice(),
        consentRevoked: state.consentRevoked,
        confirmedKey: state.confirmedKey,
        currentGrantKey: state.currentGrantKey,
        revocationRequired: state.revocationRequired,
        activeRuns: state.activeRuns.map(function (run) { return Object.assign({}, run); }),
        results: state.results.map(function (result) { return Object.assign({}, result); }),
        resultsHasMore: state.resultsHasMore,
        selectedResult: state.selectedResult && JSON.parse(JSON.stringify(state.selectedResult)),
        runEvents: state.runEvents.map(function (event) { return Object.assign({}, event); }),
        runEventsRunId: state.runEventsRunId,
        runEventsStatus: state.runEventsStatus,
        memoryProvenance: state.memoryProvenance && JSON.parse(JSON.stringify(state.memoryProvenance)),
        memoryRecall: state.memoryRecall && JSON.parse(JSON.stringify(state.memoryRecall)),
        memorySelectedIds: state.memorySelectedIds.slice(),
        memorySnapshot: state.memorySnapshot && JSON.parse(JSON.stringify(state.memorySnapshot)),
        memoryRecallBusy: state.memoryRecallBusy,
        memoryConfirmed: state.memoryConfirmed,
        memoryConfirmedKey: state.memoryConfirmedKey,
        memoryDerivedReviewConfirmed: state.memoryDerivedReviewConfirmed,
        memoryDerivedReviewKey: state.memoryDerivedReviewKey,
        memoryDerivedResultConfirmed: state.memoryDerivedResultConfirmed,
        memoryDerivedResultKey: state.memoryDerivedResultKey,
        memoryCandidate: state.memoryCandidate && JSON.parse(JSON.stringify(state.memoryCandidate)),
        memoryCandidateConfirmed: state.memoryCandidateConfirmed,
        memoryCandidateBusy: state.memoryCandidateBusy,
        linkedMemoryRecords: state.linkedMemoryRecords.map(function (record) { return JSON.parse(JSON.stringify(record)); }),
        busy: state.busy,
        ledgerLoading: state.ledgerLoading,
        storageRiskAccepted: state.storageRiskAccepted,
        workspaceWriteAccepted: workspaceWriteAccepted(),
        notice: state.notice,
        error: state.error
      };
    }
    async function buildExecutorSelectionSnapshot(choice) {
      if (!executorCore || !providerRouteCore || typeof executorCore.createSnapshot !== 'function') return Promise.resolve(null);
      var normalized = executorCore.normalizeChoice(choice);
      if (!normalized) return null;
      if (loadApiProfiles) {
        try { await loadApiProfiles(); } catch (_) { return null; }
      }
      var profiles = getApiProfiles();
      var profile = profiles.find(function (item) { return item && String(item.id || '') === normalized.profileRef && item.archived !== true; }) || null;
      var role = normalized.roleId
        ? profiles.find(function (item) { return item && String(item.id || '') === normalized.roleId && item.archived !== true; }) || null
        : null;
      return await executorCore.createSnapshot({
        choice: normalized,
        role: role,
        profile: profile,
        routeCore: providerRouteCore,
        consentCore: core,
        crypto: cryptoApi
      });
    }

    async function pinRunExecutorSelection(snapshot) {
      if (!state.run) return { ok: true, unpinned: true };
      var current = state.run.executorSelection || null;
      if (current) {
        return JSON.stringify(current) === JSON.stringify(snapshot)
          ? { ok: true, unchanged: true, run: state.run }
          : { ok: false, error: 'run-executor-selection-locked' };
      }
      if (state.run.status !== 'queued') return { ok: false, error: 'run-executor-selection-locked' };
      if (typeof homeNode.setExecutorSelection !== 'function') return { ok: false, error: 'run-executor-selection-unavailable' };
      var result;
      try {
        result = await homeNode.setExecutorSelection(state.run.runId, {
          expectedVersion: state.run.version,
          executorSelection: snapshot
        });
      } catch (_) { result = null; }
      if (!result || result.ok !== true || !result.run || !result.run.executorSelection) {
        return { ok: false, error: String(result && result.error || 'run-executor-selection-failed'), run: result && result.run || state.run };
      }
      state.run = result.run;
      return result;
    }

    function getState() { return cloneState(); }
    function persistProjectDraft() {
      if (!state.selectedProjectRef) {
        if (typeof projectDraft.clear === 'function') {
          try { return projectDraft.clear() === true; } catch (_) { return false; }
        }
        return false;
      }
      if (typeof projectDraft.save !== 'function') return false;
      try {
        return projectDraft.save({ version: 1, projectRef: state.selectedProjectRef, fileIds: state.fileIds.slice() }) === true;
      } catch (_) { return false; }
    }
    function workspaceSnapshotFingerprint(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.files)) return '';
      return JSON.stringify(snapshot.files.map(function (file) {
        return { fileId: file.fileId, path: file.path, size: file.size, contentHash: file.contentHash };
      }).sort(function (a, b) { return a.fileId.localeCompare(b.fileId); }));
    }
    async function loadProjectSnapshot(projectRef) {
      if (!projectRef || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function') {
        return { ok: false, error: 'workspace-unavailable' };
      }
      var result;
      try { result = await workspace.wsGetWorkModeProjectSnapshot(projectRef); }
      catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
      if (!result || result.ok !== true || result.projectRef !== projectRef || !Array.isArray(result.files)) {
        return { ok: false, error: String(result && result.error || 'workspace-unavailable') };
      }
      return { ok: true, snapshot: JSON.parse(JSON.stringify(result)) };
    }
    async function refreshProjectSnapshot(projectRef) {
      projectRef = String(projectRef || state.selectedProjectRef || '');
      if (!projectRef || projectRef !== state.selectedProjectRef) return { ok: false, error: 'project-required' };
      var loaded = await loadProjectSnapshot(projectRef);
      if (!loaded.ok) {
        if (state.consentId) {
          var failedRevoke = await revokeKnownConsent();
          if (!failedRevoke.ok) state.revocationRequired = true;
        }
        state.projectSnapshot = null;
        state.projectSnapshotError = loaded.error;
        state.preview = null;
        state.previewKey = '';
        state.fileIds = [];
        state.confirmedKey = '';
        state.currentGrantKey = '';
        persistProjectDraft();
        state.error = loaded.error;
        changed();
        return loaded;
      }
      var previous = state.projectSnapshot;
      var snapshot = loaded.snapshot;
      var previousFingerprint = workspaceSnapshotFingerprint(previous);
      var nextFingerprint = workspaceSnapshotFingerprint(snapshot);
      var removedSelected = state.fileIds.some(function (id) {
        return !snapshot.files.some(function (file) { return file.fileId === id; });
      });
      var changedSnapshot = !!(previous && previous.projectRef === projectRef && previousFingerprint !== nextFingerprint);
      if ((changedSnapshot || removedSelected) && state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      if (changedSnapshot) {
        state.preview = null;
        state.previewKey = '';
        state.confirmedKey = '';
        state.currentGrantKey = '';
        state.notice = 'Workspace 文件清单或内容已变化；旧范围确认已失效，请重新核对。';
      }
      state.projectSnapshot = snapshot;
      state.projectSnapshotError = '';
      if (removedSelected) {
        state.fileIds = state.fileIds.filter(function (id) {
          return snapshot.files.some(function (file) { return file.fileId === id; });
        });
        state.confirmedKey = '';
        state.currentGrantKey = '';
        state.notice = '已移除不存在的文件范围；请重新核对当前项目。';
      }
      state.error = '';
      persistProjectDraft();
      changed();
      return { ok: true, snapshot: snapshot, changed: changedSnapshot };
    }
    async function restoreProjectDraft() {
      if (state.selectedProjectRef || typeof projectDraft.load !== 'function') return { ok: true, unchanged: true };
      var draft;
      try { draft = projectDraft.load(); } catch (_) { draft = null; }
      if (!draft || draft.version !== 1 || typeof draft.projectRef !== 'string'
        || !/^[A-Za-z0-9_.:-]{1,180}$/.test(draft.projectRef) || !Array.isArray(draft.fileIds)) {
        return { ok: true, empty: true };
      }
      var access = await projectAccessStatus(draft.projectRef);
      if (!access.ok) {
        if (typeof projectDraft.clear === 'function') projectDraft.clear();
        state.projectSnapshotError = access.error;
        state.notice = '上次选择的 Workspace 项目已不可用；没有恢复文件授权。';
        changed();
        return access;
      }
      state.selectedProjectRef = draft.projectRef;
      state.fileIds = [];
      var loaded = await loadProjectSnapshot(draft.projectRef);
      if (!loaded.ok) {
        state.projectSnapshotError = loaded.error;
        state.notice = '项目已恢复，但文件预览读取失败；没有恢复授权。';
        changed();
        return loaded;
      }
      state.projectSnapshot = loaded.snapshot;
      state.projectSnapshotError = '';
      var allowed = loaded.snapshot.files.map(function (file) { return file.fileId; });
      var requested = fileIds(draft.fileIds) || [];
      state.fileIds = requested.filter(function (id) { return allowed.indexOf(id) >= 0; });
      persistProjectDraft();
      state.notice = '已恢复项目与文件范围草稿；Provider、Consent 和确认状态均未恢复。';
      state.error = '';
      changed();
      return { ok: true, projectRef: state.selectedProjectRef, fileIds: state.fileIds.slice() };
    }
    async function importProjectFiles(selectedFiles) {
      var projectRef = state.selectedProjectRef;
      if (typeof workspace.wsImportWorkModeFiles !== 'function') {
        state.error = 'workspace-unavailable';
        changed();
        return { ok: false, error: state.error };
      }
      if (!Array.isArray(selectedFiles) || !selectedFiles.length) return { ok: false, error: 'no-files-selected' };
      if (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0) {
        return { ok: false, error: 'active-run-must-be-closed' };
      }
      if (state.busy) return { ok: false, error: 'operation-busy' };
      state.busy = 'importing';
      state.error = '';
      state.notice = projectRef ? '正在将所选文本文件接入当前 Workspace 项目；不会访问其他路径。'
        : '正在根据你明确选择的文件创建 Workspace 项目；不会扫描其他路径。';
      changed();
      var priorProjectRef = projectRef;
      var createdProject = false;
      if (!projectRef) {
        if (typeof workspace.wsCreateWorkModeProject !== 'function') {
          state.busy = '';
          state.error = 'workspace-unavailable';
          changed();
          return { ok: false, error: state.error };
        }
        var relative = selectedFiles.map(function (file) {
          return file && typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : '';
        });
        var rootNames = relative.map(function (value) { return value.split('/')[0]; }).filter(Boolean);
        var folderName = rootNames.length && rootNames.every(function (value) { return value === rootNames[0]; })
          && relative.every(function (value) { return value.split('/').length > 1; }) ? rootNames[0] : '';
        var suggestedName = folderName || String(selectedFiles[0] && selectedFiles[0].name || '本地项目')
          .replace(/\.[^.]+$/, '').slice(0, 60) || '本地项目';
        var projectName = folderName || suggestedName;
        if (!folderName && requestProjectName) {
          try { projectName = String(requestProjectName(suggestedName) || '').trim(); }
          catch (_) { projectName = ''; }
        }
        if (!projectName) {
          state.busy = '';
          state.error = 'project-name-required';
          state.notice = '';
          changed();
          return { ok: false, error: state.error };
        }
        var created;
        try { created = await workspace.wsCreateWorkModeProject(projectName); }
        catch (_) { created = { ok: false, error: 'workspace-unavailable' }; }
        if (!created || created.ok !== true || !created.projectRef) {
          state.busy = '';
          state.error = safeMessage(created, 'workspace-unavailable');
          state.notice = '';
          changed();
          return created || { ok: false, error: 'workspace-unavailable' };
        }
        projectRef = String(created.projectRef);
        createdProject = created.created === true;
      }
      var access = await projectAccessStatus(projectRef);
      if (!access.ok) {
        if (createdProject && typeof workspace.wsDeleteProject === 'function') {
          try { await workspace.wsDeleteProject(projectRef); } catch (_) {}
        }
        state.busy = '';
        state.error = access.error;
        changed();
        return access;
      }
      var result;
      try { result = await workspace.wsImportWorkModeFiles(projectRef, selectedFiles); }
      catch (_) { result = { ok: false, error: 'workspace-unavailable' }; }
      var newlyWritten = Array.isArray(result && result.imported) ? result.imported.length : 0;
      if ((!result || result.ok !== true) && createdProject && newlyWritten === 0
        && typeof workspace.wsDeleteProject === 'function') {
        try { await workspace.wsDeleteProject(projectRef); } catch (_) {}
        state.busy = '';
        state.error = safeMessage(result, 'workspace-unavailable');
        state.notice = '导入未完成，已清除没有文件的临时项目。';
        changed();
        return result || { ok: false, error: 'workspace-unavailable' };
      }
      if (result && (result.ok === true || newlyWritten > 0)) {
        if (state.selectedProjectRef !== projectRef) {
          state.selectedProjectRef = projectRef;
          state.projectSnapshot = null;
          state.projectSnapshotError = '';
          state.fileIds = [];
          state.preview = null;
          state.previewKey = '';
          state.confirmedKey = '';
          state.currentGrantKey = '';
          clearConsent();
        }
      }
      var refreshed = state.selectedProjectRef === projectRef
        ? await refreshProjectSnapshot(projectRef) : { ok: false, error: 'project-required' };
      state.busy = '';
      if (result && result.ok === true) {
        state.error = '';
        var skipped = result.skipped || {};
        var skippedCount = Number(skipped.unsupported || 0) + Number(skipped.large || 0) + Number(skipped.binary || 0);
        state.notice = '已接入 ' + result.imported.length + ' 个新文件，' + result.unchanged.length
          + ' 个相同文件未重复写入' + (skippedCount ? '，跳过 ' + skippedCount + ' 个不符合范围的文件' : '')
          + (priorProjectRef ? '。' : '，项目「' + (state.projectSnapshot && state.projectSnapshot.projectName || projectRef) + '」已创建。')
          + '新文件默认不选，授权尚未创建。';
      } else {
        state.error = safeMessage(result, 'workspace-unavailable');
        state.notice = result && result.error === 'workspace-import-partial'
          ? '导入遇到存储错误；已写入部分文件，当前列表已重新读取。' : '';
      }
      if (!refreshed.ok && result && result.ok) {
        state.error = refreshed.error;
        state.notice = '文件接入完成，但 Workspace 刷新失败；请稍后重新加载预览。';
      }
      persistProjectDraft();
      changed();
      return result ? Object.assign({}, result, { projectRef: projectRef }) : { ok: false, error: 'workspace-unavailable' };
    }
    async function refreshRunEvents(runId) {
      runId = String(runId || '');
      if (!runId) {
        state.runEvents = [];
        state.runEventsRunId = '';
        state.runEventsStatus = 'idle';
        changed();
        return { ok: true, noOp: true };
      }
      if (pendingEventReads.has(runId)) return pendingEventReads.get(runId);
      if (typeof homeNode.events !== 'function') {
        state.runEvents = [];
        state.runEventsRunId = runId;
        state.runEventsStatus = 'unavailable';
        changed();
        return { ok: false, error: 'run-events-unavailable' };
      }
      state.runEventsStatus = 'loading';
      state.runEventsRunId = runId;
      changed();
      var operation = (async function () {
        var result;
        try { result = await homeNode.events(runId, { afterSequence: 0, limit: 100 }); }
        catch (_) { result = { ok: false, error: 'run-events-unavailable' }; }
        if (result && result.ok === true && Array.isArray(result.events) && result.hasMore === false) {
          state.runEvents = result.events.map(function (event) { return Object.assign({}, event); });
          var executionEvents = Array.isArray(result.executionEvents) ? result.executionEvents : [];
          executionEvents.forEach(function (event) {
            state.runEvents.push({
              sequence: 'd' + String(event.sequence || ''),
              eventType: 'dsh_' + String(event.event || 'progress'),
              executionEvent: String(event.event || ''),
              executor: 'dsh',
              fromStatus: '',
              toStatus: '',
              reasonCode: event.reason || '',
              createdAt: Number(event.at) || Date.now(),
              runId: String(event.runId || runId),
              call: event.call,
              toolName: event.toolName,
              fileId: event.fileId,
              path: event.path,
              code: event.code,
              dshEvent: event.dshEvent && typeof event.dshEvent === 'object' ? event.dshEvent : null
            });
          });
          state.runEvents.sort(function (left, right) {
            return (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
          });
          if (executionEvents.length) state.executor = 'dsh';
          state.runEventsStatus = 'ready';
        } else {
          state.runEvents = [];
          state.runEventsStatus = safeMessage(result, 'run-events-unavailable');
        }
        changed();
        pendingEventReads.delete(runId);
        return result || { ok: false, error: 'run-events-unavailable' };
      })();
      pendingEventReads.set(runId, operation);
      return operation;
    }
    async function refreshMemoryProvenance(runId) {
      runId = String(runId || '');
      if (!runId) {
        state.memoryProvenance = null;
        changed();
        return { ok: true, noOp: true };
      }
      if (pendingMemoryProvenanceReads.has(runId)) return pendingMemoryProvenanceReads.get(runId);
      if (typeof homeNode.memoryProvenance !== 'function') {
        state.memoryProvenance = { runId: runId, status: 'unavailable', consent: null, records: [], result: null };
        changed();
        return { ok: false, error: 'memory-provenance-unavailable' };
      }
      state.memoryProvenance = { runId: runId, status: 'loading', consent: null, records: [], result: null };
      changed();
      var operation = (async function () {
        var response;
        try { response = await homeNode.memoryProvenance(runId); }
        catch (_) { response = { ok: false, error: 'memory-provenance-unavailable' }; }
        if (!state.run || state.run.runId !== runId) {
          pendingMemoryProvenanceReads.delete(runId);
          return response || { ok: false, error: 'run-changed' };
        }
        if (!response || response.ok !== true || response.runId !== runId || !response.consent) {
          state.memoryProvenance = { runId: runId, status: 'unavailable', consent: null, records: [], result: null };
          changed();
          pendingMemoryProvenanceReads.delete(runId);
          return response || { ok: false, error: 'memory-provenance-unavailable' };
        }

        var consent = response.consent;
        var scope = consent.memoryScope && typeof consent.memoryScope === 'object' ? consent.memoryScope : null;
        var sourceRefs = scope && Array.isArray(scope.refs) ? scope.refs.slice(0, 12) : [];
        var projectedRecords = [];
        if (scope && sourceRefs.length) {
          var sameProject = scope.projectRef === state.run.projectRef;
          var availableRecords = state.memoryRecall && state.memoryRecall.ok === true
            && state.memoryRecall.projectRef === scope.projectRef && Array.isArray(state.memoryRecall.records)
            ? state.memoryRecall.records : [];
          var recordsForSnapshot = availableRecords.map(function (record) {
            return Object.assign({
              projectRef: scope.projectRef,
              status: 'active',
              effectiveStatus: 'active',
              expiresAt: null,
              supersededBy: null,
              retractedAt: null
            }, record);
          });
          var recordsById = Object.create(null);
          availableRecords.forEach(function (record) { if (record && record.memoryId) recordsById[record.memoryId] = record; });
          for (var refIndex = 0; refIndex < sourceRefs.length; refIndex++) {
            var ref = sourceRefs[refIndex] || {};
            var record = recordsById[ref.memoryId] || null;
            var verified = false;
            if (sameProject && record && record.revision === ref.revision
              && memoryRecall && typeof memoryRecall.createSnapshot === 'function') {
              var currentSnapshot;
              try {
                currentSnapshot = await memoryRecall.createSnapshot(recordsForSnapshot, scope.projectRef,
                  [ref.memoryId], now(), cryptoApi);
              } catch (_) { currentSnapshot = null; }
              var currentRef = currentSnapshot && currentSnapshot.ok === true && currentSnapshot.refs
                && currentSnapshot.refs.find(function (item) { return item.memoryId === ref.memoryId; });
              verified = !!(currentRef && currentRef.revision === ref.revision
                && String(currentRef.contentHash || '').toLowerCase() === String(ref.contentHash || '').toLowerCase());
              currentSnapshot = null;
            }
            projectedRecords.push({
              memoryId: String(ref.memoryId || ''),
              projectRef: String(scope.projectRef || ''),
              type: verified ? String(record.type || '') : '',
              revision: Number(ref.revision) || 0,
              contentHash: String(ref.contentHash || ''),
              recordStatus: verified ? 'matched' : (record ? 'changed' : 'unavailable')
            });
          }
          recordsForSnapshot = null;
          recordsById = null;
        }
        state.memoryProvenance = {
          runId: runId,
          status: 'ready',
          consent: {
            status: String(consent.status || 'unknown'),
            issuedAt: Number(consent.issuedAt) || 0,
            expiresAt: Number(consent.expiresAt) || 0,
            revokedAt: consent.revokedAt == null ? null : (Number(consent.revokedAt) || 0),
            memoryScope: scope ? {
              projectRef: String(scope.projectRef || ''),
              contextHash: String(scope.contextHash || ''),
              contextChars: Number(scope.contextChars) || 0
            } : null,
            memoryDerivedScope: consent.memoryDerivedScope ? {
              contextHash: String(consent.memoryDerivedScope.contextHash || ''),
              reviewConfirmed: consent.memoryDerivedScope.reviewConfirmed === true,
              resultConfirmed: consent.memoryDerivedScope.resultConfirmed === true
            } : null
          },
          records: projectedRecords,
          result: response.result && typeof response.result === 'object' ? {
            resultId: String(response.result.resultId || ''),
            status: String(response.result.status || ''),
            memoryDerived: response.result.memoryDerived === true,
            memoryContextHash: String(response.result.memoryContextHash || ''),
            createdAt: Number(response.result.createdAt) || 0
          } : null
        };
        changed();
        pendingMemoryProvenanceReads.delete(runId);
        return response;
      })();
      pendingMemoryProvenanceReads.set(runId, operation);
      return operation;
    }
    function fileIds(values) {
      if (!Array.isArray(values) || values.length > 200) return null;
      var result = values.map(String).sort();
      if (result.some(function (id, index) { return !/^[A-Za-z0-9_.:-]{1,180}$/.test(id) || (index && id === result[index - 1]); })) return null;
      return result;
    }
    function memoryScopeFor(preview, snapshot) {
      if (!preview || !snapshot || snapshot.ok !== true || !snapshot.recordCount
        || typeof memoryRecall.consentScopeForSnapshot !== 'function') return null;
      var agentProvider = (preview.providers || []).find(function (item) { return item.destination === 'agent'; });
      if (!agentProvider) return null;
      return memoryRecall.consentScopeForSnapshot(snapshot, agentProvider.scope || agentProvider);
    }
    function memoryConfirmationKey(scope) {
      if (!scope || typeof memoryRecall.stableStringify !== 'function') return '';
      return memoryRecall.stableStringify(scope);
    }
    function memoryDerivedIdentity(preview, snapshot) {
      var memoryScope = memoryScopeFor(preview, snapshot);
      if (!memoryScope || !preview || !Array.isArray(preview.providers)
        || typeof core.normalizeProviderScope !== 'function') return null;
      var middle = preview.providers.find(function (item) { return item.destination === 'middle_brain'; });
      var rawProviderScope = middle && (middle.scope || middle);
      var reviewProviderScope = rawProviderScope && core.normalizeProviderScope({
        destination: rawProviderScope.destination,
        providerRef: rawProviderScope.providerRef,
        provider: rawProviderScope.provider,
        model: rawProviderScope.model,
        routeHash: rawProviderScope.routeHash
      });
      var resultRetentionMs = Number(preview.terms && preview.terms.resultRetentionMs);
      if (!reviewProviderScope || !Number.isSafeInteger(resultRetentionMs) || resultRetentionMs < 1) return null;
      return {
        projectRef: memoryScope.projectRef,
        contextHash: memoryScope.contextHash,
        reviewProviderScope: reviewProviderScope,
        result: {
          destination: 'work_result',
          schemaVersion: core.RESULT_SCHEMA_VERSION || 1,
          storage: MEMORY_DERIVED_RESULT_STORAGE,
          retentionMs: resultRetentionMs
        }
      };
    }
    function memoryDerivedConfirmationKey(sink, preview, snapshot) {
      var identity = memoryDerivedIdentity(preview, snapshot);
      if (!identity) return '';
      return JSON.stringify({ sink: sink, identity: identity, memoryScope: memoryScopeFor(preview, snapshot) });
    }
    function resetMemoryDerivedConfirmations() {
      state.memoryDerivedReviewConfirmed = false;
      state.memoryDerivedReviewKey = '';
      state.memoryDerivedResultConfirmed = false;
      state.memoryDerivedResultKey = '';
    }
    function memoryDerivedScopeFor(preview, snapshot) {
      var identity = memoryDerivedIdentity(preview, snapshot);
      if (!identity) return null;
      var reviewKey = memoryDerivedConfirmationKey('review', preview, snapshot);
      var resultKey = memoryDerivedConfirmationKey('result', preview, snapshot);
      if (state.memoryDerivedReviewConfirmed !== true || state.memoryDerivedReviewKey !== reviewKey
        || state.memoryDerivedResultConfirmed !== true || state.memoryDerivedResultKey !== resultKey) return null;
      return {
        projectRef: identity.projectRef,
        contextHash: identity.contextHash,
        review: { confirmed: true, providerScope: identity.reviewProviderScope },
        result: {
          confirmed: true,
          destination: 'work_result',
          schemaVersion: identity.result.schemaVersion,
          storage: identity.result.storage,
          retentionMs: identity.result.retentionMs
        }
      };
    }
    function currentScopeKey(preview, snapshot) {
      var memoryScope = memoryScopeFor(preview, snapshot);
      return JSON.stringify({
        runId: preview.run && preview.run.runId,
        version: preview.run && preview.run.version,
        projectRef: preview.projectRef,
        terms: preview.terms && preview.terms.version,
        providers: (preview.providers || []).map(function (provider) {
          return {
            destination: provider.destination, providerRef: provider.providerRef,
            provider: provider.provider, model: provider.model, routeHash: provider.routeHash,
            endpointLabel: provider.endpointLabel || ''
          };
        }),
        files: (preview.files || []).map(function (file) {
          return { fileId: file.fileId, path: file.path, size: file.size, contentHash: file.contentHash };
        }).sort(function (a, b) { return a.fileId.localeCompare(b.fileId); }),
        memoryScope: memoryScope,
        memoryDerived: memoryDerivedIdentity(preview, snapshot)
      });
    }
    function makeGrantKey(scopeKey, selectedFileIds) {
      return JSON.stringify({ scopeKey: scopeKey, fileIds: selectedFileIds.slice().sort() });
    }
    function sameScopes(a, b) {
      if (typeof core.sameProviderScopes === 'function') return core.sameProviderScopes(a, b);
      return JSON.stringify((a || []).slice().sort(function (x, y) { return x.destination.localeCompare(y.destination); }))
        === JSON.stringify((b || []).slice().sort(function (x, y) { return x.destination.localeCompare(y.destination); }));
    }
    function clearConsent(revoked) {
      state.consentId = '';
      state.consent = null;
      state.consentKey = '';
      state.consentFileIds = [];
      state.consentRevoked = revoked === true;
      state.revocationRequired = false;
    }
    function traceConsentRevocationAttempt() {
      var traceRoot = typeof window !== 'undefined' ? window
        : (typeof globalThis !== 'undefined' ? globalThis : null);
      if (!traceRoot) return;
      var location = traceRoot.location;
      if (!location || String(location.port || '') !== '23130'
        || ['127.0.0.1', 'localhost'].indexOf(String(location.hostname || '').toLowerCase()) < 0) return;
      var frames = [];
      try {
        frames = String((new Error()).stack || '').split(/\r?\n/).slice(2, 9)
          .map(function (frame) { return frame.trim(); }).filter(Boolean);
      } catch (_) { /* diagnostics must never block revocation */ }
      var eventTargetId = '';
      try {
        var activeElement = traceRoot.document && traceRoot.document.activeElement;
        eventTargetId = activeElement && activeElement.id ? String(activeElement.id) : '';
      } catch (_) {}
      var eventSource = frames.find(function (frame) {
        return frame.indexOf('revokeKnownConsent') < 0 && frame.indexOf('traceConsentRevocationAttempt') < 0;
      }) || frames[0] || 'unknown';
      var trace = {
        at: new Date(Number(now())).toISOString(),
        operation: 'work-consent.revoke',
        runId: state.run && state.run.runId || '',
        consentId: state.consentId,
        eventSource: eventSource,
        activeElementId: eventTargetId,
        callStack: frames
      };
      try {
        var history = Array.isArray(traceRoot.__workModeConsentRevocationTrace)
          ? traceRoot.__workModeConsentRevocationTrace : [];
        history.push(trace);
        traceRoot.__workModeConsentRevocationTrace = history.slice(-20);
      } catch (_) {}
      try {
        if (traceRoot.console && typeof traceRoot.console.warn === 'function') {
          traceRoot.console.warn('[Work Mode Consent revoke trace]', trace);
        }
      } catch (_) {}
    }
    function bindDshSession(sessionId) {
      sessionId = String(sessionId || '');
      if (!/^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(sessionId)) {
        return { ok: false, error: 'invalid-dsh-session-id' };
      }
      if (!state.run || !['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled'].includes(state.run.status)) {
        return { ok: false, error: 'work-run-required' };
      }
      if (state.executor !== 'dsh') return { ok: false, error: 'dsh-executor-required' };
      if (state.dshSessionId && state.dshSessionId !== sessionId) return { ok: false, error: 'dsh-session-already-bound' };
      state.dshSessionId = sessionId;
      changed();
      return { ok: true, runId: state.run.runId, sessionId: sessionId };
    }
    async function revokeKnownConsent() {
      if (!state.consentId || !state.run) { clearConsent(); return { ok: true, noOp: true }; }
      if (TERMINAL_RUN_STATUSES.indexOf(state.run.status) >= 0) {
        clearConsent(true);
        return { ok: true, noOp: true, terminalRun: true };
      }
      traceConsentRevocationAttempt();
      state.revocationRequired = true;
      changed();
      var result;
      try { result = await runtime.revokeConsent(state.run.runId, state.consentId); }
      catch (_) { result = { ok: false, error: 'consent-revoke-failed' }; }
      if (!result || result.ok !== true) {
        state.error = safeMessage(result, 'consent-revoke-failed');
        state.notice = '撤销未确认；Run 保持不可启动。可取消 Run 使 Home Node 关闭授权。';
        changed();
        return { ok: false, error: state.error };
      }
      clearConsent(true);
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.notice = '授权已撤销。';
      changed();
      return result;
    }
    async function setExecutor(executor) {
      executor = String(executor || 'native');
      if (executor !== 'native' && executor !== 'dsh') return { ok: false, error: 'invalid-executor' };
      if (state.busy !== '') return { ok: false, error: 'operation-busy' };
      if (state.dshSessionId && executor !== 'dsh') return { ok: false, error: 'dsh-session-already-bound' };
      var activeRun = state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0;
      var changingExecutor = executor !== state.executor;
      if (activeRun && state.run.status !== 'queued' && changingExecutor) {
        return { ok: false, error: 'active-run-engine-locked' };
      }
      if (executor === 'dsh') {
        await refreshDshStatus();
        if (!state.dshStatus || state.dshStatus.enabled !== true) {
          state.error = 'dsh-host-disabled';
          state.notice = 'Native 保持可用；DSH 需由 Dev Launcher 显式启用。';
          changed();
          return { ok: false, error: 'dsh-host-disabled' };
        }
        if (state.run && state.run.status === 'queued' && !state.run.executorSelection && state.profileRef) {
          var queuedSelection = await buildExecutorSelectionSnapshot({
            roleId: state.executorSelection.roleId,
            profileRef: state.profileRef,
            presetId: state.executorSelection.presetId
          });
          if (!queuedSelection) return { ok: false, error: 'executor-selection-unavailable' };
          var queuedPinned = await pinRunExecutorSelection(queuedSelection);
          if (!queuedPinned || queuedPinned.ok !== true) return queuedPinned || { ok: false, error: 'run-executor-selection-failed' };
        }
      }
      if (changingExecutor && state.run && state.run.status === 'queued' && state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      state.executor = executor;
      state.dshSessionId = '';
      state.error = '';
      state.notice = executor === 'dsh'
        ? '已选择 DSH；Middle Brain 负责规划和复核，项目 Agent Memory Recall 仅在单独选择并授权后发送。'
        : '已选择 Native Work Runtime。';
      changed();
      return { ok: true, executor: executor };
    }

    async function setProfileRef(profileRef) {
      profileRef = String(profileRef || '');
      if (profileRef === state.profileRef) return { ok: true, unchanged: true };
      if (state.run && TERMINAL_RUN_STATUSES.indexOf(state.run.status) < 0 && state.run.executorSelection
        && profileRef !== String(state.run.executorSelection.profileRef || '')) {
        return { ok: false, error: 'run-executor-selection-locked' };
      }
      var nextChoice = Object.assign({}, state.executorSelection, { profileRef: profileRef });
      if (state.executor === 'dsh' && state.run && state.run.status === 'queued' && !state.run.executorSelection) {
        var snapshot = await buildExecutorSelectionSnapshot(nextChoice);
        if (!snapshot) return { ok: false, error: 'executor-selection-unavailable' };
        var pinned = await pinRunExecutorSelection(snapshot);
        if (!pinned || pinned.ok !== true) return pinned || { ok: false, error: 'run-executor-selection-failed' };
      }
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      state.profileRef = profileRef;
      state.executorSelection = { roleId: nextChoice.roleId || '', presetId: nextChoice.presetId || 'general' };
      state.preview = null;
      state.previewKey = '';
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.memoryConfirmed = false;
      state.memoryConfirmedKey = '';
      resetMemoryDerivedConfirmations();
      state.error = '';
      state.notice = 'Provider Profile 已切换，请重新核对范围。';
      persistProjectDraft();
      changed();
      return { ok: true };
    }

    async function setExecutorSelection(selection) {
      if (!executorCore || typeof executorCore.normalizeChoice !== 'function') return { ok: false, error: 'executor-selection-unavailable' };
      var normalized = executorCore.normalizeChoice(selection);
      if (!normalized) return { ok: false, error: 'invalid-executor-selection' };
      if (state.busy !== '') return { ok: false, error: 'operation-busy' };
      if (state.dshSessionId && state.executor !== 'dsh') return { ok: false, error: 'dsh-session-already-bound' };
      if (state.run && ['running', 'cancel_requested'].indexOf(state.run.status) >= 0) {
        return { ok: false, error: 'active-run-engine-locked' };
      }
      var snapshot = await buildExecutorSelectionSnapshot(normalized);
      if (!snapshot) return { ok: false, error: 'executor-selection-unavailable' };
      if (state.run && TERMINAL_RUN_STATUSES.indexOf(state.run.status) < 0 && state.run.executorSelection) {
        return JSON.stringify(state.run.executorSelection) === JSON.stringify(snapshot)
          ? { ok: true, unchanged: true, executorSelection: normalized }
          : { ok: false, error: 'run-executor-selection-locked' };
      }
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      if (state.run && state.run.status === 'queued') {
        var pinned = await pinRunExecutorSelection(snapshot);
        if (!pinned || pinned.ok !== true) return pinned || { ok: false, error: 'run-executor-selection-failed' };
      }
      state.profileRef = normalized.profileRef;
      state.executorSelection = { roleId: normalized.roleId, presetId: normalized.presetId };
      state.workspaceWriteAccepted = false; state.workspaceWriteAcceptedKey = '';
      if (state.run && TERMINAL_RUN_STATUSES.indexOf(state.run.status) >= 0) state.dshSessionId = '';
      state.preview = null;
      state.previewKey = '';
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.memoryConfirmed = false;
      state.memoryConfirmedKey = '';
      resetMemoryDerivedConfirmations();
      state.error = '';
      state.notice = '执行者已选择；角色、预设、Provider Route 和工具范围会固定在本次 Run。';
      persistProjectDraft();
      changed();
      return { ok: true, executorSelection: normalized, run: state.run };
    }
    async function setSelectedProject(projectRef) {
      if (state.busy) return { ok: false, error: 'operation-busy' };
      if (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0) {
        return { ok: false, error: 'active-run-must-be-closed' };
      }
      projectRef = String(projectRef || '');
      if (projectRef === state.selectedProjectRef) {
        if (projectRef && !state.projectSnapshot && typeof workspace.wsGetWorkModeProjectSnapshot === 'function') {
          return await refreshProjectSnapshot(projectRef);
        }
        return { ok: true, unchanged: true };
      }
      if (projectRef && !/^[A-Za-z0-9_.:-]{1,180}$/.test(projectRef)) {
        state.error = 'invalid-project-ref';
        changed();
        return { ok: false, error: state.error };
      }
      if (projectRef) {
        var access = await projectAccessStatus(projectRef);
        if (!access.ok) {
          state.error = access.error;
          changed();
          return access;
        }
      }
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      state.selectedProjectRef = projectRef;
      state.preview = null;
      state.previewKey = '';
      state.projectSnapshot = null;
      state.projectSnapshotError = '';
      state.fileIds = [];
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.storageRiskAccepted = false;
      state.workspaceWriteAccepted = false; state.workspaceWriteAcceptedKey = '';
      state.memorySelectedIds = [];
      state.memorySnapshot = null;
      state.memoryConfirmed = false;
      state.memoryConfirmedKey = '';
      resetMemoryDerivedConfirmations();
      state.memoryRecall = { ok: false, records: [], error: projectRef ? 'memory-recall-loading' : 'project-required' };
      state.memoryCandidate = null;
      state.memoryCandidateConfirmed = false;
      state.linkedMemoryRecords = [];
      state.run = null;
      state.dshSessionId = '';
      state.selectedResult = null;
      state.runEvents = [];
      state.runEventsRunId = '';
      state.runEventsStatus = 'idle';
      clearConsent();
      state.error = '';
      if (projectRef && typeof workspace.wsGetWorkModeProjectSnapshot === 'function') {
        var loaded = await refreshProjectSnapshot(projectRef);
        if (!loaded.ok) state.projectSnapshotError = loaded.error;
      }
      persistProjectDraft();
      state.notice = projectRef ? '项目已切换。请检查文件预览并选择范围；项目路径不会由浏览器猜测。' : '项目选择已清空。';
      changed();
      return { ok: true };
    }
    async function refreshMemoryRecall(projectRef) {
      projectRef = String(projectRef || state.selectedProjectRef || (state.run && state.run.projectRef) || '');
      var runProjectRef = state.run ? state.run.projectRef : state.selectedProjectRef;
      if (state.consentId && (state.memorySelectedIds.length || projectRef !== runProjectRef)) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      if (!projectRef || typeof runtime.previewMemoryRecall !== 'function') {
        state.memoryRecall = { ok: false, records: [], error: 'agent-memory-authority-unavailable' };
        state.memorySelectedIds = [];
        state.memorySnapshot = null;
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        resetMemoryDerivedConfirmations();
        state.confirmedKey = '';
        if (state.preview) {
          state.previewKey = currentScopeKey(state.preview, null);
          state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
        }
        changed();
        return { ok: false, error: 'agent-memory-authority-unavailable' };
      }
      state.memoryRecallBusy = 'loading';
      changed();
      var result;
      try { result = await runtime.previewMemoryRecall({ projectRef: projectRef }); }
      catch (_) { result = { ok: false, error: 'agent-memory-query-failed' }; }
      state.memoryRecallBusy = '';
      state.memoryRecall = result && result.ok === true ? result
        : { ok: false, records: [], error: safeMessage(result, 'agent-memory-query-failed') };
      state.memorySelectedIds = [];
      state.memorySnapshot = null;
      state.memoryConfirmed = false;
      state.memoryConfirmedKey = '';
      resetMemoryDerivedConfirmations();
      state.confirmedKey = '';
      if (state.preview) {
        state.previewKey = currentScopeKey(state.preview, null);
        state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      }
      state.error = result && result.ok === true ? '' : state.memoryRecall.error;
      changed();
      return result || { ok: false, error: 'agent-memory-query-failed' };
    }
    async function setMemorySelection(values) {
      if (state.run && state.run.workflowId === 'app.builder') return { ok: false, error: 'app-builder-memory-isolated' };
      if (!Array.isArray(values) || values.length > (memoryRecall.MAX_RECORDS || 12)) {
        return { ok: false, error: 'memory-selection-limit' };
      }
      var next = values.map(String).sort();
      if (next.some(function (id, index) { return !/^am_[A-Za-z0-9-]{36}$/.test(id) || (index && id === next[index - 1]); })) {
        return { ok: false, error: 'memory-selection-invalid' };
      }
      var allowed = state.memoryRecall && Array.isArray(state.memoryRecall.records)
        ? state.memoryRecall.records.map(function (record) { return record.memoryId; }) : [];
      if (next.some(function (id) { return allowed.indexOf(id) < 0; })) return { ok: false, error: 'memory-selection-changed' };
      if (sameArray(next, state.memorySelectedIds)) return { ok: true, unchanged: true };
      if (state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      state.memoryRecallBusy = 'selecting';
      state.memoryConfirmed = false;
      state.confirmedKey = '';
      resetMemoryDerivedConfirmations();
      changed();
      var result;
      if (!next.length) result = { ok: true, records: state.memoryRecall.records, snapshot: null, count: 0 };
      else {
        try { result = await runtime.previewMemoryRecall({ projectRef: state.selectedProjectRef, recordIds: next }); }
        catch (_) { result = { ok: false, error: 'agent-memory-query-failed' }; }
      }
      state.memoryRecallBusy = '';
      if (!result || result.ok !== true || (next.length && (!result.snapshot || result.snapshot.recordCount !== next.length))) {
        state.memorySelectedIds = [];
        state.memorySnapshot = null;
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        resetMemoryDerivedConfirmations();
        state.error = safeMessage(result, 'memory-selection-changed');
        if (state.preview) {
          state.previewKey = currentScopeKey(state.preview, null);
          state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
        }
        changed();
        return result || { ok: false, error: 'memory-selection-changed' };
      }
      state.memoryRecall = result;
      state.memorySelectedIds = next;
      state.memorySnapshot = result.snapshot || null;
      state.memoryConfirmedKey = '';
      if (state.preview) {
        state.previewKey = currentScopeKey(state.preview, state.memorySnapshot);
        state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      }
      state.notice = next.length ? '记忆范围已变化。仅本地预览；请单独授权向 Agent Provider 发送。' : '已清空记忆外发范围。';
      state.error = '';
      changed();
      return { ok: true, selectedIds: next.slice(), snapshot: state.memorySnapshot };
    }
    async function createRun(projectRef, options) {
      options = options || {};
      projectRef = String(projectRef || state.selectedProjectRef || '');
      var selectedPreset = String(state.executorSelection && state.executorSelection.presetId || 'general');
      var workflowId = String(options.workflowId || (selectedPreset === 'coding' ? 'coding.workspace' : 'project.audit.readonly'));
      var appDraftRef = String(options.appDraftRef || '');
      var appBuilder = workflowId === 'app.builder';
      var coding = workflowId === 'coding.workspace';
      if (!projectRef || typeof homeNode.create !== 'function') return { ok: false, error: 'project-required' };
      if ((appBuilder && (!/^ad_[A-Fa-f0-9-]{36}$/.test(appDraftRef)
        || state.executor !== 'dsh' || state.executorSelection.presetId !== 'app-builder'))
        || (coding && (state.executor !== 'dsh' || selectedPreset !== 'coding'))
        || (!appBuilder && !coding && workflowId !== 'project.audit.readonly')
        || (!coding && selectedPreset === 'coding')) return { ok: false, error: 'app-builder-selection-required' };
      if (state.busy || (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) < 0)
        || state.activeRuns.length) return { ok: false, error: 'active-run-must-be-closed' };
      if (pendingCreate) return pendingCreate;
      if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(projectRef)) return { ok: false, error: 'invalid-project-ref' };
      var selectionSnapshot = null;
      if (state.executor === 'dsh' && state.profileRef) {
        selectionSnapshot = await buildExecutorSelectionSnapshot({
          roleId: state.executorSelection.roleId,
          profileRef: state.profileRef,
          presetId: state.executorSelection.presetId
        });
        if (!selectionSnapshot) return { ok: false, error: 'executor-selection-unavailable' };
      } else if (state.executor === 'dsh' && state.executorSelection.roleId) {
        return { ok: false, error: 'executor-selection-unavailable' };
      }
      var access = await projectAccessStatus(projectRef);
      if (!access.ok) {
        state.error = access.error;
        state.notice = '';
        changed();
        return access;
      }
      if (requireFileSelection && projectRef !== state.selectedProjectRef) {
        state.error = 'project-access-denied';
        changed();
        return { ok: false, error: state.error };
      }
      if (typeof workspace.wsGetWorkModeProjectSnapshot === 'function') {
        if (projectRef === state.selectedProjectRef) {
          var latestSnapshot = await refreshProjectSnapshot(projectRef);
          if (!latestSnapshot.ok) return latestSnapshot;
        } else if (requireFileSelection) {
          state.error = 'project-access-denied';
          changed();
          return { ok: false, error: state.error };
        } else {
          var requestedSnapshot = await loadProjectSnapshot(projectRef);
          if (requestedSnapshot.ok) state.projectSnapshot = requestedSnapshot.snapshot;
        }
      } else if (requireFileSelection) {
        state.error = 'workspace-unavailable';
        changed();
        return { ok: false, error: state.error };
      }
      if (requireFileSelection && !appBuilder && !state.fileIds.length) {
        state.error = 'file-selection-required';
        changed();
        return { ok: false, error: state.error };
      }
      if (state.projectSnapshot && state.fileIds.some(function (id) {
        return !state.projectSnapshot.files.some(function (file) { return file.fileId === id; });
      })) {
        state.error = 'consent-file-scope-invalid';
        state.fileIds = [];
        persistProjectDraft();
        changed();
        return { ok: false, error: state.error };
      }
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      state.preview = null;
      state.previewKey = '';
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.storageRiskAccepted = false;
      state.workspaceWriteAccepted = false; state.workspaceWriteAcceptedKey = '';
      state.busy = 'creating';
      state.error = '';
      state.notice = '正在 Home Node 创建本地 Run。';
      changed();
      pendingCreate = (async function () {
        var result;
        try {
          result = await homeNode.create({ requestId: makeRequestId(), workflowId: workflowId, projectRef: projectRef,
            ...(appBuilder ? { appDraftRef: appDraftRef } : {}),
            ...(selectionSnapshot ? { executorSelection: selectionSnapshot } : {}) });
        }
        catch (_) { result = { ok: false, error: 'work-run-create-failed' }; }
        if (!result || result.ok !== true || !result.run) {
          state.error = safeMessage(result, 'work-run-create-failed');
          state.notice = '';
          state.busy = '';
          pendingCreate = null;
          changed();
          return result || { ok: false, error: 'work-run-create-failed' };
        }
        state.run = result.run;
        state.dshSessionId = '';
        state.selectedProjectRef = projectRef;
        if (appBuilder) state.fileIds = [];
        state.storageRiskAccepted = false;
        state.preview = null;
        state.previewKey = '';
        state.confirmedKey = '';
        state.currentGrantKey = '';
        clearConsent();
        state.selectedResult = null;
        state.runEvents = [];
        state.runEventsRunId = '';
        state.runEventsStatus = 'idle';
        state.memoryProvenance = null;
        state.memoryCandidate = null;
        state.memoryCandidateConfirmed = false;
        state.linkedMemoryRecords = [];
        state.memorySelectedIds = [];
        state.memorySnapshot = null;
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        resetMemoryDerivedConfirmations();
        state.memoryRecall = { ok: false, records: [], error: 'memory-recall-loading' };
        state.busy = '';
        state.notice = 'Run 已在 Home Node 创建。当前尚无外发授权。';
        persistProjectDraft();
        pendingCreate = null;
        changed();
        if (!appBuilder && typeof runtime.previewMemoryRecall === 'function') await refreshMemoryRecall(projectRef);
        await refreshRunEvents(result.run.runId);
        await refreshMemoryProvenance(result.run.runId);
        return result;
      })();
      return pendingCreate;
    }
    async function selectRun(runId) {
      if (typeof homeNode.get !== 'function') return { ok: false, error: 'work-run-api-unavailable' };
      var result;
      try { result = await homeNode.get(String(runId || '')); }
      catch (_) { result = { ok: false, error: 'work-run-api-unavailable' }; }
      if (!result || result.ok !== true || !result.run) return result || { ok: false, error: 'work-run-not-found' };
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      state.run = result.run;
      state.memoryProvenance = { runId: result.run.runId, status: 'loading', consent: null, records: [], result: null };
      state.dshSessionId = '';
      state.selectedProjectRef = result.run.projectRef;
      await refreshDshStatus();
      state.executor = state.activeDshRunIds.indexOf(result.run.runId) >= 0 || !!result.run.executorSelection ? 'dsh' : 'native';
      if (result.run.executorSelection) {
        state.profileRef = result.run.executorSelection.profileRef;
        state.executorSelection = { roleId: result.run.executorSelection.roleId, presetId: result.run.executorSelection.presetId };
      } else {
        state.executorSelection = { roleId: '', presetId: 'general' };
      }
      state.selectedResult = null;
      state.memoryCandidate = null;
      state.memoryCandidateConfirmed = false;
      state.linkedMemoryRecords = [];
      state.storageRiskAccepted = false;
      state.preview = null;
      state.previewKey = '';
      state.fileIds = [];
      state.confirmedKey = '';
      state.currentGrantKey = '';
      state.memorySelectedIds = [];
      state.memorySnapshot = null;
      state.memoryConfirmed = false;
      state.memoryConfirmedKey = '';
      resetMemoryDerivedConfirmations();
      state.memoryRecall = { ok: false, records: [], error: 'memory-recall-loading' };
      state.notice = result.run.status === 'queued'
        ? '已恢复排队 Run；刷新不会恢复授权，也不会自动启动。'
        : 'Run 状态来自 Home Node。';
      state.error = '';
      state.projectSnapshot = null;
      state.projectSnapshotError = '';
      persistProjectDraft();
      changed();
      if (typeof workspace.wsGetWorkModeProjectSnapshot === 'function') {
        var runSnapshot = await refreshProjectSnapshot(result.run.projectRef);
        if (!runSnapshot.ok) state.notice = 'Run 已恢复但文件预览读取失败；授权未恢复。';
      }
      if (result.run.workflowId !== 'app.builder' && typeof runtime.previewMemoryRecall === 'function') {
        await refreshMemoryRecall(result.run.projectRef);
      }
      await refreshRunEvents(result.run.runId);
      await refreshMemoryProvenance(result.run.runId);
      return result;
    }
    async function refreshPreview() {
      if (!state.run || !state.profileRef || typeof runtime.previewAuthorization !== 'function') {
        return { ok: false, error: 'run-and-provider-required' };
      }
      var result;
      try { result = await runtime.previewAuthorization({ runId: state.run.runId, profileRef: state.profileRef }); }
      catch (_) { result = { ok: false, error: 'authorization-preview-failed' }; }
      if (!result || result.ok !== true) {
        state.preview = null;
        state.previewKey = '';
        state.confirmedKey = '';
        state.currentGrantKey = '';
        state.error = safeMessage(result, 'authorization-preview-failed');
        changed();
        return result || { ok: false, error: 'authorization-preview-failed' };
      }
      if (state.memorySelectedIds.length) {
        var priorMemoryHash = state.memorySnapshot && state.memorySnapshot.contextHash || '';
        var freshMemory;
        state.memoryRecallBusy = 'checking';
        try { freshMemory = await runtime.previewMemoryRecall({ projectRef: result.projectRef, recordIds: state.memorySelectedIds.slice() }); }
        catch (_) { freshMemory = { ok: false, error: 'agent-memory-query-failed' }; }
        state.memoryRecallBusy = '';
        if (!freshMemory || freshMemory.ok !== true || !freshMemory.snapshot
          || freshMemory.snapshot.recordCount !== state.memorySelectedIds.length) {
          state.memoryConfirmed = false;
          resetMemoryDerivedConfirmations();
          state.confirmedKey = '';
          if (state.consentId) await revokeKnownConsent();
          state.error = safeMessage(freshMemory, 'memory-scope-changed');
          changed();
          return { ok: false, error: state.error };
        }
        state.memoryRecall = freshMemory;
        state.memorySnapshot = freshMemory.snapshot;
        if (priorMemoryHash !== state.memorySnapshot.contextHash) {
          state.memoryConfirmed = false;
          state.confirmedKey = '';
          resetMemoryDerivedConfirmations();
        }
      }
      var nextMemoryConfirmationKey = memoryConfirmationKey(memoryScopeFor(result, state.memorySnapshot));
      if (state.memoryConfirmed && (!nextMemoryConfirmationKey
        || state.memoryConfirmedKey !== nextMemoryConfirmationKey)) {
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        state.confirmedKey = '';
      }
      var nextReviewDerivedKey = memoryDerivedConfirmationKey('review', result, state.memorySnapshot);
      if (state.memoryDerivedReviewConfirmed && state.memoryDerivedReviewKey !== nextReviewDerivedKey) {
        state.memoryDerivedReviewConfirmed = false;
        state.memoryDerivedReviewKey = '';
      }
      var nextResultDerivedKey = memoryDerivedConfirmationKey('result', result, state.memorySnapshot);
      if (state.memoryDerivedResultConfirmed && state.memoryDerivedResultKey !== nextResultDerivedKey) {
        state.memoryDerivedResultConfirmed = false;
        state.memoryDerivedResultKey = '';
      }
      var nextKey = currentScopeKey(result, state.memorySnapshot);
      if (state.consentId && (nextKey !== state.consentKey || !sameArray(state.fileIds, state.consentFileIds))) {
        var revoked = await revokeKnownConsent();
        state.confirmedKey = '';
        state.currentGrantKey = '';
        if (!revoked.ok) return { ok: false, error: 'consent-revocation-required' };
      }
      state.preview = result;
      state.run = result.run;
      state.previewKey = nextKey;
      state.currentGrantKey = makeGrantKey(nextKey, state.fileIds);
      if (state.confirmedKey && state.confirmedKey !== state.currentGrantKey) state.confirmedKey = '';
      state.error = '';
      changed();
      return result;
    }
    function sameArray(a, b) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every(function (value, index) { return value === b[index]; });
    }
    function workspaceWriteKey() {
      if (!state.run || state.run.workflowId !== 'coding.workspace') return '';
      return JSON.stringify({ runId: state.run.runId, previewKey: state.previewKey,
        fileIds: state.fileIds.slice().sort(), presetId: state.run.executorSelection && state.run.executorSelection.presetId || '' });
    }
    function workspaceWriteAccepted() {
      var key = workspaceWriteKey();
      return !!key && state.workspaceWriteAccepted === true && state.workspaceWriteAcceptedKey === key;
    }
    async function confirmWorkspaceWrite(accepted) {
      if (!state.run || state.run.workflowId !== 'coding.workspace' || state.busy === 'granting' || state.busy === 'starting') {
        return { ok: false, error: 'coding-run-required' };
      }
      if (accepted !== true && state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      state.workspaceWriteAccepted = accepted === true;
      state.workspaceWriteAcceptedKey = accepted === true ? workspaceWriteKey() : '';
      state.confirmedKey = '';
      state.error = '';
      state.notice = accepted === true
        ? '已确认 Coding Workspace 写入范围；还需确认 Provider 外发和 Result 保存风险。'
        : 'Workspace 写入授权已关闭；Coding Run 不会修改文件。';
      changed();
      return { ok: state.workspaceWriteAccepted };
    }
    async function setFileIds(values) {
      var normalized = fileIds(values);
      if (state.selectedProjectRef && typeof workspace.wsGetWorkModeProjectSnapshot === 'function') {
        var freshSnapshot = await refreshProjectSnapshot(state.selectedProjectRef);
        if (!freshSnapshot.ok) return freshSnapshot;
      }
      var currentFiles = state.preview && state.preview.files ? state.preview.files
        : (state.projectSnapshot && state.projectSnapshot.files ? state.projectSnapshot.files : []);
      var allowed = currentFiles.map(function (file) { return file.fileId; });
      if (!normalized || normalized.some(function (id) { return allowed.indexOf(id) < 0; })) return { ok: false, error: 'consent-file-scope-invalid' };
      if (sameArray(normalized, state.fileIds)) return { ok: true, unchanged: true };
      var revoked = await revokeKnownConsent();
      if (!revoked.ok) return revoked;
      state.fileIds = normalized;
      state.workspaceWriteAccepted = false; state.workspaceWriteAcceptedKey = '';
      state.confirmedKey = '';
      state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      state.notice = state.run ? '文件范围已变化。请重新核对 Provider 与文件范围。'
        : '文件范围草稿已更新；授权仍未创建。';
      state.error = '';
      persistProjectDraft();
      changed();
      return { ok: true };
    }
    function confirmScope(confirmed) {
      var appBuilder = !!(state.run && state.run.workflowId === 'app.builder');
      var coding = !!(state.run && state.run.workflowId === 'coding.workspace');
      var memoryScope = memoryScopeFor(state.preview, state.memorySnapshot);
      var memoryConfirmed = !memoryScope || (state.memoryConfirmed === true
        && state.memoryConfirmedKey === memoryConfirmationKey(memoryScope));
      var derivedConfirmed = !memoryScope || !!memoryDerivedScopeFor(state.preview, state.memorySnapshot);
      if (confirmed !== true || !state.preview || (!appBuilder && !state.fileIds.length) || state.revocationRequired || !memoryConfirmed) {
        state.confirmedKey = '';
        changed();
        return { ok: false, error: memoryConfirmed ? 'explicit-consent-required' : 'explicit-memory-consent-required' };
      }
      if (coding && !workspaceWriteAccepted()) {
        state.confirmedKey = '';
        changed();
        return { ok: false, error: 'workspace-write-consent-required' };
      }
      if (!derivedConfirmed) {
        state.confirmedKey = '';
        changed();
        return { ok: false, error: 'explicit-memory-derived-consent-required' };
      }
      state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      state.confirmedKey = state.currentGrantKey;
      state.error = '';
      state.notice = memoryScope
        ? '确认覆盖当前 Provider、项目、文件及所选记忆内容与版本。'
        : '确认仅覆盖当前展示的 Provider、项目和所选文件。';
      changed();
      return { ok: true };
    }
    async function confirmMemoryScope(confirmed) {
      var scope = memoryScopeFor(state.preview, state.memorySnapshot);
      if (confirmed !== true) {
        if (state.consentId) {
          var revoked = await revokeKnownConsent();
          if (!revoked.ok) return revoked;
        }
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        resetMemoryDerivedConfirmations();
        state.confirmedKey = '';
        changed();
        return { ok: true, confirmed: false };
      }
      if (!scope || !state.memorySnapshot || state.memoryRecallBusy || state.revocationRequired) {
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        state.confirmedKey = '';
        changed();
        return { ok: false, error: 'explicit-memory-consent-required' };
      }
      if (state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      state.memoryConfirmed = true;
      state.memoryConfirmedKey = memoryConfirmationKey(scope);
      state.confirmedKey = '';
      state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      state.notice = '记忆授权仅覆盖当前显示的记录摘要、版本与 Agent Provider 路由。';
      state.error = '';
      changed();
      return { ok: true, confirmed: true };
    }
    async function confirmMemoryDerivedConsent(sink, confirmed) {
      sink = String(sink || '');
      if (sink !== 'review' && sink !== 'result') return { ok: false, error: 'invalid-memory-derived-sink' };
      var key = memoryDerivedConfirmationKey(sink, state.preview, state.memorySnapshot);
      if (!key || state.memoryRecallBusy || state.busy === 'granting' || state.busy === 'starting' || state.revocationRequired) {
        return { ok: false, error: 'memory-derived-scope-unavailable' };
      }
      if (sink === 'result' && confirmed === true && !state.storageRiskAccepted) {
        return { ok: false, error: 'storage-risk-acceptance-required' };
      }
      if (state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      if (sink === 'review') {
        state.memoryDerivedReviewConfirmed = confirmed === true;
        state.memoryDerivedReviewKey = confirmed === true ? key : '';
      } else {
        state.memoryDerivedResultConfirmed = confirmed === true;
        state.memoryDerivedResultKey = confirmed === true ? key : '';
      }
      state.confirmedKey = '';
      state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
      state.error = '';
      state.notice = confirmed === true
        ? (sink === 'review' ? '已单独确认向当前 Middle Brain Review 路由发送可能含记忆衍生内容的报告。'
          : '已单独确认将 memory-derived Work Result 以明文保存；仍需文件范围确认。')
        : '记忆衍生内容授权已撤销；旧 Run Consent 已关闭。';
      changed();
      return { ok: true, confirmed: confirmed === true };
    }
    async function confirmStorageRisk(accepted) {
      if (accepted !== true && state.consentId) {
        var revoked = await revokeKnownConsent();
        if (!revoked.ok) return revoked;
      }
      state.storageRiskAccepted = accepted === true;
      if (accepted !== true) {
        state.memoryDerivedResultConfirmed = false;
        state.memoryDerivedResultKey = '';
        state.confirmedKey = '';
      }
      state.error = '';
      changed();
      return { ok: state.storageRiskAccepted };
    }
    async function grant(expiresInMs, confirmed) {
      if (pendingGrant) return pendingGrant;
      if (state.consentId && state.consent && state.consent.status === 'active') {
        return { ok: true, duplicate: true, consent: state.consent };
      }
      expiresInMs = Number(expiresInMs);
      var memoryScope = memoryScopeFor(state.preview, state.memorySnapshot);
      var memoryDerivedScope = memoryDerivedScopeFor(state.preview, state.memorySnapshot);
      var memoryConfirmed = !memoryScope || (state.memoryConfirmed === true
        && state.memoryConfirmedKey === memoryConfirmationKey(memoryScope));
      var appBuilder = !!(state.run && state.run.workflowId === 'app.builder');
      var coding = !!(state.run && state.run.workflowId === 'coding.workspace');
      if (confirmed !== true || !state.storageRiskAccepted || !state.confirmedKey || !state.preview || (!appBuilder && !state.fileIds.length)
        || !memoryConfirmed || (memoryScope && !memoryDerivedScope)
        || (coding && !workspaceWriteAccepted())
        || (!coding && state.workspaceWriteAccepted === true)
        || !Number.isSafeInteger(expiresInMs) || expiresInMs < 60000 || expiresInMs > 60 * 60 * 1000
        || state.revocationRequired) return { ok: false, error: 'explicit-consent-required' };
      var acknowledgedKey = state.confirmedKey;
      state.busy = 'granting';
      state.notice = '正在将这份明确授权写入 Home Node。不会自动启动。';
      state.error = '';
      changed();
      pendingGrant = (async function () {
        var latest = await refreshPreview();
        if (!latest || latest.ok !== true || state.currentGrantKey !== acknowledgedKey || state.confirmedKey !== acknowledgedKey) {
          state.confirmedKey = '';
          state.busy = '';
          pendingGrant = null;
          state.error = 'authorization-preview-changed';
          state.notice = 'Provider、项目或文件范围已变化；没有授予授权，请重新核对。';
          changed();
          return { ok: false, error: 'authorization-preview-changed' };
        }
        var result;
        try {
          result = await runtime.grantConsent({
            runId: state.run.runId,
            profileRef: state.profileRef,
            fileIds: state.fileIds.slice(),
            workspaceWriteConfirmed: coding && workspaceWriteAccepted(),
            memoryScope: memoryScope,
            memoryDerivedScope: memoryDerivedScope,
            memoryConfirmed: memoryScope ? true : false,
            expiresInMs: expiresInMs,
            termsVersion: state.preview.terms.version,
            confirmed: true
          });
        } catch (_) { result = { ok: false, error: 'consent-grant-failed' }; }
        state.busy = '';
        state.confirmedKey = '';
        state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
        if (!result || result.ok !== true || !result.consent) {
          state.error = safeMessage(result, 'consent-grant-failed');
          state.notice = '授权未创建。';
          pendingGrant = null;
          changed();
          return result || { ok: false, error: 'consent-grant-failed' };
        }
        state.consentId = result.consent.consentId;
        state.consent = result.consent;
        state.consentRevoked = false;
        state.consentKey = state.previewKey;
        state.consentFileIds = state.fileIds.slice();
        state.run = result.run || state.run;
        state.notice = '授权已保存。外发仍未开始；需单独按下“启动只读审计”。';
        pendingGrant = null;
        if (state.run && state.run.runId) await refreshMemoryProvenance(state.run.runId);
        changed();
        return result;
      })();
      return pendingGrant;
    }
    function consentStartFailure(record, run, preview, selectedFileIds, expectedMemoryScope, expectedMemoryDerivedScope) {
      if (!record || record.ok !== true) {
        if (record && record.error === 'consent-not-found') {
          return { code: 'consent-record-not-found', notice: consentNotice('consent-record-not-found'), clear: true };
        }
        var readCode = record && record.error === 'work-run-api-unavailable' ? 'work-run-api-unavailable' : 'consent-read-failed';
        return { code: 'consent-read-failed', notice: consentNotice(readCode) };
      }
      var consent = record.consent;
      if (!consent) return { code: 'consent-record-not-found', notice: consentNotice('consent-record-not-found'), clear: true };
      if (consent.status === 'revoked') {
        return { code: 'consent-already-revoked', notice: consentNotice('consent-already-revoked'), clear: true, revoked: true };
      }
      if (consent.status === 'expired' || !Number.isFinite(Number(consent.expiresAt))
        || Number(consent.expiresAt) <= now()) {
        return { code: 'consent-expired', notice: consentNotice('consent-expired'), clear: true };
      }
      if (consent.status !== 'active') {
        return { code: 'consent-no-longer-active', notice: consentNotice('consent-no-longer-active'), clear: true };
      }
      if (consent.runId !== run.runId) {
        return { code: 'consent-run-mismatch', notice: consentNotice('consent-run-mismatch'), revoke: true };
      }
      if (consent.projectRef !== run.projectRef) {
        return { code: 'consent-project-mismatch', notice: consentNotice('consent-project-mismatch'), revoke: true };
      }
      if ((run.workflowId === 'coding.workspace') !== (consent.workspaceWriteConfirmed === true)) {
        return { code: 'workspace-write-consent-required', notice: 'Home Node Consent 未包含当前 Coding 写入范围；Run 未启动。', revoke: true };
      }
      if (!preview || !preview.terms || consent.termsVersion !== preview.terms.version) {
        return { code: 'consent-terms-stale', notice: consentNotice('consent-terms-stale'), revoke: true };
      }
      if (!Array.isArray(consent.fileIds) || !sameArray(consent.fileIds.slice().sort(), selectedFileIds)) {
        return { code: 'consent-file-scope-mismatch', notice: consentNotice('consent-file-scope-mismatch'), revoke: true };
      }
      if (!memoryRecall.stableStringify
        || memoryRecall.stableStringify(consent.memoryScope || null) !== memoryRecall.stableStringify(expectedMemoryScope || null)) {
        return { code: 'consent-memory-scope-mismatch', notice: consentNotice('consent-memory-scope-mismatch'), revoke: true };
      }
      if (!memoryRecall.stableStringify
        || memoryRecall.stableStringify(consent.memoryDerivedScope || null) !== memoryRecall.stableStringify(expectedMemoryDerivedScope || null)) {
        return { code: 'consent-memory-derived-scope-mismatch', notice: consentNotice('consent-memory-derived-scope-mismatch'), revoke: true };
      }
      var expectedProviderScopes = (preview.providers || []).map(function (item) {
        var scope = item.scope || item;
        return {
          destination: scope.destination, providerRef: scope.providerRef,
          provider: scope.provider, model: scope.model, routeHash: scope.routeHash
        };
      });
      if (!sameScopes(consent.providerScopes, expectedProviderScopes)) {
        return { code: 'consent-provider-mismatch', notice: consentNotice('consent-provider-mismatch'), revoke: true };
      }
      return null;
    }
    async function start(options) {
      options = options || {};
      if (pendingStart) return pendingStart;
      if (state.executor === 'dsh' && !state.dshSessionId) {
        state.error = 'dsh-session-binding-required';
        state.notice = '请从 DSH 会话绑定当前 Run；未绑定的 DSH Gateway 请求不会执行。';
        changed();
        return { ok: false, error: 'dsh-session-binding-required' };
      }
      if (!state.run || !state.consentId || state.revocationRequired
        || (state.run.workflowId !== 'app.builder' && state.consentFileIds.length === 0)) {
        return { ok: false, error: 'consent-required' };
      }
      if (state.run.workflowId === 'coding.workspace'
        && (!String(options.taskPrompt || '').trim() || String(options.taskPrompt).length > 2400
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(String(options.taskPrompt || '')))) {
        state.error = 'coding-task-required'; state.notice = 'Coding Run 需要一条不超过 2400 个字符的任务描述。'; changed();
        return { ok: false, error: 'coding-task-required' };
      }
      if (!state.storageRiskAccepted) return { ok: false, error: 'storage-risk-acceptance-required' };
      state.busy = 'starting';
      state.notice = '正在重新核對 Provider、项目、文件和 Home Node 授权；确认后才会调用模型。';
      state.error = '';
      changed();
      pendingStart = (async function () {
        var latest = await refreshPreview();
        var key = latest && latest.ok ? makeGrantKey(state.previewKey, state.fileIds) : '';
        if (!latest || latest.ok !== true || state.previewKey !== state.consentKey
          || key !== makeGrantKey(state.consentKey, state.consentFileIds)) {
          state.busy = '';
          state.error = 'consent-scope-changed';
          state.notice = '授权范围发生变化，运行未启动。';
          await revokeKnownConsent();
          pendingStart = null;
          changed();
          return { ok: false, error: 'consent-scope-changed' };
        }
        var record;
        try { record = await homeNode.getConsent(state.run.runId, state.consentId); }
        catch (_) { record = { ok: false, error: 'consent-unavailable' }; }
        var expectedFiles = state.fileIds.slice().sort();
        var expectedMemoryScope = memoryScopeFor(state.preview, state.memorySnapshot);
        var expectedMemoryDerivedScope = memoryDerivedScopeFor(state.preview, state.memorySnapshot);
        var invalidConsent = consentStartFailure(record, state.run, state.preview, expectedFiles,
          expectedMemoryScope, expectedMemoryDerivedScope);
        if (invalidConsent) {
          state.busy = '';
          state.error = invalidConsent.code;
          if (invalidConsent.revoke) {
            var revoked = await revokeKnownConsent();
            if (revoked.ok) {
              state.confirmedKey = '';
              state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
              state.notice = invalidConsent.notice + '旧授权已关闭；重新核对后可再次启动。';
            } else {
              state.error = safeMessage(revoked, 'consent-revoke-failed');
              state.notice = consentNotice(state.error) + ' Run 未启动。';
            }
          } else {
            if (invalidConsent.clear) {
              clearConsent(invalidConsent.revoked === true);
              state.confirmedKey = '';
              state.currentGrantKey = makeGrantKey(state.previewKey, state.fileIds);
            }
            state.notice = invalidConsent.notice + (invalidConsent.clear ? ' Run 未启动；重新核对即可继续。' : '授权记录保持原样；检查连接后可重试。');
          }
          pendingStart = null;
          changed();
          return { ok: false, error: invalidConsent.code };
        }
        var consent = record.consent;
        var result;
        if (state.executor === 'dsh') {
          var dshFinished = false;
          var runId = state.run.runId;
          var pollDsh = (async function () {
            while (!dshFinished) {
              await new Promise(function (resolve) {
                setTimeout(resolve, 750);
              });
              if (dshFinished) break;
              try {
                var current = await homeNode.get(runId);
                if (current && current.ok === true && current.run) state.run = current.run;
              } catch (_) { /* next poll or final result will reconcile */ }
              await refreshRunEvents(runId);
              changed();
              if (state.run && ['completed', 'failed', 'cancelled'].indexOf(state.run.status) >= 0) break;
            }
          })();
          try {
            var dshStartInput = { runId: runId, profileRef: state.profileRef,
              consentId: state.consentId, sessionId: state.dshSessionId };
            if (state.run.workflowId === 'coding.workspace') dshStartInput.taskPrompt = String(options.taskPrompt || '');
            result = await runtime.startDsh(dshStartInput);
          } catch (_) { result = { ok: false, error: 'dsh-execution-failed' }; }
          dshFinished = true;
          try { await pollDsh; } catch (_) { /* Home Node remains the status authority */ }
        } else {
          try { result = await runtime.start({ runId: state.run.runId, profileRef: state.profileRef, consentId: state.consentId }); }
          catch (_) { result = { ok: false, error: 'work-run-start-failed' }; }
        }
        state.busy = '';
        if (result && result.run) state.run = result.run;
        if (!result || result.ok !== true) {
          var wasCancelled = String(result && result.error || '') === 'cancelled'
            || String(result && result.error || '') === 'execution-cancelled'
            || !!(result && result.run && ['cancelled', 'cancel_requested'].indexOf(result.run.status) >= 0)
            || !!(state.run && ['cancelled', 'cancel_requested'].indexOf(state.run.status) >= 0);
          if (wasCancelled) {
            state.error = '';
            state.notice = 'Run 已取消。';
            if (state.consentId) {
              await revokeKnownConsent();
              state.error = '';
              state.notice = 'Run 已取消。授权已撤销。';
            }
            if (state.run && state.run.runId) await refreshRunEvents(state.run.runId);
            await refresh();
            result = Object.assign({}, result || {}, { ok: false, error: 'cancelled', run: state.run });
          } else {
          state.error = safeMessage(result, state.executor === 'dsh' ? 'dsh-execution-failed' : 'work-run-start-failed');
          state.notice = 'Run 未完成。授权将撤销，不会自动重试。';
          await revokeKnownConsent();
          }
        } else {
          clearConsent();
          state.notice = state.run.workflowId === 'coding.workspace'
            ? 'Coding Run 已完成，Result 已由 Home Node 保存。'
            : (state.executor === 'dsh'
              ? 'DSH 只读审计已完成，Result 已由 Home Node 保存。'
              : '只读审计已完成，Result 由 Home Node 保存。');
          await refreshRunEvents(state.run.runId);
          await selectResult(state.run.runId);
          await refresh();
        }
        pendingStart = null;
        changed();
        return result;
      })();
      return pendingStart;
    }
    var pendingConfirmAndStart = null;
    async function confirmAndStart(expiresInMs, options) {
      if (pendingConfirmAndStart) return pendingConfirmAndStart;
      options = options || {};
      function reject(code) {
        state.error = code;
        state.notice = consentNotice(code);
        changed();
        return { ok: false, error: code };
      }
      if (!state.run || state.run.status !== 'queued') return reject('run-not-queued');
      if (state.executor === 'dsh' && !state.dshSessionId) return reject('dsh-session-binding-required');
      var hasActiveConsent = !!(state.consentId && state.consent && state.consent.status === 'active');
      if (!hasActiveConsent) {
        if (!state.storageRiskAccepted) return reject('storage-risk-acceptance-required');
        var appBuilder = !!(state.run && state.run.workflowId === 'app.builder');
        var coding = !!(state.run && state.run.workflowId === 'coding.workspace');
        if (!state.preview || (!appBuilder && !state.fileIds.length) || !state.confirmedKey
          || state.confirmedKey !== state.currentGrantKey || state.revocationRequired
          || (coding && !workspaceWriteAccepted())) {
          return reject('explicit-consent-required');
        }
      }
      pendingConfirmAndStart = (async function () {
        try {
          if (!hasActiveConsent) {
            var granted = await grant(expiresInMs, true);
            if (!granted || granted.ok !== true) return granted || { ok: false, error: 'consent-grant-failed' };
          }
          return await start(options);
        } finally { pendingConfirmAndStart = null; }
      })();
      return pendingConfirmAndStart;
    }
    async function revokeConsent() {
      if (!state.consentId) return { ok: false, error: 'consent-not-found' };
      var result = await revokeKnownConsent();
      if (result.ok) {
        state.memoryConfirmed = false;
        state.memoryConfirmedKey = '';
        resetMemoryDerivedConfirmations();
        state.confirmedKey = '';
        if (state.run) await refreshMemoryProvenance(state.run.runId);
        changed();
      }
      return result;
    }
    async function cancel(runId) {
      runId = String(runId || (state.run && state.run.runId) || '');
      if (!runId || typeof runtime.cancel !== 'function') return { ok: false, error: 'run-required' };
      state.notice = '正在请求 Home Node 取消 Run 并撤销授权。';
      state.error = '';
      changed();
      var result;
      try { result = await runtime.cancel(runId); }
      catch (_) { result = { ok: false, error: 'work-run-cancel-failed' }; }
      if (result && result.ok) {
        if (state.run && state.run.runId === runId) {
          state.run = result.run || state.run;
          clearConsent();
        }
        state.notice = '取消已由 Home Node 接收。';
      } else state.error = safeMessage(result, 'work-run-cancel-failed');
      await refresh();
      await refreshRunEvents(runId);
      await refreshMemoryProvenance(runId);
      changed();
      return result;
    }
    async function listWorkspaceProjects() {
      if (typeof workspace.wsGetWorkModeProjects === 'function') {
        try {
          var projected = await workspace.wsGetWorkModeProjects();
          if (!projected || projected.ok !== true || !Array.isArray(projected.projects)) {
            return { ok: false, error: String(projected && projected.error || 'workspace-unavailable') };
          }
          return { ok: true, projects: projected.projects };
        } catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
      }
      if (typeof workspace.wsGetProjects !== 'function') return { ok: false, error: 'workspace-unavailable' };
      try {
        var projects = await workspace.wsGetProjects();
        return Array.isArray(projects) ? { ok: true, projects: projects } : { ok: false, error: 'workspace-unavailable' };
      } catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
    }
    async function projectAccessStatus(projectRef) {
      var available = await listWorkspaceProjects();
      if (!available.ok) return available;
      var found = available.projects.some(function (project) {
        if (!project) return false;
        var id = project.id;
        if (id && typeof id === 'object') id = id.id || id.projectId || id.ref || id.value;
        return (typeof id === 'string' || typeof id === 'number') && String(id) === String(projectRef);
      });
      return found ? { ok: true } : { ok: false, error: 'project-access-denied' };
    }
    async function projectAccessAvailable(projectRef) {
      if (!projectRef) return false;
      var result = await projectAccessStatus(projectRef);
      return result.ok === true;
    }
    function selectedResultStatement(selected, selectionRef) {
      var report = selected && selected.result && selected.result.report;
      if (!report) return '';
      if (selectionRef === 'summary') return String(report.summary || '').trim();
      var match = /^finding:(\d{1,1})$/.exec(String(selectionRef || ''));
      var findings = Array.isArray(report.findings) ? report.findings : [];
      var index = match ? Number(match[1]) : -1;
      if (index < 0 || index >= findings.length) return '';
      var finding = findings[index];
      if (!finding || !finding.title || !finding.detail) return '';
      return String(finding.severity || 'info') + ' · ' + String(finding.title) + ': ' + String(finding.detail);
    }
    async function loadLinkedMemoryRecords(selected) {
      if (!selected || !selected.run || !selected.result || typeof agentMemory.query !== 'function') return [];
      try {
        var responses = await Promise.all(['Observation', 'Procedure'].map(function (type) {
          return agentMemory.query({ type: type, projectRef: selected.run.projectRef, status: 'all', limit: 100 });
        }));
        var resultId = String(selected.result.resultId || '');
        var runId = String(selected.run.runId || '');
        return responses.reduce(function (all, response) {
          if (!response || response.ok !== true || !Array.isArray(response.records)) return all;
          return all.concat(response.records.filter(function (record) {
            return record && Array.isArray(record.provenance) && record.provenance.some(function (entry) {
              return entry && entry.sourceKind === 'work_result_ref' && entry.sourceRef === resultId
                && (!entry.sourceRunId || entry.sourceRunId === runId);
            });
          }));
        }, []);
      } catch (_) { return []; }
    }
    async function previewMemoryCandidate(selectionRef) {
      if (state.memoryCandidate && state.memoryCandidate.type === 'Procedure' && !state.memoryCandidate.committedRecord) {
        return { ok: false, error: 'memory-candidate-in-progress' };
      }
      var selected = state.selectedResult;
      if (!selected || !selected.run || !selected.result || selected.result.status !== 'available'
        || selected.result.expiresAt <= now() || selected.run.status !== 'completed'
        || selected.result.runId !== selected.run.runId || !selected.result.resultId) {
        return { ok: false, error: 'work-result-not-available' };
      }
      if (!(await projectAccessAvailable(selected.run.projectRef))) {
        state.error = 'project-access-denied';
        state.memoryCandidate = null;
        state.memoryCandidateConfirmed = false;
        changed();
        return { ok: false, error: 'project-access-denied' };
      }
      if (typeof agentMemory.state !== 'function' || typeof agentMemory.commitWorkResultCandidate !== 'function') {
        return { ok: false, error: 'agent-memory-authority-unavailable' };
      }
      var statement = selectedResultStatement(selected, selectionRef);
      if (!statement) return { ok: false, error: 'invalid-work-result-selection' };
      var memoryState;
      try { memoryState = await agentMemory.state(); } catch (_) { memoryState = null; }
      var expectedStoreRevision = memoryState && memoryState.ok === true && memoryState.state
        ? Number(memoryState.state.storeRevision) : NaN;
      if (!Number.isSafeInteger(expectedStoreRevision) || expectedStoreRevision < 0) {
        state.error = 'agent-memory-authority-unavailable';
        changed();
        return { ok: false, error: state.error };
      }
      var resultId = String(selected.result.resultId);
      var provenance = {
        sourceKind: 'work_result_ref', sourceRef: resultId,
        sourceRevision: String(selected.result.schemaVersion), selectionRef: String(selectionRef)
      };
      var linkedRecord = state.linkedMemoryRecords.find(function (record) {
        return record && record.type === 'Observation' && Array.isArray(record.provenance)
          && record.provenance.some(function (entry) {
            return entry && entry.sourceKind === 'work_result_ref' && entry.sourceRef === resultId
              && entry.selectionRef === selectionRef;
          });
      }) || null;
      state.memoryCandidate = {
        candidateId: makeRequestId(),
        type: 'Observation',
        projectRef: String(selected.run.projectRef),
        payload: { statement: statement, contextRef: 'wm:' + selectionRef },
        provenance: provenance,
        basedOn: {
          runId: String(selected.run.runId), resultId: resultId,
          resultSchemaVersion: selected.result.schemaVersion
        },
        expectedStoreRevision: expectedStoreRevision,
        expiresInMs: OBSERVATION_DEFAULT_EXPIRY_MS,
        committedRecord: linkedRecord && Object.assign({}, linkedRecord)
      };
      state.memoryCandidateConfirmed = false;
      state.error = '';
      state.notice = linkedRecord ? '该报告内容已有对应的 Agent Memory 记录。' : '';
      changed();
      return { ok: true, candidate: JSON.parse(JSON.stringify(state.memoryCandidate)) };
    }
    function normalizeProcedurePayload(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      var name = String(input.name || '').trim();
      var steps = Array.isArray(input.steps) ? input.steps.map(function (step) { return String(step || '').trim(); }) : [];
      var whenToUse = String(input.whenToUse || '').trim();
      if (!name || name.length > 160 || !steps.length || steps.length > 30
        || steps.some(function (step) { return !step || step.length > 500; })
        || !whenToUse || whenToUse.length > 600) return null;
      return { name: name, steps: steps, whenToUse: whenToUse };
    }
    async function beginProcedureCandidate() {
      if (state.memoryCandidate && state.memoryCandidate.type === 'Procedure' && !state.memoryCandidate.committedRecord) {
        return { ok: false, error: 'memory-candidate-in-progress' };
      }
      var selected = state.selectedResult;
      if (!selected || !selected.run || !selected.result || selected.result.status !== 'available'
        || selected.result.expiresAt <= now() || selected.run.status !== 'completed'
        || selected.result.runId !== selected.run.runId || !selected.result.resultId) {
        return { ok: false, error: 'work-result-not-available' };
      }
      if (!(await projectAccessAvailable(selected.run.projectRef))) {
        state.error = 'project-access-denied';
        state.memoryCandidate = null;
        state.memoryCandidateConfirmed = false;
        changed();
        return { ok: false, error: 'project-access-denied' };
      }
      if (typeof agentMemory.state !== 'function' || typeof agentMemory.commitWorkResultProcedureCandidate !== 'function') {
        return { ok: false, error: 'agent-memory-authority-unavailable' };
      }
      var memoryState;
      try { memoryState = await agentMemory.state(); } catch (_) { memoryState = null; }
      var expectedStoreRevision = memoryState && memoryState.ok === true && memoryState.state
        ? Number(memoryState.state.storeRevision) : NaN;
      if (!Number.isSafeInteger(expectedStoreRevision) || expectedStoreRevision < 0) {
        state.error = 'agent-memory-authority-unavailable';
        changed();
        return { ok: false, error: state.error };
      }
      var resultId = String(selected.result.resultId), runId = String(selected.run.runId);
      state.memoryCandidate = {
        candidateId: makeRequestId(), type: 'Procedure', projectRef: String(selected.run.projectRef),
        payload: { name: '', steps: [], whenToUse: String(selected.result.report && selected.result.report.summary || '').trim().slice(0, 600) },
        provenance: { sourceKind: 'work_result_ref', sourceRef: resultId,
          sourceRevision: String(selected.result.schemaVersion), sourceRunId: runId, selectionRef: 'procedure:draft' },
        basedOn: { runId: runId, resultId: resultId, resultSchemaVersion: selected.result.schemaVersion },
        expectedStoreRevision: expectedStoreRevision, procedureReviewed: false, procedureEditing: true,
        committedRecord: null
      };
      state.memoryCandidateConfirmed = false;
      state.error = '';
      state.notice = 'Procedure 草稿只在本页整理；当前没有写入 Agent Memory。';
      changed();
      return { ok: true, candidate: JSON.parse(JSON.stringify(state.memoryCandidate)) };
    }
    async function previewProcedureCandidate(input) {
      var candidate = state.memoryCandidate, selected = state.selectedResult;
      if (!candidate || candidate.type !== 'Procedure' || candidate.committedRecord || !candidate.procedureEditing
        || !selected || !selected.run || !selected.result || selected.run.runId !== candidate.basedOn.runId
        || selected.result.resultId !== candidate.basedOn.resultId || selected.run.status !== 'completed'
        || selected.result.status !== 'available' || selected.result.expiresAt <= now()) {
        return { ok: false, error: 'memory-candidate-not-current' };
      }
      var payload = normalizeProcedurePayload(input);
      if (!payload) {
        state.error = 'invalid-procedure-candidate';
        state.memoryCandidateConfirmed = false;
        changed();
        return { ok: false, error: state.error };
      }
      if (!(await projectAccessAvailable(candidate.projectRef))) {
        state.error = 'project-access-denied';
        state.memoryCandidateConfirmed = false;
        changed();
        return { ok: false, error: state.error };
      }
      var memoryState;
      try { memoryState = await agentMemory.state(); } catch (_) { memoryState = null; }
      var expectedStoreRevision = memoryState && memoryState.ok === true && memoryState.state
        ? Number(memoryState.state.storeRevision) : NaN;
      if (!Number.isSafeInteger(expectedStoreRevision) || expectedStoreRevision < 0) {
        state.error = 'agent-memory-authority-unavailable';
        state.memoryCandidateConfirmed = false;
        changed();
        return { ok: false, error: state.error };
      }
      candidate.payload = payload;
      candidate.expectedStoreRevision = expectedStoreRevision;
      candidate.procedureReviewed = true;
      candidate.procedureEditing = false;
      state.memoryCandidateConfirmed = false;
      state.error = '';
      state.notice = 'Procedure 候选已预览；只有随后勾选确认并提交才会写入。';
      changed();
      return { ok: true, candidate: JSON.parse(JSON.stringify(candidate)) };
    }
    function editProcedureCandidate() {
      var candidate = state.memoryCandidate;
      if (!candidate || candidate.type !== 'Procedure' || candidate.committedRecord || state.memoryCandidateBusy) {
        return { ok: false, error: 'memory-candidate-not-reviewable' };
      }
      candidate.procedureEditing = true;
      candidate.procedureReviewed = false;
      state.memoryCandidateConfirmed = false;
      state.notice = '编辑会撤销本次候选确认；更新预览后需重新确认。';
      changed();
      return { ok: true };
    }
    function discardProcedureCandidate() {
      var candidate = state.memoryCandidate;
      if (!candidate || candidate.type !== 'Procedure' || candidate.committedRecord || state.memoryCandidateBusy) {
        return { ok: false, error: 'memory-candidate-not-reviewable' };
      }
      state.memoryCandidate = null;
      state.memoryCandidateConfirmed = false;
      state.notice = 'Procedure 草稿已丢弃；Agent Memory 未改动。';
      state.error = '';
      changed();
      return { ok: true };
    }
    function confirmMemoryCandidate(confirmed) {
      if (!state.memoryCandidate || state.memoryCandidate.committedRecord || state.memoryCandidateBusy) {
        return { ok: false, error: 'memory-candidate-not-reviewable' };
      }
      if (state.memoryCandidate.type === 'Procedure'
        && (state.memoryCandidate.procedureReviewed !== true || state.memoryCandidate.procedureEditing === true)) {
        return { ok: false, error: 'procedure-candidate-preview-required' };
      }
      state.memoryCandidateConfirmed = confirmed === true;
      if (!state.memoryCandidateConfirmed) state.notice = '候选尚未确认；没有写入 Agent Memory。';
      changed();
      return { ok: true, confirmed: state.memoryCandidateConfirmed };
    }
    var pendingMemoryCommit = null;
    async function commitMemoryCandidate(confirmed) {
      if (confirmed !== true || state.memoryCandidateConfirmed !== true) {
        return { ok: false, error: 'explicit-memory-candidate-confirmation-required' };
      }
      if (pendingMemoryCommit) return pendingMemoryCommit;
      var candidate = state.memoryCandidate;
      var selected = state.selectedResult;
      if (!candidate || candidate.committedRecord || !selected || !selected.result
        || selected.result.resultId !== candidate.basedOn.resultId
        || (candidate.type === 'Procedure' && (candidate.procedureReviewed !== true || candidate.procedureEditing === true))) {
        return { ok: false, error: 'memory-candidate-not-current' };
      }
      state.memoryCandidateBusy = 'committing';
      state.error = '';
      changed();
      pendingMemoryCommit = (async function () {
        if (!(await projectAccessAvailable(candidate.projectRef))) {
          state.error = 'project-access-denied';
          state.memoryCandidateConfirmed = false;
          state.memoryCandidateBusy = '';
          changed();
          pendingMemoryCommit = null;
          return { ok: false, error: state.error };
        }
        var result;
        try {
          if (candidate.type === 'Procedure') {
            result = await agentMemory.commitWorkResultProcedureCandidate({
              runId: candidate.basedOn.runId, resultId: candidate.basedOn.resultId,
              resultSchemaVersion: candidate.basedOn.resultSchemaVersion,
              expectedStoreRevision: candidate.expectedStoreRevision,
              payload: candidate.payload, confirmed: true
            });
          } else {
            result = await agentMemory.commitWorkResultCandidate({
              runId: candidate.basedOn.runId,
              resultId: candidate.basedOn.resultId,
              selectionRef: candidate.provenance.selectionRef,
              expectedStoreRevision: candidate.expectedStoreRevision,
              confirmed: true
            });
          }
        } catch (_) { result = { ok: false, error: 'agent-memory-write-failed' }; }
        if (result && result.ok === true && result.record) {
          candidate.committedRecord = Object.assign({}, result.record);
          if (candidate.type === 'Procedure' && Array.isArray(result.record.provenance) && result.record.provenance[0]) {
            candidate.provenance = Object.assign({}, result.record.provenance[0]);
          }
          if (!state.linkedMemoryRecords.some(function (record) { return record.memoryId === result.record.memoryId; })) {
            state.linkedMemoryRecords.push(Object.assign({}, result.record));
          }
          state.memoryCandidateConfirmed = false;
          state.notice = result.duplicate ? '该来源候选此前已写入；未创建重复记录。' : '选中的 Work Result 内容已写入 Agent Memory。';
        } else {
          state.memoryCandidateConfirmed = false;
          state.error = safeMessage(result, 'agent-memory-write-failed');
          if (state.error === 'version-conflict') state.notice = 'Agent Memory 已变化；请重新预览候选后再确认。';
        }
        state.memoryCandidateBusy = '';
        changed();
        pendingMemoryCommit = null;
        return result;
      })();
      return pendingMemoryCommit;
    }
    var pendingMemoryRetractions = new Map();
    async function retractMemoryRecord(record, confirmed) {
      if (confirmed !== true) return { ok: false, error: 'explicit-memory-retraction-required' };
      if (!record || record.status !== 'active' || !record.memoryId || !Number.isSafeInteger(record.revision)
        || typeof agentMemory.retract !== 'function') return { ok: false, error: 'memory-record-not-retractable' };
      if (pendingMemoryRetractions.has(record.memoryId)) return pendingMemoryRetractions.get(record.memoryId);
      var source = Array.isArray(record.provenance) ? record.provenance.find(function (entry) {
        return entry && entry.sourceKind === 'work_result_ref' && entry.sourceRef;
      }) : null;
      if (!source || !(await projectAccessAvailable(String(record.projectRef || '')))) {
        return { ok: false, error: 'project-access-denied' };
      }
      state.memoryCandidateBusy = 'retracting';
      changed();
      var operation = (async function () {
        var result;
        try {
          result = await agentMemory.retract(record.memoryId, {
            confirmed: true,
            expectedRevision: record.revision,
            reasonCode: 'other',
            provenance: {
              sourceKind: 'work_result_ref', sourceRef: source.sourceRef,
              sourceRevision: source.sourceRevision, selectionRef: source.selectionRef,
              ...(source.sourceRunId ? { sourceRunId: source.sourceRunId } : {})
            }
          });
        } catch (_) { result = { ok: false, error: 'agent-memory-retract-failed' }; }
        if (result && result.ok === true && result.record) {
          state.linkedMemoryRecords = state.linkedMemoryRecords.map(function (item) {
            return item.memoryId === result.record.memoryId ? Object.assign({}, result.record) : item;
          });
          if (state.memoryCandidate && state.memoryCandidate.committedRecord
            && state.memoryCandidate.committedRecord.memoryId === result.record.memoryId) {
            state.memoryCandidate.committedRecord = Object.assign({}, result.record);
          }
          state.notice = '记忆写入已撤销；内容已清空并保留墓碑。';
        } else state.error = safeMessage(result, 'agent-memory-retract-failed');
        state.memoryCandidateBusy = '';
        changed();
        pendingMemoryRetractions.delete(record.memoryId);
        return result;
      })();
      pendingMemoryRetractions.set(record.memoryId, operation);
      return operation;
    }
    async function selectResult(runId) {
      if (typeof runtime.getResult !== 'function') return { ok: false, error: 'result-api-unavailable' };
      var result;
      try { result = await runtime.getResult(String(runId || '')); }
      catch (_) { result = { ok: false, error: 'work-result-read-failed' }; }
      if (result && result.ok === true && result.result && result.result.status === 'available') {
        state.selectedResult = result;
        var activeRun = state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0;
        if (!activeRun && result.run) {
          state.run = result.run;
          state.selectedProjectRef = result.run.projectRef;
        }
        var selectedRunId = activeRun && state.run ? state.run.runId : result.run && result.run.runId;
        await refreshRunEvents(selectedRunId);
        await refreshMemoryProvenance(selectedRunId);
        state.memoryCandidate = null;
        state.memoryCandidateConfirmed = false;
        state.linkedMemoryRecords = await loadLinkedMemoryRecords(result);
        state.error = '';
        changed();
      } else {
        state.error = safeMessage(result, 'work-result-read-failed');
        state.selectedResult = null;
        state.memoryCandidate = null;
        state.memoryCandidateConfirmed = false;
        state.linkedMemoryRecords = [];
        state.runEvents = [];
        state.runEventsRunId = '';
        state.runEventsStatus = 'idle';
        changed();
      }
      return result;
    }
    async function deleteResult(runId, confirmed) {
      runId = String(runId || '');
      if (confirmed !== true) return { ok: false, error: 'explicit-delete-confirmation-required' };
      if (pendingDelete.has(runId)) return pendingDelete.get(runId);
      if (typeof runtime.deleteResult !== 'function') return { ok: false, error: 'result-api-unavailable' };
      var operation = (async function () {
        var result;
        try { result = await runtime.deleteResult(runId); }
        catch (_) { result = { ok: false, error: 'work-result-delete-failed' }; }
        if (result && result.ok) {
          if (state.selectedResult && state.selectedResult.run && state.selectedResult.run.runId === runId) {
            state.selectedResult = null;
            if (state.memoryCandidate && !state.memoryCandidate.committedRecord) state.memoryCandidate = null;
            state.memoryCandidateConfirmed = false;
          }
          state.notice = 'Result 已由 Home Node 删除。Run 事件保留至其期限。';
          await refresh();
        } else state.error = safeMessage(result, 'work-result-delete-failed');
        changed();
        pendingDelete.delete(runId);
        return result;
      })();
      pendingDelete.set(runId, operation);
      return operation;
    }
    async function refresh() {
      if (pendingRefresh) return pendingRefresh;
      state.ledgerLoading = true;
      changed();
      pendingRefresh = (async function () {
        if (!recoveryAttempted && typeof runtime.recoverInterruptedRuns === 'function') {
          recoveryAttempted = true;
          try { await runtime.recoverInterruptedRuns(); } catch (_) { /* no automatic Run restart */ }
        }
        await refreshDshStatus();
        var active = null, results = null;
        try { active = await homeNode.listActive({ limit: 100 }); } catch (_) { active = null; }
        try { results = await homeNode.listResults({ limit: 100 }); } catch (_) { results = null; }
        if (state.run && typeof homeNode.get === 'function') {
          try {
            var currentRun = await homeNode.get(state.run.runId);
            if (currentRun && currentRun.ok === true && currentRun.run) {
              state.run = currentRun.run;
              if (currentRun.run.executorSelection) {
                state.profileRef = currentRun.run.executorSelection.profileRef;
                state.executorSelection = { roleId: currentRun.run.executorSelection.roleId,
                  presetId: currentRun.run.executorSelection.presetId };
              }
            }
          } catch (_) { /* status remains the last Home Node projection */ }
        }
        state.activeRuns = active && active.ok === true && Array.isArray(active.runs) ? active.runs : [];
        state.results = results && results.ok === true && Array.isArray(results.results) ? results.results : [];
        state.resultsHasMore = results && results.ok === true && results.hasMore === true;
        if (state.run && state.activeDshRunIds.indexOf(state.run.runId) >= 0) state.executor = 'dsh';
        if ((!active || active.ok !== true) && (!results || results.ok !== true)) {
          state.error = safeMessage(active || results, 'work-run-api-unavailable');
        }
        state.ledgerLoading = false;
        var activeRun = state.run && ['queued', 'running', 'cancel_requested'].indexOf(state.run.status) >= 0;
        var eventRunId = activeRun && state.run ? state.run.runId
          : (state.selectedResult && state.selectedResult.run && state.selectedResult.run.runId
            || state.run && state.run.runId);
        if (eventRunId) {
          await refreshRunEvents(eventRunId);
          await refreshMemoryProvenance(eventRunId);
        } else state.memoryProvenance = null;
        changed();
        var result = { ok: true, activeRuns: state.activeRuns.length, results: state.results.length };
        pendingRefresh = null;
        return result;
      })();
      return pendingRefresh;
    }

    return Object.freeze({
      getState: getState,
      bindDshSession: bindDshSession,
      refreshProjectSnapshot: refreshProjectSnapshot,
      restoreProjectDraft: restoreProjectDraft,
      importProjectFiles: importProjectFiles,
      setSelectedProject: setSelectedProject,
      setExecutor: setExecutor,
      refreshMemoryRecall: refreshMemoryRecall,
      setMemorySelection: setMemorySelection,
      setProfileRef: setProfileRef,
      setExecutorSelection: setExecutorSelection,
      createRun: createRun,
      selectRun: selectRun,
      previewAuthorization: refreshPreview,
      refreshRunEvents: refreshRunEvents,
      refreshMemoryProvenance: refreshMemoryProvenance,
      setFileIds: setFileIds,
      confirmMemoryScope: confirmMemoryScope,
      confirmMemoryDerivedConsent: confirmMemoryDerivedConsent,
      confirmScope: confirmScope,
      confirmWorkspaceWrite: confirmWorkspaceWrite,
      confirmStorageRisk: confirmStorageRisk,
      memoryDerivedIdentity: memoryDerivedIdentity,
      memoryDerivedConfirmationKey: memoryDerivedConfirmationKey,
      grant: grant,
      confirmAndStart: confirmAndStart,
      start: start,
      cancel: cancel,
      revokeConsent: revokeConsent,
      selectResult: selectResult,
      deleteResult: deleteResult,
      previewMemoryCandidate: previewMemoryCandidate,
      beginProcedureCandidate: beginProcedureCandidate,
      previewProcedureCandidate: previewProcedureCandidate,
      editProcedureCandidate: editProcedureCandidate,
      discardProcedureCandidate: discardProcedureCandidate,
      confirmMemoryCandidate: confirmMemoryCandidate,
      commitMemoryCandidate: commitMemoryCandidate,
      retractMemoryRecord: retractMemoryRecord,
      refresh: refresh
    });
  }

  return {
    createController: createController,
    buildResultReviewModel: buildResultReviewModel,
    deriveExecutionStages: deriveExecutionStages,
    deriveRuntimeDiagnostics: deriveRuntimeDiagnostics,
    deriveWorkflowStatus: deriveWorkflowStatus,
    deriveWorkRunSummary: deriveWorkRunSummary,
    runEventLabel: runEventLabel,
    runEventDetail: runEventDetail,
    resultReviewKey: resultReviewKey,
    formatResultMarkdown: formatResultMarkdown
  };
});
