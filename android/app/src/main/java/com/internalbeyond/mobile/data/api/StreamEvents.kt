package com.internalbeyond.mobile.data.api

import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.TurnStatus
import org.json.JSONObject

enum class DeltaKind { CONTENT, REASONING }

/** `chat.start` — the turn's identity and the position of its replay window. */
data class TurnStarted(
    val status: TurnStatus,
    val replayGap: Boolean,
    val reattached: Boolean,
)

/** `chat.done` — the ONLY success terminal, carrying the canonical assistant row. */
data class TurnDone(
    val turnId: String,
    val conversationId: String?,
    val userMessageId: String?,
    val assistantMessageId: String?,
    val revision: Long?,
    /** True when this `chat.send` was a repeat of an already-known requestId. */
    val duplicate: Boolean,
    val message: ChatMessage?,
    val stored: Boolean,
)

/**
 * One decoded frame from a turn stream. Mirrors the server's closed event set
 * (`mobile-gateway.js: STREAM_EVENTS`) — there is no separate reasoning protocol:
 * reasoning and content share `chat.delta` and differ only by `kind`.
 */
sealed class StreamEvent {
    data class Start(val started: TurnStarted) : StreamEvent()
    data class Delta(val kind: DeltaKind, val text: String, val index: Int?, val sequence: Int) : StreamEvent()
    data class Done(val done: TurnDone) : StreamEvent()
    /** A terminal failure of the turn itself (`chat.error`). */
    data class Failure(val error: ProtocolError, val sequence: Int) : StreamEvent()
    /** `stream.error` — a transport-level problem with the STREAM, not the turn. */
    data class StreamProblem(val error: ProtocolError, val resync: Boolean) : StreamEvent()
    /** A frame type this build does not know. Kept so it is never mistaken for a terminal. */
    data class Unknown(val type: String) : StreamEvent()
}

object StreamEventCodec {

    const val START = "chat.start"
    const val DELTA = "chat.delta"
    const val DONE = "chat.done"
    const val ERROR = "chat.error"
    const val STREAM_ERROR = "stream.error"

    fun decode(frame: SseParser.Frame): StreamEvent? {
        val raw = frame.data ?: return null
        val json = try {
            JSONObject(raw)
        } catch (_: Exception) {
            // A malformed data line is not a terminal state. Ignoring it is the
            // safe choice: the turn still ends with chat.done or chat.error, and
            // canonical truth is always available from sync.changes.
            return StreamEvent.Unknown("malformed")
        }
        val type = json.textOrNull("type") ?: frame.event ?: return null
        val sequence = json.intOrNull("sequence") ?: -1
        val payload = json.objOrNull("payload") ?: JSONObject()

        return when (type) {
            START -> StreamEvent.Start(
                TurnStarted(
                    status = DtoCodec.turnStatus(payload),
                    replayGap = payload.boolOrNull("replayGap") ?: false,
                    reattached = payload.boolOrNull("reattached") ?: false,
                ),
            )

            DELTA -> StreamEvent.Delta(
                kind = if (payload.textOrNull("kind") == "reasoning") DeltaKind.REASONING else DeltaKind.CONTENT,
                text = payload.strOrNull("text") ?: "",
                index = payload.intOrNull("index"),
                sequence = sequence,
            )

            DONE -> StreamEvent.Done(
                TurnDone(
                    turnId = payload.textOrNull("turnId") ?: "",
                    conversationId = payload.textOrNull("conversationId"),
                    userMessageId = payload.textOrNull("userMessageId"),
                    assistantMessageId = payload.textOrNull("assistantMessageId"),
                    revision = payload.longOrNull("revision"),
                    duplicate = payload.boolOrNull("duplicate") ?: false,
                    message = payload.objOrNull("message")?.let { DtoCodec.message(it) },
                    stored = payload.boolOrNull("stored") ?: false,
                ),
            )

            ERROR -> StreamEvent.Failure(
                error = ProtocolError.Server(
                    code = payload.textOrNull("code") ?: ProtocolError.PROVIDER_ERROR,
                    message = payload.strOrNull("message") ?: "",
                    retryable = payload.boolOrNull("retryable") ?: false,
                    detail = payload.textOrNull("message"),
                ),
                sequence = sequence,
            )

            STREAM_ERROR -> StreamEvent.StreamProblem(
                error = ProtocolError.Server(
                    code = payload.textOrNull("code") ?: ProtocolError.REPLAY_GAP,
                    message = payload.strOrNull("detail") ?: "",
                    retryable = false,
                    detail = payload.textOrNull("hint"),
                ),
                resync = payload.boolOrNull("resync") ?: false,
            )

            else -> StreamEvent.Unknown(type)
        }
    }
}

/**
 * Duplicate / missing frame detection (Phase 18).
 *
 * Two rules, and the asymmetry between them is deliberate:
 *
 * * **duplicate** (`sequence <= lastSeen`) → drop the frame. Re-delivery is
 *   normal (a resumed stream legitimately replays what we already have) and is
 *   never an error.
 * * **gap** (`sequence > lastSeen + 1`) → the middle was lost; the caller must
 *   resume from [lastSeen]. Within a single connection this should not happen.
 *
 * The FIRST sequenced frame of a fresh connection is *adopted*, not judged. When
 * the client reconnects with `after=N`, the first frame it receives is legitimately
 * `N+1` or later — and the server states the gap itself with
 * `stream.error {code:'REPLAY_GAP'}`. Inferring a gap from that first frame would
 * turn every resume into a false alarm.
 */
class StreamSequenceTracker(initialSequence: Int = 0) {

    sealed class Decision {
        /** A control frame with no sequence; state untouched. */
        object Control : Decision()
        /** The first sequenced frame on this connection. */
        object Adopted : Decision()
        object Accepted : Decision()
        data class Duplicate(val sequence: Int) : Decision()
        data class Gap(val expected: Int, val got: Int) : Decision()
    }

    /** Highest sequence this client has accepted. Persisted with the attempt. */
    var lastSeen: Int = initialSequence
        private set

    private var adoptedOneOnThisConnection = false

    fun onFrame(sequence: Int?): Decision {
        if (sequence == null || sequence <= 0) return Decision.Control
        if (!adoptedOneOnThisConnection) {
            adoptedOneOnThisConnection = true
            if (sequence <= lastSeen) return Decision.Duplicate(sequence)
            lastSeen = sequence
            return Decision.Adopted
        }
        if (sequence <= lastSeen) return Decision.Duplicate(sequence)
        val expected = lastSeen + 1
        lastSeen = sequence
        return if (sequence == expected) Decision.Accepted else Decision.Gap(expected, sequence)
    }

    /** A new connection starts un-adopted but keeps [lastSeen]. */
    fun onConnectionOpened() {
        adoptedOneOnThisConnection = false
    }
}
