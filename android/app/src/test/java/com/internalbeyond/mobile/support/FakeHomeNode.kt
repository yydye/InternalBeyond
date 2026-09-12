package com.internalbeyond.mobile.support

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger

/**
 * A scriptable stand-in for the Home Node's mobile surface, in-process.
 *
 * The real Home Node is used by [com.internalbeyond.mobile.HomeNodeIntegrationTest];
 * this fake exists because some protocol situations cannot be produced on demand
 * from a healthy server — a stream that ends without a terminal frame, a frame gap,
 * `turns.get` returning `NOT_FOUND`, and `DEVICE_REVOKED` on the very next request.
 * Those are exactly the paths M1-C's recovery logic lives in, so they are asserted
 * deterministically rather than hoped for.
 *
 * It speaks the real wire format (v1 envelope, `text/event-stream` frames), so the
 * production client and repository run unmodified.
 */
class FakeHomeNode {

    @Volatile
    var revokeNextRequest: Boolean = false

    @Volatile
    var authInvalid: Boolean = false

    /** When set, `turns.get` answers NOT_FOUND even for a known turn. */
    @Volatile
    var hideTurns: Boolean = false

    /**
     * Content deltas emitted before the stream simply ends, with NO terminal frame.
     * This is what a dropped connection looks like from the reader's side, and it is
     * precisely the case that must never be reported as a failure.
     */
    @Volatile
    var cutStreamAfterDeltas: Int? = null

    /**
     * Reasoning deltas emitted before the content deltas start.
     *
     * Reasoning and content are the same frame type on the wire, distinguished only by
     * `kind` — there is no separate reasoning protocol — so this is the whole of what a
     * reasoning-capable provider looks like from the device's side.
     */
    @Volatile
    var reasoningText: String = ""

    /**
     * Cut the stream after the reasoning frame and before any answer text: a
     * connection lost while the model was still thinking. Counted separately from
     * [cutStreamAfterDeltas] so the existing recovery tests keep cutting where their
     * own comments say they do.
     */
    @Volatile
    var cutStreamAfterReasoning: Boolean = false

    /**
     * Hold the stream open after the reasoning frame until [releaseStream].
     *
     * The only way to observe the mid-stream state from a test: `send()` returns as
     * soon as the request is queued, and without this the whole turn — including
     * `chat.done` — is written before the first assertion runs.
     */
    @Volatile
    var pauseStreamAfterReasoning: Boolean = false

    private val streamGate = java.util.concurrent.CountDownLatch(1)

    /** Let a [pauseStreamAfterReasoning] stream finish. Safe to call when unused. */
    fun releaseStream() {
        streamGate.countDown()
    }

    /**
     * How many streams to cut. One by default: a network blip happens once, and a
     * client that re-sends the same requestId should then succeed. Raise it to test
     * the exhausted-recovery path.
     */
    @Volatile
    var cutStreamTimes: Int = 1

    private val cutsDone = AtomicInteger(0)

    /** Sequence numbers to emit for specific content deltas; lets a test force a gap. */
    @Volatile
    var forcedDeltaSequences: Map<Int, Int> = emptyMap()

    /**
     * The canonical id `chat.done` names for the next turn.
     *
     * Mutable so a test can drive TWO consecutive real turns: the Home Node issues a
     * fresh id per turn, and a test that reused one id would be asserting that two
     * turns share a canonical message, which the server never does.
     */
    @Volatile
    var assistantMessageId: String = "msg_a1"

    /**
     * `metadata.showThinking` on the row history serves, when the test sets it.
     *
     * `null` omits the key entirely, which is what most providers do and what makes
     * "absent means unknown, so show it" the behaviour under test.
     */
    @Volatile
    var historyShowThinking: String? = null

    /**
     * Allow `/chat/history` to answer with the turn that has already finished.
     *
     * A real Home Node's history is the canonical store, so after a completed turn it
     * necessarily contains that turn's row. The fake cannot know which id a test
     * considers "already there" without being told, so this stays off by default and
     * the restart tests turn it on — which is the whole point of a restart test.
     */
    @Volatile
    var serveCompletedTurnInHistory: Boolean = false

    /** True once any turn has settled with `chat.done`. */
    @Volatile
    var completedTurns: Int = 0

    @Volatile
    var turnStatus: String = "running"

