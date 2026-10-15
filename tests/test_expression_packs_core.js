'use strict';

/* Expression Pack contract: role configuration owns image bytes and message refs. */
const assert = require('assert');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'assets', 'js', 'expression-packs-core.js'));

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log('✔ ' + name);
}

const image = 'data:image/webp;base64,UklGRg==';
const original = { id: 'role-a', nickname: 'A' };
let config = Core.addPack(original, 'pack-a', '温柔');
check('creates a character-bound Expression Pack', config && config.activeExpressionPackId === 'pack-a');
config = Core.addExpression(config, 'pack-a', { id: 'smile', name: '微笑', dataUrl: image, createdAt: 1 });
config = Core.addExpression(config, 'pack-a', { id: 'wave', name: '挥手', dataUrl: image, createdAt: 2 });
check('one role can upload multiple expressions to its bound pack', Core.expressionsOf(Core.activePack(config)).length === 2);

config = Core.addPack(config, 'pack-b', '夜色');
config = Core.addExpression(config, 'pack-b', { id: 'moon', name: '月光', dataUrl: image, createdAt: 3 });
check('a role can keep and bind a second pack', Core.packsOf(config).length === 2 && config.activeExpressionPackId === 'pack-a');
config = Core.setActivePack(config, 'pack-b');
check('switches the active pack without changing its expressions', Core.activePack(config).id === 'pack-b' && Core.expressionsOf(Core.activePack(config))[0].id === 'moon');
config = Core.setExpressionDefaults(config, {
  neutralExpression: { packId: 'pack-a', expressionId: 'smile' },
  greetingExpression: { packId: 'pack-b', expressionId: 'moon' },
  typingExpression: { packId: 'pack-b', expressionId: 'moon' },
  voiceExpression: { packId: 'pack-b', expressionId: 'moon' },
  errorExpression: { packId: 'pack-b', expressionId: 'moon' }
});
check('saves all five state defaults as role-config references', Core.DEFAULT_STATES.every(state => !!config.expressionDefaults[state]));
check('resolves a specific state expression from any role pack', Core.expressionForState(config, 'typingExpression').expression.id === 'moon');
check('uses neutral as a safe fallback when a state default is absent', Core.expressionForState(config, 'typingExpression').expression.id === 'moon'
  && Core.expressionForState(Core.setExpressionDefaults(config, { neutralExpression: config.expressionDefaults.neutralExpression }), 'voiceExpression').expression.id === 'smile');
check('leaves V1 behavior unchanged when no defaults are configured', !Core.expressionForState(original, 'neutralExpression')
  && !Object.prototype.hasOwnProperty.call(Core.setExpressionDefaults(original, {}), 'expressionDefaults'));

const message = { id: 'message-1', role: 'assistant', content: 'hello', friendId: 'role-a' };
config = Core.setMessageExpression(config, message.id, 'pack-b', 'moon', 10);
check('message expression resolves through role config', Core.messageExpression(config, message.id).expression.id === 'moon');
check('message content and shape remain untouched', message.content === 'hello' && !Object.prototype.hasOwnProperty.call(message, 'expression'));
check('expression selection is not stored on the chat message', !Object.prototype.hasOwnProperty.call(message, 'expressionId'));

const restored = JSON.parse(JSON.stringify(config));
check('role config export/import roundtrip preserves image reference', Core.messageExpression(restored, message.id).expression.dataUrl === image);
check('role config export/import roundtrip preserves pack binding', Core.activePack(restored).id === 'pack-b');
check('role config export/import roundtrip preserves default expression refs',
  restored.expressionDefaults.neutralExpression.packId === 'pack-a' && restored.expressionDefaults.typingExpression.expressionId === 'moon');

