package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.domain.AttemptOverlay
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.support.DtoFixtures
import com.internalbeyond.mobile.support.FakeHomeNode
import com.internalbeyond.mobile.support.TestRig
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Regression · one user request must render exactly ONE assistant bubble (M1-C.2f).
 *
 * Observed on a physical device: a single send at 16:45 to 弗洛洛 produced two
 * visually identical reply bubbles. The canonical Home Node store held exactly one
 * assistant row (`msg_<ts>_<n>`, revision 256) and the Android cache held exactly
 * one row with that same id — so nothing was duplicated on disk or on the server.
 * The second bubble was the overlay re-drawing the reply it had streamed.
 *
 * The reason it could persist is an asymmetry between two channels:
 *
 *  * the canonical ASSISTANT row is written by `chat.done`, which carries both the
 *    canonical id and the stored message, so it is in the cache the instant the turn
 *    ends;
 *  * the canonical USER row arrives only from `sync.changes`, which does not run as
 *    part of a send, and whose cursor can still sit below the turn's revisions.
 *
 * The overlay's own exit rule was keyed on the USER row. So the overlay outlived the
 * canonical reply and drew it again — with the streamed copy in `partialText` being
 * byte-for-byte the final reply, because the whole reply had been streamed.
 *
 * The invariant these tests pin down: the optimistic overlay may exist, but it must
 * never be a SECOND copy of a message canonical storage already holds. Identity is
 * the canonical message id — never the text, because [DtoFixtures] aside, two
 * legitimate replies really can be identical (the audit found 32 such rows in
 * `dm:ci_friend`).
 */
class AssistantBubbleRenderingTest {

    private lateinit var fake: FakeHomeNode
    private lateinit var rig: TestRig
    private lateinit var dbPath: String

    @Before
    fun setUp() {
        fake = FakeHomeNode().start()
        dbPath = Files.createTempFile("ib-dup-audit-", ".db").toString()
        rig = TestRig(dbPath, fake = fake)
        CacheSchema.create(rig.db)
    }

    @After
    fun tearDown() {
        runCatching { rig.close() }
        runCatching { fake.stop() }
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun canonical(id: String, role: String, content: String): ChatMessage = ChatMessage(
        id = id,
        role = role,
        content = content,
        timestamp = DtoFixtures.TIMESTAMP,
        conversationId = DtoFixtures.CONVERSATION,
    )

    /** What the chat list actually renders, as the number of reply bubbles. */
    private fun renderedAssistantBubbles(session: com.internalbeyond.mobile.data.repository.ConversationSession): Int {
        val state = session.state.value
        val ids = state.messages.mapTo(HashSet()) { it.id }
        val fromCanonical = state.messages.count { it.role == "assistant" }
        val fromOverlay = state.overlay.count { attempt ->
            AttemptOverlay.showsAssistantBubble(attempt, ids) &&
                (attempt.partialText.isNotEmpty() ||
                    attempt.state == AttemptState.RUNNING ||
                    attempt.state == AttemptState.PENDING)
        }
        return fromCanonical + fromOverlay
    }

    private fun attempt(state: AttemptState, assistantId: String?, userMessageId: String? = null) = SendAttempt(
        requestId = "r1",
        characterId = DtoFixtures.CHARACTER_ID,
        conversationId = DtoFixtures.CONVERSATION,
        content = "hello",
        state = state,
        assistantMessageId = assistantId,
        userMessageId = userMessageId,
        partialText = "ABC",
    )

    // ── the pure rule ────────────────────────────────────────────────────────

    @Test
    fun `a streamed reply whose canonical message is cached is not drawn again`() {
        val done = attempt(AttemptState.DONE, assistantId = "msg_a1", userMessageId = "msg_u1")
        assertFalse(
            "the canonical row IS this reply; drawing partialText too is the duplicate",
            AttemptOverlay.showsAssistantBubble(done, setOf("msg_a1")),
        )
    }

    @Test
    fun `a streamed reply with no canonical message yet is drawn`() {
        val running = attempt(AttemptState.RUNNING, assistantId = null)
        assertTrue(AttemptOverlay.showsAssistantBubble(running, emptySet()))
        // An id we have been told about, but whose row has not landed, is NOT proof
        // that the reply is missing — it is proof we have not seen it yet.
        val named = attempt(AttemptState.RUNNING, assistantId = "msg_a1")
        assertTrue(AttemptOverlay.showsAssistantBubble(named, emptySet()))
    }

    @Test
    fun `an empty assistant id never suppresses a bubble`() {
        val done = attempt(AttemptState.DONE, assistantId = "")
        assertTrue(AttemptOverlay.showsAssistantBubble(done, setOf("")))
    }

    @Test
    fun `suppression matches the id, not the text`() {
        // Two DIFFERENT messages may carry identical text. A reply whose canonical row
        // is a different id is a different message and must still be drawn.
        val done = attempt(AttemptState.DONE, assistantId = "msg_b2")
        assertEquals("the fixture text is deliberately identical", "ABC", done.partialText)
        assertTrue(
            "an identical-looking but differently-identified reply must not be hidden",
            AttemptOverlay.showsAssistantBubble(done, setOf("msg_a1")),
        )
    }

    // ── A. SSE done → canonical sync ─────────────────────────────────────────

    @Test
    fun `A - done before sync renders one bubble even though the user row has not synced`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        session.refreshNewest()

        // The canonical assistant row is here; the canonical user row is not (no sync).
        assertTrue(
            "the canonical reply must be cached by chat.done",
            rig.cache.message("msg_a1") != null,
        )
        assertEquals("exactly one reply bubble", 1, renderedAssistantBubbles(session))
    }

