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
      timestamp: timestampOf(record.lastActiveAt || record.updatedAt || record.createdAt)
    };
  }

  function combineRecent(threads, activities, limit) {
    return (Array.isArray(threads) ? threads : [])
      .concat(Array.isArray(activities) ? activities : [])
      .filter(function (item) { return item && typeof item.title === 'string'; })
      .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); })
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : MAX_RECENT_ITEMS);
  }

  function formatRelativeTime(timestamp, now, locale, i18n) {
    const value = timestampOf(timestamp);
    const text = function (key, fallback, vars) { return i18n && typeof i18n.t === 'function' ? i18n.t(key, vars) : fallback; };
    if (!value) return text('home.timeUnavailable', 'Time unavailable');
    const elapsed = Math.max(0, (Number(now) || Date.now()) - value);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return text('home.justNow', 'Just now');
    if (minutes < 60) return text('home.minutesAgo', minutes + ' min ago', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return text('home.hoursAgo', hours + ' hr ago', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return days === 1 ? text('home.oneDayAgo', '1 day ago', { count: days }) : text('home.daysAgo', days + ' days ago', { count: days });
    return new Date(value).toLocaleDateString(locale || undefined, { month: 'short', day: 'numeric' });
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

  function makeElement(document, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function renderRecent(document, list, items, win) {
    list.replaceChildren();
    list.hidden = items.length === 0;
    const i18n = win && win.IBI18n;
    const typeKeys = { Conversation: 'home.type.conversation', Reading: 'home.type.reading', Cinema: 'home.type.cinema', Activity: 'home.type.activity' };
    items.forEach(function (item) {
      const row = makeElement(document, 'li', 'ib-list-row home-recent-item');
      const content = makeElement(document, 'div', 'home-recent-content');
      content.appendChild(makeElement(document, 'strong', 'ib-list-row__primary', item.title));
      const meta = makeElement(document, 'div', 'home-recent-meta');
      const typeKey = typeKeys[item.type];
      meta.appendChild(makeElement(document, 'span', 'ib-list-row__secondary', typeKey && i18n ? i18n.t(typeKey) : item.type));
      content.appendChild(meta);
      const time = makeElement(document, 'time', 'ib-list-row__trailing', formatRelativeTime(item.timestamp, Date.now(), i18n && i18n.locale, i18n));
      if (item.timestamp) time.setAttribute('datetime', new Date(item.timestamp).toISOString());
      row.appendChild(content);
      row.appendChild(time);
      list.appendChild(row);
    });
  }

  function mount(document, win) {
    const page = document && document.getElementById('page-workspace');
    const workspace = document && document.getElementById('workspace-dashboard');
    if (!page || !workspace || workspace.__workspaceDashboardMounted) return null;
    workspace.__workspaceDashboardMounted = true;

    const list = document.getElementById('workspace-recent-list');
    const empty = document.getElementById('workspace-empty-state');
    const notice = document.getElementById('workspace-data-notice');
    const noticeText = document.getElementById('workspace-data-notice-text');

    let requestId = 0;
    let recentItems = [];
    let loading = false;
    function updateLocalizedRecent() {
      const i18n = win.IBI18n;
      if (list) renderRecent(document, list, recentItems, win);
      if (noticeText && notice && !notice.hidden && i18n) {
        noticeText.textContent = loading ? i18n.t('home.loading') : i18n.t(recentItems.length ? 'home.someUnavailable' : 'home.unavailable');
      }
    }
    async function refresh() {
      const id = ++requestId;
      loading = true;
      if (list) {
        list.hidden = true;
        list.replaceChildren();
      }
      if (empty) empty.hidden = true;
      if (notice) {
        notice.hidden = false;
        notice.dataset.status = 'loading';
        if (noticeText) noticeText.textContent = win.IBI18n ? win.IBI18n.t('home.loading') : 'Loading recent activity…';
      }

      const results = await Promise.allSettled([
        scanProjection(win, 'chatThreads', projectThread),
        scanProjection(win, 'activities', projectActivity)
      ]);
      if (id !== requestId) return;
      loading = false;

      const threadsReady = results[0].status === 'fulfilled';
      const activitiesReady = results[1].status === 'fulfilled';
      const unavailable = !threadsReady || !activitiesReady;
      const recent = combineRecent(
        threadsReady ? results[0].value : [],
        activitiesReady ? results[1].value : [],
        MAX_RECENT_ITEMS
      );
      recentItems = recent;
      if (list) renderRecent(document, list, recent, win);
      if (empty) empty.hidden = !(threadsReady && activitiesReady && recent.length === 0);
      if (notice) {
        notice.hidden = !unavailable;
        if (unavailable) {
          notice.dataset.status = 'degraded';
          if (noticeText) noticeText.textContent = win.IBI18n
            ? win.IBI18n.t(recent.length ? 'home.someUnavailable' : 'home.unavailable')
            : (recent.length ? 'Some recent activity is unavailable right now.' : 'Recent activity is unavailable right now.');
        } else {
          notice.dataset.status = 'loading';
          if (noticeText) noticeText.textContent = '';
        }
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
    if (typeof document.addEventListener === 'function') document.addEventListener('ib:locale-changed', updateLocalizedRecent);
    return { refresh: refresh, disconnect: function () { if (observer) observer.disconnect(); } };
  }

  return Object.freeze({
    MAX_SCAN_RECORDS: MAX_SCAN_RECORDS,
    MAX_RECENT_ITEMS: MAX_RECENT_ITEMS,
    safeLabel: safeLabel,
    timestampOf: timestampOf,
    projectThread: projectThread,
    projectActivity: projectActivity,
    combineRecent: combineRecent,
    formatRelativeTime: formatRelativeTime,
    scanProjection: scanProjection,
    mount: mount
  });
});
