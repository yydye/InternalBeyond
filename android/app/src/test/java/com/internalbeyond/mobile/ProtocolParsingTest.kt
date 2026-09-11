package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.DeltaKind
import com.internalbeyond.mobile.data.api.DtoCodec
import com.internalbeyond.mobile.data.api.Envelope
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.api.PairingParse
import com.internalbeyond.mobile.data.api.PairingPayloadParser
import com.internalbeyond.mobile.data.api.SseParser
import com.internalbeyond.mobile.data.api.StreamEvent
import com.internalbeyond.mobile.data.api.StreamEventCodec
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.support.DtoFixtures
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit · protocol parsing (Phase 36).
 *
 * These are the parsers the whole app depends on and the ones most likely to be
 * "fixed" into leniency by accident, so the assertions are about REJECTION as much
 * as acceptance: a version that is `true`, a metadata key that is not on the
 * whitelist, a stream frame that is not JSON.
 */
class ProtocolParsingTest {

    // ── envelope ─────────────────────────────────────────────────────────────

    @Test
    fun `v1 success envelope yields its payload`() {
        val raw = """{"v":1,"ok":true,"type":"handshake","payload":{"protocol":1}}"""
        val parsed = Envelope.payload(raw, 200)
        assertTrue(parsed is ApiResult.Ok)
        assertEquals(1, (parsed as ApiResult.Ok).value.optInt("protocol"))
    }

    @Test
    fun `wrong response version is refused, not coerced`() {
        val parsed = Envelope.payload("""{"v":2,"ok":true,"payload":{}}""", 200)
        assertTrue(parsed is ApiResult.Err)
        val error = (parsed as ApiResult.Err).error
        assertTrue(error is ProtocolError.Response)
        assertTrue((error as ProtocolError.Response).detail.contains("protocol v2"))
    }

    @Test
    fun `boolean version is refused`() {
        // Number(true) == 1 in JavaScript, and a version field must be stricter
        // than "coercible to 1" — the Home Node enforces this too.
        val parsed = Envelope.payload("""{"v":true,"ok":true,"payload":{}}""", 200)
        assertTrue(parsed is ApiResult.Err)
    }

    @Test
    fun `error envelope keeps the closed-vocabulary code, detail and retryable`() {
        val raw = Envelope.failure("BUSY", "another turn", retryable = true, detail = "dm:x").toString()
        val parsed = Envelope.payload(raw, 409, retryAfterMs = 3000)
        val error = (parsed as ApiResult.Err).error as ProtocolError.Server
        assertEquals(ProtocolError.BUSY, error.code)
        assertEquals(409, error.httpStatus)
        assertTrue(error.retryable)
        assertEquals("dm:x", error.detail)
        assertEquals(3000L, error.retryAfterMs)
    }

    @Test
    fun `a non-JSON body is a Response error, not a crash`() {
        val parsed = Envelope.payload("<html>502</html>", 502)
        assertTrue(parsed is ApiResult.Err)
        assertTrue((parsed as ApiResult.Err).error is ProtocolError.Response)
    }

    @Test
    fun `the Home Node's pre-envelope refusals are named, not called unexpected`() {
        // services/home-node/http.js answers a non-loopback request with this shape,
        // BEFORE routing — so it applies to /mobile/v1/* and is the exact thing a
        // phone sees when LAN access is not enabled on the desktop.
        val refusal = Envelope.payload("""{"ok":false,"error":"loopback-only"}""", 403)
        assertTrue(refusal is ApiResult.Err)
        val error = (refusal as ApiResult.Err).error as ProtocolError.Server
        assertEquals(ProtocolError.LOOPBACK_ONLY, error.code)

        val presentation = com.internalbeyond.mobile.domain.ErrorPresenter.present(error)
        assertTrue(presentation.title.contains("only accepts connections from the desktop"))
        assertEquals(com.internalbeyond.mobile.domain.ErrorAction.DESKTOP_ACTION, presentation.action)

        // ...and an unknown slug still degrades to a Response error rather than a crash.
        val unknown = Envelope.payload("""{"ok":false,"error":"something-new"}""", 400)
        assertTrue((unknown as ApiResult.Err).error is ProtocolError.Response)
    }

