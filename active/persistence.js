/* IB Active · 持久化层：状态加载（主文件 → .tmp → .bak 依次恢复）、原子写入（临时文件 +
   fsync + 备份轮换）、50ms 合并保存队列。从 services/active-message-service.js 提取为工厂。
   state 由 composition root 持有（测试钩子 resetStateForTest 会重新赋值），工厂不保存
   state 引用，序列化时经注入的 getState() 读取当前绑定——与 bridge/routes 的 getter 模式一致。
   原逻辑逐字不变。 */
'use strict';

const fs = require('fs');
const path = require('path');

function createPersistence(deps) {
  const dataDir = deps.dataDir;
  const getState = deps.getState;
  const DATA_FILE = path.join(dataDir, 'active-message-service.json');
  const DATA_TEMP_FILE = DATA_FILE + '.tmp';
  const DATA_BACKUP_FILE = DATA_FILE + '.bak';

  function emptyData() {
    return { version: 3, tasks: {}, plans: {}, events: {}, history: {}, moments: {}, replyChains: {}, bgAi: { enabled: true, sleepStart: '', sleepEnd: '' } };
  }

  function parseDataFile(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('State root is not an object');
    }
    return {
      version: 3,
      tasks: parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : {},
      plans: parsed.plans && typeof parsed.plans === 'object' && !Array.isArray(parsed.plans) ? parsed.plans : {},
      events: parsed.events && typeof parsed.events === 'object' && !Array.isArray(parsed.events) ? parsed.events : {},
      history: parsed.history && typeof parsed.history === 'object' && !Array.isArray(parsed.history) ? parsed.history : {},
      moments: parsed.moments && typeof parsed.moments === 'object' && !Array.isArray(parsed.moments) ? parsed.moments : {},
      replyChains: parsed.replyChains && typeof parsed.replyChains === 'object' && !Array.isArray(parsed.replyChains) ? parsed.replyChains : {},
      /* 后台 AI 总开关：随 state 持久化，重启后仍保持（缺省默认启用，向后兼容） */
      bgAi: Object.assign({ enabled: true, sleepStart: '', sleepEnd: '' }, (parsed.bgAi && typeof parsed.bgAi === 'object' && !Array.isArray(parsed.bgAi)) ? parsed.bgAi : {})
    };
  }

  function loadData() {
    const candidates = [DATA_FILE, DATA_TEMP_FILE, DATA_BACKUP_FILE];
    let sawInvalid = false;
    for (const file of candidates) {
      try {
        const loaded = parseDataFile(file);
        if (file !== DATA_FILE) {
          console.warn(`[Active] Recovered state from ${path.basename(file)} because the main state file was unavailable.`);
        }
        return loaded;
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        sawInvalid = true;
        console.warn(`[Active] Could not read ${path.basename(file)}:`, error.message);
      }
    }
    if (sawInvalid) console.warn('[Active] No valid state copy remains; starting with an empty queue.');
    return emptyData();
  }

  let saveQueued = false;
  let saveTimer = null;
  let mutationChain = Promise.resolve();
  const mutationLedger = new Map();
  const TEST_METADATA_FIELD = '__r101_test_marker';
  const TARGET_TYPES = new Set(['moment_character', 'plan_character', 'task_character']);
  const MAX_METADATA_VALUE = 256;
  const MAX_TRANSACTION_ID = 120;

  function targetCharacter(state, targetType, targetId) {
    const bucket = targetType === 'moment_character'
      ? state.moments
      : targetType === 'plan_character'
        ? state.plans
        : targetType === 'task_character'
          ? state.tasks
          : null;
    const row = bucket && bucket[String(targetId || '')];
    return row && row.character && typeof row.character === 'object' ? row.character : null;
  }

  function validateMetadataMutation(request) {
    const input = request && typeof request === 'object' ? request : {};
    const targetType = String(input.targetType || '');
    const targetId = String(input.targetId || '');
    const transactionId = String(input.transactionId || '');
    const patch = input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch)
      ? input.patch
      : null;
    if (!TARGET_TYPES.has(targetType)) throw new Error('R101_TARGET_TYPE_NOT_ALLOWED');
    if (!targetId || targetId.length > 180) throw new Error('R101_TARGET_ID_INVALID');
    if (!transactionId || transactionId.length > MAX_TRANSACTION_ID) throw new Error('R101_TRANSACTION_ID_INVALID');
    if (!patch || Object.keys(patch).length !== 1 || !Object.prototype.hasOwnProperty.call(patch, TEST_METADATA_FIELD)) {
      throw new Error('R101_FIELD_NOT_ALLOWED');
    }
    const value = patch[TEST_METADATA_FIELD];
    if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE) {
      throw new Error('R101_METADATA_VALUE_INVALID');
    }
    return { targetType, targetId, transactionId, value };
  }

  function snapshotTarget(state, targetType, targetId, transactionId) {
    const character = targetCharacter(state, targetType, targetId);
    if (!character) throw new Error('R101_TARGET_NOT_FOUND');
    return {
      schemaVersion: 1,
      transactionId,
      targetType,
      targetId,
      field: TEST_METADATA_FIELD,
      existed: Object.prototype.hasOwnProperty.call(character, TEST_METADATA_FIELD),
      oldValue: character[TEST_METADATA_FIELD]
    };
  }

  function enqueueMutation(operation) {
    const run = mutationChain.then(operation);
    mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function mutateTargetMetadata(request) {
    const input = validateMetadataMutation(request);
    return enqueueMutation(() => {
      const previous = mutationLedger.get(input.transactionId);
      if (previous && previous.status === 'applied') {
        return { ok: false, status: 'ALREADY_APPLIED', transactionId: input.transactionId };
      }
      const character = targetCharacter(getState(), input.targetType, input.targetId);
      if (!character) throw new Error('R101_TARGET_NOT_FOUND');
      const snapshot = snapshotTarget(getState(), input.targetType, input.targetId, input.transactionId);
      character[TEST_METADATA_FIELD] = input.value;
      saveNow();
      const readback = snapshotTarget(getState(), input.targetType, input.targetId, input.transactionId);
      if (readback.oldValue !== input.value || !readback.existed) {
        character[TEST_METADATA_FIELD] = snapshot.existed ? snapshot.oldValue : undefined;
        if (!snapshot.existed) delete character[TEST_METADATA_FIELD];
        saveNow();
        throw new Error('R101_READBACK_MISMATCH');
      }
      mutationLedger.set(input.transactionId, { status: 'applied', snapshot });
      return { ok: true, status: 'APPLIED', transactionId: input.transactionId, snapshot };
    });
  }

  function rollbackTargetMetadata(snapshot) {
    const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return enqueueMutation(() => {
      const ledger = mutationLedger.get(String(input.transactionId || ''));
      if (!ledger) throw new Error('R101_TRANSACTION_NOT_FOUND');
      if (ledger.status === 'rolled_back') {
        return { ok: true, status: 'ALREADY_ROLLED_BACK', transactionId: input.transactionId };
      }
      const character = targetCharacter(getState(), ledger.snapshot.targetType, ledger.snapshot.targetId);
      if (!character) throw new Error('R101_TARGET_NOT_FOUND');
      if (ledger.snapshot.existed) character[TEST_METADATA_FIELD] = ledger.snapshot.oldValue;
      else delete character[TEST_METADATA_FIELD];
      saveNow();
      const restored = snapshotTarget(
        getState(),
        ledger.snapshot.targetType,
        ledger.snapshot.targetId,
        ledger.snapshot.transactionId
      );
      if (restored.existed !== ledger.snapshot.existed || restored.oldValue !== ledger.snapshot.oldValue) {
        throw new Error('R101_ROLLBACK_READBACK_MISMATCH');
      }
      ledger.status = 'rolled_back';
      return { ok: true, status: 'ROLLED_BACK', transactionId: input.transactionId };
    });
  }

  function fsyncFile(file) {
    const handle = fs.openSync(file, 'r');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  function fsyncDataDirectory() {
    try {
      const handle = fs.openSync(dataDir, 'r');
      try {
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch (_) {
      // Directory fsync is not available on every Windows/filesystem combination.
    }
  }

  function saveNow() {
    saveQueued = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const handle = fs.openSync(DATA_TEMP_FILE, 'w', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(getState(), null, 2), 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try {
      if (fs.existsSync(DATA_FILE)) {
        if (fs.existsSync(DATA_BACKUP_FILE)) fs.unlinkSync(DATA_BACKUP_FILE);
        fs.renameSync(DATA_FILE, DATA_BACKUP_FILE);
      }
      fs.renameSync(DATA_TEMP_FILE, DATA_FILE);
      try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
      fsyncDataDirectory();
    } catch (error) {
      /* Keep at least one readable main copy if the final rename fails. */
      try {
        if (!fs.existsSync(DATA_FILE) && fs.existsSync(DATA_BACKUP_FILE)) {
          fs.copyFileSync(DATA_BACKUP_FILE, DATA_FILE);
          fsyncFile(DATA_FILE);
        }
      } catch (_) {}
      throw error;
    }
  }

  function queueSave() {
    if (saveQueued) return;
    saveQueued = true;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        saveNow();
      } catch (error) {
        saveQueued = false;
        console.error('[Active] Could not persist queued state:', error.message);
      }
    }, 50);
  }

  return {
    loadData,
    saveNow,
    queueSave,
    emptyData,
    parseDataFile,
    mutateTargetMetadata,
    rollbackTargetMetadata
  };
}

module.exports = createPersistence;
