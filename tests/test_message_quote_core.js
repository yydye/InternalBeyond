'use strict';

/* P3.1 · request-local quote selection, exact-source verification, and safe UI references. */
const assert = require('assert');
const Quote = require('../assets/js/message-quote-core.js');
const ChatCore = require('../assets/js/chat-core.js');

let passed = 0;
function check(name, condition, detail) {
  if (!condition) throw new Error(name + ': ' + (detail == null ? 'failed' : String(detail)));
  passed++;
}

check('quote pointer reuses canonical metadata; no top-level message field or schema addition',
  ChatCore.CONDITIONAL_FIELDS.indexOf('metadata') >= 0 && ChatCore.KNOWN_FIELDS.indexOf('replyQuote') < 0);

const friendId = 'dm_fixture';
const sourceLong = {
  id: 'msg_100_u', role: 'user', friendId, threadId: 'topic-a', timestamp: 100,
  content: '我本来想把周末留给自己。后来想到你上次说的那家旧书店，还是想一起去看看。'
};
const selfReply = {
  id: 'msg_101_ai', role: 'assistant', friendId, threadId: 'topic-a', timestamp: 101,
  senderName: 'Sui', metadata: { config_id: 'role_self' }, content: '我也想去。'
};
const peerReply = {
  id: 'msg_102_peer', role: 'assistant', friendId, threadId: 'topic-a', timestamp: 102,
  senderName: 'Mira', metadata: { speakerId: 'role_peer' }, content: '周六下午可以。'
};
const withdrawn = {
  id: 'msg_103_u', role: 'user', friendId, threadId: 'topic-a', timestamp: 103,
  content: '这句已撤回', withdrawn: true
};
const otherThread = {
  id: 'msg_104_u', role: 'user', friendId, threadId: 'topic-b', timestamp: 104,
  content: '另一条 thread 的内容'
};
const messages = [sourceLong, selfReply, peerReply, withdrawn, otherThread];

const chat = Quote.buildContext(messages, {
  mode: 'chat', friendId, threadId: 'topic-a', currentSenderId: 'role_self',
  allowedRoles: ['user'], userName: '你', limit: 8
});
check('chat candidate scope keeps incoming canonical message', chat.candidates.length === 1 && chat.candidates[0].messageId === sourceLong.id);
check('chat prompt is optional, bounded to actual IDs, and distinct from group/Role DM policy',
  chat.prompt.includes('也可以直接自然回复') && chat.prompt.includes(sourceLong.id)
    && !chat.prompt.includes('群聊里') && !chat.prompt.includes('对方确实说过'));

const group = Quote.buildContext(messages, {
  mode: 'group', friendId, threadId: 'topic-a', currentSenderId: 'role_self', limit: 8
});
check('group context admits another participant but excludes self, withdrawn, and other thread',
  group.candidates.length === 2 && group.candidates[0].messageId === sourceLong.id && group.candidates[1].messageId === peerReply.id);
check('group uses independent quote guidance', group.prompt.includes('群聊里') && !group.prompt.includes('每轮出现'));

const roleDmId = 'roledm_fixture';
const roleDmSource = {
  id: 'rdm_msg_10', role: 'assistant', friendId: roleDmId,
  metadata: { conversationType: 'role-dm', threadId: roleDmId, senderId: 'role_peer' },
  senderName: 'Mira', content: '我本来不想提这件事。可是那天你愿意留下来听我说完，我一直记得。'
};
const roleDmContext = Quote.buildContext([roleDmSource], {
  mode: 'role-dm', friendId: roleDmId, threadId: roleDmId, currentSenderId: 'role_self'
});
check('Role DM source uses its existing metadata.threadId and peer sender ID', roleDmContext.candidates.length === 1
  && roleDmContext.candidates[0].senderKey === 'role:role_peer' && roleDmContext.prompt.includes('人设、关系和 IB.brevity'));
check('short selector catalog maps exact sentence options to the canonical source',
  roleDmContext.quoteOptions.some(function (o) { return o.key === 'Q1.1' && o.snippet === '我本来不想提这件事。'; })
    && roleDmContext.quoteOptions.some(function (o) { return o.key === 'Q1.2' && o.snippet === '可是那天你愿意留下来听我说完，我一直记得。'; })
    && roleDmContext.prompt.indexOf('[[quote:Q1.2]]') >= 0);

