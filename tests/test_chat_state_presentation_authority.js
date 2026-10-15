'use strict';

/* P36-VL-D4.1-C · guard the existing Chat state and persistence owners while
   presentation adapters are added. This is a source-boundary check; browser
   behavior is covered by test_chat_smoke.js and test_delivery_runtime.js. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const comm = read('assets/js/communication.js');
const social = read('assets/js/social.js');
const memory = read('assets/js/memory.js');
const delivery = read('assets/js/delivery-runtime.js');
const page = read('InternalBeyond.html');
let failures = 0;
let passes = 0;

function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.error('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

function section(source, start, end) {
  const i = source.indexOf(start);
  if (i < 0) return '';
  const j = end ? source.indexOf(end, i + start.length) : -1;
  return source.slice(i, j < 0 ? source.length : j);
}

const busyAdapter = section(comm, 'function _chatSyncComposerBusy()', 'function _chatSetComposerFeedback');
const thinkingAdapter = section(comm, 'function _ibTypingOn(', 'function _ibTypingFinish');
const streamProjection = section(comm, 'function _chatSetStreamActivityElement(', 'function _chatSetActiveStreamActivity');
const favoriteOwner = section(comm, 'async function _toggleMsgFav(', 'function _msgFavBtn');
const actionProjection = section(comm, 'function _chatAppendMessageActions(', 'async function deleteSingleMsg');
const selectionOwner = section(memory, 'function _chatCreateSelectionControl(', 'function toggleChatSelectMode');

check('sending.storeRemainsInSocialOwner',
  /const _chatSendingFor\s*=\s*new Set\(\)/.test(social)
  && /_chatSendingFor\.add\(_targetFriend\)/.test(comm)
  && /_chatSendingFor\.delete\(_targetFriend\)/.test(comm));
check('sending.adapterOnlyReadsCurrentOwner',
  /_chatSendingFor\.has\(fid\)/.test(busyAdapter)
  && !/_chatSendingFor\.(add|delete|clear)\(/.test(busyAdapter)
  && !/new (Set|Map)\(/.test(busyAdapter));
check('typing.deliveryRuntimeRemainsLifecycleOwner',
  /function notifyTyping\(q, on\)/.test(delivery)
  && /q\.typingOn\s*=\s*true/.test(delivery)
  && /notifyTyping\(q, false\)/.test(delivery)
  && /function _ibTypingOn\(/.test(comm)
  && /function _ibTypingOff\(/.test(comm));
check('thinking.remainsCallAndTypingProjection',
  /function _ibTypingOn\(/.test(thinkingAdapter)
  && /mode==='typing'\)\?'typing':'thinking'/.test(thinkingAdapter)
  && /_ibTypingReg\[key\]\s*=\s*rec/.test(thinkingAdapter)
  && !/new (Set|Map)\(/.test(thinkingAdapter));
check('streaming.usesExistingProviderCallbacksAndTransientNode',
  /async function callApiChatStream\(/.test(comm)
  && /onChunk\s*:\s*function/.test(comm)
  && /function _createStreamBubble\(/.test(comm)
  && /_chatSetStreamActivity\(gStreamRefs,'streaming'\)/.test(comm)
  && !/new (Set|Map)\(/.test(streamProjection));
check('streaming.disambiguatesThinkPrefixesBeforeReplyLabel',
  /function _chatStreamPrefixCanProjectReply\(/.test(comm)
  && /_chatStreamPrefixCanProjectReply\(_sBuf\)/.test(comm)
  && /_chatStreamPrefixCanProjectReply\(_gSBuf\)/.test(comm));
check('stopping.delegatesToExistingAbortState',
  /function stopStreaming\(\)[\s\S]*?st\.stopped=true[\s\S]*?st\.ac\.abort\(\)/.test(comm)
  && /_chatSetActiveStreamActivity\(st\.key,activeThreadId,'stopping'\)/.test(comm));
check('group.plannerIsStillSingleExecutionAuthority',
  (comm.match(/planParticipation\(_gPlanInput\)/g) || []).length === 1
  && !/planParticipation/.test(streamProjection));
check('conversation.selectionUsesExistingFriendAndThreadPointers',
  /function _chatRenderConversationSelector\(/.test(social)
  && /let activeFriendId=null/.test(social)
  && /let activeThreadId=null/.test(social)
  && /activeFriendId=friendId;[\s\S]{0,80}activeThreadId=threadId/.test(social)
  && !/new (Set|Map)\(/.test(busyAdapter));
check('message.persistenceDoesNotMoveIntoPresentationAdapters',
  /dbPut\('chatMessages',userMsg\)/.test(comm)
  && /dbPut\('chatMessages',aiMsg\)/.test(comm)
  && !/db(Put|Delete|Get)\(/.test(actionProjection)
  && !/db(Put|Delete|Get)\(/.test(streamProjection));
check('favorite.stillUsesCanonicalFavoritesOwner',
  /IB\.favorites\.has/.test(favoriteOwner)
  && /IB\.favorites\.add\(/.test(favoriteOwner)
  && /IB\.favorites\.removeBySource\(/.test(favoriteOwner));
check('selection.stillUsesSingleExistingSelectionSet',
  /var _chatSelectedIds=new Set\(\)/.test(memory)
  && /_chatSelectedIds\.has\(msgId\)/.test(memory)
  && /_toggleMsgSel\(id,control\)/.test(selectionOwner)
  && !/new (Set|Map)\(/.test(actionProjection));
check('composer.controlsStillCallExistingSendOwner',
  /async function sendChatMessage\(/.test(comm)
  && /onclick="sendChatMessage\(\)"/.test(page)
  && /chatKeyDown\(event\)/.test(page));

console.log(failures ? `Chat State Presentation Authority: ${passes} passed, ${failures} failed` : `Chat State Presentation Authority: ${passes} passed`);
process.exitCode = failures ? 1 : 0;
