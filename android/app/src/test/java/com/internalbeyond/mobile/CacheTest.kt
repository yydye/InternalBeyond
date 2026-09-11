package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.cache.SyncState
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.MessageDeletion
import com.internalbeyond.mobile.domain.model.SendAttempt
import com.internalbeyond.mobile.support.DtoFixtures
import com.internalbeyond.mobile.support.JdbcSqlDatabase
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
 * Unit · the local cache, against a real SQLite engine.
 *
 * Every statement in [CacheSchema] and [LocalCache] runs here for real, which is the
 * point of the `SqlDatabase` seam: the behaviours that would otherwise only be
 * exercised on a device — a delete that must not be undone, an empty answer that
 * must not wipe the list, a cursor that must survive a restart — are asserted on the
 * JVM.
 */
class CacheTest {

    private lateinit var dbPath: String
    private lateinit var db: JdbcSqlDatabase
    private lateinit var cache: LocalCache
    private var now = DtoFixtures.TIMESTAMP

    @Before
    fun setUp() {
        dbPath = Files.createTempFile("ib-cache-", ".db").toString()
        db = JdbcSqlDatabase.open(dbPath)
        CacheSchema.create(db)
        cache = LocalCache(db) { now }
    }

    @After
    fun tearDown() {
        runCatching { db.close() }
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
    }

    private fun message(
        id: String,
        content: String = "text",
        role: String = "assistant",
        timestamp: Long = DtoFixtures.TIMESTAMP,
    ) = ChatMessage(
        id = id,
        role = role,
        content = content,
        timestamp = timestamp,
        conversationId = DtoFixtures.CONVERSATION,
    )

    private fun attempt(requestId: String, state: AttemptState, createdAt: Long = DtoFixtures.TIMESTAMP) =
        SendAttempt(
            requestId = requestId,
            characterId = DtoFixtures.CHARACTER_ID,
            conversationId = DtoFixtures.CONVERSATION,
            content = "hello",
            state = state,
            createdAt = createdAt,
            updatedAt = createdAt,
        )

    // ── characters ───────────────────────────────────────────────────────────

