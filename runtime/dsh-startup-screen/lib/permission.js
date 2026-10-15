/* Task Permission mode for the DSH startup screen. The only authority is the
 * embedding Home Node Work UI; this module only renders a request and returns
 * the user's explicit choice. It never persists Consent or starts a Run. */
(function () {
  'use strict'

  if (window.__DSH_STARTUP_PERMISSION__) return

  var ROOT_ID = 'dsh-startup-permission'
  var active = null
  var theme = window.__DSH_STARTUP_THEME__ === 'dark' ? 'dark' : 'light'
  var decisionHandlers = new Map()

  function text(value, limit) {
    return String(value == null ? '' : value).slice(0, limit || 500)
  }

  function node(tag, cls, value) {
    var item = document.createElement(tag)
    if (cls) item.className = cls
    if (value != null) item.textContent = value
    return item
  }

  function appendList(parent, values) {
    var list = node('ul', 'dsu-permission-list')
    ;(Array.isArray(values) ? values : []).slice(0, 20).forEach(function (value) {
      var item = node('li', '', text(value, 500))
      list.appendChild(item)
    })
    if (!list.childNodes.length) list.appendChild(node('li', '', '未提供'))
    parent.appendChild(list)
  }

  function dispatch(action, acknowledgements) {
    if (!active || active.submitted) return
    if (action === 'confirm') {
      var accepted = {}
      var valid = active.acknowledgements.every(function (item) {
        var input = active.root.querySelector('[data-dsu-ack="' + item.key + '"]')
        accepted[item.key] = !!(input && input.checked)
        return accepted[item.key]
      })
      if (!valid) {
        active.status.textContent = '请逐项确认上方的授权与风险说明。'
        return
      }
      active.submitted = true
      active.status.textContent = '已收到你的确认，正在请求 Home Node 核验…'
      active.actions.replaceChildren(node('span', 'dsu-permission-pending', 'Home Node 核验中…'))
      action = 'confirm'
      acknowledgements = accepted
    } else if (action === 'deny' || action === 'cancel') {
      active.submitted = true
      active.status.textContent = action === 'deny'
        ? '你已拒绝本次请求；未创建 Consent，也未启动 Run。'
        : '本次请求已取消；未创建 Consent，也未启动 Run。'
      active.actions.replaceChildren()
      addReturnButton(active)
    }
    var detail = { requestId: active.requestId, sessionId: active.sessionId, runId: active.runId,
      previewKey: active.previewKey, action: action, acknowledgements: acknowledgements || {} }
    try {
      var decisionHandler = decisionHandlers.get(active.requestId)
      if (typeof decisionHandler === 'function') decisionHandler(detail)
      window.dispatchEvent(new CustomEvent('dsh-startup:permission-decision', { detail: detail }))
    } catch (error) {
      if (active && active.status) active.status.textContent = '归墟权限桥接失败；没有创建 Consent。'
    }
  }

  function addReturnButton(record) {
    var button = node('button', 'dsu-permission-button dsu-permission-secondary', '返回任务界面')
    button.type = 'button'
    button.addEventListener('click', function () { closePermission(record.requestId) })
    record.actions.appendChild(button)
  }

  function build(request) {
    var old = document.getElementById(ROOT_ID)
    if (old && old.parentNode) old.parentNode.removeChild(old)
    var root = node('div', 'dsu-permission-root')
    root.id = ROOT_ID
    root.dataset.theme = theme
    var dialog = node('section', 'dsu-permission-dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'dsu-permission-title')
    dialog.setAttribute('data-permission-phase', 'request')

    var header = node('header', 'dsu-permission-header')
    var brand = node('div', 'dsu-permission-brand')
    brand.appendChild(node('span', 'dsu-permission-mark', '归'))
    brand.appendChild(node('span', '', '归墟 · HOME NODE'))
    header.appendChild(brand)
    header.appendChild(node('span', 'dsu-permission-code', 'TASK PERMISSION'))
    dialog.appendChild(header)

    var progress = node('ol', 'dsu-permission-progress')
    ;['请求已接收', '范围与风险', '用户确认', 'Host 核验'].forEach(function (label, index) {
      var step = node('li', index < 2 ? 'is-current' : '', label)
      step.dataset.step = String(index + 1)
      progress.appendChild(step)
    })
    dialog.appendChild(progress)

    var title = node('h1', 'dsu-permission-title', text(request.title || '任务权限请求', 100))
    title.id = 'dsu-permission-title'
    dialog.appendChild(title)
    dialog.appendChild(node('p', 'dsu-permission-summary', text(request.summary || '请检查本次 Run 的模型、操作范围和存储风险。', 500)))

    var modelCard = node('div', 'dsu-permission-model')
    modelCard.appendChild(node('span', 'dsu-permission-label', '本次模型'))
    modelCard.appendChild(node('strong', '', text(request.model || '不可用', 200)))
    dialog.appendChild(modelCard)

    var columns = node('div', 'dsu-permission-columns')
    var scope = node('section', 'dsu-permission-section')
    scope.appendChild(node('h2', '', '操作范围'))
    appendList(scope, request.scope)
    var risks = node('section', 'dsu-permission-section')
    risks.appendChild(node('h2', '', '存储与发送风险'))
    appendList(risks, request.risks)
    columns.appendChild(scope)
    columns.appendChild(risks)
    dialog.appendChild(columns)

    var details = node('details', 'dsu-permission-details')
    details.appendChild(node('summary', '', '展开技术细节'))
    appendList(details, request.details)
    dialog.appendChild(details)

    var acknowledgements = Array.isArray(request.acknowledgements) ? request.acknowledgements.slice(0, 8) : []
    var checks = node('fieldset', 'dsu-permission-checks')
    checks.appendChild(node('legend', '', '请明确确认以下事项'))
    acknowledgements.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return
      var key = text(raw.key, 64)
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) return
      var label = node('label', 'dsu-permission-check')
      var input = node('input')
      input.type = 'checkbox'
      input.dataset.dsuAck = key
      input.setAttribute('aria-label', text(raw.label, 240))
      label.appendChild(input)
      label.appendChild(node('span', '', text(raw.label, 240)))
      checks.appendChild(label)
    })
    if (checks.querySelectorAll('input[type="checkbox"]').length) dialog.appendChild(checks)

    var status = node('p', 'dsu-permission-status', '确认后，Home Node 会重新核对 Run、Provider 路由、范围与 Consent 条款。')
    status.setAttribute('role', 'status')
    dialog.appendChild(status)
    var actions = node('div', 'dsu-permission-actions')
    var confirm = node('button', 'dsu-permission-button dsu-permission-primary', '确认并请求 Host 核验')
    confirm.type = 'button'
    confirm.disabled = !acknowledgements.length || !checks.querySelectorAll('input[type="checkbox"]').length
    confirm.addEventListener('click', function () { dispatch('confirm') })
    var deny = node('button', 'dsu-permission-button dsu-permission-danger', '拒绝')
    deny.type = 'button'
    deny.addEventListener('click', function () { dispatch('deny') })
    var cancel = node('button', 'dsu-permission-button dsu-permission-secondary', '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', function () { dispatch('cancel') })
    actions.appendChild(confirm)
    actions.appendChild(deny)
    actions.appendChild(cancel)
    dialog.appendChild(actions)

    root.appendChild(dialog)
    document.body.appendChild(root)
    return { root: root, dialog: dialog, status: status, actions: actions,
      acknowledgements: acknowledgements.filter(function (item) { return item && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(text(item.key, 64)) }),
      confirm: confirm, submitted: false }
  }

  function requestPermission(request) {
    if (!request || typeof request !== 'object') return false
    var requestId = text(request.requestId, 160)
    var sessionId = text(request.sessionId, 80)
    var runId = text(request.runId, 100)
    if (!requestId || !sessionId || !runId) return false
    if (active && active.requestId !== requestId) decisionHandlers.delete(active.requestId)
    var model = build(request)
    model.requestId = requestId
    model.sessionId = sessionId
    model.runId = runId
    model.previewKey = text(request.previewKey, 4096)
    active = model
    model.dialog.dataset.permissionBridge = decisionHandlers.has(requestId) ? 'ready' : 'pending'
    model.confirm.focus()
    return true
  }

  function updatePermission(requestId, update) {
    if (!active || active.requestId !== text(requestId, 160) || !update) return false
    var status = text(update.status, 32)
    var message = text(update.message, 500)
    var labels = {
      verifying: '正在由 Home Node 核验当前 Run、Provider 路由和 Consent…',
      verified: 'Home Node 已核验并绑定本次 Consent。执行仍由 Host 在每次调用时再次检查。',
      running: 'Home Node 已通过权限检查，正在执行本次 Run。',
      completed: 'Run 已完成，Result 已由 Home Node 保存。',
      failed: 'Host 核验未通过；Consent 未用于执行。',
      cancelled: 'Run 已取消；没有通过启动动画授予权限。'
    }
    active.dialog.dataset.permissionPhase = status
    active.status.textContent = message || labels[status] || '请返回任务界面检查当前 Run。'
    var steps = active.dialog.querySelectorAll('.dsu-permission-progress li')
    for (var i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('is-current', (status === 'verifying' && i === 3)
        || (status === 'verified' && i === 3) || (status === 'running' && i === 3)
        || (status === 'completed' && i === 3) || ((status === 'failed' || status === 'cancelled') && i === 3))
      steps[i].classList.toggle('is-complete', (status === 'verified' || status === 'running' || status === 'completed') && i < 4)
      steps[i].classList.toggle('is-error', (status === 'failed' || status === 'cancelled') && i === 3)
    }
    if (status === 'verified' || status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled') {
      active.actions.replaceChildren()
      addReturnButton(active)
    }
    try {
      window.dispatchEvent(new CustomEvent('dsh-startup:permission-status', {
        detail: { requestId: active.requestId, status: status, message: active.status.textContent }
      }))
    } catch (_) { /* status observers are optional */ }
    return true
  }

  function closePermission(requestId) {
    if (!active || (requestId && active.requestId !== text(requestId, 160))) return false
    decisionHandlers.delete(active.requestId)
    if (active.root && active.root.parentNode) active.root.parentNode.removeChild(active.root)
    active = null
    return true
  }

  function setTheme(value) {
    if (value !== 'light' && value !== 'dark') return false
    theme = value
    var root = document.getElementById(ROOT_ID)
    if (root) root.dataset.theme = value
    var splash = document.getElementById('dsh-startup-root')
    if (splash) splash.classList.toggle('dsu-dark', value === 'dark')
    return true
  }

  function setDecisionHandler(requestId, handler) {
    var id = text(requestId, 160)
    if (!id) return function () {}
    if (typeof handler === 'function') decisionHandlers.set(id, handler)
    else decisionHandlers.delete(id)
    if (active && active.requestId === id) active.dialog.dataset.permissionBridge = decisionHandlers.has(id) ? 'ready' : 'pending'
    return function () { if (decisionHandlers.get(id) === handler) decisionHandlers.delete(id) }
  }

  function hasDecisionHandler(requestId) {
    return requestId == null ? decisionHandlers.size > 0 : decisionHandlers.has(text(requestId, 160))
  }

  document.addEventListener('keydown', function (event) {
    if (!active || event.key !== 'Escape') return
    if (!active.submitted) dispatch('cancel')
  })

  window.__DSH_STARTUP_PERMISSION__ = Object.freeze({
    requestPermission: requestPermission,
    updatePermission: updatePermission,
    closePermission: closePermission,
    setTheme: setTheme,
    setDecisionHandler: setDecisionHandler,
    hasDecisionHandler: hasDecisionHandler
  })
})()
