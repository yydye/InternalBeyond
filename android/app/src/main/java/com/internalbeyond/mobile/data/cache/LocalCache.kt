package com.internalbeyond.mobile.data.cache

import com.internalbeyond.mobile.data.api.DtoCodec
import com.internalbeyond.mobile.domain.model.AttemptState
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.MessageDeletion
import com.internalbeyond.mobile.domain.model.SendAttempt
import org.json.JSONObject

/** The per-Home-Node sync cursor (Phase 14). One row per Home Node endpoint. */
data class SyncState(
    val nodeKey: String,
    val cursor: Long = 0L,
    val revision: Long = 0L,
    val catalogUpdatedAt: Long? = null,
    /**
     * Set when the Home Node has authoritatively told us its catalog is empty.
     * The cache is deliberately NOT deleted in that case (Phase 11) — this flag is
     * how the UI distinguishes "nothing published yet" from "nothing fetched yet".
     */
    val catalogConfirmedEmpty: Boolean = false,
    val updatedAt: Long = 0L,
)

data class CacheStats(
    val characters: Int,
    val messages: Int,
    val conversations: Int,
    val openAttempts: Int,
    val drafts: Int,
)

/**
 * The local cache.
 *
 * Two rules are enforced here rather than left to callers:
 *
 * * **[upsertMessages] respects tombstones.** A message the Home Node deleted
 *   cannot be brought back by a later history page.
 * * **[replaceCharacters] refuses an empty list.** Publish has replace semantics on
 *   the server; a transient empty answer must not silently empty the phone.
 */
