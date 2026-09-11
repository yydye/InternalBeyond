package com.internalbeyond.mobile.data.cache

/**
 * The local cache schema.
 *
 * **The cache is not an authority** (Phase 13). Every table here either holds a
 * server-produced DTO verbatim, or holds purely local UI state that the server has
 * never heard of:
 *
 * ```
 * characters            server character DTOs (mobile-safe projection only)
 * conversations         characterId → conversationId, LEARNED from the server
 * messages              server message DTOs, keyed by CANONICAL id
 * message_tombstones    ids the Home Node has deleted, so an older page cannot resurrect them
 * sync_state            the per-Home-Node cursor, so a cold start knows what it has
 * send_attempts         purely local: in-flight sends and their requestIds
 * drafts                purely local: unsent text
 * ```
 *
 * Two consequences worth stating:
 *
 * * the character DTO store holds only fields the server exposes, so a cache read
 *   can never surface a credential that the network path would have withheld;
 * * messages are reduced to their DTO JSON too, so there is no second message
 *   schema to keep in step with the server's projection.
 */
object CacheSchema {

    const val VERSION = 1

    const val TABLE_CHARACTERS = "characters"
    const val TABLE_CONVERSATIONS = "conversations"
    const val TABLE_MESSAGES = "messages"
    const val TABLE_TOMBSTONES = "message_tombstones"
    const val TABLE_SYNC_STATE = "sync_state"
    const val TABLE_ATTEMPTS = "send_attempts"
    const val TABLE_DRAFTS = "drafts"

    val STATEMENTS: List<String> = listOf(
        """
        CREATE TABLE IF NOT EXISTS $TABLE_CHARACTERS (
            id                 TEXT PRIMARY KEY,
            catalog_updated_at INTEGER,
            dto_json           TEXT NOT NULL,
            cached_at          INTEGER NOT NULL
        )
        """.trimIndent(),

        """
        CREATE TABLE IF NOT EXISTS $TABLE_CONVERSATIONS (
            character_id    TEXT NOT NULL,
            thread_id       TEXT NOT NULL DEFAULT '',
            conversation_id TEXT NOT NULL,
            updated_at      INTEGER NOT NULL,
            PRIMARY KEY (character_id, thread_id)
        )
        """.trimIndent(),

        """
        CREATE TABLE IF NOT EXISTS $TABLE_MESSAGES (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            timestamp       INTEGER NOT NULL,
            role            TEXT NOT NULL,
            revision        INTEGER,
            dto_json        TEXT NOT NULL,
            cached_at       INTEGER NOT NULL
        )
        """.trimIndent(),

        "CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON $TABLE_MESSAGES (conversation_id, timestamp)",

        // A tombstone is what makes deletes durable. Without it, "load older page"
        // (which reads a stale server window) could re-insert a message the Home
        // Node has already deleted, and the cache would disagree with the truth.
        """
        CREATE TABLE IF NOT EXISTS $TABLE_TOMBSTONES (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT,
            deleted_at      INTEGER NOT NULL
        )
        """.trimIndent(),

        """
        CREATE TABLE IF NOT EXISTS $TABLE_SYNC_STATE (
            node_key                TEXT PRIMARY KEY,
            cursor                  INTEGER NOT NULL,
            revision                INTEGER,
            catalog_updated_at      INTEGER,
            catalog_confirmed_empty INTEGER NOT NULL DEFAULT 0,
            updated_at              INTEGER NOT NULL
        )
        """.trimIndent(),

        """
        CREATE TABLE IF NOT EXISTS $TABLE_ATTEMPTS (
            request_id           TEXT PRIMARY KEY,
            character_id         TEXT NOT NULL,
            conversation_id      TEXT NOT NULL,
            content              TEXT NOT NULL,
            state                TEXT NOT NULL,
            turn_id              TEXT,
            user_message_id      TEXT,
            assistant_message_id TEXT,
            last_sequence        INTEGER NOT NULL DEFAULT 0,
            partial_text         TEXT,
            reasoning_text       TEXT,
            error_code           TEXT,
            error_message        TEXT,
            created_at           INTEGER NOT NULL,
            updated_at           INTEGER NOT NULL
        )
        """.trimIndent(),

        "CREATE INDEX IF NOT EXISTS idx_attempts_state ON $TABLE_ATTEMPTS (state)",

        """
        CREATE TABLE IF NOT EXISTS $TABLE_DRAFTS (
            conversation_id TEXT PRIMARY KEY,
            text            TEXT NOT NULL,
            updated_at      INTEGER NOT NULL
        )
        """.trimIndent(),
    )

    fun create(db: SqlDatabase) {
        for (statement in STATEMENTS) db.exec(statement)
    }
}
