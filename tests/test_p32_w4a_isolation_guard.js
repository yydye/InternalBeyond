'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const guard = require('./p32-w4a-isolation-guard.js');

const realLocal = path.join(os.homedir(), 'AppData', 'Local');
const realApp = path.join(os.homedir(), 'AppData', 'Roaming');
const realProfile = os.homedir();
const sandbox = path.join(os.tmpdir(), 'p32-w4a-guard-fixture');
const fixture = {
  realLocalAppData: realLocal,
  realAppData: realApp,
  realUserProfile: realProfile,
  realTemp: os.tmpdir(),
  realDataRoot: path.join(realLocal, 'InternalBeyond'),
  realInstallRoot: 'E:\\IB-C\\InternalBeyond',
  realTauriRoot: 'E:\\IB-C\\InternalBeyond',
  realInnoRoot: 'E:\\IB-E2E-1.0.1\\InternalBeyond',
  realStartMenu: path.join(realApp, 'Microsoft', 'Windows', 'Start Menu'),
  realDesktop: path.join(realProfile, 'Desktop'),
  localAppData: path.join(sandbox, 'local'),
  appData: path.join(sandbox, 'roaming'),
  temp: path.join(sandbox, 'temp'),
  tmp: path.join(sandbox, 'tmp'),
  userProfile: path.join(sandbox, 'profile'),
  installRoot: path.join(sandbox, 'install'),
  dataRoot: path.join(sandbox, 'local', 'InternalBeyond'),
  bootState: path.join(sandbox, 'local', 'InternalBeyond', 'boot-state.json'),
  logs: path.join(sandbox, 'local', 'InternalBeyond', 'logs'),
  activeData: path.join(sandbox, 'local', 'InternalBeyond', 'active-message-service.json'),
  bridgeData: path.join(sandbox, 'local', 'InternalBeyond', 'bridge'),
  homeNodeData: path.join(sandbox, 'local', 'InternalBeyond', 'home-node'),
  webViewProfile: path.join(sandbox, 'local', 'com.internalbeyond.desktop', 'EBWebView'),
  testStartMenu: path.join(sandbox, 'roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InternalBeyond Installer Smoke Test'),
  testDesktopShortcut: path.join(sandbox, 'profile', 'Desktop', 'InternalBeyond Installer Smoke Test.lnk'),
  ports: { web: 30120, restart: 30116, bridge: 30115, active: 30114, homeNode: 30118 },
  defaultPorts: { web: 23120, restart: 23116, bridge: 23115, active: 23114, homeNode: 23118 },
  productionInnoKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PRODUCTION}',
  tauriKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InternalBeyond',
  testInstallerKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST}',
  testAppName: 'InternalBeyond Installer Smoke Test'
};

guard.assertIsolated(fixture);
assert.throws(() => guard.assertIsolated(Object.assign({}, fixture, { appData: realApp })), /appData resolves inside forbidden real root/);
assert.throws(() => guard.assertIsolated(Object.assign({}, fixture, { ports: Object.assign({}, fixture.ports, { web: 23120 }) })), /reuses product default/);
assert.throws(() => guard.assertWindowsShellIsolated({ appData: fixture.appData, userProfile: fixture.userProfile }), /Windows AppData shell folder is not isolated/);
console.log('P32-W.4A isolation guard: all checks passed');
