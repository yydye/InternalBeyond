'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const csp = tauri.app && tauri.app.security && tauri.app.security.csp;
assert.equal(typeof csp, 'string', 'Tauri WebView must use a non-null CSP');
assert.match(csp, /default-src 'self'/);
assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/www\.youtube\.com/);
assert.match(csp, /script-src-attr 'unsafe-inline'/, 'legacy UI event handlers remain usable in WebView2');
assert.doesNotMatch(csp, /unsafe-eval|(?:^|;)\s*script-src[^;]*\s(?:https?:|data:|blob:)(?:\s|;|$)/);
assert.match(csp, /connect-src[^;]*ipc:/, 'Tauri IPC must remain permitted');
assert.match(csp, /connect-src[^;]*127\.0\.0\.1:\*/);
assert.match(csp, /connect-src[^;]*https:/, 'user-configured HTTPS providers remain reachable');
assert.match(csp, /frame-src[^;]*about:/, 'restricted static about: documents remain embeddable');
assert.doesNotMatch(csp, /frame-src[^;]*'self'/, 'only known local and media frame sources are embedded');
assert.match(csp, /frame-src[^;]*player\.bilibili\.com/, 'Bilibili embeds remain available');
assert.match(csp, /frame-src[^;]*youtube\.com/, 'YouTube embeds remain available');
assert.doesNotMatch(csp, /\[::1\]:\*/, 'WebView2 rejects the invalid IPv6 wildcard-port source form');
assert.match(csp, /object-src 'none'/);
assert.doesNotMatch(csp, /frame-src[^;]*(?:data:|blob:)/, 'opaque data/blob documents cannot become Tauri child frames');

const appCore = read('assets/js/app-builder-core.js');
assert.match(appCore, /publishSandboxedPreview/);
assert.match(appCore, /__TAURI_INTERNALS__/);
const appStore = read('assets/js/app-store.js');
assert.match(appStore, /publishSandboxedPreview\(draft\)/, 'generated App Store apps use the isolated document endpoint');
assert.match(appStore, /canUseLocalSrcdocPreview/, 'the legacy file:// host uses srcdoc only outside Tauri');
assert.match(appStore, /frame\.srcdoc=localPreview/);
assert.match(appStore, /frame\.src=published\.url/, 'the Tauri main document loads generated apps from the isolated route');
assert.match(appStore, /event\.origin!=='null'/, 'the sandbox message adapter accepts only opaque-origin child messages');
const webServer = read('services/internal-beyond-server.js');
assert.match(webServer, /GENERATED_APP_CSP/);
assert.match(webServer, /connect-src 'none'/);
assert.match(webServer, /sandbox allow-scripts/);

const html = read('InternalBeyond.html');
const imageScript = html.indexOf('<script src="assets/js/safe-image.js"');
assert.ok(imageScript >= 0 && imageScript < html.indexOf('<script src="assets/js/core.js"'), 'image guard loads before import and UI modules');
assert.ok(imageScript < html.indexOf('<script src="assets/js/social.js"'));

