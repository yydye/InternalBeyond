package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.api.DtoCodec
import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.data.repository.ConversationSession
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Regression · a user turn always precedes its own assistant turn (M1-C.2h).
 *
 * Observed on 单可昕, physically:
 *
 * ```
 *   assistant canonical bubble
 *   timestamp
 *   user overlay bubble
 * ```
 *
 * — a reply drawn ABOVE the message that caused it. The audit rules out the two
 * hypotheses that come first:
 *
 *  * **Not timestamp inversion.** The canonical assistant timestamp is the
 *    GENERATION-FINISH clock and the user timestamp is the SEND clock, so
 *    `user.ts < asst.ts` holds for every turn this device sends.
 *  * **Not an `insert_seq` problem.** The mobile DTO genuinely lacks `insert_seq`
 *    (`docs/ANDROID_THIN_CLIENT.md`, the `(timestamp, id)` fallback), and this fix does
 *    not need it: the pair's true order is already known locally, from the attempt row.
 *
 * The cause is list assembly. The screen drew `items(state.messages)` and then
 * `state.overlay.forEach { … }` — every canonical row, THEN every overlay row. That is
 * correct only while the sending turn is the newest thing in the conversation, and the
 * window in which it is not is exactly the one `chat.done` creates:
 *
 * ```
 *   chat.done names assistantMessageId AND carries the stored row
 *     → the canonical assistant row is cached IMMEDIATELY
 *   the canonical USER row arrives later, through sync.changes
 *     → a channel not guaranteed to run at all before the next send
 * ```
 *
 * So with any earlier canonical row present, the render became
 * `[…earlier turns…, msg_<asst>, USER OVERLAY]`: the answer above the question.
 *
 * The fix is an anchor, not a sort. A turn this device sent is named in full by its own
 * attempt row — `userMessageId` is the question, `assistantMessageId` is the answer — so
 * [AttemptOverlay.render] draws that turn where its own identity says it goes and leaves
 * every canonical row it cannot vouch for exactly where canonical order put it.
 *
 * [transcript] reads the same merged list the screen renders, so these tests cannot
 * drift from the UI.
 */
class UserBeforeAssistantOrderingTest {

    private lateinit var fake: FakeHomeNode
    private lateinit var rig: TestRig
    private lateinit var dbPath: String

    @Before
    fun setUp() {
        fake = FakeHomeNode().start()
        dbPath = Files.createTempFile("ib-order-", ".db").toString()
        rig = TestRig(dbPath, fake = fake)
        CacheSchema.create(rig.db)
        // Bind the character to its conversation, which is what a session learns from
        // its first history read or its first stream frame.
        rig.cache.bindConversation(DtoFixtures.CHARACTER_ID, "", DtoFixtures.CONVERSATION)
    }

    @After
    fun tearDown() {
        runCatching { rig.close() }
        runCatching { fake.stop() }
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
    }

    // ── the conversation as the screen draws it ───────────────────────────────

    /**
     * Read [ConversationState.render] — the one list the UI draws — and turn it into
     * strings. Nothing here reconstructs ordering: if this function and the screen
     * disagree, the screen is wrong, because both read the same list.
     */
    private fun transcript(session: ConversationSession): List<String> {
        val state = session.state.value
        val out = mutableListOf<String>()
        for (item in state.render) {
            when (item) {
                is AttemptOverlay.RenderItem.Message -> {
                    val message = item.message
                    val reasoning = state.reasoning[message.id]
                    if (reasoning != null && AttemptOverlay.showsThinking(message)) {
                        out += "thinking($reasoning)"
                    }
                    out += "${message.role}(${message.content})"
                }

                is AttemptOverlay.RenderItem.AttemptUser -> out += "user(${item.attempt.content})"

                is AttemptOverlay.RenderItem.AttemptAssistant -> {
                    val attempt = item.attempt
                    if (attempt.reasoningText.isNotEmpty()) out += "thinking(${attempt.reasoningText})"
                    out += if (attempt.partialText.isEmpty()) "dots" else "assistant(${attempt.partialText})"
                }
            }
        }
        return out
    }

