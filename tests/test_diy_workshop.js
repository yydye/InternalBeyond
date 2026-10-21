'use strict';

const assert = require('node:assert/strict');
const DIY = require('../assets/js/diy-workshop-core.js');

const ACCENT = '#5080b0';
const pngData = 'data:image/png;base64,AAAA';

const defaults = DIY.defaultConfig(ACCENT);
assert.equal(defaults.id, 'ibDiyWorkshopV1');
assert.equal(defaults.version, 2);
assert.equal(defaults.accent, ACCENT);
assert.equal(defaults.tarotFaceStyle, 'veil');
assert.equal(defaults.visualSchemes.length, DIY.VISUAL_SLOT_COUNT);
assert.equal(defaults.bubbleSchemes.length, DIY.BUBBLE_SLOT_COUNT);
assert.equal(DIY.isDefault(defaults, ACCENT), true);

const configured = DIY.normalize({
  id: 'tampered-id',
  version: 99,
  apiKey: 'must-not-be-kept',
  accent: '#d8f2ff',
  fontScale: 1.3,
  fontFamily: 'serif',
  chatFont: 'serif',
  cardShadow: false,
  widgetStyle: 'ink',
  decorations: false,
  sectionColors: { home: '#aa6677', room: 'red', unknown: '#123456' },
  visualSchemes: [{
    name: '薄雾',
    snapshot: { accent: '#d8f2ff', fontScale: 1.05, fontFamily: 'serif', chatFont: 'serif', cardShadow: false, widgetStyle: 'frost', decorations: false, sectionColors: { chat: '#aabbcc' }, html: '<script>bad()</script>' }
  }],
  bubbleSchemes: [{
    name: '星雾',
    user: { stops: ['#123456', 'red', 'url(javascript:alert(1))', '#abcdef'], angle: 500, opacity: 0.7, borderStyle: 'dashed', decoration: 'spark', svg: '<svg onload="x">' },
    assistant: { stops: ['#abcdef'], borderColor: '#123456', borderWidth: 20, decoration: '<svg>' }
  }],
  bubbleActive: { internal: '0', infernal: '99' },
  bubbleBindings: { role_1: { internal: '0', infernal: 'javascript:1' }, '__proto__': { internal: '0' } },
  tarotFaceStyle: 'orrery',
  assets: {
    homeInternal: pngData,
    roomNight: 'game/room_night.png',
    tarotBack: 'javascript:alert(1)',
    unknown: pngData
  },
  portraits: {
    role_1: { src: pngData, scale: 3, x: -500, y: 48, name: 'portrait.png' },
    '__proto__': { src: pngData, scale: 1, x: 0, y: 0 }
  }
}, ACCENT);

assert.equal(configured.id, 'ibDiyWorkshopV1');
assert.equal(configured.version, 2);
assert.equal(configured.accent, '#d8f2ff');
assert.equal(configured.fontScale, 1.1);
assert.equal(configured.fontFamily, 'serif');
assert.equal(configured.chatFont, 'serif');
assert.equal(configured.cardShadow, false);
assert.equal(configured.widgetStyle, 'ink');
assert.equal(configured.decorations, false);
assert.deepEqual(configured.sectionColors, { home: '#aa6677' });
assert.equal(configured.visualSchemes[0].name, '薄雾');
assert.equal(configured.visualSchemes[0].snapshot.fontScale, 1.05);
assert.equal(Object.prototype.hasOwnProperty.call(configured.visualSchemes[0].snapshot, 'html'), false);
assert.equal(configured.bubbleSchemes[0].name, '星雾');
assert.deepEqual(configured.bubbleSchemes[0].user.stops, ['#123456', '#abcdef']);
assert.equal(configured.bubbleSchemes[0].user.angle, 360);
assert.equal(configured.bubbleSchemes[0].user.decoration, 'spark');
assert.equal(configured.bubbleSchemes[0].assistant.borderWidth, 4);
assert.equal(configured.bubbleSchemes[0].assistant.decoration, 'none');
assert.deepEqual(configured.bubbleActive, { internal: '0', infernal: '' });
assert.deepEqual(configured.bubbleBindings.role_1, { internal: '0', infernal: '' });
assert.equal(Object.prototype.hasOwnProperty.call(configured.bubbleBindings, '__proto__'), false);
assert.equal(configured.tarotFaceStyle, 'orrery');
assert.deepEqual(configured.assets, {
  homeInternal: pngData,
  roomNight: 'game/room_night.png'
});
assert.deepEqual(configured.portraits.role_1, {
  src: pngData,
  name: 'portrait.png',
  scale: 1.5,
  x: -100,
  y: 48
});
assert.equal(Object.prototype.hasOwnProperty.call(configured.portraits, '__proto__'), false);
assert.equal(JSON.stringify(configured).includes('must-not-be-kept'), false);
assert.equal(DIY.safeImageSource('game/room_day.png'), 'game/room_day.png');
assert.equal(DIY.safeImageSource('file:///C:/Users/private.png'), '');
assert.equal(DIY.safeImageSource('data:image/svg+xml;base64,PHN2Zy8+'), '');
assert.equal(DIY.isDefault(configured, ACCENT), false);

console.log('DIY workshop core config checks passed');
