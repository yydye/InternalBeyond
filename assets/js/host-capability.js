/* ====================================================================
   P32 · IB Host Capability Contract
   --------------------------------------------------------------------
   Business code talks to IB.host. Only this file knows whether the current
   surface is Browser/HomeNode or Tauri 2. Existing Web APIs remain the
   Browser adapter; the first native capability is read-only Project Knowledge.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = { createHost: factory };
  } else {
    var host = factory(root);
    root.IB = root.IB || {};
    if (typeof root.IB.expose === 'function') root.IB.expose('host', host);
    else root.IB.host = host;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var CONTRACT_VERSION = 'p32.v1';

  function safeString(value) {
    return value == null ? '' : String(value);
  }

  function rejected(code, detail) {
    var error = new Error(detail || code);
    error.code = code;
    return Promise.reject(error);
  }

  function isSafeExternalUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return ['http:', 'https:'].indexOf(url.protocol) >= 0;
    } catch (e) { return false; }
  }

  function tauriInvoke(target) {
    try {
      var tauri = target && target.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
        return function (name, args) {
          return args === undefined ? tauri.core.invoke(name) : tauri.core.invoke(name, args);
        };
      }
    } catch (e) {}
    return null;
  }

  /* Tauri can expose its global namespace before the optional core invoke
     bridge is ready. The runtime surface is still Tauri in that case; native
     command capabilities remain unavailable until `core.invoke` is present. */
  function hasTauriRuntime(target) {
    try {
      if (target && target.__TAURI__ && typeof target.__TAURI__ === 'object') return true;
      if (target && target.__TAURI_INTERNALS__ && typeof target.__TAURI_INTERNALS__ === 'object') return true;
      if (target && target.__IB_TAURI_HOST__ === true) return true;
      if (target && target.chrome && target.chrome.webview && typeof target.chrome.webview === 'object') return true;
      var origin = target && target.location ? safeString(target.location.origin) : '';
      if (/^https?:\/\/tauri\.localhost(?::\d+)?$/i.test(origin)) return true;
      var search = target && target.location ? safeString(target.location.search) : '';
      return /(?:^|[?&])ib_tauri_host=1(?:&|$)/i.test(search);
    }
    catch (e) { return false; }
  }

  function jsonFetch(target, pathname, params) {
    if (!target || typeof target.fetch !== 'function') return Promise.resolve({ ok: false, error: 'host-fetch-unavailable' });
    var query = [];
    Object.keys(params || {}).forEach(function (key) {
      if (params[key] === undefined || params[key] === null || params[key] === '') return;
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
    });
    var url = pathname + (query.length ? '?' + query.join('&') : '');
    return target.fetch(url, { method: 'GET', cache: 'no-store' }).then(function (response) {
      return response.text().then(function (raw) {
        var value = null;
        try { value = raw ? JSON.parse(raw) : null; } catch (e) { value = null; }
        if (!value || typeof value !== 'object') return { ok: false, error: 'host-invalid-response' };
        if (!response.ok && value.ok !== false) value.ok = false;
        return value;
      });
    }, function (error) {
      return { ok: false, error: 'host-fetch-failed', detail: safeString(error && error.message || error) };
    });
  }

  function browserProjectKnowledge(target) {
    return {
      listProjectDocs: function () { return jsonFetch(target, '/__project-knowledge/list'); },
      searchProjectDocs: function (query, options) {
        options = options || {};
        return jsonFetch(target, '/__project-knowledge/search', {
          q: safeString(query), limit: options.limit, authority: options.authority
        });
      },
      readProjectDoc: function (docId, section) {
        return jsonFetch(target, '/__project-knowledge/read', { docId: safeString(docId), section: section });
      },
      status: function () { return jsonFetch(target, '/__project-knowledge/status'); }
    };
  }

  function tauriProjectKnowledge(invoke) {
    function command(name, args) {
      return invoke(name, args).then(function (value) {
        return value && typeof value === 'object' ? value : { ok: false, error: 'host-invalid-response' };
      }, function (error) {
        return { ok: false, error: 'host-command-failed', detail: safeString(error && error.message || error) };
      });
    }
    return {
      listProjectDocs: function () { return command('list_project_docs'); },
      searchProjectDocs: function (query, options) {
        options = options || {};
        return command('search_project_docs', {
          query: safeString(query), limit: options.limit == null ? null : Number(options.limit),
          authority: options.authority == null ? null : safeString(options.authority)
        });
      },
      readProjectDoc: function (docId, section) {
        return command('read_project_doc', { docId: safeString(docId), section: section == null ? null : safeString(section) });
      },
      status: function () { return command('project_knowledge_status'); }
    };
  }

  function browserCredentialStatus() {
    return {
      available: false,
      query: function () {
        return Promise.resolve({ ok: false, error: 'credential-status-unavailable' });
      }
    };
  }

  function tauriCredentialStatus(invoke) {
    function query(bindings) {
      var list = Array.isArray(bindings) ? bindings : [];
      if (list.length > 200) return Promise.resolve({ ok: false, errorCode: 'BATCH_TOO_LARGE', results: [] });
      return invoke('credential_status', { request: { bindings: list } }).then(function (value) {
        return value && typeof value === 'object' ? value : { ok: false, error: 'host-invalid-response' };
      }, function (error) {
        return { ok: false, error: 'credential-status-unavailable', detail: safeString(error && error.message || error) };
      });
    }
    return { available: true, query: query };
  }

  function credentialUnavailable() {
    var error = new Error('CREDENTIAL_UNAVAILABLE');
    error.code = 'CREDENTIAL_UNAVAILABLE';
    return Promise.reject(error);
  }

  function browserCredentialResolver() {
    return {
      available: false,
      resolve: function () { return credentialUnavailable(); }
    };
  }

  /* This bridge returns one credential only for the lifetime of the caller's
     request. Callers must not cache, log, or persist the returned value. */
  function tauriCredentialResolver(invoke) {
    return {
      available: true,
      resolve: function (bindingId) {
        var id = safeString(bindingId).trim();
        if (!id || id.length > 180 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return credentialUnavailable();
        return invoke('credential_resolve', { request: { bindingId: id } }).then(function (value) {
          if (!value || value.ok !== true || typeof value.apiKey !== 'string' || !value.apiKey.trim()
            || typeof value.provider !== 'string' || !/^[A-Za-z0-9._-]{1,48}$/.test(value.provider)) {
            return credentialUnavailable();
          }
          var resolved = { ok: true, provider: value.provider, apiKey: value.apiKey };
          value.apiKey = '';
          return resolved;
        }, function () {
          return credentialUnavailable();
        });
      }
    };
  }

  function tauriLive2dModels(invoke, target) {
    function command(name, args) {
      return invoke(name, args).then(function (value) {
        if (value && typeof value === 'object' && value.ok === false) throw new Error(safeString(value.error || 'live2d-command-failed'));
        return value;
      });
    }
    function assetUrl(path) {
      var convert = target && target.__TAURI__ && target.__TAURI__.core && target.__TAURI__.core.convertFileSrc;
      if (typeof convert !== 'function') throw new Error('live2d-asset-protocol-unavailable');
      var filePath = String(path || '');
      /* Keep Windows separators as URL separators so .model3.json resources
         resolve beside their parent model instead of at the asset host root. */
      var normalized = filePath.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalized)) {
        return 'http://asset.localhost/' + normalized.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
      }
      return convert(filePath, 'asset');
    }
    return Object.freeze({
      available: true,
      list: function () { return command('ib_live2d_models_list').then(function (rows) { return Array.isArray(rows) ? rows : []; }); },
      begin: function (mode) { return command('ib_live2d_import_begin', { mode: safeString(mode) }); },
      writeChunk: function (request) {
        request = request || {};
        return command('ib_live2d_import_chunk', {
          importId: safeString(request.importId), relativePath: safeString(request.relativePath),
          offset: Number(request.offset) || 0, totalSize: Number(request.totalSize) || 0,
          chunk: Array.isArray(request.chunk) ? request.chunk : []
        });
      },
      finish: function (importId) { return command('ib_live2d_import_finish', { importId: safeString(importId) }); },
      abort: function (importId) { return command('ib_live2d_import_abort', { importId: safeString(importId) }); },
      resolve: function (modelRef) {
        return command('ib_live2d_model_resolve', { modelRef: safeString(modelRef) }).then(assetUrl);
      },
      runtimeUrl: function () { return command('ib_live2d_runtime_resolve').then(assetUrl); }
    });
  }

  function browserLive2dModels() {
    function unavailable() { return rejected('live2d-native-storage-unavailable', 'Live2D 模型导入需要 Tauri 桌面版'); }
    return Object.freeze({
      available: false,
      list: function () { return Promise.resolve([]); },
      begin: unavailable, writeChunk: unavailable, finish: unavailable, abort: function () { return Promise.resolve(); },
      resolve: unavailable, runtimeUrl: unavailable
    });
  }

  function tauriPuppetBundles(invoke, target) {
    function command(name, args) {
      return invoke(name, args).then(function (value) {
        if (value && typeof value === 'object' && value.ok === false) throw new Error(safeString(value.error || 'puppet-command-failed'));
        return value;
      });
    }
    function assetUrl(path) {
      var convert = target && target.__TAURI__ && target.__TAURI__.core && target.__TAURI__.core.convertFileSrc;
      if (typeof convert !== 'function') throw new Error('puppet-asset-protocol-unavailable');
      var filePath = String(path || ''), normalized = filePath.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalized)) return 'http://asset.localhost/' + normalized.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
      return convert(filePath, 'asset');
    }
    return Object.freeze({
      available: true,
      list: function () { return command('ib_puppet_bundles_list').then(function (rows) { return Array.isArray(rows) ? rows : []; }); },
      begin: function (mode) { return command('ib_puppet_import_begin', { mode: safeString(mode) }); },
      writeChunk: function (request) {
        request = request || {};
        return command('ib_puppet_import_chunk', {
          importId: safeString(request.importId), relativePath: safeString(request.relativePath),
          offset: Number(request.offset) || 0, totalSize: Number(request.totalSize) || 0,
          chunk: Array.isArray(request.chunk) ? request.chunk : []
        });
      },
      finish: function (importId) { return command('ib_puppet_import_finish', { importId: safeString(importId) }); },
      abort: function (importId) { return command('ib_puppet_import_abort', { importId: safeString(importId) }); },
      resolve: function (bundleId) { return command('ib_puppet_bundle_resolve', { bundleId: safeString(bundleId) }).then(assetUrl); },
      export: function (bundleId) { return command('ib_puppet_bundle_export', { bundleId: safeString(bundleId) }); }
    });
  }

  function browserPuppetBundles() {
    function unavailable() { return rejected('puppet-native-storage-unavailable', '角色动画素材导入需要 Tauri 桌面版'); }
    return Object.freeze({
      available: false,
      list: function () { return Promise.resolve([]); },
      begin: unavailable, writeChunk: unavailable, finish: unavailable, abort: function () { return Promise.resolve(); }, resolve: unavailable, export: unavailable
    });
  }

  function tauriPuppetProjects(invoke) {
    function command(name, args) {
      return invoke(name, args).then(function (value) {
        if (value && typeof value === 'object' && value.ok === false) throw new Error(safeString(value.error || 'puppet-project-command-failed'));
        return value;
      });
    }
    return Object.freeze({
      available: true,
      list: function () { return command('ib_puppet_projects_list').then(function (rows) { return Array.isArray(rows) ? rows : []; }); },
      save: function (projectJson) { return command('ib_puppet_project_save', { projectJson: safeString(projectJson) }); },
      load: function (projectId) { return command('ib_puppet_project_load', { projectId: safeString(projectId) }); },
      export: function (projectJson) { return command('ib_puppet_project_export', { projectJson: safeString(projectJson) }); },
      compileRuntime: function (projectId) { return command('ib_puppet_project_compile', { projectId: safeString(projectId) }); }
    });
  }

  function browserPuppetProjects() {
    function unavailable() { return rejected('puppet-project-native-storage-unavailable', '可编辑工程库需要 Tauri 桌面版'); }
    return Object.freeze({
      available: false,
      list: function () { return Promise.resolve([]); },
      save: unavailable, load: unavailable, export: unavailable, compileRuntime: unavailable
    });
  }

  function tauriPuppetAi(invoke) {
    function command(name, args) {
      return invoke(name, args).then(function (value) {
        if (value && typeof value === 'object' && value.ok === false) throw new Error(safeString(value.error || 'puppet-ai-command-failed'));
        return value;
      });
    }
    return Object.freeze({
      available: true,
      pickPath: function (kind) { return command('ib_puppet_ai_pick_path', { kind: safeString(kind) }); },
      status: function () { return command('ib_puppet_ai_status'); },
      install: function (request) {
        request = request || {};
        return command('ib_puppet_ai_install', {
          componentRoot: safeString(request.componentRoot), sourceRoot: safeString(request.sourceRoot),
          pythonExecutable: safeString(request.pythonExecutable), modelDirectory: safeString(request.modelDirectory),
          licenseAcknowledged: request.licenseAcknowledged === true
        });
      },
      uninstall: function (request) { request = request || {}; return command('ib_puppet_ai_uninstall', { removeManagedEnvironment: request.removeManagedEnvironment === true }); },
      clearCache: function (removeModels) { return command('ib_puppet_ai_clear_cache', { removeModels: removeModels === true }); },
      run: function (request) {
        request = request || {};
        return command('ib_puppet_ai_run', { sourceDataUrl: safeString(request.sourceDataUrl), inputName: safeString(request.inputName) });
      },
      readResultChunk: function (jobId, offset, maxBytes) {
        return command('ib_puppet_ai_result_read_chunk', { jobId: safeString(jobId), offset: Number(offset) || 0, maxBytes: Number(maxBytes) || 262144 });
      }
    });
  }

  function browserPuppetAi() {
    function unavailable() { return rejected('puppet-ai-tauri-required', '本地 AI 组件管理需要 Windows Tauri 桌面版；图片导入和手动分层仍可使用。'); }
    return Object.freeze({
      available: false, pickPath: unavailable, install: unavailable, uninstall: unavailable,
      clearCache: unavailable, run: unavailable, readResultChunk: unavailable,
      status: function () { return Promise.resolve({ installed: false, ready: false, message: '本地 AI 组件需要 Tauri 桌面版。' }); }
    });
  }

  function browserFiles(target) {
    return {
      pickFile: function (options) {
        if (!target || typeof target.showOpenFilePicker !== 'function') return rejected('file-picker-unavailable');
        options = options || {};
        return target.showOpenFilePicker({ multiple: !!options.multiple, types: options.types || undefined });
      },
      pickDirectory: function () {
        if (!target || typeof target.showDirectoryPicker !== 'function') return rejected('directory-picker-unavailable');
        return target.showDirectoryPicker();
      },
      saveText: function (filename, value) {
        if (!target || !target.document || typeof target.Blob !== 'function' || !target.URL || typeof target.URL.createObjectURL !== 'function') {
          return rejected('save-unavailable');
        }
        var blob = new target.Blob([safeString(value)], { type: 'text/plain;charset=utf-8' });
        var url = target.URL.createObjectURL(blob);
        try {
          var anchor = target.document.createElement('a');
          anchor.href = url; anchor.download = safeString(filename) || 'InternalBeyond-export.txt';
          anchor.rel = 'noopener'; anchor.click();
          return Promise.resolve({ ok: true });
        } finally {
          try { target.URL.revokeObjectURL(url); } catch (e) {}
        }
      }
    };
  }

  function browserClipboard(target) {
    return {
      readText: function () {
        var clipboard = target && target.navigator && target.navigator.clipboard;
        return clipboard && typeof clipboard.readText === 'function' ? clipboard.readText() : rejected('clipboard-read-unavailable');
      },
      writeText: function (value) {
        var clipboard = target && target.navigator && target.navigator.clipboard;
        return clipboard && typeof clipboard.writeText === 'function' ? clipboard.writeText(safeString(value)) : rejected('clipboard-write-unavailable');
      }
    };
  }

  function browserNotifications(target) {
    return {
      permission: function () {
        return target && target.Notification ? safeString(target.Notification.permission || 'default') : 'unsupported';
      },
      requestPermission: function () {
        if (!target || !target.Notification || typeof target.Notification.requestPermission !== 'function') return Promise.resolve('unsupported');
        return target.Notification.requestPermission();
      },
      notify: function (title, options) {
        if (!target || !target.Notification || typeof target.Notification !== 'function') return rejected('notification-unavailable');
        return Promise.resolve(new target.Notification(safeString(title), options || {}));
      }
    };
  }

  function browserExternal(target) {
    return {
      open: function (value) {
        var url = safeString(value);
        if (!isSafeExternalUrl(url)) return rejected('external-url-rejected');
        if (!target || typeof target.open !== 'function') return rejected('external-open-unavailable');
        target.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve({ ok: true, url: url });
      }
    };
  }

  function capabilities(target, platform, projectKnowledge, nativeInvoke, credentialResolverAvailable, live2dModelsAvailable, puppetBundlesAvailable) {
    var protocol = target && target.location ? safeString(target.location.protocol) : '';
    var browserStatic = !nativeInvoke && protocol !== 'file:';
    var navigator = target && target.navigator;
    var hasClipboard = !!(navigator && navigator.clipboard);
    var hasNotification = !!(target && target.Notification);
    return Object.freeze({
      contract: CONTRACT_VERSION,
      platform: platform,
      projectKnowledge: Object.freeze({
        available: !!nativeInvoke || browserStatic,
        readOnly: true,
        transport: nativeInvoke ? 'tauri-command' : 'browser-static'
      }),
      credentialStatus: Object.freeze({
        available: !!nativeInvoke,
        readOnly: true,
        transport: nativeInvoke ? 'tauri-command' : 'unavailable'
      }),
      credentialResolver: Object.freeze({
        available: !!credentialResolverAvailable,
        requestScoped: true,
        transport: credentialResolverAvailable ? 'tauri-command' : 'unavailable'
      }),
      live2dModels: Object.freeze({
        available: !!live2dModelsAvailable,
        userData: !!live2dModelsAvailable,
        transport: live2dModelsAvailable ? 'tauri-command' : 'unavailable'
      }),
      characterPuppets: Object.freeze({
        available: !!puppetBundlesAvailable,
        userData: !!puppetBundlesAvailable,
        transport: puppetBundlesAvailable ? 'tauri-command' : 'unavailable'
      }),
      filesystem: Object.freeze({ available: !!(target && target.showOpenFilePicker), transport: 'web-api' }),
      clipboard: Object.freeze({ available: hasClipboard, transport: 'web-api' }),
      notifications: Object.freeze({ available: hasNotification, transport: 'web-api' }),
      external: Object.freeze({ available: !!(target && target.open), transport: 'web-api' }),
      background: Object.freeze({ available: false, transport: 'deferred' })
    });
  }

  function createHost(target) {
    target = target || {};
    var invoke = tauriInvoke(target);
    var initialPlatform = invoke || hasTauriRuntime(target) ? 'tauri' : 'browser';
    var projectKnowledge = invoke ? tauriProjectKnowledge(invoke) : browserProjectKnowledge(target);
    var credentialStatus = invoke ? tauriCredentialStatus(invoke) : browserCredentialStatus();
    var recoveryOnly = !!(target && (target.__IB_RECOVERY_ONLY__ === true || target.__IB_RECOVERY_BOOT_BLOCKED__ === true));
    var credentialResolverAvailable = !!invoke && !recoveryOnly;
    var credentialResolver = credentialResolverAvailable ? tauriCredentialResolver(invoke) : browserCredentialResolver();
    var live2dModels = invoke && !recoveryOnly ? tauriLive2dModels(invoke, target) : browserLive2dModels();
    var puppetBundles = invoke && !recoveryOnly ? tauriPuppetBundles(invoke, target) : browserPuppetBundles();
    var puppetProjects = invoke && !recoveryOnly ? tauriPuppetProjects(invoke) : browserPuppetProjects();
    var puppetAi = invoke && !recoveryOnly ? tauriPuppetAi(invoke) : browserPuppetAi();
    var caps = capabilities(target, initialPlatform, projectKnowledge, !!invoke, credentialResolverAvailable, !!invoke && !recoveryOnly, !!invoke && !recoveryOnly);
    return Object.freeze({
      version: CONTRACT_VERSION,
      platform: function () { return invoke || hasTauriRuntime(target) ? 'tauri' : 'browser'; },
      capabilities: function () { return caps; },
      files: browserFiles(target),
      notifications: browserNotifications(target),
      clipboard: browserClipboard(target),
      external: browserExternal(target),
      projectKnowledge: projectKnowledge,
      credentialStatus: credentialStatus,
      credentialResolver: credentialResolver,
      live2dModels: live2dModels,
      characterPuppets: puppetBundles,
      puppetProjects: puppetProjects,
      puppetAi: puppetAi
    });
  }

  return createHost(root);
});
