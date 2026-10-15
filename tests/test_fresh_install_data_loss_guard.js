'use strict';

/* P32-W.5 · Fresh-install data-loss guard semantics.
 * Pure Node regression coverage: no browser profile, installer, WebView,
 * provider or runtime service is started. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const presence = require(path.join(__dirname, '..', 'assets', 'js', 'data-presence-core.js'));
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log('  ✓ ' + name);
}

function verdict(host, input) {
  return presence.decide(Object.assign({ host: host }, input));
}

console.log('P32-W.5 fresh-install data-loss guard regression\n');

check('1. TRUE_FRESH_INSTALL: empty profile does not warn', () => {
  assert.strictEqual(verdict('browser', { marker: '', businessCount: 0 }).warn, false);
});

check('2. Fresh initialized DB: schema/stores alone do not warn', () => {
  assert.strictEqual(verdict('browser', { schemaReady: true, storesCreated: true, marker: '', businessCount: 0 }).warn, false);
});

check('3. Initialization-only settings/theme/window state do not warn', () => {
  assert.strictEqual(verdict('browser', { initializationOnly: true, marker: '', businessCount: 0 }).warn, false);
});

check('4. REAL_DATA_LOSS_SUSPECTED: durable business marker plus empty stores warns', () => {
  const result = verdict('browser', { marker: '1', businessCount: 0 });
  assert.strictEqual(result.warn, true);
  assert.strictEqual(result.reason, 'business-history-but-empty');
});

check('5. Healthy profile with business data does not warn', () => {
  assert.strictEqual(verdict('browser', { marker: '1', businessCount: 3 }).warn, false);
});

check('6. Completed backup restore with business data clears warning', () => {
  assert.strictEqual(verdict('browser', { marker: '1', businessCount: 341, restoredFromBackup: true }).warn, false);
});

check('7. Browser mode uses business evidence, not ib_lastActive', () => {
  assert.strictEqual(verdict('browser', { lastActive: Date.now(), marker: '', businessCount: 0 }).warn, false);
  assert.strictEqual(verdict('browser', { lastActive: 0, marker: '1', businessCount: 0 }).warn, true);
});

check('8. Tauri fresh profile uses the same policy without host-specific bypass', () => {
  assert.strictEqual(verdict('tauri', { marker: '', businessCount: 0 }).warn, false);
  assert.strictEqual(verdict('tauri', { marker: '1', businessCount: 0 }).warn, true);
});

check('9. Only successful business records qualify for the durable marker', () => {
  assert.strictEqual(presence.isBusinessRecord('active_message_settings', { id: 's' }), false);
  assert.strictEqual(presence.isBusinessRecord('apiSettings', { id: 'theme' }), false);
  assert.strictEqual(presence.isBusinessRecord('chatMessages', { id: 'm' }), true);
  assert.strictEqual(presence.isBusinessRecord('apiConfigs', { id: 'role' }), true);
  assert.strictEqual(presence.isBusinessRecord('letters', { id: '__demo_847__', isDemo: true }), false);
  assert.strictEqual(presence.isBusinessRecord('letters', { id: 'real-letter', content: 'x' }), true);
});

check('10. Browser/Tauri page loads policy before core guard', () => {
  const html = read('InternalBeyond.html');
  assert.ok(html.indexOf('assets/js/data-presence-core.js') >= 0);
  assert.ok(html.indexOf('assets/js/data-presence-core.js') < html.indexOf('assets/js/core.js'));
  assert.ok(html.indexOf('assets/js/host-capability.js') < html.indexOf('assets/js/core.js'));
});

check('11. Startup chain still checks after DB open, but no longer reads ib_lastActive', () => {
  const core = read('assets/js/core.js');
  const start = core.indexOf('async function _ibGuardCheck');
  const end = core.indexOf('function _ibShowGuardOverlay', start);
  assert.ok(start >= 0 && end > start, 'guard function must remain present');
  const guard = core.slice(start, end);
  assert.ok(guard.indexOf('ib_lastActive') < 0, 'guard must not use presence timestamp');
  assert.ok(core.indexOf('_ibMarkBusinessDataPresent(s,stored)') >= 0,
    'successful dbPut must mark presence from the credential-free record actually stored');
  assert.match(read('assets/js/active-diary.js'), /await openDB\(\);\s*await _ibGuardCheck\(\)/,
    'the startup guard must run after the database is opened');
});

check('12. ib_lastActive remains welcome-back state only', () => {
  const communication = read('assets/js/communication.js');
  assert.ok(communication.indexOf("localStorage.setItem('ib_lastActive'") >= 0);
  assert.ok(communication.indexOf('function _checkWelcomeBack') >= 0);
  assert.ok(communication.indexOf('ib_hasEverHadBusinessData') < 0);
});

console.log('\nPASS: ' + pass + ' fresh-install data-loss guard checks');
