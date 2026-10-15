(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBStartupAnimation = api;
  if (root && root.document) api.mount(root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var ENABLED_KEY = 'ib_startup_animation_enabled';
  var SEEN_KEY = 'ib_startup_animation_seen';
  var MAJOR_KEY = 'ib_startup_animation_major';
  var VIDEO_URL = 'Video/08e2b1dc2b734d4fafae30c3fb9f2f01%20(1).mp4';
  var OVERLAY_ID = 'ib-startup-animation';
  var VERSION_TIMEOUT_MS = 1500;
  var START_TIMEOUT_MS = 6000;
  var FADE_OUT_MS = 950;

  function isDevelopmentHost(locationLike, runtimeMode) {
    var mode = String(runtimeMode || '').toLowerCase();
    if (mode === 'development' || mode === 'acceptance') return true;
    var location = locationLike || {};
    var hostname = String(location.hostname || '').toLowerCase();
    return location.protocol === 'file:' || hostname === 'localhost' || hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
  }

  function resolveEnabled(preference, isDevelopment) {
    if (preference === '1') return true;
    if (preference === '0') return false;
    return !isDevelopment;
  }

  function majorVersion(version) {
    var match = String(version || '').trim().match(/^(\d+)(?:\.|$)/);
    return match ? match[1] : '';
  }

  function decidePlayback(options) {
    var input = options || {};
    if (!input.enabled) return { play: false, full: false, canSkip: false, reason: 'disabled' };
    var seen = input.seen === true;
    var previousMajor = String(input.previousMajor || '');
    var currentMajor = String(input.currentMajor || '');
    var firstRun = !seen;
    var majorUpdate = seen && !!previousMajor && !!currentMajor && previousMajor !== currentMajor;
    var full = firstRun || majorUpdate;
    return {
      play: true,
      full: full,
      canSkip: !full,
      reason: firstRun ? 'first-run' : (majorUpdate ? 'major-update' : 'regular')
    };
  }

  function safeGet(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch (error) { return null; }
  }

  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (error) { /* storage can be unavailable in private contexts */ }
  }

  function getStorage(windowRef) {
    try { return windowRef.localStorage; } catch (error) { return null; }
  }

  function readProductVersion(windowRef) {
    if (typeof windowRef.fetch !== 'function') return Promise.resolve('');
    var controller = typeof windowRef.AbortController === 'function' ? new windowRef.AbortController() : null;
    var timer = windowRef.setTimeout(function () { if (controller) controller.abort(); }, VERSION_TIMEOUT_MS);
    var url;
    try {
      url = new URL('VERSION', windowRef.location.href);
      url.searchParams.set('_startup', String(Date.now()));
    } catch (error) {
      windowRef.clearTimeout(timer);
      return Promise.resolve('');
    }
    return windowRef.fetch(url.href, {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response || !response.ok) return '';
      return response.text();
    }).then(function (text) {
      return String(text || '').trim();
    }).catch(function () {
      return '';
    }).then(function (version) {
      windowRef.clearTimeout(timer);
      return version;
    });
  }

  function markSeen(storage, major) {
    safeSet(storage, SEEN_KEY, '1');
    if (major) safeSet(storage, MAJOR_KEY, major);
  }

  function settingValue(windowRef) {
    var development = isDevelopmentHost(windowRef.location, windowRef.__IB_RUNTIME_MODE__);
    return resolveEnabled(safeGet(getStorage(windowRef), ENABLED_KEY), development);
  }

  function setEnabled(enabled) {
    var success = false;
    try {
      root.localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
      success = true;
    } catch (error) { /* the in-memory control still reflects the user's choice */ }
    var control = root.document && root.document.getElementById('ib-startup-animation-toggle');
    if (control) control.checked = !!enabled;
    return success;
  }

  function createOverlay(documentRef) {
    var existing = documentRef.getElementById(OVERLAY_ID);
    if (existing) return existing;
    var overlay = documentRef.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.setAttribute('aria-label', 'InternalBeyond 启动动画');

    var video = documentRef.createElement('video');
    video.muted = true;
    video.autoplay = false;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.src = VIDEO_URL;
    overlay.appendChild(video);

    var skip = documentRef.createElement('button');
    skip.type = 'button';
    skip.className = 'ib-startup-animation-skip';
    skip.textContent = '跳过启动动画';
    skip.hidden = true;
    overlay.appendChild(skip);
    documentRef.body.appendChild(overlay);
    return overlay;
  }

  function mount(windowRef) {
    var documentRef = windowRef.document;
    var control = documentRef.getElementById('ib-startup-animation-toggle');
    if (control) control.checked = settingValue(windowRef);

    function start() {
      var storage = getStorage(windowRef);
      var development = isDevelopmentHost(windowRef.location, windowRef.__IB_RUNTIME_MODE__);
      var preference = safeGet(storage, ENABLED_KEY);
      var enabled = resolveEnabled(preference, development);
      var previouslySeen = safeGet(storage, SEEN_KEY) === '1';

      // Local development stays out of the user-facing first-run/version history by default.
      if (development && preference !== '1') return;

      var overlay = enabled ? createOverlay(documentRef) : null;
      var video = overlay && overlay.querySelector('video');
      var skip = overlay && overlay.querySelector('button');
      var leaving = false;
      var started = false;
      var canSkip = false;
      var currentMajor = '';
      var startTimer = 0;

      function finish() {
        if (leaving) return;
        leaving = true;
        if (startTimer) windowRef.clearTimeout(startTimer);
        windowRef.removeEventListener('keydown', onKeyDown);
        if (video) {
          video.pause();
        }
        if (overlay) {
          overlay.classList.add('is-leaving');
          windowRef.setTimeout(function () {
            overlay.hidden = true;
            overlay.classList.remove('is-visible', 'is-leaving');
            if (video) video.classList.remove('is-playing');
          }, FADE_OUT_MS);
        }
        markSeen(storage, currentMajor);
      }

      function onKeyDown(event) {
        if (canSkip && event.key === 'Escape') finish();
      }

      if (skip) skip.addEventListener('click', finish);

      // Fade the old resource preloader away under the video layer. Home can now
      // become visible on the existing DOMContentLoaded route while the clip plays.
      if (overlay) {
        var preloader = documentRef.getElementById('preloader');
        if (preloader) preloader.classList.add('fade-out');
        overlay.hidden = false;
        windowRef.requestAnimationFrame(function () { overlay.classList.add('is-visible'); });
      }

      var versionPromise = readProductVersion(windowRef);
      versionPromise.then(function (version) {
        currentMajor = majorVersion(version);
        var previousMajor = safeGet(storage, MAJOR_KEY) || '';
        var decision = decidePlayback({
          enabled: enabled,
          seen: previouslySeen,
          previousMajor: previousMajor,
          currentMajor: currentMajor
        });

        if (!decision.play) {
          markSeen(storage, currentMajor);
          return;
        }

        if (!overlay || !video) {
          markSeen(storage, currentMajor);
          return;
        }

        canSkip = decision.canSkip;
        if (skip) skip.hidden = !canSkip;
        if (canSkip) {
          windowRef.addEventListener('keydown', onKeyDown);
          try { skip.focus({ preventScroll: true }); } catch (error) { /* focus is optional */ }
        }

        video.addEventListener('playing', function () {
          started = true;
          video.classList.add('is-playing');
          if (startTimer) windowRef.clearTimeout(startTimer);
        }, { once: true });
        video.addEventListener('ended', finish, { once: true });
        video.addEventListener('error', finish, { once: true });
        startTimer = windowRef.setTimeout(function () {
          if (!started) finish();
        }, START_TIMEOUT_MS);

        var playResult;
        try { playResult = video.play(); } catch (error) { finish(); return; }
        if (playResult && typeof playResult.catch === 'function') playResult.catch(finish);
      }).catch(function () {
        if (overlay) finish();
        else markSeen(storage, currentMajor);
      });
    }

    if (documentRef.readyState === 'loading') {
      documentRef.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  return Object.freeze({
    ENABLED_KEY: ENABLED_KEY,
    SEEN_KEY: SEEN_KEY,
    MAJOR_KEY: MAJOR_KEY,
    VIDEO_URL: VIDEO_URL,
    isDevelopmentHost: isDevelopmentHost,
    resolveEnabled: resolveEnabled,
    majorVersion: majorVersion,
    decidePlayback: decidePlayback,
    setEnabled: setEnabled,
    mount: mount
  });
});
