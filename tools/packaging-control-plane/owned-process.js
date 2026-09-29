'use strict';

/* Exact Windows process identity helpers. No process is selected by image name;
   every termination request carries PID, start time and parent PID. */

const childProcess = require('child_process');
const path = require('path');
const environmentInspector = require('./environment-inspector.js');

const PROCESS_QUERY_TIMEOUT_MS = 8000;
const OWNERSHIP_POLL_MS = 1500;

function powershellPath(env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, timeoutMs) {
  const env = environmentInspector.createBuildEnvironment();
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
  return new Promise((resolve) => {
    childProcess.execFile(powershellPath(env), args, {
      cwd: process.cwd(), env: env, windowsHide: true, shell: false,
      timeout: timeoutMs || PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      resolve(error ? { ok: false, stdout: '' } : { ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

function processProjection(variable, includeCommandLine) {
  const p = variable || '$p';
  const commandLine = includeCommandLine ? ',commandLine=[string]' + p + '.CommandLine' : '';
  return '[pscustomobject]@{' +
    'pid=[int]' + p + '.ProcessId;' +
    'parentPid=[int]' + p + '.ParentProcessId;' +
    'startTimeUtc=' + p + '.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",[Globalization.CultureInfo]::InvariantCulture);' +
    'name=[string]' + p + '.Name' + commandLine +
  '}';
}

function parseProcessRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const pid = Number(value.pid);
  const parentPid = Number(value.parentPid);
  const startTimeUtc = String(value.startTimeUtc || '');
  const startTimeMs = Date.parse(startTimeUtc);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
      !Number.isFinite(startTimeMs) || typeof value.name !== 'string') return null;
  const record = { pid: pid, parentPid: parentPid, startTimeUtc: startTimeUtc, startTimeMs: startTimeMs, name: value.name };
  if (typeof value.commandLine === 'string') record.commandLine = value.commandLine;
  return record;
}

function defaultAdapter() {
  async function listProcesses() {
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.CreationDate } | ForEach-Object { ' + processProjection('$_', false) + ' })',
      'if ($rows.Count -eq 0) { Write-Output "[]" } else { ConvertTo-Json -InputObject $rows -Compress -Depth 3 }'
    ].join(';');
    const output = await runPowerShell(script);
    if (!output.ok) throw new Error('process snapshot unavailable');
    let parsed;
    try { parsed = JSON.parse(output.stdout); } catch (_) { throw new Error('process snapshot malformed'); }
    return (Array.isArray(parsed) ? parsed : [parsed]).map(parseProcessRecord).filter(Boolean);
  }

  async function getProcess(pid) {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=' + value + '" -ErrorAction SilentlyContinue',
      'if (-not $p -or -not $p.CreationDate) { Write-Output "null" } else { ConvertTo-Json -InputObject (' + processProjection('$p', true) + ') -Compress -Depth 3 }'
    ].join(';');
    const output = await runPowerShell(script);
    if (!output.ok) throw new Error('process identity unavailable');
    let parsed;
    try { parsed = JSON.parse(output.stdout); } catch (_) { throw new Error('process identity malformed'); }
    return parsed ? parseProcessRecord(parsed) : null;
  }

  async function terminateProcess(record) {
    const pid = Number(record && record.pid);
    const parentPid = Number(record && record.parentPid);
    const startTime = String(record && record.startTimeUtc || '');
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startTime)) {
      return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
    }
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$wantedPid = ' + pid,
      '$wantedParent = ' + parentPid,
      '$wantedStart = "' + startTime + '"',
      '$w = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$wantedPid" -ErrorAction SilentlyContinue',
      'if (-not $w) { [pscustomobject]@{ state="ALREADY_EXITED" } | ConvertTo-Json -Compress; exit 0 }',
      '$wStart = $w.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",[Globalization.CultureInfo]::InvariantCulture)',
      'if ([int]$w.ParentProcessId -ne $wantedParent -or $wStart -ne $wantedStart) { [pscustomobject]@{ state="IDENTITY_MISMATCH" } | ConvertTo-Json -Compress; exit 0 }',
      '$p = Get-Process -Id $wantedPid -ErrorAction SilentlyContinue',
      'if (-not $p) { [pscustomobject]@{ state="ALREADY_EXITED" } | ConvertTo-Json -Compress; exit 0 }',
      '$pStart = $p.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",[Globalization.CultureInfo]::InvariantCulture)',
      'if ($pStart -ne $wantedStart) { [pscustomobject]@{ state="IDENTITY_MISMATCH" } | ConvertTo-Json -Compress; exit 0 }',
      '$p.Kill()',
      '$p.WaitForExit(10000) | Out-Null',
      'if (-not $p.HasExited) { [pscustomobject]@{ state="STILL_RUNNING" } | ConvertTo-Json -Compress; exit 0 }',
      '$exit = $p.ExitTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",[Globalization.CultureInfo]::InvariantCulture)',
      '[pscustomobject]@{ state="TERMINATED"; exitTimeUtc=$exit } | ConvertTo-Json -Compress'
    ].join(';');
    const output = await runPowerShell(script, 15000);
    if (!output.ok) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
    let parsed;
    try { parsed = JSON.parse(output.stdout); } catch (_) { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }; }
    if (parsed.state === 'ALREADY_EXITED') return { ok: true, alreadyExited: true, exitTimeMs: null };
    if (parsed.state === 'IDENTITY_MISMATCH' || parsed.state === 'STILL_RUNNING') {
      return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
    }
    const exitTimeMs = Date.parse(parsed.exitTimeUtc || '');
    return Number.isFinite(exitTimeMs)
      ? { ok: true, alreadyExited: false, exitTimeMs: exitTimeMs }
      : { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  }

  return { listProcesses: listProcesses, getProcess: getProcess, terminateProcess: terminateProcess };
}

