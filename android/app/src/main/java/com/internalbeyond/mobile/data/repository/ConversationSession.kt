package com.internalbeyond.mobile.data.repository

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.DeltaKind
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.api.StreamEvent
import com.internalbeyond.mobile.data.api.StreamSequenceTracker
import com.internalbeyond.mobile.data.api.TurnDone
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.sync.SyncEngine
import com.internalbeyond.mobile.domain.AttemptOverlay
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.platform.IdGen
import com.internalbeyond.mobile.platform.IbLog
import com.internalbeyond.mobile.platform.StreamRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

data class ConversationState(
    val conversationId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    /** Local sends that still need their own bubble. See [AttemptOverlay]. */
    val overlay: List<SendAttempt> = emptyList(),
    /**
     * Reasoning addressed by the canonical assistant message it belongs to, for turns
     * whose canonical row is already in [messages]. The overlay's copy is only drawn
     * while that row is missing, so an assistant turn shows its thinking exactly once
     * (M1-C.2g). A view over `send_attempts`, never a second store.
     */
    val reasoning: Map<String, String> = emptyMap(),
    val hasOlder: Boolean = false,
    val loading: Boolean = false,
    val loadingOlder: Boolean = false,
    val syncing: Boolean = false,
    /** A stream was interrupted and the app is re-establishing it (Phase 19). */
    val reconnecting: Boolean = false,
    val error: ProtocolError? = null,
)

/**
 * One open conversation: history, pagination, send, streaming and recovery.
 *
 * The three protocol rules this class implements, in the order they matter:
 *
 * 1. **The client never invents a canonical id.** Local sends live in
 *    [SendAttempt] records and are rendered as an overlay; the message list holds
 *    only server DTOs (Phase 15).
 * 2. **A dropped stream is not a failed message.** The Home Node owns the turn, so
 *    an interruption moves the attempt to [AttemptState.RECOVERING] and the app
 *    probes `turns.get` / reconnects — it does not mark anything failed (Phase 19).
 * 3. **The requestId is generated before the request and reused by every retry that
 *    is retrying the same delivery.** A terminal error ends that mandate: after the
 *    Home Node has explicitly finished the turn, "send again" is a NEW request with
 *    a NEW requestId, because replaying the old one would return the old outcome
 *    rather than generate anything (Phase 20).
 */
