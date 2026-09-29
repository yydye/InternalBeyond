'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.IBHomeWorkspace = api;
  api.mount(root.document, root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const MAX_SCAN_RECORDS = 24;
  const MAX_RECENT_ITEMS = 4;
  const ROUTES = Object.freeze({
    chat: 'chat', memory: 'memory', blog: 'blog', active: 'active',
    apps: 'apps', packaging: 'packaging', api: 'api'
  });

  function safeLabel(value, fallback) {
    const label = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return label || fallback;
  }

  function timestampOf(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  function projectThread(record) {
    if (!record || typeof record !== 'object') return null;
    return {
      title: safeLabel(record.name, 'Conversation'),
      type: 'Conversation',
      timestamp: timestampOf(record.created)
    };
  }

  function projectActivity(record) {
    if (!record || typeof record !== 'object') return null;
    const kind = safeLabel(record.kind || record.type, 'Activity');
    return {
      title: safeLabel(record.title, kind === 'coread' ? 'Shared reading' : 'Activity'),
      type: kind === 'coread' ? 'Reading' : (kind === 'watch' ? 'Cinema' : 'Activity'),
      timestamp: timestampOf(record.updatedAt || record.lastActiveAt || record.createdAt)
    };
  }

  function combineRecent(threads, activities, limit) {
    return (Array.isArray(threads) ? threads : [])
      .concat(Array.isArray(activities) ? activities : [])
      .filter(function (item) { return item && typeof item.title === 'string'; })
      .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); })
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : MAX_RECENT_ITEMS);
  }

  function formatRelativeTime(timestamp, now) {
    const value = timestampOf(timestamp);
    if (!value) return 'Time unavailable';
    const elapsed = Math.max(0, (Number(now) || Date.now()) - value);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' hr ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function scanProjection(win, store, projector) {
    if (!win || typeof win.dbScan !== 'function') throw new Error('LOCAL_SCAN_UNAVAILABLE');
    const rows = [];
    await win.dbScan(store, function (record) {
      const item = projector(record);
      if (item) rows.push(item);
      return true;
    }, { direction: 'prev', maxRecords: MAX_SCAN_RECORDS });
    return rows;
  }

  async function readPackagingAvailability(win) {
    const center = win && win.IB && win.IB.packagingCenter;
    if (!center || typeof center.createClient !== 'function') throw new Error('PACKAGING_STATUS_UNAVAILABLE');
    const result = await center.createClient().jobs();
    if (!result || result.ok !== true || typeof result.available !== 'boolean') {
      throw new Error('PACKAGING_STATUS_UNAVAILABLE');
    }
    return result.available;
  }

  function readMemoryCount(win) {
    if (!win || typeof win._ibCount !== 'function') return Promise.reject(new Error('MEMORY_COUNT_UNAVAILABLE'));
    return Promise.resolve(win._ibCount('memories')).then(function (count) {
      if (!Number.isFinite(Number(count)) || Number(count) < 0) throw new Error('MEMORY_COUNT_UNAVAILABLE');
      return Math.floor(Number(count));
    });
  }

  function greetingFor(hour) {
    const h = Number(hour);
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 18) return 'Good afternoon';
    if (h >= 18 && h < 22) return 'Good evening';
    return 'Welcome back';
  }

  function makeElement(document, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function renderRecent(document, list, items, isReady) {
    list.replaceChildren();
    if (!items.length) {
      list.hidden = !isReady;
      return;
    }
    list.hidden = false;
    items.forEach(function (item) {
      const row = makeElement(document, 'li', 'home-recent-item');
      const marker = makeElement(document, 'span', 'home-recent-marker', '·');
      marker.setAttribute('aria-hidden', 'true');
      const content = makeElement(document, 'div', 'home-recent-content');
      content.appendChild(makeElement(document, 'strong', 'home-recent-title', item.title));
      const meta = makeElement(document, 'div', 'home-recent-meta');
      meta.appendChild(makeElement(document, 'span', 'home-recent-type', item.type));
      meta.appendChild(makeElement(document, 'time', 'home-recent-time', formatRelativeTime(item.timestamp)));
      content.appendChild(meta);
      row.appendChild(marker);
      row.appendChild(content);
      list.appendChild(row);
    });
  }

  function setStatus(document, id, label, state) {
    const item = document.getElementById(id);
    if (!item) return;
    item.dataset.state = state;
    const value = item.querySelector('.workspace-status-value');
    if (value) value.textContent = label;
  }

  function mount(document, win) {
    const page = document && document.getElementById('page-workspace');
    const workspace = document && document.getElementById('workspace-dashboard');
    if (!page || !workspace || workspace.__workspaceDashboardMounted) return null;
    workspace.__workspaceDashboardMounted = true;

    const list = document.getElementById('workspace-recent-list');
    const empty = document.getElementById('workspace-empty-state');
    const notice = document.getElementById('workspace-data-notice');

    workspace.addEventListener('click', function (event) {
      const link = event.target && event.target.closest ? event.target.closest('[data-workspace-route]') : null;
      if (!link || !workspace.contains(link)) return;
      event.preventDefault();
      const route = ROUTES[link.dataset.workspaceRoute];
      if (!route || !document.getElementById('page-' + route) || typeof win.navTo !== 'function') return;
      win.navTo(route);
    });

    let requestId = 0;
    async function refresh() {
      const id = ++requestId;
      if (list) {
        list.hidden = false;
        list.replaceChildren(makeElement(document, 'li', 'home-recent-loading', 'Loading workspace...'));
      }
      if (empty) empty.hidden = true;
      if (notice) { notice.hidden = false; notice.textContent = 'Loading workspace...'; }

      const results = await Promise.allSettled([
        scanProjection(win, 'chatThreads', projectThread),
        scanProjection(win, 'activities', projectActivity),
        readMemoryCount(win),
        readPackagingAvailability(win)
      ]);
      if (id !== requestId) return;

      const threadsReady = results[0].status === 'fulfilled';
      const activitiesReady = results[1].status === 'fulfilled';
      const memoryReady = threadsReady && results[2].status === 'fulfilled';
      const packagingReady = results[3].status === 'fulfilled';
      const recent = combineRecent(
        threadsReady ? results[0].value : [],
        activitiesReady ? results[1].value : [],
        MAX_RECENT_ITEMS
      );

      if (list) renderRecent(document, list, recent, threadsReady && activitiesReady);
      if (empty) empty.hidden = !(threadsReady && activitiesReady && recent.length === 0);
      setStatus(document, 'workspace-status-storage', threadsReady ? 'Ready' : 'Unavailable', threadsReady ? 'ready' : 'unavailable');
      setStatus(document, 'workspace-status-memory', memoryReady
        ? results[2].value + (results[2].value === 1 ? ' memory' : ' memories')
        : 'Unavailable', memoryReady ? 'ready' : 'unavailable');
      setStatus(document, 'workspace-status-packaging', packagingReady && results[3].value ? 'Available' : 'Unavailable',
        packagingReady && results[3].value ? 'ready' : 'unavailable');

      const unavailable = !threadsReady || !activitiesReady || !memoryReady || !packagingReady;
      if (notice) {
        notice.hidden = !unavailable;
        notice.textContent = 'Some workspace information unavailable';
      }
    }

    let wasActive = page.classList.contains('active');
    if (wasActive) refresh();
    const Observer = win.MutationObserver || (document.defaultView && document.defaultView.MutationObserver);
    let observer = null;
    if (Observer) {
      observer = new Observer(function () {
        const isActive = page.classList.contains('active');
        if (isActive && !wasActive) refresh();
        wasActive = isActive;
      });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    return { refresh: refresh, disconnect: function () { if (observer) observer.disconnect(); } };
  }

  return Object.freeze({
    MAX_SCAN_RECORDS: MAX_SCAN_RECORDS,
    MAX_RECENT_ITEMS: MAX_RECENT_ITEMS,
    ROUTES: ROUTES,
    safeLabel: safeLabel,
    timestampOf: timestampOf,
    projectThread: projectThread,
    projectActivity: projectActivity,
    combineRecent: combineRecent,
    formatRelativeTime: formatRelativeTime,
    greetingFor: greetingFor,
    scanProjection: scanProjection,
    readMemoryCount: readMemoryCount,
    readPackagingAvailability: readPackagingAvailability,
    mount: mount
  });
});
