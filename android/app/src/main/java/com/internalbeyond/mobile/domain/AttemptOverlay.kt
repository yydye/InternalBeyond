package com.internalbeyond.mobile.domain

import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.SendAttempt

/**
 * Decides whether a local send-attempt still needs its own bubble in the UI.
 *
 * The alternative design — writing the optimistic message INTO the message table —
 * was rejected deliberately. It would put a row with a client-invented id next to
 * canonical rows, and every later reconciliation (history page, sync upsert, delete)
 * would have to guess which rows are real. Keeping optimistic state in its own type
 * means the canonical list contains only server DTOs, and this function is the single
 * place that decides when the overlay goes away.
 *
 * Rules:
 *  * an open attempt is always visible (it is by definition the newest thing);
 *  * a FAILED attempt stays visible so the user can retry with the SAME requestId;
 *  * a DONE attempt stays visible only until its canonical user message is actually
 *    in the cache — otherwise the user's own text would blink out between the
 *    stream finishing and the next sync landing.
 *
 * The second rule below is the one that keeps the conversation honest. An attempt
 * carries the streamed reply in [SendAttempt.partialText], and that reply becomes a
 * real canonical message the moment `chat.done` lands: the done frame names the
 * canonical `assistantMessageId` AND carries the stored message, which
 * [ConversationSession] writes straight into the cache. So the canonical assistant
 * row is present immediately, while the canonical USER row only ever arrives later
 * through `sync.changes` — a channel that is not guaranteed to run at all between
 * one send and the next.
 *
 * Keying the whole overlay on the user message alone therefore rendered the reply
 * TWICE: once from `messages` (canonical, authoritative) and once from the overlay's
 * copy of the same text, for as long as the user row had not synced. Since a
 * `send_attempts` row is retained after it is DONE, that window never closes on its
 * own. Suppressing the overlay's assistant bubble once the canonical assistant row
 * is cached is RECONCILIATION, not a second append: the two are the same message,
 * matched by the canonical id — never by content, because two legitimate replies may
 * be word-for-word identical.
 */
object AttemptOverlay {

    fun visible(attempt: SendAttempt, canonicalIds: Set<String>): Boolean = when (attempt.state) {
        AttemptState.PENDING, AttemptState.RUNNING, AttemptState.RECOVERING -> true
        AttemptState.FAILED -> true
        AttemptState.DONE -> attempt.userMessageId?.let { it !in canonicalIds } ?: true
    }

    fun visible(attempts: List<SendAttempt>, canonicalIds: Set<String>): List<SendAttempt> =
        attempts.filter { visible(it, canonicalIds) }

    /**
     * True when the turn this attempt is streaming has already been written to
     * canonical storage, so any bubble still replaying [SendAttempt.partialText]
     * would be a duplicate of a real message rather than a preview of one.
     *
     * An attempt with no `assistantMessageId` has not been told about a canonical row
     * yet, so it keeps its bubble: "we have not been told" must never be read as
     * "there is nothing there".
     */
    fun assistantIsCanonical(attempt: SendAttempt, canonicalIds: Set<String>): Boolean =
        attempt.assistantMessageId?.let { it.isNotEmpty() && it in canonicalIds } ?: false

    /** [visible] for the attempt's own bubble, [assistantIsCanonical] for its reply. */
    fun showsAssistantBubble(attempt: SendAttempt, canonicalIds: Set<String>): Boolean =
        !assistantIsCanonical(attempt, canonicalIds)
}
