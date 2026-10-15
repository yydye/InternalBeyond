'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const startup = require('../assets/js/startup-animation.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'InternalBeyond.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/navigation-shell.css'), 'utf8');
const startupSource = fs.readFileSync(path.join(root, 'assets/js/startup-animation.js'), 'utf8');
const manifest = require('../scripts/release-manifest.js');
const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const staticServer = fs.readFileSync(path.join(root, 'services/internal-beyond-server.js'), 'utf8');
const videoPath = 'Video/08e2b1dc2b734d4fafae30c3fb9f2f01 (1).mp4';

assert.strictEqual(startup.resolveEnabled(null, true), false, 'development defaults off');
assert.strictEqual(startup.resolveEnabled(null, false), true, 'release defaults on');
assert.strictEqual(startup.resolveEnabled('1', true), true, 'the setting can enable development playback');
assert.strictEqual(startup.resolveEnabled('0', false), false, 'the setting can disable release playback');

assert.strictEqual(startup.isDevelopmentHost({ hostname: '127.0.0.1', protocol: 'http:' }), true);
assert.strictEqual(startup.isDevelopmentHost({ hostname: 'localhost', protocol: 'http:' }), true);
assert.strictEqual(startup.isDevelopmentHost({ hostname: 'tauri.localhost', protocol: 'http:' }), false);
assert.strictEqual(startup.isDevelopmentHost({ hostname: '', protocol: 'file:' }), true);
assert.strictEqual(startup.majorVersion('12.4.8'), '12');

assert.deepStrictEqual(startup.decidePlayback({ enabled: true, seen: false, currentMajor: '1' }), {
  play: true, full: true, canSkip: false, reason: 'first-run'
});
assert.deepStrictEqual(startup.decidePlayback({ enabled: true, seen: true, previousMajor: '1', currentMajor: '2' }), {
  play: true, full: true, canSkip: false, reason: 'major-update'
});
assert.deepStrictEqual(startup.decidePlayback({ enabled: true, seen: true, previousMajor: '1', currentMajor: '1' }), {
  play: true, full: false, canSkip: true, reason: 'regular'
});
assert.strictEqual(startup.decidePlayback({ enabled: false, seen: false }).play, false);

const startupScript = '<script src="assets/js/startup-animation.js"></script>';
assert.ok(html.indexOf(startupScript) >= 0 && html.indexOf(startupScript) < html.indexOf('<script src="assets/js/core.js"></script>'),
  'startup overlay must register before the existing Home startup route');
assert.ok(html.includes('id="ib-startup-animation-toggle"'), 'settings page exposes the startup switch');
assert.ok(html.includes('setEnabled(this.checked)'), 'settings switch persists its choice');
assert.ok(startupSource.includes('video.muted = true;') && startupSource.includes('video.autoplay = false;'),
  'muted playback starts only after startup policy and skip controls are ready');
assert.ok(fs.existsSync(path.join(root, videoPath)), 'startup MP4 exists');
assert.ok(manifest.resolve({}).files.some(file => file.to === videoPath), 'release whitelist ships the startup MP4');
assert.ok(tauri.bundle.resources.includes('../' + videoPath), 'Tauri bundle ships the startup MP4');
assert.ok(staticServer.includes("'.mp4': 'video/mp4'"), 'existing static server serves the correct MP4 MIME type');
assert.ok(css.includes('#ib-startup-animation.is-leaving{opacity:0;pointer-events:none}'), 'overlay fades over Home');

console.log('Startup animation contract: all checks passed');