    @Test
    fun `a v1 error envelope is never mistaken for a refusal slug`() {
        // The v1 `error` value is an OBJECT; a naive string read would match it.
        val parsed = Envelope.payload(
            Envelope.failure("BUSY", "another turn", retryable = true).toString(),
            409,
        )
        val error = (parsed as ApiResult.Err).error as ProtocolError.Server
        assertEquals(ProtocolError.BUSY, error.code)
        assertTrue(error.retryable)
    }

    @Test
    fun `an empty body with a failure status becomes a bare error`() {
        val error = Envelope.bareError(429, "too many requests")
        assertEquals(ProtocolError.RATE_LIMITED, error.code)
        assertTrue(error.retryable)
    }

    // ── SSE ──────────────────────────────────────────────────────────────────

    @Test
    fun `a frame split across chunks is reassembled`() {
        val parser = SseParser()
        assertTrue(parser.feed("event: chat.delta\nid: s:3\nda").isEmpty())
        val frames = parser.feed("ta: {\"type\":\"chat.delta\",\"sequence\":3}\n\n")
        assertEquals(1, frames.size)
        assertEquals("chat.delta", frames[0].event)
        assertEquals(3, frames[0].idSequence)
        assertTrue(frames[0].data!!.contains("chat.delta"))
    }

    @Test
    fun `comment heartbeats produce no frames`() {
        val parser = SseParser()
        assertTrue(parser.feed(": open\n\n").isEmpty())
        assertTrue(parser.feed(": ping 12345\n\n").isEmpty())
    }

    @Test
    fun `multiple frames in one chunk are all returned in order`() {
        val parser = SseParser()
        val chunk = "event: a\ndata: {\"n\":1}\n\nevent: b\ndata: {\"n\":2}\n\n"
        val frames = parser.feed(chunk)
        assertEquals(2, frames.size)
        assertEquals("a", frames[0].event)
        assertEquals("b", frames[1].event)
    }

    @Test
    fun `CRLF framing is accepted`() {
        val frames = SseParser().feed("event: a\r\ndata: {\"n\":1}\r\n\r\n")
        assertEquals(1, frames.size)
        assertEquals("a", frames[0].event)
    }

    @Test
    fun `an unterminated trailing frame is flushed at end of stream`() {
        val parser = SseParser()
        assertTrue(parser.feed("event: a\ndata: {\"n\":1}").isEmpty())
        assertEquals(1, parser.flush().size)
    }

    // ── stream events ────────────────────────────────────────────────────────

    @Test
    fun `reasoning and content share one delta type and differ by kind`() {
        val reasoning = StreamEventCodec.decode(
            SseParser.Frame(
                "chat.delta",
                "s:1",
                """{"type":"chat.delta","sequence":1,"payload":{"kind":"reasoning","text":"why"}}""",
            ),
        )
        val content = StreamEventCodec.decode(
            SseParser.Frame(
                "chat.delta",
                "s:2",
                """{"type":"chat.delta","sequence":2,"payload":{"kind":"content","text":"hi"}}""",
            ),
        )
        assertEquals(DeltaKind.REASONING, (reasoning as StreamEvent.Delta).kind)
        assertEquals(DeltaKind.CONTENT, (content as StreamEvent.Delta).kind)
    }

    @Test
    fun `a malformed data line is not a terminal state`() {
        val decoded = StreamEventCodec.decode(SseParser.Frame("chat.delta", "s:1", "not json"))
        assertTrue(decoded is StreamEvent.Unknown)
    }

    @Test
    fun `chat done carries the canonical message`() {
        val frame = SseParser.Frame(
            "chat.done",
            "s:9",
            """{"type":"chat.done","sequence":9,"payload":{"turnId":"t1","assistantMessageId":"m2",
               "revision":7,"duplicate":false,"stored":true,
               "message":{"id":"m2","role":"assistant","content":"hello","timestamp":1,"conversationId":"dm:a"}}}""",
        )
        val done = (StreamEventCodec.decode(frame) as StreamEvent.Done).done
        assertEquals("m2", done.assistantMessageId)
        assertEquals("hello", done.message!!.content)
        assertEquals(7L, done.revision)
    }

