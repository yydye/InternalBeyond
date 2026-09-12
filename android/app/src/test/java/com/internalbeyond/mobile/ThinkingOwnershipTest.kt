package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.data.api.DtoCodec
import com.internalbeyond.mobile.data.repository.ConversationSession
import com.internalbeyond.mobile.domain.AttemptOverlay
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.support.DtoFixtures
import com.internalbeyond.mobile.support.FakeHomeNode
import com.internalbeyond.mobile.support.TestRig
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Regression · thinking is assistant-owned turn state (M1-C.2g).
 *
 * Observed on 爱莉希雅, physically: a previous reply, then the user's `在吗`, then
 * 思考过程, then the reply. The thinking block read as belonging to the user message.
 *
 * The device's own cache says exactly why, and it is not what the first hypothesis
 * predicted:
 *
 *  * the conversation held ONE canonical row — the assistant reply. The canonical user
 *    row for `在吗` was never delivered (`sync.changes` had not run since the turn);
 *  * so the `在吗` bubble on screen could only be the send-attempt overlay, and the
 *    reply could only be the canonical row;
 *  * reasoning exists in exactly one durable place, `send_attempts.reasoning_text`
 *    (202 characters for that turn). The canonical assistant row DOES carry
 *    `reasoning_content` in the Home Node's store, and the mobile DTO strips it
 *    (`assets/js/mobile-dto.js:208`), so no canonical row on the device can ever show
 *    its own thinking;
 *  * one `send_attempts` row was drawn as one column: user bubble → status → thinking
 *    → reply. The thinking block therefore sat BELOW the user's own message.
 *
 * So the defect is (A) an ownership bug with (C) a reconciliation half — NOT the
 * ordering bug it resembles. Measured on the same device, a completed turn's canonical
 * rows order correctly (`user.ts < asst.ts` in all three turns that have both), so
 * there is no timestamp inversion to fix and no reason to touch the Home Node.
 *
 * The invariant: `UserTurn → AssistantTurn{ reasoning, content }`. During a stream the
 * transient attempt owns the incoming reasoning AND the reply; the moment
 * `assistantMessageId` is canonical, both move to the canonical bubble, joined by that
 * one id. Exactly one owner, at every instant.
 *
 * [transcript] reconstructs the chat list's rendering ORDER from the same public facts
 * the Compose layer reads, so a regression in either the rules or their order fails
 * here rather than only on a phone.
 */
class ThinkingOwnershipTest {

    private lateinit var fake: FakeHomeNode
    private lateinit var rig: TestRig
    private lateinit var dbPath: String

    @Before
    fun setUp() {
        fake = FakeHomeNode().start()
        dbPath = Files.createTempFile("ib-thinking-", ".db").toString()
        rig = TestRig(dbPath, fake = fake)
        CacheSchema.create(rig.db)
    }

    @After
    fun tearDown() {
        runCatching { rig.close() }
        runCatching { fake.stop() }
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
    }

    /**
     * A durable attempt row, exactly as the session writes it mid-stream.
     *
     * Building one directly is not a shortcut around the transport: [ConversationSession]
     * persists every delta into this table, and the UI is rebuilt from it, so this IS
     * the intermediate state. Cases 1a/1b below cover the same ground through the real
     * SSE path.
     */
    private fun attempt(
        state: AttemptState,
        partial: String = "",
        reasoning: String = "",
        assistantId: String? = null,
        userMessageId: String? = null,
        requestId: String = "req_row",
    ) = com.internalbeyond.mobile.domain.model.SendAttempt(
        requestId = requestId,
        characterId = DtoFixtures.CHARACTER_ID,
        conversationId = DtoFixtures.CONVERSATION,
        content = "hello",
        state = state,
        userMessageId = userMessageId,
        assistantMessageId = assistantId,
        partialText = partial,
        reasoningText = reasoning,
    )

    /** Rebuild the visible state from durable storage without touching the network. */
    private fun republish(session: ConversationSession) {
        runBlocking { session.syncNow() }
    }