    // ── B. canonical sync → SSE done ─────────────────────────────────────────

    @Test
    fun `B - sync landing before done still renders one bubble`() = runBlocking {
        val session = rig.session()
        // Canonical truth is already cached for this id before the turn settles.
        rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC")))
        session.sendAndAwait("hello")
        session.refreshNewest()
        assertEquals("exactly one reply bubble", 1, renderedAssistantBubbles(session))
    }

    // ── C. sync during active streaming ──────────────────────────────────────

    @Test
    fun `C - a sync applied mid-stream does not add a bubble`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC")))
        session.refreshNewest()
        assertEquals("exactly one reply bubble", 1, renderedAssistantBubbles(session))
    }

    // ── D. reconnect after a partial stream ──────────────────────────────────

    @Test
    fun `D - a turn resumed after a cut still renders one bubble`() = runBlocking {
        fake.cutStreamAfterDeltas = 1
        val session = rig.session()
        session.sendAndAwait("hello")
        session.refreshNewest()

        val record = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.DONE, record.state)
        assertTrue("the streamed reply is retained as the overlay's copy", record.partialText.isNotEmpty())
        assertEquals("exactly one reply bubble", 1, renderedAssistantBubbles(session))
    }

    // ── E. app restart after a completed turn ────────────────────────────────

    @Test
    fun `E - after a restart the reply is drawn once`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        assertEquals(1, renderedAssistantBubbles(session))

        // A restart re-reads durable storage and re-runs sync, which is what finally
        // delivers the canonical user row.
        val restarted = rig.session()
        restarted.refreshNewest()
        assertEquals("a restart must not double the reply", 1, renderedAssistantBubbles(restarted))
    }

    // ── F. retry with the same requestId / idempotency key ───────────────────

    @Test
    fun `F - replaying the same requestId returns the same canonical reply once`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        val first = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()

        // The Home Node turns a replayed requestId into the ORIGINAL turn, so the
        // canonical id is unchanged and no second row may appear.
        session.sendAndAwait("hello")
        val attempts = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID)
        assertEquals("the same canonical assistant id", "msg_a1", first.assistantMessageId)
        assertTrue(attempts.all { it.assistantMessageId == "msg_a1" })
        assertEquals("exactly one reply bubble", 1, renderedAssistantBubbles(session))
        assertEquals("the canonical store holds one row", 1, assistantRows("msg_a1"))
    }

    // ── G. manual refresh right after completion ─────────────────────────────

    @Test
    fun `G - a manual refresh immediately after completion does not double the reply`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        repeat(3) { session.refreshNewest() }
        session.syncNow()
        assertEquals("repeated refreshes must be idempotent", 1, renderedAssistantBubbles(session))
    }

    @Test
    fun `G - repeated syncs never accumulate reply bubbles`() = runBlocking {
        val session = rig.session()
        session.sendAndAwait("hello")
        repeat(5) { session.syncNow() }
        assertEquals(1, renderedAssistantBubbles(session))
        assertEquals(1, assistantRows("msg_a1"))
    }

    private fun assistantRows(id: String): Int {
        val message = rig.cache.message(id) ?: return 0
        return if (message.role == "assistant") 1 else 0
    }

    // ── the user's own bubble is unaffected ──────────────────────────────────

    @Test
    fun `the user bubble still waits for the canonical row so it cannot blink out`() {
        val done = attempt(AttemptState.DONE, assistantId = "msg_a1", userMessageId = "msg_u1")
        assertTrue(
            "the user's own text must stay until its canonical row exists",
            AttemptOverlay.visible(done, setOf("msg_a1")),
        )
        assertFalse(
            "and disappear once it does",
            AttemptOverlay.visible(done, setOf("msg_a1", "msg_u1")),
        )
    }
}