    /**
     * The invariant, checked structurally rather than by eyeballing one list: walking the
     * items in order, the first assistant turn may not precede the first user turn, and
     * every later assistant turn must still follow the user turn that opened its
     * exchange.
     */
    private fun assertNoAssistantAboveItsUser(order: List<String>, where: String) {
        var usersSeen = 0
        var assistantsSeen = 0
        for (item in order) {
            when {
                item.startsWith("user(") -> usersSeen++
                item.startsWith("assistant(") || item == "dots" -> {
                    assistantsSeen++
                    if (assistantsSeen > usersSeen) {
                        throw AssertionError("$where: assistant turn #$assistantsSeen has no user turn before it: $order")
                    }
                }
            }
        }
        assertTrue("$where: nothing was drawn at all", order.isNotEmpty())
    }

    /** Two canonical rows: the turn before the one under test. */
    private fun earlierTurn() = listOf(
        canonical("msg_u0", "user", "first", 0),
        canonical("msg_a0", "assistant", "FIRST", 1_000),
    )

    private fun canonical(
        id: String,
        role: String,
        content: String,
        offset: Long,
        showThinking: String? = null,
    ): ChatMessage = DtoCodec.message(
        (if (role == "user") DtoFixtures.userMessage(content, id) else DtoFixtures.assistantMessage(content, id))
            .put("timestamp", DtoFixtures.TIMESTAMP + offset)
            .also { json ->
                if (showThinking != null) json.getJSONObject("metadata").put("showThinking", showThinking)
            },
    )

    private fun attempt(
        state: AttemptState,
        content: String = "hello",
        partial: String = "",
        reasoning: String = "",
        userMessageId: String? = null,
        assistantMessageId: String? = null,
        requestId: String = "req_row",
        createdAt: Long = 0L,
    ) = SendAttempt(
        requestId = requestId,
        characterId = DtoFixtures.CHARACTER_ID,
        conversationId = DtoFixtures.CONVERSATION,
        content = content,
        state = state,
        userMessageId = userMessageId,
        assistantMessageId = assistantMessageId,
        partialText = partial,
        reasoningText = reasoning,
        createdAt = createdAt,
    )

    /** Rebuild visible state from durable storage without touching the network. */
    private fun republish(session: ConversationSession) {
        runBlocking { session.syncNow() }
    }

    // ── A. assistant canonical first, user transient ──────────────────────────
    //
    // This is the reported symptom, in the exact shape the 单可昕 conversation had.

