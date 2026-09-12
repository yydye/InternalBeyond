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
 *
 * ── M1-C.2h · the user turn is anchored to its own reply ──────────────────────────
 *
 * The two halves above reconcile against different ids at different times, and the
 * ORDER they end up in used to be an accident of how the list was assembled: every
 * canonical row first, then every overlay item. That is correct only while the sending
 * turn is the newest thing in the conversation. It stops being correct the moment its
 * reply becomes canonical while its question has not:
 *
 * ```
 *   messages  [ …earlier turns… , msg_<asst> ]   ← the reply, canonical
 *   overlay   [ attempt{ U, A } ]                ← the question, still transient
 *   rendered  [ …earlier turns… , msg_<asst>, USER BUBBLE ]
 * ```
 *
 * which is the reported symptom: a canonical reply drawn ABOVE the user message that
 * caused it. Observed on 单可昕. The conversation had older canonical rows, so "the
 * overlay is appended last" put the question below its own answer.
 *
 * The fix is NOT a sort. It is an anchor. A turn this device sent is identified by the
 * attempt row, which names BOTH halves (`userMessageId`, `assistantMessageId`), so
 * [render] places the transient user bubble immediately before the canonical row it
 * belongs to and leaves every other row exactly where canonical order put it.
 *
 * The invariant, in one line: THE USER TURN ALWAYS PRECEDES ITS OWN ASSISTANT TURN.
 *
 * It holds in all six orderings, because in each one the attempt says where its two
 * halves go:
 *
 * | canonical | transient | rendered                          |
 * |-----------|-----------|-----------------------------------|
 * | A         | U         | U is anchored immediately before A |
 * | U         | A         | the attempt's assistant turn is appended after every canonical row, so it still follows U |
 * | U and A   | —         | canonical order, adjusted only if the server's own order inverted the pair |
 * | —         | U and A   | appended as one turn: user, then thinking+reply |
 * | reconnect | —         | the attempt row is durable, so the anchor survives it |
 * | restart   | —         | state is rebuilt from `send_attempts` plus the cache, so the same anchor is derived |
 *
 * Nothing here compares timestamps, matches content, applies an offset, or asks the
 * Home Node for anything new. Two attempts can never claim one turn because
 * `userMessageId` and `assistantMessageId` are the rows' own ids.
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

    // ── the conversation as it is drawn (M1-C.2h) ─────────────────────────────

    /**
     * One item of the conversation, in the order it is drawn.
     *
     * The UI renders this list verbatim. It used to concatenate the canonical list and
     * the overlay list itself, which is precisely how a reply could be drawn above the
     * question it answers: the concatenation had no idea the two belonged to one turn.
     * Making the merge explicit and pure is what lets the invariant be asserted in a
     * test instead of hoped for on a phone.
     */
    sealed interface RenderItem {
        /** Stable `LazyColumn` key. Never a content hash. */
        val key: String

        data class Message(val message: ChatMessage) : RenderItem {
            override val key: String get() = message.id
        }

        /**
         * The optimistic half of a USER turn: [SendAttempt.content], drawn while the
         * canonical row for this send's own message is absent.
         */
        data class AttemptUser(val attempt: SendAttempt) : RenderItem {
            override val key: String get() = attempt.localMessageId + ":user"
        }

        /**
         * The optimistic ASSISTANT turn: thinking above, then the reply, drawn while
         * the canonical row for this reply is absent.
         */
        data class AttemptAssistant(val attempt: SendAttempt) : RenderItem {
            override val key: String get() = attempt.localMessageId + ":assistant"
        }
    }

    /**
     * The conversation, ordered so that a user turn always precedes its own assistant
     * turn.
     *
     * Canonical order is authoritative for everything this device has not sent, and it
     * is preserved exactly: this function is not a sort, and it never moves a canonical
     * row that is not contradicted by turn identity. What it adds is a single rule,
     * applied in two shapes because a turn can be split across the two lists in two
     * ways:
     *
     * ```
     * ANSWER canonical, QUESTION still transient      (the reported symptom)
     *   → the transient user bubble is drawn immediately before the answer's row
     *
     * QUESTION canonical, ANSWER still transient      (a send in flight after a sync)
     *   → the transient assistant turn is drawn after that row, as its own turn
     * ```
     *
     * plus one correction the device can make and the server's ordering key cannot: when
     * BOTH of its own rows are canonical but the cache put the answer first. The
     * canonical order key is `(timestamp, insert_seq)`, `insert_seq` is not in the mobile
     * DTO, and the assistant timestamp is the GENERATION-FINISH clock while the user
     * timestamp is the SEND clock — so the `(timestamp, id)` fallback can invert a pair.
     * This device knows the pair's real order from its own attempt row, so it uses it. It
     * does NOT guess for a turn it never sent.
     */
    fun render(
        canonical: List<ChatMessage>,
        attempts: List<SendAttempt>,
        canonicalIds: Set<String>,
    ): List<RenderItem> {
        // Oldest first. The cache hands these back in creation order already, but the
        // merge below must not depend on that.
        val senders = attempts.sortedWith(compareBy({ it.createdAt }, { it.requestId }))

        /**
         * How one attempt is drawn: its user bubble (null once that row is canonical)
         * and its assistant turn (null once THAT row is canonical). The two halves
         * leave at different times, which is why one attempt is two items, not one.
         */
        class Halo(val user: RenderItem.AttemptUser?, val assistant: RenderItem.AttemptAssistant?)

        val haloFor = HashMap<String, Halo>(senders.size)
        for (attempt in senders) {
            val halo = Halo(
                user = attempt.takeIf { showsUserBubble(it, canonicalIds) }?.let { RenderItem.AttemptUser(it) },
                assistant = attempt.takeIf { showsAssistantBubble(it, canonicalIds) }
                    ?.let { RenderItem.AttemptAssistant(it) },
            )
            // An attempt with nothing left to draw — the ordinary state of every turn
            // once both of its rows have synced — contributes no halo at all.
            if (halo.user != null || halo.assistant != null) haloFor[attempt.localMessageId] = halo
        }

        /**
         * The canonical row each halo must be drawn immediately before, by message id:
         * the reply, once it is cached and the halo is not replaying it any more.
         *
         * This is the anchor the whole fix turns on. Without it the halo was appended
         * after every canonical row, which put a still-transient question BELOW the
         * answer it had already produced.
         */
        val anchorAt = HashMap<String, String>(senders.size)
        for (attempt in senders) {
            val halo = haloFor[attempt.localMessageId] ?: continue
            val answer = attempt.assistantMessageId
            if (halo.assistant == null && !answer.isNullOrEmpty() && answer in canonicalIds) {
                anchorAt[attempt.localMessageId] = answer
            }
        }

        /**
         * The two canonical rows of one of OUR turns, when the cache ordered them
         * backwards.
         *
         * The canonical order key is `(timestamp, insert_seq)`; `insert_seq` is not in
         * the mobile DTO, and the assistant timestamp is the GENERATION-FINISH clock
         * while the user timestamp is the SEND clock, so the `(timestamp, id)` fallback
         * can invert a pair. This device knows the pair's real order from its own
         * attempt row, so it uses it — and it does NOT guess for a turn it never sent.
         */
        val questionOf = HashMap<String, String>(senders.size)
        for (attempt in senders) {
            val question = attempt.userMessageId
            val answer = attempt.assistantMessageId
            if (question.isNullOrEmpty() || answer.isNullOrEmpty()) continue
            if (question !in canonicalIds || answer !in canonicalIds) continue
            // Both halves must actually be in the list being ordered, and in the wrong
            // order: `indexOfFirst` answers -1 for an absent id, and -1 is not "later".
            val q = canonical.indexOfFirst { it.id == question }
            val a = canonical.indexOfFirst { it.id == answer }
            if (q < 0 || a < 0) continue
            if (q < a) continue
            questionOf[answer] = question
        }

        val drawn = HashSet<String>(haloFor.size)
        val emitted = HashSet<String>(canonical.size)
        val out = ArrayList<RenderItem>(canonical.size + haloFor.size)

        /**
         * Draw a halo, whole, where it belongs — once.
         *
         * There is deliberately no "assistant half only" or "user half only" variant.
         * `halo.assistant` is already null exactly when the canonical row is drawing that
         * answer itself, and `halo.user` is already null exactly when the canonical row is
         * drawing the question, so the halo IS the set of things still missing. Passing a
         * flag to suppress half of it is how a still-streaming reply got dropped from its
         * own turn.
         */
        fun draw(haloId: String) {
            if (haloId in drawn) return
            val halo = haloFor[haloId] ?: return
            drawn += haloId
            halo.user?.let { out.add(it) }
            halo.assistant?.let { out.add(it) }
        }

        for (row in canonical) {
            /*
             * A turn of ours whose question the cache placed AFTER this reply. Both halves
             * have to move for this to come out right:
             *
             *  * the question is drawn here, immediately before the answer it belongs to;
             *  * the answer is drawn here rather than at its own (earlier) position, which
             *    is exactly what `row.id !in emitted` is for.
             *
             * An attempt whose rows the cache already ordered correctly never enters
             * [questionOf], so canonical order is untouched for it.
             */
            questionOf[row.id]?.let { questionId ->
                val question = canonical.firstOrNull { it.id == questionId }
                if (question != null && row.id !in emitted && emitted.add(questionId)) {
                    out += RenderItem.Message(question)
                }
            }

            // Every halo whose answer is this row: the transient question, immediately
            // before the canonical reply it produced. The row is marked first, so a
            // question the cache put later is still pulled up in its own iteration
            // instead of being treated as already answered for.
            if (emitted.add(row.id)) {
                for (attempt in senders) {
                    if (anchorAt[attempt.localMessageId] == row.id) draw(attempt.localMessageId)
                }
                out += RenderItem.Message(row)
            }
        }

        // Whatever is left has no canonical row to sit with — its reply is not cached,
        // so it is the newest thing in the conversation and belongs after every
        // canonical row. [drawn] is what keeps a halo that already found its place from
        // being appended a second time, which would put the user's own message AFTER the
        // reply: the exact defect this function exists to prevent.
        for (attempt in senders) draw(attempt.localMessageId)

        return out
    }
}