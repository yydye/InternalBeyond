package com.internalbeyond.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.domain.AttemptOverlay
import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.common.IbAvatar
import com.internalbeyond.mobile.ui.common.IbBackground
import com.internalbeyond.mobile.ui.common.IbConnectionBadge
import com.internalbeyond.mobile.ui.common.IbDisclosure
import com.internalbeyond.mobile.ui.common.IbEmptyState
import com.internalbeyond.mobile.ui.common.IbErrorCard
import com.internalbeyond.mobile.ui.common.IbGlow
import com.internalbeyond.mobile.ui.common.IbMark
import com.internalbeyond.mobile.ui.common.IbTextField
import com.internalbeyond.mobile.ui.common.IbTextAction
import com.internalbeyond.mobile.ui.common.IbThinkingDots
import com.internalbeyond.mobile.ui.common.IbTopBar
import com.internalbeyond.mobile.ui.common.connectionBusy
import com.internalbeyond.mobile.ui.common.connectionColor
import com.internalbeyond.mobile.ui.common.connectionLabel
import com.internalbeyond.mobile.ui.common.formatTimestamp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType
import kotlinx.coroutines.launch

class ChatViewModel(
    private val graph: AppGraph,
    val characterId: String,
) : ViewModel() {

    /**
     * The session outlives this ViewModel on purpose: it is owned by [AppGraph], so
     * leaving the chat while a reply is being generated does not cancel it — the
     * Home Node keeps generating either way, and the session keeps consuming.
     */
    private val session = graph.chat.open(characterId)

    private var started = false

    val state = session.state

    val character: Character? get() = graph.characters.character(characterId)

    init {
        if (!started) {
            started = true
            session.start()
        }
    }

    fun send(text: String) {
        session.send(text)
    }

    /** Terminal failure → a NEW requestId. See [ConversationSession]'s class comment. */
    fun sendAgain(requestId: String) {
        session.sendAgain(requestId)
    }

    fun loadOlder() {
        viewModelScope.launch { session.loadOlder() }
    }

    /** Manual "resume now" after a recovery budget ran out. Same requestId. */
    fun resume() {
        viewModelScope.launch { session.resumeOpenAttemptsNow() }
    }

    fun draft(): String = session.draft()

    fun saveDraft(text: String) = session.saveDraft(text)

    companion object {
        fun factory(graph: AppGraph, characterId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChatViewModel(graph, characterId) as T
            }
    }
}

/**
 * The conversation.
 *
 * M1-C.1 changed nothing about how this screen works — the same session, the same
 * overlay, the same recovery — and everything about how it reads:
 *
 *  · The header is the character: their face, their name in the serif face the product
 *    uses for people, and one line saying whether the computer is reachable. Not an
 *    app bar with a title and a back arrow.
 *  · The two speakers are told apart by weight, not by colour alone: the character
 *    speaks in serif over glass, the user speaks in the interface face over an
 *    accent-tinted bubble.
 *  · Streaming grows a bubble in place, as before; what is new is that a reply with no
 *    text yet shows three soft dots rather than a bare spinner.
 *  · Reasoning is folded shut behind 思考过程 instead of an English "Show reasoning",
 *    and the model id is gone from under every message: it is a fact about a machine,
 *    and 开发者信息 in Settings is where facts about machines live.
 */
