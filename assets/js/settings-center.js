'use strict';

/* Settings Center is a presentation-only host for existing settings controls.
   The controls keep their original IDs, handlers, storage keys and authorities. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.IBSettingsCenter = api;
  var mounted = api.mount(root.document, root);
  if (mounted) root.IBSettingsCenter = mounted;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var CATEGORIES = Object.freeze(['general', 'appearance', 'ai', 'memory', 'services', 'data', 'advanced']);
  var MOVES = Object.freeze([
    ['ib-startup-animation-settings', 'settings-appearance-content'],
    ['middle-brain-section', 'settings-ai-content'],
    ['image-router-section', 'settings-ai-content'],
    ['api-voice-transcription-settings', 'settings-ai-content'],
    ['api-read-scope-settings', 'settings-memory-content'],
    ['api-summary-settings', 'settings-memory-content'],
    ['api-memory-settings', 'settings-memory-content'],
    ['api-presence-settings', 'settings-general-content'],
    ['api-output-settings', 'settings-general-content'],
    ['bg-ai-settings-card', 'settings-general-content'],
    ['api-chat-history-settings', 'settings-data-content'],
    ['api-data-protection', 'settings-data-content'],
    ['ibtools-settings-card', 'settings-services-content'],
    ['pay-auth-settings-card', 'settings-services-content']
  ]);

  function moveExistingControls(doc) {
    var apiPage = doc.getElementById('page-api');
    var credentialModal = doc.getElementById('ib-cred-modal-backdrop');
    /* The key dialog is opened from the API role editor, so keep it under that page. */
    if (apiPage && credentialModal && credentialModal.parentNode !== apiPage) apiPage.appendChild(credentialModal);
    MOVES.forEach(function (row) {
      var control = doc.getElementById(row[0]);
      var target = doc.getElementById(row[1]);
      if (control && target && control.parentNode !== target) target.appendChild(control);
    });
  }

  function mount(doc, win) {
    if (!doc) return null;
    var page = doc.getElementById('page-settings');
    var nav = page && page.querySelector('.settings-center-nav');
    var content = page && page.querySelector('.settings-center-content');
    if (!page || !nav || !content) return null;
    moveExistingControls(doc);
    if (page.__ibSettingsCenterMounted) return page.__ibSettingsCenter;
    page.__ibSettingsCenterMounted = true;

    function setCategory(name) {
      var category = CATEGORIES.indexOf(String(name || '')) >= 0 ? String(name) : 'general';
      nav.querySelectorAll('[data-settings-category]').forEach(function (button) {
        var active = button.getAttribute('data-settings-category') === category;
        button.classList.toggle('is-active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      content.querySelectorAll('[data-settings-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-settings-panel') !== category;
      });
      page.setAttribute('data-settings-active-category', category);
      if (category === 'services') {
        try {
          var qq = win.IB && win.IB.qqOnebot;
          if (qq && typeof qq.refreshRoleCatalog === 'function') qq.refreshRoleCatalog();
        } catch (_) { }
        try {
          var officialQQ = win.IB && win.IB.qqOfficialUI;
          if (officialQQ && typeof officialQQ.refreshRoleCatalog === 'function') officialQQ.refreshRoleCatalog();
        } catch (_) { }
      }
      updateThemeStatus();
      return category;
    }

    function updateThemeStatus() {
      var status = doc.getElementById('settings-theme-state');
      if (status) {
        var theme = doc.body.classList.contains('theme-infernal') ? 'Infernal' : 'Internal';
        status.textContent = win.IBI18n && typeof win.IBI18n.t === 'function'
          ? win.IBI18n.t('settings.appearance.currentTheme', { theme: theme })
          : '当前主题：' + theme;
      }
    }

    function onEnter() {
      /* Reuse the established page loader so moved controls receive the same reads,
         and the existing cognitive settings view refreshes from Home Node authority. */
      try { if (typeof win.loadApiSettingsUI === 'function') win.loadApiSettingsUI(); } catch (_) { }
      try { if (typeof win.renderIbToolsList === 'function') win.renderIbToolsList(); } catch (_) { }
      try { if (win.IBDIY && typeof win.IBDIY.mount === 'function') win.IBDIY.mount(); } catch (_) { }
      try { if (win.IBCm && win.IBCm.PaySettings && typeof win.IBCm.PaySettings.render === 'function') win.IBCm.PaySettings.render(); } catch (_) { }
      try { if (typeof win._bgAiLoadUI === 'function') win._bgAiLoadUI(); } catch (_) { }
      updateThemeStatus();
    }

    nav.querySelectorAll('[data-settings-category]').forEach(function (button) {
      var category = button.getAttribute('data-settings-category');
      var panel = doc.getElementById('settings-category-' + category);
      if (panel) button.setAttribute('aria-controls', panel.id);
      button.addEventListener('click', function () { setCategory(category); });
    });
    doc.addEventListener('ib:locale-changed', updateThemeStatus);
    setCategory(page.getAttribute('data-settings-active-category') || 'general');
    if (win.MutationObserver && doc.body) {
      try {
        new win.MutationObserver(updateThemeStatus).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
      } catch (_) { }
    }

    var api = {
      categories: CATEGORIES,
      moveExistingControls: function () { moveExistingControls(doc); },
      setCategory: setCategory,
      open: function (name) {
        var isActive = page.classList.contains('active');
        if (!isActive && typeof win.navTo === 'function') win.navTo('settings');
        return setCategory(name);
      },
      onEnter: onEnter
    };
    page.__ibSettingsCenter = api;
    return api;
  }

  return { CATEGORIES: CATEGORIES, MOVES: MOVES, mount: mount, moveExistingControls: moveExistingControls };
});