const core = read('assets/js/core.js');
assert.match(core, /sanitizeImportedArchive\(data\)/, 'plain JSON import validates media and IDs before the first store write');
assert.match(core, /_ibSafeProfileImageSource\(data\.avatar\)/);
assert.doesNotMatch(core, /src=["']\s*\+data\.avatar|background-image:url\(\+data\.(?:bgImage|galleryImages)/);
assert.match(core, /function esc\(s\).*&#39;/, 'shared HTML escaping includes both quote characters');

const localVault = read('assets/js/local-vault.js');
assert.match(localVault, /sanitizeImportedData\(parsed\)/, 'plain JSON uses the validated import copy');
assert.match(localVault, /sanitizeImportedData\(decrypted\)/, 'encrypted JSON uses the same validated import path');

const communication = read('assets/js/communication.js');
assert.doesNotMatch(communication, /avatarEl\.innerHTML\s*=\s*'<img/);
assert.doesNotMatch(communication, /item\.innerHTML\s*=\s*'<img src="'\+img\.dataUrl/);
assert.match(communication, /function _chatImageElement/);
assert.match(communication, /const safeSource=_chatSafeImageSource\(src\);if\(!safeSource\)return/);
const annotations = read('assets/js/communication/annotations.js');
assert.match(annotations, /_annoJsArg\(a\.id\)/);
assert.match(annotations, /_annoJsArg\(a\.postId\)/);
assert.match(annotations, /data-post-id/);
const letters = read('assets/js/communication/letters.js');
assert.match(letters, /_lettersJsArg\(l\.id\)/);
assert.match(letters, /_lettersHtmlAttr\(l\.id\)/);
const summaries = read('assets/js/communication/summary.js');
assert.match(summaries, /_summarySafeJsArg\(s\.id\)/);

const social = read('assets/js/social.js');
assert.match(social, /function _ibApiJsArgument/);
assert.match(social, /_ibApiAvatarSource\(a\.avatar\)/);
assert.match(social, /if\(!_ibApiIdAllowed\(inputId\)/);
assert.match(social, /group\.members\.every\(/, 'persisted group IDs are checked before their inline action renderer');

const autoMemory = read('assets/js/memory/auto-memory.js');
assert.match(autoMemory, /normalizeSource\(cfg\.avatar\)/, 'Auto Memory avatar renderer validates stored profile images');
assert.match(autoMemory, /escapeAttribute\(safeAvatar\)/);
assert.match(autoMemory, /a\.href=_amSafeSearchHref\(r\.url\)/, 'untrusted search result URLs cannot use javascript:');
assert.match(autoMemory, /_amSafeJsArg\(e\.id\)/);
const socialNetwork = read('assets/js/social-network.js');
assert.match(socialNetwork, /normalizeSource\(view\.banner\)/, 'social profile banners validate stored image sources');
assert.match(socialNetwork, /cssUrl\(safeBanner\)/);
const coread = read('assets/js/activity/coread.js');
assert.match(coread, /coreadOpen\('\+_coreadSafeJsArgument\(r\.resourceId\)\+'/);
assert.match(coread, /coreadOpen\('\+_coreadSafeJsArgument\(q\.id\)\+'/);
const memory = read('assets/js/memory.js');
assert.match(memory, /toggleMemExpand\('\+memIdArg\+/);
assert.match(memory, /toggleMemPin\('\+memIdArg\+/);
assert.match(memory, /selectPanelThread\('\+_memSafeJsArg\(a\.id\)/);
const workspaceFiles = read('assets/js/workspace/files.js');
assert.match(workspaceFiles, /wsFileDragStart\(event,this,'\+fileIdArg\+/);
assert.match(workspaceFiles, /renderWsFiles\('\+pIdArg\+/);
const workspacePreview = read('assets/js/workspace/preview.js');
assert.match(workspacePreview, /wsToggleSearch\('\+fileIdArg\+/);
assert.match(workspacePreview, /frame\.setAttribute\('sandbox',''\)/, 'untrusted workspace HTML preview has no script or popup capability');
const roleLetters = read('assets/js/role-letters.js');
assert.match(roleLetters, /_roleLettersJsArg\(l\.id\)/);
const siteOperations = read('assets/js/site-operations.js');
assert.match(siteOperations, /ibToolTest\('\+_ibToolSafeJsArg\(t\.id\)\+/);
const favorites = read('assets/js/favorites.js');
assert.match(favorites, /data-favid="'\+_favSafeAttr\(f2\.id\)/);
assert.match(favorites, /var u=_favSafeImage\(/, 'favorite image rows validate untrusted image URLs');
const voiceboxPage = read('assets/js/voicebox-page.js');
assert.match(voiceboxPage, /normalizeLink\(resource\.source\.url\)/);
assert.match(voiceboxPage, /normalizeLink\(resource\.license\.url\)/);

const roleDm = read('assets/js/role-dm.js');
assert.match(roleDm, /message-data-not-allowed/);
assert.match(roleDm, /\^\[A-Za-z0-9_\.:\-\]\+\$/);
const roleDmUi = read('assets/js/role-dm-ui.js');
assert.match(roleDmUi, /sanitizeSceneData\(payload\)/);
assert.match(roleDmUi, /esc\(m\.content\)/);

const rust = read('src-tauri/src/lib.rs');
assert.match(rust, /fn home_node_desktop_credential\(webview: tauri::WebviewWindow\)/);
assert.match(rust, /fn credential_resolve\([\s\S]*?webview: tauri::WebviewWindow/);
assert.equal((rust.match(/credential_ipc_window_allowed\(&webview\)/g) || []).length, 2);
assert.match(rust, /fn credential_ipc_target_allowed\(/);

const activeHttp = read('active/http.js');
assert.doesNotMatch(activeHttp, /return !origin \|\| origin === 'null'/);
assert.match(activeHttp, /if \(origin == null \|\| origin === ''\) return true/);
assert.match(activeHttp, /componentRegistry\.portOf\('static'\)/, 'Active grants production browser CORS only to the canonical static port');
assert.doesNotMatch(activeHttp, /setHeader\('Access-Control-Allow-Origin', origin \|\| 'null'\)/);

console.log('P0 security closure source contracts passed');
