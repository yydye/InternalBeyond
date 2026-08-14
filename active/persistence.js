/* IB Active · 持久化层：状态加载（主文件 → .tmp → .bak 依次恢复）、原子写入（临时文件 +
   fsync + 备份轮换）、50ms 合并保存队列。从 active-message-service.js 提取为工厂。
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
    return { version: 3, tasks: {}, plans: {}, events: {}, history: {} };
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
      history: parsed.history && typeof parsed.history === 'object' && !Array.isArray(parsed.history) ? parsed.history : {}
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

  return { loadData, saveNow, queueSave, emptyData, parseDataFile };
}

module.exports = createPersistence;