const exactExcerpt = '那天你愿意留下来听我说完';
const parsedExcerpt = Quote.parseReply('嗯，我知道。\n' + Quote.OPEN + JSON.stringify({ key: 'Q1', text: exactExcerpt }) + Quote.CLOSE, roleDmContext);
check('sentence excerpt resolves to the original message ID and exact original substring', parsedExcerpt.valid
  && parsedExcerpt.text === '嗯，我知道。' && parsedExcerpt.quote.sourceMessageId === roleDmSource.id
  && parsedExcerpt.quote.snippet === exactExcerpt && parsedExcerpt.quote.sourceSenderKey === 'role:role_peer');

const parsedWhole = Quote.parseReply('我记得。\n' + Quote.OPEN + JSON.stringify({ key: 'Q1', whole: true }) + Quote.CLOSE, roleDmContext);
check('whole-message quote resolves from source without model retranscription', parsedWhole.valid
  && parsedWhole.quote.mode === 'whole' && parsedWhole.quote.snippet === roleDmSource.content);
const parsedSimpleSentence = Quote.parseReply('嗯，我知道。\n[[quote:Q1.2]]', roleDmContext);
check('simplified selector resolves a whole exact sentence without model retranscription', parsedSimpleSentence.valid
  && parsedSimpleSentence.text === '嗯，我知道。'
  && parsedSimpleSentence.quote.sourceMessageId === roleDmSource.id
  && parsedSimpleSentence.quote.snippet === '可是那天你愿意留下来听我说完，我一直记得。');

const invalidText = '普通回应。';
const spoof = Quote.parseReply(invalidText + Quote.OPEN + JSON.stringify({ key: 'Q1', text: '你当时答应过我。' }) + Quote.CLOSE, roleDmContext);
check('fabricated snippet degrades to plain response with no reference', !spoof.valid && !spoof.quote && spoof.text === invalidText);
const unknownId = Quote.parseReply(invalidText + Quote.OPEN + JSON.stringify({ key: 'Q9', whole: true }) + Quote.CLOSE, roleDmContext);
check('unknown source key degrades to plain response', !unknownId.valid && !unknownId.quote && unknownId.text === invalidText);
const duplicate = Quote.parseReply(invalidText + Quote.OPEN + '{bad}' + Quote.CLOSE + Quote.OPEN + '{bad}' + Quote.CLOSE, roleDmContext);
check('duplicate or malformed reference directives do not create a quote', !duplicate.valid && !duplicate.quote && duplicate.text === invalidText);
const partial = Quote.parseReply(invalidText + Quote.OPEN + '{"key":"Q1"', roleDmContext);
check('truncated directive is stripped without exposing its protocol payload', !partial.valid && !partial.quote && partial.text === invalidText);
const noQuote = Quote.parseReply('短消息，直接回答就好。', roleDmContext);
check('short ordinary answer stays unchanged when model elects not to quote', !noQuote.directiveFound && noQuote.text === '短消息，直接回答就好。');

