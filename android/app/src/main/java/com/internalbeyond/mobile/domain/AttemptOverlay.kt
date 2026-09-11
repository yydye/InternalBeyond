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
 */
object AttemptOverlay {

    fun visible(attempt: SendAttempt, canonicalIds: Set<String>): Boolean = when (attempt.state) {
        AttemptState.PENDING, AttemptState.RUNNING, AttemptState.RECOVERING -> true
        AttemptState.FAILED -> true
        AttemptState.DONE -> attempt.userMessageId?.let { it !in canonicalIds } ?: true
    }

    fun visible(attempts: List<SendAttempt>, canonicalIds: Set<String>): List<SendAttempt> =
        attempts.filter { visible(it, canonicalIds) }
}