    // ── what the conversation renders, in order ───────────────────────────────

    private fun transcript(session: ConversationSession): List<String> {
        val state = session.state.value
        val canonicalIds = state.messages.mapTo(HashSet()) { it.id }
        val out = mutableListOf<String>()
        for (message in state.messages) {
            val reasoning = state.reasoning[message.id]
            if (reasoning != null && AttemptOverlay.showsThinking(message)) {
                out += "thinking($reasoning)"
            }
            out += "${message.role}(${message.content})"
        }
        for (attempt in state.overlay) {
            if (AttemptOverlay.showsUserBubble(attempt, canonicalIds)) out += "user(${attempt.content})"
            if (!AttemptOverlay.showsAssistantBubble(attempt, canonicalIds)) continue
            val draws = attempt.partialText.isNotEmpty() ||
                attempt.reasoningText.isNotEmpty() ||
                !attempt.state.isTerminal
            if (!draws) continue
            if (attempt.reasoningText.isNotEmpty()) out += "thinking(${attempt.reasoningText})"
            out += "assistant(${attempt.partialText})"
        }
        return out
    }

    /** Every thinking block on screen, in order. */
    private fun thinkingBlocks(session: ConversationSession): List<String> =
        transcript(session).filter { it.startsWith("thinking(") }
            .map { it.removePrefix("thinking(").removeSuffix(")") }

    /** Every assistant bubble on screen, in order. */
    private fun assistantBubbles(session: ConversationSession): List<String> =
        transcript(session).filter { it.startsWith("assistant(") }

    private fun canonical(id: String, role: String, content: String, showThinking: String? = null): ChatMessage =
        ChatMessage(
            id = id,
            role = role,
            content = content,
            timestamp = DtoFixtures.TIMESTAMP,
            conversationId = DtoFixtures.CONVERSATION,
            metadata = if (showThinking == null) emptyMap() else mapOf("showThinking" to showThinking),
        )

    // ── 1. active streaming ───────────────────────────────────────────────────

    @Test
    fun `1a - while the model thinks, the thinking belongs to the pending assistant turn`() {
        // Mid-stream durable state: reasoning arrived, the answer has not started, and
        // no canonical row exists yet.
        rig.cache.saveAttempt(attempt(AttemptState.RUNNING, partial = "", reasoning = "THINK"))
        val session = rig.session()
        republish(session)

        assertNull("nothing is canonical until chat.done", rig.cache.message("msg_a1"))
        assertEquals(
            "user → thinking → the pending answer, and nothing under the user's message",
            listOf("user(hello)", "thinking(THINK)", "assistant()"),
            transcript(session),
        )
    }

    @Test
    fun `1b - answer text arriving mid-stream keeps thinking directly above it`() {
        rig.cache.saveAttempt(attempt(AttemptState.RUNNING, partial = "AB", reasoning = "THINK"))
        val session = rig.session()
        republish(session)

        assertEquals(
            listOf("user(hello)", "thinking(THINK)", "assistant(AB)"),
            transcript(session),
        )
    }

    @Test
    fun `1c - a reasoning frame really does reach the attempt through the SSE path`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        session.sendAndAwait("hello")

