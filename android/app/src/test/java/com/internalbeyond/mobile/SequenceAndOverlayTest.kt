package com.internalbeyond.mobile

import com.internalbeyond.mobile.app.BackStack
import com.internalbeyond.mobile.app.Route
import com.internalbeyond.mobile.data.api.StreamSequenceTracker
import com.internalbeyond.mobile.domain.AttemptOverlay
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.platform.IbLog
import com.internalbeyond.mobile.support.DtoFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit · stream sequencing, optimistic overlay and the back ladder.
 *
 * All three are small pure functions that decide a lot: whether a frame is a
 * duplicate, whether the user's own text stays on screen, and whether Back leaves
 * the chat or the app.
 */
class SequenceAndOverlayTest {

    // ── sequence tracking ────────────────────────────────────────────────────

    @Test
    fun `the first frame of a connection is adopted, whatever its number`() {
        // Reconnecting with `after=6` legitimately makes the first frame 7. Treating
        // that as a gap would turn every resume into a false alarm.
        val tracker = StreamSequenceTracker(initialSequence = 6)
        assertTrue(tracker.onFrame(7) is StreamSequenceTracker.Decision.Adopted)
        assertEquals(7, tracker.lastSeen)
        assertTrue(tracker.onFrame(8) is StreamSequenceTracker.Decision.Accepted)
    }

    @Test
    fun `a re-delivered frame is dropped, not appended twice`() {
        val tracker = StreamSequenceTracker(0)
        tracker.onFrame(1)
        val decision = tracker.onFrame(1)
        assertTrue(decision is StreamSequenceTracker.Decision.Duplicate)
        assertEquals(1, tracker.lastSeen)
    }

    @Test
    fun `a missing frame is detected with the position to resume from`() {
        val tracker = StreamSequenceTracker(0)
        tracker.onFrame(1)
        tracker.onFrame(2)
        val decision = tracker.onFrame(5)
        assertTrue(decision is StreamSequenceTracker.Decision.Gap)
        assertEquals(3, (decision as StreamSequenceTracker.Decision.Gap).expected)
        assertEquals(5, decision.got)
        // lastSeen advances so a reconnect asks for everything after the gap.
        assertEquals(5, tracker.lastSeen)
    }

    @Test
    fun `sequence-less control frames do not disturb the position`() {
        val tracker = StreamSequenceTracker(0)
        tracker.onFrame(1)
        assertTrue(tracker.onFrame(null) is StreamSequenceTracker.Decision.Control)
        // stream.error is emitted with sequence 0 — it must not look like a duplicate
        // of, or a gap after, the real frames.
        assertTrue(tracker.onFrame(0) is StreamSequenceTracker.Decision.Control)
        assertEquals(1, tracker.lastSeen)
        assertTrue(tracker.onFrame(2) is StreamSequenceTracker.Decision.Accepted)
    }

    @Test
    fun `a new connection re-adopts but keeps what was already seen`() {
        val tracker = StreamSequenceTracker(0)
        tracker.onFrame(1)
        tracker.onFrame(2)
        tracker.onConnectionOpened()
        // A duplicate delivery of an old frame is still a duplicate, and it consumes
        // the one "adopt the first frame" slot for this connection.
        assertTrue(tracker.onFrame(2) is StreamSequenceTracker.Decision.Duplicate)
        assertTrue(tracker.onFrame(3) is StreamSequenceTracker.Decision.Accepted)
        assertEquals(3, tracker.lastSeen)
        // ...and a genuine gap afterwards is still detected.
        assertTrue(tracker.onFrame(9) is StreamSequenceTracker.Decision.Gap)
    }

    // ── optimistic overlay ───────────────────────────────────────────────────

    private fun attempt(state: AttemptState, userMessageId: String? = null) = SendAttempt(
        requestId = "r1",
        characterId = DtoFixtures.CHARACTER_ID,
        conversationId = DtoFixtures.CONVERSATION,
        content = "hello",
        state = state,
        userMessageId = userMessageId,
    )

    @Test
    fun `an unfinished send is always visible`() {
        for (state in listOf(AttemptState.PENDING, AttemptState.RUNNING, AttemptState.RECOVERING)) {
            assertTrue("$state must stay visible", AttemptOverlay.visible(attempt(state), emptySet()))
        }
    }

    @Test
    fun `a failed send stays visible so it can be retried`() {
        assertTrue(AttemptOverlay.visible(attempt(AttemptState.FAILED), emptySet()))
    }

    @Test
    fun `a finished send disappears only once its canonical message is cached`() {
        val done = attempt(AttemptState.DONE, userMessageId = "msg_u1")
        assertTrue("the user's text must not blink out", AttemptOverlay.visible(done, emptySet()))
        assertFalse(AttemptOverlay.visible(done, setOf("msg_u1")))
    }

    @Test
    fun `a done attempt with no known user message id keeps its overlay`() {
        assertTrue(AttemptOverlay.visible(attempt(AttemptState.DONE, userMessageId = null), emptySet()))
    }

    // ── back ladder ──────────────────────────────────────────────────────────

    @Test
    fun `back from a chat returns to the character list, not out of the app`() {
        val stack = BackStack(Route.Characters)
        stack.push(Route.Chat("c1"))
        assertEquals(Route.Chat("c1"), stack.current)
        assertTrue(stack.pop())
        assertEquals(Route.Characters, stack.current)
        assertFalse("the root must defer to the system", stack.pop())
    }

    @Test
    fun `settings pops back to whatever pushed it`() {
        val stack = BackStack(Route.Characters)
        stack.push(Route.Settings)
        assertEquals(Route.Settings, stack.current)
        assertTrue(stack.pop())
        assertEquals(Route.Characters, stack.current)
    }

    @Test
    fun `pushing the same destination twice is ignored`() {
        val stack = BackStack(Route.Characters)
        stack.push(Route.Settings)
        stack.push(Route.Settings)
        assertEquals(2, stack.depth)
    }

    @Test
    fun `a session reset collapses the stack to pairing`() {
        val stack = BackStack(Route.Characters)
        stack.push(Route.Chat("c1"))
        stack.reset(Route.Pairing)
        assertEquals(1, stack.depth)
        assertEquals(Route.Pairing, stack.current)
    }

    // ── log redaction ────────────────────────────────────────────────────────

    @Test
    fun `redaction masks credentials even when a call site passes one by mistake`() {
        val token = DtoFixtures.TOKEN
        val secret = DtoFixtures.PAIRING_SECRET
        assertEquals("«redacted»", IbLog.sanitize(token))
        assertEquals("«redacted»", IbLog.sanitize("sk-SECRETSECRETSECRETSECRET"))
        assertFalse(IbLog.sanitize("Authorization: Bearer $token").contains(token))
        assertFalse(IbLog.sanitize("secret=$secret").contains(secret))
        // Non-secret diagnostics survive, or the log would be useless.
        assertEquals("192.168.1.5:23118", IbLog.sanitize("192.168.1.5:23118"))
        assertEquals("turn_abc123", IbLog.sanitize("turn_abc123"))
    }
}
