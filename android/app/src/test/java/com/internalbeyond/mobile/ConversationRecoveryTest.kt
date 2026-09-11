package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.support.DtoFixtures
import com.internalbeyond.mobile.support.FakeHomeNode
import com.internalbeyond.mobile.support.JdbcSqlDatabase
import com.internalbeyond.mobile.support.TestRig
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Unit/Integration · send, stream interruption, resume and restart (Phase 19/20/21).
 *
 * The situations here are the ones a healthy server cannot be asked to produce on
 * demand: a connection severed mid-generation, a frame gap, a turn the Home Node no
 * longer remembers, and a device revoked on the next request. Each is scripted
 * against [FakeHomeNode], which speaks the real wire format, so the production
 * client and the production repository run unmodified.
 */
class ConversationRecoveryTest {

    private lateinit var fake: FakeHomeNode
    private lateinit var rig: TestRig
    private lateinit var dbPath: String

    @Before
    fun setUp() {
        fake = FakeHomeNode().start()
        dbPath = Files.createTempFile("ib-recovery-", ".db").toString()
        rig = TestRig(dbPath, fake = fake)
        CacheSchema.create(rig.db)
    }

    @After
    fun tearDown() {
        runCatching { rig.close() }
        runCatching { fake.stop() }
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
    }

    private fun stateOf(requestId: String): AttemptState =
        rig.cache.attempt(requestId)?.state ?: error("attempt $requestId is missing")

    // ── the happy path ───────────────────────────────────────────────────────

    @Test
    fun `a normal send streams to done and caches the canonical message`() = runBlocking {
        val session = rig.session()
        val error = session.sendAndAwait("hello")
        assertNull(error)

        val attempt = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.DONE, attempt.state)
        assertEquals(DtoFixtures.TURN_ID, attempt.turnId)
        assertEquals("msg_a1", attempt.assistantMessageId)
        assertTrue("content deltas must have been consumed", attempt.partialText.contains("ABC"))

        // The canonical row (from chat.done) is what the UI renders, not the partial.
        val canonical = rig.cache.message("msg_a1")
        assertNotNull(canonical)
        assertEquals("ABC", canonical!!.content)