class ConversationSession(
    val characterId: String,
    private val threadId: String = "",
    private val client: HomeNodeClient,
    private val cache: LocalCache,
    private val sync: SyncEngine,
    private val streams: StreamRegistry,
    private val scope: CoroutineScope,
    private val nodeKey: () -> String,
    private val onFailure: (ProtocolError) -> Unit,
) {

    private val _state = MutableStateFlow(ConversationState())
    val state: StateFlow<ConversationState> = _state.asStateFlow()

    private val streamKey = "conv:$characterId:$threadId"

    // ── lifecycle ────────────────────────────────────────────────────────────

    /**
     * Cache first, then the network — and open attempts are recovered first, so a
     * send that was in flight when the process died is picked up immediately
     * (Phase 21) instead of being shown as failed.
     */
    fun start(): Job = scope.launch {
        publish(loading = true)
        refreshNewest()
        resumeOpenAttempts()
    }

    fun stop() {
        streams.cancel(streamKey)
    }

    // ── history ──────────────────────────────────────────────────────────────

    suspend fun refreshNewest(): ProtocolError? {
        val result = client.chatHistory(characterId, HISTORY_PAGE, cursor = null, threadId = threadId.ifEmpty { null })
        return when (result) {
            is ApiResult.Err -> {
                onFailure(result.error)
                publish(error = result.error)
                result.error
            }

            is ApiResult.Ok -> {
                val page = result.value
                cache.bindConversation(characterId, threadId, page.conversationId)
                cache.upsertMessages(page.messages)
                _hasOlder = page.hasOlder
                publish(lastRevision = page.revision)
                null
            }
        }
    }

    /** Phase 12: pagination via M1-A's keyset anchor (`oldest` of the last page). */
    suspend fun loadOlder(): ProtocolError? {
        val cursor = _olderAnchor ?: return null
        if (_state.value.loadingOlder) return null
        _state.value = _state.value.copy(loadingOlder = true)
        val result = client.chatHistory(characterId, HISTORY_PAGE, cursor = cursor, threadId = threadId.ifEmpty { null })
        return when (result) {
            is ApiResult.Err -> {
                onFailure(result.error)
                _state.value = _state.value.copy(loadingOlder = false, error = result.error)
                result.error
            }

            is ApiResult.Ok -> {
                val page = result.value
                cache.bindConversation(characterId, threadId, page.conversationId)
                cache.upsertMessages(page.messages)
                _olderAnchor = page.olderAnchor
                _hasOlder = page.hasOlder
                _state.value = _state.value.copy(loadingOlder = false, error = null)
                publish()
                null
            }
        }
    }

    // ── sending ──────────────────────────────────────────────────────────────

    /** Queue a send. Returns the requestId that identifies it from now on. */
    fun send(text: String): String {
        val attempt = createAttempt(text)
        launch(attempt)
        return attempt.requestId
    }

    /** Test/deterministic entry point: runs the whole send in the caller's coroutine. */
    suspend fun sendAndAwait(text: String): ProtocolError? = runAttempt(createAttempt(text))

    /**
     * "Send again" for a failed attempt: the SAME text, a NEW requestId.
     * See the class comment for why this is not the same as a retry.
     */
    fun sendAgain(requestId: String): String? {
        val previous = cache.attempt(requestId) ?: return null
        val attempt = createAttempt(previous.content)
        launch(attempt)
        return attempt.requestId
    }

    suspend fun sendAgainAndAwait(requestId: String): ProtocolError? {
        val previous = cache.attempt(requestId) ?: return null
        return runAttempt(createAttempt(previous.content))
    }

    /** Pick every unfinished send back up (app restart, or returning to foreground). */
    fun resumeOpenAttempts(): Job = scope.launch { resumeOpenAttemptsNow() }

    suspend fun resumeOpenAttemptsNow() {
        for (attempt in cache.openAttempts().filter { it.characterId == characterId }) {
            IbLog.info(
                "attempt.resume",
                IbLog.FIELD_REQUEST_ID to attempt.requestId,
                IbLog.FIELD_STATUS to attempt.state.name,
                IbLog.FIELD_SEQUENCE to attempt.lastSequence,
            )
            runAttempt(attempt)
        }
    }

    private fun createAttempt(text: String): SendAttempt {
        val now = System.currentTimeMillis()
        val attempt = SendAttempt(
            requestId = IdGen.requestId(),
            characterId = characterId,
            conversationId = cache.conversationId(characterId, threadId) ?: "",
            content = text,
            state = AttemptState.PENDING,
            createdAt = now,
            updatedAt = now,
        )
        // Persisted BEFORE anything is sent: this is what makes a process death
        // recoverable instead of losing the requestId (Phase 21).
        cache.saveAttempt(attempt)
        cache.clearDraft(conversationIdKey())
        publish()
        return attempt
    }

    private fun launch(attempt: SendAttempt) {
        scope.launch {
            val job = coroutineContext[Job]
            if (job != null) streams.register(streamKey, job)
            try {
                runAttempt(attempt)
            } finally {
                streams.unregister(streamKey)
            }
        }
    }

    /**
     * Drive one attempt to a terminal state.
     *
     * The loop is bounded on purpose: each iteration either makes progress toward a
     * terminal frame or consumes one of a small budget of recoveries. An unbounded
     * loop here would be an app that hammers a Home Node forever.
     */
    private suspend fun runAttempt(initial: SendAttempt): ProtocolError? = withContext(Dispatchers.IO) {
        var attempt = initial
        if (attempt.state == AttemptState.DONE || attempt.state == AttemptState.FAILED) return@withContext null

        var recoveries = 0
        var restarts = 0
        while (true) {
            val runtime = AttemptRuntime(attempt)
            val flow = if (runtime.turnId != null) {
                // We already know the turn: resume it rather than re-posting.
                client.openTurnStream(runtime.turnId!!, runtime.lastSequence)
            } else {
                runtime.state = AttemptState.PENDING
                client.sendStream(
                    requestId = runtime.requestId,
                    characterId = runtime.characterId,
                    // The USER'S text — never runtime.content, which accumulates the
                    // streamed reply. Sending the buffer would send an empty message on
                    // the first attempt and the assistant's own words on a retry.
                    content = runtime.userText,
                    threadId = threadId.ifEmpty { null },
                )
            }

            val end = collectStream(flow, runtime, attempt.lastSequence)
            when (end) {
                is StreamEnd.Terminal -> {
                    settleDone(runtime, end.done)
                    return@withContext null
                }

                is StreamEnd.TurnFailed -> {
                    // A turn can end with a fatal auth error just as a read can: the
                    // credential must die here too, or a revoked device keeps a token
                    // it can never use (Phase 24).
                    if (end.error.isAuthFatal) onFailure(end.error)
                    settleFailed(runtime, end.error)
                    return@withContext end.error
                }

                is StreamEnd.Restart -> {
                    // A missing frame inside one connection: reconnect from the last
                    // sequence we actually accepted.
                    restarts++
                    IbLog.warn(
                        "stream.gap",
                        IbLog.FIELD_REQUEST_ID to runtime.requestId,
                        IbLog.FIELD_SEQUENCE to runtime.lastSequence,
                    )
                    attempt = persist(runtime, force = true)
                    if (restarts > MAX_RESTARTS) {
                        return@withContext recover(runtime, null, recoveries)
                    }
                }

                is StreamEnd.Interrupted -> {
                    attempt = persist(runtime, force = true)
                    recoveries++
                    if (recoveries > MAX_RECOVERIES) {
                        return@withContext giveUpRecovering(runtime, end.error)
                    }
                    val outcome = recover(runtime, end.error, recoveries)
                    if (outcome != null) return@withContext outcome
                    // recover() cleared the turnId when the Home Node had no record of
                    // it, which makes the next iteration re-send with the SAME requestId.
                    attempt = cache.attempt(runtime.requestId) ?: attempt
                }
            }
        }
        @Suppress("UNREACHABLE_CODE")
        null
    }

    /**
     * Phase 19's recovery ladder, in the order the protocol defines it.
     *
     * Returns a non-null error only when the attempt reached a terminal failure;
     * null means "keep going" (either the turn finished and was settled, or the
     * loop should re-enter and re-send).
     */
    private suspend fun recover(runtime: AttemptRuntime, cause: ProtocolError?, attemptNumber: Int): ProtocolError? {
        runtime.state = AttemptState.RECOVERING
        _state.value = _state.value.copy(reconnecting = true)
        persist(runtime, force = true)

        if (attemptNumber > 1) {
            delay(backoffMs(attemptNumber))
        }

        val key = runtime.turnId ?: runtime.requestId
        when (val probe = client.turnsGet(key)) {
            is ApiResult.Ok -> {
                val status = probe.value
                runtime.userMessageId = status.userMessageId ?: runtime.userMessageId
                runtime.assistantMessageId = status.assistantMessageId ?: runtime.assistantMessageId
                status.conversationId?.let { runtime.conversationId = it }
                when {
                    status.status == "running" -> {
                        // Still generating. Reconnect and keep streaming from where we got to.
                        _state.value = _state.value.copy(reconnecting = true)
                        persist(runtime, force = true)
                        return null
                    }

                    status.isSuccess -> {
                        settleDoneFromStatus(runtime)
                        return null
                    }

                    else -> {
                        settleFailed(
                            runtime,
                            ProtocolError.Server(
                                code = status.error ?: ProtocolError.INTERNAL,
                                message = "the turn ended with ${status.error ?: "an error"}",
                                retryable = false,
                            ),
                        )
                        return ProtocolError.Server(
                            code = status.error ?: ProtocolError.INTERNAL,
                            message = "the turn ended with ${status.error ?: "an error"}",
                            retryable = false,
                        )
                    }
                }
            }

            is ApiResult.Err -> {
                val error = probe.error
                if (error is ProtocolError.Server && error.code == ProtocolError.NOT_FOUND) {
                    // The Home Node has no turn for that id. Either our request never
                    // landed, or it is long finished and the in-memory turn was pruned.
                    // Re-sending the SAME requestId is safe in both cases: the store's
                    // idempotency key is derived from it, so a replay cannot create a
                    // second user message (docs/MOBILE_GATEWAY.md §12).
                    IbLog.info(
                        "recover.no-turn",
                        IbLog.FIELD_REQUEST_ID to runtime.requestId,
                        IbLog.FIELD_STATUS to "re-send",
                    )
                    // Starting over: the Home Node has no turn, so its frames will begin
                    // at sequence 1 again and the old buffer describes a turn that no
                    // longer exists. Canonical truth still comes from chat.done/sync.
                    runtime.turnId = null
                    runtime.lastSequence = 0
                    runtime.content.setLength(0)
                    runtime.reasoning.setLength(0)
                    runtime.state = AttemptState.PENDING
                    persist(runtime, force = true)
                    return null
                }
                if (error.isAuthFatal) {
                    onFailure(error)
                    settleFailed(runtime, error)
                    return error
                }
                if (cause != null && attemptNumber >= MAX_RECOVERIES) {
                    return giveUpRecovering(runtime, error)
                }
                // Transient: another lap of the outer loop will probe again.
                persist(runtime, force = true)
                return null
            }
        }
    }

    /**
     * Out of recovery budget while the Home Node is unreachable. The attempt is kept
     * in RECOVERING — NOT marked failed, because nothing is known to have failed —
     * and the UI offers to resume (Phase 19).
     */
    private fun giveUpRecovering(runtime: AttemptRuntime, error: ProtocolError?): ProtocolError? {
        runtime.state = AttemptState.RECOVERING
        runtime.errorCode = error?.code
        runtime.errorMessage = error?.message
        persist(runtime, force = true)
        _state.value = _state.value.copy(reconnecting = false, error = error)
        IbLog.warn(
            "recover.deferred",
            IbLog.FIELD_REQUEST_ID to runtime.requestId,
            IbLog.FIELD_CODE to (error?.code ?: "unknown"),
        )
        return null
    }

    private fun settleDone(runtime: AttemptRuntime, done: TurnDone) {
        runtime.state = AttemptState.DONE
        runtime.assistantMessageId = done.assistantMessageId ?: runtime.assistantMessageId
        runtime.userMessageId = done.userMessageId ?: runtime.userMessageId
        done.conversationId?.let { runtime.conversationId = it }
        done.message?.let { cache.upsertMessages(listOf(it)) }
        persist(runtime, force = true)
        IbLog.info(
            "attempt.done",
            IbLog.FIELD_REQUEST_ID to runtime.requestId,
            IbLog.FIELD_TURN_ID to runtime.turnId,
            IbLog.FIELD_SEQUENCE to runtime.lastSequence,
            "duplicate" to done.duplicate,
        )
    }

    private fun settleDoneFromStatus(runtime: AttemptRuntime) {
        runtime.state = AttemptState.DONE
        runtime.errorCode = null
        runtime.errorMessage = null
        persist(runtime, force = true)
    }

    private fun settleFailed(runtime: AttemptRuntime, error: ProtocolError) {
        runtime.state = AttemptState.FAILED
        runtime.errorCode = error.code
        runtime.errorMessage = error.message
        persist(runtime, force = true)
        IbLog.warn(
            "attempt.failed",
            IbLog.FIELD_REQUEST_ID to runtime.requestId,
            IbLog.FIELD_CODE to error.code,
        )
    }

    // ── stream consumption ───────────────────────────────────────────────────

    private sealed interface StreamEnd {
        data class Terminal(val done: TurnDone) : StreamEnd
        data class TurnFailed(val error: ProtocolError) : StreamEnd
        data class Interrupted(val error: ProtocolError?) : StreamEnd
        /** A frame was missing inside one connection: reconnect from lastSequence. */
        object Restart : StreamEnd
    }

    private class StopCollecting(val end: StreamEnd) : Exception()

    private suspend fun collectStream(
        flow: kotlinx.coroutines.flow.Flow<StreamEvent>,
        runtime: AttemptRuntime,
        startingSequence: Int,
    ): StreamEnd {
        val tracker = StreamSequenceTracker(startingSequence)
        tracker.onConnectionOpened()
        var end: StreamEnd = StreamEnd.Interrupted(null)
        var lastPersist = 0L
        try {
            flow.collect { event ->
                when (event) {
                    is StreamEvent.Start -> {
                        val status = event.started.status
                        if (status.turnId.isNotEmpty()) runtime.turnId = status.turnId
                        status.conversationId?.let {
                            runtime.conversationId = it
                            cache.bindConversation(characterId, threadId, it)
                        }
                        if (runtime.state != AttemptState.RUNNING) {
                            runtime.state = AttemptState.RUNNING
                            _state.value = _state.value.copy(reconnecting = false)
                        }
                        lastPersist = persistThrottled(runtime, lastPersist, force = true)
                    }

                    is StreamEvent.Delta -> when (val decision = tracker.onFrame(event.sequence)) {
                        is StreamSequenceTracker.Decision.Duplicate -> Unit // drop: re-delivery is normal
                        is StreamSequenceTracker.Decision.Control -> Unit

                        is StreamSequenceTracker.Decision.Gap -> {
                            end = StreamEnd.Restart
                            runtime.lastSequence = tracker.lastSeen
                            throw StopCollecting(end)
                        }

                        StreamSequenceTracker.Decision.Adopted,
                        StreamSequenceTracker.Decision.Accepted,
                        -> {
                            runtime.lastSequence = tracker.lastSeen
                            if (event.kind == DeltaKind.CONTENT) {
                                runtime.content.append(event.text)
                            } else {
                                // Reasoning frames are never discarded (Phase 17); they
                                // are accumulated and shown collapsed by the UI.
                                runtime.reasoning.append(event.text)
                            }
                            lastPersist = persistThrottled(runtime, lastPersist, force = false)
                        }
                    }

                    is StreamEvent.Done -> {
                        end = StreamEnd.Terminal(event.done)
                        throw StopCollecting(end)
                    }

                    is StreamEvent.Failure -> {
                        end = StreamEnd.TurnFailed(event.error)
                        throw StopCollecting(end)
                    }

                    is StreamEvent.StreamProblem -> {
                        if (event.error.code == ProtocolError.REPLAY_GAP || event.resync) {
                            // "The middle was lost, resync" — never "your data is gone".
                            // Canonical state comes from sync.changes.
                            end = StreamEnd.Interrupted(event.error)
                            throw StopCollecting(end)
                        }
                        end = StreamEnd.Interrupted(event.error)
                        throw StopCollecting(end)
                    }

                    is StreamEvent.Unknown -> {
                        // A frame type from a newer server. Ignoring it is safe: the
                        // turn still terminates with chat.done / chat.error.
                        IbLog.debug("stream.unknown-frame")
                    }
                }
            }
            // EOF without a terminal frame: treat as an interruption, not a failure.
            end = StreamEnd.Interrupted(null)
        } catch (stop: StopCollecting) {
            end = stop.end
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            end = StreamEnd.Interrupted(HomeNodeClient.transportError(error))
        }
        persist(runtime, force = true)
        return end
    }

    // ── state plumbing ───────────────────────────────────────────────────────

    private fun conversationIdKey(): String = cache.conversationId(characterId, threadId) ?: characterId

    private var _hasOlder = false
    private var _olderAnchor: String? = null

    /**
     * Rebuild the visible state from the cache. The UI never holds authoritative
     * state of its own, which is what makes "kill the app mid-stream" recoverable.
     */
    private fun publish(
        loading: Boolean = _state.value.loading,
        error: ProtocolError? = _state.value.error,
        lastRevision: Long? = null,
    ) {
        val conversationId = cache.conversationId(characterId, threadId)
        val messages = conversationId?.let { cache.messages(it, HISTORY_PAGE) } ?: emptyList()
        val ids = messages.mapTo(HashSet()) { it.id }
        val attempts = cache.attemptsFor(characterId)
        _state.value = ConversationState(
            conversationId = conversationId,
            messages = messages,
            overlay = AttemptOverlay.visible(attempts, ids),
            reasoning = AttemptOverlay.reasoningByAssistantId(attempts, ids),
            hasOlder = _hasOlder || messages.size >= HISTORY_PAGE,
            loading = loading,
            loadingOlder = _state.value.loadingOlder,
            syncing = _state.value.syncing,
            reconnecting = _state.value.reconnecting,
            error = error,
        )
    }

    private fun persist(runtime: AttemptRuntime, force: Boolean): SendAttempt {
        val snapshot = runtime.snapshot()
        cache.saveAttempt(snapshot)
        if (force) publish()
        return snapshot
    }

    private fun persistThrottled(runtime: AttemptRuntime, lastPersist: Long, force: Boolean): Long {
        val now = System.currentTimeMillis()
        if (!force && now - lastPersist < PERSIST_INTERVAL_MS) return lastPersist
        cache.saveAttempt(runtime.snapshot())
        return now
    }

    /** Pull canonical truth. Always safe, and the only thing that can't be wrong. */
    suspend fun syncNow(): ProtocolError? = withContext(Dispatchers.IO) {
        _state.value = _state.value.copy(syncing = true)
        val result = sync.run(nodeKey())
        val error = result.errorOrNull()
        if (error != null) onFailure(error)
        _state.value = _state.value.copy(syncing = false, error = error ?: _state.value.error)
        publish()
        error
    }

    fun draft(): String = cache.draft(conversationIdKey())

    fun saveDraft(text: String) = cache.saveDraft(conversationIdKey(), text)

    /** The canonical ids currently rendered, so the UI can key bubbles correctly. */
    fun messageIds(): Set<String> = _state.value.messages.mapTo(HashSet()) { it.id }

    companion object {
        const val HISTORY_PAGE = 50
        const val MAX_RECOVERIES = 5
        const val MAX_RESTARTS = 2
        const val PERSIST_INTERVAL_MS = 200L

        fun backoffMs(attempt: Int): Long {
            val base = 1000L shl (attempt - 1).coerceIn(0, 4)
            return base.coerceAtMost(16_000L)
        }
    }
}

