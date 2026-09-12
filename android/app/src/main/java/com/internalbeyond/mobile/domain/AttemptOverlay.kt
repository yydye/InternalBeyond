package com.internalbeyond.mobile.domain

import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
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
 *
 * ── M1-C.2g · reasoning is assistant-owned turn state ─────────────────────────────
 *
 * The turn the user sees is not one row but a pair, and the two halves reconcile
 * independently:
 *
 * ```
 *   USER TURN                       ASSISTANT TURN
 *   attempt.content        ──►      attempt.reasoningText   (thinking)
 *   (until userMessageId            attempt.partialText     (the reply)
 *    is canonical)                  (until assistantMessageId is canonical)
 * ```
 *
 * So one `send_attempts` row has to be drawn as TWO conversation items, each anchored
 * to its own canonical id. Drawing it as one column — user bubble, then status, then
 * reasoning, then reply — put the thinking block *below the user's own message*, where
 * it reads as belonging to the user, and left it there after the reply had already
 * reconciled into the canonical list (observed on 爱莉希雅: `在吗` → 思考过程 → reply).
 *
 * Reasoning has exactly ONE owner at any moment, and the handover is the same event
 * that hands over the reply:
 *
 *  * **before** the canonical assistant row exists, the transient attempt owns it and
 *    renders it as part of its pending assistant turn;
 *  * **after**, the canonical assistant turn owns it, and [reasoningByAssistantId]
 *    hands the SAME text to the canonical bubble — keyed by `assistantMessageId`, the
 *    one identity that names the canonical row itself (`userMessageId` names the
 *    question, not the answer, and reasoning belongs to the answer).
 *
 * Reasoning is NOT copied into a second durable store by any of this: `send_attempts`
 * remains its only durable home, and the map below is a view over that table.
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

    /**
     * The optimistic half of the USER turn: drawn only while the canonical row for
     * this send's own message is absent, so the user's text cannot blink out between
     * the reply settling and `sync.changes` delivering the row.
     *
     * The counterpart of [showsAssistantBubble], and the reason an attempt has to be
     * split into two list items: the two halves leave at different times.
     */
    fun showsUserBubble(attempt: SendAttempt, canonicalIds: Set<String>): Boolean =
        attempt.userMessageId?.let { it.isEmpty() || it !in canonicalIds } ?: true

    /** [showsUserBubble] for the attempt's own message, [assistantIsCanonical] for its reply. */
    fun showsAssistantBubble(attempt: SendAttempt, canonicalIds: Set<String>): Boolean =
        !assistantIsCanonical(attempt, canonicalIds)

    /**
     * Reasoning, addressed by the canonical assistant message it belongs to.
     *
     * This is the reconciliation half of the ownership handover: once the canonical
     * reply is in the list, the canonical bubble renders this text instead of the
     * overlay, so thinking and answer are one assistant turn again. An attempt still
     * waiting for its canonical row is deliberately absent — the overlay is drawing it.
     *
     * Two attempts can never claim one canonical message: `assistantMessageId` is the
     * row's own id. A later attempt for the same turn (an idempotent replay) carries
     * the same id and the same reasoning, so the last write is the same value.
     */
    fun reasoningByAssistantId(attempts: List<SendAttempt>, canonicalIds: Set<String>): Map<String, String> {
        val out = HashMap<String, String>()
        for (attempt in attempts) {
            val id = attempt.assistantMessageId
            if (id.isNullOrEmpty() || id !in canonicalIds) continue
            if (attempt.reasoningText.isEmpty()) continue
            out[id] = attempt.reasoningText
        }
        return out
    }

    /**
     * Whether the thinking block is shown for one assistant turn.
     *
     * `showThinking` is a per-turn fact the Home Node already sends in the message
     * metadata whitelist, so the client reads it rather than inventing a setting.
     * Absent means unknown, and unknown is shown: hiding a whole class of content
     * because a field was missing would be a silent behaviour change on every provider
     * that does not set it.
     */
    fun showsThinking(message: ChatMessage): Boolean =
        message.metadata["showThinking"]?.trim()?.lowercase() != "false"
}