    @Test
    fun `characters are replaced as a set, in the order the node sent them`() {
        val first = com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character("c1"))
        val second = com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character("c2"))
        assertEquals(2, cache.replaceCharacters(listOf(first, second), 11L))
        assertEquals(listOf("c1", "c2"), cache.characters().map { it.id })

        val replacement = com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character("c3"))
        cache.replaceCharacters(listOf(replacement), 12L)
        assertEquals(listOf("c3"), cache.characters().map { it.id })
    }

    @Test
    fun `an empty catalog never wipes the cache`() {
        val character = com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character())
        cache.replaceCharacters(listOf(character), 1L)
        assertEquals(0, cache.replaceCharacters(emptyList(), 2L))
        assertEquals(1, cache.characters().size)
    }

    @Test
    fun `only an explicit forget empties the catalog`() {
        cache.replaceCharacters(
            listOf(com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character())),
            1L,
        )
        cache.clearCharacters()
        assertTrue(cache.characters().isEmpty())
    }

    // ── messages ─────────────────────────────────────────────────────────────

    @Test
    fun `messages come back oldest first and are upserted, not duplicated`() {
        cache.upsertMessages(listOf(message("m1", timestamp = 10), message("m2", timestamp = 20)))
        cache.upsertMessages(listOf(message("m2", content = "edited", timestamp = 20)))
        val messages = cache.messages(DtoFixtures.CONVERSATION, 10)
        assertEquals(listOf("m1", "m2"), messages.map { it.id })
        assertEquals("edited", messages[1].content)
        assertEquals(2, cache.messageCount(DtoFixtures.CONVERSATION))
    }

    @Test
    fun `the page limit returns the NEWEST messages, still oldest-first`() {
        for (index in 1..10) {
            cache.upsertMessages(listOf(message("m$index", timestamp = index.toLong())))
        }
        val page = cache.messages(DtoFixtures.CONVERSATION, 3)
        assertEquals(listOf("m8", "m9", "m10"), page.map { it.id })
    }

    @Test
    fun `a delete removes the message and a later upsert cannot resurrect it`() {
        cache.upsertMessages(listOf(message("m1"), message("m2")))
        assertEquals(1, cache.applyDeletes(listOf(MessageDeletion("m1", DtoFixtures.CONVERSATION, 9L))))

        assertNull(cache.message("m1"))
        assertTrue(cache.isTombstoned("m1"))
        assertEquals(1, cache.messageCount(DtoFixtures.CONVERSATION))

        // A stale history page or an out-of-order sync must not bring it back.
        cache.upsertMessages(listOf(message("m1", content = "stale")))
        assertNull(cache.message("m1"))
        assertEquals(1, cache.messageCount(DtoFixtures.CONVERSATION))
    }

    @Test
    fun `an empty id is ignored rather than stored`() {
        assertEquals(0, cache.upsertMessages(listOf(message(""))))
        assertEquals(0, cache.applyDeletes(listOf(MessageDeletion("", null, null))))
    }

    @Test
    fun `conversation ids are learned from the node, not synthesised`() {
        assertNull(cache.conversationId(DtoFixtures.CHARACTER_ID))
        cache.bindConversation(DtoFixtures.CHARACTER_ID, "", "dm:whatever-the-node-said")
        assertEquals("dm:whatever-the-node-said", cache.conversationId(DtoFixtures.CHARACTER_ID))
        // A different thread is a different conversation.
        assertNull(cache.conversationId(DtoFixtures.CHARACTER_ID, "thread-1"))
    }

    // ── sync state ───────────────────────────────────────────────────────────

    @Test
    fun `sync state defaults to cursor zero and round-trips`() {
        assertEquals(0L, cache.syncState("node-a").cursor)
        assertEquals(false, cache.syncState("node-a").catalogConfirmedEmpty)

        cache.saveSyncState(
            SyncState(
                nodeKey = "node-a",
                cursor = 42L,
                revision = 42L,
                catalogUpdatedAt = 7L,
                catalogConfirmedEmpty = true,
            ),
        )
        val loaded = cache.syncState("node-a")
        assertEquals(42L, loaded.cursor)
        assertEquals(7L, loaded.catalogUpdatedAt)
        assertTrue(loaded.catalogConfirmedEmpty)
        // Cursors are per Home Node: another node starts from scratch.
        assertEquals(0L, cache.syncState("node-b").cursor)
    }

    // ── send attempts ────────────────────────────────────────────────────────

    @Test
    fun `open attempts exclude terminal ones`() {
        cache.saveAttempt(attempt("r1", AttemptState.PENDING))
        cache.saveAttempt(attempt("r2", AttemptState.RUNNING, createdAt = DtoFixtures.TIMESTAMP + 1))
        cache.saveAttempt(attempt("r3", AttemptState.RECOVERING, createdAt = DtoFixtures.TIMESTAMP + 2))
        cache.saveAttempt(attempt("r4", AttemptState.DONE, createdAt = DtoFixtures.TIMESTAMP + 3))
        cache.saveAttempt(attempt("r5", AttemptState.FAILED, createdAt = DtoFixtures.TIMESTAMP + 4))

        assertEquals(listOf("r1", "r2", "r3"), cache.openAttempts().map { it.requestId })
    }

    @Test
    fun `an attempt keeps its streaming position and text across an update`() {
        cache.saveAttempt(attempt("r1", AttemptState.RUNNING))
        val updated = cache.attempt("r1")!!.copy(
            state = AttemptState.RECOVERING,
            turnId = "turn_1",
            lastSequence = 7,
            partialText = "half a repl",
            reasoningText = "because",
        )
        cache.saveAttempt(updated)
        val loaded = cache.attempt("r1")!!
        assertEquals(AttemptState.RECOVERING, loaded.state)
        assertEquals("turn_1", loaded.turnId)
        assertEquals(7, loaded.lastSequence)
        assertEquals("half a repl", loaded.partialText)
        assertEquals("because", loaded.reasoningText)
    }

    @Test
    fun `attempts are listed per character and pruned by age`() {
        cache.saveAttempt(attempt("r1", AttemptState.DONE, createdAt = DtoFixtures.TIMESTAMP))
        cache.saveAttempt(attempt("r2", AttemptState.RUNNING, createdAt = DtoFixtures.TIMESTAMP + 10))
        assertEquals(
            listOf("r1", "r2"),
            cache.attemptsFor(DtoFixtures.CHARACTER_ID).map { it.requestId },
        )

        now = DtoFixtures.TIMESTAMP + 100_000
        assertEquals(1, cache.pruneAttempts(olderThanMs = 50_000))
        assertEquals(listOf("r2"), cache.openAttempts().map { it.requestId })
        assertNull(cache.attempt("r1"))
    }

    // ── drafts and maintenance ───────────────────────────────────────────────

    @Test
    fun `drafts persist and an empty draft clears the row`() {
        cache.saveDraft("c1", "unfinished thought")
        assertEquals("unfinished thought", cache.draft("c1"))
        cache.saveDraft("c1", "")
        assertEquals("", cache.draft("c1"))
        assertEquals(0, cache.stats().drafts)
    }

    @Test
    fun `stats count what is actually stored`() {
        cache.replaceCharacters(
            listOf(com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character())),
            1L,
        )
        cache.upsertMessages(listOf(message("m1"), message("m2")))
        cache.saveAttempt(attempt("r1", AttemptState.RUNNING))
        cache.saveDraft("c1", "draft")
        val stats = cache.stats()
        assertEquals(1, stats.characters)
        assertEquals(2, stats.messages)
        assertEquals(1, stats.conversations)
        assertEquals(1, stats.openAttempts)
        assertEquals(1, stats.drafts)
    }

    @Test
    fun `clearAll forgets everything`() {
        cache.replaceCharacters(
            listOf(com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character())),
            1L,
        )
        cache.upsertMessages(listOf(message("m1")))
        cache.saveAttempt(attempt("r1", AttemptState.RUNNING))
        cache.saveDraft("c1", "draft")
        cache.saveSyncState(SyncState("node-a", cursor = 5L))

        cache.clearAll()

        val stats = cache.stats()
        assertEquals(0, stats.characters)
        assertEquals(0, stats.messages)
        assertEquals(0, stats.openAttempts)
        assertEquals(0, stats.drafts)
        assertEquals(0L, cache.syncState("node-a").cursor)
    }

    /**
     * Phase 21's premise: the cache is on disk, so a restart finds the requestId.
     */
    @Test
    fun `everything survives closing and reopening the database`() {
        cache.replaceCharacters(
            listOf(com.internalbeyond.mobile.data.api.DtoCodec.character(DtoFixtures.character())),
            1L,
        )
        cache.upsertMessages(listOf(message("m1")))
        cache.saveAttempt(attempt("r1", AttemptState.RECOVERING).copy(turnId = "turn_1", lastSequence = 4))
        cache.saveSyncState(SyncState("node-a", cursor = 99L))
        db.close()

        db = JdbcSqlDatabase.open(dbPath)
        val reopened = LocalCache(db) { now }

        assertEquals(1, reopened.characters().size)
        assertEquals("m1", reopened.messages(DtoFixtures.CONVERSATION, 10).single().id)
        assertEquals("turn_1", reopened.attempt("r1")!!.turnId)
        assertEquals(4, reopened.attempt("r1")!!.lastSequence)
        assertEquals(99L, reopened.syncState("node-a").cursor)
        assertFalse(reopened.openAttempts().isEmpty())
    }

    @Test
    fun `the schema is idempotent so a second open does not fail`() {
        CacheSchema.create(db)
        CacheSchema.create(db)
        assertTrue(cache.characters().isEmpty())
    }
}
