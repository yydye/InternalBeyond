package com.internalbeyond.mobile.data.repository

import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.sync.SyncEngine
import com.internalbeyond.mobile.platform.StreamRegistry
import kotlinx.coroutines.CoroutineScope
import java.util.concurrent.ConcurrentHashMap

/**
 * Creates and owns one [ConversationSession] per character.
 *
 * A session is created lazily when a chat is opened and kept afterwards, so
 * returning to a conversation does not lose an in-flight turn — the stream is owned
 * by the session, not by the screen (which is exactly what makes "leave the chat
 * while it is still generating" work).
 */
class ChatRepository(
    private val client: HomeNodeClient,
    private val cache: LocalCache,
    private val sync: SyncEngine,
    private val streams: StreamRegistry,
    private val scope: CoroutineScope,
    private val nodeKey: () -> String,
    private val onFailure: (com.internalbeyond.mobile.domain.ProtocolError) -> Unit,
) {

    private val sessions = ConcurrentHashMap<String, ConversationSession>()

    fun open(characterId: String, threadId: String = ""): ConversationSession =
        sessions.getOrPut(characterId) {
            ConversationSession(
                characterId = characterId,
                threadId = threadId,
                client = client,
                cache = cache,
                sync = sync,
                streams = streams,
                scope = scope,
                nodeKey = nodeKey,
                onFailure = onFailure,
            )
        }

    /** Sessions with unfinished sends, for a foreground resume sweep (Phase 21). */
    fun sessionsWithOpenAttempts(): List<ConversationSession> {
        val characters = cache.openAttempts().map { it.characterId }.distinct()
        return characters.map { open(it) }
    }

    fun closeAll() {
        for (session in sessions.values) session.stop()
        sessions.clear()
    }
}
