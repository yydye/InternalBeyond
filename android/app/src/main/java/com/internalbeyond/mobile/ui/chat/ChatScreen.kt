package com.internalbeyond.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.data.repository.ConversationState
import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.ui.character.EmptyState
import com.internalbeyond.mobile.ui.common.AttachmentChips
import com.internalbeyond.mobile.ui.common.StreamingDots
import com.internalbeyond.mobile.ui.common.formatTimestamp
import com.internalbeyond.mobile.ui.pairing.ErrorCard
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

    fun syncNow() {
        viewModelScope.launch { session.syncNow() }
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

@OptIn(ExperimentalMaterial3Api::class)
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
    val character = viewModel.character
    val listState = rememberLazyListState()

    var draft by rememberSaveable(characterId) { mutableStateOf(viewModel.draft()) }

    // Keep the newest content visible as it streams in.
    val itemCount = state.messages.size + state.overlay.size + 1
    LaunchedEffect(itemCount, state.overlay.map { it.partialText.length }) {
        if (itemCount > 1) {
            runCatching { listState.animateScrollToItem(itemCount - 1) }
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(
                            text = character?.name ?: characterId,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        ChatStatusLine(state)
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (state.reconnecting) {
                ReconnectBanner(onResume = { viewModel.resume() })
            }
            state.error?.let { ErrorCard(ErrorPresenter.present(it)) }

            Box(modifier = Modifier.weight(1f)) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        horizontal = 12.dp,
                        vertical = 8.dp,
                    ),
                ) {
                    if (state.hasOlder) {
                        item(key = "older") {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.Center,
                            ) {
                                if (state.loadingOlder) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                    )
                                } else {
                                    TextButton(onClick = { viewModel.loadOlder() }) {
                                        Text("Load older messages")
                                    }
                                }
                            }
                        }
                    }

                    if (state.messages.isEmpty() && state.overlay.isEmpty() && !state.loading) {
                        item(key = "empty") {
                            EmptyState(
                                title = "No messages yet",
                                detail = "Say something to ${character?.name ?: "this character"}.",
                            )
                        }
                    }

                    items(state.messages, key = { it.id }) { message ->
                        MessageBubble(message)
                    }

                    items(state.overlay, key = { it.localMessageId }) { attempt ->
                        AttemptBubbles(
                            attempt = attempt,
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
private fun ChatStatusLine(state: ConversationState) {
    val label = when {
        state.reconnecting -> "Reconnecting…"
        state.overlay.any { it.state == AttemptState.RUNNING } -> "Replying…"
        state.syncing -> "Syncing…"
        state.messages.isNotEmpty() -> "${state.messages.size} messages"
        else -> ""
    }
    if (label.isEmpty()) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (state.reconnecting || state.overlay.any { it.state == AttemptState.RUNNING }) {
            StreamingDots()
        }
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ReconnectBanner(onResume: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StreamingDots()
        Text(
            text = "Reconnecting… the reply continues on the Home Node",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onResume) { Text("Resume now") }
    }
}

/**
 * One canonical message. Only the DTO's own fields are rendered — there is nothing
 * here that could show a provider, an endpoint or a prompt, because the DTO does not
 * contain them.
 */
@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.isUser
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            if (message.withdrawn) {
                Text(
                    text = "(withdrawn)",
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                return@Column
            }
            Box(
                modifier = Modifier
                    .clip(
                        RoundedCornerShape(
                            topStart = 16.dp,
                            topEnd = 16.dp,
                            bottomStart = if (isUser) 16.dp else 4.dp,
                            bottomEnd = if (isUser) 4.dp else 16.dp,
                        ),
                    )
                    .background(
                        if (isUser) {
                            MaterialTheme.colorScheme.primaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceContainerHigh
                        },
                    )
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (message.content.isNotEmpty()) {
                        Text(
                            text = message.content,
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (isUser) {
                                MaterialTheme.colorScheme.onPrimaryContainer
                            } else {
                                MaterialTheme.colorScheme.onSurface
                            },
                        )
                    }
                    AttachmentChips(message)
                    if (message.truncated) {
                        Text(
                            text = "truncated",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            val stamp = formatTimestamp(message.timestamp)
            val model = message.metadata["model_id"] ?: message.metadata["model"]
            val caption = listOfNotNull(
                stamp.takeIf { it.isNotEmpty() },
                model?.takeIf { it.isNotEmpty() && !isUser },
            ).joinToString(" · ")
            if (caption.isNotEmpty()) {
                Text(
                    text = caption,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * The optimistic part of the UI: a send that has not (yet) got a canonical row.
 *
 * States come from [SendAttempt], never from a boolean: a pending bubble and a
 * failed one look different because they ARE different, and a recovering one says
 * "Reconnecting…" rather than "failed" (Phase 16/19).
 */
@Composable
private fun AttemptBubbles(attempt: SendAttempt, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            Box(
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .clip(RoundedCornerShape(16.dp, 16.dp, 16.dp, 4.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer)
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Text(
                    text = attempt.content,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }

        when (attempt.state) {
            AttemptState.PENDING -> StatusLine("Sending…")
            AttemptState.RECOVERING -> StatusLine("Reconnecting…")
            AttemptState.RUNNING -> StatusLine(null)
            AttemptState.DONE -> Unit
            AttemptState.FAILED -> Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = attempt.errorCode ?: "failed",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = onRetry) { Text("Send again") }
            }
        }

        if (attempt.reasoningText.isNotEmpty()) {
            ReasoningPanel(attempt.reasoningText)
        }

        val showAssistant = attempt.partialText.isNotEmpty() ||
            attempt.state == AttemptState.RUNNING ||
            attempt.state == AttemptState.PENDING
        if (showAssistant) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                Box(
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .clip(RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                ) {
                    if (attempt.partialText.isEmpty()) {
                        StreamingDots()
                    } else {
                        Text(
                            text = attempt.partialText,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusLine(text: String?) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (text == null) {
            StreamingDots()
        } else {
            Text(
                text = text,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Reasoning is collapsed by default but never discarded (Phase 17). */
@Composable
private fun ReasoningPanel(reasoning: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = if (expanded) "Hide reasoning" else "Show reasoning",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable { expanded = !expanded }
                .padding(vertical = 4.dp),
        )
        if (expanded) {
            Text(
                text = reasoning,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainer)
                    .padding(10.dp),
            )
        }
    }
}

/**
 * The composer.
 *
 * No IME inset handling here: the root container already pads by `safeDrawing`,
 * which includes the IME, and the activity is `adjustResize`. Re-applying it would
 * double the gap (Phase 30 — one mechanism, not two).
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
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("Message") },
            maxLines = 5,
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(18.dp),
        )
        IconButton(
            onClick = onSend,
            enabled = value.isNotBlank(),
        ) {
            Icon(
                Icons.AutoMirrored.Filled.Send,
                contentDescription = "Send",
                tint = if (value.isNotBlank()) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.outline
                },
            )
        }
    }
}