        val record = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals("reasoning is accumulated from chat.delta", "THINK", record.reasoningText)
        assertEquals("and it is not mixed into the answer", "ABC", record.partialText)
    }

    // ── 2. chat.done ──────────────────────────────────────────────────────────

    @Test
    fun `2 - at chat done the reasoning reconciles under the canonical assistant turn`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        session.sendAndAwait("hello")

        val attempt = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals("the reasoning is retained in the attempt table", "THINK", attempt.reasoningText)
        assertEquals("the canonical assistant id names the answer", "msg_a1", attempt.assistantMessageId)

        // One thinking block, addressed by the canonical assistant message…
        assertEquals(mapOf("msg_a1" to "THINK"), session.state.value.reasoning)
        // …and it is drawn with the answer, not with the user's message.
        assertEquals(listOf("THINK"), thinkingBlocks(session))
        assertEquals(
            "thinking then the answer, and exactly one copy of each",
            listOf("assistant(ABC)"),
            assistantBubbles(session),
        )
        assertTrue(
            "the thinking block precedes its own assistant bubble: ${transcript(session)}",
            transcript(session).indexOf("thinking(THINK)") < transcript(session).indexOf("assistant(ABC)"),
        )
    }

    // ── 3. done before sync ───────────────────────────────────────────────────

    @Test
    fun `3 - done before sync still leaves the thinking under the assistant turn`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        session.sendAndAwait("hello")

        // The canonical USER row is absent — this is the 爱莉希雅 window exactly.
        assertTrue(
            "the overlay still supplies the user's own message",
            session.state.value.overlay.any { AttemptOverlay.showsUserBubble(it, setOf("msg_a1")) },
        )
        assertEquals(
            "the canonical user row is not among the cached messages",
            0,
            session.state.value.messages.count { it.role == "user" },
        )
        assertEquals(
            "the reply is canonical, so the overlay must not replay it",
            listOf("assistant(ABC)"),
            assistantBubbles(session),
        )
        assertEquals("exactly one thinking block", listOf("THINK"), thinkingBlocks(session))
        assertEquals(
            "and it sits with the answer, never between user and answer",
            0,
            transcript(session).indexOf("thinking(THINK)"),
        )
    }

    // ── 4. sync before done ───────────────────────────────────────────────────

    @Test
    fun `4 - canonical rows arriving before the turn settles do not move the thinking`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        // Both canonical rows are already cached, with the answer the turn will produce.
        rig.cache.upsertMessages(
            listOf(
                canonical(DtoFixtures.USER_MESSAGE_ID, "user", "hello"),
                canonical("msg_a1", "assistant", "ABC"),
            ),
        )
        session.sendAndAwait("hello")

        assertEquals(
            "the canonical user row is authoritative — no second user bubble",
            1,
            transcript(session).count { it == "user(hello)" },
        )
        assertEquals("exactly one thinking block", listOf("THINK"), thinkingBlocks(session))
        assertEquals("exactly one reply bubble", listOf("assistant(ABC)"), assistantBubbles(session))
    }

    // ── 5. reconnect during reasoning ─────────────────────────────────────────

    @Test
    fun `5 - a reconnect mid thinking keeps the reasoning on the assistant turn`() = runBlocking {
        fake.reasoningText = "THINK"
        fake.cutStreamAfterReasoning = true
        val session = rig.session()
        session.sendAndAwait("hello")

        assertTrue("the stream was reopened", fake.chatStreamOpenCount.get() >= 1)

        // Before this fix the cut dropped `reasoningText` on the floor, because a
        // reasoning-only frame set never advanced `partialText`.
        val attempt = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.DONE, attempt.state)
        assertEquals("reasoning survives the interruption", "THINK", attempt.reasoningText)
        assertEquals(listOf("THINK"), thinkingBlocks(session))
        assertEquals(listOf("assistant(ABC)"), assistantBubbles(session))
    }

    // ── 6. reconnect during answer generation ─────────────────────────────────

    @Test
    fun `6 - a reconnect mid answer keeps reasoning and partial together`() = runBlocking {
        fake.reasoningText = "THINK"
        fake.cutStreamAfterDeltas = 1
        val session = rig.session()
        session.sendAndAwait("hello")

        assertEquals(
            "one thinking block and one reply — the pair travelled together",
            listOf("THINK"),
            thinkingBlocks(session),
        )
        assertEquals(listOf("assistant(ABC)"), assistantBubbles(session))
    }

    // ── 7. restart after a completed reasoning turn ───────────────────────────

    @Test
    fun `7 - after a restart the thinking is still owned by the canonical turn`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        session.sendAndAwait("hello")
        assertEquals(listOf("THINK"), thinkingBlocks(session))

        // A restart rebuilds state from durable storage only: the attempt table plus the
        // cached canonical rows, with history answering from the settled turn. This is
        // the path the device took and saw the block on.
        fake.serveCompletedTurnInHistory = true
        val restarted = rig.session()
        restarted.start().join()

        assertEquals("still exactly one thinking block", listOf("THINK"), thinkingBlocks(restarted))
        assertEquals("still exactly one reply", listOf("assistant(ABC)"), assistantBubbles(restarted))
        assertEquals(
            "the canonical turn is the owner after a restart",
            mapOf("msg_a1" to "THINK"),
            restarted.state.value.reasoning,
        )
    }

    // ── 8. showThinking=false ─────────────────────────────────────────────────

    @Test
    fun `8 - showThinking false draws no thinking UI and leaves the answer untouched`() {
        // The turn itself says not to show thinking — a per-turn fact the Home Node
        // already puts in the message metadata whitelist, so nothing here invents a
        // client-side setting.
        fake.historyShowThinking = "false"
        // The turn has already been answered on the node, so history serves it.
        fake.serveCompletedTurnInHistory = true
        val session = rig.session()
        runBlocking {
            // One history read: it binds this character to its conversation (a fresh
            // session does not know the conversation id yet) and caches the row whose
            // metadata says not to show thinking.
            session.refreshNewest()
        }
        // The turn's reasoning is still the attempt's, but the turn says do not show it.
        rig.cache.saveAttempt(
            com.internalbeyond.mobile.domain.model.SendAttempt(
                requestId = "req_x",
                characterId = DtoFixtures.CHARACTER_ID,
                conversationId = DtoFixtures.CONVERSATION,
                content = "hello",
                state = AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partialText = "ABC",
                reasoningText = "THINK",
            ),
        )
        runBlocking { session.syncNow() }

        assertEquals(
            "no thinking UI at all; row metadata was " +
                "${rig.cache.message("msg_a1")?.metadata}, state.reasoning ${session.state.value.reasoning}",
            emptyList<String>(),
            thinkingBlocks(session),
        )
        assertEquals(
            "and the final answer is unaffected",
            listOf("assistant(ABC)"),
            assistantBubbles(session),
        )
    }

    // ── 9. non-reasoning provider ─────────────────────────────────────────────

    @Test
    fun `9 - a provider that never thinks renders exactly as before`() = runBlocking {
        // fake.reasoningText stays empty: no reasoning frames at all.
        val session = rig.session()
        session.sendAndAwait("hello")

        assertEquals(emptyList<String>(), thinkingBlocks(session))
        assertEquals(listOf("assistant(ABC)"), assistantBubbles(session))
        assertEquals(emptyMap<String, String>(), session.state.value.reasoning)
    }

    // ── 10. two consecutive turns ─────────────────────────────────────────────

    @Test
    fun `10 - reasoning from turn N can never attach to turn N plus 1`() = runBlocking {
        fake.reasoningText = "THINK_A"
        val session = rig.session()
        session.sendAndAwait("first")

        fake.reasoningText = "THINK_B"
        // A second turn gets its OWN canonical id, exactly as the Home Node issues one
        // per turn; reusing msg_a1 would assert that two turns share a message.
        fake.assistantMessageId = "msg_a2"
        session.sendAndAwait("second")

        val attempts = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID)
        assertEquals("two turns, two attempts", 2, attempts.size)
        assertEquals(listOf("THINK_A", "THINK_B"), attempts.map { it.reasoningText })
        assertEquals(
            "each thinking block is named by its own canonical message",
            mapOf("msg_a1" to "THINK_A", "msg_a2" to "THINK_B"),
            session.state.value.reasoning,
        )
        assertEquals(
            "both blocks are on screen, in turn order",
            listOf("THINK_A", "THINK_B"),
            thinkingBlocks(session),
        )
        // The decisive assertion: no block may sit before its own reply's turn begins.
        val blocks = transcript(session)
        assertTrue(
            "turn A's thinking precedes turn B's: $blocks",
            blocks.indexOf("thinking(THINK_A)") < blocks.indexOf("thinking(THINK_B)"),
        )
        assertEquals(
            "and neither block may be the ONLY thing drawn for a turn",
            2,
            blocks.count { it.startsWith("assistant(") },
        )
    }

    // ── 11. the M1-C.2f invariant survives ────────────────────────────────────

    @Test
    fun `11 - one canonical assistant message still means one assistant bubble`() = runBlocking {
        fake.reasoningText = "THINK"
        val session = rig.session()
        session.sendAndAwait("hello")
        repeat(3) { session.syncNow() }
        session.syncNow()

        assertEquals(
            "repeated sync must not multiply the reply",
            listOf("assistant(ABC)"),
            assistantBubbles(session),
        )
        assertEquals("nor the thinking", listOf("THINK"), thinkingBlocks(session))
    }

    // ── 12. identity is the id, never the text ────────────────────────────────

    @Test
    fun `12 - identical reasoning text is not a reason to merge or to drop anything`() {
        val session = rig.session()
        // Bind the character to its conversation, which is what a session learns from
        // its first history read or stream frame.
        rig.cache.bindConversation(DtoFixtures.CHARACTER_ID, "", DtoFixtures.CONVERSATION)
        runBlocking {
            rig.cache.upsertMessages(
                listOf(
                    canonical("msg_u1", "user", "first"),
                    canonical("msg_a1", "assistant", "SAME"),
                    canonical("msg_u2", "user", "second"),
                    canonical("msg_a2", "assistant", "SAME"),
                ),
            )
        }
        for (id in listOf("msg_a1", "msg_a2")) {
            rig.cache.saveAttempt(
                com.internalbeyond.mobile.domain.model.SendAttempt(
                    requestId = "req_$id",
                    characterId = DtoFixtures.CHARACTER_ID,
                    conversationId = DtoFixtures.CONVERSATION,
                    content = "x",
                    state = AttemptState.DONE,
                    userMessageId = if (id == "msg_a1") "msg_u1" else "msg_u2",
                    assistantMessageId = id,
                    partialText = "SAME",
                    reasoningText = "SAME_THINKING",
                ),
            )
        }
        runBlocking { session.syncNow() }

        assertEquals(
            "two turns, two thinking blocks — identical text is not one block",            listOf("SAME_THINKING", "SAME_THINKING"),
            thinkingBlocks(session),
        )
        assertEquals(
            "two turns, two replies",
            listOf("assistant(SAME)", "assistant(SAME)"),
            assistantBubbles(session),
        )
        assertEquals(
            "each canonical id owns its own reasoning",
            mapOf("msg_a1" to "SAME_THINKING", "msg_a2" to "SAME_THINKING"),
            session.state.value.reasoning,
        )
    }

    // ── the canonical DTO cannot carry reasoning (recorded, not assumed) ──────

    @Test
    fun `the mobile DTO never carries reasoning_content, so the join is unavoidable`() {
        // The Home Node's store holds it (`execution.js:315`) and the mobile projection
        // drops it (`assets/js/mobile-dto.js:208`). Both halves are asserted here,
        // because the second is the reason the client has to keep its own copy at all.
        val stored = DtoFixtures.assistantMessage("ABC", reasoning = "THINK")
        assertTrue("the stored row carries reasoning", stored.has("reasoning_content"))
        assertEquals("THINK", stored.getString("reasoning_content"))

        val projected = DtoCodec.message(stored)
        assertFalse(
            "no field of the device's ChatMessage can hold it",
            projected.metadata.keys.any { it.contains("reason", ignoreCase = true) },
        )
        assertEquals("ABC", projected.content)
        assertEquals(
            "and it cannot leak into the whitelisted metadata either",
            mapOf("model_id" to "mock-model"),
            projected.metadata,
        )
    }
}