    @Test
    fun `stream error carries the resync hint`() {
        val frame = SseParser.Frame(
            "stream.error",
            null,
            """{"type":"stream.error","sequence":0,"payload":{"code":"REPLAY_GAP","detail":"gone","resync":true}}""",
        )
        val problem = (StreamEventCodec.decode(frame) as StreamEvent.StreamProblem)
        assertEquals(ProtocolError.REPLAY_GAP, problem.error.code)
        assertTrue(problem.resync)
    }

    // ── pairing payload ──────────────────────────────────────────────────────

    @Test
    fun `flat payload, envelope payload and wrapped-in-text all parse`() {
        val flat = DtoFixtures.pairingSessionPayload(23118).toString()
        val envelope = DtoFixtures.pairingEnvelope(23118).toString()
        val noisy = "here you go: " + flat + " — done"

        for (input in listOf(flat, envelope, noisy)) {
            val parsed = PairingPayloadParser.parse(input)
            assertTrue("expected Ok for $input", parsed is PairingParse.Ok)
            val payload = (parsed as PairingParse.Ok).payload
            assertEquals(DtoFixtures.PAIRING_ID, payload.pairingId)
            assertEquals(23118, payload.endpoint!!.port)
            assertEquals("/mobile/v1/pairing/complete", payload.pairPath)
        }
    }

    @Test
    fun `a payload with no version is accepted, a future version is not`() {
        val current = DtoFixtures.pairingSessionPayload(23118)
        assertTrue(PairingPayloadParser.parse(current.toString()) is PairingParse.Ok)

        val future = JSONObject(current.toString()).put("v", 2)
        val failed = PairingPayloadParser.parse(future.toString())
        assertTrue(failed is PairingParse.Fail)
        assertTrue((failed as PairingParse.Fail).title.contains("different protocol version"))
    }

    @Test
    fun `a truncated secret is rejected with an explanation, not a generic failure`() {
        val payload = DtoFixtures.pairingSessionPayload(23118).put("secret", "abc")
        val failed = PairingPayloadParser.parse(payload.toString())
        assertTrue(failed is PairingParse.Fail)
        assertTrue((failed as PairingParse.Fail).title.contains("truncated"))
    }

    @Test
    fun `a loopback-only node parses but reports no address, and explains itself`() {
        val payload = DtoFixtures.pairingSessionPayload(23118)
        payload.put("lanReachable", false)
        payload.getJSONObject("endpoints").put(
            "mobile",
            JSONObject().put("host", "").put("port", 23118).put("scheme", "http"),
        )
        // Parsing SUCCEEDS: the credential in the payload is perfectly good, and the
        // pairing screen's address override is the way out. Refusing here would make
        // that override unreachable in the one case it exists for.
        val parsed = PairingPayloadParser.parse(payload.toString())
        assertTrue(parsed is PairingParse.Ok)
        assertNull((parsed as PairingParse.Ok).payload.endpoint)

        val (title, detail) = PairingPayloadParser.missingAddressExplanation(lanReachable = false)
        assertTrue(title.contains("no network address"))
        assertTrue(detail.contains("IB_HOME_NODE_HOST"))
    }

    @Test
    fun `a payload with no endpoint field also parses, with a different explanation`() {
        val payload = DtoFixtures.pairingSessionPayload(23118)
        payload.remove("endpoints")
        val parsed = PairingPayloadParser.parse(payload.toString())
        assertTrue(parsed is PairingParse.Ok)
        assertNull((parsed as PairingParse.Ok).payload.endpoint)
        val (title, _) = PairingPayloadParser.missingAddressExplanation(lanReachable = true)
        assertTrue(title.contains("no address"))
    }

    @Test
    fun `garbage is rejected without throwing`() {
        for (input in listOf("", "   ", "hello", "{", "[]")) {
            assertTrue(PairingPayloadParser.parse(input) is PairingParse.Fail)
        }
    }

    // ── endpoints ────────────────────────────────────────────────────────────

    @Test
    fun `address overrides accept host, host-port, scheme-url and IPv6`() {
        assertEquals(
            HomeNodeEndpoint("http", "192.168.10.7", 23118),
            HomeNodeEndpoint.parseOverride("192.168.10.7", "http"),
        )
        assertEquals(
            HomeNodeEndpoint("http", "192.168.10.7", 9999),
            HomeNodeEndpoint.parseOverride("192.168.10.7:9999", "http"),
        )
        assertEquals(
            HomeNodeEndpoint("https", "node.local", 8443),
            HomeNodeEndpoint.parseOverride("https://node.local:8443/", "http"),
        )
        assertEquals(
            HomeNodeEndpoint("http", "::1", 23118),
            HomeNodeEndpoint.parseOverride("[::1]", "http"),
        )
        assertNull(HomeNodeEndpoint.parseOverride("not a host:port:extra", "http"))
        assertNull(HomeNodeEndpoint.parseOverride("", "http"))
    }

