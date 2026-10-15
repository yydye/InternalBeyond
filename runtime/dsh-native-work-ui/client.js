// The Lost Beyond DSH Work Mode client extension.
globalThis.__ModuleLoader__.load({
  id: '@internalbeyond/dsh-native-work-ui',
  factory: function (require) {
    var React = require('react');
    var WORK_MODE_PARENT_ORIGIN = '';
    function isTrustedWorkModeParentOrigin(origin) {
      return origin === 'http://tauri.localhost' || origin === 'tauri://localhost';
    }
    try {
      var workModeParentParameter = new URL(window.location.href).searchParams.get('ib_parent_origin') || '';
      var parentReferrerOrigin = document.referrer ? new URL(document.referrer).origin : '';
      if (isTrustedWorkModeParentOrigin(workModeParentParameter)) WORK_MODE_PARENT_ORIGIN = workModeParentParameter;
      else if (isTrustedWorkModeParentOrigin(parentReferrerOrigin)) WORK_MODE_PARENT_ORIGIN = parentReferrerOrigin;
    } catch (_) { /* a DSH tab without its trusted Work Mode parent stays disconnected */ }
    window.addEventListener('message', function (event) {
      if (event.source === window.parent && isTrustedWorkModeParentOrigin(event.origin)) {
        WORK_MODE_PARENT_ORIGIN = event.origin;
      }
    }, true);
    var WORK_MODE_TRACE_RECORD = 'plugin:internalbeyond/dsh-work-mode/run-event';
    function traceData(event) {
      return event && event.type === WORK_MODE_TRACE_RECORD && event.data && typeof event.data === 'object'
        ? event.data : null;
    }
    function traceViewNode(context, anchorSeq, data) {
      return { key: context.key, kind: context.kind, id: context.id, target: 'trajectory',
        anchorSeq: anchorSeq, location: context.start && context.start.location || { kind: 'unresolved' }, data: data };
    }
    function homeNodeStatusNode(context, data, text, time) {
      var event = context.start && context.start.event;
      var node = { kind: 'context', seq: Number(event && event.seq) || 0, time: Number(time) || Number(event && event.time) || Date.now(),
        content: [{ type: 'text', text: String(text || '') }], source: { kind: 'internalbeyond/work-mode-run', runId: String(data.runId || '') },
        producer: { role: 'inject', label: 'Home Node Run' }, form: 'notice' };
      return node;
    }
    function chatStatusNode(context, node) {
      var event = context.start && context.start.event;
      return { key: context.key, kind: 'context', id: context.id, target: 'chat',
        anchorSeq: Number(event && event.seq) || 0,
        location: context.start && context.start.location || { kind: 'unresolved' },
        visibility: 'visible', data: node };
    }
    function registerWorkModeTrajectory(ctx) {
      var registrations = [];
      registrations.push(ctx.uiConversation.events.register({
        kind: 'ib-work-mode-trajectory-request', target: 'trajectory',
        match: function (event) {
          var data = traceData(event);
          return data && data.kind === 'request-header'
            ? { id: String(data.runId) + ':' + String(data.sourceSequence), role: 'start' } : null;
        },
        start: function (_context, match) {
          var event = match.event; var data = traceData(event);
          return { seq: Number(event.seq), time: Number(data.sourceTime) || Number(event.time),
            location: match.location, prompt: { config: { provider: String(data.provider || 'Home Node'),
              model: String(data.model || 'DSH') }, system: '', tools: [] } };
        },
        update: function (context) { return context.state; },
        buildViewNode: function (context) {
          var state = context.state;
          return state ? traceViewNode(context, state.seq, { kind: 'request-header', header: state }) : null;
        }
      }));
      registrations.push(ctx.uiConversation.events.register({
        kind: 'ib-work-mode-trajectory-tool', target: 'trajectory',
        match: function (event) {
          var data = traceData(event);
          if (!data || (data.kind !== 'tool-call' && data.kind !== 'tool-result')) return null;
          return { id: String(data.runId) + ':' + String(data.callId), role: data.kind === 'tool-call' ? 'start' : 'update' };
        },
        start: function (_context, match) {
          var data = traceData(match.event);
          return { runId: String(data.runId), callId: String(data.callId), name: String(data.name || ''),
            argsRaw: String(data.arguments || '{}'), callSeq: Number(match.event.seq),
            callTime: Number(data.sourceTime) || Number(match.event.time), turn: Number(data.turn) || 0,
            step: Number(data.step) || 0, result: data.kind === 'tool-result' ? data : null,
            resultSeq: data.kind === 'tool-result' ? Number(match.event.seq) : 0 };
        },
        update: function (context, match) {
          var data = traceData(match.event);
          return data && data.kind === 'tool-result' ? Object.assign({}, context.state, {
            result: data, resultSeq: Number(match.event.seq), resultTime: Number(data.sourceTime) || Number(match.event.time)
          }) : context.state;
        },
        buildViewNode: function (context) {
          var state = context.state;
          if (!state) return null;
          var args = {};
          var root;
          if (state.result) {
            var result = state.result;
            root = { kind: 'tool-result', seq: Number(state.resultSeq || state.callSeq),
              time: Number(state.resultTime || result.sourceTime || state.callTime), callId: state.callId,
              name: String(result.name || state.name), args: args,
              call: state.callSeq ? { name: state.name, argsRaw: state.argsRaw } : null,
              callTime: state.callSeq ? state.callTime : null,
              content: Array.isArray(result.content) ? result.content : [], isError: result.isError === true,
              ...(result.errorCode ? { error: { name: 'WorkModeToolError', code: String(result.errorCode), reason: '工具执行未完成。' } } : {}),
              subCalls: [] };
          } else {
            root = { phase: 'start', callId: state.callId, name: state.name, argsRaw: state.argsRaw,
              args: args, turn: state.turn, step: state.step, time: state.callTime, subCalls: [] };
          }
          return traceViewNode(context, Number(state.callSeq || context.start.event.seq), { kind: 'tool', root: root });
        }
      }));
      registrations.push(ctx.uiConversation.events.register({
        kind: 'ib-work-mode-trajectory-run-state', target: 'trajectory',
        match: function (event) {
          var data = traceData(event);
          return data && data.kind === 'run-state' && ['running', 'completed', 'failed', 'cancelled'].indexOf(String(data.phase)) >= 0
            ? { id: String(data.runId) + ':' + String(data.sourceSequence), role: 'start' } : null;
        },
        start: function (_context, match) { return traceData(match.event); },
        update: function (context) { return context.state; },
        buildViewNode: function (context) {
          var data = context.state;
          if (!data) return null;
          var event = context.start.event;
          var at = Number(data.at) || Number(event.time);
          var turn = Number(data.turn) || 0;
          var duration = Number.isSafeInteger(data.durationMs) && data.durationMs >= 0 ? Number(data.durationMs) : 0;
          var seconds = duration ? (duration / 1000).toFixed(1) + ' s' : '';
          var route = data.provider || data.model ? String(data.provider || '') + ' / ' + String(data.model || '') : '';
          var line = data.phase === 'running' ? 'Home Node Run running'
            : data.phase === 'completed' ? 'Home Node Result'
              : data.phase === 'cancelled' ? 'Home Node Run cancelled'
                : 'Home Node Run failed' + (data.errorCode ? ' · ' + String(data.errorCode) : '');
          var summary = data.phase === 'completed' ? String(data.summary || 'Result is available in Work Details.') : '';
          var text = line + (route ? ' · ' + route : '') + (seconds ? ' · ' + seconds : '') + (summary ? '\n' + summary : '');
          var node = homeNodeStatusNode(context, data, text, at);
          return traceViewNode(context, Number(event.seq), { kind: 'node', node: node });
        }
      }));
      registrations.push(ctx.uiConversation.events.register({
        kind: 'ib-work-mode-trajectory-model-metadata', target: 'trajectory',
        match: function (event) {
          var data = traceData(event);
          return data && data.kind === 'assistant-metadata'
            ? { id: String(data.runId) + ':' + String(data.sourceSequence), role: 'start' } : null;
        },
        start: function (_context, match) { return traceData(match.event); },
        update: function (context) { return context.state; },
        buildViewNode: function (context) {
          var data = context.state;
          if (!data) return null;
          var duration = Number.isSafeInteger(data.stepStartTime) && Number.isSafeInteger(data.sourceTime)
            ? Math.max(0, Number(data.sourceTime) - Number(data.stepStartTime)) : 0;
          var firstToken = Number.isSafeInteger(data.firstTokenTime) && Number.isSafeInteger(data.stepStartTime)
            ? Math.max(0, Number(data.firstTokenTime) - Number(data.stepStartTime)) : 0;
          var usage = data.usage || {};
          var words = ['DSH 模型响应'];
          if (data.provider || data.model) words.push(String(data.provider || '') + ' / ' + String(data.model || ''));
          if (duration) words.push((duration / 1000).toFixed(1) + ' s');
          if (firstToken) words.push('首 token ' + (firstToken / 1000).toFixed(2) + ' s');
          if (Number.isSafeInteger(usage.outputTokens)) words.push(String(usage.outputTokens) + ' output tokens');
          var node = homeNodeStatusNode(context, data, words.join(' · '), Number(data.sourceTime));
          return traceViewNode(context, Number(context.start.event.seq), { kind: 'node', node: node });
        }
      }));
      registrations.push(ctx.uiConversation.events.register({
        kind: 'ib-work-mode-chat-run-result', target: 'chat',
        match: function (event) {
          var data = traceData(event);
          return data && data.kind === 'run-state' && ['completed', 'failed', 'cancelled'].indexOf(String(data.phase)) >= 0
            ? { id: String(data.runId) + ':' + String(data.sourceSequence), role: 'start' } : null;
        },
        start: function (_context, match) { return traceData(match.event); },
        update: function (context) { return context.state; },
        buildViewNode: function (context) {
          var data = context.state;
          if (!data) return null;
          var at = Number(data.at) || Number(context.start.event.time);
          var status = data.phase === 'completed' ? 'Home Node Result'
            : data.phase === 'cancelled' ? 'Home Node Run cancelled'
              : 'Home Node Run failed' + (data.errorCode ? ' · ' + String(data.errorCode) : '');
          var text = status + (data.phase === 'completed' && data.summary ? '\n' + String(data.summary) : '');
          return chatStatusNode(context, homeNodeStatusNode(context, data, text, at));
        }
      }));
      return function () { registrations.reverse().forEach(function (dispose) { if (typeof dispose === 'function') dispose(); }); };
    }
    function draftDiff(before, after) {
      before = before == null ? '' : String(before); after = after == null ? '' : String(after);
      if (before === after) return '（无变化）';
      if (!before) return after.split('\n').map(function (line) { return '+ ' + line; }).join('\n');
      if (!after) return before.split('\n').map(function (line) { return '- ' + line; }).join('\n');
      return '--- before\n' + before + '\n+++ after\n' + after;
    }
    function nativeComposer(sessionId) {
      var conversation = document.querySelector('[data-conversation-session="' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
      return conversation && conversation.querySelector('[data-composer-card] [contenteditable="true"]');
    }
    function taskPromptKey(sessionId) { return 'ib-dsh-work-task:' + String(sessionId || ''); }
    function storedTaskPrompt(sessionId) {
      try {
        var raw = window.sessionStorage.getItem(taskPromptKey(sessionId));
        var saved = raw ? JSON.parse(raw) : null;
        var prompt = saved && typeof saved.prompt === 'string' ? saved.prompt : '';
        return prompt.length <= 2400 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt) ? prompt : '';
      } catch (_) { return ''; }
    }
    function isWorkTaskRoute(route) {
      return !!(route && ['general', 'coding', 'research', 'app-builder'].indexOf(route.presetId) >= 0);
    }
    function submitWorkModeTask(route) {
      if (!isWorkTaskRoute(route) || typeof route.submit !== 'function') return false;
      var nativeMode = window.__IB_DSH_AGENT_PRESET__;
      if (nativeMode && nativeMode.sessionId === route.sessionId
        && /^(general|coding|research|app-builder)$/.test(String(nativeMode.presetId || ''))) {
        route.presetId = String(nativeMode.presetId);
      }
      if (typeof route.isPending === 'function' && route.isPending()) {
        if (typeof route.reject === 'function') route.reject('正在创建本次任务，请稍候。');
        return true;
      }
      var editor = nativeComposer(route.sessionId);
      if (!editor) return false;
      var inputBridge = window.__IB_DSH_INPUT_BRIDGE__;
      var inputState = inputBridge && inputBridge.sessionId === route.sessionId && typeof inputBridge.getState === 'function'
        ? inputBridge.getState() : null;
      if (inputState && Array.isArray(inputState.attachmentIds) && inputState.attachmentIds.length) {
        if (typeof route.reject === 'function') route.reject('归墟 Work Mode 当前只接收文字任务；请先移除输入框中的附件。');
        return true;
      }
      var taskPrompt = String(inputState && typeof inputState.draft === 'string' ? inputState.draft
        : (editor.innerText || editor.textContent || '')).replace(/\u00a0/g, ' ').trim();
      if (!taskPrompt) {
        var emptyMessage = route.presetId === 'coding' ? '请先描述要创建或修改的 Workspace 文件。'
          : route.presetId === 'app-builder' ? '请先描述要生成或修改的 APP。'
            : route.presetId === 'research' ? '请先写下希望研究的问题。' : '请先描述要处理的任务。';
        if (typeof route.reject === 'function') route.reject(emptyMessage);
        return true;
      }
      if (taskPrompt.length > 2400 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskPrompt)) {
        if (typeof route.reject === 'function') route.reject('任务需为纯文本且不超过 2400 个字符；内容已保留，可直接编辑。');
        return true;
      }
      var panel = document.querySelector('.ib-work-run-session[data-dsh-session-id="'
        + String(route.sessionId).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
      var draftSelect = panel && panel.querySelector('[data-app-draft-select]');
      var submissionId = 'work-mode-' + route.presetId + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      route.submit(taskPrompt, route.presetId === 'app-builder'
        ? (draftSelect ? String(draftSelect.value || '') : String(route.draftRef || '')) : '', submissionId);
      return true;
    }
    function isNativeSendButton(button) {
      if (!button) return false;
      var label = String(button.getAttribute('aria-label') || '').toLowerCase();
      return /发送消息|排队发送|插话发送|send message|queue message|steer message/.test(label);
    }
    function ibBrandMark(props) {
      var size = Math.max(18, Math.min(48, Number(props && props.size) || 24));
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none',
        'aria-hidden': true, focusable: false, className: 'ib-dsh-brand-mark' },
        React.createElement('circle', { cx: 16, cy: 16, r: 14.5, stroke: 'currentColor', strokeWidth: 1.2, opacity: .48 }),
        React.createElement('path', { d: 'M6.5 20.5 12 14l3.2 3.4L21 10l4.5 5.2M8 23.5h16',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        React.createElement('circle', { cx: 21, cy: 9, r: 1.2, fill: 'currentColor' }));
    }
    function WorkRecordSessionMenuItem(props) {
      var sessionId = String(props && props.sessionId || '');
      var useMenuOpenState = props && props.useMenuOpenState;
      var menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null;
      var setMenuOpen = menuState && menuState[1];
      return React.createElement('button', { type: 'button', role: 'menuitem', className: 'ib-work-record-menu-item',
        onClick: function () {
          if (typeof setMenuOpen === 'function') setMenuOpen(false);
          if (!/^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(sessionId)) return;
          var row = document.querySelector('[data-row-key="session:' + sessionId + '"]');
          if (!row || row.getAttribute('aria-description')) return;
          window.__IB_DSH_WORK_RECORD_REQUEST__ = { sessionId: sessionId, expiresAt: Date.now() + 5000 };
          try { window.dispatchEvent(new CustomEvent('ib-dsh-work-record-open', { detail: { sessionId: sessionId } })); } catch (_) {}
          var active = document.querySelector('[data-conversation-session]');
          if (!active || active.getAttribute('data-conversation-session') !== sessionId) setTimeout(function () { row.click(); }, 0);
          setTimeout(function () {
            var pending = window.__IB_DSH_WORK_RECORD_REQUEST__;
            if (pending && pending.sessionId === sessionId && pending.expiresAt <= Date.now()) delete window.__IB_DSH_WORK_RECORD_REQUEST__;
          }, 5100);
        }
      }, '工作记录');
    }
    function LostBeyondAbout() {
      return React.createElement('section', { className: 'ib-dsh-about', 'data-ib-dsh-about': 'true' },
        React.createElement('h3', null, '归墟 · The Lost Beyond'),
        React.createElement('p', null, 'InternalBeyond Work Mode 使用 DSH Cordis 会话与原生轨迹，并由 Home Node 管理 Run、Consent 和 Workspace 权限。'),
        React.createElement('p', null, '技术来源：DeepSeek Harness（DSH）。上游 MIT 许可与版权声明保留在随附的开源许可和来源记录中。'));
    }
    function ThemeFollowSettingsRow() {
      return React.createElement('div', { className: 'ib-dsh-theme-follow-row', 'data-ib-theme-follows': 'true' },
        React.createElement('strong', null, '外观'),
        React.createElement('span', null, '此界面跟随归墟 Light / Dark 主题；请在归墟全局外观中切换。'));
    }
    function notifyNativeWorkStatus(sessionId, level, message) {
      var bridge = window.__IB_DSH_INPUT_BRIDGE__;
      if (!bridge || bridge.sessionId !== sessionId || typeof bridge.notify !== 'function' || !message) return;
      bridge.notify(level, String(message).slice(0, 500));
    }
    function WorkExecutorSelector(props) {
      var sessionId = String(props && props.sessionId || '');
      var parentOrigin = WORK_MODE_PARENT_ORIGIN;
      var [remote, setRemote] = React.useState({ roles: [], profiles: [], selection: { roleId: '', profileRef: '', presetId: 'general' }, locked: false, error: '' });
      var [draft, setDraft] = React.useState({ roleId: '', profileRef: '' });
      var [open, setOpen] = React.useState('');
      var selectorSessionRef = React.useRef(sessionId);
      if (selectorSessionRef.current !== sessionId) {
        selectorSessionRef.current = sessionId;
        setRemote({ roles: [], profiles: [], selection: { roleId: '', profileRef: '', presetId: 'general' }, locked: false, error: '' });
        setDraft({ roleId: '', profileRef: '' });
        setOpen('');
      }
      var inputState = typeof props.useInput === 'function' ? props.useInput(function (snapshot) { return snapshot; }) : null;
      var inputStateRef = React.useRef(inputState);
      inputStateRef.current = inputState;
      var inputBridgeRef = React.useRef(null);
      if (!inputBridgeRef.current) inputBridgeRef.current = { sessionId: sessionId };
      inputBridgeRef.current.sessionId = sessionId;
      inputBridgeRef.current.getState = function () { return inputStateRef.current; };
      inputBridgeRef.current.clearDraft = function () {
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') props.inputActions.setDraft('');
      };
      inputBridgeRef.current.notify = function (level, text) {
        if (props.inputActions && typeof props.inputActions.notify === 'function') props.inputActions.notify(level, text);
      };
      React.useEffect(function () {
        var bridge = inputBridgeRef.current;
        window.__IB_DSH_INPUT_BRIDGE__ = bridge;
        return function () { if (window.__IB_DSH_INPUT_BRIDGE__ === bridge) delete window.__IB_DSH_INPUT_BRIDGE__; };
      }, [sessionId, props.inputActions]);
      React.useEffect(function () {
        function receive(event) {
          if (event.source !== parent || event.origin !== parentOrigin || !event.data
            || event.data.type !== 'ib-dsh-p3-executor-state' || event.data.sessionId !== sessionId) return;
          var next = event.data;
          setRemote({ roles: Array.isArray(next.roles) ? next.roles : [], profiles: Array.isArray(next.profiles) ? next.profiles : [],
            selection: next.selection || { roleId: '', profileRef: '', presetId: 'general' },
            locked: next.locked === true, error: String(next.error || '') });
          if (next.selection) setDraft({ roleId: String(next.selection.roleId || ''), profileRef: String(next.selection.profileRef || '') });
        }
        addEventListener('message', receive);
        if (sessionId) parent.postMessage({ type: 'ib-dsh-p3-catalog-request', sessionId: sessionId }, parentOrigin);
        return function () { removeEventListener('message', receive); };
      }, [sessionId]);
      var selectedRole = remote.roles.find(function (item) { return item.roleId === draft.roleId; }) || null;
      var selectedProfile = remote.profiles.find(function (item) { return item.profileRef === draft.profileRef; }) || null;
      var selectedName = selectedRole ? selectedRole.name : '标准 Agent';
      var selectedModel = selectedProfile ? selectedProfile.model : '选择模型 Profile';
      var modelOverride = !!(selectedRole && selectedProfile && draft.profileRef !== selectedRole.profileRef);
      var profileKind = !selectedRole ? '独立模型 Profile' : modelOverride ? '手动覆盖' : '角色默认模型';
      function updateRole(roleId) {
        var role = remote.roles.find(function (item) { return item.roleId === roleId; });
        setDraft({ roleId: roleId, profileRef: role ? role.profileRef : draft.profileRef });
      }
      function apply(selectionKind) {
        if (remote.locked || !draft.profileRef) return;
        setOpen('');
        parent.postMessage({ type: 'ib-dsh-p3-executor-selection', sessionId: sessionId,
          selectionKind: selectionKind, roleId: draft.roleId, profileRef: draft.profileRef }, parentOrigin);
      }
      return React.createElement('div', { className: 'ib-executor-selector', 'data-executor-selector': 'true' },
        React.createElement('div', { className: 'ib-executor-trigger' },
          React.createElement('button', { type: 'button', className: 'ib-executor-role-trigger',
            'aria-label': '选择角色，当前：' + selectedName, 'aria-haspopup': 'dialog', 'aria-expanded': open === 'role',
            disabled: !sessionId || remote.locked, onClick: function () { setOpen(open === 'role' ? '' : 'role'); } },
            selectedRole && selectedRole.avatar ? React.createElement('img', { className: 'ib-executor-avatar', src: selectedRole.avatar, alt: '' })
              : React.createElement('span', { className: 'ib-executor-avatar ib-executor-avatar-fallback', 'aria-hidden': true }, String(selectedName).slice(0, 1)),
            React.createElement('span', { className: 'ib-executor-role-copy' }, selectedName),
            React.createElement('span', { className: 'ib-executor-chevron', 'aria-hidden': true }, '⌄')),
          React.createElement('button', { type: 'button', className: 'ib-executor-profile-trigger',
            'aria-label': '选择模型 Profile，当前：' + selectedModel, 'aria-haspopup': 'dialog', 'aria-expanded': open === 'profile',
            disabled: !sessionId || remote.locked, onClick: function () { setOpen(open === 'profile' ? '' : 'profile'); } },
            React.createElement('span', { className: 'ib-executor-profile-copy' }, selectedModel),
            React.createElement('span', { className: 'ib-executor-profile-kind' }, profileKind),
            React.createElement('span', { className: 'ib-executor-chevron', 'aria-hidden': true }, '⌄'))),
        open === 'role' ? React.createElement('div', { className: 'ib-executor-menu ib-executor-role-menu', role: 'dialog', 'aria-label': '选择角色' },
          React.createElement('h3', null, '角色'),
          React.createElement('button', { type: 'button', className: 'ib-executor-option', 'aria-pressed': draft.roleId === '',
            disabled: remote.locked, onClick: function () { updateRole(''); } },
            React.createElement('span', { className: 'ib-executor-avatar ib-executor-avatar-fallback', 'aria-hidden': true }, '标'),
            React.createElement('span', { className: 'ib-executor-option-copy' },
              React.createElement('strong', null, '标准 Agent'), React.createElement('span', null, '不附加角色人格'))),
          ...remote.roles.map(function (role) { return React.createElement('button', { key: role.roleId, type: 'button',
            className: 'ib-executor-option', 'aria-pressed': draft.roleId === role.roleId, disabled: remote.locked,
            onClick: function () { updateRole(role.roleId); } },
            role.avatar ? React.createElement('img', { className: 'ib-executor-avatar', src: role.avatar, alt: '' })
              : React.createElement('span', { className: 'ib-executor-avatar ib-executor-avatar-fallback', 'aria-hidden': true }, String(role.name || '角').slice(0, 1)),
            React.createElement('span', { className: 'ib-executor-option-copy' },
              React.createElement('strong', null, role.name), React.createElement('span', null, '默认模型 · ' + role.model))); }),
          React.createElement('p', { className: 'ib-executor-menu-note' }, '选择角色会恢复该角色的默认模型；需要时可在旁边单独覆盖模型 Profile。'),
          remote.locked ? React.createElement('p', { role: 'status' }, '当前 Run 已固定角色和模型；结束后可为新的 Run 选择。') : null,
          remote.error ? React.createElement('p', { role: 'alert' }, remote.error) : null,
          React.createElement('button', { type: 'button', disabled: remote.locked || !draft.profileRef,
            onClick: function () { apply('role'); } }, '应用角色')) : null,
        open === 'profile' ? React.createElement('div', { className: 'ib-executor-menu ib-executor-profile-menu', role: 'dialog', 'aria-label': '选择模型 Profile' },
          React.createElement('h3', null, '模型 Profile'),
          ...remote.profiles.map(function (profile) { return React.createElement('button', { key: profile.profileRef, type: 'button',
            className: 'ib-executor-option ib-executor-profile-option', 'aria-pressed': draft.profileRef === profile.profileRef,
            disabled: remote.locked, onClick: function () { setDraft(Object.assign({}, draft, { profileRef: profile.profileRef })); } },
            React.createElement('span', { className: 'ib-executor-option-copy' },
              React.createElement('strong', null, profile.model), React.createElement('span', null, profile.name + ' · ' + profile.provider))); }),
          selectedRole ? React.createElement('p', { className: 'ib-executor-menu-note' }, modelOverride
            ? '当前 Profile 覆盖角色默认模型。' : '当前使用角色绑定的默认模型。') : null,
          remote.locked ? React.createElement('p', { role: 'status' }, '当前 Run 已固定角色和模型；结束后可为新的 Run 选择。') : null,
          remote.error ? React.createElement('p', { role: 'alert' }, remote.error) : null,
          React.createElement('button', { type: 'button', disabled: remote.locked || !draft.profileRef,
            onClick: function () { apply('profile'); } }, '应用模型 Profile')) : null);
    }
    function WorkRunComposer(props) {
      var sessionId = String(props && props.sessionId || '');
      var initialPreset = window.__IB_DSH_AGENT_PRESET__ && window.__IB_DSH_AGENT_PRESET__.sessionId === sessionId
        ? String(window.__IB_DSH_AGENT_PRESET__.presetId || 'general') : 'general';
      var [nativePresetId, setNativePresetId] = React.useState(initialPreset);
      var [state, setState] = React.useState({ phase: 'checking', runId: '', result: null, authorization: null,
        events: [], error: '', executorSelection: { presetId: 'general' }, drafts: [], history: [], draft: null, previewSrcdoc: '', appInstalled: false });
      var [ackEgress, setAckEgress] = React.useState(false);
      var [ackStorage, setAckStorage] = React.useState(false);
      var [ackMemory, setAckMemory] = React.useState(false);
      var [ackMemoryReview, setAckMemoryReview] = React.useState(false);
      var [ackMemoryResult, setAckMemoryResult] = React.useState(false);
      var [memoryIds, setMemoryIds] = React.useState([]);
      var [draftRef, setDraftRef] = React.useState('');
      var [installAccepted, setInstallAccepted] = React.useState(false);
      var [restoreVersion, setRestoreVersion] = React.useState(null);
      var [restoreError, setRestoreError] = React.useState('');
      var [exportVersion, setExportVersion] = React.useState(null);
      var [exportPending, setExportPending] = React.useState(false);
      var [exportStatus, setExportStatus] = React.useState('');
      var [permissionMessage, setPermissionMessage] = React.useState('');
      var [panelOpen, setPanelOpen] = React.useState(false);
      var stateRef = React.useRef(state);
      stateRef.current = state;
      React.useEffect(function () {
        function receivePreset(event) {
          var detail = event && event.detail;
          if (!detail || detail.sessionId !== sessionId || !/^(general|coding|research|app-builder)$/.test(String(detail.presetId || ''))) return;
          setNativePresetId(String(detail.presetId));
        }
        addEventListener('ib-dsh-agent-preset-state', receivePreset);
        var current = window.__IB_DSH_AGENT_PRESET__;
        if (current && current.sessionId === sessionId && /^(general|coding|research|app-builder)$/.test(String(current.presetId || ''))) {
          setNativePresetId(String(current.presetId));
        }
        return function () { removeEventListener('ib-dsh-agent-preset-state', receivePreset); };
      }, [sessionId]);
      var previewFrameRef = React.useRef(null);
      var draftArtifactRef = React.useRef(null);
      var lastRunIdRef = React.useRef('');
      var permissionRequestRef = React.useRef('');
      var permissionToCloseRef = React.useRef('');
      var permissionContextRef = React.useRef(null);
      var permissionSubmittedRef = React.useRef(false);
      var pendingAppBuilderSubmissionRef = React.useRef(null);
      var previewKeyRef = React.useRef('');
      var composerSessionRef = React.useRef(sessionId);
      var lastNativeStatusRef = React.useRef('');
      var lastNativeToolSequenceRef = React.useRef(0);
      var traceForwardRef = React.useRef({ key: '', sequence: 0, phase: '' });
      var traceQueueRef = React.useRef(Promise.resolve());
      if (composerSessionRef.current !== sessionId) {
        composerSessionRef.current = sessionId;
        permissionToCloseRef.current = permissionRequestRef.current;
        setState({ phase: 'checking', runId: '', result: null, authorization: null,
          events: [], error: '', executorSelection: { presetId: 'general' }, drafts: [], history: [], draft: null, previewSrcdoc: '', appInstalled: false });
        setAckEgress(false); setAckStorage(false); setAckMemory(false); setAckMemoryReview(false); setAckMemoryResult(false);
        setMemoryIds([]); setDraftRef(''); setInstallAccepted(false); setRestoreVersion(null); setRestoreError('');
        setExportVersion(null); setExportPending(false); setExportStatus('');
        setPermissionMessage(''); setPanelOpen(false);
        draftArtifactRef.current = null; lastRunIdRef.current = ''; permissionRequestRef.current = '';
        permissionContextRef.current = null; permissionSubmittedRef.current = false; pendingAppBuilderSubmissionRef.current = null;
        previewKeyRef.current = ''; lastNativeStatusRef.current = ''; lastNativeToolSequenceRef.current = 0;
        traceForwardRef.current = { key: '', sequence: 0, phase: '' };
      }
      React.useEffect(function () {
        function openDetails(event) {
          if (event && event.detail && event.detail.sessionId === sessionId) setPanelOpen(true);
        }
        window.addEventListener('ib-dsh-work-record-open', openDetails);
        var pending = window.__IB_DSH_WORK_RECORD_REQUEST__;
        if (pending && pending.sessionId === sessionId && pending.expiresAt > Date.now()) {
          delete window.__IB_DSH_WORK_RECORD_REQUEST__;
          setPanelOpen(true);
        }
        return function () { window.removeEventListener('ib-dsh-work-record-open', openDetails); };
      }, [sessionId]);
      function publishWorkModeTrace(message) {
        var incomingRunId = String(message && message.runId || '');
        var phase = String(message && message.phase || '');
        if (!incomingRunId || ['running', 'completed', 'failed', 'cancelled'].indexOf(phase) < 0) return;
        var key = sessionId + ':' + incomingRunId;
        if (traceForwardRef.current.key !== key) traceForwardRef.current = { key: key, sequence: 0, phase: '' };
        var events = Array.isArray(message.events) ? message.events.filter(function (item) {
          return item && String(item.runId || incomingRunId) === incomingRunId
            && item.event === 'dsh-session-event' && item.dshEvent && typeof item.dshEvent === 'object';
        }).slice().sort(function (left, right) {
          return Number(String(left.sequence || '').replace(/^d/, '')) - Number(String(right.sequence || '').replace(/^d/, ''));
        }) : [];
        var nextEvents = events.filter(function (item) {
          return Number(String(item.sequence || '').replace(/^d/, '')) > traceForwardRef.current.sequence;
        });
        if (!nextEvents.length && traceForwardRef.current.phase === phase) return;
        var current = stateRef.current || {};
        var authorization = message.authorization || current.authorization || {};
        var agent = authorization.agent || {};
        var report = message.result && message.result.report || current.result && current.result.report || {};
        var draft = message.draft || current.draft || {};
        var summary = String(message.traceSummary || report.summary || (draft.name
          ? 'APP 草稿 ' + String(draft.name) + ' · v' + String(draft.version || 0)
          : '')).slice(0, 1600);
        summary = summary.replace(/(api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [已隐藏]');
        var promptSummary = String(message.tracePrompt || authorization.taskPrompt || draft.request || '').trim();
        if (!promptSummary) {
          var selectedPaths = Array.isArray(authorization.files)
            ? authorization.files.map(function (file) { return String(file && file.path || ''); }).filter(Boolean).slice(0, 12) : [];
          promptSummary = '对 Workspace 项目 ' + String(authorization.projectRef || '')
            + (selectedPaths.length ? ' 中明确选择的文件 ' + selectedPaths.join('、') : '') + ' 执行只读审计。';
        }
        promptSummary = promptSummary.slice(0, 2400);
        var errorCode = String(message.traceErrorCode || '');
        if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(errorCode)) {
          var matchedCode = /(?:^|[\s(])([A-Za-z][A-Za-z0-9_.:-]{2,79})(?:$|[\s)])/g;
          var found = matchedCode.exec(String(message.error || current.error || ''));
          errorCode = found ? found[1] : '';
        }
        var maxSequence = nextEvents.reduce(function (highest, item) {
          return Math.max(highest, Number(String(item.sequence || '').replace(/^d/, '')) || 0);
        }, traceForwardRef.current.sequence);
        var payload = {
          sessionId: sessionId,
          runId: incomingRunId,
          phase: phase,
          events: nextEvents,
          promptSummary: promptSummary,
          provider: String(message.traceProvider || agent.provider || ''),
          model: String(message.traceModel || agent.model || ''),
          summary: summary,
          errorCode: errorCode,
          at: Number(message.traceAt) || Date.now()
        };
        traceQueueRef.current = traceQueueRef.current.catch(function () {}).then(function () {
          return fetch('/api/ib/work-mode/trace', { method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        }).then(function (response) {
          if (!response || !response.ok) throw new Error('native-trace-unavailable');
          traceForwardRef.current = { key: key, sequence: maxSequence, phase: phase };
        }).catch(function () { /* The Home Node Run remains authoritative; retry on the next status frame. */ });
      }
      React.useEffect(function () {
        var requestId = permissionToCloseRef.current;
        permissionToCloseRef.current = '';
        var api = window.__DSH_STARTUP_PERMISSION__;
        if (requestId && api && typeof api.closePermission === 'function') api.closePermission(requestId);
      }, [sessionId]);
      React.useEffect(function () { draftArtifactRef.current = state.draft; }, [state.draft]);
      React.useEffect(function () {
        function onMessage(event) {
          if (!event.data) return;
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-p3-executor-state' && event.data.sessionId === sessionId) {
            setState(function (previous) { return Object.assign({}, previous, {
              executorSelection: event.data.selection || previous.executorSelection,
              drafts: Array.isArray(event.data.appDrafts) ? event.data.appDrafts : previous.drafts,
              error: String(event.data.error || previous.error || '') }); });
            return;
          }
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-p3-run-created' && event.data.sessionId === sessionId) {
            var pendingSubmission = pendingAppBuilderSubmissionRef.current;
            if (pendingSubmission && pendingSubmission.submissionId === String(event.data.submissionId || '')) {
              pendingAppBuilderSubmissionRef.current = null;
              if (event.data.created === true) {
                var runId = String(event.data.runId || '');
                fetch('/api/ib/work-mode/task', { method: 'POST', cache: 'no-store',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionId: sessionId, runId: runId, prompt: pendingSubmission.taskPrompt })
                }).then(function (response) {
                  if (!response || !response.ok) throw new Error('task-message-append-failed');
                  var inputBridge = window.__IB_DSH_INPUT_BRIDGE__;
                  var inputState = inputBridge && inputBridge.sessionId === sessionId && typeof inputBridge.getState === 'function'
                    ? inputBridge.getState() : null;
                  if (inputState && typeof inputBridge.clearDraft === 'function'
                    && String(inputState.draft || '').replace(/\u00a0/g, ' ').trim() === pendingSubmission.taskPrompt) inputBridge.clearDraft();
                  parent.postMessage({ type: 'ib-dsh-p3-task-appended', sessionId: sessionId, runId: runId }, WORK_MODE_PARENT_ORIGIN);
                }).catch(function () {
                  setState(function (previous) { return Object.assign({}, previous, { error: '本地 DSH 会话没有保存任务消息；请检查工作记录后重试。' }); });
                });
              }
              if (event.data.error) {
                setState(function (previous) { return Object.assign({}, previous, { error: String(event.data.error) }); });
                notifyNativeWorkStatus(sessionId, 'error', String(event.data.error));
              }
            }
            return;
          }
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-app-storage-response' && event.data.sessionId === sessionId
            && previewFrameRef.current && event.data.draftRef === String(draftArtifactRef.current && draftArtifactRef.current.draftRef || '')) {
            previewFrameRef.current.contentWindow.postMessage({ type: 'ib-generated-app-storage-response',
              requestId: event.data.requestId, ok: event.data.ok === true, value: event.data.value, error: event.data.error }, '*');
            return;
          }
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-app-install-state' && event.data.sessionId === sessionId) {
            setState(function (previous) { return Object.assign({}, previous, { appInstalled: event.data.installed === true,
              installError: String(event.data.error || '') }); });
            return;
          }
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-app-restore-state' && event.data.sessionId === sessionId) {
            setRestoreVersion(null); setRestoreError(String(event.data.error || ''));
            return;
          }
          if (event.source === parent && event.origin === WORK_MODE_PARENT_ORIGIN
            && event.data.type === 'ib-dsh-app-export-state' && event.data.sessionId === sessionId) {
            var exportMessage = String(event.data.message || (event.data.ok === true ? '导出已开始。' : '导出失败。'));
            setExportPending(false); setExportStatus(exportMessage);
            notifyNativeWorkStatus(sessionId, event.data.ok === true ? 'info' : 'error', exportMessage);
            return;
          }
          if (previewFrameRef.current && event.source === previewFrameRef.current.contentWindow && event.origin === 'null'
            && event.data.type === 'ib-generated-app-storage-request' && draftArtifactRef.current) {
            parent.postMessage({ type: 'ib-dsh-app-storage-request', sessionId: sessionId, draftRef: draftArtifactRef.current.draftRef,
              requestId: event.data.requestId, action: event.data.action, key: event.data.key, value: event.data.value }, WORK_MODE_PARENT_ORIGIN);
            return;
          }
          if (event.source !== parent || event.origin !== WORK_MODE_PARENT_ORIGIN
            || event.data.type !== 'ib-dsh-p1-run-state' || event.data.sessionId !== sessionId) return;
          publishWorkModeTrace(event.data);
          if (['completed', 'failed', 'cancelled'].indexOf(String(event.data.phase || '')) >= 0) {
            try { window.sessionStorage.removeItem(taskPromptKey(sessionId)); } catch (_) {}
          }
          var authorization = event.data.authorization || null;
          var incomingRunId = String(event.data.runId || '');
          var changedRun = !!(incomingRunId && lastRunIdRef.current && incomingRunId !== lastRunIdRef.current);
          if (changedRun) {
            lastNativeStatusRef.current = '';
            lastNativeToolSequenceRef.current = 0;
            setRestoreVersion(null); setRestoreError(''); setInstallAccepted(false);
          }
          var incomingPhase = String(event.data.phase || 'ready');
          var currentSelection = stateRef.current && stateRef.current.executorSelection || {};
          var isAppBuilderRun = !!(authorization && authorization.workflowId === 'app.builder')
            || currentSelection.presetId === 'app-builder';
          var phaseChanged = incomingPhase !== String(stateRef.current && stateRef.current.phase || '')
            || incomingRunId !== String(stateRef.current && stateRef.current.runId || '');
          if (phaseChanged && ((isAppBuilderRun && incomingPhase === 'needs-consent')
            || ['running', 'completed', 'cancelled', 'failed', 'error'].indexOf(incomingPhase) >= 0)) {
            setPanelOpen(false);
          }
          if (incomingRunId) {
            var statusKey = sessionId + ':' + incomingRunId + ':' + incomingPhase;
            if (['running', 'completed', 'cancelled', 'failed', 'error'].indexOf(incomingPhase) >= 0
              && lastNativeStatusRef.current !== statusKey) {
              lastNativeStatusRef.current = statusKey;
              if (incomingPhase === 'running') notifyNativeWorkStatus(sessionId, 'info', '工作任务正在执行。');
              else if (incomingPhase === 'completed') {
                var summary = event.data.result && event.data.result.report && event.data.result.report.summary;
                notifyNativeWorkStatus(sessionId, 'info', summary || '工作任务已完成，可从工作记录入口查看结果。');
              } else if (incomingPhase === 'cancelled') notifyNativeWorkStatus(sessionId, 'info', '任务已取消，已保存的草稿版本保持不变。');
              else notifyNativeWorkStatus(sessionId, 'error', event.data.error || '任务未完成；已保留上一个已保存版本。');
            }
            var events = Array.isArray(event.data.events) ? event.data.events : [];
            var toolEvent = events.slice().reverse().find(function (item) {
              return item && Number(item.sequence) > lastNativeToolSequenceRef.current
                && (String(item.event || '').indexOf('tool') >= 0 || String(item.event || '').indexOf('app-draft-file') === 0);
            });
            if (incomingPhase === 'running' && toolEvent) {
              lastNativeToolSequenceRef.current = Number(toolEvent.sequence) || lastNativeToolSequenceRef.current;
              notifyNativeWorkStatus(sessionId, 'info', toolEvent.path ? '工作进度 · ' + String(toolEvent.path) : '正在处理授权范围内的工作步骤。');
            }
          }
          if (incomingRunId) lastRunIdRef.current = incomingRunId;
          var nextPreviewKey = authorization && String(authorization.previewKey || '');
          if (nextPreviewKey && nextPreviewKey !== previewKeyRef.current) {
            previewKeyRef.current = nextPreviewKey;
            setAckEgress(false); setAckStorage(false);
            setAckMemory(false); setAckMemoryReview(false); setAckMemoryResult(false);
            setMemoryIds(Array.isArray(authorization.memory && authorization.memory.selectedIds)
              ? authorization.memory.selectedIds.map(String) : []);
            setInstallAccepted(false);
          }
          setState(function (previous) { return Object.assign({}, previous, {
            phase: String(event.data.phase || 'ready'), runId: String(event.data.runId || ''), result: event.data.result || null,
            authorization: authorization || previous.authorization,
            executorSelection: authorization && authorization.executorSelection || event.data.executorSelection || previous.executorSelection,
            events: Array.isArray(event.data.events) ? event.data.events : previous.events,
            error: String(event.data.error || ''), drafts: Array.isArray(event.data.drafts) ? event.data.drafts : previous.drafts,
            history: Array.isArray(event.data.history) ? event.data.history : previous.history,
            draft: event.data.draft || (changedRun ? null : previous.draft),
            previewSrcdoc: event.data.previewSrcdoc || (changedRun ? '' : previous.previewSrcdoc),
            appInstalled: typeof event.data.appInstalled === 'boolean' ? event.data.appInstalled : previous.appInstalled,
            installError: String(event.data.installError || '') }); });
          if (authorization && authorization.appDraftRef) setDraftRef(String(authorization.appDraftRef));
          else if (event.data.draft && event.data.draft.draftRef) setDraftRef(function (previous) {
            return previous || String(event.data.draft.draftRef);
          });
        }
        addEventListener('message', onMessage);
        parent.postMessage({ type: 'ib-dsh-p1-session-open', sessionId: sessionId,
          taskPrompt: storedTaskPrompt(sessionId) }, WORK_MODE_PARENT_ORIGIN);
        var timer = setInterval(function () {
          parent.postMessage({ type: 'ib-dsh-p1-session-status', sessionId: sessionId, timestamp: Date.now() }, WORK_MODE_PARENT_ORIGIN);
        }, 1500);
        return function () { clearInterval(timer); removeEventListener('message', onMessage); };
      }, [sessionId]);
      React.useEffect(function () {
        var previous = window.__IB_DSH_APP_BUILDER_COMPOSER__;
        var route = { sessionId: sessionId,
          presetId: String(nativePresetId || state.executorSelection && state.executorSelection.presetId || 'general'),
          draftRef: draftRef,
          isPending: function () { return !!pendingAppBuilderSubmissionRef.current; },
          submit: function (taskPrompt, selectedDraftRef, submissionId) {
            pendingAppBuilderSubmissionRef.current = { taskPrompt: taskPrompt, submissionId: submissionId, presetId: route.presetId };
            if (route.presetId === 'coding') {
              try { window.sessionStorage.setItem(taskPromptKey(sessionId), JSON.stringify({ prompt: String(taskPrompt || ''), at: Date.now() })); } catch (_) {}
            }
            parent.postMessage({ type: 'ib-dsh-p3-create-run', sessionId: sessionId,
              taskPrompt: taskPrompt, draftRef: String(selectedDraftRef || ''), submissionId: submissionId }, WORK_MODE_PARENT_ORIGIN);
          },
          reject: function (message) {
            setState(function (current) { return Object.assign({}, current, { error: message }); });
            notifyNativeWorkStatus(sessionId, 'error', message);
          } };
        window.__IB_DSH_APP_BUILDER_COMPOSER__ = route;
        return function () {
          if (window.__IB_DSH_APP_BUILDER_COMPOSER__ === route) {
            if (previous && previous.sessionId !== sessionId) window.__IB_DSH_APP_BUILDER_COMPOSER__ = previous;
            else delete window.__IB_DSH_APP_BUILDER_COMPOSER__;
          }
        };
      }, [sessionId, draftRef, nativePresetId, state.executorSelection && state.executorSelection.presetId]);
      var report = state.result && state.result.report;
      var authorization = state.authorization;
      var permissionApi = window.__DSH_STARTUP_PERMISSION__;
      var permissionRequestId = authorization ? ['ibp', sessionId, authorization.runId, String(authorization.previewKey || '').slice(0, 16)].join(':') : '';
      var permissionMemoryIds = authorization && authorization.memory && Array.isArray(authorization.memory.selectedIds)
        ? authorization.memory.selectedIds.map(String) : [];
      var permissionIsAppBuilder = !!(authorization && authorization.workflowId === 'app.builder');
      var permissionIsCoding = !!(authorization && authorization.workflowId === 'coding.workspace');
      var permissionExecutor = authorization && authorization.executorSelection || {};
      var permissionTools = Array.isArray(permissionExecutor.allowedTools) ? permissionExecutor.allowedTools : [];
      var permissionContext = { sessionId: sessionId, authorization: authorization, requestId: permissionRequestId,
        memoryIds: permissionMemoryIds, appBuilder: permissionIsAppBuilder, coding: permissionIsCoding };
      permissionContextRef.current = permissionContext;
      function permissionAcknowledgements(context) {
        var items = [
          { key: 'egress', label: '我授权将本次任务内容、角色人格提示词' + (context.appBuilder ? '和 APP 草稿文件' : '与已选择的项目文件') + '发送给所列模型。' },
          { key: 'storage', label: context.appBuilder
            ? '我接受 APP 源码明文保存在 Home Node 草稿区，以及 Result 摘要保存在本机 SQLite 的风险。'
            : '我接受 Home Node Result 在本机 SQLite 明文保存的风险。' }
        ];
        if (context.memoryIds.length) items.push(
          { key: 'memory', label: '我单独授权将所选项目 Agent Memory Recall 发送给 Agent Provider。' },
          { key: 'memoryReview', label: '我单独授权将可能包含 Memory 衍生内容的证据和报告发送给 Middle Brain Review Provider。' },
          { key: 'memoryResult', label: '我单独授权将 memory-derived Result 明文保存到 Home Node SQLite。' });
        if (context.coding) items.push({ key: 'workspaceWrite', label: '我单独授权 Coding Agent 修改已选择的文件，并在其所在目录新建文本文件；运行失败或取消时会尝试回退。' });
        return items;
      }
      function buildPermissionRequest(context) {
        var auth = context.authorization || {};
        var appBuilder = context.appBuilder;
        var coding = context.coding;
        var agent = auth.agent || {};
        var review = auth.review || {};
        var role = auth.executorSelection && auth.executorSelection.roleName || '标准 Agent';
        var scope = appBuilder ? [
          '当前 APP 草稿：' + String(auth.appDraftName || 'Todo App') + ' · v' + String(auth.appDraftVersion || 0),
          '仅限草稿文件 index.html、styles.css、app.js；仅开放：' + (permissionTools.join(', ') || '无工具'),
          '不读取 Workspace 文件、Chat Memory、凭据；不开放 Shell、网络、MCP 或任意路径。'
        ] : (coding ? [
          'Workspace 项目：' + String(auth.projectRef || '') + '；更新仅限明确选择的文件 ID：'
            + (Array.isArray(auth.files) ? auth.files.map(function (file) { return String(file.path || ''); }).join(', ') || '无' : '无'),
          '新建文本文件仅限上述文件所在目录；每次修改都检查 Workspace 文件版本。',
          '只开放：' + (permissionTools.join(', ') || '无工具') + '；不开放 Shell、网络、MCP、浏览器或任意路径。'
        ] : [
          'Workspace 项目：' + String(auth.projectRef || '') + '；仅限明确选择的文件：'
            + (Array.isArray(auth.files) ? auth.files.map(function (file) { return String(file.path || ''); }).join(', ') || '无' : '无'),
          '工具范围：' + (permissionTools.join(', ') || '无项目工具') + '；只读次数上限：'
            + String(auth.executorSelection && auth.executorSelection.maxProjectReadCalls || 0),
          context.memoryIds.length ? '项目 Agent Memory Recall 只读，共 ' + String(context.memoryIds.length) + ' 条；与 Chat Memory 隔离。'
            : '未选择 Agent Memory Recall。'
        ]);
        var risks = [
          'Agent 模型：' + String(agent.provider || '') + ' / ' + String(agent.model || '') + '；执行者：' + String(role),
          appBuilder ? 'APP 源码明文保存在 Home Node 草稿区；Result 摘要保存于本机 SQLite。'
            : (coding ? '所选文件、任务与角色提示词发送给 Agent Provider；修改范围由 Home Node Consent 固定。Result 在 Home Node SQLite 明文保存，最多保留 90 天。'
              : '所选文件、任务与角色提示词将外发；Result 在 Home Node SQLite 明文保存，最多保留 90 天。'),
          'Consent 有效期 15 分钟；取消、完成、过期或范围变化后不能继续使用。'
        ];
        var details = [
          'DSH Session：' + context.sessionId,
          'Home Node Run：' + String(auth.runId || ''),
          '项目引用：' + String(auth.projectRef || ''),
          'Agent 路由：' + String(agent.provider || '') + ' / ' + String(agent.model || '') + ' · ' + String(agent.endpointLabel || ''),
          review.provider ? 'Middle Brain Review 路由：' + String(review.provider) + ' / ' + String(review.model || '') + ' · ' + String(review.endpointLabel || '') : '本 Run 不调用 Middle Brain Review。',
          '工具：' + (permissionTools.join(', ') || '无') + ' · 配置固定于本 Run。',
          context.memoryIds.length ? 'Memory Recall：' + String(auth.memory && auth.memory.contextChars || 0) + ' 字符 · SHA-256 ' + String(auth.memory && auth.memory.contextHash || '').slice(0, 12) + '…' : 'Memory Recall：未选择。',
          '任务：' + String(auth.taskPrompt || '（无单独任务文本）')
        ];
        return { requestId: context.requestId, sessionId: context.sessionId, runId: auth.runId,
          previewKey: auth.previewKey, title: appBuilder ? 'App Builder Run 权限请求' : (coding ? 'Coding Run 权限请求' : 'Work Run 权限请求'),
          summary: coding ? '请核对模型、选中文件与写入目录。单独确认后，归墟 Home Node 会记录 Workspace 写入 Consent。'
            : '请核对本次 Run 的模型、操作范围与存储风险。确认后，归墟 Home Node 会创建并绑定 Consent。',
          model: String(agent.provider || '') + ' / ' + String(agent.model || ''), scope: scope, risks: risks,
          details: details, acknowledgements: permissionAcknowledgements(context) };
      }
      function onPermissionDecision(detail) {
        detail = detail || {};
        var context = permissionContextRef.current;
        var auth = context && context.authorization;
        if (!context || !auth || detail.requestId !== context.requestId || detail.sessionId !== context.sessionId
          || detail.runId !== auth.runId || detail.previewKey !== auth.previewKey) return;
        var acknowledgements = detail.acknowledgements || {};
        var api = window.__DSH_STARTUP_PERMISSION__;
        if (detail.action === 'deny' || detail.action === 'cancel') {
          var denied = detail.action === 'deny';
          permissionSubmittedRef.current = false;
          var message = denied ? '已拒绝本次请求；Home Node 未创建 Consent，Run 未启动。'
            : '本次请求已取消；Home Node 未创建 Consent，Run 未启动。';
          setPermissionMessage(message);
          if (api && typeof api.updatePermission === 'function') api.updatePermission(context.requestId, {
            status: denied ? 'denied' : 'cancelled', message: message
          });
          return;
        }
        if (detail.action !== 'confirm' || acknowledgements.egress !== true || acknowledgements.storage !== true
          || (context.memoryIds.length && (acknowledgements.memory !== true || acknowledgements.memoryReview !== true
            || acknowledgements.memoryResult !== true))
          || (context.coding && acknowledgements.workspaceWrite !== true)) return;
        setPermissionMessage('正在请求 Home Node 核验；授权尚未通过。');
        if (api && typeof api.updatePermission === 'function') api.updatePermission(context.requestId, { status: 'verifying' });
        permissionSubmittedRef.current = true;
        setState(function (previous) { return Object.assign({}, previous, { phase: 'binding', error: '' }); });
        parent.postMessage({ type: 'ib-dsh-p1-consent', sessionId: context.sessionId, runId: auth.runId,
          previewKey: auth.previewKey, expiresInMs: auth.expiresInMs,
          fileIds: Array.isArray(auth.files) ? auth.files.map(function (file) { return String(file.fileId || ''); }) : [],
          memoryIds: context.memoryIds.slice(), ackMemory: acknowledgements.memory === true,
          ackMemoryReview: acknowledgements.memoryReview === true, ackMemoryResult: acknowledgements.memoryResult === true,
          ackWorkspaceWrite: acknowledgements.workspaceWrite === true, taskPrompt: String(auth.taskPrompt || ''),
          ackEgress: acknowledgements.egress === true, ackStorage: acknowledgements.storage === true }, WORK_MODE_PARENT_ORIGIN);
      }
      function openPermissionMode() {
        var context = permissionContextRef.current;
        var api = window.__DSH_STARTUP_PERMISSION__;
        if (!context || !context.authorization || !api || typeof api.requestPermission !== 'function'
          || typeof api.setDecisionHandler !== 'function') {
          setPermissionMessage('DSH Permission 模式不可用；可使用下方 Home Node 授权卡片。');
          return false;
        }
        permissionSubmittedRef.current = false;
        api.setDecisionHandler(context.requestId, onPermissionDecision);
        var opened = api.requestPermission(buildPermissionRequest(context));
        if (!opened) {
          api.setDecisionHandler(context.requestId, null);
          setPermissionMessage('权限请求信息不完整；Home Node 未收到授权确认。');
        }
        return opened;
      }
      React.useEffect(function () {
        if (state.phase !== 'needs-consent' || !authorization || !permissionRequestId || !permissionApi
          || typeof permissionApi.requestPermission !== 'function') return;
        if (permissionRequestRef.current === permissionRequestId) return;
        permissionRequestRef.current = permissionRequestId;
        setPermissionMessage('');
        openPermissionMode();
      }, [state.phase, permissionRequestId]);
      React.useEffect(function () {
        var requestId = permissionRequestRef.current;
        var api = window.__DSH_STARTUP_PERMISSION__;
        if (!requestId || !api || typeof api.updatePermission !== 'function') return;
        var status = state.phase === 'ready' ? 'verified' : state.phase === 'running' ? 'running'
          : state.phase === 'completed' ? 'completed' : ['failed', 'error'].indexOf(state.phase) >= 0 && permissionSubmittedRef.current ? 'failed'
            : state.phase === 'cancelled' ? 'cancelled' : state.phase === 'binding' ? 'verifying' : '';
        if (state.phase === 'needs-consent' && state.error && permissionSubmittedRef.current) status = 'failed';
        if (status) api.updatePermission(requestId, { status: status, message: state.error || '' });
        if ((status === 'running' || status === 'completed') && typeof api.closePermission === 'function') {
          api.closePermission(requestId);
        }
      }, [state.phase, state.error, state.runId]);
      var frozenRunSelection = ['needs-consent', 'ready', 'running', 'binding'].indexOf(state.phase) >= 0
        && authorization && authorization.executorSelection;
      var executorSelection = frozenRunSelection || state.executorSelection || authorization && authorization.executorSelection || null;
      var appBuilder = !!(executorSelection && executorSelection.presetId === 'app-builder');
      var codingMode = !!(executorSelection && executorSelection.presetId === 'coding');
      var researchMode = !!(executorSelection && executorSelection.presetId === 'research');
      var executeLabel = appBuilder ? '开始生成 / 修改 APP'
        : codingMode ? '开始 Coding · Home Node 限定写入'
          : researchMode ? '开始 Research · 只读'
            : '开始 General · 只读';
      var hasAppDraft = !!(state.draft && state.draft.files && state.draft.draftRef);
      var memory = authorization && authorization.memory || { records: [], selectedIds: [], selectedCount: 0, contextChars: 0 };
      var selectedMemoryIds = Array.isArray(memoryIds) ? memoryIds : [];
      var memorySelected = selectedMemoryIds.length > 0;
      function changeMemory(recordId, checked) {
        var next = selectedMemoryIds.slice().filter(function (id) { return id !== recordId; });
        if (checked) next.push(recordId);
        next.sort();
        setMemoryIds(next);
        parent.postMessage({ type: 'ib-dsh-p2-memory-selection', sessionId: sessionId,
          runId: authorization.runId, memoryIds: next }, WORK_MODE_PARENT_ORIGIN);
      }
      var auditScopeCard = state.phase === 'needs-consent' && authorization && !appBuilder ? React.createElement('section', { className: 'ib-work-run-consent' },
        React.createElement('strong', null, '本次 Home Node 授权预览'),
        React.createElement('p', null, '项目 · ' + String(authorization.projectRef || '') + ' · Run ' + String(authorization.runId || '')),
        executorSelection ? React.createElement('p', { 'data-executor-selection': executorSelection.presetId },
          '执行者 · ' + String(executorSelection.roleName || '标准 Agent') + ' · ' + String(executorSelection.presetLabel || executorSelection.presetId)
          + ' · 工具：' + (Array.isArray(executorSelection.allowedTools) && executorSelection.allowedTools.length
            ? executorSelection.allowedTools.join(', ') : '无项目工具')
          + ' · 只读次数上限：' + String(executorSelection.maxProjectReadCalls || 0)) : React.createElement('p', null, '执行者配置缺失；请返回选择角色/模型与预设。'),
        React.createElement('p', null, 'Agent Provider · ' + String(authorization.agent && authorization.agent.provider || '') + ' / ' + String(authorization.agent && authorization.agent.model || '') + ' · ' + String(authorization.agent && authorization.agent.endpointLabel || '')),
        React.createElement('p', null, 'Review Provider · ' + String(authorization.review && authorization.review.provider || '') + ' / ' + String(authorization.review && authorization.review.model || '') + ' · ' + String(authorization.review && authorization.review.endpointLabel || '')),
        React.createElement('p', null, '明确选择的文件：'),
        React.createElement('ul', null, ...(Array.isArray(authorization.files) ? authorization.files.map(function (file) {
          return React.createElement('li', { key: file.fileId }, String(file.path || '') + ' · ' + String(file.size || 0) + ' B');
        }) : [])),
        React.createElement('p', null, '当前项目的 Agent Memory Recall（仅本地只读预览；与 Chat Memory 隔离）：'),
        React.createElement('ul', null, ...(Array.isArray(memory.records) ? memory.records.map(function (record) {
          return React.createElement('li', { key: record.memoryId },
            React.createElement('label', null,
              React.createElement('input', { type: 'checkbox', checked: selectedMemoryIds.indexOf(record.memoryId) >= 0,
                onChange: function (event) { changeMemory(String(record.memoryId), event.target.checked); } }),
              String(record.type || 'Memory') + ' · r' + String(record.revision || 0) + ' · ' + String(record.summary || '')));
        }) : [])),
        React.createElement('p', null, '所选源文件与有界 Review 证据会发送到以上 Provider；'
          + (memorySelected ? '勾选的项目 Agent Memory 会作为不可信 Recall 参考发送给 Agent Provider。' : '未选择 Agent Memory。')
          + 'Result 将由 Home Node SQLite 保存明文，最多保留 90 天。'),
        memorySelected ? React.createElement('p', null, 'Memory Recall · ' + String(memory.selectedCount || selectedMemoryIds.length)
          + ' 条 · ' + String(memory.contextChars || 0) + ' 字符 · SHA-256 ' + String(memory.contextHash || '').slice(0, 12) + '…') : null,
        React.createElement('p', null, '有效期：15 分钟；完成、取消或过期后不能继续发送。'),
        React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: ackEgress, onChange: function (event) { setAckEgress(event.target.checked); } }),
          '我已核对项目、两个 Provider 和逐项文件，并授权本次外发。角色人格提示词与任务预设会发送给 Agent Provider。'),
        React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: ackStorage, onChange: function (event) { setAckStorage(event.target.checked); } }),
          '我已阅读并接受 Home Node Result 的本地明文保存与删除残留风险。'),
        memorySelected ? React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: ackMemory,
          onChange: function (event) { setAckMemory(event.target.checked); } }),
          '我单独授权将所选项目 Agent Memory Recall 发送给当前 Agent Provider。') : null,
        memorySelected ? React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: ackMemoryReview,
          onChange: function (event) { setAckMemoryReview(event.target.checked); } }),
          '我单独授权将可能包含 Memory 衍生内容的证据和报告发送给当前 Middle Brain Review Provider。') : null,
        memorySelected ? React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: ackMemoryResult,
          onChange: function (event) { setAckMemoryResult(event.target.checked); } }),
          '我单独授权将完整 memory-derived Result 明文保存到 Home Node SQLite。') : null,
        React.createElement('button', { type: 'button', disabled: !ackEgress || !ackStorage
          || (memorySelected && (!ackMemory || !ackMemoryReview || !ackMemoryResult)), onClick: function () {
          setState(function (previous) { return Object.assign({}, previous, { phase: 'binding', runId: state.runId,
            authorization: authorization, result: null, events: state.events, error: '' }); });
          parent.postMessage({ type: 'ib-dsh-p1-consent', sessionId: sessionId, runId: authorization.runId,
            previewKey: authorization.previewKey, expiresInMs: authorization.expiresInMs,
            fileIds: Array.isArray(authorization.files) ? authorization.files.map(function (file) { return String(file.fileId || ''); }) : [],
            memoryIds: selectedMemoryIds, ackMemory: ackMemory, ackMemoryReview: ackMemoryReview,
            ackMemoryResult: ackMemoryResult, ackEgress: ackEgress, ackStorage: ackStorage }, WORK_MODE_PARENT_ORIGIN);
        } }, '授予此范围的 Consent')) : null;
      var scopeCard = auditScopeCard;
      var permissionLauncher = state.phase === 'needs-consent' && authorization ? React.createElement('div', {
        className: 'ib-work-run-consent', 'data-dsh-permission-entry': 'true' },
        React.createElement('strong', null, 'DSH Permission 模式'),
        React.createElement('p', null, '权限动画可关闭或跳过；只有逐项确认后才会向 Home Node 请求 Consent。拒绝、取消或核验失败都不会启动本次 Run。'),
        React.createElement('button', { type: 'button', 'data-dsh-permission-reopen': 'true', onClick: openPermissionMode }, '打开权限请求'),
        permissionMessage ? React.createElement('p', { role: 'status' }, permissionMessage) : null) : null;
      var draftList = authorization && Array.isArray(authorization.appDrafts) ? authorization.appDrafts
        : (Array.isArray(state.drafts) ? state.drafts : []);
      var canContinueAppBuilder = appBuilder && (state.phase === 'needs-run'
        || (hasAppDraft && ['completed', 'failed', 'cancelled'].indexOf(state.phase) >= 0));
      var appBuilderEntry = canContinueAppBuilder ? React.createElement('section', {
        className: 'ib-app-builder-entry', 'data-app-builder-entry': 'true' },
        React.createElement('label', null, React.createElement('span', null, 'APP 草稿'),
          React.createElement('select', { 'aria-label': 'APP 草稿', 'data-app-draft-select': 'true', value: draftRef,
            onChange: function (event) { setDraftRef(event.target.value); } },
            React.createElement('option', { value: '' }, '新建 Todo App'),
            ...draftList.map(function (item) { return React.createElement('option', { key: item.draftRef, value: item.draftRef },
              String(item.name || 'Generated App') + ' · v' + String(item.version || 0)); }))),
        React.createElement('p', { role: 'status' }, hasAppDraft
          ? '在下方 DSH 输入框描述修改并按 Enter；每次任务都会创建新 Run 并重新请求权限。'
          : '在下方 DSH 输入框描述 APP 并按 Enter；Home Node 会创建并绑定 Run。')) : null;
      var artifact = state.draft && state.draft.files ? state.draft : null;
      var artifactChanges = artifact && artifact.runStatus === 'completed' && artifact.changes || {};
      var exportHistory = artifact && Array.isArray(artifact.history) ? artifact.history.slice().sort(function (a, b) {
        return Number(a && a.version || 0) - Number(b && b.version || 0);
      }) : [];
      var availableExportVersions = exportHistory.map(function (item) { return Number(item.version); })
        .filter(function (version) { return Number.isSafeInteger(version) && version > 0; });
      var selectedExportVersion = Number.isSafeInteger(exportVersion) && availableExportVersions.indexOf(exportVersion) >= 0
        ? exportVersion : Number(artifact && artifact.version || 0);
      var exportControls = artifact && availableExportVersions.length ? React.createElement('section', {
        className: 'ib-app-export-controls', 'data-app-export-controls': 'true',
        style: { display: 'grid', gap: '8px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
        React.createElement('h4', null, '导出独立版本'),
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, React.createElement('span', null, '选择已提交版本'),
          React.createElement('select', { 'aria-label': '导出版本', value: String(selectedExportVersion), disabled: exportPending,
            onChange: function (event) { setExportVersion(Number(event.target.value)); setExportStatus(''); } },
            ...exportHistory.map(function (item) { return React.createElement('option', { key: String(item.version), value: String(item.version) },
              'v' + String(item.version) + ' · ' + String(item.instruction || '已保存版本')); }))),
        React.createElement('div', { className: 'ib-app-export-actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          React.createElement('button', { type: 'button', disabled: exportPending, 'data-app-export-source': 'true', onClick: function () {
            setExportPending(true); setExportStatus('正在读取所选的已提交版本…');
            parent.postMessage({ type: 'ib-dsh-app-export-request', sessionId: sessionId, draftRef: artifact.draftRef,
              version: selectedExportVersion, kind: 'source-zip', requestId: 'app-export-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) }, WORK_MODE_PARENT_ORIGIN);
          } }, '导出源码 ZIP'),
          React.createElement('button', { type: 'button', disabled: exportPending, 'data-app-export-web': 'true', onClick: function () {
            setExportPending(true); setExportStatus('正在读取所选的已提交版本…');
            parent.postMessage({ type: 'ib-dsh-app-export-request', sessionId: sessionId, draftRef: artifact.draftRef,
              version: selectedExportVersion, kind: 'web-app', requestId: 'app-export-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) }, WORK_MODE_PARENT_ORIGIN);
          } }, '导出 Web APP')),
        React.createElement('p', { role: 'status', 'data-app-export-status': 'true' }, exportStatus || '导出只读取选定版本，不改变草稿、版本历史或已安装 APP。')) : null;
      var artifactPanel = artifact && ['completed', 'failed', 'cancelled'].indexOf(state.phase) >= 0 ? React.createElement('section', {
        className: 'ib-work-run-result', 'data-app-builder-artifact': artifact.draftRef },
        React.createElement('h3', null, String(artifact.name || 'Generated App') + ' · v' + String(artifact.version || 0)),
        React.createElement('p', null, '草稿与版本历史已保存在归墟；可继续提出修改，安装需另行确认。'),
        state.phase === 'failed' || state.phase === 'cancelled' ? React.createElement('p', { role: 'status' },
          state.phase === 'cancelled' ? '本次 Run 已取消，保留上一个已提交版本。'
            : '本次 Run 失败，候选修改已丢弃；以下仍是上一个已提交版本。') : null,
        React.createElement('details', { 'data-app-builder-details': 'true' },
        React.createElement('summary', null, '文件、差异、预览与安装'),
        React.createElement('h4', null, '生成文件'),
        React.createElement('ul', null, ...['index.html', 'styles.css', 'app.js'].map(function (name) {
          var content = artifact.files[name];
          return React.createElement('li', { key: name, 'data-app-file': name },
            React.createElement('details', null,
              React.createElement('summary', null, name + (typeof content === 'string' ? ' · ' + content.length + ' chars' : ' · missing')),
              typeof content === 'string' ? React.createElement('pre', { style: { maxHeight: '280px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, content) : null));
        })),
        React.createElement('h4', null, '本次修改差异'),
        React.createElement('div', null, ...(Object.keys(artifactChanges).length ? Object.keys(artifactChanges).map(function (name) {
          var change = artifactChanges[name] || { before: null, after: artifact.files[name] };
          var text = draftDiff(change.before, change.after);
          return React.createElement('details', { key: name, open: true, 'data-app-diff': name },
            React.createElement('summary', null, name), React.createElement('pre', { style: { maxHeight: '280px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, text));
        }) : [React.createElement('p', { key: 'no-change' }, '本次 Run 没有已提交文件变更。')])),
        React.createElement('h4', null, '版本历史'),
        React.createElement('ol', { 'data-app-version-history': 'true' }, ...((Array.isArray(artifact.history) ? artifact.history : []).slice().reverse().map(function (version) {
          var selected = restoreVersion === version.version;
          return React.createElement('li', { key: String(version.version) + ':' + String(version.runId || '') },
            React.createElement('span', null, 'v' + String(version.version) + ' · ' + String(version.instruction || '已保存版本')
              + ' · ' + (Array.isArray(version.changedPaths) ? version.changedPaths.join(', ') || '无文件变化' : '')),
            selected ? React.createElement('button', { type: 'button', 'data-app-restore-confirm': version.version, onClick: function () {
              setRestoreError('');
              parent.postMessage({ type: 'ib-dsh-app-version-restore-confirm', sessionId: sessionId,
                draftRef: artifact.draftRef, version: version.version, confirmed: true }, WORK_MODE_PARENT_ORIGIN);
            } }, '确认恢复 v' + String(version.version)) : React.createElement('button', { type: 'button', 'data-app-restore-version': version.version,
              onClick: function () { setRestoreVersion(version.version); setRestoreError(''); } }, '恢复此版本'));
        }))),
        exportControls,
        restoreError ? React.createElement('p', { role: 'alert' }, restoreError) : null,
        state.previewSrcdoc ? React.createElement('div', { 'data-app-preview': 'true' },
          React.createElement('h4', null, '隔离预览'),
          React.createElement('iframe', { ref: previewFrameRef, title: 'App Draft preview', sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', srcDoc: state.previewSrcdoc,
            style: { width: '100%', minHeight: '520px', border: '1px solid var(--border-color, #8899aa)', borderRadius: '12px', background: '#fff' } })) : null,
        React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: installAccepted,
          onChange: function (event) { setInstallAccepted(event.target.checked); } }),
          '我已查看生成文件、差异和隔离预览，确认将此版本安装到归墟 App Store。'),
        React.createElement('button', { type: 'button', disabled: !installAccepted || state.appInstalled,
          'data-app-install-confirm': 'true', onClick: function () {
            parent.postMessage({ type: 'ib-dsh-app-install-confirm', sessionId: sessionId, draftRef: artifact.draftRef,
              version: artifact.version, confirmed: true }, WORK_MODE_PARENT_ORIGIN);
          } }, state.appInstalled ? '已安装到 App Store' : '确认安装到 App Store'),
        state.installError ? React.createElement('p', { role: 'alert' }, state.installError) : null,
        state.installError ? React.createElement('span', { hidden: true }) : null)) : null;
      var runHistoryPanel = Array.isArray(state.history) && state.history.length ? React.createElement('section', {
        className: 'ib-work-run-history', 'data-work-run-history': 'true' },
        React.createElement('details', null,
        React.createElement('summary', null, '此会话的 Run 历史 · ' + String(state.history.length)),
        React.createElement('ol', null, ...state.history.map(function (item) {
          var statusLabel = { completed: '已完成', failed: '失败', cancelled: '已取消', running: '执行中', cancel_requested: '正在取消', queued: '等待授权' };
          return React.createElement('li', { key: item.runId }, String(statusLabel[item.status] || item.status) + ' · '
            + (item.draftVersion == null ? '' : 'APP v' + String(item.draftVersion) + ' · ')
            + String(item.summary || item.workflowId || '工作结果'));
        })))) : null;
      var detailsPanel = panelOpen ? React.createElement('section', { className: 'ib-work-run-details', 'data-work-run-details': 'true' },
        React.createElement('div', { className: 'ib-work-run-heading' },
          React.createElement('strong', null, appBuilder ? 'APP 草稿与结果' : '工作结果'),
          React.createElement('button', { type: 'button', 'data-work-mode-close': 'true', onClick: function () { setPanelOpen(false); } }, '收起')),
        state.phase === 'checking' ? null : state.phase === 'completed' && report
          ? React.createElement('article', { className: 'ib-work-run-result' },
            React.createElement('p', null, String(report.summary || '')),
            ...(Array.isArray(report.findings) ? report.findings.map(function (finding, index) {
              return React.createElement('div', { key: String(index), className: 'ib-work-run-finding' },
                React.createElement('strong', null, String(finding.severity || '').toUpperCase() + ' · ' + String(finding.title || '')),
                React.createElement('p', null, String(finding.path || '') + (finding.line ? ':' + String(finding.line) : '')),
                React.createElement('p', null, String(finding.detail || '')));
            }) : []))
          : React.createElement('div', { className: 'ib-work-run-events' }, state.events.slice(-8).map(function (item, index) {
            return React.createElement('div', { key: String(item.sequence || index) },
              String(item.event || 'run-event') + (item.path ? ' · ' + String(item.path) : '') + (item.code ? ' · ' + String(item.code) : ''));
          })),
        appBuilderEntry,
        artifactPanel,
        runHistoryPanel,
        permissionLauncher,
        state.error ? React.createElement('p', { role: 'alert' }, state.error) : null,
        scopeCard,
        state.phase === 'needs-run' && !appBuilder ? React.createElement('button', { type: 'button', onClick: function () {
          parent.postMessage({ type: 'ib-dsh-p3-create-run', sessionId: sessionId }, WORK_MODE_PARENT_ORIGIN);
        } }, '创建 Home Node Run 并绑定此 Session') : null,
        state.phase === 'needs-binding' ? React.createElement('button', { type: 'button', onClick: function () {
          setState(function (previous) { return Object.assign({}, previous, { phase: 'binding', runId: '', result: null, events: [], error: '' }); });
          parent.postMessage({ type: 'ib-dsh-p1-bind', sessionId: sessionId }, WORK_MODE_PARENT_ORIGIN);
        } }, '绑定到当前 Home Node Run') : null,
        state.phase === 'ready' ? React.createElement('button', { type: 'button', onClick: function () {
          setState(function (previous) { return Object.assign({}, previous, { phase: 'binding', runId: '', result: null, events: [], error: '' }); });
          parent.postMessage({ type: 'ib-dsh-p1-execute', sessionId: sessionId }, WORK_MODE_PARENT_ORIGIN);
        } }, executeLabel) : null) : null;
      var phaseLabels = { 'needs-consent': '等待权限', ready: '已授权', running: '执行中', completed: '已完成',
        cancelled: '已取消', failed: '未完成', error: '需要处理' };
      var showRunStatus = !!(state.runId && phaseLabels[state.phase] && state.phase !== 'checking');
      if (!panelOpen && !showRunStatus) return null;
      return React.createElement('section', { className: 'ib-work-run-session', 'data-work-run-phase': state.phase,
        'data-dsh-session-id': sessionId, 'data-run-id': state.runId || '', 'data-work-details-open': panelOpen ? 'true' : 'false' },
        showRunStatus ? React.createElement('div', { className: 'ib-dsh-work-entry' },
          React.createElement('span', { role: 'status', 'data-work-native-status': state.phase }, phaseLabels[state.phase],
            appBuilder && artifact ? ' · ' + String(artifact.name || 'APP 草稿') + ' v' + String(artifact.version || 0) : ''),
          state.phase === 'running' ? React.createElement('button', { type: 'button', 'data-work-run-cancel': 'true', onClick: function () {
            parent.postMessage({ type: 'ib-dsh-p1-cancel', sessionId: sessionId }, WORK_MODE_PARENT_ORIGIN);
          } }, '取消') : null) : null,
        panelOpen ? detailsPanel : null);
    }
    return {
      inject: ['theme', 'slots', 'uiConversation', 'sessions'],
      apply: function (ctx) {
        var parentOrigin = WORK_MODE_PARENT_ORIGIN;
        ctx.effect(function () { return registerWorkModeTrajectory(ctx); }, 'native work mode trajectory projection');
        var presetByNativeId = { 'synthetic-p0': 'general', general: 'general', coding: 'coding', research: 'research', 'app-builder': 'app-builder' };
        var lastPresetSignature = '';
        var presetSyncTimer = 0;
        function syncActiveAgentPreset() {
          var active = document.querySelector('[data-conversation-session]');
          var sessionId = active && String(active.getAttribute('data-conversation-session') || '');
          if (!sessionId) return;
          var snapshot = ctx.sessions.list.getSnapshot();
          var session = snapshot && snapshot.byId && snapshot.byId[sessionId];
          var projection = session && session.projectionValues || {};
          var nativePresetId = String(projection.agentPreset || 'general');
          var presetId = presetByNativeId[nativePresetId] || 'general';
          var signature = sessionId + ':' + nativePresetId;
          if (signature === lastPresetSignature) return;
          lastPresetSignature = signature;
          var detail = { sessionId: sessionId, nativePresetId: nativePresetId, presetId: presetId };
          window.__IB_DSH_AGENT_PRESET__ = detail;
          try { window.dispatchEvent(new CustomEvent('ib-dsh-agent-preset-state', { detail: detail })); } catch (_) {}
          parent.postMessage(Object.assign({ type: 'ib-dsh-p3-agent-preset-state' }, detail), parentOrigin);
        }
        function syncHostOwnedThemeRow() {
          var dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return;
          var labels = ['浅色', '深色', '跟随系统', 'Light', 'Dark', 'Follow system'];
          var controls = Array.prototype.filter.call(dialog.querySelectorAll('button'), function (button) {
            return labels.indexOf(String(button.innerText || '').trim()) >= 0;
          });
          if (controls.length < 3) return;
          var title = Array.prototype.find.call(dialog.querySelectorAll('*'), function (node) {
            return node.children.length === 0 && ['外观', 'Appearance'].indexOf(String(node.textContent || '').trim()) >= 0;
          });
          var group = title && title.parentElement;
          if (group) group.setAttribute('data-ib-host-theme-row', 'true');
        }
        ctx.effect(function () {
          var disposed = false;
          function schedule() {
            if (presetSyncTimer) return;
            presetSyncTimer = window.setTimeout(function () {
              presetSyncTimer = 0;
              if (!disposed) syncActiveAgentPreset();
            }, 0);
          }
          var stopList = ctx.sessions.list.subscribe(schedule);
          var observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-conversation-session'] });
          schedule();
          return function () {
            disposed = true;
            if (presetSyncTimer) { window.clearTimeout(presetSyncTimer); presetSyncTimer = 0; }
            observer.disconnect();
            if (typeof stopList === 'function') stopList();
          };
        }, 'native Agent preset to Home Node Work Mode bridge');
        ctx.effect(function () {
          var disposed = false;
          var timer = 0;
          function schedule() {
            if (timer) return;
            timer = window.setTimeout(function () { timer = 0; if (!disposed) syncHostOwnedThemeRow(); }, 0);
          }
          var observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true });
          schedule();
          return function () {
            disposed = true;
            if (timer) { window.clearTimeout(timer); timer = 0; }
            observer.disconnect();
          };
        }, 'DSH appearance setting follows InternalBeyond theme');
        var readySent = false;
        function receive(event) {
          if (event.source !== parent || !isTrustedWorkModeParentOrigin(event.origin)) return;
          parentOrigin = event.origin;
          WORK_MODE_PARENT_ORIGIN = event.origin;
          var value = event.data;
          if (!value || value.type !== 'ib-dsh-p0-theme' || (value.theme !== 'light' && value.theme !== 'dark')) return;
          ctx.theme.setTheme(value.theme);
          window.__DSH_STARTUP_THEME__ = value.theme;
          var startupPermission = window.__DSH_STARTUP_PERMISSION__;
          if (startupPermission && typeof startupPermission.setTheme === 'function') startupPermission.setTheme(value.theme);
          var startupRoot = document.getElementById('dsh-startup-root');
          if (startupRoot) startupRoot.classList.toggle('dsu-dark', value.theme === 'dark');
          // 归墟侧每次主题同步都附带当前已解析的 token 数值；原样 setProperty 到
          // 自己的 document 上，--dsw-alias-* 因此和归墟宿主的明暗主题保持一致，
          // 不需要在这里维护一份独立的浅/暗色映射表。DSH 自己的样式表在 body（以及
          // body[data-ds-dark-theme]）上重新声明了这些变量，内联样式必须同样落在
          // body 上才能覆盖——落在 html 上会被 body 自身的声明盖掉。
          if (value.tokens && typeof value.tokens === 'object') {
            Object.keys(value.tokens).forEach(function (name) {
              if (/^--dsw-alias-[a-z0-9-]+$/.test(name)) {
                document.body.style.setProperty(name, String(value.tokens[name]));
              }
            });
          }
          parent.postMessage({ type: 'ib-dsh-p0-theme-applied', theme: value.theme }, parentOrigin);
          if (!readySent) {
            parent.postMessage({ type: 'ib-dsh-p0-ready' }, parentOrigin);
            readySent = true;
          }
        }
        ctx.effect(function () {
          addEventListener('message', receive);
          function onComposerKeydown(event) {
            var route = window.__IB_DSH_APP_BUILDER_COMPOSER__;
            if (!isWorkTaskRoute(route) || event.key !== 'Enter' || event.shiftKey
              || event.isComposing || event.keyCode === 229 || !(event.target instanceof Element)) return;
            var editor = nativeComposer(route.sessionId);
            if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
            event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
            submitWorkModeTask(route);
          }
          function onComposerClick(event) {
            var route = window.__IB_DSH_APP_BUILDER_COMPOSER__;
            if (!isWorkTaskRoute(route) || !(event.target instanceof Element)) return;
            var button = event.target.closest('button');
            var editor = nativeComposer(route.sessionId);
            if (!editor || !button || !isNativeSendButton(button)
              || !button.closest('[data-composer-card]') || !button.closest('[data-conversation-session="' + String(route.sessionId).replace(/[^A-Za-z0-9_-]/g, '') + '"]')) return;
            event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
            submitWorkModeTask(route);
          }
          if (!isTrustedWorkModeParentOrigin(parentOrigin)
            && isTrustedWorkModeParentOrigin(WORK_MODE_PARENT_ORIGIN)) {
            parentOrigin = WORK_MODE_PARENT_ORIGIN;
          }
          if (isTrustedWorkModeParentOrigin(parentOrigin)) {
            parent.postMessage({ type: 'ib-dsh-p0-ready' }, parentOrigin);
            readySent = true;
          }
          document.addEventListener('keydown', onComposerKeydown, true);
          document.addEventListener('click', onComposerClick, true);
          return function () {
            removeEventListener('message', receive);
            document.removeEventListener('keydown', onComposerKeydown, true);
            document.removeEventListener('click', onComposerClick, true);
          };
        });
        ctx.slots.inject('conversation.input.dock', function () { return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'ib-home-node-work-run',
          order: -20,
        }, WorkRunComposer); });
        ctx.slots.inject('conversation.input.model', function () { return ctx.slots.register({
          name: 'conversation.input.model',
          id: 'ib-home-node-executor-selector',
          priority: -100,
          inject: function (sessionId) { return { sessionId: sessionId }; },
        }, WorkExecutorSelector); });
        ctx.slots.inject('sidebar.brand.mark', function () { return ctx.slots.register({
          name: 'sidebar.brand.mark', id: 'internalbeyond-brand-mark', priority: 100,
        }, ibBrandMark); });
        ctx.slots.inject('sidebar.brand.name', function () { return ctx.slots.register({
          name: 'sidebar.brand.name', id: 'internalbeyond-brand-name', priority: 100,
        }, function () { return React.createElement('span', { className: 'ib-dsh-brand-name' }, '归墟'); }); });
        ctx.slots.inject('conversation.hero.brand.mark', function () { return ctx.slots.register({
          name: 'conversation.hero.brand.mark', id: 'internalbeyond-hero-brand-mark', priority: 100,
        }, ibBrandMark); });
        ctx.slots.inject('sidebar.workspaces.session.menu.item', function () { return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: 'internalbeyond-work-record', order: 350,
        }, WorkRecordSessionMenuItem); });
        ctx.slots.inject('settings.section', function () { return ctx.slots.register({
          name: 'settings.section', id: 'internalbeyond-about', order: 1000, label: '关于 / 开源许可',
        }, LostBeyondAbout); });
        ctx.slots.inject('settings.general.item', function () { return ctx.slots.register({
          name: 'settings.general.item', id: 'ib-theme-follows-host', order: 10, priority: 100,
        }, ThemeFollowSettingsRow); });
        ctx.slots.inject('settings.general.item', function () { return ctx.slots.register({
          name: 'settings.general.item', id: 'developer-tools', order: 15, priority: 100,
        }, function () { return null; }); });
        document.title = '归墟 · The Lost Beyond';
      }
    };
  }
});