    @Test
    fun `A - a canonical reply is never drawn above its still transient user message`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        // chat.done: the answer is canonical, the question has not synced.
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partial = "ABC",
                reasoning = "THINK",
            ),
        )
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC", 3_000))) }

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            "the transient question is anchored immediately before the canonical answer",
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            order,
        )
        assertNoAssistantAboveItsUser(order, "A")
        assertEquals(
            "and the question is not appended after the answer",
            order.indexOf("user(hello)") + 1,
            order.indexOf("thinking(THINK)"),
        )
    }

    @Test
    fun `A2 - the anchor survives further syncs that have still not delivered the user row`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(
            attempt(AttemptState.DONE, userMessageId = "msg_u1", assistantMessageId = "msg_a1", partial = "ABC"),
        )
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC", 3_000))) }

        val session = rig.session()
        republish(session)
        repeat(3) { republish(session) }

        assertEquals(
            "repeated reconciliation must not move it",
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "assistant(ABC)"),
            transcript(session),
        )
    }

    // ── B. user canonical first, assistant transient ──────────────────────────

    @Test
    fun `B - a canonical user row stays above the reply still streaming from the attempt`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        // The question has synced; the turn is still generating.
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_u1", "user", "hello", 2_000))) }
        rig.cache.saveAttempt(
            attempt(AttemptState.RUNNING, userMessageId = "msg_u1", partial = "AB", reasoning = "THINK"),
        )

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(AB)"),
            order,
        )
        assertNoAssistantAboveItsUser(order, "B")
        assertEquals("no second copy of the user's own message", 1, order.count { it == "user(hello)" })
    }

    // ── C. both canonical ─────────────────────────────────────────────────────

    @Test
    fun `C - both rows canonical draws one user bubble then one answer, in that order`() {
        runBlocking {
            rig.cache.upsertMessages(
                earlierTurn() + listOf(
                    canonical("msg_u1", "user", "hello", 2_000),
                    canonical("msg_a1", "assistant", "ABC", 3_000),
                ),
            )
        }
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partial = "ABC",
                reasoning = "THINK",
            ),
        )

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            order,
        )
        assertNoAssistantAboveItsUser(order, "C")
    }

    @Test
    fun `C2 - a cache that ordered the two rows backwards is corrected from turn identity`() {
        // The canonical order key is (timestamp, insert_seq); insert_seq is not in the
        // mobile DTO, so the device falls back to (timestamp, id). Give the assistant row
        // the EARLIER timestamp — the inversion that fallback cannot detect — and let the
        // attempt row, which knows the pair's real order, put the turn back together.
        runBlocking {
            rig.cache.upsertMessages(
                earlierTurn() + listOf(
                    canonical("msg_a1", "assistant", "ABC", 2_000),
                    canonical("msg_u1", "user", "hello", 3_000),
                ),
            )
        }
        rig.cache.saveAttempt(
            attempt(AttemptState.DONE, userMessageId = "msg_u1", assistantMessageId = "msg_a1", partial = "ABC"),
        )

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "assistant(ABC)"),
            order,
        )
        assertNoAssistantAboveItsUser(order, "C2")
    }

    @Test
    fun `C3 - a turn this device never sent is left exactly where canonical order put it`() {
        // No attempt row: nothing links these two rows as a pair, so the client must not
        // invent an order for them. (This is also why the fix needs no protocol change:
        // guessing here would be worse than the fallback.)
        runBlocking {
            rig.cache.upsertMessages(
                listOf(
                    canonical("msg_a9", "assistant", "FROM ANOTHER DEVICE", 1_000),
                    canonical("msg_u9", "user", "from another device", 2_000),
                ),
            )
        }

        val session = rig.session()
        republish(session)

        assertEquals(
            "canonical order is authoritative for turns we did not send",
            listOf("assistant(FROM ANOTHER DEVICE)", "user(from another device)"),
            transcript(session),
        )
    }

    // ── D. neither canonical: the turn in flight carries its own answer ───────
    //
    // The canonical rows a device did not send are untouched, and the turn in flight is
    // the newest thing that is not one of them. Its question and its answer are drawn
    // together, so the reply placeholder can never be separated from the message it
    // belongs to.

    @Test
    fun `D - with neither row canonical the turn in flight keeps its own answer`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(attempt(AttemptState.PENDING))

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "dots"),
            order,
        )
        assertNoAssistantAboveItsUser(order, "D")
    }

    @Test
    fun `D2 - with no history at all a pending turn is its own exchange`() {
        rig.cache.saveAttempt(attempt(AttemptState.PENDING))

        val session = rig.session()
        republish(session)

        assertEquals(listOf("user(hello)", "dots"), transcript(session))
    }

    // ── E. reconnect ──────────────────────────────────────────────────────────

    @Test
    fun `E - a reconnect mid turn keeps the question above the answer`() = runBlocking {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        fake.reasoningText = "THINK"
        fake.cutStreamAfterDeltas = 1

        val session = rig.session()
        session.sendAndAwait("hello")

        // The recovery probe learns both ids from turns.get, and the attempt is durable,
        // so the anchor is available to the reconnect exactly as it was to the send.
        val record = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        assertEquals(AttemptState.DONE, record.state)
        assertNotNull("the interruption did not cost the answer its id", record.assistantMessageId)

        val order = transcript(session)
        assertNoAssistantAboveItsUser(order, "E")
        assertEquals(
            "the turn is rebuilt as question then answer",
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            order,
        )
    }

    // ── F. restart ────────────────────────────────────────────────────────────

    @Test
    fun `F - after a restart the same order is derived from durable storage alone`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partial = "ABC",
                reasoning = "THINK",
            ),
        )
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC", 3_000))) }

        val before = rig.session()
        republish(before)
        val expected = transcript(before)

        // A restart: a brand-new session object with no in-memory state of its own, and
        // the node answering history with the settled row. Everything it knows is what
        // the cache and the attempt table hold.
        fake.serveCompletedTurnInHistory = true
        val restarted = rig.session()
        runBlocking { restarted.start().join() }

        assertEquals(
            "the ordering is a fact about durable state, not about this process run",
            expected,
            transcript(restarted),
        )
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            transcript(restarted),
        )
        assertNoAssistantAboveItsUser(transcript(restarted), "F")
    }

    // ── G. two consecutive overlapping turns ──────────────────────────────────

    /**
     * The whole chain, through the real transport: a `requestId` is generated and
     * persisted, the SSE turn runs, `chat.done` names the canonical ids, and the user row
     * reaches the device afterwards — on a channel that is not guaranteed to run at all.
     *
     * This is the reported window exactly. Every id here came off the wire, and the
     * ordering is decided from what the app itself recorded, not from a fixture.
     */
    @Test
    fun `F2 - a real send keeps its question above its answer before the user row syncs`() = runBlocking {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        fake.reasoningText = "THINK"

        val session = rig.session()
        session.sendAndAwait("hello")

        // Read back what the device actually persisted for this send.
        val record = rig.cache.attemptsFor(DtoFixtures.CHARACTER_ID).single()
        val requestId: String = record.requestId
        val userRow: String = record.userMessageId!!
        val assistantRow: String = record.assistantMessageId!!
        assertEquals(DtoFixtures.TURN_ID, record.turnId)
        assertTrue("the requestId was generated before the request", requestId.startsWith("req_"))
        assertEquals(AttemptState.DONE, record.state)

        // The canonical answer is here; the question is not (sync.changes has not run).
        assertNotNull(rig.cache.message(assistantRow))
        assertEquals(null, rig.cache.message(userRow))

        val beforeUserRow = transcript(session)
        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            beforeUserRow,
        )
        assertNoAssistantAboveItsUser(beforeUserRow, "F2")

        // Now the canonical question finally lands, as a later sync would deliver it.
        runBlocking {
            rig.cache.upsertMessages(
                listOf(
                    DtoCodec.message(
                        DtoFixtures.userMessage("hello", userRow)
                            .put("timestamp", DtoFixtures.TIMESTAMP + 2_000),
                    ),
                ),
            )
        }
        session.syncNow()

        val afterUserRow = transcript(session)
        assertEquals(
            "the transient bubble hands over to the canonical row, in the same place",
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "assistant(ABC)"),
            afterUserRow,
        )
        assertEquals(
            "and exactly one item of each kind is drawn",
            1,
            session.state.value.render.count { it.key == userRow },
        )
        assertEquals(
            "the overlay half is gone",
            0,
            session.state.value.render.count { it.key == "local:$requestId:user" },
        )
    }


    @Test
    fun `G - two overlapping turns each keep their own question above their own answer`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        // Turn 1 has settled and its answer is canonical; turn 2 is still streaming and
        // its question has NOT synced. This is the state a quick second send produces.
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                content = "one",
                partial = "ONE",
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                requestId = "req_1",
                createdAt = 1_000,
            ),
        )
        rig.cache.saveAttempt(
            attempt(
                AttemptState.RUNNING,
                content = "two",
                partial = "TW",
                reasoning = "THINK2",
                requestId = "req_2",
                createdAt = 2_000,
            ),
        )
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ONE", 3_000))) }

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertEquals(
            listOf(
                "user(first)", "assistant(FIRST)",
                "user(one)", "assistant(ONE)",
                "user(two)", "thinking(THINK2)", "assistant(TW)",
            ),
            order,
        )
        assertNoAssistantAboveItsUser(order, "G")
        assertTrue(
            "turn 1 stays above turn 2: $order",
            order.indexOf("assistant(ONE)") < order.indexOf("user(two)"),
        )
    }

    @Test
    fun `G2 - a turn whose user row synced late does not land under the next turn`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                content = "one",
                partial = "ONE",
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                requestId = "req_1",
                createdAt = 1_000,
            ),
        )
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                content = "two",
                partial = "TWO",
                userMessageId = "msg_u2",
                assistantMessageId = "msg_a2",
                requestId = "req_2",
                createdAt = 2_000,
            ),
        )
        // Both answers are canonical, and turn 1's question arrives LAST — the worst
        // ordering the fallback can produce.
        runBlocking {
            rig.cache.upsertMessages(
                listOf(
                    canonical("msg_a1", "assistant", "ONE", 3_000),
                    canonical("msg_a2", "assistant", "TWO", 4_000),
                    canonical("msg_u2", "user", "two", 5_000),
                    canonical("msg_u1", "user", "one", 6_000),
                ),
            )
        }

        val session = rig.session()
        republish(session)

        val order = transcript(session)
        assertNoAssistantAboveItsUser(order, "G2")
        assertEquals(
            "each question sits with its own answer, in turn order",
            listOf(
                "user(first)", "assistant(FIRST)",
                "user(one)", "assistant(ONE)",
                "user(two)", "assistant(TWO)",
            ),
            order,
        )
    }

    // ── the invariants of M1-C.2f / M1-C.2g survive the new merge ─────────────

    @Test
    fun `H - merging must not multiply a bubble, drop one, or move a thinking block`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partial = "ABC",
                reasoning = "THINK",
            ),
        )
        runBlocking { rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC", 3_000))) }

        val session = rig.session()
        republish(session)
        repeat(3) { republish(session) }

        val order = transcript(session)
        assertEquals("one reply per canonical assistant row", 2, order.count { it.startsWith("assistant(") })
        assertEquals("one question", 2, order.count { it.startsWith("user(") })
        assertEquals("one thinking block", 1, order.count { it.startsWith("thinking(") })
        assertEquals(
            "and the block is drawn as part of its reply's turn",
            order.indexOf("thinking(THINK)"),
            order.indexOf("assistant(ABC)") - 1,
        )
        assertEquals(
            "no item may appear twice, and none may be dropped",
            listOf("msg_u0", "msg_a0", "local:req_row:user", "msg_a1"),
            session.state.value.render.map { it.key },
        )
    }

    @Test
    fun `H2 - while the reply is still transient its thinking stays inside its own turn`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(attempt(AttemptState.RUNNING, partial = "", reasoning = "THINK"))

        val session = rig.session()
        republish(session)

        assertEquals(
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "thinking(THINK)", "dots"),
            transcript(session),
        )
    }

    @Test
    fun `H3 - showThinking false still suppresses the block wherever it is owned`() {
        runBlocking { rig.cache.upsertMessages(earlierTurn()) }
        rig.cache.saveAttempt(
            attempt(
                AttemptState.DONE,
                userMessageId = "msg_u1",
                assistantMessageId = "msg_a1",
                partial = "ABC",
                reasoning = "THINK",
            ),
        )
        runBlocking {
            rig.cache.upsertMessages(listOf(canonical("msg_a1", "assistant", "ABC", 3_000, showThinking = "false")))
        }

        val session = rig.session()
        republish(session)

        assertEquals(
            "no thinking anywhere, and the answer is untouched",
            listOf("user(first)", "assistant(FIRST)", "user(hello)", "assistant(ABC)"),
            transcript(session),
        )
    }
}