    @Test
    fun `the transport label never claims encryption without TLS`() {
        val plain = HomeNodeEndpoint("http", "192.168.1.5", 23118)
        assertFalse(
            "a cleartext link must not be described as encrypted",
            plain.transportLabel.contains("Encrypted connection"),
        )
        assertTrue(plain.transportLabel.contains("not encrypted"))

        val tls = HomeNodeEndpoint("https", "node.example", 443)
        assertTrue(tls.transportLabel.contains("Encrypted connection"))
    }

    // ── DTOs ─────────────────────────────────────────────────────────────────

    @Test
    fun `a message DTO round-trips through JSON without losing fields`() {
        val raw = DtoFixtures.assistantMessage("hi")
            .put("images", org.json.JSONArray().put(JSONObject().put("mime", "image/png").put("inline", true)))
            .put("truncated", true)
        val message = DtoCodec.message(raw)
        val again = DtoCodec.message(DtoCodec.messageToJson(message))
        assertEquals(message, again)
        assertTrue(again.hasAttachments)
        assertTrue(again.truncated)
    }

    @Test
    fun `unknown metadata keys are dropped and whitelisted ones kept`() {
        val raw = DtoFixtures.assistantMessage("hi").put(
            "metadata",
            JSONObject()
                .put("model_id", "mock-model")
                .put("source", "mobile-gateway")
                .put("futureSecret", "sk-should-not-survive"),
        )
        val message = DtoCodec.message(raw)
        assertEquals("mock-model", message.metadata["model_id"])
        assertEquals("mobile-gateway", message.metadata["source"])
        assertNull(message.metadata["futureSecret"])
    }

    @Test
    fun `runtime-only fields are not modelled at all`() {
        val raw = DtoFixtures.assistantMessage("hi")
            .put("reasoning_content", "hidden")
            .put("wsSearches", org.json.JSONArray())
            .put("memOps", org.json.JSONArray())
        val json = DtoCodec.messageToJson(DtoCodec.message(raw)).toString()
        assertFalse(json.contains("reasoning_content"))
        assertFalse(json.contains("wsSearches"))
        assertFalse(json.contains("memOps"))
    }

    @Test
    fun `character DTO falls back to the model name and defaults capabilities`() {
        val raw = JSONObject().put("id", "c1").put("model", "some-model")
        val character = DtoCodec.character(raw)
        assertEquals("some-model", character.name)
        assertTrue(character.capabilities.chat)
        assertFalse(character.capabilities.vision)
        assertEquals("S", DtoCodec.character(JSONObject().put("id", "c").put("name", "sora")).initial)
    }

    @Test
    fun `no character field can carry a credential, because none is modelled`() {
        val raw = DtoFixtures.character()
            .put("apiKey", "sk-SECRET")
            .put("endpoint", "http://127.0.0.1:9/v1")
            .put("systemPrompt", "HIDDEN")
        val json = DtoCodec.characterToJson(DtoCodec.character(raw)).toString()
        assertFalse(json.contains("sk-SECRET"))
        assertFalse(json.contains("HIDDEN"))
        assertFalse(json.contains("127.0.0.1"))
        assertNotNull(DtoCodec.character(raw).id)
    }

    @Test
    fun `history pagination anchors are read from objects or bare ids`() {
        val payload = JSONObject()
            .put("conversationId", "dm:a")
            .put("messages", org.json.JSONArray().put(DtoFixtures.userMessage("hi")))
            .put("count", 1)
            .put("oldest", JSONObject().put("id", "msg_old").put("timestamp", 1))
            .put("cursor", "msg_new")
            .put("hasOlder", true)
            .put("hasMore", true)
        val page = DtoCodec.historyPage(payload)
        assertEquals("msg_old", page.oldest)
        assertEquals("msg_new", page.cursor)
        assertEquals("msg_old", page.olderAnchor)
        assertTrue(page.hasOlder)
    }
}