const pointer = parsedExcerpt.quote;
const roleDmReply = {
  id: 'rdm_msg_11', role: 'assistant', friendId: roleDmId, threadId: roleDmId,
  senderId: 'role_self', senderName: 'Sui', content: '嗯，我知道。'
};
const roleDmSourceForUi = Object.assign({}, roleDmSource, { threadId: roleDmId });
check('UI reference validation checks ID, exact text, sender, and same DM thread',
  Quote.validateReference(pointer, roleDmSourceForUi, roleDmReply, { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_self' }).ok);
check('missing original safely resolves unavailable after deletion', Quote.resolveReference(pointer, [], roleDmReply,
  { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_self' }).reason === 'source-missing');
check('withdrawn original safely resolves unavailable', !Quote.validateReference(pointer,
  Object.assign({}, roleDmSourceForUi, { withdrawn: true }), roleDmReply,
  { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_self' }).ok);
check('changed sender fails closed', !Quote.validateReference(pointer,
  Object.assign({}, roleDmSourceForUi, { senderId: 'role_other', metadata: { senderId: 'role_other' } }), roleDmReply,
  { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_self' }).ok);
check('cross-conversation reference fails closed', !Quote.validateReference(pointer,
  Object.assign({}, roleDmSourceForUi, { friendId: 'other' }), roleDmReply,
  { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_self' }).ok);
check('self-reference fails closed', !Quote.validateReference(pointer, roleDmSourceForUi,
  Object.assign({}, roleDmReply, { senderId: 'role_peer' }),
  { friendId: roleDmId, threadId: roleDmId, replySenderKey: 'role:role_peer' }).ok);

const roleDmLongSource = Object.assign({}, roleDmSource, {
  id: 'rdm_long_topics',
  content: '昨晚录歌到很晚，副歌终于唱顺了。Live 的返送有点糟，我回来耳朵还嗡嗡响。Demo 我留了两个版本，等你有空再听。你最近怎么样？'
});
const multiContext = Quote.buildContext([roleDmLongSource], {
  mode: 'role-dm', friendId: roleDmId, threadId: roleDmId, currentSenderId: 'role_self'
});
const multiRaw = '录歌那段终于收好了。\n[[quote:Q1.1]]\n[[ib:message]]\nLive 现场确实挺折腾的。\n[[quote:Q1.2]]\n[[ib:message]]\nDemo 等你有空再听，最近也想问问你过得怎么样。';
const parsedMulti = Quote.parseReplyMessages(multiRaw, multiContext);
check('explicit message boundaries produce three independent units without punctuation splitting', parsedMulti.multi
  && parsedMulti.messages.length === 3
  && parsedMulti.messages[0].text === '录歌那段终于收好了。'
  && parsedMulti.messages[1].text === 'Live 现场确实挺折腾的。'
  && parsedMulti.messages[2].text === 'Demo 等你有空再听，最近也想问问你过得怎么样。');
check('each message independently validates and maps its exact quote selector', parsedMulti.messages[0].quote
  && parsedMulti.messages[0].quote.snippet === '昨晚录歌到很晚，副歌终于唱顺了。'
  && parsedMulti.messages[1].quote
  && parsedMulti.messages[1].quote.snippet === 'Live 的返送有点糟，我回来耳朵还嗡嗡响。'
  && !parsedMulti.messages[2].quote
  && parsedMulti.messages[2].quoteResult === 'no-directive');
const singleWithParagraphs = Quote.parseReplyMessages('第一句。\n\n第二句！\n最后补充？', multiContext);
check('ordinary newlines and punctuation remain one message unless the explicit separator exists', !singleWithParagraphs.multi
  && singleWithParagraphs.messages.length === 1 && singleWithParagraphs.messages[0].text === '第一句。\n\n第二句！\n最后补充？');
const invalidSecondQuote = Quote.parseReplyMessages('先接住。\n[[quote:Q1.1]]\n[[ib:message]]\n不伪造原话。\n[[quote:Q1.99]]', multiContext);
check('a bad quote in one unit degrades only that unit while preserving other exact refs', invalidSecondQuote.multi
  && !!invalidSecondQuote.messages[0].quote && !invalidSecondQuote.messages[1].quote
  && invalidSecondQuote.messages[1].text === '不伪造原话。');
const overLimit = Quote.parseReplyMessages('一。[[ib:message]]二。[[ib:message]]三。[[ib:message]]四。[[quote:Q1.1]]', multiContext);
check('more than three units safely fall back to one message and strip ambiguous quote directives', overLimit.formatFallback
  && overLimit.formatReason === 'too-many-messages' && overLimit.messages.length === 1
  && overLimit.messages[0].text.indexOf('[[ib:message]]') < 0 && !overLimit.messages[0].quote);
const emptyUnit = Quote.parseReplyMessages('第一条。\n[[ib:message]]\n[[ib:message]]\n第三条。', multiContext);
check('empty sequence members trigger a plain single-message fallback', emptyUnit.formatFallback
  && emptyUnit.formatReason === 'empty-message' && emptyUnit.messages.length === 1);

const stream = Quote.createStreamFilter();
const frame = Quote.OPEN + JSON.stringify({ key: 'Q1', text: exactExcerpt }) + Quote.CLOSE;
let visible = stream.push('正文先正常流出。');
visible += stream.push(frame.slice(0, 7));
visible += stream.push(frame.slice(7, 23));
visible += stream.push(frame.slice(23) + '继续正文。');
visible += stream.finish();
check('stream filter hides the control frame across arbitrary chunk boundaries', visible === '正文先正常流出。继续正文。', visible);
const selectorStream = Quote.createStreamFilter();
let selectorVisible = selectorStream.push('回复文本。');
selectorVisible += selectorStream.push('[[quo');
selectorVisible += selectorStream.push('te:Q1.2]]');
selectorVisible += selectorStream.finish();
check('stream filter hides the simplified selector across chunk boundaries', selectorVisible === '回复文本。', selectorVisible);

console.log('P3.1 Message Quote Core: ' + passed + ' passed.');
