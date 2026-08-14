/* IB Bridge · 轻量 JSON 持久化原语（无状态：只接受文件路径 / 数据目录，不持有业务状态）。
   从 ib-bridge-service.js 提取为工厂；业务数据（whispers 等）仍由 composition root 持有。
   原逻辑逐字不变。 */
'use strict';

const fs = require('fs');
const path = require('path');
const { backupBrokenFile } = require('./util');

function createPersistence(deps) {
  const dataDir = deps.dataDir;

  function jsonPath(name) {
    return path.join(dataDir, name + '.json');
  }

  /* writeJson 以显式文件路径工作并注入 config 工厂，
     避免工厂反向依赖根文件（循环引用）。 */
  function writeJson(file, obj) {
    const tmp = file + '.tmp';
    const bak = file + '.bak';
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, bak); } catch (e) { /* 忽略备份失败 */ }
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
      return false;
    }
  }

  function saveJson(name, obj) {
    return writeJson(jsonPath(name), obj);
  }

  function loadJson(name, fallback) {
    const file = jsonPath(name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      if (fs.existsSync(file)) backupBrokenFile(file, '不是合法对象');
      return fallback;
    } catch (e) {
      if (fs.existsSync(file)) backupBrokenFile(file, '解析失败');
      return fallback;
    }
  }

  function loadList(name) {
    const file = jsonPath(name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
      if (fs.existsSync(file)) backupBrokenFile(file, '不是数组');
      return [];
    } catch (e) {
      if (fs.existsSync(file)) backupBrokenFile(file, '解析失败');
      return [];
    }
  }

  function saveList(name, list) {
    return saveJson(name, list);
  }

  function fileSummary(name) {
    const file = jsonPath(name);
    try {
      const stat = fs.statSync(file);
      return { name: name + '.json', bytes: stat.size, modified: stat.mtime.toISOString() };
    } catch (e) { return { name: name + '.json', bytes: 0, missing: true }; }
  }

  function directoryUsage(dir) {
    let bytes = 0, files = 0;
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const target = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            const nested = directoryUsage(target);
            bytes += nested.bytes; files += nested.files;
          } else if (entry.isFile()) {
            bytes += fs.statSync(target).size; files += 1;
          }
        } catch (e) { /* a file may disappear during scan */ }
      });
    } catch (e) { /* no access: return a partial result */ }
    return { bytes, files };
  }

  return { jsonPath, writeJson, saveJson, loadJson, loadList, saveList, fileSummary, directoryUsage };
}

module.exports = createPersistence;
