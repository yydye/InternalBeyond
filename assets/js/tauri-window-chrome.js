(function () {
  'use strict';

  const windowApi = window.__TAURI__ && window.__TAURI__.window;
  if (!windowApi || typeof windowApi.getCurrentWindow !== 'function') return;

  const navbar = document.getElementById('navbar');
  const navBrand = navbar && navbar.querySelector('.nav-brand');
  const navLinks = navbar && navbar.querySelector('.nav-links');
  const navActions = navbar && navbar.querySelector('.nav-actions');
  if (!navbar || !navBrand || !navLinks || !navActions) return;

  const appWindow = windowApi.getCurrentWindow();
  const titlebar = document.createElement('div');
  titlebar.id = 'ib-tauri-titlebar';
  titlebar.className = 'ib-tauri-titlebar';
  titlebar.setAttribute('data-tauri-drag-region', '');
  titlebar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(titlebar);

  const controls = document.createElement('div');
  controls.className = 'ib-window-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '窗口控件');
  const controlsSlot = document.createElement('span');
  controlsSlot.className = 'ib-window-controls-slot';
  controlsSlot.setAttribute('aria-hidden', 'true');
  titlebar.appendChild(controlsSlot);

  const dragRegion = document.createElement('span');
  dragRegion.id = 'ib-tauri-drag-region';
  dragRegion.setAttribute('aria-hidden', 'true');
  document.body.appendChild(dragRegion);

  function createButton(action, label, svg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ib-window-control';
    button.dataset.windowAction = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = svg;
    controls.appendChild(button);
    return button;
  }

  const minimizeButton = createButton(
    'minimize',
    '最小化窗口',
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.5h10"/></svg>'
  );
  const maximizeButton = createButton(
    'maximize',
    '最大化窗口',
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1"/></svg>'
  );
  const closeButton = createButton(
    'close',
    '关闭窗口',
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
  );
  document.body.appendChild(controls);

  function positionDragRegion() {
    /* The sidebar is fully interactive. Only the empty titlebar strip over the
       workspace starts native window dragging; the control slot stays outside it. */
    const titlebarRect = titlebar.getBoundingClientRect();
    const slotRect = controlsSlot.getBoundingClientRect();
    const leftEdge = titlebarRect.left;
    const width = slotRect.left - titlebarRect.left - 2;
    if (width < 4) {
      dragRegion.style.width = '0px';
      dragRegion.style.pointerEvents = 'none';
      return;
    }
    dragRegion.style.left = `${leftEdge + 1}px`;
    dragRegion.style.top = `${titlebarRect.top}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${titlebarRect.height}px`;
    dragRegion.style.pointerEvents = 'auto';
  }

  function positionWindowControls() {
    const slotRect = controlsSlot.getBoundingClientRect();
    controls.style.left = `${slotRect.left}px`;
    controls.style.top = `${slotRect.top + Math.max(0, (slotRect.height - controls.offsetHeight) / 2)}px`;
  }

  function reportWindowError(error) {
    console.error('[IB window chrome]', error);
  }

  async function syncMaximizeButton() {
    try {
      const maximized = await appWindow.isMaximized();
      const label = maximized ? '还原窗口' : '最大化窗口';
      maximizeButton.setAttribute('aria-label', label);
      maximizeButton.title = label;
      maximizeButton.innerHTML = maximized
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.25h7.25v7.25"/><rect x="3.25" y="5.5" width="7.5" height="7.25" rx="1"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1"/></svg>';
    } catch (error) {
      reportWindowError(error);
    }
  }

  function bindWindowAction(button, action, updateMaximize) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve()
        .then(action)
        .then(() => updateMaximize && syncMaximizeButton())
        .catch(reportWindowError);
    });
  }

  bindWindowAction(minimizeButton, () => appWindow.minimize(), false);
  bindWindowAction(maximizeButton, () => appWindow.toggleMaximize(), true);
  bindWindowAction(closeButton, () => appWindow.close(), false);

  dragRegion.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.buttons !== 1) return;
    if (event.detail === 2) {
      event.preventDefault();
      appWindow.toggleMaximize().then(syncMaximizeButton).catch(reportWindowError);
      return;
    }
    appWindow.startDragging().catch(reportWindowError);
  });

  let resizeSyncTimer = 0;
  appWindow.onResized(() => {
    window.clearTimeout(resizeSyncTimer);
    resizeSyncTimer = window.setTimeout(syncMaximizeButton, 100);
  }).catch(reportWindowError);

  const resizeObserver = new ResizeObserver(() => {
    positionDragRegion();
    positionWindowControls();
  });
  resizeObserver.observe(navbar);
  resizeObserver.observe(titlebar);
  resizeObserver.observe(controlsSlot);
  Array.from(navbar.children).forEach((child) => {
    if (child !== dragRegion) resizeObserver.observe(child);
  });
  const mutationObserver = new MutationObserver(() => {
    if (controlsSlot.parentElement !== titlebar || titlebar.lastElementChild !== controlsSlot) {
      titlebar.appendChild(controlsSlot);
    }
    Array.from(navbar.children).forEach((child) => {
      if (child !== dragRegion) resizeObserver.observe(child);
    });
    window.requestAnimationFrame(() => {
      positionDragRegion();
      positionWindowControls();
    });
  });
  mutationObserver.observe(navbar, { childList: true, subtree: true, characterData: true });

  window.addEventListener('resize', () => {
    positionDragRegion();
    positionWindowControls();
  });
  window.addEventListener('ib:navigation-layout-change', () => {
    window.requestAnimationFrame(() => {
      positionDragRegion();
      positionWindowControls();
    });
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
    positionDragRegion();
    positionWindowControls();
  });
  window.requestAnimationFrame(() => {
    positionDragRegion();
    positionWindowControls();
  });
  syncMaximizeButton();
})();
