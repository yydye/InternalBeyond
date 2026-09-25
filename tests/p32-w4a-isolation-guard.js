'use strict';

/* P32-W.4A-BG · pre-spawn isolation guard. Pure path/identity checks only. */

const path = require('path');
const { execFileSync } = require('child_process');

function normalized(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function sameOrWithin(candidate, root) {
  const c = normalized(candidate);
  const r = normalized(root);
  return !!c && !!r && (c === r || c.indexOf(r + path.sep) === 0);
}

function assertOutside(label, candidate, forbiddenRoots) {
  if (!candidate) throw new Error(label + ' is empty');
  for (const root of forbiddenRoots) {
    if (sameOrWithin(candidate, root)) {
      throw new Error(label + ' resolves inside forbidden real root: ' + candidate);
    }
  }
}

function assertIsolated(input) {
  const o = input || {};
  const realRoots = [o.realLocalAppData, o.realAppData, o.realUserProfile].filter(Boolean);
  const realTemp = o.realTemp ? normalized(o.realTemp) : '';
  const isolatedRoots = {
    localAppData: o.localAppData,
    appData: o.appData,
    temp: o.temp,
    tmp: o.tmp,
    userProfile: o.userProfile,
    installRoot: o.installRoot,
    dataRoot: o.dataRoot,
    bootState: o.bootState,
    logs: o.logs,
    activeData: o.activeData,
    bridgeData: o.bridgeData,
    homeNodeData: o.homeNodeData,
    webViewProfile: o.webViewProfile
  };

  for (const [label, value] of Object.entries(isolatedRoots)) {
    const isOwnedTemp = realTemp && sameOrWithin(value, realTemp) && normalized(value) !== realTemp;
    if (!isOwnedTemp) assertOutside(label, value, realRoots);
  }
  assertOutside('installRoot', o.installRoot, [o.realInstallRoot, o.realTauriRoot, o.realInnoRoot].filter(Boolean));
  assertOutside('dataRoot', o.dataRoot, [o.realDataRoot].filter(Boolean));
  assertOutside('testStartMenu', o.testStartMenu, [o.realStartMenu].filter(Boolean));
  assertOutside('testDesktopShortcut', o.testDesktopShortcut, [o.realDesktop].filter(Boolean));

  const ports = o.ports || {};
  const defaults = Object.values(o.defaultPorts || {});
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
      throw new Error('isolated port is invalid: ' + name + '=' + port);
    }
    if (defaults.indexOf(Number(port)) >= 0) {
      throw new Error('isolated port reuses product default: ' + name + '=' + port);
    }
  }

  const productionIds = [String(o.productionInnoKey || ''), String(o.tauriKey || '')].filter(Boolean);
  if (!o.testInstallerKey || productionIds.indexOf(String(o.testInstallerKey)) >= 0) {
    throw new Error('test installer identity is not separate from production identities');
  }
  if (!String(o.testAppName || '').includes('Test')) {
    throw new Error('test installer display name is not explicitly test-only');
  }
  return true;
}

function windowsShellFolders() {
  if (process.platform !== 'win32') return null;
  const command = '$s=New-Object -ComObject WScript.Shell;' +
    '[pscustomobject]@{AppData=$s.SpecialFolders("AppData");Desktop=$s.SpecialFolders("Desktop");Programs=$s.SpecialFolders("Programs")}|ConvertTo-Json -Compress';
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }).trim());
}

function assertWindowsShellIsolated(input) {
  const o = input || {};
  const actual = windowsShellFolders();
  if (!actual) return true;
  if (normalized(actual.AppData) !== normalized(o.appData)) {
    throw new Error('Windows AppData shell folder is not isolated: ' + actual.AppData);
  }
  if (!sameOrWithin(actual.Desktop, o.userProfile) || !sameOrWithin(actual.Programs, o.appData)) {
    throw new Error('Windows shortcut shell folders are not isolated: ' + JSON.stringify(actual));
  }
  return true;
}

module.exports = { assertIsolated, assertWindowsShellIsolated, normalized, sameOrWithin, windowsShellFolders };
