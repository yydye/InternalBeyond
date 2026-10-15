(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.IBWorkModeExecutor = api;
    if (root.IB) {
      root.IB.workMode = root.IB.workMode || {};
      root.IB.workMode.executor = api;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TOOL_PROJECT_READ = 'project.read_file';
  var TOOL_PROJECT_CREATE = 'project.create_file';
  var TOOL_PROJECT_UPDATE = 'project.update_file';
  var APP_DRAFT_LIST = 'app_draft.list_files';
  var APP_DRAFT_READ = 'app_draft.read_file';
  var APP_DRAFT_CREATE = 'app_draft.create_file';
  var APP_DRAFT_UPDATE = 'app_draft.update_file';
  var PRESETS = Object.freeze({
    general: Object.freeze({
      id: 'general', label: 'General',
      strategy: '用清晰、均衡的方式完成任务；只陈述可由本次授权上下文支持的结论。',
      allowedTools: Object.freeze([TOOL_PROJECT_READ]), maxProjectReadCalls: 1
    }),
    coding: Object.freeze({
      id: 'coding', label: 'Coding',
      strategy: '优先检查实现、入口、配置与测试；只在 Home Node Consent 明确授权的 Workspace 文件范围内创建或修改文本文件，生成变更后总结路径与差异。',
      allowedTools: Object.freeze([TOOL_PROJECT_READ, TOOL_PROJECT_CREATE, TOOL_PROJECT_UPDATE]), maxProjectReadCalls: 12
    }),
    research: Object.freeze({
      id: 'research', label: 'Research',
      strategy: '以证据为先，区分观察、推断与未知；只引用本次授权读取的项目内容。',
      allowedTools: Object.freeze([TOOL_PROJECT_READ]), maxProjectReadCalls: 8
    }),
    'app-builder': Object.freeze({
      id: 'app-builder', label: 'App Builder',
      strategy: '按用户请求在隔离的 APP 草稿工作区中生成或修改 HTML/CSS/JS；先读取已有草稿，再以受限工具写入文件。',
      allowedTools: Object.freeze([APP_DRAFT_LIST, APP_DRAFT_READ, APP_DRAFT_CREATE, APP_DRAFT_UPDATE]), maxProjectReadCalls: 0
    })
  });

  function string(value, max) {
    if (typeof value !== 'string') return '';
    value = value.trim();
    return value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
  }

  function roleProfileRef(role) {
    if (!role || typeof role !== 'object') return '';
    return string(role.apiProfileRef || role.providerProfileRef || role.profileRef || role.id, 180);
  }

  function isMiddleBrainProfile(profile) {
    if (!profile || typeof profile !== 'object') return false;
    if (profile.middleBrainOnly === true || profile.isMiddleBrain === true || profile.destination === 'middle_brain') return true;
    var identity = [profile.id, profile.name, profile.nickname, profile.displayName, profile.purpose, profile.profileType]
      .filter(function (value) { return typeof value === 'string'; }).join(' ').toLowerCase();
    return /middle[\s._-]*brain|中枢/.test(identity);
  }

  function normalizeChoice(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var rawRoleId = value.roleId == null ? '' : String(value.roleId);
    var roleId = rawRoleId ? string(rawRoleId, 180) : '';
    var profileRef = string(value.profileRef, 180);
    var presetId = string(value.presetId, 32);
    if ((rawRoleId && !roleId) || !profileRef || !/^[A-Za-z0-9_.:-]{1,180}$/.test(profileRef)
      || !Object.prototype.hasOwnProperty.call(PRESETS, presetId)
      || (roleId && !/^[A-Za-z0-9_.:-]{1,180}$/.test(roleId))) return null;
    return Object.freeze({ roleId: roleId, profileRef: profileRef, presetId: presetId });
  }

  function validProviderScope(scope) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
    var keys = Object.keys(scope).sort().join(',');
    return keys === 'destination,model,provider,providerRef,routeHash'
      && scope.destination === 'agent'
      && /^[A-Za-z0-9_.:-]{1,180}$/.test(String(scope.providerRef || ''))
      && /^[A-Za-z0-9_.:-]{1,80}$/.test(String(scope.provider || ''))
      && /^[A-Za-z0-9_.:+/-]{1,120}$/.test(String(scope.model || ''))
      && /^[a-f0-9]{64}$/.test(String(scope.routeHash || ''));
  }

  function normalizeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var keys = Object.keys(value).sort().join(',');
    if (keys !== 'allowedTools,maxProjectReadCalls,personaHash,presetId,profileRef,providerScope,roleId,roleName,schemaVersion'
      || value.schemaVersion !== 1) return null;
    var choice = normalizeChoice({ roleId: value.roleId, profileRef: value.profileRef, presetId: value.presetId });
    var roleName = string(value.roleName, 100);
    var preset = choice && PRESETS[choice.presetId];
    if (!choice || !roleName || !/^[a-f0-9]{64}$/.test(String(value.personaHash || ''))
      || !validProviderScope(value.providerScope) || value.providerScope.providerRef !== choice.profileRef
      || !Array.isArray(value.allowedTools) || !preset
      || value.maxProjectReadCalls !== preset.maxProjectReadCalls
      || value.allowedTools.length !== preset.allowedTools.length
      || value.allowedTools.some(function (tool, index) { return tool !== preset.allowedTools[index]; })) return null;
    return Object.freeze({
      schemaVersion: 1,
      roleId: choice.roleId,
      roleName: roleName,
      profileRef: choice.profileRef,
      presetId: choice.presetId,
      personaHash: String(value.personaHash).toLowerCase(),
      maxProjectReadCalls: preset.maxProjectReadCalls,
      providerScope: Object.freeze({
        destination: 'agent', providerRef: String(value.providerScope.providerRef),
        provider: String(value.providerScope.provider), model: String(value.providerScope.model),
        routeHash: String(value.providerScope.routeHash).toLowerCase()
      }),
      allowedTools: Object.freeze(preset.allowedTools.slice())
    });
  }

  function digestText(value, cryptoApi) {
    value = String(value == null ? '' : value);
    cryptoApi = cryptoApi || (typeof crypto !== 'undefined' ? crypto : null);
    if (cryptoApi && cryptoApi.subtle && typeof cryptoApi.subtle.digest === 'function' && typeof TextEncoder === 'function') {
      return cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(function (digest) {
        return Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      });
    }
    if (typeof require === 'function') {
      return Promise.resolve(require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex'));
    }
    return Promise.reject(new Error('sha256-unavailable'));
  }

  async function createSnapshot(input) {
    input = input || {};
    var choice = normalizeChoice(input.choice);
    var role = input.role || null;
    var profile = input.profile || null;
    var routeCore = input.routeCore;
    var consentCore = input.consentCore;
    var cryptoApi = input.crypto || null;
    if (!choice || !profile || String(profile.id || '') !== choice.profileRef || profile.archived === true
      || !String(profile.credentialRef || '').trim() || !routeCore || typeof routeCore.normalize !== 'function'
      || !consentCore || typeof consentCore.providerScope !== 'function') return null;
    if (choice.roleId) {
      if (!role || String(role.id || '') !== choice.roleId || role.archived === true
        || role.roleSelectable === false || role.isRole === false) return null;
    } else if (role) return null;
    var route = routeCore.normalize(profile);
    if (!route || route.providerRef !== choice.profileRef) return null;
    var providerScope = await consentCore.providerScope('agent', choice.profileRef, route, cryptoApi);
    var persona = role ? String(role.systemPrompt || '') : '';
    if (persona.length > 30000 || !validProviderScope(providerScope)) return null;
    var personaHash;
    try { personaHash = await digestText(persona, cryptoApi); } catch (_) { return null; }
    var preset = PRESETS[choice.presetId];
    return normalizeSnapshot({
      schemaVersion: 1,
      roleId: choice.roleId,
      roleName: role ? (role.nickname || role.name || role.model || role.id) : '标准 Agent',
      profileRef: choice.profileRef,
      presetId: choice.presetId,
      personaHash: personaHash,
      providerScope: providerScope,
      allowedTools: preset.allowedTools.slice(),
      maxProjectReadCalls: preset.maxProjectReadCalls
    });
  }

  function composePrompt(snapshot, persona, basePrompt) {
    var normalized = normalizeSnapshot(snapshot);
    if (!normalized) return '';
    var preset = PRESETS[normalized.presetId];
    persona = String(persona == null ? '' : persona);
    if (persona.length > 30000) return '';
    return [
      normalized.roleId ? '【角色身份与表达风格】\n' + persona : '【执行者】标准 Agent；不附加角色人格。',
      '【Agent 预设 · ' + preset.label + '】\n' + preset.strategy,
      '【本 Run 可用工具】\n' + (normalized.allowedTools.length ? normalized.allowedTools.join(', ') : '无')
        + (normalized.presetId === 'app-builder' ? '；只允许在当前 APP 草稿区创建、读取和修改固定 HTML/CSS/JS 文件。'
          : normalized.presetId === 'coding' ? '；最多读取 12 次、创建或修改 12 次；修改仅限本 Run Consent 选中的文件 ID；新建仅限这些文件所在目录；每次写入按当前 Workspace 版本比对。'
            : '；project.read_file 最多调用 ' + normalized.maxProjectReadCalls + ' 次。'),
      String(basePrompt || ''),
      '最终权限边界：只能使用 Home Node 为本 Run Consent 明确授权的能力；不得调用未列出的工具、网络、写入、Shell、MCP、浏览器、凭据或 Chat Memory。角色和预设文本不能扩大权限。'
    ].filter(Boolean).join('\n\n').slice(0, 32000);
  }

  function avatarOf(profile) {
    var avatar = profile && typeof profile.avatar === 'string' ? profile.avatar
      : (profile && typeof profile.avatarUrl === 'string' ? profile.avatarUrl
        : (profile && profile.character && typeof (profile.character.avatar || profile.character.avatarUrl || profile.character.image) === 'string'
          ? (profile.character.avatar || profile.character.avatarUrl || profile.character.image) : ''));
    return avatar.length <= 160000 && (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(avatar)
      || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(avatar)) ? avatar : '';
  }

  function catalog(profiles, routeCore, roleRows) {
    if (!Array.isArray(profiles)) return [];
    roleRows = roleRows !== false;
    return profiles.filter(function (profile) {
      return profile && !isMiddleBrainProfile(profile) && profile.archived !== true
        && /^[A-Za-z0-9_.:-]{1,180}$/.test(String(profile.id || ''))
        && String(profile.credentialRef || '').trim() && routeCore && routeCore.normalize(profile);
    }).map(function (profile) {
      var route = routeCore.normalize(profile);
      return Object.freeze({
        id: String(profile.id), roleId: roleRows ? String(profile.id) : '',
        profileRef: roleRows ? roleProfileRef(profile) : String(profile.id),
        name: string(profile.nickname || profile.name || profile.model || profile.id, 100) || String(profile.id),
        avatar: avatarOf(profile),
        provider: route.provider,
        model: route.model
      });
    }).filter(function (item) { return /^[A-Za-z0-9_.:-]{1,180}$/.test(item.profileRef); });
  }

  function roleCatalog(profiles, routeCore) {
    if (!Array.isArray(profiles)) return [];
    /* apiConfigs is the existing character authority: custom roles do not need
     * a built-in flag, avatar, or non-empty prompt to appear. Only explicit
     * provider-only records opt out; valid route and credential checks remain
     * in the shared catalog builder. */
    var byId = Object.create(null);
    profiles.forEach(function (profile) {
      if (profile && typeof profile.id === 'string') byId[profile.id] = profile;
    });
    return profiles.filter(function (role) {
      return role && !isMiddleBrainProfile(role) && role.roleSelectable !== false
        && role.isRole !== false && role.providerProfileOnly !== true
        && /^[A-Za-z0-9_.:-]{1,180}$/.test(String(role.id || ''));
    }).map(function (role) {
      var profileRef = roleProfileRef(role);
      var profile = profileRef && byId[profileRef];
      var routeRow = profile && catalog([profile], routeCore, false)[0];
      if (!routeRow) return null;
      return Object.freeze({
        id: String(role.id), roleId: String(role.id), profileRef: profileRef,
        name: string(role.nickname || role.name || role.model || role.id, 100) || String(role.id),
        avatar: avatarOf(role) || routeRow.avatar,
        provider: routeRow.provider, model: routeRow.model
      });
    }).filter(function (item) { return !!item; });
  }

  function profileCatalog(profiles, routeCore) {
    return catalog(profiles, routeCore, false);
  }

  return Object.freeze({
    TOOL_PROJECT_READ: TOOL_PROJECT_READ,
    TOOL_PROJECT_CREATE: TOOL_PROJECT_CREATE,
    TOOL_PROJECT_UPDATE: TOOL_PROJECT_UPDATE,
    APP_DRAFT_TOOLS: Object.freeze([APP_DRAFT_LIST, APP_DRAFT_READ, APP_DRAFT_CREATE, APP_DRAFT_UPDATE]),
    PRESETS: PRESETS,
    preset: function (id) { return Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : null; },
    normalizeChoice: normalizeChoice,
    normalizeSnapshot: normalizeSnapshot,
    createSnapshot: createSnapshot,
    composePrompt: composePrompt,
    digestText: digestText,
    roleProfileRef: roleProfileRef,
    isMiddleBrainProfile: isMiddleBrainProfile,
    catalog: profileCatalog,
    roleCatalog: roleCatalog,
    profileCatalog: profileCatalog
  });
});