    val chatSendCount = AtomicInteger(0)
    val chatStreamOpenCount = AtomicInteger(0)
    val turnsGetCount = AtomicInteger(0)
    val lastSendRequestBody: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
    val lastStreamAfter: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())

    private val server = MockWebServer()

    fun start(): FakeHomeNode {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = respond(request)
        }
        server.start()
        return this
    }

    val port: Int get() = server.port

    val baseUrl: String get() = "http://127.0.0.1:${server.port}"

    fun stop() {
        runCatching { server.shutdown() }
    }

    private fun respond(request: RecordedRequest): MockResponse {
        val target = request.path ?: "/"
        val body = request.body.readUtf8()
        val authed = request.getHeader("Authorization") != null

        if (revokeNextRequest) {
            revokeNextRequest = false
            return errorResponse(403, "DEVICE_REVOKED")
        }
        if (authInvalid) return errorResponse(401, "AUTH_INVALID")
        if (!target.endsWith("/pairing/complete") && !authed) return errorResponse(401, "AUTH_REQUIRED")

        return when {
            target.endsWith("/pairing/complete") -> jsonResponse(envelope("pairing.complete", pairingPayload()))

            target.endsWith("/handshake") -> jsonResponse(
                envelope(
                    "handshake",
                    JSONObject()
                        .put("dtoVersion", 1)
                        .put("protocol", 1)
                        .put("serverVersion", "fake-1.0")
                        .put("fingerprint", DtoFixtures.NODE_FINGERPRINT)
                        .put("sync", JSONObject().put("cursorModel", "home-node-revision")),
                ),
            )

            target.endsWith("/character/list") -> jsonResponse(
                envelope(
                    "character.list",
                    JSONObject()
                        .put("count", 1)
                        .put("characters", JSONArray().put(DtoFixtures.character())),
                ),
            )

            target.contains("/chat/history") -> jsonResponse(
                envelope(
                    "chat.history",
                    JSONObject()
                        .put("conversationId", DtoFixtures.CONVERSATION)
                        .put("messages", JSONArray().put(historyMessage()))
                        .put("count", 1)
                        .put("oldest", JSONObject().put("id", "msg_a1").put("timestamp", DtoFixtures.TIMESTAMP))
                        .put("cursor", JSONObject().put("id", "msg_a1").put("timestamp", DtoFixtures.TIMESTAMP))
                        .put("hasMore", false)
                        .put("hasOlder", false)
                        .put("hasNewer", false)
                        .put("revision", 5),
                ),
            )

            target.contains("/sync/changes") -> jsonResponse(
                envelope(
                    "sync.changes",
                    JSONObject()
                        .put("cursor", 9)
                        .put("revision", 9)
                        .put("upserts", JSONArray())
                        .put("deletes", JSONArray())
                        .put("hasMore", false)
                        .put("serverTime", DtoFixtures.TIMESTAMP),
                ),
            )

            target.contains("/turns/") -> {
                turnsGetCount.incrementAndGet()
                if (hideTurns) errorResponse(404, "NOT_FOUND", "unknown turn")
                else jsonResponse(envelope("turn.status", turnStatusPayload()))
            }

            target.endsWith("/device/revoke") -> jsonResponse(envelope("device.revoked", JSONObject()))

            target.contains("/chat/stream/") -> {
                chatStreamOpenCount.incrementAndGet()
                lastStreamAfter.add(target.substringAfter('?', ""))
                streamResponse()
            }

            target.endsWith("/chat/send") -> {
                chatSendCount.incrementAndGet()
                lastSendRequestBody.add(body)
                if (request.getHeader("Accept")?.contains("text/event-stream") == true) {
                    streamResponse()
                } else {
                    jsonResponse(
                        envelope(
                            "chat.send",
                            JSONObject()
                                .put("turnId", DtoFixtures.TURN_ID)
                                .put("streamUrl", "/mobile/v1/chat/stream/${DtoFixtures.TURN_ID}")
                                .put("disconnectPolicy", "generation-continues"),
                        ),
                    )
                }
            }

            else -> errorResponse(404, "UNKNOWN_VERB")
        }
    }

    /**
     * The one row `/chat/history` serves.
     *
     * An id that has never settled in this fake answers "canonical", the placeholder
     * the pre-M1-C tests were written against; once a turn has settled, or when a test
     * says so explicitly, the row served is that turn's own — including the reasoning
     * the executor really stores on it and the mobile DTO really strips.
     */
    private fun historyMessage(): JSONObject {
        val settled = completedTurns > 0 || serveCompletedTurnInHistory
        if (!settled) return DtoFixtures.assistantMessage("canonical")
        val json = DtoFixtures.assistantMessage("ABC", id = assistantMessageId, showThinking = historyShowThinking)
        /* The Home Node's store holds reasoning on the assistant row. It is served here
           so the device's projection can be shown to drop it, rather than assumed to. */
        json.put("reasoning_content", "THINK")
        return json
    }

    /**
     * The whole turn as one SSE body. When [cutStreamAfterDeltas] is set the body
     * simply stops early and its Content-Length matches what was sent, so the client
     * observes a clean end-of-stream with no terminal frame — the same thing a lost
     * connection produces.
     */
    private fun streamResponse(): MockResponse {
        val out = StringBuilder()
        out.append(": open\n\n")
        var sequence = 1
        fun frame(type: String, payload: JSONObject) {
            out.append("event: ").append(type).append('\n')
            out.append("id: s:").append(sequence).append('\n')
            out.append("data: ")
                .append(JSONObject().put("type", type).put("sequence", sequence).put("payload", payload))
                .append("\n\n")
            sequence++
        }

        frame("chat.start", turnStatusPayload())
        val cutAfter = cutStreamAfterDeltas
        // A network blip happens once: after [cutStreamTimes] cuts the same requestId
        // must be able to succeed, which is the whole point of the protocol's
        // idempotency. Raise it to exercise the exhausted-recovery path.
        val shouldCut = cutAfter != null && cutsDone.getAndIncrement() < cutStreamTimes
        if (cutAfter != null && !shouldCut) cutsDone.decrementAndGet()

        /* The real Home Node has no separate reasoning frame: reasoning and content
           share `chat.delta` and differ only by `kind` (mobile-gateway.js:596), and a
           reasoning-capable provider's thinking precedes its answer. [reasoningText]
           therefore rides as the FIRST delta, before the content deltas.

           It does NOT count toward [cutStreamAfterDeltas]. That knob is documented as
           "content deltas before the stream simply ends", and the recovery tests that
           use it assert on the accumulated answer ("ABC") — counting an extra frame
           would silently move where they cut. [cutStreamAfterReasoning] exists for the
           mid-thinking case instead. */
        if (reasoningText.isNotEmpty()) {
            frame("chat.delta", JSONObject().put("kind", "reasoning").put("text", reasoningText).put("index", 0))
            if (pauseStreamAfterReasoning) {
                runCatching { streamGate.await(10, java.util.concurrent.TimeUnit.SECONDS) }
            }
            if (cutStreamAfterReasoning && cutsDone.getAndIncrement() < cutStreamTimes) {
                return sseResponse(out.toString())
            }
        }

        val texts = listOf("A", "B", "C")
        var emitted = 0
        for ((index, text) in texts.withIndex()) {
            forcedDeltaSequences[index]?.let { sequence = it }
            frame("chat.delta", JSONObject().put("kind", "content").put("text", text).put("index", index))
            emitted++
            if (shouldCut && emitted >= cutAfter!!) {
                return sseResponse(out.toString())
            }
        }
        if (turnStatus == "running") {
            frame(
                "chat.done",
                JSONObject()
                    .put("turnId", DtoFixtures.TURN_ID)
                    .put("conversationId", DtoFixtures.CONVERSATION)
                    .put("userMessageId", DtoFixtures.USER_MESSAGE_ID)
                    .put("assistantMessageId", assistantMessageId)
                    .put("revision", 7)
                    .put("duplicate", false)
                    .put("stored", true)
                    .put("message", DtoFixtures.assistantMessage("ABC", id = assistantMessageId)),
            )
            completedTurns++
        }
        return sseResponse(out.toString())
    }

    private fun turnStatusPayload(): JSONObject = JSONObject()
        .put("turnId", DtoFixtures.TURN_ID)
        .put("requestId", DtoFixtures.REQUEST_ID)
        .put("conversationId", DtoFixtures.CONVERSATION)
        .put("characterId", DtoFixtures.CHARACTER_ID)
        .put("status", turnStatus)
        .put("sequence", 4)
        .put("userMessageId", DtoFixtures.USER_MESSAGE_ID)
        .put("assistantMessageId", assistantMessageId)
        .put("revision", 7)
        .put("duplicate", false)
        .put("replayFrom", 1)
        .put("replayTo", 4)

    private fun pairingPayload(): JSONObject = JSONObject()
        .put("device", DtoFixtures.device())
        .put("token", DtoFixtures.TOKEN)
        .put("tokenType", "Bearer")
        .put(
            "profile",
            JSONObject()
                .put("protocol", 1)
                .put("serverVersion", "fake-1.0")
                .put("fingerprint", DtoFixtures.NODE_FINGERPRINT)
                .put("dtoVersion", 1),
        )

    private fun envelope(type: String, payload: JSONObject): String = JSONObject()
        .put("v", 1)
        .put("ok", true)
        .put("type", type)
        .put("requestId", JSONObject.NULL)
        .put("serverTime", DtoFixtures.TIMESTAMP)
        .put("payload", payload)
        .toString()

    private fun errorResponse(status: Int, code: String, detail: String? = null): MockResponse {
        val error = JSONObject().put("code", code).put("message", code.lowercase()).put("retryable", false)
        if (detail != null) error.put("detail", detail)
        val body = JSONObject()
            .put("v", 1)
            .put("ok", false)
            .put("type", "error")
            .put("serverTime", DtoFixtures.TIMESTAMP)
            .put("error", error)
            .toString()
        return MockResponse()
            .setResponseCode(status)
            .setHeader("Content-Type", "application/json; charset=utf-8")
            .setBody(body)
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .setBody(body)

    private fun sseResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "text/event-stream; charset=utf-8")
        .setBody(body)
}
