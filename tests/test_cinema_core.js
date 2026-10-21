'use strict';

const assert = require('assert');
const core = require('../assets/js/activity/cinema-core.js');

const localA = core.mediaIdentity({
  provider: 'local', id: 'clip.mp4', url: 'blob:first-session',
  caps: { file: { name: 'clip.mp4', size: 529638, lastModified: 1728012345000, type: 'video/mp4' } }
}, 'clip');
const localB = core.mediaIdentity({
  provider: 'local', id: 'clip.mp4', url: 'blob:next-session',
  caps: { file: { name: 'clip.mp4', size: 529638, lastModified: 1728012345000, type: 'video/mp4' } }
}, 'clip');
const changedFile = core.mediaIdentity({
  provider: 'local', id: 'clip.mp4', url: 'blob:changed',
  caps: { file: { name: 'clip.mp4', size: 900000, lastModified: 1728012345000, type: 'video/mp4' } }
}, 'clip');

assert.strictEqual(localA.resourceId, localB.resourceId, 'a new blob URL must not break the same local file identity');
assert.notStrictEqual(localA.resourceId, changedFile.resourceId, 'a different local file must not reuse another file progress');
assert.strictEqual(localA.legacyResourceId, localB.legacyResourceId, 'legacy name-only records remain discoverable for explicit migration');
assert.ok(!localA.resourceId.includes('clip.mp4'), 'the durable resource key must not contain the filename or path');
assert.strictEqual(core.mediaIdentity({ provider: 'youtube', id: 'abc', url: 'https://youtube.com/watch?v=abc' }, 'clip').resourceId,
  core.mediaIdentity({ provider: 'youtube', id: 'abc', url: 'https://youtube.com/watch?v=abc' }, 'clip').resourceId);

assert.strictEqual(core.resumePoint({ sec: 2.1 }, 3.5, true), 2.1, 'short local clips can resume');
assert.strictEqual(core.resumePoint({ sec: 0.4 }, 3.5, true), null, 'near-start positions are not offered as resume');
assert.strictEqual(core.resumePoint({ sec: 3.3 }, 3.5, true), null, 'near-end positions are not offered as resume');
assert.strictEqual(core.resumePoint({ sec: 20, noTime: true }, 0, true), null, 'unknown embeds do not invent a resume point');
assert.strictEqual(core.resumePoint({ sec: 20 }, 0, false), null, 'unseekable media does not offer resume');

const segment = core.recapSegment([
  [0, 2, '开场：角色进入房间。'],
  [3, 5, '她发现桌上留有一封信。'],
  [10, 12, '信中写着一段旧约定。'],
  [20, 22, '这句字幕超出了本次整理区间。']
], 0, 15, 900, 6000);
assert.strictEqual(segment.lines.length, 3);
assert.strictEqual(segment.toSec, 15);
const prompt = core.buildRecapPrompt({ title: '测试影片', previousRecap: '她来到房间。', segment: segment });
assert.match(prompt, /已有梗概/);
assert.match(prompt, /旧约定/);
assert.doesNotMatch(prompt, /超出了本次整理区间/);
assert.match(core.visibleText('<think>hidden</think>可见内容'), /可见内容/);

console.log('Cinema core: stable file identity, bounded resume, and explicit recap scope passed.');
