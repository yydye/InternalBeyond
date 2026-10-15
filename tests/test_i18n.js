'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../assets/js/i18n.js');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const htmlKeys = [...html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g)].map(match => match[1]);
const uiScripts = ['assets/js/core.js', 'assets/js/navigation-shell.js', 'assets/js/settings-center.js', 'assets/js/home-workspace.js', 'assets/js/memory.js', 'assets/js/social.js', 'assets/js/communication.js', 'assets/js/memory/auto-memory.js']
  .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
const runtimeKeys = [...uiScripts.matchAll(/(?:IBI18n\.t|_apiUiText|_amUiText)\(['"]([^'"]+)['"]/g)].map(match => match[1]);
const keys = htmlKeys.concat(runtimeKeys);

assert.deepStrictEqual(i18n.SUPPORTED_LOCALES, ['zh-CN', 'en-US']);
assert.strictEqual(i18n.DEFAULT_LOCALE, 'zh-CN');
assert.strictEqual(i18n.normalizeLocale('en'), 'en-US');
assert.strictEqual(i18n.normalizeLocale('en-GB'), 'en-US');
assert.strictEqual(i18n.normalizeLocale('zh-Hant'), 'zh-CN');
assert.strictEqual(i18n.normalizeLocale('fr-FR'), 'zh-CN');

const zhKeys = Object.keys(i18n.CATALOGS['zh-CN']).sort();
const enKeys = Object.keys(i18n.CATALOGS['en-US']).sort();
assert.deepStrictEqual(enKeys, zhKeys, 'both locale catalogs have the same keys');
for (const key of new Set(keys)) {
  assert.ok(Object.prototype.hasOwnProperty.call(i18n.CATALOGS['zh-CN'], key), 'zh-CN key exists: ' + key);
  assert.ok(Object.prototype.hasOwnProperty.call(i18n.CATALOGS['en-US'], key), 'en-US key exists: ' + key);
}

assert.ok(html.indexOf('assets/js/i18n.js') >= 0 && html.indexOf('assets/js/i18n.js') < html.indexOf('</head>'),
  'locale preference is read before the page body is rendered');
assert.ok(html.includes('id="settings-language-select"') && html.includes('data-i18n-locale-picker'),
  'Settings Center exposes the persistent locale selector');
assert.ok(html.includes('data-i18n="settings.language.coverage"'),
  'the UI states which areas are localized and which retain source text');

i18n.setLocale('en-US');
assert.strictEqual(i18n.locale, 'en-US');
assert.strictEqual(i18n.t('settings.category.general'), 'General');
assert.strictEqual(i18n.t('chat.selectedCount', { count: 3 }), '3 selected');
assert.strictEqual(i18n.t('unknown.key'), 'unknown.key', 'unknown keys do not replace source text with an invented translation');
i18n.setLocale('zh-CN');
assert.strictEqual(i18n.t('settings.category.general'), '通用');

console.log('PASS test_i18n (' + new Set(htmlKeys).size + ' HTML keys, ' + new Set(runtimeKeys).size + ' runtime keys, ' + zhKeys.length + ' catalog keys)');