@Composable
fun ChatScreen(
    graph: AppGraph,
    characterId: String,
    onBack: () -> Unit,
    viewModel: ChatViewModel = viewModel(
        key = "chat:$characterId",
        factory = ChatViewModel.factory(graph, characterId),
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val session by graph.session.state.collectAsStateWithLifecycle()
    val character = viewModel.character
    val listState = rememberLazyListState()

    // The canonical ids currently rendered. An overlay row whose reply is already in
    // this set must not draw it a second time (M1-C.2f).
    val canonicalIds = remember(state.messages) { state.messages.mapTo(HashSet()) { it.id } }

    var draft by rememberSaveable(characterId) { mutableStateOf(viewModel.draft()) }

    // Keep the newest content visible as it streams in.
    val itemCount = state.messages.size + state.overlay.size + 1
    LaunchedEffect(itemCount, state.overlay.map { it.partialText.length }) {
        if (itemCount > 1) {
            runCatching { listState.animateScrollToItem(itemCount - 1) }
        }
    }

    IbBackground(glow = IbGlow.Quiet) {
        Column(modifier = Modifier.fillMaxSize()) {
            IbTopBar(
                title = character?.name ?: characterId,
                titleStyle = IbType.name,
                onBack = onBack,
                leading = character?.let {
                    { IbAvatar(character = it, size = 38.dp) }
                },
                subtitle = {
                    IbConnectionBadge(
                        color = connectionColor(session),
                        label = connectionLabel(session),
                        busy = connectionBusy(session),
                    )
                },
            )

            if (state.reconnecting) {
                ReconnectBanner(onResume = { viewModel.resume() })
            }

            state.error?.let { error ->
                Box(modifier = Modifier.padding(horizontal = IbSpacing.gutter, vertical = IbSpacing.sm)) {
                    IbErrorCard(ErrorPresenter.present(error))
                }
            }

            Box(modifier = Modifier.weight(1f)) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    // A short conversation sits on the composer rather than floating at
                    // the top of an empty screen. `Arrangement.Bottom` only applies when
                    // the content is shorter than the viewport, so scrolling is
                    // unaffected once there is more than a screenful.
                    verticalArrangement = Arrangement.spacedBy(
                        space = IbSpacing.lg,
                        alignment = Alignment.Bottom,
                    ),
                    contentPadding = PaddingValues(
                        start = IbSpacing.gutter,
                        end = IbSpacing.gutter,
                        top = IbSpacing.md,
                        bottom = IbSpacing.lg,
                    ),
                ) {
                    if (state.hasOlder) {
                        item(key = "older") {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.Center,
                            ) {
                                if (state.loadingOlder) {
                                    IbThinkingDots()
                                } else {
                                    IbTextAction(
                                        label = IbStrings.chatLoadOlder,
                                        onClick = { viewModel.loadOlder() },
                                        color = IbColors.AccentSoft,
                                    )
                                }
                            }
                        }
                    }

                    if (state.messages.isEmpty() && state.overlay.isEmpty() && !state.loading) {
                        item(key = "empty") {
                            IbEmptyState(
                                title = IbStrings.chatEmptyTitle,
                                detail = IbStrings.chatEmptyDetail(character?.name ?: characterId),
                            )
                        }
                    }

                    items(state.messages, key = { it.id }) { message ->
                        MessageBubble(message)
                    }

                    items(state.overlay, key = { it.localMessageId }) { attempt ->
                        AttemptBubbles(
                            attempt = attempt,
                            canonicalIds = canonicalIds,
                            onRetry = { viewModel.sendAgain(attempt.requestId) },
                        )
                    }
                }
            }

            Composer(
                value = draft,
                onValueChange = {
                    draft = it
                    viewModel.saveDraft(it)
                },
                onSend = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        draft = ""
                        viewModel.saveDraft("")
                        viewModel.send(text)
                    }
                },
            )
        }
    }
}

@Composable
private fun ReconnectBanner(onResume: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = IbSpacing.gutter, vertical = IbSpacing.xs)
            .clip(IbShapes.control)
            .background(IbColors.Glass)
            .border(1.dp, IbColors.GlassEdge, IbShapes.control)
            .padding(horizontal = IbSpacing.lg, vertical = IbSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(IbSpacing.md),
    ) {
        IbThinkingDots()
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = IbStrings.chatReconnecting,
                style = IbType.bodySmall,
                color = IbColors.Text,
            )
            Text(
                text = IbStrings.chatReconnectingNote,
                style = IbType.caption,
                color = IbColors.TextFaint,
            )
        }
        IbTextAction(
            label = IbStrings.chatResumeNow,
            onClick = onResume,
            color = IbColors.AccentSoft,
        )
    }
}

/**
 * One canonical message.
 *
 * Only the DTO's own fields are rendered — there is nothing here that could show a
 * provider, an endpoint or a prompt, because the DTO does not contain them.
 */
@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.isUser

    if (message.withdrawn) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        ) {
            Text(
                text = IbStrings.chatWithdrawn,
                style = IbType.bodySmall,
                fontStyle = FontStyle.Italic,
                color = IbColors.TextFaint,
            )
        }
        return
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Bubble(
                fromUser = isUser,
                content = {
                    Column(verticalArrangement = Arrangement.spacedBy(IbSpacing.sm)) {
                        if (message.content.isNotEmpty()) {
                            Text(
                                text = message.content,
                                style = if (isUser) IbType.body else IbType.speech,
                                color = IbColors.Text,
                            )
                        }
                        AttachmentMarks(message)
                        if (message.truncated) {
                            Text(
                                text = IbStrings.chatTruncated,
                                style = IbType.caption,
                                color = IbColors.TextFaint,
                            )
                        }
                    }
                },
            )
            val stamp = formatTimestamp(message.timestamp)
            if (stamp.isNotEmpty()) {
                Spacer(Modifier.height(IbSpacing.xs))
                Text(text = stamp, style = IbType.caption, color = IbColors.TextFaint)
            }
        }
    }
}

/**
 * The optimistic part of the UI: a send that has not (yet) got a canonical row.
 *
 * States come from [SendAttempt], never from a boolean: a pending bubble and a
 * failed one look different because they ARE different, and a recovering one says
 * 正在重新连接 rather than 发送失败 (Phase 16/19).
 *
 * The reply half is drawn only while it is still the ONLY copy of that reply. Once
 * the canonical assistant message is in the list, [AttemptOverlay.showsAssistantBubble]
 * says so and this composable keeps only the user's own bubble — otherwise the same
 * reply would appear twice, since the canonical row arrives with `chat.done` while
 * the user's row waits for a later `sync.changes` (M1-C.2f).
 */