check('rejects remote image URLs', Core.addExpression(config, 'pack-b', { id: 'remote', name: 'remote', dataUrl: 'https://example.com/x.webp' }) === null);
check('rejects unsupported data URL types', Core.addExpression(config, 'pack-b', { id: 'svg', name: 'svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }) === null);
check('rejects a selection that does not belong to the selected pack', Core.setMessageExpression(config, 'message-2', 'pack-b', 'smile') === null);
const resolverConfig = Core.setActivePack(config, 'pack-a');
check('v3 defaults role automatic behavior on with only one character-level motion setting',
  Core.settingsOf(resolverConfig).enabled && Core.settingsOf(resolverConfig).microMotion);
const disabledResolver = Core.setSettings(resolverConfig, { enabled: false, microMotion: false });
check('v3 role settings are isolated and survive a config export/import roundtrip',
  !Core.settingsOf(disabledResolver).enabled && !Core.settingsOf(disabledResolver).microMotion
    && Core.settingsOf(JSON.parse(JSON.stringify(disabledResolver))).enabled === false
    && Core.settingsOf(resolverConfig).enabled === true);
const parsedTag = Core.parseReplyExpressions('好呀 [[expression:happy]]，我们走吧。', resolverConfig);
check('v3 strips and resolves an optional model expression tag without changing persistent messages',
  parsedTag.text === '好呀 ，我们走吧。' && parsedTag.expressionRef.packId === 'pack-a'
    && parsedTag.expressionRef.expressionId === 'smile'
    && !Object.prototype.hasOwnProperty.call(message, 'expressionRef'));
const invalidTag = Core.parseReplyExpressions('正文 [[expression:unknown_face]] 尾句', resolverConfig);
check('v3 strips an unknown model expression marker and leaves ordinary reply text',
  invalidTag.text === '正文  尾句' && invalidTag.expressionRef === null);
check('v3 removes an incomplete expression directive line safely',
  Core.parseReplyExpressions('前一句\n[[expression:unfinished\n后一句', resolverConfig).text === '前一句\n后一句');
check('v3 strips an oversized invalid marker without dropping neighboring reply text',
  Core.parseReplyExpressions('左边 [[expression:' + 'x'.repeat(100) + ']] 右边', resolverConfig).text === '左边  右边');
const automaticSelection = Core.resolveMessageExpression(resolverConfig, { text: '太好了，我很开心！' });
check('v3 auto-selects a matching character expression from simple reply rules',
  automaticSelection.source === 'automatic' && automaticSelection.expression.id === 'smile'
    && automaticSelection.action === 'sway');
const statePriority = Core.resolveMessageExpression(resolverConfig, {
  stateOverride: 'typingExpression', modelExpressionRef: parsedTag.expressionRef, text: '好开心'
});
check('v3 explicit input/playback state wins over model markers and context inference',
  statePriority.source === 'state' && statePriority.expression.id === 'moon');
const manuallySelected = Core.setMessageExpression(resolverConfig, message.id, 'pack-a', 'wave', 20);
const manualPriority = Core.resolveMessageExpression(manuallySelected, {
  messageId: message.id, modelExpressionRef: parsedTag.expressionRef, text: '我很开心'
});
check('v3 manual per-message choice has priority over automatic and model selection',
  manualPriority.source === 'manual' && manualPriority.expression.id === 'wave');
const manualStatePriority = Core.resolveMessageExpression(manuallySelected, {
  messageId: message.id, stateOverride: 'typingExpression', modelExpressionRef: parsedTag.expressionRef, text: '我很开心'
});
check('v3 explicit input/playback state takes priority during active playback even for manually selected bubbles',
  manualStatePriority.source === 'state' && manualStatePriority.expression.id === 'moon');
check('v3 role toggle disables inference but keeps existing neutral Expression Defaults',
  Core.resolveMessageExpression(disabledResolver, { text: '太好了，我很开心！' }).expression.id === 'smile'
    && Core.resolveMessageExpression(disabledResolver, { text: '太好了，我很开心！' }).source !== 'automatic');
const multiConfig = Core.addExpression(resolverConfig, 'pack-b', { id: 'sad', name: '难过', dataUrl: image, createdAt: 4 });
const markerParse = Core.parseReplyExpressions('甲 [[expression:happy]]。乙 [[expression:sad]]。', multiConfig);
const segmentRefs = Core.expressionRefsForSegments(markerParse, ['甲 。', '乙 。']);
check('v3 independently maps expression tags to different bubble segments',
  segmentRefs[0] && segmentRefs[0].expressionId === 'smile'
    && segmentRefs[1] && segmentRefs[1].expressionId === 'sad');
const streamFilter = Core.createTagStreamFilter();
const streamFirst = streamFilter.push('hello [[express');
const streamSecond = streamFilter.push('ion:happy]]world [[expression:unknown]]');
check('v3 stream filter hides complete and chunk-split expression markers',
  streamFirst + streamSecond + streamFilter.finish() === 'hello world ');
const spacedStreamFilter = Core.createTagStreamFilter();
check('v3 stream filter also hides whitespace-tolerant expression directives',
  spacedStreamFilter.push('A [[ expression : happy ]] B') + spacedStreamFilter.finish() === 'A  B');
check('clears the role-side assignment when an expression is deleted',
  Core.messageExpression(Core.removeExpression(config, 'pack-b', 'moon'), message.id) === null);
check('deleting an expression clears dangling defaults', (function () {
  const next = Core.removeExpression(config, 'pack-b', 'moon');
  return !next.expressionDefaults.greetingExpression && !Core.defaultExpression(next, 'voiceExpression')
    && Core.expressionForState(next, 'voiceExpression').expression.id === 'smile';
})());
check('clears pack assignments and selects a remaining pack on deletion', (function () {
  const next = Core.removePack(config, 'pack-b');
  return Core.packsOf(next).length === 1 && next.activeExpressionPackId === 'pack-a' && !Core.messageExpression(next, message.id);
})());

console.log('\nExpression Pack core tests passed ✔ (' + passed + ' checks)');
