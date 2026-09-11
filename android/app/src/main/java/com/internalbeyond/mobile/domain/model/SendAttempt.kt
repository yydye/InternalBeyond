package com.internalbeyond.mobile.domain.model

/**
 * Where a locally-tracked send has got to.
 *
 * This is NOT a message state. The Home Node's message is canonical the moment it
 * writes it; an attempt is this app's record of "there is a request I sent and I
 * have not yet confirmed how it ended". That distinction is what makes Phase 19
 * possible: a dropped connection moves an attempt to [RECOVERING], never to
 * [FAILED], because the generation is still running on the Home Node.
 */
enum class AttemptState {
    /** Created locally, not yet acknowledged by the Home Node. */
    PENDING,

    /** The Home Node accepted it and the turn is streaming. */
    RUNNING,

    /** The stream was lost; the turn is (probably) still running. Probe, don't fail. */
    RECOVERING,

    /** Terminal success. The canonical rows carry the truth from here on. */
    DONE,

    /** Terminal failure with a code. Retrying reuses the SAME requestId. */
    FAILED,
    ;

    val isTerminal: Boolean get() = this == DONE || this == FAILED
    val isOpen: Boolean get() = !isTerminal

    companion object {
        fun parse(raw: String?): AttemptState =
            entries.firstOrNull { it.name == raw } ?: PENDING
    }
}

/**
 * One user-initiated send.
 *
 * Persisted BEFORE the HTTP request goes out (Phase 21): if the process dies mid
 * flight, the requestId survives, and because the Home Node keys idempotency on
 * exactly that value, restarting and re-sending the same requestId either joins
 * the turn that is already running or replays the one that already finished. A
 * requestId generated after the request would make that impossible.
 */
data class SendAttempt(
    val requestId: String,
    val characterId: String,
    val conversationId: String,
    val content: String,
    val state: AttemptState,
    val turnId: String? = null,
    val userMessageId: String? = null,
    val assistantMessageId: String? = null,
    /** Highest stream sequence accepted. The resume anchor. */
    val lastSequence: Int = 0,
    /** Content deltas received so far — shown while the canonical row is absent. */
    val partialText: String = "",
    /** Reasoning deltas. Never discarded, shown collapsed (Phase 17). */
    val reasoningText: String = "",
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
) {
    /**
     * A stable, obviously-local id for the optimistic bubble. It can never be
     * confused with a canonical id, because the Home Node only ever issues ids it
     * generated itself (Phase 15).
     */
    val localMessageId: String get() = "local:$requestId"

    val conversationKey: String get() = conversationId.ifEmpty { "dm:$characterId" }

    companion object {
        const val MAX_PARTIAL_CHARS = 64_000
        const val MAX_REASONING_CHARS = 32_000
    }
}