@Composable
private fun AttemptBubbles(attempt: SendAttempt, canonicalIds: Set<String>, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Bubble(fromUser = true) {
                Text(text = attempt.content, style = IbType.body, color = IbColors.Text)
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = if (attempt.state == AttemptState.FAILED) Arrangement.End else Arrangement.Start,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (attempt.state) {
                AttemptState.PENDING -> Text(
                    text = IbStrings.chatSending,
                    style = IbType.caption,
                    color = IbColors.TextFaint,
                )
                AttemptState.RECOVERING -> Text(
                    text = IbStrings.chatReconnecting,
                    style = IbType.caption,
                    color = IbColors.TextFaint,
                )
                AttemptState.RUNNING -> Unit
                AttemptState.DONE -> Unit
                AttemptState.FAILED -> {
                    // The protocol code is not shown. It is in 详细信息 on the error
                    // card, if the session produced one; here the only useful thing is
                    // that this did not go, and the way to try again.
                    Text(
                        text = IbStrings.chatSendFailed,
                        style = IbType.caption,
                        color = IbColors.Danger,
                    )
                    IbTextAction(
                        label = IbStrings.chatSendAgain,
                        onClick = onRetry,
                        color = IbColors.AccentSoft,
                    )
                }
            }
        }

        if (attempt.reasoningText.isNotEmpty()) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                IbDisclosure(label = IbStrings.chatReasoningShow) {
                    Text(
                        text = attempt.reasoningText,
                        style = IbType.bodySmall,
                        fontStyle = FontStyle.Italic,
                        color = IbColors.TextFaint,
                    )
                }
            }
        }

        val hasReplyToDraw = attempt.partialText.isNotEmpty() ||
            attempt.state == AttemptState.RUNNING ||
            attempt.state == AttemptState.PENDING
        val showAssistant = hasReplyToDraw && AttemptOverlay.showsAssistantBubble(attempt, canonicalIds)
        if (showAssistant) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                Bubble(fromUser = false) {
                    if (attempt.partialText.isEmpty()) {
                        IbThinkingDots()
                    } else {
                        Text(text = attempt.partialText, style = IbType.speech, color = IbColors.Text)
                    }
                }
            }
        }
    }
}

@Composable
private fun Bubble(fromUser: Boolean, content: @Composable () -> Unit) {
    val shape = IbShapes.bubble(fromUser)
    Box(
        modifier = Modifier
            .widthIn(max = 300.dp)
            .clip(shape)
            .background(if (fromUser) IbColors.BubbleOut else IbColors.BubbleIn)
            .then(
                if (fromUser) Modifier.border(1.dp, IbColors.BubbleOutEdge, shape) else Modifier,
            )
            .padding(horizontal = 14.dp, vertical = 11.dp),
    ) {
        content()
    }
}

/** Attachment placeholders (Phase 33): what is there, without pretending it renders. */
@Composable
private fun AttachmentMarks(message: ChatMessage) {
    if (!message.hasAttachments) return
    Column(verticalArrangement = Arrangement.spacedBy(IbSpacing.xs)) {
        for (image in message.images) {
            IbMark(
                text = buildString {
                    append(IbStrings.chatImageMark(image.mime))
                    image.width?.let { w -> image.height?.let { h -> append(" · ${w}×$h") } }
                },
            )
        }
        for (file in message.files) {
            IbMark(text = IbStrings.chatFileMark(file.name))
        }
        message.voice?.let { voice ->
            IbMark(
                text = buildString {
                    append(IbStrings.chatVoiceMark(voice.durationSeconds))
                    if (voice.transcript != null) append(" · ${IbStrings.chatVoiceTranscript()}")
                },
            )
        }
    }
}

/**
 * The composer.
 *
 * No IME inset handling here: the root container already pads by `safeDrawing`, which
 * includes the IME, and the activity is `adjustResize`. Re-applying it would double the
 * gap (Phase 30 — one mechanism, not two).
 *
 * The shape is a pill rather than a box, and the send control is a filled circle, so the
 * bottom of the screen does not look like a form. There is deliberately no attachment
 * button: the brief asks for the *place* a future voice/image control would go, and an
 * inert paperclip would be a promise this build cannot keep.
 */
@Composable
private fun Composer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = IbSpacing.gutter, end = IbSpacing.md, top = IbSpacing.sm, bottom = IbSpacing.md),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        IbTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = IbStrings.chatComposerPlaceholder,
            maxLines = 5,
            shape = IbShapes.pill,
            modifier = Modifier.weight(1f),
        )

        val ready = value.isNotBlank()
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(IbShapes.pill)
                .background(if (ready) IbColors.AccentFill else IbColors.Glass)
                .then(
                    if (ready) Modifier.border(1.dp, IbColors.AccentSoft.copy(alpha = 0.35f), IbShapes.pill)
                    else Modifier.border(1.dp, IbColors.GlassEdge, IbShapes.pill),
                ),
            contentAlignment = Alignment.Center,
        ) {
            IconButton(onClick = onSend, enabled = ready) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = IbStrings.chatSend,
                    tint = if (ready) IbColors.Text else IbColors.TextFaint,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}