function sameIdentity(left, right) {
  return !!left && !!right && left.pid === right.pid && left.parentPid === right.parentPid &&
    left.startTimeMs === right.startTimeMs;
}

function processKey(record) { return String(record.pid) + ':' + String(record.startTimeMs); }

function verifyBuildCommandLine(commandLine, mode) {
  const normalized = String(commandLine || '').toLowerCase().replace(/[\\/]/g, '\\').replace(/"/g, '').replace(/\s+/g, ' ');
  if (!normalized.includes('-noprofile') || !normalized.includes('-executionpolicy bypass') ||
      !normalized.includes('-file scripts\\build-installer.ps1')) return false;
  const testMode = /(?:^|\s)-testmode(?:\s|$)/.test(normalized);
  return mode === 'test' ? testMode : !testMode;
}

async function captureRootProcess(pid, parentPid, spawnedAtMs, mode, adapter) {
  const api = adapter || defaultAdapter();
  if (process.platform !== 'win32' || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) {
    return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  }
  let info;
  try { info = await api.getProcess(Number(pid)); } catch (_) { info = null; }
  if (!info || info.parentPid !== Number(parentPid) || info.name.toLowerCase() !== 'powershell.exe' ||
      info.startTimeMs < Number(spawnedAtMs) - 5000 || info.startTimeMs > Date.now() + 5000 ||
      !verifyBuildCommandLine(info.commandLine, mode)) {
    return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  }
  const record = {
    pid: info.pid,
    parentPid: info.parentPid,
    startTimeUtc: info.startTimeUtc,
    startTimeMs: info.startTimeMs,
    name: info.name
  };
  return { ok: true, record: record };
}

async function captureInspectorWorker(pid, parentPid, spawnedAtMs, adapter) {
  const api = adapter || defaultAdapter();
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  let info;
  try { info = await api.getProcess(Number(pid)); } catch (_) { info = null; }
  const expectedName = path.basename(process.execPath).toLowerCase();
  const commandLine = String(info && info.commandLine || '').toLowerCase().replace(/[\\/]/g, '\\').replace(/"/g, '');
  if (!info || info.parentPid !== Number(parentPid) || info.name.toLowerCase() !== expectedName ||
      info.startTimeMs < Number(spawnedAtMs) - 5000 || info.startTimeMs > Date.now() + 5000 ||
      !commandLine.includes('inspector-worker.js')) {
    return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  }
  return {
    ok: true,
    record: { pid: info.pid, parentPid: info.parentPid, startTimeUtc: info.startTimeUtc,
      startTimeMs: info.startTimeMs, name: info.name }
  };
}

function collectOwnedTree(root, snapshot, previous) {
  const records = new Map();
  const depths = new Map();
  const currentByPid = new Map((snapshot || []).map((record) => [record.pid, record]));
  const currentRoot = currentByPid.get(root && root.pid);
  if (!sameIdentity(root, currentRoot)) return { ok: false, records: [] };
  records.set(processKey(root), root);
  depths.set(processKey(root), 0);
  for (const record of previous || []) {
    if (record && record.pid !== root.pid && Number.isFinite(record.startTimeMs) && Number.isSafeInteger(record.parentPid)) {
      records.set(processKey(record), record);
      depths.set(processKey(record), Number.isInteger(record.depth) ? record.depth : 1);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const parent of Array.from(records.values())) {
      const currentParent = currentByPid.get(parent.pid);
      if (!sameIdentity(parent, currentParent)) continue;
      const parentDepth = depths.get(processKey(parent)) || 0;
      for (const candidate of snapshot || []) {
        if (candidate.pid === root.pid || candidate.parentPid !== parent.pid || candidate.startTimeMs < parent.startTimeMs) continue;
        const key = processKey(candidate);
        if (!records.has(key)) {
          records.set(key, candidate);
          depths.set(key, parentDepth + 1);
          changed = true;
        }
      }
    }
  }
  const ordered = Array.from(records.values()).map((record) => Object.assign({}, record, { depth: depths.get(processKey(record)) || 0 }));
  ordered.sort((a, b) => a.depth - b.depth || a.pid - b.pid);
  return { ok: true, records: ordered };
}

function createMonitor(root, adapter, intervalMs) {
  const api = adapter || defaultAdapter();
  let records = [Object.assign({}, root, { depth: 0 })];
  let polling = false;
  let stopped = false;
  const refresh = async function () {
    if (stopped || polling) return { ok: false };
    polling = true;
    try {
      const snapshot = await api.listProcesses();
      const tree = collectOwnedTree(root, snapshot, records);
      if (tree.ok) records = tree.records;
      return tree;
    } catch (_) { return { ok: false }; }
    finally { polling = false; }
  };
  const timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs || OWNERSHIP_POLL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    refresh: refresh,
    stop: function () { stopped = true; clearInterval(timer); },
    records: function () { return records.map((item) => Object.assign({}, item)); }
  };
}

async function terminateOwnedProcessTree(root, known, adapter) {
  const api = adapter || defaultAdapter();
  let snapshot;
  try { snapshot = await api.listProcesses(); }
  catch (_) { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: [] }; }
  let tree = collectOwnedTree(root, snapshot, known);
  if (!tree.ok) {
    tree = { ok: true, records: (known || []).slice() };
    if (!tree.records.some((item) => sameIdentity(item, root))) tree.records.unshift(Object.assign({}, root, { depth: 0 }));
  }
  const queue = tree.records.slice().sort((a, b) => a.depth - b.depth);
  const seen = new Set();
  const terminated = [];
  const exitTimes = new Map();
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    const key = processKey(parent);
    if (seen.has(key)) continue;
    seen.add(key);
    let outcome;
    try { outcome = await api.terminateProcess(parent); }
    catch (_) { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated }; }
    if (!outcome || outcome.ok !== true) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated };
    terminated.push({ pid: parent.pid, startTimeMs: parent.startTimeMs });
    if (!Number.isFinite(outcome.exitTimeMs)) continue;
    exitTimes.set(key, outcome.exitTimeMs);
    let after;
    try { after = await api.listProcesses(); }
    catch (_) { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated }; }
    for (const candidate of after) {
      if (candidate.parentPid !== parent.pid || candidate.startTimeMs < parent.startTimeMs || candidate.startTimeMs > outcome.exitTimeMs) continue;
      const childKey = processKey(candidate);
      if (seen.has(childKey) || queue.some((item) => processKey(item) === childKey)) continue;
      queue.push(Object.assign({}, candidate, { depth: (parent.depth || 0) + 1 }));
    }
  }
  let finalSnapshot;
  try { finalSnapshot = await api.listProcesses(); }
  catch (_) { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated }; }
  const survivors = queue.filter((owned) => sameIdentity(owned, finalSnapshot.find((item) => item.pid === owned.pid)));
  if (survivors.length) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated };
  const finalByPid = new Map(finalSnapshot.map((item) => [item.pid, item]));
  for (const owner of queue) {
    const currentParent = finalByPid.get(owner.pid);
    if (currentParent) continue; /* PID is absent or was reused by a different process identity. */
    const exitTimeMs = exitTimes.get(processKey(owner));
    const ambiguousChildren = finalSnapshot.some((item) => item.parentPid === owner.pid &&
      item.startTimeMs >= owner.startTimeMs && (!Number.isFinite(exitTimeMs) || item.startTimeMs <= exitTimeMs));
    if (ambiguousChildren) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED', terminated: terminated };
  }
  return { ok: true, terminated: terminated };
}

module.exports = {
  defaultAdapter: defaultAdapter,
  captureRootProcess: captureRootProcess,
  captureInspectorWorker: captureInspectorWorker,
  captureInspectorWorker: captureInspectorWorker,
  collectOwnedTree: collectOwnedTree,
  createMonitor: createMonitor,
  terminateOwnedProcessTree: terminateOwnedProcessTree,
  sameIdentity: sameIdentity
};
