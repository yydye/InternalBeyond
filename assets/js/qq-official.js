'use strict';

(function (NS) {
  'use strict';

  var STORAGE_KEY = 'ib_qq_official_settings_v1';
  var MIGRATION_SCHEMA = 'internalbeyond.qq-official-config';
  var MIGRATION_SCHEMA_VERSION = 1;
  var COMMAND_PROFILE = 'qq-official-p2.1-text-v1';
  var MIGRATION_FILE_MAX_BYTES = 1024 * 1024;
  var APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var OPEN_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
  var DEFAULT_SESSION_ID = 'default';
  var SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  var state = loadState();
  var statusByAppId = Object.create(null);
  var resumeConnectedByAppId = Object.create(null);
  var homeNodeRecovery = null;
  var replyErrors = Object.create(null);
  var transportError = '';
  var hasHomeNodeResponse = false;
  var consecutiveStatusFailures = 0;
  var configSyncError = '';
  var notice = '';
  var noticeKind = 'info';
  var initialized = false;
  var stopped = false;
  var pollTimer = null;
  var pollFailureCount = 0;
  var statusRefreshInFlight = null;
  var POLL_FAILURE_NOTICE = 'QQ 消息轮询暂时异常，正在自动重试。';
  var connectionActionRevision = 0;
  var connectionNotice = null;
  var lastStatusActionRevision = 0;
  var configInFlight = Promise.resolve();
  var pendingMigration = null;
  var peerSessionRevision = Object.create(null);
  var providerQueuesByPeer = Object.create(null);
  var activeSendsByPeer = Object.create(null);

  function remote() { return NS.homeNode && NS.homeNode.qqOfficial || null; }
  function roleApi() { return NS.qqOnebot || null; }
  function noteHomeNodeResponse() {
    hasHomeNodeResponse = true;
    consecutiveStatusFailures = 0;
    if (transportError) {
      transportError = '';
      renderAccountStatus();
    }
  }
  function noteStatusFailure(error) {
    consecutiveStatusFailures += 1;
    /* After a successful Home Node response, one slow status read is a transient
       request failure, not proof that every local service disconnected. Require
       two consecutive failed status reads before changing the connection badge. */
    if (!hasHomeNodeResponse || consecutiveStatusFailures >= 2) {
      transportError = String(error || 'home-node-unreachable');
      renderAccountStatus();
    }
  }
  function notePollFailure() {
    pollFailureCount += 1;
    if (pollFailureCount >= 3 && (!notice || notice === POLL_FAILURE_NOTICE)) {
      setNotice(POLL_FAILURE_NOTICE, 'error');
    }
  }
  function clearPollFailure() {
    if (!pollFailureCount) return;
    pollFailureCount = 0;
    if (notice === POLL_FAILURE_NOTICE) setNotice('', 'info');
  }
  function host() { return typeof document !== 'undefined' ? document.getElementById('qq-official-app') : null; }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function accountId(appId) { return 'qqofficial_' + String(appId || '').trim(); }
  function credentialRef(appId) { return 'qqofficial:' + String(appId || '').trim(); }
  function parseOpenIds(value) {
    var input = Array.isArray(value) ? value : String(value || '').split(/[\s,，;；]+/);
    var result = [], seen = Object.create(null);
    input.forEach(function (item) {
      var id = String(item == null ? '' : item).trim();
      if (OPEN_ID_RE.test(id) && !seen[id] && result.length < 20) { seen[id] = true; result.push(id); }
    });
    return result;
  }
  function parseLocalLabels(value) {
    var result = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    Object.keys(value).slice(0, 200).forEach(function (key) {
      var id = String(key || '').trim();
      var label = String(value[key] == null ? '' : value[key]).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (/^[^\s\u0000-\u001f\u007f]{1,2048}$/u.test(id) && label) result[id] = label;
    });
    return result;
  }
  function parseGroupBindings(values) {
    var result = [], seen = Object.create(null);
    (Array.isArray(values) ? values.slice(0, 32) : []).forEach(function (row) {
      var groupOpenId = String(row && row.groupOpenId || '').trim();
      if (!OPEN_ID_RE.test(groupOpenId) || seen[groupOpenId]) return;
      seen[groupOpenId] = true;
      result.push({
        groupOpenId: groupOpenId,
        roleId: String(row && row.roleId || '').slice(0, 160),
        takeover: row && row.takeover === true,
        adminMemberOpenIds: parseOpenIds(row && row.adminMemberOpenIds),
        sessionId: parseSessionId(row && row.sessionId)
      });
    });
    return result;
  }
  function parseSessionId(value) {
    var id = String(value || '').trim();
    return !id || id === DEFAULT_SESSION_ID || SESSION_ID_RE.test(id) ? (id || DEFAULT_SESSION_ID) : DEFAULT_SESSION_ID;
  }
  function parsePrivateRoleSelections(values, allowedUserOpenIds) {
    var allowed = new Set(parseOpenIds(allowedUserOpenIds));
    var result = [], seen = Object.create(null);
    (Array.isArray(values) ? values.slice(0, 20) : []).forEach(function (row) {
      var userOpenId = String(row && row.userOpenId || '').trim();
      var roleId = String(row && row.roleId || '').trim().slice(0, 160);
      if (!OPEN_ID_RE.test(userOpenId) || !allowed.has(userOpenId) || !roleId || seen[userOpenId]) return;
      seen[userOpenId] = true;
      result.push({ userOpenId: userOpenId, roleId: roleId, sessionId: parseSessionId(row && row.sessionId) });
    });
    return result;
  }
  function loadState() {
    var fallback = { paused: true, accounts: [] };
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) return fallback;
      return {
        paused: parsed.paused !== false,
        accounts: parsed.accounts.slice(0, 16).map(function (row) {
          var appId = String(row && row.appId || '').trim();
          return {
            appId: appId,
            displayName: String(row && row.displayName || '').trim().slice(0, 80),
            roleId: String(row && row.roleId || '').slice(0, 160),
            takeover: row && row.takeover === true,
            allowedUserOpenIds: parseOpenIds(row && row.allowedUserOpenIds),
            privateRoleSelections: parsePrivateRoleSelections(row && row.privateRoleSelections, row && row.allowedUserOpenIds),
            groups: parseGroupBindings(row && row.groups),
            userNotes: parseLocalLabels(row && row.userNotes),
            groupNotes: parseLocalLabels(row && row.groupNotes),
            memberNames: parseLocalLabels(row && row.memberNames),
            combinedIntentConsent: row && row.combinedIntentConsent === true,
            credentialSaved: row && row.credentialSaved === true,
            sourceDisconnectRequired: row && row.sourceDisconnectRequired === true,
            sourceDisconnectedConfirmed: row && row.sourceDisconnectedConfirmed === true
          };
        }).filter(function (row, index, rows) {
          return APP_ID_RE.test(row.appId) && rows.findIndex(function (other) { return other.appId === row.appId; }) === index;
        })
      };
    } catch (_) { return fallback; }
  }
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        paused: state.paused !== false,
        accounts: state.accounts.map(function (row) {
          return {
            appId: row.appId,
            displayName: String(row.displayName || '').trim().slice(0, 80),
            roleId: row.roleId,
            takeover: row.takeover === true,
            allowedUserOpenIds: parseOpenIds(row.allowedUserOpenIds),
            privateRoleSelections: parsePrivateRoleSelections(row.privateRoleSelections, row.allowedUserOpenIds),
            groups: parseGroupBindings(row.groups),
            userNotes: parseLocalLabels(row.userNotes),
            groupNotes: parseLocalLabels(row.groupNotes),
            memberNames: parseLocalLabels(row.memberNames),
            combinedIntentConsent: row.combinedIntentConsent === true,
            credentialSaved: row.credentialSaved === true,
            sourceDisconnectRequired: row.sourceDisconnectRequired === true,
            sourceDisconnectedConfirmed: row.sourceDisconnectedConfirmed === true
          };
        })
      }));
      return true;
    } catch (_) { return false; }
  }
  function migrationObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function migrationAssertKeys(value, allowed, label) {
    if (!migrationObject(value)) throw new Error('migration-shape-invalid');
    Object.keys(value).forEach(function (key) {
      if (/^(appsecret|apikey|token|credential|credentialref|credentialid)$/i.test(key)) throw new Error('migration-credential-field-forbidden');
      if (!allowed.includes(key)) throw new Error(label + '-field-unsupported');
    });
  }
  function migrationString(value, maxLength, allowEmpty) {
    if (typeof value !== 'string' || value.length > maxLength) throw new Error('migration-field-invalid');
    var text = value.trim();
    if (!allowEmpty && !text) throw new Error('migration-field-invalid');
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('migration-field-invalid');
    return text;
  }
  function migrationBoolean(value) {
    if (typeof value !== 'boolean') throw new Error('migration-field-invalid');
    return value;
  }
  function migrationOpenIds(value, maxCount) {
    if (!Array.isArray(value) || value.length > maxCount) throw new Error('migration-id-list-invalid');
    var seen = Object.create(null);
    return value.map(function (item) {
      var id = migrationString(item, 512, false);
      if (!OPEN_ID_RE.test(id) || seen[id]) throw new Error('migration-id-list-invalid');
      seen[id] = true;
      return id;
    });
  }
  function migrationLabels(value) {
    if (!migrationObject(value) || Object.keys(value).length > 200) throw new Error('migration-labels-invalid');
    var result = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!/^[^\s\u0000-\u001f\u007f]{1,2048}$/u.test(key)) throw new Error('migration-labels-invalid');
      var label = migrationString(value[key], 80, true).replace(/\s+/g, ' ');
      if (label) result[key] = label;
    });
    return result;
  }
  function validateMigrationBundle(value) {
    migrationAssertKeys(value, ['schema', 'schemaVersion', 'commandProfile', 'paused', 'roleLabels', 'accounts'], 'migration');
    if (value.schema !== MIGRATION_SCHEMA || value.schemaVersion !== MIGRATION_SCHEMA_VERSION) throw new Error('migration-schema-invalid');
    if (value.commandProfile !== COMMAND_PROFILE) throw new Error('migration-command-profile-unsupported');
    if (!Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > 16) throw new Error('migration-account-count-invalid');
    if (!migrationObject(value.roleLabels) || Object.keys(value.roleLabels).length > 256) throw new Error('migration-labels-invalid');
    var roleLabels = Object.create(null);
    Object.keys(value.roleLabels).forEach(function (roleId) {
      if (!/^[^\u0000-\u001f\u007f]{1,160}$/.test(roleId)) throw new Error('migration-field-invalid');
      roleLabels[roleId] = migrationString(value.roleLabels[roleId], 80, true);
    });
    var seenApps = Object.create(null);
    var accounts = value.accounts.map(function (row) {
      migrationAssertKeys(row, ['appId', 'displayName', 'roleId', 'takeover', 'allowedUserOpenIds', 'privateRoleSelections', 'groups', 'userNotes', 'groupNotes', 'memberNames'], 'migration-account');
      var appId = migrationString(row.appId, 64, false);
      if (!APP_ID_RE.test(appId) || seenApps[appId]) throw new Error('migration-duplicate-app-id');
      seenApps[appId] = true;
      var allowedUserOpenIds = migrationOpenIds(row.allowedUserOpenIds, 20);
      var privateRoleSelections = Array.isArray(row.privateRoleSelections) ? row.privateRoleSelections : null;
      if (!privateRoleSelections || privateRoleSelections.length > 20) throw new Error('migration-shape-invalid');
      var seenPrivate = Object.create(null);
      privateRoleSelections = privateRoleSelections.map(function (selection) {
        migrationAssertKeys(selection, ['userOpenId', 'roleId'], 'migration-private-role');
        var userOpenId = migrationString(selection.userOpenId, 512, false);
        var roleId = migrationString(selection.roleId, 160, false);
        if (!OPEN_ID_RE.test(userOpenId) || !allowedUserOpenIds.includes(userOpenId) || seenPrivate[userOpenId]
          || !/^[^\u0000-\u001f\u007f]{1,160}$/.test(roleId)) throw new Error('migration-private-role-invalid');
        seenPrivate[userOpenId] = true;
        return { userOpenId: userOpenId, roleId: roleId };
      });
      if (!Array.isArray(row.groups) || row.groups.length > 32) throw new Error('migration-shape-invalid');
      var seenGroups = Object.create(null);
      var groups = row.groups.map(function (group) {
        migrationAssertKeys(group, ['groupOpenId', 'roleId', 'takeover', 'adminMemberOpenIds'], 'migration-group');
        var groupOpenId = migrationString(group.groupOpenId, 512, false);
        var groupRoleId = migrationString(group.roleId, 160, true);
        if (!OPEN_ID_RE.test(groupOpenId) || seenGroups[groupOpenId]
          || (groupRoleId && !/^[^\u0000-\u001f\u007f]{1,160}$/.test(groupRoleId))) throw new Error('migration-group-invalid');
        seenGroups[groupOpenId] = true;
        return {
          groupOpenId: groupOpenId,
          roleId: groupRoleId,
          takeover: migrationBoolean(group.takeover),
          adminMemberOpenIds: migrationOpenIds(group.adminMemberOpenIds, 20)
        };
      });
      var roleId = migrationString(row.roleId, 160, false);
      if (!/^[^\u0000-\u001f\u007f]{1,160}$/.test(roleId)) throw new Error('migration-field-invalid');
      return {
        appId: appId,
        displayName: migrationString(row.displayName, 80, true),
        roleId: roleId,
        takeover: migrationBoolean(row.takeover),
        allowedUserOpenIds: allowedUserOpenIds,
        privateRoleSelections: privateRoleSelections,
        groups: groups,
        userNotes: migrationLabels(row.userNotes),
        groupNotes: migrationLabels(row.groupNotes),
        memberNames: migrationLabels(row.memberNames)
      };
    });
    return { schema: MIGRATION_SCHEMA, schemaVersion: MIGRATION_SCHEMA_VERSION, commandProfile: COMMAND_PROFILE,
      paused: migrationBoolean(value.paused), roleLabels: roleLabels, accounts: accounts };
  }
  function migrationExportBundle() {
    if (!state.accounts.length) throw new Error('migration-no-accounts');
    var roleIds = Object.create(null);
    var accounts = state.accounts.map(function (account) {
      var roleId = String(account.roleId || '');
      if (roleId) roleIds[roleId] = true;
      var privateRoleSelections = parsePrivateRoleSelections(account.privateRoleSelections, account.allowedUserOpenIds).map(function (row) {
        roleIds[row.roleId] = true;
        return { userOpenId: row.userOpenId, roleId: row.roleId };
      });
      var groups = parseGroupBindings(account.groups).map(function (group) {
        if (group.roleId) roleIds[group.roleId] = true;
        return { groupOpenId: group.groupOpenId, roleId: group.roleId, takeover: group.takeover,
          adminMemberOpenIds: group.adminMemberOpenIds.slice() };
      });
      return { appId: account.appId, displayName: account.displayName, roleId: roleId, takeover: account.takeover === true,
        allowedUserOpenIds: parseOpenIds(account.allowedUserOpenIds), privateRoleSelections: privateRoleSelections, groups: groups,
        userNotes: parseLocalLabels(account.userNotes), groupNotes: parseLocalLabels(account.groupNotes), memberNames: parseLocalLabels(account.memberNames) };
    });
    var snapshot = roleCatalogSnapshot(roleApi());
    var labelById = Object.create(null);
    if (snapshot && Array.isArray(snapshot.roles)) snapshot.roles.forEach(function (role) {
      if (role && role.id) labelById[String(role.id)] = roleDisplayName(role);
    });
    var roleLabels = Object.create(null);
    Object.keys(roleIds).forEach(function (roleId) { roleLabels[roleId] = labelById[roleId] || roleId; });
    return { schema: MIGRATION_SCHEMA, schemaVersion: MIGRATION_SCHEMA_VERSION, commandProfile: COMMAND_PROFILE,
      paused: state.paused === true, roleLabels: roleLabels, accounts: accounts };
  }
  function findAccount(appId) {
    return state.accounts.find(function (row) { return row.appId === String(appId || ''); }) || null;
  }
  function groupBinding(account, groupOpenId) {
    var id = String(groupOpenId || '').trim();
    return account && Array.isArray(account.groups)
      ? account.groups.find(function (group) { return group.groupOpenId === id; }) || null : null;
  }
  function privateRoleSelection(account, userOpenId) {
    var id = String(userOpenId || '').trim();
    return account && Array.isArray(account.privateRoleSelections)
      ? account.privateRoleSelections.find(function (row) { return row.userOpenId === id; }) || null : null;
  }
  function currentRoleSession(account, event) {
    if (!account || !event) return { roleId: '', sessionId: DEFAULT_SESSION_ID };
    if (event.messageType === 'group') {
      var group = groupBinding(account, event.groupOpenId || event.peerId);
      return group ? { roleId: group.roleId, sessionId: group.sessionId || DEFAULT_SESSION_ID } : { roleId: '', sessionId: DEFAULT_SESSION_ID };
    }
    var selection = privateRoleSelection(account, event.senderId);
    return selection
      ? { roleId: selection.roleId, sessionId: selection.sessionId || DEFAULT_SESSION_ID }
      : { roleId: account.roleId, sessionId: DEFAULT_SESSION_ID };
  }
  function accountHandlesEvent(account, event) {
    if (!account || !event) return false;
    var current = currentRoleSession(account, event);
    if (current.roleId !== String(event.roleId || '')
      || current.sessionId !== String(event.sessionId || DEFAULT_SESSION_ID)) return false;
    if (event.messageType === 'group') {
      var groupId = String(event.groupOpenId || event.peerId || '').trim();
      var group = groupBinding(account, groupId);
      return !!group && group.takeover === true && !!group.roleId
        && group.roleId === String(event.roleId || '')
        && !!String(event.senderId || '').trim()
        && (event.canManageConversation !== true || group.adminMemberOpenIds.includes(String(event.senderId || '')))
        && /^member-[a-f0-9]{12}$/.test(String(event.senderRef || ''));
    }
    return event.messageType === 'private' && account.takeover === true
      && account.allowedUserOpenIds.includes(String(event.senderId || ''));
  }
  function accountHasTakeover(account) {
    return !!account && (account.takeover === true || (Array.isArray(account.groups)
      && account.groups.some(function (group) { return group && group.takeover === true && !!group.roleId; })));
  }
  function accountsForServer() {
    return state.accounts.map(function (row) {
      return {
        appId: row.appId,
        roleId: row.roleId,
        takeover: row.takeover === true,
        combinedIntentConsent: row.combinedIntentConsent === true,
        allowedUserOpenIds: parseOpenIds(row.allowedUserOpenIds),
        privateRoleSelections: parsePrivateRoleSelections(row.privateRoleSelections, row.allowedUserOpenIds),
        groups: parseGroupBindings(row.groups)
      };
    });
  }
  function setNotice(message, kind) {
    connectionActionRevision += 1;
    connectionNotice = null;
    notice = String(message || '');
    noticeKind = kind || 'info';
    render();
  }
  function connectionNoticeCurrent(revision) {
    return !!connectionNotice && connectionNotice.revision === revision
      && connectionActionRevision === revision;
  }
  function beginConnectionNotice(appId, action, message) {
    var revision = ++connectionActionRevision;
    connectionNotice = { appId: String(appId || ''), action: action, revision: revision };
    notice = message;
    noticeKind = 'info';
    render();
    return revision;
  }
  function updateConnectionNotice(revision, message, kind, finished) {
    if (!connectionNoticeCurrent(revision)) return false;
    var nextNotice = String(message || '');
    var nextKind = kind || 'info';
    var changed = notice !== nextNotice || noticeKind !== nextKind;
    notice = nextNotice;
    noticeKind = nextKind;
    if (finished) connectionNotice = null;
    if (changed) render();
    return true;
  }
  function clearConnectionNotice(revision) {
    if (!connectionNoticeCurrent(revision)) return false;
    connectionNotice = null;
    notice = '';
    noticeKind = 'info';
    render();
    return true;
  }
  function reflectConnectionNotice(statusRevision) {
    var current = connectionNotice;
    if (!current || current.revision !== connectionActionRevision || current.revision > statusRevision) return;
    var row = statusByAppId[current.appId];
    if (!row) return;
    var accountState = String(row.state || 'stopped');
    if (current.action === 'connect') {
      if (accountState === 'online' || accountState === 'stale') {
        clearConnectionNotice(current.revision);
      } else if (accountState === 'reconnecting') {
        updateConnectionNotice(current.revision, 'QQ 官方服务正在重连…', 'info');
      } else if (accountState === 'failed') {
        updateConnectionNotice(current.revision, errorLabel(row.lastError || 'official-start-failed'), 'error');
      } else {
        updateConnectionNotice(current.revision, '正在连接 QQ 官方服务…', 'info');
      }
    } else if (current.action === 'disconnect') {
      if (accountState === 'stopped') {
        updateConnectionNotice(current.revision, '官方 Bot 已断开；角色、白名单和 Vault 密钥仍保留。', 'info', true);
      } else if (accountState === 'failed') {
        updateConnectionNotice(current.revision, errorLabel(row.lastError || 'official-disconnect-failed'), 'error');
      } else {
        updateConnectionNotice(current.revision, '正在断开官方 Bot…', 'info');
      }
    }
  }
  function clearRecoveryNotice() {
    notice = '';
    noticeKind = 'info';
    var root = host();
    var node = root && typeof root.querySelector === 'function'
      ? root.querySelector('.qq-official-notice') : null;
    if (node && node.parentNode) node.parentNode.removeChild(node);
    else if (root) render();
  }
  function syncConfig() {
    var api = remote();
    if (!api || typeof api.configure !== 'function') return Promise.resolve({ ok: false, error: 'qq-official-remote-missing' });
    configInFlight = configInFlight.catch(function () {}).then(function () {
      return api.configure({ paused: state.paused === true, accounts: accountsForServer() });
    });
    return configInFlight.then(function (result) {
      if (!result || result.ok !== true) {
        configSyncError = String(result && result.error || 'home-node-unreachable');
        setNotice('本地服务未连接，QQ 设置尚未同步。', 'error');
      } else configSyncError = '';
      return result;
    }, function () {
      configSyncError = 'home-node-unreachable';
      setNotice('本地服务未连接，QQ 设置尚未同步。', 'error');
      return { ok: false, error: 'home-node-unreachable' };
    });
  }
  function rememberConnectionStates(rows) {
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var appId = String(row && row.appId || '');
      if (!appId || !findAccount(appId)) return;
      if (row.state === 'online' || row.state === 'connecting' || row.state === 'reconnecting') {
        resumeConnectedByAppId[appId] = true;
      } else if (row.state === 'stopped' || row.state === 'failed') {
        resumeConnectedByAppId[appId] = false;
      }
    });
    Object.keys(resumeConnectedByAppId).forEach(function (appId) {
      if (!findAccount(appId)) delete resumeConnectedByAppId[appId];
    });
  }
  function reconcileHomeNodeAccounts(api, rows) {
    if (homeNodeRecovery) return homeNodeRecovery;
    var remoteByAppId = Object.create(null);
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (row && row.appId) remoteByAppId[String(row.appId)] = row;
    });
    var needsConfig = state.accounts.some(function (account) { return !remoteByAppId[account.appId]; })
      || Object.keys(remoteByAppId).some(function (appId) { return !findAccount(appId); });
    if (!needsConfig) return Promise.resolve({ ok: true, accounts: rows });

    var reconnectAppIds = state.accounts.filter(function (account) {
      return resumeConnectedByAppId[account.appId] === true && account.combinedIntentConsent === true
        && (!account.sourceDisconnectRequired || account.sourceDisconnectedConfirmed === true);
    }).map(function (account) { return account.appId; });
    homeNodeRecovery = (async function () {
      var configured = await syncConfig();
      if (!configured || configured.ok !== true) return configured || { ok: false, error: 'home-node-unreachable' };
      for (var index = 0; index < reconnectAppIds.length; index++) {
        var appId = reconnectAppIds[index];
        if (!findAccount(appId)) continue;
        var result;
        try { result = await api.connect(appId); }
        catch (_) { result = { ok: false, error: 'home-node-unreachable' }; }
        if (!result || result.ok !== true) {
          replyErrors[appId] = result && result.error || 'official-start-failed';
        }
      }
      try { return await api.status(); }
      catch (_) { return { ok: false, error: 'home-node-unreachable' }; }
    })().finally(function () { homeNodeRecovery = null; });
    return homeNodeRecovery;
  }
  function roleOptions(selected) {
    var api = roleApi();
    return api && typeof api._roleOptions === 'function'
      ? api._roleOptions(selected)
      : '<option value="" selected disabled>角色目录暂不可用</option>';
  }
  function roleAvailability(roleId) {
    var api = roleApi();
    var role = { id: String(roleId || '') };
    if (!api || typeof api._roleAvailability !== 'function') return { available: false, reason: '角色目录暂不可用' };
    try { return api._roleAvailability(role); } catch (_) { return { available: false, reason: '角色配置检查失败' }; }
  }
  function stateLabel(appId) {
    var row = statusByAppId[String(appId)] || {};
    if (transportError) return '本地服务未连接';
    if (!row.state || row.state === 'stopped') return '已断开';
    if (row.state === 'connecting') return '正在连接';
    if (row.state === 'online') return '已连接';
    if (row.state === 'reconnecting') return '正在重连';
    if (row.state === 'stopping') return '正在断开';
    if (row.state === 'stale') return '已连接，等待授权消息';
    if (row.state === 'failed') return '连接失败';
    return '状态暂不可用';
  }
  function errorLabel(error) {
    var labels = {
      'credential-vault-unavailable': '角色 Provider 的 API Key 未配置或无法读取。',
      'credential-vault-provider-mismatch': 'Bot 凭据无法读取；请在高级设置中更新 AppSecret。',
      'official-sdk-unavailable': '本机 QQ 组件未就绪；请查看高级诊断。',
      'official-invalid-credentials': 'AppID 或 AppSecret 未通过 QQ 平台验证。',
      'official-app-not-authorized': 'QQ 平台尚未允许当前机器人使用此消息场景。',
      'official-intent-not-accepted': 'QQ 平台未允许当前消息场景；请检查机器人开发体验设置。',
      'combined-intent-consent-required': '请先确认此 Bot 的消息接入范围。',
      'official-network-error': 'QQ 服务连接中断，正在重试。',
      'official-start-failed': 'QQ Bot 连接失败；请检查凭据和本机网络。',
      'official-send-failed': 'QQ 平台没有接受这条回复，消息未送达。',
      'provider-unavailable': '所选角色的 Provider 尚未准备好。',
      'role-config-unavailable': '所选角色设置不完整，消息未发送。',
      'role-unavailable': '所选角色已不可用，请重新选择。',
      'context-failed': '准备角色对话时出错，消息未发送。',
      'invalid-event': '这条消息暂时无法处理。',
      'provider-failed': '角色 Provider 请求失败。',
      'empty-output': '角色没有生成可发送的文本。',
      'vision-unavailable': '绑定角色的视觉能力不可用；图片未交给文字模型，普通文字消息不受影响。',
      'image-input-invalid': '图片内容未通过本地输入校验；未交给 Provider。',
      'image-output-invalid': 'Provider 返回的图片格式或大小无效；图片未发送。',
      'image-output-disabled': '该角色未启用图片生成能力；Provider 图片未发送。',
      'image-source-rejected': 'QQ 图片来源未通过本地安全校验；未下载或调用模型。',
      'image-download-failed': '图片下载失败或超时；未调用模型，普通文字消息不受影响。',
      'image-source-domain-rejected': '图片来源域名不在腾讯图片白名单中；未下载或调用模型。',
      'image-source-protocol-rejected': '图片来源未使用受信任的 HTTPS 地址；未下载或调用模型。',
      'image-redirect-rejected': '图片下载跳转到未允许的地址或跳转次数超限；已拒绝。',
      'image-dns-failed': '无法解析 QQ 图片来源域名；未调用模型。',
      'image-dns-rejected': '图片来源域名解析到非公网地址；已按安全策略拒绝。',
      'image-download-timeout': 'QQ 图片下载超过 10 秒；未调用模型，可稍后重试。',
      'image-http-rejected': 'QQ 图片服务器拒绝下载请求；未调用模型。',
      'image-network-failed': '连接 QQ 图片服务器失败；未调用模型。',
      'image-network-unreachable': '本机到 QQ 图片服务器的网络路由不可达；未调用模型。',
      'image-ipv6-unreachable': '本机 IPv6 路由不可达，无法连接 QQ 图片服务器；未调用模型。',
      'image-connection-refused': 'QQ 图片服务器拒绝建立连接；未调用模型。',
      'image-connection-reset': '下载连接被中途重置；未调用模型。',
      'image-connection-closed': '下载连接在图片完整接收前关闭；未调用模型。',
      'image-address-family-unavailable': '本机网络接口不支持本次下载所需的地址类型；未调用模型。',
      'image-lookup-result-invalid': '本机固定 DNS 结果未被 Node 网络层接受；请求已中止。',
      'image-tls-failed': 'QQ 图片 HTTPS 证书校验失败；未调用模型。',
      'image-attachment-invalid': 'QQ 图片事件缺少有效附件地址或类型字段；未调用模型。',
      'image-type-mismatch': '附件声明类型与图片文件签名不一致；已拒绝。',
      'image-too-large': '图片超过本地处理上限；未调用模型。',
      'image-type-unsupported': '图片格式不支持；请发送 JPEG、PNG 或 WebP。',
      'attachments-unsupported': '当前仅支持图片和文字消息，不支持其他附件。',
      'message-not-allowed': '此私聊用户尚未批准。',
      'group-not-allowed': '此群尚未批准；消息内容未交给 AI。',
      'group-role-required': '请先为此群绑定可用角色，再开启 AI 接管。',
      'invalid-group-list': '群授权列表格式无效或超过数量上限。',
      'invalid-group-binding': '群绑定字段无效。',
      'invalid-group-openid': '群 OpenID 格式无效。',
      'duplicate-group-openid': '群 OpenID 重复。',
      'invalid-group-admin-list': '群指令管理者列表格式无效或超过 20 人。',
      'invalid-group-admin-openid': '群指令管理者成员 OpenID 格式无效。',
      'duplicate-group-admin-openid': '群指令管理者 OpenID 重复。',
      'invalid-private-role-selection-list': '私聊角色选择列表超过数量上限。',
      'invalid-private-role-selection': '私聊用户角色选择无效。',
      'duplicate-private-role-selection': '同一私聊用户不能有重复角色选择。',
      'invalid-session-id': 'QQ 会话标识无效。',
      'request-timeout': '消息在本机处理超时；请检查本地服务与角色 Provider。',
      'queue-full': '本机 QQ 待处理队列已满；稍后重试。',
      'home-node-unreachable': '本地服务未连接，请检查 IB 服务状态。',
      'takeover-paused': '接管已暂停；此消息未发送。',
      'official-stopped': '官方连接已断开；此消息未发送。'
    };
    return labels[String(error || '')] || (error ? '处理失败；请展开高级设置查看原因。' : '官方 QQ 连接失败。');
  }
  function stageLabel(row) {
    var stages = {
      'websocket-connecting': '正在建立官方 WebSocket 连接',
      'websocket-connected': '官方 WebSocket 已连接',
      'websocket-reconnecting': '官方 WebSocket 正在重连',
      'websocket-disconnected': '官方 WebSocket 已断开',
      'non-c2c-dropped': '最新事件不属于支持的私聊或群聊消息，已在本机首层丢弃',
      'self-echo-dropped': '已忽略 Bot 自身事件',
      'open-id-denied': '最新私聊未命中 OpenID 白名单，未交给角色',
      'group-no-mention': '最新群消息未 @ 此机器人，已在本机首层丢弃',
      'group-not-allowed': '最新 @ 群消息来自未授权群；正文和附件未读取',
      'group-manual': '此群处于人工使用，未交给 Provider',
      'group-paused': '全局接管已暂停，群消息未交给 Provider',
      'global-paused': '全局接管已暂停，未交给 Provider',
      'account-manual': '此账号处于人工使用，未交给 Provider',
      'worker-inactive': '桌面消息处理器未在线，未交给 Provider',
      'invalid-reply-target': '回复目标与原私聊或群消息不匹配，已拒绝发送',
      'attachments-unsupported': '附件类型不受支持，未交给 Provider',
      'image-download-started': '正在安全下载官方消息图片',
      'image-download-succeeded': '图片已通过类型和大小校验',
      'image-download-failed': '图片下载或校验失败，未交给 Provider',
      'image-output-invalid': 'Provider 图片输出无效，未调用 QQ 媒体接口',
      'empty-message': '消息没有可处理的文本',
      'queue-full': '本机待处理队列已满',
      'event-queued': '官方消息已通过授权和接管检查，等待桌面处理',
      'delivered-to-ui': 'Home Node 已将消息交给桌面处理流程',
      'provider-started': '已开始调用绑定角色的 Provider',
      'provider-ready': 'Provider 已生成回复，等待腾讯发送 API',
      'provider-failed': '绑定角色的 Provider 阶段失败',
      'send-started': '正在调用腾讯私聊或群聊发送 API',
      'send-succeeded': '腾讯发送 API 已接受回复',
      'send-failed': '腾讯发送 API 返回失败',
      'media-send-started': '正在通过官方 SDK 上传并发送图片回复',
      'media-send-succeeded': '腾讯官方媒体接口已接受图片回复',
      'media-send-failed': '腾讯官方媒体接口拒绝或未确认图片回复',
      'empty-reply': 'Provider 未生成可发送的文本',
      'queue-timeout': '事件在桌面处理流程取走前超时',
      'client-timeout': '桌面处理流程未及时完成',
      'provider-timeout': '角色 Provider 处理超时',
      'takeover-cancelled': '接管状态改变，待处理回复已取消',
      'official-stopped': '官方 Bot 已停止',
      idle: ''
    };
    return row && stages[String(row.lastStage || 'idle')] || '';
  }
  function statusDetail(account, includeDiagnostics) {
    var row = statusByAppId[account.appId] || {};
    if (replyErrors[account.appId]) return errorLabel(replyErrors[account.appId]);
    if (row.lastError) {
      var detail = '';
      if (row.lastError === 'credential-vault-unavailable' && row.lastStage === 'provider-failed') {
        detail = '角色 Provider API Key 尚未能从 Credential Vault 解析；请检查该角色的 Provider 设置。';
      } else if (row.lastError === 'credential-vault-unavailable' && row.state === 'failed') {
        detail = 'Bot AppSecret 未能从 Credential Vault 读取；请在高级设置中更换凭据。';
      } else detail = errorLabel(row.lastError);
      if (!includeDiagnostics) return detail;
      var response = [];
      if (Number.isInteger(Number(row.lastApiHttpStatus)) && Number(row.lastApiHttpStatus) > 0) {
        response.push('HTTP ' + Number(row.lastApiHttpStatus));
      }
      if (row.lastStage === 'image-download-failed'
        && Number.isInteger(Number(row.lastImageHttpStatus)) && Number(row.lastImageHttpStatus) >= 100) {
        response.push('图片源 HTTP ' + Number(row.lastImageHttpStatus));
      }
      if (row.lastApiBusinessCode != null && row.lastApiBusinessCode !== ''
        && Number.isSafeInteger(Number(row.lastApiBusinessCode))) {
        response.push('腾讯业务码 ' + Number(row.lastApiBusinessCode));
      }
      return detail + (response.length ? '（' + response.join('，') + '）' : '');
    }
    return '';
  }
  function shortOpenId(value) {
    var id = String(value || '').trim();
    return id.length > 6 ? '…' + id.slice(-6) : id;
  }
  function localLabel(map, id) { return map && map[String(id || '')] || ''; }
  function groupMemberNameKey(groupOpenId, memberOpenId) {
    return encodeURIComponent(String(groupOpenId || '')) + '|' + encodeURIComponent(String(memberOpenId || ''));
  }
  function recentGroupMemberNames(account, groupOpenId) {
    var map = account && account.memberNames || {};
    var prefix = encodeURIComponent(String(groupOpenId || '')) + '|';
    return Object.keys(map).filter(function (key) { return key.indexOf(prefix) === 0; })
      .slice(-3).map(function (key) { return String(map[key] || '').trim(); }).filter(Boolean);
  }
  function localNoteInput(kind, id, value, placeholder) {
    return '<label class="qq-official-local-note"><span>本机备注</span><input type="text" maxlength="80" data-qq-local-note-kind="'
      + esc(kind) + '" data-local-id="' + esc(id || '') + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '仅在本机显示') + '"></label>';
  }
  function providerSetupHint(roleId) {
    if (!roleId) return '<div class="qq-official-provider-hint"><span>先选择一个角色</span><p>QQ 接入会复用 IB 现有角色与 Provider 设置。</p>'
      + '<button type="button" class="btn" data-qq-official-action="open-provider-settings">打开角色与 API 设置</button></div>';
    var availability = roleAvailability(roleId);
    if (availability.available) return '';
    return '<div class="qq-official-provider-hint" role="status"><span>此角色还不能回复 QQ 消息</span><p>'
      + esc(availability.reason || '请完成角色 Provider 设置。')
      + '</p><button type="button" class="btn" data-qq-official-action="open-provider-settings">打开角色与 API 设置</button></div>';
  }
  function roleCatalogHintHtml() {
    var api = roleApi();
    var snapshot = null;
    try { snapshot = api && typeof api._roleCatalogSnapshot === 'function' ? api._roleCatalogSnapshot() : null; } catch (_) {}
    if (!snapshot || snapshot.state === 'loading') return '';
    if (snapshot.state === 'unavailable') return '<div class="qq-official-provider-hint"><span>暂时无法读取角色</span><p>角色目录未加载完成，请重试或检查本地服务。</p></div>';
    if (snapshot.state === 'empty' || !Array.isArray(snapshot.roles) || !snapshot.roles.length) {
      return '<div class="qq-official-provider-hint"><span>先添加一个 IB 角色</span><p>QQ 复用现有角色目录，不会创建第二套角色。</p>'
        + '<button type="button" class="btn" data-qq-official-action="open-provider-settings">打开角色与 API 设置</button></div>';
    }
    var ready = snapshot.roles.some(function (role) { return role && roleAvailability(role.id).available; });
    return ready ? '' : '<div class="qq-official-provider-hint"><span>还没有可接入的角色</span>'
      + '<p>请检查角色 Provider、接口地址、模型和 Credential Vault 中的 API Key。</p>'
      + '<button type="button" class="btn" data-qq-official-action="open-provider-settings">打开角色与 API 设置</button></div>';
  }
  function pendingAuthorizationHtml(account) {
    var row = statusByAppId[account.appId] || {};
    var ids = Array.isArray(row.pendingUserOpenIds) ? row.pendingUserOpenIds : [];
    if (!ids.length) return '';
    return '<section class="qq-official-approval"><div class="qq-official-section-head"><div><span class="qq-official-kicker">待处理</span>'
      + '<h5>新的私聊用户</h5><p>选择角色后批准，不会打开接管；若私聊接管已开启且全局未暂停，此用户会按当前设置处理。</p></div><span class="qq-official-count">' + ids.length + '</span></div>'
      + '<div class="qq-official-entity-list">' + ids.map(function (openId) {
        var name = localLabel(account.userNotes, openId);
        var selectedRole = roleAvailability(account.roleId).available ? account.roleId : '';
        return '<article class="qq-official-pending-card" data-pending-user-card data-open-id="' + esc(openId) + '">'
          + '<div class="qq-official-entity-title"><div><strong>' + esc(name || '新 QQ 联系人') + '</strong><span>'
          + esc(name ? '本机备注' : 'QQ 私聊消息未提供昵称') + '</span></div></div>'
          + localNoteInput('user', openId, name, '例如：小林（仅本机显示）')
          + '<label>绑定角色<select data-qq-pending-role>' + roleOptions(selectedRole) + '</select></label>'
          + '<div data-qq-role-hint>' + providerSetupHint(selectedRole) + '</div>'
          + '<button type="button" class="btn btn-primary" data-qq-official-action="approve-user" data-open-id="' + esc(openId) + '"'
          + (selectedRole ? '' : ' disabled') + '>批准此用户</button>'
          + '</article>';
      }).join('') + '</div><p class="qq-official-safety-note">未批准前，消息正文和附件不会进入本机处理流程。</p></section>';
  }
  function pendingGroupAuthorizationHtml(account) {
    var row = statusByAppId[account.appId] || {};
    var ids = Array.isArray(row.pendingGroupOpenIds) ? row.pendingGroupOpenIds : [];
    if (!ids.length) return '';
    return '<section class="qq-official-approval"><div class="qq-official-section-head"><div><span class="qq-official-kicker">待处理</span>'
      + '<h5>新的群聊</h5><p>选择角色后添加为人工使用；群接管保持关闭，之后可逐群开启。</p></div><span class="qq-official-count">' + ids.length + '</span></div>'
      + '<div class="qq-official-entity-list">' + ids.map(function (groupOpenId) {
        var name = localLabel(account.groupNotes, groupOpenId);
        var selectedRole = roleAvailability(account.roleId).available ? account.roleId : '';
        return '<article class="qq-official-pending-card" data-pending-group-card data-group-openid="' + esc(groupOpenId) + '">'
          + '<div class="qq-official-entity-title"><div><strong>' + esc(name || '待授权群聊') + '</strong><span>'
          + esc(name ? '本机备注' : 'QQ 群事件未提供群名称') + '</span></div></div>'
          + localNoteInput('group', groupOpenId, name, '例如：家庭群（仅本机显示）')
          + '<label>绑定角色<select data-qq-pending-role>' + roleOptions(selectedRole) + '</select></label>'
          + '<div data-qq-role-hint>' + providerSetupHint(selectedRole) + '</div>'
          + '<button type="button" class="btn btn-primary" data-qq-official-action="approve-group" data-group-openid="' + esc(groupOpenId) + '"'
          + (selectedRole ? '' : ' disabled') + '>添加为人工使用</button>'
          + '</article>';
      }).join('') + '</div><p class="qq-official-safety-note">未授权群的正文和附件不会进入 Provider；批准也不会开启群接管。</p></section>';
  }
  function pendingGroupAdminAuthorizationHtml(account, group) {
    var status = statusByAppId[account.appId] || {};
    var serverGroup = Array.isArray(status.groups)
      ? status.groups.find(function (row) { return row && row.groupOpenId === group.groupOpenId; }) : null;
    var members = serverGroup && Array.isArray(serverGroup.pendingAdminMemberOpenIds)
      ? serverGroup.pendingAdminMemberOpenIds : [];
    if (!members.length) return '';
    return '<div class="qq-official-group-admin-pending"><strong>待授权群指令管理员</strong><p>仅显示已授权群内 @ 过机器人的成员；此名单只控制 /role 切换与 /reset。</p>'
      + members.map(function (memberOpenId) {
      var name = localLabel(account.memberNames, groupMemberNameKey(group.groupOpenId, memberOpenId));
        return '<div class="qq-official-admin-candidate"><span><strong>' + esc(name || '群成员') + '</strong><small>'
          + esc(name ? '来自 QQ 群消息昵称' : shortOpenId(memberOpenId)) + '</small></span>'
          + '<button type="button" class="btn" data-qq-official-action="authorize-group-admin" data-member-open-id="' + esc(memberOpenId) + '">授权为指令管理员</button></div>';
      }).join('') + '</div>';
  }
  function userListHtml(account) {
    var users = parseOpenIds(account.allowedUserOpenIds);
    if (!users.length) return '<p class="qq-official-empty">尚无已批准私聊用户。收到陌生用户消息后，可在待处理卡片中批准。</p>';
    return '<div class="qq-official-entity-list">' + users.map(function (openId) {
      var note = localLabel(account.userNotes, openId);
      var selection = privateRoleSelection(account, openId);
      var roleId = selection ? selection.roleId : account.roleId;
      var availability = roleId ? roleAvailability(roleId) : { available: false, reason: '尚未绑定角色' };
      return '<article class="qq-official-entity-card" data-user-open-id="' + esc(openId) + '">'
        + '<div class="qq-official-entity-title"><div><strong>' + esc(note || 'QQ 私聊用户') + '</strong><span>'
        + esc(note ? '本机备注' : 'QQ 私聊消息未提供昵称') + '</span></div><span class="qq-official-badge">已批准</span></div>'
        + localNoteInput('user', openId, note, '添加本机备注')
        + '<label>角色<select data-qq-private-role data-user-open-id="' + esc(openId) + '">' + roleOptions(roleId) + '</select></label>'
        + (availability.available ? '' : providerSetupHint(roleId))
        + '<div class="qq-official-entity-actions"><small>私聊接管：' + (account.takeover ? '已开启' : '关闭') + '</small>'
        + '<button type="button" class="btn qq-official-revoke" data-qq-official-action="revoke-user" data-open-id="' + esc(openId) + '">撤销授权</button></div>'
        + '</article>';
    }).join('') + '</div>';
  }
  function groupBindingsHtml(account) {
    var groups = parseGroupBindings(account.groups);
    var rows = groups.map(function (group) {
      var name = localLabel(account.groupNotes, group.groupOpenId);
      var memberNames = recentGroupMemberNames(account, group.groupOpenId);
      var availability = group.roleId ? roleAvailability(group.roleId) : { available: false, reason: '先选择一个可用角色' };
      return '<article class="qq-official-entity-card qq-official-group-row" data-group-openid="' + esc(group.groupOpenId) + '">'
        + '<div class="qq-official-entity-title"><div><strong>' + esc(name || 'QQ 群聊') + '</strong><span>'
        + esc(name ? '本机备注' : 'QQ 事件未提供群名称') + '</span></div>'
        + '<span class="qq-official-badge ' + (group.takeover ? 'is-active' : '') + '">' + (group.takeover ? 'AI 接管' : '人工使用') + '</span></div>'
        + localNoteInput('group', group.groupOpenId, name, '添加本机群备注')
        + (memberNames.length ? '<p class="qq-official-helper">近期群消息昵称：' + esc(memberNames.join('、')) + '</p>' : '')
        + '<div class="qq-official-entity-settings"><label>绑定角色<select data-qq-group-field="roleId">' + roleOptions(group.roleId) + '</select></label>'
        + '<label class="qq-official-toggle"><input type="checkbox" data-qq-group-field="takeover"'
        + (group.takeover ? ' checked' : '') + (group.roleId && availability.available ? '' : ' disabled')
        + '>此群 @ 消息交给 AI</label></div>'
        + (!availability.available ? providerSetupHint(group.roleId) : '')
        + '<details class="qq-official-advanced-inline"><summary>群 OpenID 与指令管理权限</summary><div class="qq-official-advanced-content">'
        + '<code class="qq-official-id">' + esc(group.groupOpenId) + '</code>'
        + '<label>可切换角色或重置会话的成员 OpenID<textarea rows="2" data-qq-group-field="adminMemberOpenIds" placeholder="每行一个群成员 OpenID">'
        + esc(group.adminMemberOpenIds.join('\n')) + '</textarea><span class="qq-official-helper">群内其他成员可查询角色；此处权限名单由 IB 显式授权，不使用 QQ 管理员标记。</span></label>'
        + pendingGroupAdminAuthorizationHtml(account, group)
        + '<button type="button" class="btn qq-official-danger-action" data-qq-official-action="remove-group">移除此群授权</button></div></details>'
        + '</article>';
    }).join('');
    return '<div class="qq-official-entity-list">' + (rows || '<p class="qq-official-empty">尚无已批准群聊。收到测试群 @ 消息后，可在待处理卡片中添加。</p>') + '</div>';
  }
  function accountAdvancedHtml(account) {
    var row = statusByAppId[account.appId] || {};
    var users = parseOpenIds(account.allowedUserOpenIds);
    var secretActionLabel = account.sourceDisconnectRequired && !account.credentialSaved ? '录入正式版 AppSecret' : '更换 AppSecret';
    return '<details class="qq-official-advanced"><summary>高级设置与故障诊断</summary><div class="qq-official-advanced-content">'
      + '<section><h5>机器人标识</h5><code class="qq-official-id">AppID ' + esc(account.appId) + '</code></section>'
      + '<section><h5>私聊白名单 OpenID</h5><textarea rows="3" data-qq-official-field="allowedUserOpenIds" aria-label="私聊白名单 OpenID">' + esc(users.join('\n')) + '</textarea>'
      + '<p class="qq-official-helper">普通设置页已提供逐用户授权与撤销操作。内部鉴权始终使用 OpenID。</p></section>'
      + '<section><h5>手动添加群</h5><div class="qq-official-group-add"><label>群 OpenID<input type="text" maxlength="512" data-qq-group-id-input placeholder="一般使用待处理卡片即可"></label>'
      + '<button type="button" class="btn" data-qq-official-action="add-group">添加为人工使用</button></div></section>'
      + '<label class="qq-official-consent"><input type="checkbox" data-qq-official-field="combinedIntentConsent"' + (account.combinedIntentConsent ? ' checked' : '')
      + '>确认 QQ 官方 C2C / 群聊 Gateway 共享接入范围</label>'
      + '<section><h5>连接与消息诊断</h5><p class="qq-official-stage" data-official-stage role="status" hidden></p>'
      + '<p class="qq-official-helper" data-official-transport-detail' + (configSyncError || transportError ? '' : ' hidden') + '>本地诊断代码：' + esc(configSyncError || transportError) + '</p>'
      + '<p class="qq-official-error" data-official-error-detail role="alert" hidden></p></section>'
      + (account.sourceDisconnectRequired ? '<label class="qq-official-consent"><input type="checkbox" data-qq-official-field="sourceDisconnectedConfirmed"'
        + (account.sourceDisconnectedConfirmed ? ' checked' : '') + '>我已在 Dev 断开此 Bot</label>'
        + '<p class="qq-official-helper">这是对 Dev 环境的手动确认；IB 无法跨环境自动探测。请先在 Dev 断开同一 Bot。正式版当前连接状态单独显示在本卡片的状态栏。</p>' : '')
      + '<details class="qq-official-secret"><summary>' + secretActionLabel + '</summary><div><label>AppSecret<input type="password" autocomplete="new-password" data-qq-official-secret placeholder="只写入当前环境的 Credential Vault"></label>'
      + '<button type="button" class="btn" data-qq-official-action="save-secret">保存凭据</button></div></details>'
      + (state.accounts.length && state.accounts[0].appId === account.appId ? migrationPanelHtml() + addBotFormHtml() : '')
      + '<div class="qq-official-danger-row"><button type="button" class="btn" data-qq-official-action="remove">移除 Bot 配置与对应 Vault 密钥</button></div>'
      + '</div></details>';
  }
  function migrationTargetRoles() {
    var snapshot = roleCatalogSnapshot(roleApi());
    if (!snapshot || snapshot.state !== 'ready' || !Array.isArray(snapshot.roles)) return null;
    return snapshot.roles.filter(function (role) {
      return role && String(role.id || '').trim();
    });
  }
  function migrationRoleRefs(accounts, roleLabels) {
    var refs = Object.create(null);
    function add(roleId) {
      var id = String(roleId || '').trim();
      if (id && !refs[id]) refs[id] = { id: id, label: String(roleLabels && roleLabels[id] || id) };
    }
    (Array.isArray(accounts) ? accounts : []).forEach(function (account) {
      add(account.roleId);
      (account.privateRoleSelections || []).forEach(function (selection) { add(selection.roleId); });
      (account.groups || []).forEach(function (group) { add(group.roleId); });
    });
    return Object.keys(refs).map(function (id) { return refs[id]; });
  }
  function initialMigrationRoleMap(bundle, accounts) {
    var roles = migrationTargetRoles() || [];
    var refs = migrationRoleRefs(accounts, bundle.roleLabels);
    var roleMap = Object.create(null);
    refs.forEach(function (ref) {
      var exact = roles.filter(function (role) { return String(role.id) === ref.id; });
      if (exact.length === 1) { roleMap[ref.id] = String(exact[0].id); return; }
      var byName = roles.filter(function (role) {
        return roleDisplayName(role).toLocaleLowerCase() === ref.label.toLocaleLowerCase();
      });
      roleMap[ref.id] = byName.length === 1 ? String(byName[0].id) : '';
    });
    return { refs: refs, roleMap: roleMap };
  }
  function migrationPreviewPlan() {
    if (!pendingMigration) return null;
    var bundle = pendingMigration.bundle;
    var added = bundle.accounts.filter(function (account) { return !findAccount(account.appId); });
    var skipped = bundle.accounts.length - added.length;
    var targetRoles = migrationTargetRoles() || [];
    var unresolvedRoles = pendingMigration.refs.filter(function (ref) {
      var selected = String(pendingMigration.roleMap[ref.id] || '');
      return !selected || !targetRoles.some(function (role) { return String(role.id) === selected; });
    });
    var capacityExceeded = state.accounts.length + added.length > 16;
    var userCount = 0, groupCount = 0, commandAdminCount = 0, takeoverAccountCount = 0, takeoverGroupCount = 0;
    added.forEach(function (account) {
      userCount += account.allowedUserOpenIds.length;
      groupCount += account.groups.length;
      commandAdminCount += account.groups.reduce(function (sum, group) { return sum + group.adminMemberOpenIds.length; }, 0);
      if (account.takeover) takeoverAccountCount++;
      takeoverGroupCount += account.groups.filter(function (group) { return group.takeover; }).length;
    });
    return {
      added: added,
      skipped: skipped,
      unresolvedRoles: unresolvedRoles,
      capacityExceeded: capacityExceeded,
      userCount: userCount,
      groupCount: groupCount,
      commandAdminCount: commandAdminCount,
      takeoverAccountCount: takeoverAccountCount,
      takeoverGroupCount: takeoverGroupCount,
      canApply: added.length > 0 && !unresolvedRoles.length && !pendingMigration.roleCatalogUnavailable
        && !pendingMigration.noTargetRoles && !capacityExceeded
    };
  }
  function migrationConfirmationKey(plan) {
    if (!pendingMigration || !plan) return '';
    var targetRoles = migrationTargetRoles() || [];
    return JSON.stringify({
      targetAppIds: state.accounts.map(function (account) { return String(account.appId); }).sort(),
      addedAppIds: plan.added.map(function (account) { return String(account.appId); }).sort(),
      roleMap: Object.keys(pendingMigration.roleMap).sort().map(function (roleId) {
        return [roleId, String(pendingMigration.roleMap[roleId] || '')];
      }),
      targetRoles: targetRoles.map(function (role) {
        var id = String(role.id || '');
        return [id, roleAvailability(id).available === true];
      }).sort(function (a, b) { return a[0].localeCompare(b[0]); }),
      initialPause: state.accounts.length ? null : state.paused === true
    });
  }
  function migrationConfirmationCurrent(plan) {
    return !!pendingMigration && pendingMigration.confirmed === true
      && pendingMigration.confirmationKey === migrationConfirmationKey(plan);
  }
  function migrationRoleOptions(selected) {
    var roles = migrationTargetRoles() || [];
    var html = '<option value="">选择正式版角色</option>';
    roles.forEach(function (role) {
      var id = String(role.id || '');
      var name = roleDisplayName(role);
      var available = roleAvailability(id).available;
      html += '<option value="' + esc(id) + '"' + (id === String(selected || '') ? ' selected' : '') + '>'
        + esc(name + (name === id ? '' : ' · ' + id) + (available ? '' : '（需配置 Provider）')) + '</option>';
    });
    return html;
  }
  function migrationPanelHtml() {
    return '<section class="qq-official-migration"><h5>Dev → 正式版配置迁移</h5>'
      + '<p>导出文件不含 AppSecret、Vault 凭据引用或聊天上下文；含 Bot、角色绑定、授权对象、本机备注、指令版本与接管设置。请只在可信位置保存。</p>'
      + '<div class="qq-official-migration-actions">'
      + '<button type="button" class="btn" data-qq-official-action="migration-export"' + (state.accounts.length ? '' : ' disabled') + '>导出此环境配置</button>'
      + '<button type="button" class="btn" data-qq-official-action="migration-choose">选择 Dev 配置文件</button>'
      + '<button type="button" class="btn" data-qq-official-action="migration-clear" data-migration-clear hidden>清除预览</button>'
      + '<input type="file" accept=".json,application/json" data-qq-migration-file hidden></div>'
      + '<p class="qq-official-migration-status" data-migration-status role="status">导出后在正式版选择该文件；预览仅保存在当前页面，刷新后需重新选择。正式版不会自动连接 Bot。</p>'
      + '<div data-migration-preview hidden></div>'
      + '<p class="qq-official-safety-note">导入只新增未登记 Bot；同 AppID 的正式版配置会跳过且不覆盖。每个 Bot 需重新保存 AppSecret、确认接入范围，并先在 Dev 断开后才能从正式版连接。</p></section>';
  }
  function migrationTargetRoleName(roleId) {
    var id = String(roleId || '');
    var role = (migrationTargetRoles() || []).find(function (row) { return String(row.id) === id; });
    return role ? roleDisplayName(role) : '';
  }
  function migrationAccountDiffHtml(account) {
    var exists = !!findAccount(account.appId);
    var mappedRole = !exists && pendingMigration ? String(pendingMigration.roleMap[account.roleId] || '') : '';
    var mappedRoleName = mappedRole ? migrationTargetRoleName(mappedRole) || mappedRole : '需选择目标角色';
    var userRows = account.allowedUserOpenIds.map(function (userOpenId) {
      var selection = account.privateRoleSelections.find(function (row) { return row.userOpenId === userOpenId; });
      var sourceRole = selection ? selection.roleId : account.roleId;
      var targetRole = !exists && pendingMigration ? String(pendingMigration.roleMap[sourceRole] || '') : '';
      return '<li>' + esc(localLabel(account.userNotes, userOpenId) || '私聊用户') + ' <code>' + esc(shortOpenId(userOpenId)) + '</code>'
        + (selection ? ' · 角色 ' + esc(targetRole ? migrationTargetRoleName(targetRole) || targetRole : '需匹配') : ' · 使用 Bot 默认角色') + '</li>';
    }).join('');
    var groupRows = account.groups.map(function (group) {
      var targetRole = !exists && group.roleId && pendingMigration ? String(pendingMigration.roleMap[group.roleId] || '') : '';
      return '<li>' + esc(localLabel(account.groupNotes, group.groupOpenId) || '群聊') + ' <code>' + esc(shortOpenId(group.groupOpenId)) + '</code>'
        + ' · ' + (group.takeover ? '群接管开启' : '人工使用')
        + ' · ' + (group.roleId ? '角色 ' + esc(targetRole ? migrationTargetRoleName(targetRole) || targetRole : '需匹配') : '未绑定角色')
        + ' · ' + group.adminMemberOpenIds.length + ' 位指令管理员</li>';
    }).join('');
    return '<details class="qq-official-migration-account"><summary><strong>' + esc(account.displayName || 'QQ 官方机器人') + '</strong>'
      + '<code>AppID ' + esc(account.appId) + '</code><span class="qq-official-badge">' + (exists ? '跳过，不覆盖' : '新增') + '</span></summary>'
      + '<div><p>Bot 默认角色：' + esc(exists ? '保持正式版现有设置' : mappedRoleName) + '；私聊接管：'
      + (account.takeover ? '开启' : '关闭') + '。</p><p>内置指令：/role、/who、/reset。</p>'
      + '<strong>授权私聊用户 · ' + account.allowedUserOpenIds.length + '</strong><ul>' + (userRows || '<li>无</li>') + '</ul>'
      + '<strong>授权群聊 · ' + account.groups.length + '</strong><ul>' + (groupRows || '<li>无</li>') + '</ul></div></details>';
  }
  function migrationPreviewHtml(plan) {
    if (!pendingMigration || !plan) return '';
    var mappingHtml = plan.unresolvedRoles.length || pendingMigration.refs.length
      ? '<div class="qq-official-migration-roles"><strong>角色对应</strong>' + pendingMigration.refs.map(function (ref) {
        return '<label><span>' + esc(ref.label) + ' <code>' + esc(ref.id) + '</code></span><select data-qq-migration-role-map="' + esc(ref.id) + '">'
          + migrationRoleOptions(pendingMigration.roleMap[ref.id]) + '</select></label>';
      }).join('') + '</div>' : '';
    var pauseCopy = state.accounts.length
      ? '正式版已有 Bot：保留正式版当前全局暂停状态。'
      : '正式版尚无 Bot：按导出文件中的全局暂停状态迁移。';
    var blockedCopy = plan.capacityExceeded ? 'Bot 数量超过正式版上限，无法导入。'
      : !plan.added.length ? '没有可新增的 Bot；现有同 AppID 配置不会覆盖。'
        : pendingMigration.roleCatalogUnavailable ? '正式版角色列表暂不可用；刷新角色目录后重选配置文件。'
          : pendingMigration.noTargetRoles ? '正式版尚无角色；请先创建角色后再导入。'
            : plan.unresolvedRoles.length ? '请为每个未匹配角色选择一个可用的正式版角色。' : '';
    return '<div class="qq-official-migration-diff"><strong>导入预览</strong>'
      + '<dl><div><dt>新增 Bot</dt><dd>' + plan.added.length + '</dd></div><div><dt>跳过冲突</dt><dd>' + plan.skipped + '</dd></div>'
      + '<div><dt>私聊用户</dt><dd>' + plan.userCount + '</dd></div><div><dt>群聊</dt><dd>' + plan.groupCount + '</dd></div>'
      + '<div><dt>群指令管理员</dt><dd>' + plan.commandAdminCount + '</dd></div><div><dt>接管开启的 Bot / 群</dt><dd>'
      + plan.takeoverAccountCount + ' / ' + plan.takeoverGroupCount + '</dd></div></dl>'
      + '<p>指令版本：/role、/who、/reset。聊天记录与 Memory 不迁移；导入后的 QQ 会话从空上下文开始。</p>'
      + '<p>' + esc(pauseCopy) + ' Bot 在重新保存密钥和确认接入范围前保持断连。</p></div>' + mappingHtml
      + '<div class="qq-official-migration-accounts">' + pendingMigration.bundle.accounts.map(migrationAccountDiffHtml).join('') + '</div>'
      + (blockedCopy ? '<p class="qq-official-error" data-migration-blocked>' + esc(blockedCopy) + '</p>' : '')
      + '<label class="qq-official-consent"><input type="checkbox" data-qq-migration-confirm' + (migrationConfirmationCurrent(plan) ? ' checked' : '')
      + '>我已核对上方差异，并同意将这些新增绑定和授权写入当前环境。</label>'
      + '<button type="button" class="btn btn-primary" data-qq-official-action="migration-apply" data-migration-apply disabled>确认并导入新增配置</button>';
  }
  function updateMigrationApplyButton() {
    var root = host();
    var button = root && root.querySelector('[data-migration-apply]');
    var confirm = root && root.querySelector('[data-qq-migration-confirm]');
    var plan = migrationPreviewPlan();
    if (button) button.disabled = !plan || !plan.canApply || !migrationConfirmationCurrent(plan)
      || !confirm || confirm.checked !== true;
  }
  function renderMigrationPreview() {
    var root = host();
    var preview = root && root.querySelector('[data-migration-preview]');
    var status = root && root.querySelector('[data-migration-status]');
    var clear = root && root.querySelector('[data-migration-clear]');
    if (!preview) return;
    preview.hidden = !pendingMigration;
    if (!pendingMigration) { if (clear) clear.hidden = true; return; }
    var plan = migrationPreviewPlan();
    if (pendingMigration.confirmed === true
      && pendingMigration.confirmationKey !== migrationConfirmationKey(plan)) {
      pendingMigration.confirmed = false;
      pendingMigration.confirmationKey = '';
    }
    pendingMigration.plan = plan;
    preview.innerHTML = migrationPreviewHtml(plan);
    if (status) status.textContent = '配置文件已读取；尚未写入当前环境。请先核对差异。';
    if (clear) clear.hidden = false;
    updateMigrationApplyButton();
  }
  function migrationErrorMessage(error) {
    var messages = {
      'migration-no-accounts': '此环境没有可导出的 QQ Bot 配置。',
      'migration-file-too-large': '配置文件超过 1 MB，已拒绝读取。',
      'migration-json-invalid': '文件不是有效的 JSON 配置。',
      'migration-credential-field-forbidden': '文件包含不允许迁移的凭据字段；未导入。',
      'migration-schema-invalid': '配置版本不受支持；未导入。',
      'migration-command-profile-unsupported': '指令版本与当前 IB 不兼容；未导入。',
      'migration-account-count-invalid': 'Bot 数量不符合迁移限制。',
      'migration-duplicate-app-id': '文件中的 Bot 标识重复或无效。',
      'migration-private-role-invalid': '私聊授权与角色绑定数据无效。',
      'migration-group-invalid': '群聊授权数据无效。',
      'migration-id-list-invalid': '授权对象列表无效或超过数量限制。',
      'migration-labels-invalid': '本机备注数据无效。',
      'migration-field-invalid': '配置字段格式无效。',
      'migration-fields-unsupported': '文件包含当前版本不支持的字段。',
      'migration-account-fields-unsupported': 'Bot 配置包含当前版本不支持的字段。',
      'migration-private-role-fields-unsupported': '私聊角色配置格式不受支持。',
      'migration-group-fields-unsupported': '群聊配置格式不受支持。',
      'migration-shape-invalid': '配置结构不完整或超出限制。'
    };
    var code = String(error && error.message || error || '');
    return messages[code] || '配置文件未通过检查；当前环境没有写入任何迁移内容。';
  }
  async function readMigrationFile(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var root = host();
    var status = root && root.querySelector('[data-migration-status]');
    pendingMigration = null;
    if (file.size > MIGRATION_FILE_MAX_BYTES) {
      if (status) status.textContent = migrationErrorMessage('migration-file-too-large');
      renderMigrationPreview();
      input.value = '';
      return;
    }
    try {
      var bundle;
      try { bundle = validateMigrationBundle(JSON.parse(await file.text())); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error('migration-json-invalid');
        throw error;
      }
      var roles = migrationTargetRoles();
      var newAccounts = bundle.accounts.filter(function (account) { return !findAccount(account.appId); });
      var initial = initialMigrationRoleMap(bundle, newAccounts);
      pendingMigration = { bundle: bundle, refs: initial.refs, roleMap: initial.roleMap, confirmed: false,
        roleCatalogUnavailable: !roles, noTargetRoles: !!roles && roles.length === 0 };
      renderMigrationPreview();
    } catch (error) {
      if (status) status.textContent = migrationErrorMessage(error);
      renderMigrationPreview();
    } finally { input.value = ''; }
  }
  function exportMigrationFile() {
    try {
      var payload = migrationExportBundle();
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'InternalBeyond-QQ-Official-Config.json';
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      setNotice('QQ 配置已导出；文件不含 AppSecret、Vault 引用或聊天记录。', 'info');
    } catch (error) { setNotice(migrationErrorMessage(error), 'error'); }
  }
  function clearMigrationPreview() {
    pendingMigration = null;
    var root = host();
    var preview = root && root.querySelector('[data-migration-preview]');
    var status = root && root.querySelector('[data-migration-status]');
    var clear = root && root.querySelector('[data-migration-clear]');
    if (preview) { preview.hidden = true; preview.innerHTML = ''; }
    if (status) status.textContent = '导出后在正式版选择该文件；正式版不会自动连接 Bot。';
    if (clear) clear.hidden = true;
  }
  function importedAccount(source, roleMap) {
    var selectionByUser = Object.create(null);
    source.privateRoleSelections.forEach(function (selection) { selectionByUser[selection.userOpenId] = selection.roleId; });
    return {
      appId: source.appId,
      displayName: source.displayName,
      roleId: roleMap[source.roleId],
      takeover: source.takeover,
      allowedUserOpenIds: source.allowedUserOpenIds.slice(),
      privateRoleSelections: source.allowedUserOpenIds.map(function (userOpenId) {
        var sourceRoleId = selectionByUser[userOpenId] || source.roleId;
        return { userOpenId: userOpenId, roleId: roleMap[sourceRoleId], sessionId: newSessionId() };
      }),
      groups: source.groups.map(function (group) {
        return { groupOpenId: group.groupOpenId, roleId: group.roleId ? roleMap[group.roleId] : '',
          takeover: group.takeover, adminMemberOpenIds: group.adminMemberOpenIds.slice(), sessionId: newSessionId() };
      }),
      userNotes: parseLocalLabels(source.userNotes),
      groupNotes: parseLocalLabels(source.groupNotes),
      memberNames: parseLocalLabels(source.memberNames),
      combinedIntentConsent: false,
      credentialSaved: false,
      sourceDisconnectRequired: true,
      sourceDisconnectedConfirmed: false
    };
  }
  async function applyMigration() {
    var root = host();
    var confirm = root && root.querySelector('[data-qq-migration-confirm]');
    var applyButton = root && root.querySelector('[data-migration-apply]');
    var plan = migrationPreviewPlan();
    if (!pendingMigration || !plan || !plan.canApply || !migrationConfirmationCurrent(plan)
      || !confirm || confirm.checked !== true || !applyButton || applyButton.disabled) return;
    applyButton.disabled = true;
    var before = JSON.parse(JSON.stringify(state));
    var imported = plan.added.map(function (account) { return importedAccount(account, pendingMigration.roleMap); });
    state.accounts = state.accounts.concat(imported);
    if (!before.accounts.length) state.paused = pendingMigration.bundle.paused;
    imported.forEach(function (account) { resumeConnectedByAppId[account.appId] = false; });
    if (!saveState()) {
      state = before;
      setNotice('本机无法保存迁移结果；正式版设置未更改。', 'error');
      return;
    }
    render();
    var sync = await syncConfig();
    if (!sync || sync.ok !== true) {
      state = before;
      saveState();
      render();
      var rollback = await syncConfig();
      setNotice(rollback && rollback.ok === true
        ? '本地服务未确认导入；本机设置已恢复，正式版 Bot 未连接。'
        : '迁移同步未确认；本机设置已恢复，但本地服务状态仍需检查。', 'error');
      return;
    }
    pendingMigration = null;
    render();
    await refreshStatus();
    setNotice(imported.length + ' 个 Bot 配置已导入，均保持断连；请在正式版重新保存 AppSecret、确认接入范围，并确认 Dev 已断开后再连接。', 'info');
  }
  function accountHtml(account) {
    var runtime = statusByAppId[account.appId] || {};
    var stateName = runtime.state || 'stopped';
    var connectionPending = stateName === 'connecting' || stateName === 'reconnecting';
    var alreadyOnline = stateName === 'online';
    var displayName = String(account.displayName || '').trim() || 'QQ 官方机器人';
    var defaultRole = roleAvailability(account.roleId);
    var userCount = parseOpenIds(account.allowedUserOpenIds).length;
    var groupCount = parseGroupBindings(account.groups).length;
    var pendingUserCount = Array.isArray(runtime.pendingUserOpenIds) ? runtime.pendingUserOpenIds.length : 0;
    var pendingGroupCount = Array.isArray(runtime.pendingGroupOpenIds) ? runtime.pendingGroupOpenIds.length : 0;
    var pendingCount = pendingUserCount + pendingGroupCount;
    var connectionGate = !account.combinedIntentConsent ? '先确认接入范围'
      : (account.sourceDisconnectRequired && !account.credentialSaved ? '先保存正式版凭据'
        : (account.sourceDisconnectRequired && !account.sourceDisconnectedConfirmed ? '展开高级设置确认 Dev 已断开' : '连接 / 重试'));
    var connectionAction = '<button type="button" class="btn btn-primary" data-qq-official-action="connect"'
      + (alreadyOnline ? ' hidden' : '')
      + (connectionPending || !account.combinedIntentConsent || (account.sourceDisconnectRequired && (!account.credentialSaved || !account.sourceDisconnectedConfirmed)) ? ' disabled' : '') + '>'
      + (connectionPending ? '连接中…' : connectionGate) + '</button>';
    return '<article class="qq-official-account" data-app-id="' + esc(account.appId) + '">'
      + '<header class="qq-official-account-head"><div class="qq-official-account-identity"><span class="qq-official-state" data-state="' + esc(stateName) + '" data-official-state>'
      + esc(stateLabel(account.appId)) + '</span><strong>' + esc(displayName) + '</strong>'
      + '<small>官方 QQ Bot</small>'
      + '</div>'
      + '<div class="qq-official-account-actions">' + connectionAction
      + '<button type="button" class="btn" data-qq-official-action="disconnect"' + (stateName && stateName !== 'stopped' ? '' : ' disabled') + '>断开</button></div></header>'
      + '<div class="qq-official-account-config">' + localNoteInput('bot', account.appId, account.displayName, '例如：我的测试机器人')
      + '<label class="qq-official-default-role">默认角色（新批准私聊）<select data-qq-official-field="roleId">' + roleOptions(account.roleId) + '</select></label></div>'
      + '<div class="qq-official-account-status"><span>私聊接管：<strong>' + (account.takeover ? '开启' : '关闭') + '</strong></span>'
      + '<label class="qq-official-toggle"><input type="checkbox" data-qq-official-field="takeover"' + (account.takeover ? ' checked' : '') + '>允许已批准私聊用户交给 AI</label></div>'
      + (account.sourceDisconnectRequired && !account.credentialSaved
        ? '<p class="qq-official-helper">此环境尚未绑定 Bot 凭据；请在高级设置中重新录入 AppSecret。</p>' : '')
      + (!defaultRole.available ? providerSetupHint(account.roleId) : '')
      + '<p class="qq-official-capability-note">私聊支持文字和图片；群聊请 @ Bot，未 @ 的消息不会缓存。回复引用图片后 @（需腾讯事件携带引用附件）。角色命令：/role、/who、/reset；群内切换与重置仅限 IB 指令管理员。</p>'
      + '<details class="qq-official-object-details"><summary><strong>已授权用户与群聊</strong><span data-approved-counts>' + userCount + ' 个私聊 · ' + groupCount + ' 个群聊</span></summary>'
      + '<div class="qq-official-object-content"><section class="qq-official-section"><div class="qq-official-section-head"><strong>私聊用户</strong><span class="qq-official-count">' + userCount + '</span></div>'
      + '<div data-official-users>' + userListHtml(account) + '</div></section>'
      + '<section class="qq-official-section"><div class="qq-official-section-head"><strong>群聊</strong><span class="qq-official-count">' + groupCount + '</span></div>'
      + '<div data-official-groups>' + groupBindingsHtml(account) + '</div></section></div></details>'
      + '<details class="qq-official-pending-fold" data-official-pending-fold data-has-pending="' + (pendingCount ? 'true' : 'false') + '"><summary><strong>待批准对象</strong><span data-pending-count>' + pendingCount + ' 个</span></summary>'
      + '<div class="qq-official-object-content"><div data-official-pending-users>' + pendingAuthorizationHtml(account) + '</div>'
      + '<div data-official-pending-groups>' + pendingGroupAuthorizationHtml(account) + '</div>'
      + '<p class="qq-official-empty" data-no-pending' + (pendingCount ? ' hidden' : '') + '>当前没有待批准对象。</p></div></details>'
      + '<p class="qq-official-error qq-official-account-error" data-official-error role="alert" hidden></p>'
      + (state.accounts.length && state.accounts[0].appId === account.appId ? quickStartHtml() : '')
      + accountAdvancedHtml(account)
      + '</article>';
  }
  function quickStartHtml() {
    return '<details class="qq-official-guide" id="qq-official-guide"><summary><span class="qq-official-guide-icon" aria-hidden="true">5</span>'
      + '<span><strong>新手教程</strong><small>' + (state.accounts.length ? '查看接入步骤' : '首次接入？展开 5 步指引') + '</small></span></summary><ol class="qq-official-guide-steps">'
      + '<li><span>01</span><div><strong>创建 QQ Bot</strong><p>在 <a href="https://q.qq.com/" target="_blank" rel="noopener noreferrer">QQ 开放平台</a>创建机器人并选择开发体验场景。</p></div></li>'
      + '<li><span>02</span><div><strong>获取 AppID 与 AppSecret</strong><p>在 Bot 管理页准备两项凭据；AppSecret 只会写入本机 Credential Vault。</p></div></li>'
      + '<li><span>03</span><div><strong>添加测试对象</strong><p>在 QQ 开放平台的开发体验/沙箱中添加测试账号或群，并在 QQ 客户端添加 Bot。</p></div></li>'
      + '<li><span>04</span><div><strong>发消息并批准</strong><p>测试用户私聊 Bot，或在测试群 @ Bot；IB 会显示待批准卡片，可直接选角色。未 @ 的消息不会缓存；回复引用图片后 @（需腾讯事件携带引用附件）。</p></div></li>'
      + '<li><span>05</span><div><strong>检查角色并发送第一条消息</strong><p>确认角色 Provider、模型和 Credential Vault 凭据可用，再显式开启接管。</p>'
      + '<button type="button" class="btn" data-qq-official-action="open-provider-settings">检查角色与 API 设置</button></div></li>'
      + '</ol><a class="qq-official-guide-link" href="https://bot.q.qq.com/wiki/" target="_blank" rel="noopener noreferrer">打开 QQ 机器人官方接入指南 ↗</a></details>';
  }
  function addBotFormHtml() {
    return '<details class="qq-official-add" id="qq-official-add-details"' + (state.accounts.length ? '' : ' open') + '><summary>'
      + (state.accounts.length ? '连接另一个 QQ Bot' : '连接 QQ Bot') + '</summary><form id="qq-official-add-form"><div class="qq-official-add-grid">'
      + '<label>Bot 显示备注<input name="displayName" autocomplete="off" maxlength="80" placeholder="可选，仅在本机显示"></label>'
      + '<label>AppID<input name="appId" autocomplete="off" maxlength="64" required placeholder="QQ 开放平台 AppID"></label>'
      + '<label>AppSecret<input name="appSecret" type="password" autocomplete="new-password" required placeholder="保存到本机 Credential Vault"></label>'
      + '<label>默认角色<select name="roleId" required>' + roleOptions('') + '</select></label></div>'
      + roleCatalogHintHtml()
      + '<label class="qq-official-consent"><input type="checkbox" name="combinedIntentConsent" required>我已在 QQ 开放平台开通机器人私聊 / 群聊测试接入，并同意 IB 接收这些消息</label>'
      + '<p>连接不会批准用户、群聊或开启 AI 接管；这些权限在收到事件后由你逐项确认。</p>'
      + '<button type="submit" class="btn btn-primary">保存并连接</button></form></details>';
  }
  function render() {
    var root = host();
    if (!root) return;
    var active = state.accounts.filter(accountHasTakeover).length;
    root.innerHTML = '<div class="qq-official-panel"><header class="qq-official-hero"><div>'
      + '<h3>QQ 接入</h3><p>让 IB 角色通过 QQ 与你聊天。</p></div>'
      + '<button type="button" class="btn ' + (state.paused ? 'btn-primary' : '') + '" data-qq-official-action="pause">'
      + (state.paused ? '恢复 AI 接管' : '暂停 AI 接管') + '</button></header>'
      + '<div class="qq-official-summary" role="status" aria-live="polite">'
      + esc(transportError ? '本地服务未连接'
        : (state.paused ? 'AI 接管已暂停' : (active ? 'AI 接管已开启' : 'AI 接管尚未开启')))
      + '</div>' + (notice ? '<p class="qq-official-notice" data-state="' + esc(noticeKind) + '" role="' + (noticeKind === 'error' ? 'alert' : 'status') + '">' + esc(notice) + '</p>' : '')
      + (state.accounts.length ? '<div class="qq-official-accounts">' + state.accounts.map(accountHtml).join('') + '</div>'
        : addBotFormHtml() + '<p class="qq-official-empty">添加现有 Bot 后，收到私聊或群 @ 事件时，会在这里出现待批准对象。</p>' + quickStartHtml()
          + '<details class="qq-official-advanced"><summary>高级设置与配置迁移</summary><div class="qq-official-advanced-content">' + migrationPanelHtml() + '</div></details>')
      + '</div>';
    bindEvents(root);
    /* Keep an in-page migration preview across ordinary settings re-renders.
       The selected bundle stays in memory and is never persisted to storage. */
    if (pendingMigration) renderMigrationPreview();
  }
  function editingLocalNote(node) {
    var active = typeof document !== 'undefined' ? document.activeElement : null;
    return !!(node && active && node.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(String(active.tagName || '').toUpperCase()));
  }
  function renderAccountStatus() {
    var root = host();
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('.qq-official-account'), function (node) {
      var appId = node.getAttribute('data-app-id');
      var account = findAccount(appId);
      var stateNode = node.querySelector('[data-official-state]');
      if (stateNode && account) {
        var currentRuntime = statusByAppId[appId] || {};
        stateNode.textContent = stateLabel(appId);
        stateNode.setAttribute('data-state', transportError ? 'failed' : (currentRuntime.state || 'stopped'));
      }
      if (account) {
        var approvedCountNode = node.querySelector('[data-approved-counts]');
        if (approvedCountNode) approvedCountNode.textContent = parseOpenIds(account.allowedUserOpenIds).length + ' 个私聊 · ' + parseGroupBindings(account.groups).length + ' 个群聊';
        var currentPendingUsers = Array.isArray((statusByAppId[appId] || {}).pendingUserOpenIds)
          ? statusByAppId[appId].pendingUserOpenIds.length : 0;
        var currentPendingGroups = Array.isArray((statusByAppId[appId] || {}).pendingGroupOpenIds)
          ? statusByAppId[appId].pendingGroupOpenIds.length : 0;
        var pendingTotal = currentPendingUsers + currentPendingGroups;
        var pendingCountNode = node.querySelector('[data-pending-count]');
        if (pendingCountNode) pendingCountNode.textContent = pendingTotal + ' 个';
        var pendingFold = node.querySelector('[data-official-pending-fold]');
        if (pendingFold) pendingFold.setAttribute('data-has-pending', pendingTotal ? 'true' : 'false');
        var noPending = node.querySelector('[data-no-pending]');
        if (noPending) noPending.hidden = pendingTotal > 0;
      }
      var errorNode = node.querySelector('[data-official-error]');
      var advancedErrorNode = node.querySelector('[data-official-error-detail]');
      if (errorNode && account) {
        var detail = statusDetail(account, false);
        errorNode.hidden = !detail;
        errorNode.textContent = detail;
      }
      if (advancedErrorNode && account) {
        var advancedDetail = statusDetail(account, true);
        advancedErrorNode.hidden = !advancedDetail;
        advancedErrorNode.textContent = advancedDetail;
      }
      var stageNode = node.querySelector('[data-official-stage]');
      if (stageNode && account) {
        var runtime = statusByAppId[appId] || {};
        var stage = stageLabel(runtime);
        stageNode.hidden = !stage;
        stageNode.textContent = stage;
      }
      var transportNode = node.querySelector('[data-official-transport-detail]');
      if (transportNode) {
        var transportDetail = configSyncError || transportError;
        transportNode.hidden = !transportDetail;
        transportNode.textContent = transportDetail ? '本地诊断代码：' + transportDetail : '';
      }
      var usersNode = node.querySelector('[data-official-users]');
      if (usersNode && account && !editingLocalNote(usersNode)) usersNode.innerHTML = userListHtml(account);
      var pendingUsersNode = node.querySelector('[data-official-pending-users]');
      if (pendingUsersNode && account && !editingLocalNote(pendingUsersNode)) pendingUsersNode.innerHTML = pendingAuthorizationHtml(account);
      var pendingGroupsNode = node.querySelector('[data-official-pending-groups]');
      if (pendingGroupsNode && account && !editingLocalNote(pendingGroupsNode)) pendingGroupsNode.innerHTML = pendingGroupAuthorizationHtml(account);
      var groupsNode = node.querySelector('[data-official-groups]');
      if (groupsNode && account && !editingLocalNote(groupsNode)) {
        var openGroupDetails = Array.prototype.map.call(groupsNode.querySelectorAll('.qq-official-advanced-inline'), function (detail) { return detail.open; });
        groupsNode.innerHTML = groupBindingsHtml(account);
        Array.prototype.forEach.call(groupsNode.querySelectorAll('.qq-official-advanced-inline'), function (detail, index) {
          detail.open = openGroupDetails[index] === true;
        });
      }
      var connect = node.querySelector('[data-qq-official-action="connect"]');
      var runtime = statusByAppId[appId] || {};
      var serviceDown = !!transportError;
      var connectionPending = runtime.state === 'connecting' || runtime.state === 'reconnecting';
      var alreadyOnline = runtime.state === 'online';
      if (connect) {
        connect.hidden = alreadyOnline && !serviceDown;
        connect.disabled = connectionPending || (alreadyOnline && !serviceDown) || !account.combinedIntentConsent
          || (account.sourceDisconnectRequired && (!account.credentialSaved || !account.sourceDisconnectedConfirmed));
        if (serviceDown && account.combinedIntentConsent) connect.textContent = '重试连接';
        else if (connectionPending) connect.textContent = '连接中…';
        else if (alreadyOnline) connect.textContent = '已连接';
        else if (!account.combinedIntentConsent) connect.textContent = '先确认接入范围';
        else if (account.sourceDisconnectRequired && !account.credentialSaved) connect.textContent = '先保存正式版凭据';
        else if (account.sourceDisconnectRequired && !account.sourceDisconnectedConfirmed) connect.textContent = '展开高级设置确认 Dev 已断开';
        else connect.textContent = '连接 / 重试';
      }
      var disconnect = node.querySelector('[data-qq-official-action="disconnect"]');
      if (disconnect) disconnect.disabled = !runtime.state || runtime.state === 'stopped';
    });
  }
  function persistAndSync() {
    saveState();
    render();
    return syncConfig().then(function (result) {
      return Promise.resolve(refreshStatus()).then(function () { return result; });
    });
  }
  function setAccountField(appId, field, value) {
    var account = findAccount(appId);
    if (!account) return;
    if (field === 'roleId') {
      var nextRoleId = String(value || '').slice(0, 160);
      if (nextRoleId !== account.roleId) resetDefaultPrivateSessions(account, nextRoleId);
      account.roleId = nextRoleId;
      if (!nextRoleId) account.takeover = false;
    }
    else if (field === 'takeover') account.takeover = value === true;
    else if (field === 'combinedIntentConsent') account.combinedIntentConsent = value === true;
    else if (field === 'sourceDisconnectedConfirmed' && account.sourceDisconnectRequired) {
      var previousConfirmation = account.sourceDisconnectedConfirmed === true;
      account.sourceDisconnectedConfirmed = value === true;
      if (!saveState()) {
        account.sourceDisconnectedConfirmed = previousConfirmation;
        setNotice('无法保存 Dev 断开确认；正式版 Bot 未连接，请重试。', 'error');
        return;
      }
      /* This is a local, manual source-environment fact. It is deliberately not
         sent to Home Node; update the gate in place without rebuilding the page. */
      renderAccountStatus();
      return;
    }
    else if (field === 'allowedUserOpenIds') {
      account.allowedUserOpenIds = parseOpenIds(value);
      account.privateRoleSelections = parsePrivateRoleSelections(account.privateRoleSelections, account.allowedUserOpenIds);
    }
    delete replyErrors[appId];
    persistAndSync();
  }
  function setGroupField(appId, groupOpenId, field, value) {
    var account = findAccount(appId);
    var group = account && groupBinding(account, groupOpenId);
    if (!account || !group) return;
    if (field === 'roleId') {
      var nextGroupRoleId = String(value || '').slice(0, 160);
      if (nextGroupRoleId !== group.roleId) {
        resetConfiguredPeerContext(account, 'group', group.groupOpenId, group.sessionId);
        group.sessionId = newSessionId();
      }
      group.roleId = nextGroupRoleId;
      if (group.takeover && !roleAvailability(group.roleId).available) group.takeover = false;
    } else if (field === 'takeover') {
      if (value === true && (!group.roleId || !roleAvailability(group.roleId).available)) {
        group.takeover = false;
        setNotice('此群需先绑定可用角色，之后才能开启 AI 接管。', 'error');
        return;
      }
      group.takeover = value === true;
    } else if (field === 'adminMemberOpenIds') {
      group.adminMemberOpenIds = parseOpenIds(value);
    }
    delete replyErrors[appId];
    persistAndSync();
  }
  function setLocalNote(appId, kind, id, value) {
    var account = findAccount(appId);
    if (!account) return;
    var clean = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (kind === 'bot') account.displayName = clean;
    else {
      var map = kind === 'user' ? account.userNotes : account.groupNotes;
      if (!map || typeof map !== 'object') map = Object.create(null);
      account[kind === 'user' ? 'userNotes' : 'groupNotes'] = map;
      if (clean) map[String(id || '')] = clean;
      else delete map[String(id || '')];
    }
    saveState();
  }
  function rememberGroupSenderName(event) {
    if (!event || event.messageType !== 'group' || !event.senderId || !event.senderName) return;
    var account = findAccount(event.appId);
    var groupId = String(event.groupOpenId || event.peerId || '').trim();
    var senderId = String(event.senderId || '').trim();
    var name = String(event.senderName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!account || !groupBinding(account, groupId) || !OPEN_ID_RE.test(senderId) || !name) return;
    if (!account.memberNames) account.memberNames = Object.create(null);
    var nameKey = groupMemberNameKey(groupId, senderId);
    if (account.memberNames[nameKey] === name) return;
    account.memberNames[nameKey] = name;
    saveState();
  }
  function setPrivateUserRole(appId, userOpenId, roleId) {
    var account = findAccount(appId);
    var id = String(userOpenId || '').trim();
    var nextRole = String(roleId || '').trim();
    if (!account || !account.allowedUserOpenIds.includes(id) || !OPEN_ID_RE.test(id)) return;
    if (!roleAvailability(nextRole).available) { setNotice('所选角色尚未配置完成；请先打开角色与 API 设置。', 'error'); return; }
    var previous = privateRoleSelection(account, id);
    var previousRole = previous ? previous.roleId : account.roleId;
    var previousSession = previous ? previous.sessionId : DEFAULT_SESSION_ID;
    if (previousRole === nextRole) return;
    resetConfiguredPeerContext(account, 'private', id, previousSession);
    updatePrivateRoleSelection(account, id, nextRole, newSessionId());
    persistAndSync();
    setNotice('已更新此私聊用户的角色，并开启新的 QQ 会话。', 'info');
  }
  function revokeUser(appId, userOpenId) {
    var account = findAccount(appId);
    var id = String(userOpenId || '').trim();
    if (!account || !account.allowedUserOpenIds.includes(id)) return;
    var previousAllowed = account.allowedUserOpenIds.slice();
    var previousSelections = account.privateRoleSelections.slice();
    var previousNote = localLabel(account.userNotes, id);
    account.allowedUserOpenIds = account.allowedUserOpenIds.filter(function (row) { return row !== id; });
    account.privateRoleSelections = parsePrivateRoleSelections(account.privateRoleSelections, account.allowedUserOpenIds);
    delete account.userNotes[id];
    persistAndSync().then(function (result) {
      var serverAccount = result && result.ok === true && Array.isArray(result.accounts)
        ? result.accounts.find(function (row) { return row && row.appId === appId; }) : null;
      if (!serverAccount || Number(serverAccount.allowedUserCount) !== account.allowedUserOpenIds.length) {
        account.allowedUserOpenIds = previousAllowed;
        account.privateRoleSelections = previousSelections;
        if (previousNote) account.userNotes[id] = previousNote;
        saveState();
        render();
        setNotice('本地服务未确认撤销；授权已恢复，请稍后重试。', 'error');
        return;
      }
      setNotice('已撤销该私聊用户的 QQ 授权。', 'info');
    });
  }
  function authorizeGroupAdmin(appId, groupOpenId, memberOpenId) {
    var account = findAccount(appId);
    var group = account && groupBinding(account, groupOpenId);
    var id = String(memberOpenId || '').trim();
    if (!group || !OPEN_ID_RE.test(id)) return;
    if (group.adminMemberOpenIds.includes(id)) return;
    if (group.adminMemberOpenIds.length >= 20) {
      setNotice('每个群最多授权 20 位指令管理者。', 'error');
      return;
    }
    var previousAdmins = group.adminMemberOpenIds.slice();
    group.adminMemberOpenIds = parseOpenIds(group.adminMemberOpenIds.concat([id]));
    persistAndSync().then(function (result) {
      var serverAccount = result && result.ok === true && Array.isArray(result.accounts)
        ? result.accounts.find(function (row) { return row && row.appId === appId; }) : null;
      var serverGroup = serverAccount && Array.isArray(serverAccount.groups)
        ? serverAccount.groups.find(function (row) { return row && row.groupOpenId === groupOpenId; }) : null;
      if (!serverGroup || Number(serverGroup.adminMemberCount) !== group.adminMemberOpenIds.length) {
        group.adminMemberOpenIds = previousAdmins;
        saveState();
        render();
        setNotice('本地服务未确认该群指令管理员授权；权限尚未生效，请重试。', 'error');
        return;
      }
      setNotice('该群成员已加入 IB 指令管理者名单。', 'info');
    });
  }
  function authorizeGroup(appId, groupOpenId, roleId, note) {
    var account = findAccount(appId);
    var id = String(groupOpenId || '').trim();
    var role = String(roleId || '').trim();
    if (!account || !OPEN_ID_RE.test(id)) {
      setNotice('请提供有效的群 OpenID。', 'error');
      return;
    }
    if (groupBinding(account, id)) { setNotice('这个群已在授权列表中。', 'info'); return; }
    if (account.groups.length >= 32) { setNotice('每个官方 Bot 最多授权 32 个群。', 'error'); return; }
    if (role && !roleAvailability(role).available) { setNotice('请先选择一个可用角色。', 'error'); return; }
    var previousNote = localLabel(account.groupNotes, id);
    account.groups.push({ groupOpenId: id, roleId: role, takeover: false,
      adminMemberOpenIds: [], sessionId: newSessionId() });
    if (note) {
      if (!account.groupNotes) account.groupNotes = Object.create(null);
      account.groupNotes[id] = String(note).replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    saveState();
    render();
    return syncConfig().then(function (result) {
      return refreshStatus().then(function () {
        var serverAccount = result && result.ok === true && Array.isArray(result.accounts)
          ? result.accounts.find(function (row) { return row && row.appId === appId; }) : null;
        var confirmed = serverAccount && Array.isArray(serverAccount.groups)
          && serverAccount.groups.some(function (serverGroup) {
            return serverGroup && serverGroup.groupOpenId === id && serverGroup.roleId === role && serverGroup.takeover === false;
          });
        if (!confirmed) {
          account.groups = account.groups.filter(function (group) { return group.groupOpenId !== id; });
          if (previousNote) account.groupNotes[id] = previousNote;
          else if (account.groupNotes) delete account.groupNotes[id];
          saveState();
          render();
          setNotice('本地服务未确认群聊授权；本地添加已撤销，群接管保持关闭。', 'error');
        } else setNotice('群聊已添加为人工使用；需要时可单独开启此群接管。', 'info');
        return result;
      });
    });
  }
  function removeGroup(appId, groupOpenId) {
    var account = findAccount(appId);
    if (!account) return;
    var id = String(groupOpenId || '');
    account.groups = account.groups.filter(function (group) { return group.groupOpenId !== id; });
    if (account.groupNotes) delete account.groupNotes[id];
    delete replyErrors[appId];
    persistAndSync();
  }
  function addGroupFromInput(node, appId) {
    var input = node && node.querySelector('[data-qq-group-id-input]');
    var id = String(input && input.value || '').trim();
    if (!id) { setNotice('请输入群 OpenID，或从待授权群中添加。', 'error'); return; }
    if (input) input.value = '';
    return authorizeGroup(appId, id);
  }
  function vaultWrite(appId, secret) {
    if (typeof window._ibWriteVaultCredential !== 'function') return Promise.reject(new Error('credentials-service-unavailable'));
    return window._ibWriteVaultCredential(credentialRef(appId), { provider: 'qqbot', endpoint: '', model: '' }, secret);
  }
  function vaultDelete(appId) {
    if (typeof window._ibDeleteVaultCredential !== 'function') return Promise.reject(new Error('credentials-service-unavailable'));
    return window._ibDeleteVaultCredential(credentialRef(appId));
  }
  function addBot(form) {
    var appId = String(form.elements.appId.value || '').trim();
    var secretInput = form.elements.appSecret;
    var secret = String(secretInput && secretInput.value || '').trim();
    var roleId = String(form.elements.roleId.value || '').trim();
    var displayName = String(form.elements.displayName && form.elements.displayName.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    var allowed = form.elements.allowedUserOpenIds ? parseOpenIds(form.elements.allowedUserOpenIds.value) : [];
    var combinedIntentConsent = form.elements.combinedIntentConsent && form.elements.combinedIntentConsent.checked === true;
    if (!APP_ID_RE.test(appId) || !secret || !roleId) { setNotice('请提供有效 AppID、AppSecret 和可用角色。', 'error'); return; }
    if (!combinedIntentConsent) { setNotice('请先确认此 Bot 的私聊 / 群聊接入范围。', 'error'); return; }
    if (findAccount(appId)) { setNotice('这个 AppID 已登记；请在该 Bot 卡片中更换密钥。', 'error'); return; }
    if (state.accounts.length >= 16) { setNotice('最多登记 16 个官方 Bot。', 'error'); return; }
    var availability = roleAvailability(roleId);
    if (!availability.available) { setNotice(availability.reason || '当前角色不可用。', 'error'); return; }
    setNotice('正在把 AppSecret 写入 Credential Vault…', 'info');
    vaultWrite(appId, secret).then(function () {
      secretInput.value = '';
      state.accounts.push({ appId: appId, displayName: displayName, roleId: roleId, takeover: false, allowedUserOpenIds: allowed,
        privateRoleSelections: [], groups: [], userNotes: Object.create(null), groupNotes: Object.create(null), memberNames: Object.create(null),
        combinedIntentConsent: true, credentialSaved: true });
      saveState();
      return syncConfig();
    }).then(function (result) {
      if (!result || !result.ok) return;
      render();
      return startAccount(appId);
    }).catch(function (error) {
      secretInput.value = '';
      setNotice(String(error && error.message || '').indexOf('credentials') >= 0
        ? 'Credential Vault 未确认保存；Bot 尚未连接。'
        : 'AppSecret 保存失败；Bot 尚未连接。', 'error');
    });
  }
  function startAccount(appId) {
    var account = findAccount(appId);
    if (account && account.sourceDisconnectRequired && account.credentialSaved !== true) {
      setNotice('连接前请先在当前环境的 Credential Vault 中保存 AppSecret。', 'error');
      return;
    }
    if (account && account.sourceDisconnectRequired && account.sourceDisconnectedConfirmed !== true) {
      setNotice('连接前请先在 Dev 断开此 Bot，并在高级设置中确认。', 'error');
      return;
    }
    if (account && account.combinedIntentConsent !== true) {
      setNotice('连接前请先确认此 Bot 的私聊 / 群聊接入范围。', 'error');
      return;
    }
    var api = remote();
    if (!api || typeof api.connect !== 'function') { setNotice('本地服务暂不可用，请稍后重试。', 'error'); return; }
    var operationRevision = beginConnectionNotice(appId, 'connect', '正在连接 QQ 官方服务…');
    return Promise.resolve(api.connect(appId)).then(function (result) {
      if (!connectionNoticeCurrent(operationRevision)) return result;
      if (!result || result.ok !== true) {
        updateConnectionNotice(operationRevision, errorLabel(result && result.error || 'official-start-failed'), 'error', true);
        return result;
      }
      resumeConnectedByAppId[String(appId)] = true;
      return refreshStatusForConnection(operationRevision).then(function () { return result; });
    }).catch(function () {
      updateConnectionNotice(operationRevision, '本地服务未能启动 QQ 连接。', 'error', true);
      return { ok: false, error: 'official-start-failed' };
    });
  }
  function stopAccount(appId) {
    var api = remote();
    if (!api || typeof api.disconnect !== 'function') return Promise.resolve({ ok: false, error: 'qq-official-remote-missing' });
    var operationRevision = beginConnectionNotice(appId, 'disconnect', '正在断开官方 Bot…');
    return Promise.resolve(api.disconnect(appId)).then(function (result) {
      if (!connectionNoticeCurrent(operationRevision)) return result;
      if (!result || result.ok !== true) {
        updateConnectionNotice(operationRevision, errorLabel(result && result.error || 'official-stopped'), 'error', true);
        return result;
      }
      resumeConnectedByAppId[String(appId)] = false;
      return refreshStatusForConnection(operationRevision).then(function () { return result; });
    }).catch(function () {
      updateConnectionNotice(operationRevision, '断开请求未完成。', 'error', true);
      return { ok: false, error: 'official-disconnect-failed' };
    });
  }
  function removeAccount(appId) {
    if (typeof window.confirm === 'function'
      && !window.confirm('将停止此 Bot、移除本地绑定，并从 Credential Vault 删除该 Bot 的 AppSecret。其他角色凭据与 NapCat 数据不受影响。继续？')) return;
    var api = remote();
    var stop = api && typeof api.disconnect === 'function' ? api.disconnect(appId) : Promise.resolve({ ok: true });
    Promise.resolve(stop).then(function (result) {
      if (!result || result.ok !== true) throw new Error('official-disconnect-failed');
      return vaultDelete(appId);
    }).then(function () {
      var roles = roleApi();
      if (roles && typeof roles._clearConversationAccount === 'function') {
        try { roles._clearConversationAccount(accountId(appId)); } catch (_) {}
      }
      state.accounts = state.accounts.filter(function (row) { return row.appId !== appId; });
      delete statusByAppId[appId];
      delete resumeConnectedByAppId[appId];
      delete replyErrors[appId];
      saveState();
      return syncConfig();
    }).then(function () { setNotice('Bot 配置与对应 Vault 密钥已移除。', 'info'); refreshStatus(); })
      .catch(function () { setNotice('移除未完成；本地绑定仍保留，请检查断开状态与 Credential Vault。', 'error'); });
  }
  function updateSecret(node, appId) {
    var input = node && node.querySelector('[data-qq-official-secret]');
    var secret = String(input && input.value || '').trim();
    if (!secret) { setNotice('请输入新的 AppSecret。', 'error'); return; }
    vaultWrite(appId, secret).then(function () {
      if (input) input.value = '';
      var account = findAccount(appId);
      if (account) { account.credentialSaved = true; saveState(); }
      return stopAccount(appId).then(function (result) {
        if (result && result.ok === false) return;
        setNotice('AppSecret 已保存到 Credential Vault。你可以重新连接以加载新凭据。', 'info');
      });
    }).catch(function () {
      if (input) input.value = '';
      setNotice('Vault 未确认保存新 AppSecret；未更改连接。', 'error');
    });
  }
  function authorizeOpenId(appId, openId, roleId, note) {
    var account = findAccount(appId);
    var id = String(openId || '').trim();
    var role = String(roleId || '').trim();
    if (!account || !OPEN_ID_RE.test(id)) return;
    if (!account.allowedUserOpenIds.includes(id) && account.allowedUserOpenIds.length >= 20) {
      setNotice('此 Bot 已达到 20 位私聊授权用户上限；请先撤销不再使用的授权。', 'error');
      return;
    }
    if (!role || !roleAvailability(role).available) { setNotice('请为此用户选择一个可用角色后再批准。', 'error'); return; }
    var previousAllowed = account.allowedUserOpenIds.slice();
    var previousSelections = account.privateRoleSelections.slice();
    account.allowedUserOpenIds = parseOpenIds(account.allowedUserOpenIds.concat([id]));
    updatePrivateRoleSelection(account, id, role, newSessionId());
    if (note) {
      if (!account.userNotes) account.userNotes = Object.create(null);
      account.userNotes[id] = String(note).replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    persistAndSync().then(function (result) {
      var serverAccount = result && result.ok === true && Array.isArray(result.accounts)
        ? result.accounts.find(function (row) { return row && row.appId === appId; }) : null;
      if (!serverAccount || Number(serverAccount.allowedUserCount) !== account.allowedUserOpenIds.length) {
        account.allowedUserOpenIds = previousAllowed;
        account.privateRoleSelections = previousSelections;
        saveState();
        render();
        setNotice('本地服务未确认用户授权；本地批准已撤销，请稍后重试。', 'error');
        return;
      }
      setNotice('用户已批准并绑定角色；账号级私聊接管设置保持不变。', 'info');
    });
  }
  function providerErrorCode(value) {
    var safe = {
      'provider-unavailable': true, 'provider-failed': true, 'role-unavailable': true,
      'role-config-unavailable': true, 'credential-vault-unavailable': true,
      'context-failed': true, 'invalid-event': true, 'empty-output': true,
      'vision-unavailable': true, 'image-input-invalid': true, 'image-output-invalid': true, 'image-output-disabled': true,
      'image-download-failed': true, 'image-too-large': true, 'image-type-unsupported': true
    };
    var code = String(value || '');
    return safe[code] ? code : 'provider-failed';
  }
  async function reportProgress(api, event, stage, errorCode) {
    if (!api || typeof api.progress !== 'function') return { ok: false, error: 'diagnostics-unavailable' };
    try { return await api.progress(event.requestId, stage, errorCode); }
    catch (_) { return { ok: false, error: 'home-node-unreachable' }; }
  }
  function clearImagePayloads(images) {
    (Array.isArray(images) ? images : []).forEach(function (image) {
      if (image && typeof image === 'object') image.base64 = '';
    });
  }
  function normalizeCommandText(value) {
    return String(value == null ? '' : value).replace(/<@!?[^>]+>\s*/g, '').trim();
  }
  function parseTextCommand(value) {
    var text = normalizeCommandText(value);
    if (text.charAt(0) !== '/') return null;
    var match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return { name: '', args: '', unknown: true };
    return { name: String(match[1] || '').toLowerCase(), args: String(match[2] || '').trim(), unknown: false };
  }
  function peerStateKey(event) {
    if (!event) return '';
    var peerId = event.messageType === 'group'
      ? String(event.groupOpenId || event.peerId || '') : String(event.senderId || event.peerId || '');
    if (!peerId || !event.accountId) return '';
    return String(event.accountId) + ':' + String(event.messageType || '') + ':' + peerId;
  }
  function revisionForPeer(key) { return Number(peerSessionRevision[key]) || 0; }
  function invalidatePeerSession(key) { peerSessionRevision[key] = revisionForPeer(key) + 1; }
  function newSessionId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return 's-' + window.crypto.randomUUID().replace(/-/g, '');
    } catch (_) {}
    return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
  }
  function resetConfiguredPeerContext(account, messageType, peerId, oldSessionId) {
    if (!account || !peerId) return;
    var event = {
      accountId: accountId(account.appId),
      messageType: messageType,
      peerId: String(peerId),
      sessionId: parseSessionId(oldSessionId)
    };
    if (messageType === 'group') event.groupOpenId = String(peerId);
    else event.senderId = String(peerId);
    invalidatePeerSession(peerStateKey(event));
    var roles = roleApi();
    if (roles && typeof roles._conversationReset === 'function') {
      try { roles._conversationReset(event); } catch (_) {}
    }
  }
  function resetDefaultPrivateSessions(account, nextRoleId) {
    if (!account) return;
    var rows = parsePrivateRoleSelections(account.privateRoleSelections, account.allowedUserOpenIds);
    account.allowedUserOpenIds.forEach(function (userOpenId) {
      if (rows.some(function (row) { return row.userOpenId === userOpenId; })) return;
      resetConfiguredPeerContext(account, 'private', userOpenId, DEFAULT_SESSION_ID);
      if (nextRoleId) rows.push({ userOpenId: userOpenId, roleId: nextRoleId, sessionId: newSessionId() });
    });
    account.privateRoleSelections = parsePrivateRoleSelections(rows, account.allowedUserOpenIds);
  }
  function roleDisplayName(role) {
    return String(role && (role.name || role.nickname || role.id) || '角色').trim();
  }
  function roleCatalogSnapshot(roles) {
    try { return roles && typeof roles._roleCatalogSnapshot === 'function' ? roles._roleCatalogSnapshot() : null; }
    catch (_) { return null; }
  }
  async function availableRoleList(roles) {
    if (roles && typeof roles.refreshRoleCatalog === 'function') {
      try { await roles.refreshRoleCatalog(); } catch (_) {}
    }
    var snapshot = roleCatalogSnapshot(roles);
    if (!snapshot || snapshot.state !== 'ready' || !Array.isArray(snapshot.roles)) return { ok: false, roles: [] };
    return {
      ok: true,
      roles: snapshot.roles.filter(function (role) {
        if (!role || !String(role.id || '').trim()) return false;
        var availability = roleAvailability(role.id);
        return availability.available === true;
      })
    };
  }
  function renderRoleList(roleRows) {
    var rows = Array.isArray(roleRows) ? roleRows : [];
    var counts = Object.create(null);
    rows.forEach(function (role) {
      var key = roleDisplayName(role).toLocaleLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    var labels = rows.slice(0, 30).map(function (role) {
      var label = roleDisplayName(role);
      return counts[label.toLocaleLowerCase()] > 1 ? label + '（id:' + String(role.id || '') + '）' : label;
    });
    if (!labels.length) return '当前没有可用于 QQ 的角色。';
    return '可用角色：' + labels.join('、') + (roleRows.length > labels.length ? ' 等' : '')
      + '\n切换：/role 角色名';
  }
  function findRoleByCommandName(roleRows, commandValue) {
    var query = String(commandValue || '').trim();
    if (!query) return { role: null, ambiguous: false };
    if (query.indexOf('id:') === 0) {
      var byId = roleRows.filter(function (role) { return String(role.id || '') === query.slice(3).trim(); });
      return { role: byId.length === 1 ? byId[0] : null, ambiguous: byId.length > 1 };
    }
    var byName = roleRows.filter(function (role) {
      return roleDisplayName(role).toLocaleLowerCase() === query.toLocaleLowerCase();
    });
    if (byName.length === 1) return { role: byName[0], ambiguous: false };
    if (byName.length > 1) return { role: null, ambiguous: true, ids: byName.map(function (role) { return String(role.id || ''); }) };
    var byIdExact = roleRows.filter(function (role) { return String(role.id || '') === query; });
    return { role: byIdExact.length === 1 ? byIdExact[0] : null, ambiguous: byIdExact.length > 1 };
  }
  function roleNameById(roles, roleId) {
    var snapshot = roleCatalogSnapshot(roles);
    var role = snapshot && Array.isArray(snapshot.roles)
      ? snapshot.roles.find(function (row) { return String(row.id || '') === String(roleId || ''); }) : null;
    return role ? roleDisplayName(role) : String(roleId || '未绑定');
  }
  function sendSetForPeer(key) {
    if (!activeSendsByPeer[key]) activeSendsByPeer[key] = new Set();
    return activeSendsByPeer[key];
  }
  function trackPeerSend(key, promise) {
    var set = sendSetForPeer(key);
    set.add(promise);
    var cleanup = function () {
      set.delete(promise);
      if (!set.size) delete activeSendsByPeer[key];
    };
    promise.then(cleanup, cleanup);
    return promise;
  }
  async function waitForPeerSends(key) {
    while (activeSendsByPeer[key] && activeSendsByPeer[key].size) {
      await Promise.all(Array.from(activeSendsByPeer[key]).map(function (promise) { return Promise.resolve(promise).catch(function () {}); }));
    }
  }
  function isCurrentProviderTurn(event, token) {
    var account = event && findAccount(event.appId);
    return !!event && !stopped && !state.paused && accountHandlesEvent(account, event)
      && revisionForPeer(token.peerKey) === token.revision
      && String(event.roleId || '') === token.roleId
      && String(event.sessionId || DEFAULT_SESSION_ID) === token.sessionId;
  }
  function clearEventImages(event) {
    if (event && Array.isArray(event.images)) {
      clearImagePayloads(event.images);
      event.images.length = 0;
    }
  }
  async function rejectEvent(event, api) {
    if (event && event.requestId && api) {
      try { await api.complete(event.requestId, ''); } catch (_) {}
    }
    clearEventImages(event);
  }
  async function processProviderEvent(event) {
    var api = remote();
    var account = event && findAccount(event.appId);
    var roles = roleApi();
    if (!event || !api || !account || state.paused || !accountHandlesEvent(account, event)
      || !roles || typeof roles._conversationReply !== 'function') {
      await rejectEvent(event, api);
      return;
    }
    var peerKey = peerStateKey(event);
    var token = {
      peerKey: peerKey,
      revision: revisionForPeer(peerKey),
      roleId: String(event.roleId || ''),
      sessionId: String(event.sessionId || DEFAULT_SESSION_ID)
    };
    await reportProgress(api, event, 'provider-started');
    if (!isCurrentProviderTurn(event, token)) { await rejectEvent(event, api); return; }
    var result;
    try { result = await roles._conversationReply(event); }
    catch (_) { result = { ok: false, error: 'provider-failed' }; }
    finally { clearEventImages(event); }
    if (!isCurrentProviderTurn(event, token)) {
      clearImagePayloads(result && result.images);
      await rejectEvent(event, api);
      return;
    }
    var outputImages = result && Array.isArray(result.images) ? result.images : [];
    var hasOutput = !!(result && result.ok === true
      && (String(result.reply || '').trim() || outputImages.length));
    if (!hasOutput) {
      var providerError = result && result.ok === true
        ? 'empty-output' : providerErrorCode(result && result.error || 'provider-failed');
      await reportProgress(api, event, 'provider-failed', providerError);
      await rejectEvent(event, api);
      clearImagePayloads(outputImages);
      if (result && Array.isArray(result.images)) result.images.length = 0;
      if (isCurrentProviderTurn(event, token)) {
        replyErrors[event.appId] = providerError;
        renderAccountStatus();
      }
      return;
    }
    await reportProgress(api, event, 'provider-ready');
    if (!isCurrentProviderTurn(event, token)) {
      clearImagePayloads(outputImages);
      await rejectEvent(event, api);
      if (result && Array.isArray(result.images)) result.images.length = 0;
      return;
    }
    var sendPromise = Promise.resolve().then(function () { return api.complete(event.requestId, result.reply, outputImages); });
    var sent;
    try { sent = await trackPeerSend(peerKey, sendPromise); }
    catch (_) { sent = { ok: false, error: 'home-node-unreachable' }; }
    clearImagePayloads(outputImages);
    if (result && Array.isArray(result.images)) result.images.length = 0;
    if (!sent || sent.ok !== true || sent.replied !== true) {
      if (isCurrentProviderTurn(event, token)) {
        replyErrors[event.appId] = sent && sent.error || 'official-send-failed';
        renderAccountStatus();
      }
      return;
    }
    if (isCurrentProviderTurn(event, token)) {
      roles._conversationCommit(result);
      delete replyErrors[event.appId];
      renderAccountStatus();
    }
  }
  function queueProviderEvent(event) {
    var peerKey = peerStateKey(event);
    var key = peerKey + ':session:' + String(event && event.sessionId || DEFAULT_SESSION_ID);
    var previous = providerQueuesByPeer[key] || Promise.resolve();
    var task = previous.catch(function () {}).then(function () { return processProviderEvent(event); });
    providerQueuesByPeer[key] = task;
    task.then(function () { if (providerQueuesByPeer[key] === task) delete providerQueuesByPeer[key]; },
      function () { if (providerQueuesByPeer[key] === task) delete providerQueuesByPeer[key]; });
    return task;
  }
  function commandHelp() {
    return '支持命令：/role、/role 角色名、/who、/reset';
  }
  function updatePrivateRoleSelection(account, userOpenId, roleId, sessionId) {
    var rows = parsePrivateRoleSelections(account.privateRoleSelections, account.allowedUserOpenIds)
      .filter(function (row) { return row.userOpenId !== String(userOpenId || ''); });
    rows.push({ userOpenId: String(userOpenId || ''), roleId: String(roleId || ''), sessionId: parseSessionId(sessionId) });
    account.privateRoleSelections = parsePrivateRoleSelections(rows, account.allowedUserOpenIds);
  }
  async function commitSessionChange(event, account, roles, roleId, action) {
    var peerKey = peerStateKey(event);
    var oldSessionId = String(event.sessionId || DEFAULT_SESSION_ID);
    var nextSessionId = newSessionId();
    invalidatePeerSession(peerKey);
    if (roles && typeof roles._conversationReset === 'function') {
      try { roles._conversationReset(Object.assign({}, event, { sessionId: oldSessionId })); } catch (_) {}
    }
    if (event.messageType === 'group') {
      var group = groupBinding(account, event.groupOpenId || event.peerId);
      if (group) { if (roleId) group.roleId = roleId; group.sessionId = nextSessionId; }
    } else {
      var currentRole = roleId || String(event.roleId || account.roleId || '');
      updatePrivateRoleSelection(account, event.senderId, currentRole, nextSessionId);
    }
    saveState();
    render();
    await waitForPeerSends(peerKey);
    return { changed: true, action: action, sessionId: nextSessionId };
  }
  async function executeCommandAction(event, command) {
    var account = event && findAccount(event.appId);
    var roles = roleApi();
    if (!event || !account || state.paused || !accountHandlesEvent(account, event)) {
      return { reply: '当前 QQ 会话未授权或已暂停。', changed: false };
    }
    var name = String(command && command.name || '').toLowerCase();
    var args = String(command && command.args || '').trim();
    if (command && command.unknown) return { reply: commandHelp(), changed: false };
    if (name === 'who') {
      if (args) return { reply: '用法：/who', changed: false };
      return { reply: '当前角色：' + roleNameById(roles, event.roleId), changed: false };
    }
    if (name !== 'role' && name !== 'reset') return { reply: commandHelp(), changed: false };
    if (name === 'role' && !args) {
      var roleCatalog = await availableRoleList(roles);
      return { reply: roleCatalog.ok ? renderRoleList(roleCatalog.roles) : '角色目录暂不可用，请稍后重试。', changed: false };
    }
    if (event.messageType === 'group' && event.canManageConversation !== true) {
      return { reply: '只有 IB 群设置中明确授权的指令管理者可以切换角色或重置群会话。', changed: false };
    }
    if (name === 'reset') {
      if (args) return { reply: '用法：/reset', changed: false };
      await commitSessionChange(event, account, roles, '', 'reset');
      return { reply: '已重置当前 QQ 会话上下文；角色保持不变，长期 Memory 未删除。', changed: true };
    }
    var available = await availableRoleList(roles);
    if (!available.ok) return { reply: '角色目录暂不可用，请稍后重试。', changed: false };
    var selected = findRoleByCommandName(available.roles, args);
    if (!selected.role) {
      if (selected.ambiguous) {
        return { reply: '角色名称重复，请使用 /role id:<角色ID>。可选 ID：' + (selected.ids || []).join('、'), changed: false };
      }
      return { reply: '没有可用角色与「' + args.slice(0, 120) + '」匹配。\n' + renderRoleList(available.roles), changed: false };
    }
    if (String(selected.role.id || '') === String(event.roleId || '')) {
      return { reply: '当前已经是「' + roleDisplayName(selected.role) + '」，会话上下文未更改。', changed: false };
    }
    await commitSessionChange(event, account, roles, String(selected.role.id || ''), 'role');
    return { reply: '已切换到「' + roleDisplayName(selected.role) + '」，并开启全新 QQ 会话。', changed: true };
  }
  async function dispatchCommand(event, command, replySender) {
    var result = await executeCommandAction(event, command);
    var sent = { ok: true, replied: true };
    if (typeof replySender === 'function') {
      try { sent = await replySender(result.reply); } catch (_) { sent = { ok: false, error: 'official-send-failed' }; }
    } else {
      var api = remote();
      if (!api || !event || !event.requestId) return { ok: false, error: 'command-reply-unavailable' };
      try { sent = await api.complete(event.requestId, result.reply); }
      catch (_) { sent = { ok: false, error: 'home-node-unreachable' }; }
    }
    if (result.changed) {
      var sync = await syncConfig();
      if (!sync || sync.ok !== true) setNotice('角色或会话已在本地切换，但设置未同步；请稍后重试。', 'error');
      else { await refreshStatus(); setNotice(result.reply, 'info'); }
    }
    if (!sent || sent.ok !== true || sent.replied === false) {
      replyErrors[event.appId] = sent && sent.error || 'official-send-failed';
      renderAccountStatus();
      return { ok: false, error: replyErrors[event.appId] };
    }
    renderAccountStatus();
    return { ok: true, replied: true, changed: result.changed === true };
  }
  function processEvent(event) {
    var command = parseTextCommand(event && event.text);
    return command ? dispatchCommand(event, command) : queueProviderEvent(event);
  }
  async function pollOnce() {
    if (stopped) return;
    var api = remote();
    if (!api || typeof api.poll !== 'function') return;
    if (!state.paused && state.accounts.some(accountHasTakeover)) {
      try {
        var result = await api.poll(1000);
        if (result && result.ok && result.event) {
          rememberGroupSenderName(result.event);
          var command = parseTextCommand(result.event.text);
          if (command) await dispatchCommand(result.event, command);
          else queueProviderEvent(result.event).catch(function () {});
        }
        if (result && result.ok) {
          noteHomeNodeResponse();
          clearPollFailure();
        } else if (result && result.error) throw new Error('home-node-unreachable');
      } catch (_) {
        /* One failed event poll does not prove Home Node is down. The status
           endpoint owns the service badge; repeated poll failures get their own
           notice and continue through the existing bounded retry loop. */
        notePollFailure();
      }
    }
  }
  function schedulePoll(delay) {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      pollOnce().finally(function () { schedulePoll(state.paused ? 2000 : 250); });
    }, delay);
  }
  async function refreshStatusOnce() {
    var connectionRevisionAtStart = connectionActionRevision;
    var api = remote();
    if (!api || typeof api.status !== 'function') {
      noteStatusFailure('home-node-unreachable');
      return false;
    }
    try {
      if (typeof api.heartbeat === 'function') await api.heartbeat();
      var result = await api.status();
      if (!result || result.ok !== true || !Array.isArray(result.accounts)) {
        noteStatusFailure(result && result.error || 'home-node-unreachable');
        return false;
      }
      noteHomeNodeResponse();
      rememberConnectionStates(result.accounts);
      var reconciled = await reconcileHomeNodeAccounts(api, result.accounts);
      if (reconciled && reconciled.ok === true && Array.isArray(reconciled.accounts)) result = reconciled;
      else if (reconciled && reconciled.ok === false) {
        setNotice('本地服务已恢复，但 QQ 设置尚未同步：' + errorLabel(reconciled.error || 'home-node-unreachable'), 'error');
        return false;
      }
      rememberConnectionStates(result.accounts);
      statusByAppId = Object.create(null);
      result.accounts.forEach(function (row) { statusByAppId[String(row.appId)] = row; });
      lastStatusActionRevision = connectionRevisionAtStart;
      reflectConnectionNotice(connectionRevisionAtStart);
      if (noticeKind === 'error' && notice.indexOf('本地服务已恢复，但 QQ 设置尚未同步：') === 0) {
        clearRecoveryNotice();
      }
      renderAccountStatus();
      return true;
    } catch (_) {
      noteStatusFailure('home-node-unreachable');
      return false;
    }
  }
  function refreshStatus() {
    if (statusRefreshInFlight) return statusRefreshInFlight;
    var pending = refreshStatusOnce().finally(function () {
      if (statusRefreshInFlight === pending) statusRefreshInFlight = null;
    });
    statusRefreshInFlight = pending;
    return pending;
  }
  function refreshStatusForConnection(revision) {
    return Promise.resolve(refreshStatus()).then(function () {
      /* A status request already in flight before this connect/disconnect action
         may return an older snapshot. Follow it with one fresh read so the newer
         operation's notice is reconciled against post-action state. */
      if (connectionNoticeCurrent(revision) && lastStatusActionRevision < revision) return refreshStatus();
      return null;
    });
  }
  function bindEvents(root) {
    if (root.__qqOfficialBound) return;
    root.__qqOfficialBound = true;
    root.addEventListener('submit', function (event) {
      var form = event.target;
      if (!form || form.id !== 'qq-official-add-form') return;
      event.preventDefault();
      addBot(form);
    });
    root.addEventListener('input', function (event) {
      var input = event.target;
      if (!input || !input.getAttribute) return;
      var kind = input.getAttribute('data-qq-local-note-kind');
      if (!kind) return;
      var accountNode = input.closest('.qq-official-account');
      var account = accountNode && findAccount(accountNode.getAttribute('data-app-id'));
      if (account) setLocalNote(account.appId, kind, input.getAttribute('data-local-id'), input.value);
    });
    root.addEventListener('change', function (event) {
      var input = event.target;
      if (!input || !input.getAttribute) return;
      if (input.hasAttribute('data-qq-migration-file')) { readMigrationFile(input); return; }
      if (input.hasAttribute('data-qq-migration-role-map')) {
        if (pendingMigration) {
          pendingMigration.roleMap[input.getAttribute('data-qq-migration-role-map')] = String(input.value || '');
          pendingMigration.confirmed = false;
          pendingMigration.confirmationKey = '';
          renderMigrationPreview();
        }
        return;
      }
      if (input.hasAttribute('data-qq-migration-confirm')) {
        if (pendingMigration) {
          var plan = migrationPreviewPlan();
          pendingMigration.confirmed = input.checked === true;
          pendingMigration.confirmationKey = pendingMigration.confirmed ? migrationConfirmationKey(plan) : '';
        }
        updateMigrationApplyButton();
        return;
      }
      var localKind = input.getAttribute('data-qq-local-note-kind');
      if (localKind) {
        var localAccountNode = input.closest('.qq-official-account');
        var localAccount = localAccountNode && findAccount(localAccountNode.getAttribute('data-app-id'));
        if (localAccount) {
          var localId = input.getAttribute('data-local-id');
          setLocalNote(localAccount.appId, localKind, localId, input.value);
          if (localKind === 'bot') {
            var botName = localAccountNode.querySelector('.qq-official-account-identity strong');
            if (botName) botName.textContent = String(input.value || '').trim() || 'QQ 官方机器人';
          } else renderAccountStatus();
        }
        return;
      }
      if (input.hasAttribute('data-qq-pending-role')) {
        var pendingCard = input.closest('.qq-official-pending-card');
        var roleHint = pendingCard && pendingCard.querySelector('[data-qq-role-hint]');
        if (roleHint) roleHint.innerHTML = providerSetupHint(input.value);
        var approveButton = pendingCard && pendingCard.querySelector('[data-qq-official-action="approve-user"], [data-qq-official-action="approve-group"]');
        if (approveButton) approveButton.disabled = !roleAvailability(input.value).available;
        return;
      }
      if (input.hasAttribute('data-qq-private-role')) {
        var privateAccount = input.closest('.qq-official-account');
        if (privateAccount) setPrivateUserRole(privateAccount.getAttribute('data-app-id'), input.getAttribute('data-user-open-id'), input.value);
        return;
      }
      var groupField = input.getAttribute('data-qq-group-field');
      if (groupField) {
        var groupRow = input.closest('.qq-official-group-row');
        var groupAccountRow = input.closest('.qq-official-account');
        if (groupRow && groupAccountRow) {
          var groupValue = groupField === 'takeover' ? input.checked : input.value;
          setGroupField(groupAccountRow.getAttribute('data-app-id'), groupRow.getAttribute('data-group-openid'), groupField, groupValue);
        }
        return;
      }
      if (input.hasAttribute('data-qq-official-global-pause')) {
        state.paused = input.checked === true;
        persistAndSync();
        return;
      }
      var field = input.getAttribute('data-qq-official-field');
      if (!field) return;
      var row = input.closest('.qq-official-account');
      if (!row) return;
      var value = field === 'takeover' || field === 'combinedIntentConsent' || field === 'sourceDisconnectedConfirmed'
        ? input.checked === true : input.value;
      setAccountField(row.getAttribute('data-app-id'), field, value);
    });
    root.addEventListener('click', function (event) {
      var button = event.target && event.target.closest('[data-qq-official-action]');
      if (!button) return;
      var action = button.getAttribute('data-qq-official-action');
      var row = button.closest('.qq-official-account');
      var appId = row && row.getAttribute('data-app-id');
      var groupRow = button.closest('.qq-official-group-row');
      var groupOpenId = groupRow ? groupRow.getAttribute('data-group-openid') : button.getAttribute('data-group-openid');
      if (action === 'migration-export') exportMigrationFile();
      else if (action === 'migration-choose') {
        var migrationInput = root.querySelector('[data-qq-migration-file]');
        if (migrationInput) migrationInput.click();
      }
      else if (action === 'migration-clear') clearMigrationPreview();
      else if (action === 'migration-apply') applyMigration();
      else if (action === 'pause') {
        state.paused = !state.paused;
        persistAndSync();
      } else if (action === 'connect' && appId) startAccount(appId);
      else if (action === 'disconnect' && appId) stopAccount(appId);
      else if (action === 'remove' && appId) removeAccount(appId);
      else if (action === 'save-secret' && appId) updateSecret(row, appId);
      else if (action === 'approve-user' && appId) {
        var userCard = button.closest('[data-pending-user-card]');
        var userRole = userCard && userCard.querySelector('[data-qq-pending-role]');
        var userNote = userCard && userCard.querySelector('[data-qq-local-note-kind="user"]');
        authorizeOpenId(appId, button.getAttribute('data-open-id'), userRole && userRole.value, userNote && userNote.value);
      }
      else if (action === 'approve-group' && appId) {
        var groupCard = button.closest('[data-pending-group-card]');
        var groupRole = groupCard && groupCard.querySelector('[data-qq-pending-role]');
        var groupNote = groupCard && groupCard.querySelector('[data-qq-local-note-kind="group"]');
        authorizeGroup(appId, button.getAttribute('data-group-openid'), groupRole && groupRole.value, groupNote && groupNote.value);
      }
      else if (action === 'revoke-user' && appId) revokeUser(appId, button.getAttribute('data-open-id'));
      else if (action === 'authorize-group-admin' && appId && groupOpenId) {
        authorizeGroupAdmin(appId, groupOpenId, button.getAttribute('data-member-open-id'));
      }
      else if (action === 'add-group' && appId) addGroupFromInput(row, appId);
      else if (action === 'remove-group' && appId && groupOpenId) removeGroup(appId, groupOpenId);
      else if (action === 'open-provider-settings') {
        if (typeof window.navTo === 'function') window.navTo('api');
        else setNotice('无法打开角色设置；请从「AI 与连接」进入角色与 API 配置。', 'error');
      }
    });
  }
  function init() {
    if (initialized || !host()) return;
    initialized = true;
    refreshRoleCatalog().then(function () {
      render();
      return syncConfig();
    }).then(function () { refreshStatus(); schedulePoll(500); });
    setInterval(refreshStatus, 5000);
  }
  function refreshRoleCatalog() {
    var roles = roleApi();
    return roles && typeof roles.refreshRoleCatalog === 'function'
      ? Promise.resolve(roles.refreshRoleCatalog()).then(render)
      : Promise.resolve(null);
  }

  var api = NS.qqOfficialUI || {};
  Object.assign(api, {
    init: init,
    refreshRoleCatalog: refreshRoleCatalog,
    status: function () { return remote() ? remote().status() : Promise.resolve({ ok: false, error: 'qq-official-remote-missing' }); },
    _getState: function () { return JSON.parse(JSON.stringify(state)); },
    _dispatchCommand: dispatchCommand,
    _parseTextCommand: parseTextCommand,
    _processEvent: processEvent,
    _pollOnce: pollOnce,
    _refreshStatus: refreshStatus,
    _getConnectionState: function () {
      return transportError ? 'unavailable' : (hasHomeNodeResponse ? 'connected' : 'unknown');
    },
    _migrationExportBundle: migrationExportBundle,
    _validateMigrationBundle: validateMigrationBundle
  });
  NS.qqOfficialUI = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(window.IB || (window.IB = {}));
