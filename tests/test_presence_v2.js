'use strict';

const assert = require('assert');
const presence = require('../assets/js/presence-core.js');

const legacy = presence.normalizeSettings({ welcomeEnabled: true, welcomeInterval: 4 });
assert.strictEqual(legacy.silentEnabled, true, 'legacy Presence remains a silent awareness setting');
assert.strictEqual(legacy.greetingEnabled, false, 'legacy Presence must not enable proactive greeting');
assert.strictEqual(legacy.intervalMs, 4 * 60 * 60 * 1000);

const independent = presence.normalizeSettings({ welcomeEnabled: false, presenceGreetingEnabled: true, welcomeInterval: 1 });
assert.strictEqual(independent.silentEnabled, false);
assert.strictEqual(independent.greetingEnabled, true, 'greeting switch is independent from silent awareness');
assert.strictEqual(presence.normalizeSettings({}).greetingEnabled, false, 'new proactive behavior defaults off');

const now = 1800000000000;
assert.strictEqual(presence.buildReturnEvent(now - 30 * 60 * 1000, now, 2 * 60 * 60 * 1000), null,
  'brief window/app switches do not become a return event');
const longAway = presence.buildReturnEvent(now - 5 * 60 * 60 * 1000, now, 2 * 60 * 60 * 1000);
assert.ok(longAway && longAway.durationMs === 5 * 60 * 60 * 1000, 'long departures become a return event');
assert.strictEqual(longAway.id, presence.buildReturnEvent(longAway.departedAt, now + 1000, 0).id,
  'the same departure has a stable id across startup/visibility replays');
assert.strictEqual(presence.formatDuration(5 * 60 * 60 * 1000), '5 小时');

const note = presence.contextForReturn(longAway);
assert.ok(note.includes('约 5 小时') && note.includes('不要求你提及离开时长'),
  'silent context gives the role the fact without forcing a time reference');
assert.ok(presence.mayDeliverContext(longAway, now + 1000));
assert.strictEqual(presence.mayDeliverContext(longAway, now + presence.CONTEXT_MAX_AGE_MS + 1), false,
  'stale unconsumed context expires');
assert.strictEqual(presence.mayAttemptGreeting({ enabled: true, event: longAway, now: now + presence.CONTEXT_MAX_AGE_MS + 1 }), false,
  'delayed startup cannot send an old return greeting');

const safe = { enabled: true, event: longAway, now: now + 1 };
assert.strictEqual(presence.mayAttemptGreeting(safe), true);
assert.strictEqual(presence.mayAttemptGreeting(Object.assign({}, safe, { isGroup: true })), false,
  'group chats are not a greeting target');
assert.strictEqual(presence.mayAttemptGreeting(Object.assign({}, safe, { chatBusy: true })), false,
  'in-flight chat suppresses greetings');
assert.strictEqual(presence.mayAttemptGreeting(Object.assign({}, safe, { hasDraft: true })), false,
  'drafts suppress greetings');
assert.strictEqual(presence.mayAttemptGreeting(Object.assign({}, safe, { hasAttachments: true })), false,
  'pending attachments suppress greetings');
assert.strictEqual(presence.mayAttemptGreeting(Object.assign({}, safe, { lastGreetingAt: now })), false,
  'global greeting cooldown suppresses repeats');

console.log('Presence 2.0 core checks passed');
