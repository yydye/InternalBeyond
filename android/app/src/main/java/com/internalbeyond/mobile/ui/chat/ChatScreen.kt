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
 *
 * M1-C.2h moved the ORDER of the list out of this file. It used to draw every canonical
 * row and then every overlay row, which put a user's own message underneath the reply it
 * had already produced, whenever that reply became canonical before its question synced
 * (observed on 单可昕). [ConversationState.render] now hands this screen one merged list
 * in which each transient half is anchored to the canonical row it belongs to; this
 * layer draws it in order and never reorders it.
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

    var draft by rememberSaveable(characterId) { mutableStateOf(viewModel.draft()) }

    // Keep the newest content visible as it streams in. Sized from the merged list the
    // screen actually draws, plus the one "load older" row that precedes it.
    val itemCount = state.render.size + 1
    val streaming = remember(state.render) {
        state.render.sumOf {
            when (it) {
                is AttemptOverlay.RenderItem.AttemptAssistant -> it.attempt.partialText.length
                else -> 0
            }
        }
    }
    LaunchedEffect(itemCount, streaming) {
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

                    if (state.render.isEmpty() && !state.loading) {
                        item(key = "empty") {
                            IbEmptyState(
                                title = IbStrings.chatEmptyTitle,
                                detail = IbStrings.chatEmptyDetail(character?.name ?: characterId),
                            )
                        }
                    }

                    /**
                     * One list, already merged. [ConversationState.render] places each
                     * transient half where it belongs relative to the canonical rows —
                     * a send's own user bubble is anchored immediately before the reply
                     * it caused, so a canonical answer can never be drawn above the
                     * question (M1-C.2h). This layer only turns items into pixels and
                     * must not reorder them.
                     */
                    items(state.render, key = { it.key }) { item ->
                        when (item) {
                            is AttemptOverlay.RenderItem.Message ->
                                MessageBubble(item.message, reasoning = state.reasoning[item.message.id])

                            is AttemptOverlay.RenderItem.AttemptUser -> UserAttemptBubble(item.attempt)

                            is AttemptOverlay.RenderItem.AttemptAssistant -> AssistantAttemptTurn(
                                attempt = item.attempt,
                                onRetry = { viewModel.sendAgain(item.attempt.requestId) },
                            )
                        }
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
 *
 * [reasoning] is non-null only for an assistant message whose turn streamed reasoning
 * that the canonical DTO does not carry (`mobile-dto.js` strips `reasoning_content`).
 * It is joined by the canonical message id, and it belongs INSIDE this bubble: an
 * assistant turn is its thinking plus its answer, and neither may be drawn under the
 * user's message (M1-C.2g).
 */
@Composable
private fun MessageBubble(message: ChatMessage, reasoning: String? = null) {
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
            val thinking = reasoning?.takeIf {
                it.isNotEmpty() && AttemptOverlay.showsThinking(message)
            }
            if (thinking != null) {
                ThinkingBlock(thinking)
            }
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
 * The user's own optimistic bubble.
 *
 * Split out of the assistant half (M1-C.2g) because the two halves of one send
 * reconcile against different canonical ids at different times: this one waits for
 * `userMessageId`, the assistant turn below waits for `assistantMessageId`.
 */
@Composable
private fun UserAttemptBubble(attempt: SendAttempt) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Bubble(fromUser = true) {
            Text(text = attempt.content, style = IbType.body, color = IbColors.Text)
        }
    }
}

/**
 * The optimistic assistant turn: thinking above, then the reply, then the failure
 * control if there is one.
 *
 * Order is the invariant. A `send_attempts` row used to be drawn as one column —
 * user bubble, status, thinking, reply — which put the thinking block beneath the
 * user's message, where it read as the user's. An assistant turn is anchored to its
 * own reply: `UserTurn → AssistantTurn{ reasoning, content }`, and a gap in between
 * (the status line) must not be able to break that pair apart.
 */
@Composable
private fun AssistantAttemptTurn(attempt: SendAttempt, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        // A quiet progress line ABOVE the turn, so the thinking block and the reply
        // below it stay adjacent: the pair is the assistant turn.
        val status = when (attempt.state) {
            AttemptState.PENDING -> IbStrings.chatSending
            AttemptState.RECOVERING -> IbStrings.chatReconnecting
            AttemptState.RUNNING, AttemptState.DONE -> ""
            // The protocol code is not shown. It is in 详细信息 on the error card, if
            // the session produced one; here the only useful thing is that this did
            // not go, and the way to try again.
            AttemptState.FAILED -> IbStrings.chatSendFailed
        }
        if (status.isNotEmpty()) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                Text(
                    text = status,
                    style = IbType.caption,
                    color = if (attempt.state == AttemptState.FAILED) IbColors.Danger else IbColors.TextFaint,
                )
            }
        }

        if (attempt.state == AttemptState.FAILED) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                IbTextAction(
                    label = IbStrings.chatSendAgain,
                    onClick = onRetry,
                    color = IbColors.AccentSoft,
                )
            }
        }

        if (attempt.reasoningText.isNotEmpty()) {
            ThinkingBlock(attempt.reasoningText)
        }

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

/** The model's thinking, folded shut. One presentation owner at a time (M1-C.2g). */@Composable
private fun ThinkingBlock(text: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        IbDisclosure(label = IbStrings.chatReasoningShow) {
            Text(
                text = text,
                style = IbType.bodySmall,
                fontStyle = FontStyle.Italic,
                color = IbColors.TextFaint,
            )
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