class LocalCache(
    private val db: SqlDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    // ── characters ───────────────────────────────────────────────────────────

    /**
     * Replace the cached catalog.
     *
     * Returns the number of characters written. An EMPTY list is a no-op by
     * design: the desktop never publishes an empty catalog (it would wipe the Home
     * Node's), so an empty read means "not fetched / not published", not "the user
     * deleted every character".
     */
    fun replaceCharacters(characters: List<Character>, catalogUpdatedAt: Long?): Int {
        if (characters.isEmpty()) return 0
        val now = clock()
        db.transaction {
            db.exec("DELETE FROM ${CacheSchema.TABLE_CHARACTERS}")
            for (character in characters) {
                db.exec(
                    "INSERT OR REPLACE INTO ${CacheSchema.TABLE_CHARACTERS} " +
                        "(id, catalog_updated_at, dto_json, cached_at) VALUES (?, ?, ?, ?)",
                    listOf(character.id, catalogUpdatedAt, DtoCodec.characterToJson(character).toString(), now),
                )
            }
        }
        return characters.size
    }

    /**
     * Cached characters, in the order the desktop published them (which is its
     * `apiConfigs` order). `rowid` is the right ordering key here: the table has no
     * sortable display column, and insertion order is the server's order because
     * the whole table is rewritten from one response.
     */
    fun characters(): List<Character> =
        db.query(
            "SELECT dto_json FROM ${CacheSchema.TABLE_CHARACTERS} ORDER BY rowid ASC",
        ) { row -> DtoCodec.character(JSONObject(row.getString(0))) }

    fun character(id: String): Character? =
        db.query(
            "SELECT dto_json FROM ${CacheSchema.TABLE_CHARACTERS} WHERE id = ?",
            listOf(id),
        ) { row -> DtoCodec.character(JSONObject(row.getString(0))) }.firstOrNull()

    /**
     * Drop the cached catalog deliberately.
     *
     * Separate from [replaceCharacters] precisely because that one refuses an empty
     * list — an explicit forget is the only way to empty this table, so it can never
     * happen as a side effect of a network answer.
     */
    fun clearCharacters() {
        db.exec("DELETE FROM ${CacheSchema.TABLE_CHARACTERS}")
    }

    // ── conversations ────────────────────────────────────────────────────────

    /**
     * Remember the conversation id a `(characterId, threadId)` pair maps to.
     *
     * The mapping is LEARNED from the server (`chat.history` returns
     * `conversationId`; `chat.start`/`chat.done` carry it too). The client does not
     * synthesise it, because the shape of a conversation id is the Home Node's
     * business — duplicating that rule here would be a second implementation of a
     * server detail, which is exactly the kind of drift M1-A banned.
     */
    fun bindConversation(characterId: String, threadId: String, conversationId: String) {
        if (characterId.isEmpty() || conversationId.isEmpty()) return
        db.exec(
            "INSERT OR REPLACE INTO ${CacheSchema.TABLE_CONVERSATIONS} " +
                "(character_id, thread_id, conversation_id, updated_at) VALUES (?, ?, ?, ?)",
            listOf(characterId, threadId, conversationId, clock()),
        )
    }

    fun conversationId(characterId: String, threadId: String = ""): String? =
        db.query(
            "SELECT conversation_id FROM ${CacheSchema.TABLE_CONVERSATIONS} " +
                "WHERE character_id = ? AND thread_id = ?",
            listOf(characterId, threadId),
        ) { row -> row.getString(0) }.firstOrNull()

    // ── messages ─────────────────────────────────────────────────────────────

    /**
     * Insert or update server messages.
     *
     * Ordering note: the canonical order is `(timestamp, insert_seq)`, and
     * `insert_seq` is not part of the mobile DTO. Ordering falls back to
     * `(timestamp, id)`, which is deterministic. Two messages in one conversation
     * with the same millisecond timestamp could therefore display in a different
     * order than the server would — irrelevant for a cache whose content is
     * re-fetched a moment later, and never a correctness issue for sync, which
     * applies messages by id.
     */
    fun upsertMessages(messages: List<ChatMessage>): Int {
        if (messages.isEmpty()) return 0
        val now = clock()
        var applied = 0
        db.transaction {
            for (message in messages) {
                if (message.id.isEmpty()) continue
                if (isTombstoned(message.id)) continue
                db.exec(
                    "INSERT OR REPLACE INTO ${CacheSchema.TABLE_MESSAGES} " +
                        "(id, conversation_id, timestamp, role, revision, dto_json, cached_at) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    listOf(
                        message.id,
                        message.conversationId,
                        message.timestamp,
                        message.role,
                        message.revision,
                        DtoCodec.messageToJson(message).toString(),
                        now,
                    ),
                )
                applied++
            }
        }
        return applied
    }

    /** The newest [limit] messages of a conversation, returned oldest-first. */
    fun messages(conversationId: String, limit: Int = 50): List<ChatMessage> {
        // The LIMIT is interpolated rather than bound: Android passes every bind
        // argument as TEXT, and SQLite's LIMIT wants an integer. It is a coerced
        // Int constant from this class, never user input.
        val capped = limit.coerceIn(1, MAX_PAGE)
        val rows = db.query(
            "SELECT dto_json FROM ${CacheSchema.TABLE_MESSAGES} WHERE conversation_id = ? " +
                "ORDER BY timestamp DESC, id DESC LIMIT $capped",
            listOf(conversationId),
        ) { row -> DtoCodec.message(JSONObject(row.getString(0))) }
        return rows.asReversed()
    }

    fun message(id: String): ChatMessage? =
        db.query(
            "SELECT dto_json FROM ${CacheSchema.TABLE_MESSAGES} WHERE id = ?",
            listOf(id),
        ) { row -> DtoCodec.message(JSONObject(row.getString(0))) }.firstOrNull()

    fun messageCount(conversationId: String): Int =
        db.query(
            "SELECT COUNT(*) FROM ${CacheSchema.TABLE_MESSAGES} WHERE conversation_id = ?",
            listOf(conversationId),
        ) { row -> row.getInt(0) }.firstOrNull() ?: 0

    /**
     * Apply `sync.changes` deletes. The delete AND its tombstone are written in one
     * transaction so a crash cannot leave one without the other.
     */
    fun applyDeletes(deletes: List<MessageDeletion>): Int {
        if (deletes.isEmpty()) return 0
        val now = clock()
        var applied = 0
        db.transaction {
            for (deletion in deletes) {
                if (deletion.messageId.isEmpty()) continue
                db.exec("DELETE FROM ${CacheSchema.TABLE_MESSAGES} WHERE id = ?", listOf(deletion.messageId))
                db.exec(
                    "INSERT OR REPLACE INTO ${CacheSchema.TABLE_TOMBSTONES} (id, conversation_id, deleted_at) " +
                        "VALUES (?, ?, ?)",
                    listOf(deletion.messageId, deletion.conversationId, now),
                )
                applied++
            }
        }
        return applied
    }

    fun isTombstoned(messageId: String): Boolean =
        db.query(
            "SELECT 1 FROM ${CacheSchema.TABLE_TOMBSTONES} WHERE id = ?",
            listOf(messageId),
        ) { row -> row.getInt(0) }.isNotEmpty()

    // ── sync cursor ──────────────────────────────────────────────────────────

    fun syncState(nodeKey: String): SyncState =
        db.query(
            "SELECT cursor, revision, catalog_updated_at, catalog_confirmed_empty, updated_at " +
                "FROM ${CacheSchema.TABLE_SYNC_STATE} WHERE node_key = ?",
            listOf(nodeKey),
        ) { row ->
            SyncState(
                nodeKey = nodeKey,
                cursor = row.getLong(0),
                revision = row.longOrNull(1) ?: 0L,
                catalogUpdatedAt = row.longOrNull(2),
                catalogConfirmedEmpty = row.getInt(3) != 0,
                updatedAt = row.getLong(4),
            )
        }.firstOrNull() ?: SyncState(nodeKey = nodeKey)

    fun saveSyncState(state: SyncState) {
        db.exec(
            "INSERT OR REPLACE INTO ${CacheSchema.TABLE_SYNC_STATE} " +
                "(node_key, cursor, revision, catalog_updated_at, catalog_confirmed_empty, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
            listOf(
                state.nodeKey,
                state.cursor,
                state.revision,
                state.catalogUpdatedAt,
                if (state.catalogConfirmedEmpty) 1 else 0,
                clock(),
            ),
        )
    }

    // ── send attempts (purely local state) ───────────────────────────────────

    fun saveAttempt(attempt: SendAttempt) {
        val now = clock()
        db.exec(
            "INSERT OR REPLACE INTO ${CacheSchema.TABLE_ATTEMPTS} " +
                "(request_id, character_id, conversation_id, content, state, turn_id, user_message_id, " +
                "assistant_message_id, last_sequence, partial_text, reasoning_text, error_code, " +
                "error_message, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            listOf(
                attempt.requestId,
                attempt.characterId,
                attempt.conversationId,
                attempt.content,
                attempt.state.name,
                attempt.turnId,
                attempt.userMessageId,
                attempt.assistantMessageId,
                attempt.lastSequence,
                attempt.partialText,
                attempt.reasoningText,
                attempt.errorCode,
                attempt.errorMessage,
                if (attempt.createdAt == 0L) now else attempt.createdAt,
                now,
            ),
        )
    }

    fun attempt(requestId: String): SendAttempt? =
        db.query(ATTEMPT_SELECT + " WHERE request_id = ?", listOf(requestId), ::attemptFrom).firstOrNull()

    /**
     * Attempts that have not reached a terminal state — the restart recovery set.
     *
     * Keyed by characterId, not by conversationId: an attempt is created BEFORE the
     * conversation id is known (the client learns it from `chat.start`/`chat.done`),
     * so filtering on conversationId would lose exactly the sends that need recovery.
     */
    fun openAttempts(): List<SendAttempt> =
        db.query(
            ATTEMPT_SELECT + " WHERE state NOT IN (?, ?) ORDER BY created_at ASC",
            listOf(AttemptState.DONE.name, AttemptState.FAILED.name),
            ::attemptFrom,
        )

    fun attemptsFor(characterId: String, limit: Int = 50): List<SendAttempt> {
        val capped = limit.coerceIn(1, MAX_PAGE)
        return db.query(
            ATTEMPT_SELECT + " WHERE character_id = ? ORDER BY created_at DESC LIMIT $capped",
            listOf(characterId),
            ::attemptFrom,
        ).asReversed()
    }

    fun deleteAttempt(requestId: String) {
        db.exec("DELETE FROM ${CacheSchema.TABLE_ATTEMPTS} WHERE request_id = ?", listOf(requestId))
    }

    /** Housekeeping: drop attempts that ended a while ago and are no longer needed. */
    fun pruneAttempts(olderThanMs: Long): Int {
        val cutoff = clock() - olderThanMs
        val before = countTable(CacheSchema.TABLE_ATTEMPTS)
        db.exec(
            "DELETE FROM ${CacheSchema.TABLE_ATTEMPTS} WHERE state IN (?, ?) AND updated_at < ?",
            listOf(AttemptState.DONE.name, AttemptState.FAILED.name, cutoff),
        )
        return before - countTable(CacheSchema.TABLE_ATTEMPTS)
    }

    // ── drafts ───────────────────────────────────────────────────────────────

    fun draft(conversationId: String): String =
        db.query(
            "SELECT text FROM ${CacheSchema.TABLE_DRAFTS} WHERE conversation_id = ?",
            listOf(conversationId),
        ) { row -> row.getString(0) }.firstOrNull() ?: ""

    fun saveDraft(conversationId: String, text: String) {
        if (text.isEmpty()) {
            clearDraft(conversationId)
            return
        }
        db.exec(
            "INSERT OR REPLACE INTO ${CacheSchema.TABLE_DRAFTS} (conversation_id, text, updated_at) VALUES (?, ?, ?)",
            listOf(conversationId, text, clock()),
        )
    }

    fun clearDraft(conversationId: String) {
        db.exec("DELETE FROM ${CacheSchema.TABLE_DRAFTS} WHERE conversation_id = ?", listOf(conversationId))
    }

    // ── maintenance ──────────────────────────────────────────────────────────

    /**
     * Forget everything about the Home Node: cached messages and characters, the
     * cursor, drafts and attempt history. Used by Phase 23's opt-in "also delete
     * cached data" and by `DEVICE_REVOKED` handling where the credential is gone.
     *
     * The credential itself is NOT touched here — it lives in [com.internalbeyond.mobile.data.auth],
     * and keeping the two clearances separate is deliberate.
     */
    fun clearAll() {
        db.transaction {
            for (table in listOf(
                CacheSchema.TABLE_MESSAGES,
                CacheSchema.TABLE_TOMBSTONES,
                CacheSchema.TABLE_CHARACTERS,
                CacheSchema.TABLE_CONVERSATIONS,
                CacheSchema.TABLE_SYNC_STATE,
                CacheSchema.TABLE_ATTEMPTS,
                CacheSchema.TABLE_DRAFTS,
            )) {
                db.exec("DELETE FROM $table")
            }
        }
    }

    fun stats(): CacheStats = CacheStats(
        characters = countTable(CacheSchema.TABLE_CHARACTERS),
        messages = countTable(CacheSchema.TABLE_MESSAGES),
        conversations = db.query(
            "SELECT COUNT(DISTINCT conversation_id) FROM ${CacheSchema.TABLE_MESSAGES}",
        ) { row -> row.getInt(0) }.firstOrNull() ?: 0,
        openAttempts = db.query(
            "SELECT COUNT(*) FROM ${CacheSchema.TABLE_ATTEMPTS} WHERE state NOT IN (?, ?)",
            listOf(AttemptState.DONE.name, AttemptState.FAILED.name),
        ) { row -> row.getInt(0) }.firstOrNull() ?: 0,
        drafts = countTable(CacheSchema.TABLE_DRAFTS),
    )

    private fun countTable(table: String): Int =
        db.query("SELECT COUNT(*) FROM $table") { row -> row.getInt(0) }.firstOrNull() ?: 0

    private fun attemptFrom(row: SqlRow): SendAttempt = SendAttempt(
        requestId = row.stringOrNull(0) ?: "",
        characterId = row.stringOrNull(1) ?: "",
        conversationId = row.stringOrNull(2) ?: "",
        content = row.stringOrNull(3) ?: "",
        state = AttemptState.parse(row.stringOrNull(4)),
        turnId = row.stringOrNull(5),
        userMessageId = row.stringOrNull(6),
        assistantMessageId = row.stringOrNull(7),
        lastSequence = row.getInt(8),
        partialText = row.stringOrNull(9) ?: "",
        reasoningText = row.stringOrNull(10) ?: "",
        errorCode = row.stringOrNull(11),
        errorMessage = row.stringOrNull(12),
        createdAt = row.getLong(13),
        updatedAt = row.getLong(14),
    )

    companion object {
        /** Matches the gateway's own ceiling for a history page (max 500). */
        private const val MAX_PAGE = 500

        private const val ATTEMPT_COLUMNS =
            "request_id, character_id, conversation_id, content, state, turn_id, user_message_id, " +
                "assistant_message_id, last_sequence, partial_text, reasoning_text, error_code, " +
                "error_message, created_at, updated_at"

        private const val ATTEMPT_SELECT = "SELECT $ATTEMPT_COLUMNS FROM ${CacheSchema.TABLE_ATTEMPTS}"
    }
}
