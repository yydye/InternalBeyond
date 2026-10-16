'use strict';

const assert = require('node:assert/strict');
const safeImage = require('../assets/js/safe-image.js');

assert.equal(safeImage.normalizeSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
assert.equal(safeImage.normalizeSource('https://images.example.invalid/avatar.png'), 'https://images.example.invalid/avatar.png');
assert.equal(safeImage.normalizeSource('assets/images/avatar.png', 'http://tauri.localhost/InternalBeyond.html'), 'http://tauri.localhost/assets/images/avatar.png');
assert.equal(safeImage.normalizeSource('assets/images/avatar.png', 'file:///C:/IB/InternalBeyond.html'), 'assets/images/avatar.png');
assert.equal(safeImage.normalizeSource('javascript:alert(1)'), '');
assert.equal(safeImage.normalizeSource('data:text/html;base64,PHNjcmlwdD4='), '');
assert.equal(safeImage.normalizeSource('data:image/svg+xml,<svg onload=alert(1)>'), '');
assert.equal(safeImage.normalizeSource('//images.example.invalid/avatar.png'), '');
assert.equal(safeImage.normalizeSource('file:///C:/Users/test/secret.png'), '');
assert.equal(safeImage.normalizeSource('../outside.png', 'file:///C:/IB/InternalBeyond.html'), '');
assert.equal(safeImage.normalizeSource('%2e%2e/secret.png', 'file:///C:/IB/InternalBeyond.html'), '');
assert.equal(safeImage.normalizeSource('%2e%2e%2fsecret.png', 'file:///C:/IB/InternalBeyond.html'), '');
assert.equal(safeImage.normalizeSource('https://user:pass@example.invalid/avatar.png'), '');
assert.equal(safeImage.normalizeLink('javascript:alert(1)'), '');
assert.equal(safeImage.normalizeLink('data:text/html;base64,PHNjcmlwdD4='), '');
assert.equal(safeImage.normalizeLink('https://user:pass@example.invalid/'), '');
assert.equal(safeImage.normalizeLink('https://docs.example.invalid/path?q=1'), 'https://docs.example.invalid/path?q=1');
assert.equal(safeImage.normalizeLink('mailto:support@example.invalid'), '');
assert.equal(safeImage.normalizeLink('mailto:support@example.invalid', true), 'mailto:support@example.invalid');
assert.equal(safeImage.cssUrl('javascript:alert(1)'), '');
assert.match(safeImage.cssUrl('https://images.example.invalid/a.png'), /^url\("https:\/\/images\.example\.invalid\/a\.png"\)$/);
const encodedHandlerArgument = safeImage.jsArgument("x');window.__p0=1;//<script>");
assert.ok(encodedHandlerArgument.startsWith('&quot;') && encodedHandlerArgument.endsWith('&quot;'));
assert.ok(encodedHandlerArgument.includes('&#39;') && encodedHandlerArgument.includes('\\u003c'));

const imported = {
  about: [{
    id: 'main',
    avatar: 'x" onerror="window.__p0=1',
    bgImage: 'data:text/html;base64,PHNjcmlwdD4=',
    galleryImages: ['data:image/png;base64,AAAA', 'javascript:alert(1)']
  }],
  apiConfigs: [{ id: 'friend_safe', avatar: 'data:image/svg+xml,<svg onload=alert(1)>' }],
  chatMessages: [{ id: 'm1', images: [{ dataUrl: 'x\"><img onerror=alert(1)>' }] }],
  posts: [{ id: 'post_safe', title: 'safe title' }],
  blogComments: [{ id: 'comment_safe', postId: 'post_safe' }],
  groups: [{ id: 'group_safe', members: [{ characterId: 'friend_safe' }] }],
  unrelated: '<img onerror="must remain ordinary text">'
};
safeImage.sanitizeImportedArchive(imported);
assert.equal(imported.about[0].avatar, '');
assert.equal(imported.about[0].bgImage, '');
assert.equal(imported.about[0].galleryImages[0], 'data:image/png;base64,AAAA');
assert.equal(imported.about[0].galleryImages[1], '');
assert.equal(imported.apiConfigs[0].avatar, '');
assert.equal(imported.chatMessages[0].images[0].dataUrl, '');
assert.equal(imported.unrelated, '<img onerror="must remain ordinary text">');
assert.throws(() => safeImage.sanitizeImportedArchive({ posts: [{ id: 'bad\');window.__p0=1;//' }] }), /IMPORT_ID_INVALID/);
assert.throws(() => safeImage.sanitizeImportedArchive({ groups: [{ id: 'group_safe', members: [{ characterId: 'bad\' );window.__p0=1;//' }] }] }), /IMPORT_ID_INVALID/);

const roleScene = { scene: { participants: [{ id: 'role-safe', avatar: 'javascript:alert(1)' }] } };
safeImage.sanitizeSceneData(roleScene);
assert.equal(roleScene.scene.participants[0].avatar, '');
assert.equal(safeImage.validBindingId('role.safe-1:2'), true);
assert.equal(safeImage.validBindingId('role\' ); alert(1);//'), false);
assert.throws(() => safeImage.sanitizeImportedArchive({ apiConfigs: [{ id: 'id\' ); window.__p0=1;//' }] }), /API_CONFIG_ID_INVALID/);

console.log('safe-image security tests passed');