        // The optimistic overlay keeps the user's own bubble until the CANONICAL user
        // row is in the cache — otherwise their text would blink out between the
        // stream finishing and the next sync landing.
        val overlay = session.state.value.overlay.single()
        assertEquals(AttemptState.DONE, overlay.state)
        rig.cache.upsertMessages(
            listOf(
                com.internalbeyond.mobile.domain.model.ChatMessage(
                    id = overlay.userMessageId!!,
                    role = "user",
                    content = "hello",
                    timestamp = DtoFixtures.TIMESTAMP,
                    conversationId = DtoFixtures.CONVERSATION,
                ),
            ),
        )
        session.refreshNewest()
        assertTrue("once the canonical row exists the overlay is gone", session.state.value.overlay.isEmpty())
    }

    @Test
    fun `the send body carries a requestId and the character id, never a message id`() {
        runBlocking { rig.session().sendAndAwait("hello") }
        val body = fake.lastSendRequestBody.single()
        assertTrue(body.contains("\"requestId\""))
        assertTrue(body.contains(DtoFixtures.CHARACTER_ID))
        assertFalse("the client must not choose a canonical message id", body.contains(USER_ID))
    }

    // ── interruption ─────────────────────────────────────────────────────────

    @Test
    fun `a severed stream becomes RECOVERING and resumes rather than failing`() = runBlocking {
        fake.cutStreamAfterDeltas = 1
        val session = rig.session()
        val error = session.sendAndAwait("hello")
        assertNull("a dropped connection is not a failed message", error)

        val attempt = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.DONE, attempt.state)
        assertEquals("ABC", rig.cache.message("msg_a1")!!.content)
        assertTrue("the stream must have been reopened", fake.chatStreamOpenCount.get() >= 1)
    }

    @Test
    fun `never once is an interrupted send marked FAILED`() = runBlocking {
        fake.cutStreamAfterDeltas = 1
        val session = rig.session()
        val requestId = session.send("hello")

        // Give the send a moment to get past its first interruption.
        Thread.sleep(400)
        val during = rig.cache.attempt(requestId)
        assertNotNull(during)
        assertFalse(
            "an unknown outcome must never be reported as a failure (Phase 19)",
            during!!.state == AttemptState.FAILED,
        )

        session.resumeOpenAttemptsNow()
        assertEquals(AttemptState.DONE, rig.cache.attempt(requestId)!!.state)
    }

    @Test
    fun `a frame gap reconnects from the last accepted sequence`() = runBlocking {
        // The third content delta jumps from 4 to 9 with no frames in between.
        fake.forcedDeltaSequences = mapOf(2 to 9)
        val session = rig.session()
        session.sendAndAwait("hello")

        assertTrue(fake.chatStreamOpenCount.get() >= 1)
        assertTrue(
            "the reconnect must ask for frames after the gap: ${fake.lastStreamAfter}",
            fake.lastStreamAfter.any { it.contains("after=9") },
        )
        assertEquals(AttemptState.DONE, rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single().state)
    }

    // ── the Home Node has forgotten the turn ─────────────────────────────────

    @Test
    fun `when the turn is unknown the SAME requestId is re-sent`() = runBlocking {
        fake.cutStreamAfterDeltas = 1
        fake.hideTurns = true
        val session = rig.session()
        session.sendAndAwait("hello")

        assertEquals("the request was re-sent exactly once", 2, fake.chatSendCount.get())
        val requestIds = fake.lastSendRequestBody.map { extractRequestId(it) }
        assertEquals(requestIds[0], requestIds[1])
        assertEquals(AttemptState.DONE, rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single().state)
    }

    // ── restart ──────────────────────────────────────────────────────────────

    @Test
    fun `an attempt left behind by a killed process is resumed, not failed`() = runBlocking {
        // Simulate a process that died mid-stream: the attempt row is on disk with a
        // known turn and position, and nothing is running.
        val requestId = "req_survivor_0001"
        rig.cache.saveAttempt(
            SendAttempt(
                requestId = requestId,
                characterId = DtoFixtures.CHARACTER_ID,
                conversationId = DtoFixtures.CONVERSATION,
                content = "hello",
                state = AttemptState.RUNNING,
                turnId = DtoFixtures.TURN_ID,
                lastSequence = 2,
                partialText = "AB",
                createdAt = DtoFixtures.TIMESTAMP,
                updatedAt = DtoFixtures.TIMESTAMP,
            ),
        )
        rig.close()

        // A new process: new database handle, new cache, new client, same file.
        val restarted = TestRig(dbPath, fake = fake)
        try {
            val session = restarted.session()
            session.resumeOpenAttemptsNow()

            val attempt = restarted.cache.attempt(requestId)
            assertNotNull("the requestId must survive the restart", attempt)
            assertEquals(AttemptState.DONE, attempt!!.state)
            assertEquals("ABC", restarted.cache.message("msg_a1")!!.content)
        } finally {
            restarted.close()
            // tearDown closes rig again; make it harmless.
            rig = restarted
        }
    }

    @Test
    fun `a restart with no turn id re-sends the stored requestId`() = runBlocking {
        val requestId = "req_survivor_0002"
        rig.cache.saveAttempt(
            SendAttempt(
                requestId = requestId,
                characterId = DtoFixtures.CHARACTER_ID,
                conversationId = "",
                content = "hello",
                state = AttemptState.PENDING,
                createdAt = DtoFixtures.TIMESTAMP,
                updatedAt = DtoFixtures.TIMESTAMP,
            ),
        )
        rig.session().resumeOpenAttemptsNow()

        assertEquals(1, fake.chatSendCount.get())
        assertEquals(requestId, extractRequestId(fake.lastSendRequestBody.single()))
        assertEquals(AttemptState.DONE, rig.cache.attempt(requestId)!!.state)
    }

    // ── revocation ───────────────────────────────────────────────────────────

    @Test
    fun `DEVICE_REVOKED on a send ends the attempt and reaches the session`() = runBlocking {
        fake.revokeNextRequest = true
        val error = rig.session().sendAndAwait("hello")

        assertNotNull(error)
        assertEquals(ProtocolError.DEVICE_REVOKED, error!!.code)
        assertTrue(error.isAuthFatal)
        assertEquals(AttemptState.FAILED, rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single().state)
        assertTrue(
            "a revoked device must be reported to the session so the token is deleted",
            rig.failureSink.any { it.code == ProtocolError.DEVICE_REVOKED },
        )
    }

    @Test
    fun `AUTH_INVALID on a send is treated as fatal too`() = runBlocking {
        fake.authInvalid = true
        val error = rig.session().sendAndAwait("hello")
        assertEquals(ProtocolError.AUTH_INVALID, error!!.code)
        assertTrue(rig.failureSink.any { it.code == ProtocolError.AUTH_INVALID })
    }

    // ── retry semantics ──────────────────────────────────────────────────────

    @Test
    fun `send again after a terminal failure uses a NEW requestId`() = runBlocking {
        fake.revokeNextRequest = true
        val session = rig.session()
        session.sendAndAwait("hello")
        val failed = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.FAILED, failed.state)

        fake.revokeNextRequest = false
        fake.authInvalid = false
        val error = session.sendAgainAndAwait(failed.requestId)
        assertNull(error)

        val attempts = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID)
        assertEquals(2, attempts.size)
        val requestIds = attempts.map { it.requestId }.toSet()
        assertEquals(
            "the protocol's idempotency ends at a terminal frame, so a real retry is a new request",
            2,
            requestIds.size,
        )
    }

    private fun extractRequestId(body: String): String =
        org.json.JSONObject(body).optString("requestId", "")

    private companion object {
        /** The canonical user message id is derived by the SERVER; the client must not send one. */
        const val USER_ID = DtoFixtures.USER_MESSAGE_ID
    }
}