/**
 * Mutable working copy of one attempt, so that a stream can be consumed without
 * writing to SQLite on every delta.
 */
private class AttemptRuntime(attempt: SendAttempt) {
    val requestId = attempt.requestId
    val characterId = attempt.characterId
    val userText = attempt.content
    val createdAt = attempt.createdAt

    var conversationId = attempt.conversationId
    var state = attempt.state
    var turnId: String? = attempt.turnId
    var userMessageId: String? = attempt.userMessageId
    var assistantMessageId: String? = attempt.assistantMessageId
    var lastSequence = attempt.lastSequence
    var errorCode: String? = attempt.errorCode
    var errorMessage: String? = attempt.errorMessage

    val content = StringBuilder(attempt.partialText)
    val reasoning = StringBuilder(attempt.reasoningText)

    fun snapshot(): SendAttempt = SendAttempt(
        requestId = requestId,
        characterId = characterId,
        conversationId = conversationId,
        content = userText,
        state = state,
        turnId = turnId,
        userMessageId = userMessageId,
        assistantMessageId = assistantMessageId,
        lastSequence = lastSequence,
        partialText = content.toString().take(SendAttempt.MAX_PARTIAL_CHARS),
        reasoningText = reasoning.toString().take(SendAttempt.MAX_REASONING_CHARS),
        errorCode = errorCode,
        errorMessage = errorMessage,
        createdAt = createdAt,
        updatedAt = System.currentTimeMillis(),
    )
}
