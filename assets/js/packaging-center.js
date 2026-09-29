'use strict';

/* P35.6 · Presentation-only client for the same-origin Packaging Control Plane API. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.IB = root.IB || {};
  root.IB.packagingCenter = api;
  api.mount(root.document, root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const STATE_ORDER = Object.freeze([
    'CREATED', 'PREFLIGHT', 'READY', 'BUILDING', 'BUILD_COMPLETE',
    'VALIDATING', 'VALIDATED', 'WRITING_MANIFEST', 'COMPLETE'
  ]);
  const STATE_PRESENTATION = Object.freeze({
    CREATED: { label: '已创建', tone: 'pending' },
    PREFLIGHT: { label: '正在检查环境', tone: 'active' },
    READY: { label: '准备就绪', tone: 'success' },
    BUILDING: { label: '正在构建安装包', tone: 'building' },
    BUILD_COMPLETE: { label: '构建完成', tone: 'active' },
    VALIDATING: { label: '正在校验安装包', tone: 'active' },
    VALIDATED: { label: '校验通过', tone: 'success' },
    WRITING_MANIFEST: { label: '正在写入清单', tone: 'active' },
    COMPLETE: { label: '已完成', tone: 'success' },
    CANCELLING: { label: '正在取消', tone: 'warning' },
    CANCELLED: { label: '已取消', tone: 'cancelled' },
    FAILED: { label: '失败', tone: 'failure' }
  });
  const FAILURE_COPY = Object.freeze({
    INVALID_REQUEST: '打包请求不符合当前支持的安装包要求。',
    PREFLIGHT_FAILED: '必要的环境检查未通过。',
    BUILD_PLAN_NOT_EXECUTABLE: '构建计划未通过检查，暂时无法开始打包。',
    RELEASE_NOT_ELIGIBLE: '当前源码工作区不满足正式构建条件。',
    PACKAGING_BUSY: '当前会话已有另一个打包任务正在运行。',
    BUILD_SPAWN_FAILED: '无法启动安装包构建。',
    BUILD_FAILED: '安装包构建失败。',
    BUILD_CANCELLED: '构建已取消。',
    CANCELLATION_TOO_LATE: '校验已开始，无法再取消此任务。',
    ALREADY_TERMINAL: '此任务已经结束。',
    ARTIFACT_NOT_FOUND_AFTER_BUILD: '构建结束后未找到预期的安装包。',
    ARTIFACT_IDENTITY_FAILED: '无法确认安装包的一致性。',
    VALIDATION_FAILED: '安装包未通过校验。',
    VALIDATION_WARNINGS_NOT_ACCEPTED: '校验发现警告，已停止写入清单。',
    MANIFEST_WRITE_FAILED: '无法写入安装包清单。',
    MANIFEST_ALREADY_EXISTS_CONFLICT: '已存在内容不同的清单，原文件未被覆盖。',
    ARTIFACT_CHANGED_DURING_FINALIZATION: '安装包在校验后发生了变化。',
    PROCESS_OWNERSHIP_FAILED: '无法安全确认相关进程是否属于当前任务。',
    EXECUTOR_INTERNAL_ERROR: '打包过程中发生内部错误，任务已停止。',
    INVALID_STATE_TRANSITION: '任务状态切换无效，已拒绝该操作。'
  });
  const CHECK_LABELS = Object.freeze({
    target: '打包目标', 'operating-system': 'Windows 系统', node: 'Node.js', npm: 'npm',
    rustc: 'Rust 编译器', cargo: 'Cargo', 'tauri-cli': 'Tauri 命令行工具', powershell: 'Windows PowerShell',
    'inno-setup': 'Inno Setup', webview2: 'WebView2', 'required-files': '构建所需文件',
    'version-metadata': '版本信息', 'release-manifest': '发行清单', 'payload-closure': '安装包文件完整性',
    'git-revision': '源码版本', 'git-cleanliness': '源码工作区',
    'output-writable': '输出目录可写性', 'temporary-writable': '临时目录可写性',
    'host-build-writable': '桌面宿主构建目录可写性', 'output-disk-space': '输出目录磁盘空间',
    'host-build-disk-space': '桌面宿主构建磁盘空间', 'temporary-disk-space': '临时目录磁盘空间'
  });
  const STATUS_LABELS = Object.freeze({
    PASS: '通过', WARN: '警告', FAIL: '未通过',
    READY: '准备就绪', READY_WITH_WARNINGS: '已就绪，但有警告', BLOCKED: '暂不可构建', UNSUPPORTED: '暂不支持',
    WRITTEN: '已生成', ALREADY_IDENTICAL: '已存在且内容一致', FAILED: '失败'
  });
  // The API supplies these fixed presentation labels; machine states stay unchanged.
  const PLAN_STEP_LABELS = Object.freeze({
    'Environment check': '检查构建环境',
    'Prepare staging': '准备打包文件',
    'Stage the Windows host': '准备 Windows 桌面宿主',
    'Audit the staged payload': '审计打包文件',
    'Compile the installer': '编译安装程序',
    'Build the Windows installer': '构建 Windows 安装包',
    'Validate the artifact': '校验安装包'
  });
  const CHECK_MARK = Object.freeze({ PASS: '✓', WARN: '!', FAIL: '×' });
  const ACTIVE_STATES = new Set([
    'CREATED', 'PREFLIGHT', 'READY', 'BUILDING', 'BUILD_COMPLETE',
    'VALIDATING', 'VALIDATED', 'WRITING_MANIFEST', 'CANCELLING'
  ]);

  function statePresentation(state) {
    return STATE_PRESENTATION[state] || { label: '未知状态', tone: 'pending' };
  }

  function canCancelState(state) {
    return state === 'CREATED' || state === 'PREFLIGHT' || state === 'READY' || state === 'BUILDING' || state === 'CANCELLING';
  }

  function failureMessage(code) {
    return FAILURE_COPY[code] || '打包任务失败，详细技术输出未在此处显示。';
  }

  function createPackagingJob(preflight, id) {
    if (!preflight || preflight.ok !== true || preflight.available !== true
      || !preflight.actions || preflight.actions.start !== true
      || typeof preflight.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(preflight.version)) {
      throw new Error('PACKAGING_NOT_READY');
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw new Error('PACKAGING_JOB_ID_INVALID');
    }
    return {
      id: id,
      target: 'windows-installer',
      version: preflight.version,
      channel: 'stable',
      mode: 'release',
      options: { includeDocs: false, includeExamples: false }
    };
  }

  function createClient(fetchImpl) {
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
    async function request(url, method, body) {
      if (!doFetch) return { ok: false, code: 'PACKAGING_API_UNAVAILABLE' };
      const init = { method: method || 'GET', cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      try {
        const response = await doFetch(url, init);
        let payload = null;
        try { payload = await response.json(); } catch (_) { payload = null; }
        if (!payload || typeof payload !== 'object') return { ok: false, code: 'PACKAGING_API_UNAVAILABLE' };
        if (!response.ok && payload.ok !== false) return { ok: false, code: 'PACKAGING_API_UNAVAILABLE' };
        return payload;
      } catch (_) {
        return { ok: false, code: 'PACKAGING_API_UNAVAILABLE' };
      }
    }
    return {
      preflight: function () { return request('/__packaging/preflight', 'GET'); },
      start: function (job) { return request('/__packaging/jobs', 'POST', { job: job }); },
      jobs: function () { return request('/__packaging/jobs', 'GET'); },
      state: function (id) { return request('/__packaging/jobs/' + encodeURIComponent(id), 'GET'); },
      cancel: function (id) { return request('/__packaging/jobs/' + encodeURIComponent(id) + '/cancel', 'POST', {}); }
    };
  }

  function createJobId(win) {
    try {
      if (win.crypto && typeof win.crypto.randomUUID === 'function') return 'pc-' + win.crypto.randomUUID();
      if (win.crypto && typeof win.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        win.crypto.getRandomValues(bytes);
        return 'pc-' + Array.from(bytes).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
      }
    } catch (_) { }
    return 'pc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function mount(document, win, suppliedClient) {
    const page = document && document.getElementById('page-packaging');
    if (!page || page.__pcMounted) return;
    page.__pcMounted = true;
    const client = suppliedClient || createClient(win && win.fetch ? win.fetch.bind(win) : null);
    const byId = function (id) { return document.getElementById(id); };
    const currentPanel = byId('pc-current-job');
    const startButton = byId('pc-start');
    const cancelButton = byId('pc-cancel');
    const cancelDialog = byId('pc-cancel-dialog');
    const timelineNames = {
      CREATED: '创建任务', PREFLIGHT: '检查环境', READY: '准备就绪', BUILDING: '构建安装包',
      BUILD_COMPLETE: '构建完成', VALIDATING: '校验安装包', VALIDATED: '校验通过',
      WRITING_MANIFEST: '写入清单', COMPLETE: '任务完成'
    };
    let preflight = null;
    let selectedJobId = '';
    let selectedState = null;
    let sessionJobs = [];
    let pollTimer = null;
    let opened = false;
    let cancelBusy = false;
    let cancelNotice = '';

    function setText(id, value) {
      const element = byId(id);
      if (element) element.textContent = value == null ? '' : String(value);
    }
    function setTone(element, tone) {
      if (!element) return;
      element.dataset.status = tone || 'unknown';
    }
    function createElement(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = String(text);
      return element;
    }
    function showAvailability(label, tone) {
      const element = byId('pc-availability');
      if (!element) return;
      element.textContent = label;
      setTone(element, tone);
    }

    function renderChecks(checks) {
      const list = byId('pc-checks');
      if (!list) return;
      list.replaceChildren();
      (Array.isArray(checks) ? checks : []).forEach(function (check) {
        if (!check || !['PASS', 'WARN', 'FAIL'].includes(check.status)) return;
        const row = createElement('li');
        row.dataset.status = check.status;
        const label = createElement('span', 'pc-check-label');
        label.appendChild(createElement('span', 'pc-check-mark', CHECK_MARK[check.status]));
        label.appendChild(createElement('span', '', CHECK_LABELS[check.name] || '其他检查'));
        row.appendChild(label);
        row.appendChild(createElement('span', 'pc-check-status', STATUS_LABELS[check.status]));
        list.appendChild(row);
      });
    }

    function renderPlan(plan) {
      const list = byId('pc-plan-steps');
      if (!list) return;
      list.replaceChildren();
      (plan && Array.isArray(plan.steps) ? plan.steps : []).forEach(function (step) {
        if (!step || typeof step.label !== 'string') return;
        const row = createElement('li', '', PLAN_STEP_LABELS[step.label] || '其他构建步骤');
        row.dataset.status = ['PLANNED', 'BLOCKED', 'COMPLETE'].includes(step.status) ? step.status : 'BLOCKED';
        list.appendChild(row);
      });
    }

    function renderPreflight(data) {
      preflight = data && data.ok === true ? data : null;
      if (!preflight || preflight.available !== true) {
        const isUnavailable = !data || data.code === 'PACKAGING_BACKEND_UNAVAILABLE' || data.code === 'PACKAGING_API_UNAVAILABLE';
        showAvailability(isUnavailable ? '当前环境未提供源码打包工具。' : '打包预检查未能完成。', 'warning');
        setTone(byId('pc-environment-state'), 'unavailable');
        setText('pc-environment-state', '不可用');
        setText('pc-environment-note', isUnavailable
          ? '请从具备构建工具的 Windows 源码工作区启动应用后使用此功能。'
          : '请重新加载此页面，再次检查构建环境。');
        setTone(byId('pc-plan-state'), 'unavailable');
        setText('pc-plan-state', '不可用');
        setText('pc-plan-note', '当前会话无法获取构建计划。');
        renderChecks([]);
        renderPlan(null);
        if (startButton) startButton.disabled = true;
        return;
      }

      setText('pc-version', preflight.version);
      const environment = preflight.environment || {};
      const checks = Array.isArray(environment.checks) ? environment.checks : [];
      const failed = checks.filter(function (item) { return item.status === 'FAIL'; }).length;
      const warned = checks.filter(function (item) { return item.status === 'WARN'; }).length;
      const plan = preflight.plan || {};
      const canStart = !!(preflight.actions && preflight.actions.start === true);
      showAvailability(canStart ? '构建条件已满足，可以开始打包。' : '预检查未满足构建条件，暂时无法打包。', canStart ? 'success' : (failed ? 'failure' : 'warning'));
      setText('pc-environment-state', environment.ready === true ? (warned ? '已就绪，但有警告' : '准备就绪') : '暂不可构建');
      setTone(byId('pc-environment-state'), environment.ready === true ? (warned ? 'WARN' : 'PASS') : 'FAIL');
      const dirty = checks.some(function (item) { return item.name === 'git-cleanliness' && item.status === 'WARN'; });
      setText('pc-environment-note', failed
        ? '请先处理未通过的必要检查，再开始构建。'
        : (dirty ? '源码工作区存在未提交改动，需要先满足正式构建条件。' : '已完成构建环境检查。'));
      setText('pc-plan-state', STATUS_LABELS[plan.status] || '不可用');
      setTone(byId('pc-plan-state'), plan.releaseEligible ? 'PASS' : (plan.status === 'BLOCKED' ? 'FAIL' : 'WARN'));
      setText('pc-plan-note', canStart
        ? '此计划使用现有的 Windows 安装包构建流程，仅供查看。'
        : (dirty ? '正式构建要求源码工作区满足发布条件。' : '当前环境的构建计划尚未通过检查。'));
      renderChecks(checks);
      renderPlan(plan);
      updateStartButton();
    }

    function resultNote(state) {
      const result = state && state.result;
      const failure = result && result.failure;
      if (cancelNotice) return cancelNotice;
      if (state && state.state === 'FAILED') return failureMessage(failure && failure.code);
      if (state && state.state === 'COMPLETE') return '安装包校验通过，清单已写入，最终文件一致性已确认。';
      if (state && state.state === 'CANCELLED') return '此任务已取消，未影响其他进程。';
      if (state && state.state === 'CANCELLING') return '正在停止当前任务的构建进程。';
      if (state && state.state === 'BUILDING') return '正在构建 Windows 安装包。';
      if (state && state.state === 'VALIDATING') return '正在检查生成的安装包。';
      if (state && state.state === 'WRITING_MANIFEST') return '安装包校验通过，正在完成清单写入。';
      if (state && state.state === 'BUILD_COMPLETE') return '构建已成功结束，接下来需要校验安装包。';
      if (state && state.state === 'VALIDATED') return '安装包已通过校验，接下来需要完成清单写入。';
      if (state && state.state === 'PREFLIGHT') return '正在检查构建环境和打包计划。';
      if (state && state.state === 'READY') return '正在准备执行已通过检查的构建计划。';
      return '打包服务正在处理任务，状态将自动更新。';
    }

    function addResultItem(container, label, value, className) {
      if (value == null || value === '') return;
      const item = createElement('div', 'pc-result-item' + (className ? ' ' + className : ''));
      item.appendChild(createElement('span', '', label));
      item.appendChild(createElement('strong', '', value));
      container.appendChild(item);
    }

    function renderResult(result) {
      const container = byId('pc-result');
      if (!container) return;
      container.replaceChildren();
      if (!result) { container.hidden = true; return; }
      container.hidden = false;
      if (result.artifact) {
        addResultItem(container, '安装包', result.artifact.name);
        addResultItem(container, '校验结果', STATUS_LABELS[result.validation && result.validation.status] || '暂无结果');
        addResultItem(container, '文件清单', STATUS_LABELS[result.manifest && result.manifest.status] || '未生成');
        addResultItem(container, 'SHA-256', result.artifact.sha256, 'pc-result-hash');
      }
      if (result.failure && result.failure.code) {
        const failure = createElement('div', 'pc-failure');
        failure.appendChild(createElement('strong', '', '错误代码：' + result.failure.code));
        failure.appendChild(createElement('p', '', failureMessage(result.failure.code)));
        container.appendChild(failure);
      }
      if (!result.artifact && !result.failure && result.build && Number.isInteger(result.build.exitCode)) {
        addResultItem(container, '构建退出码', String(result.build.exitCode));
      }
    }

    function renderTimeline(state) {
      const list = byId('pc-timeline');
      if (!list) return;
      list.replaceChildren();
      const events = state && Array.isArray(state.events) ? state.events : [];
      const reached = new Set(events.map(function (event) { return event && event.state; }).filter(Boolean));
      const currentIndex = STATE_ORDER.indexOf(state && state.state);
      STATE_ORDER.forEach(function (name, index) {
        const row = createElement('li', '', timelineNames[name]);
        if (name === (state && state.state)) row.classList.add('is-current');
        else if (reached.has(name) || (currentIndex >= 0 && index < currentIndex)) row.classList.add('is-done');
        if (state && state.state === 'FAILED' && reached.has(name) && index === Math.max.apply(null, Array.from(reached).map(function (item) { return STATE_ORDER.indexOf(item); }).filter(function (n) { return n >= 0; }))) row.classList.add('is-failed');
        list.appendChild(row);
      });
    }

    function renderCurrent(state) {
      selectedState = state || null;
      if (!currentPanel) return;
      if (!state) {
        currentPanel.hidden = true;
        updateStartButton();
        return;
      }
      currentPanel.hidden = false;
      const presentation = statePresentation(state.state);
      setText('pc-run-state', presentation.label);
      setTone(byId('pc-run-state'), presentation.tone);
      setText('pc-run-job-id', state.jobId ? '任务 ' + state.jobId : '当前会话');
      setText('pc-run-note', resultNote(state));
      renderTimeline(state);
      renderResult(state.result);
      if (cancelButton) {
        cancelButton.hidden = !canCancelState(state.state);
        cancelButton.disabled = cancelBusy;
        cancelButton.textContent = state.state === 'CANCELLING' ? '重试取消' : '取消构建';
      }
      updateStartButton();
    }

    function updateStartButton() {
      if (!startButton) return;
      const busy = !!(selectedState && ACTIVE_STATES.has(selectedState.state));
      startButton.disabled = !(preflight && preflight.ok === true && preflight.actions
        && preflight.actions.start === true && !busy);
    }

    function renderHistory(jobs) {
      sessionJobs = Array.isArray(jobs) ? jobs : [];
      setText('pc-history-count', String(sessionJobs.length));
      const list = byId('pc-history-list');
      if (!list) return;
      list.replaceChildren();
      if (!sessionJobs.length) {
        list.appendChild(createElement('p', 'pc-empty-state', '当前会话暂无打包任务。'));
        return;
      }
      sessionJobs.forEach(function (state) {
        if (!state || typeof state.jobId !== 'string') return;
        const row = createElement('div', 'pc-history-row');
        const summary = createElement('div', 'pc-history-summary');
        summary.appendChild(createElement('strong', '', statePresentation(state.state).label));
        summary.appendChild(createElement('span', '', state.jobId));
        row.appendChild(summary);
        const view = createElement('button', 'btn', '查看');
        view.type = 'button';
        view.addEventListener('click', function () {
          selectedJobId = state.jobId;
          cancelNotice = '';
          renderCurrent(state);
          schedulePoll();
        });
        row.appendChild(view);
        list.appendChild(row);
      });
    }

    async function refreshJobs() {
      const result = await client.jobs();
      if (!result || result.ok !== true) return;
      renderHistory(result.jobs);
      if (!selectedJobId && sessionJobs.length) selectedJobId = sessionJobs[0].jobId;
      if (selectedJobId) {
        const found = sessionJobs.find(function (item) { return item && item.jobId === selectedJobId; });
        if (found) renderCurrent(found);
      }
    }

    async function refreshSelected() {
      if (!selectedJobId) return;
      const response = await client.state(selectedJobId);
      if (response && response.ok === true && response.job) {
        selectedState = response.job;
        renderCurrent(response.job);
        if (sessionJobs.length) {
          sessionJobs = sessionJobs.map(function (item) { return item.jobId === selectedJobId ? response.job : item; });
          renderHistory(sessionJobs);
        }
      }
    }

    function schedulePoll() {
      if (pollTimer) win.clearTimeout(pollTimer);
      pollTimer = null;
      if (!opened || !selectedState || !ACTIVE_STATES.has(selectedState.state)) return;
      pollTimer = win.setTimeout(async function () {
        pollTimer = null;
        if (!opened) return;
        await refreshSelected();
        schedulePoll();
      }, 1200);
    }

    async function loadPage() {
      if (opened || !page.classList.contains('active')) return;
      opened = true;
      showAvailability('正在读取源码工作区…', 'active');
      const preview = await client.preflight();
      renderPreflight(preview);
      await refreshJobs();
      await refreshSelected();
      schedulePoll();
    }

    async function startBuild() {
      if (!preflight || !preflight.actions || preflight.actions.start !== true) return;
      startButton.disabled = true;
      const job = createPackagingJob(preflight, createJobId(win));
      const response = await client.start(job);
      if (!response || response.ok !== true || response.accepted !== true) {
        cancelNotice = response && response.code === 'PACKAGING_BUSY'
          ? '当前会话已有另一个安装包构建正在运行。'
          : '打包服务未接受此任务。';
        setText('pc-run-note', cancelNotice);
        startButton.disabled = false;
        return;
      }
      selectedJobId = job.id;
      cancelNotice = '';
      renderCurrent({ jobId: job.id, state: 'CREATED', events: [], result: null });
      await refreshJobs();
      await refreshSelected();
      schedulePoll();
    }

    function closeCancelDialog() {
      if (cancelDialog && typeof cancelDialog.close === 'function' && cancelDialog.open) cancelDialog.close();
    }

    function openCancelDialog() {
      if (!selectedState || !canCancelState(selectedState.state)) return;
      if (cancelDialog && typeof cancelDialog.showModal === 'function') cancelDialog.showModal();
      else if (win.confirm('确定取消此打包任务吗？仅会停止当前任务的构建进程。')) confirmCancel();
    }

    async function confirmCancel() {
      closeCancelDialog();
      if (!selectedJobId || !selectedState || !canCancelState(selectedState.state)) return;
      cancelBusy = true;
      if (cancelButton) cancelButton.disabled = true;
      const result = await client.cancel(selectedJobId);
      cancelBusy = false;
      if (!result || result.ok !== true) {
        cancelNotice = '取消请求未能完成。';
      } else if (result.status === 'DENIED' && result.code === 'CANCELLATION_TOO_LATE') {
        cancelNotice = '校验已开始，无法再取消此任务。';
      } else if (result.status === 'CANCELLING') {
        cancelNotice = '正在停止当前任务的构建进程。';
      } else if (result.status === 'CANCELLED') {
        cancelNotice = '此任务已取消。';
      } else if (result.status === 'ALREADY_TERMINAL') {
        cancelNotice = '此任务已经结束。';
      }
      await refreshJobs();
      await refreshSelected();
      schedulePoll();
    }

    if (startButton) startButton.addEventListener('click', startBuild);
    if (cancelButton) cancelButton.addEventListener('click', openCancelDialog);
    const cancelDismiss = byId('pc-cancel-dismiss');
    const cancelConfirm = byId('pc-cancel-confirm');
    if (cancelDismiss) cancelDismiss.addEventListener('click', closeCancelDialog);
    if (cancelConfirm) cancelConfirm.addEventListener('click', confirmCancel);
    if (cancelDialog) cancelDialog.addEventListener('cancel', function () { closeCancelDialog(); });

    win.addEventListener('hashchange', function () {
      if (page.classList.contains('active')) loadPage();
      else {
        opened = false;
        if (pollTimer) win.clearTimeout(pollTimer);
        pollTimer = null;
      }
    });
    if (typeof win.MutationObserver === 'function') {
      const observer = new win.MutationObserver(function () {
        if (page.classList.contains('active')) loadPage();
        else if (opened) {
          opened = false;
          if (pollTimer) win.clearTimeout(pollTimer);
          pollTimer = null;
        }
      });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    if (page.classList.contains('active') || (win.location && win.location.hash === '#packaging')) loadPage();
  }

  return {
    STATE_ORDER: STATE_ORDER,
    STATE_PRESENTATION: STATE_PRESENTATION,
    CHECK_LABELS: CHECK_LABELS,
    statePresentation: statePresentation,
    canCancelState: canCancelState,
    failureMessage: failureMessage,
    createPackagingJob: createPackagingJob,
    createClient: createClient,
    mount: mount
  };
});
