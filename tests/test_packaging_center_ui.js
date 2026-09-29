'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../assets/js/packaging-center.js');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'assets/js/packaging-center.js'), 'utf8');
const pageStart = html.indexOf('<div class="page" id="page-packaging">');
const pageEnd = html.indexOf('<!-- P22-15 · Economy', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'Packaging Center page is present in the app route');
const page = html.slice(pageStart, pageEnd);

assert.ok(html.includes('href="#packaging" data-page="packaging"'), 'page is reachable from the existing navigation');
assert.ok(html.includes('assets/css/packaging-center.css'));
assert.ok(html.includes('assets/js/packaging-center.js'));
assert.ok(page.includes('Windows 安装包'));
assert.ok(page.includes('暂不支持，后续提供'));
assert.ok(!/(?:Windows 便携版|网页导出|Android APK)[^<]*<button/i.test(page), 'future targets are not clickable');
assert.ok(!/<(?:input|select|textarea)\b/i.test(page), 'the page accepts no free-form input');
const forbiddenFieldIds = Array.from(page.matchAll(/\bid="([^"]+)"/g)).map(match => match[1])
  .filter(id => /(?:^|[-_])(?:command|script|path|env|credential|artifact(?:[-_]location)?)(?:[-_]|$)/i.test(id));
assert.deepStrictEqual(forbiddenFieldIds, []);
assert.ok(!/\b(?:child_process|powershell\.exe|spawnSync|execFileSync)\b/.test(script), 'UI does not import shell or process execution');
assert.ok(!/\b(?:spawn|execFile|execSync)\s*\(/.test(script), 'UI does not invoke a process helper');
assert.ok(!/\.innerHTML\b/.test(script), 'API values are not inserted as HTML');

assert.strictEqual(ui.statePresentation('BUILDING').label, '正在构建安装包');
assert.strictEqual(ui.statePresentation('BUILDING').tone, 'building');
assert.strictEqual(ui.canCancelState('BUILDING'), true);
assert.strictEqual(ui.canCancelState('CANCELLING'), true, 'a stuck owned cancellation can be retried through the Executor');
assert.strictEqual(ui.statePresentation('VALIDATING').label, '正在校验安装包');
assert.strictEqual(ui.canCancelState('VALIDATING'), false);
assert.strictEqual(ui.statePresentation('FAILED').tone, 'failure');
assert.strictEqual(ui.failureMessage('ARTIFACT_CHANGED_DURING_FINALIZATION'), '安装包在校验后发生了变化。');
assert.strictEqual(ui.statePresentation('COMPLETE').tone, 'success');
assert.strictEqual(ui.canCancelState('COMPLETE'), false);

const preflight = {
  ok: true,
  available: true,
  version: '1.2.3',
  actions: { start: true }
};
const job = ui.createPackagingJob(preflight, 'pc-ui-test');
assert.deepStrictEqual(job, {
  id: 'pc-ui-test', target: 'windows-installer', version: '1.2.3', channel: 'stable', mode: 'release',
  options: { includeDocs: false, includeExamples: false }
});
assert.throws(function () { ui.createPackagingJob(Object.assign({}, preflight, { actions: { start: false } }), 'pc-blocked'); }, /PACKAGING_NOT_READY/);
assert.throws(function () { ui.createPackagingJob(preflight, 'pc/invalid'); }, /PACKAGING_JOB_ID_INVALID/);

async function checkClient() {
  const calls = [];
  const client = ui.createClient(function (url, options) {
    calls.push({ url: url, options: options });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, accepted: true }); } });
  });
  await client.start(job);
  assert.strictEqual(calls[0].url, '/__packaging/jobs');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.deepStrictEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(), ['job']);
  assert.deepStrictEqual(JSON.parse(calls[0].options.body).job, job);
  await client.cancel(job.id);
  assert.strictEqual(calls[1].url, '/__packaging/jobs/' + encodeURIComponent(job.id) + '/cancel');
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.strictEqual(calls[1].options.body, '{}');
}

checkClient().then(function () {
  console.log('PASS test_packaging_center_ui');
}).catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
