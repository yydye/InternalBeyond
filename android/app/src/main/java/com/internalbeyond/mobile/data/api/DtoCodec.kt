package com.internalbeyond.mobile.data.api

import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.CharacterCapabilities
import com.internalbeyond.mobile.domain.model.DeviceProfile
import com.internalbeyond.mobile.domain.model.FileMeta
import com.internalbeyond.mobile.domain.model.HistoryPage
import com.internalbeyond.mobile.domain.model.ImageMeta
import com.internalbeyond.mobile.domain.model.MessageDeletion
import com.internalbeyond.mobile.domain.model.NodeHandshake
import com.internalbeyond.mobile.domain.model.PresenceEntry
import com.internalbeyond.mobile.domain.model.SyncPage
import com.internalbeyond.mobile.domain.model.TurnStatus
import com.internalbeyond.mobile.domain.model.VoiceMeta
import org.json.JSONArray
import org.json.JSONObject

/**
 * Wire DTO ⇄ domain model.
 *
 * Mirrors `assets/js/mobile-dto.js` field for field. The mirror is necessary
 * (there is no shared code between Kotlin and Node) but it is *checked*: the
 * integration test drives the real Home Node and asserts the concrete values the
 * `test_mobile_thin_client.js` suite asserts, so a divergence fails a test rather
 * than a user.
 *
 * Parsing is tolerant of MISSING fields (the server omits empty ones) and
 * oblivious to UNKNOWN ones — the latter is the important half: a field this
 * client does not model cannot be rendered, cached, or logged.
 */
object DtoCodec {

    // ── messages ─────────────────────────────────────────────────────────────

    /** Whitelist copied from `mobile-dto.js: MESSAGE_METADATA_KEYS`. */
    private val METADATA_KEYS = listOf(
        "model", "model_id", "config_id", "showThinking", "source", "eventType", "characterId", "waifu",
    )

    fun message(obj: JSONObject): ChatMessage = ChatMessage(
        id = obj.strOrNull("id") ?: "",
        role = obj.strOrNull("role") ?: "",
        content = obj.strOrNull("content") ?: "",
        timestamp = obj.longOrNull("timestamp") ?: 0L,
        conversationId = obj.strOrNull("conversationId") ?: "",
        threadId = obj.textOrNull("threadId"),
        senderName = obj.textOrNull("senderName"),
        images = obj.arrOrNull("images")?.objects()?.map(::imageMeta) ?: emptyList(),
        files = obj.arrOrNull("files")?.objects()?.map(::fileMeta) ?: emptyList(),
        voice = obj.objOrNull("voice")?.let(::voiceMeta),
        truncated = obj.boolOrNull("truncated") ?: false,
        withdrawn = obj.boolOrNull("withdrawn") ?: false,
        withdrawnBy = obj.textOrNull("withdrawnBy"),
        metadata = metadataOf(obj.objOrNull("metadata")),
        revision = obj.longOrNull("revision"),
    )

    /** Round-trips [message] exactly as far as the cache is concerned. */
    fun messageToJson(m: ChatMessage): JSONObject {
        val out = JSONObject()
            .put("id", m.id)
            .put("role", m.role)
            .put("content", m.content)
            .put("timestamp", m.timestamp)
            .put("conversationId", m.conversationId)
        m.threadId?.let { out.put("threadId", it) }
        m.senderName?.let { out.put("senderName", it) }
        if (m.images.isNotEmpty()) out.put("images", JSONArray(m.images.map(::imageMetaToJson)))
        if (m.files.isNotEmpty()) out.put("files", JSONArray(m.files.map(::fileMetaToJson)))
        m.voice?.let { out.put("voice", voiceMetaToJson(it)) }
        if (m.truncated) out.put("truncated", true)
        if (m.withdrawn) {
            out.put("withdrawn", true)
            m.withdrawnBy?.let { out.put("withdrawnBy", it) }
        }
        if (m.metadata.isNotEmpty()) out.put("metadata", JSONObject(m.metadata as Map<*, *>))
        m.revision?.let { out.put("revision", it) }
        return out
    }

    private fun metadataOf(obj: JSONObject?): Map<String, String> {
        if (obj == null) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (key in METADATA_KEYS) {
            if (!obj.has(key) || obj.isNull(key)) continue
            val value = obj.opt(key)
            if (value == null || value == JSONObject.NULL) continue
            out[key] = value.toString()
        }
        return out
    }

    private fun imageMeta(obj: JSONObject): ImageMeta = ImageMeta(
        mime = obj.textOrNull("mime") ?: "image/jpeg",
        name = obj.textOrNull("name"),
        width = obj.intOrNull("width"),
        height = obj.intOrNull("height"),
        size = obj.longOrNull("size"),
        inline = obj.boolOrNull("inline") ?: false,
    )

    private fun imageMetaToJson(m: ImageMeta): JSONObject {
        val out = JSONObject().put("mime", m.mime).put("inline", m.inline)
        m.name?.let { out.put("name", it) }
        m.width?.let { out.put("width", it) }
        m.height?.let { out.put("height", it) }
        m.size?.let { out.put("size", it) }
        return out
    }

    private fun fileMeta(obj: JSONObject): FileMeta = FileMeta(
        name = obj.strOrNull("name") ?: "",
        ext = obj.textOrNull("ext"),
        size = obj.longOrNull("size"),
    )

    private fun fileMetaToJson(f: FileMeta): JSONObject {
        val out = JSONObject().put("name", f.name)
        f.ext?.let { out.put("ext", it) }
        f.size?.let { out.put("size", it) }
        return out
    }

    private fun voiceMeta(obj: JSONObject): VoiceMeta = VoiceMeta(
        mime = obj.textOrNull("mime"),
        durationSeconds = obj.doubleOrNull("duration"),
        transcript = obj.textOrNull("transcript"),
        inline = obj.boolOrNull("inline") ?: false,
    )

    private fun voiceMetaToJson(v: VoiceMeta): JSONObject {
        val out = JSONObject()
        v.mime?.let { out.put("mime", it) }
        v.durationSeconds?.let { out.put("duration", it) }
        v.transcript?.let { out.put("transcript", it) }
        if (v.inline) out.put("inline", true)
        return out
    }

    // ── characters ───────────────────────────────────────────────────────────

    fun character(obj: JSONObject): Character {
        val caps = obj.objOrNull("capabilities")
        return Character(
            id = obj.strOrNull("id") ?: "",
            // Same three-level fallback as the server, so a DTO that came back
            // from the cache (where `nickname` no longer exists) keeps its name.
            name = obj.textOrNull("name") ?: obj.textOrNull("model") ?: "AI",
            avatar = obj.strOrNull("avatar") ?: "",
            relationship = obj.strOrNull("relationship") ?: "",
            handle = obj.strOrNull("handle") ?: "",
            signature = obj.strOrNull("signature") ?: "",
            bio = obj.strOrNull("bio") ?: "",
            banner = obj.strOrNull("banner") ?: "",
            createdAt = obj.longOrNull("createdAt") ?: 0L,
            model = obj.strOrNull("model") ?: "",
            status = obj.textOrNull("status") ?: "active",
            capabilities = CharacterCapabilities(
                chat = caps?.boolOrNull("chat") ?: true,
                stream = caps?.boolOrNull("stream") ?: true,
                vision = caps?.boolOrNull("vision") ?: false,
                webSearch = caps?.boolOrNull("webSearch") ?: false,
                imageGen = caps?.boolOrNull("imageGen") ?: false,
            ),
        )
    }

    fun characterToJson(c: Character): JSONObject {
        val caps = JSONObject()
            .put("chat", c.capabilities.chat)
            .put("stream", c.capabilities.stream)
            .put("vision", c.capabilities.vision)
            .put("webSearch", c.capabilities.webSearch)
        if (c.capabilities.imageGen) caps.put("imageGen", true)
        return JSONObject()
            .put("id", c.id)
            .put("name", c.name)
            .put("avatar", c.avatar)
            .put("relationship", c.relationship)
            .put("handle", c.handle)
            .put("signature", c.signature)
            .put("bio", c.bio)
            .put("banner", c.banner)
            .put("createdAt", c.createdAt)
            .put("model", c.model)
            .put("status", c.status)
            .put("capabilities", caps)
    }

    // ── pages and status payloads ────────────────────────────────────────────

    fun historyPage(payload: JSONObject): HistoryPage = HistoryPage(
        conversationId = payload.strOrNull("conversationId") ?: "",
        messages = payload.arrOrNull("messages")?.objects()?.map(::message) ?: emptyList(),
        count = payload.intOrNull("count") ?: 0,
        cursor = anchorId(payload.opt("cursor")),
        oldest = anchorId(payload.opt("oldest")),
        newest = anchorId(payload.opt("newest")),
        hasMore = payload.boolOrNull("hasMore") ?: false,
        hasOlder = payload.boolOrNull("hasOlder") ?: false,
        hasNewer = payload.boolOrNull("hasNewer") ?: false,
        revision = payload.longOrNull("revision"),
    )

    fun syncPage(payload: JSONObject): SyncPage = SyncPage(
        cursor = payload.longOrNull("cursor") ?: 0L,
        revision = payload.longOrNull("revision") ?: 0L,
        upserts = payload.arrOrNull("upserts")?.objects()?.map(::message) ?: emptyList(),
        deletes = payload.arrOrNull("deletes")?.objects()?.map {
            MessageDeletion(
                messageId = it.strOrNull("messageId") ?: "",
                conversationId = it.textOrNull("conversationId"),
                revision = it.longOrNull("revision"),
            )
        } ?: emptyList(),
        hasMore = payload.boolOrNull("hasMore") ?: false,
        serverTime = payload.longOrNull("serverTime") ?: 0L,
    )

    /** M1-A pagination anchors are `{id, timestamp}` objects, or a bare id. */
    private fun anchorId(value: Any?): String? = when (value) {
        null -> null
        is JSONObject -> value.textOrNull("id")
        else -> value.toString().takeIf { it.isNotEmpty() && it != "null" }
    }

    fun turnStatus(payload: JSONObject): TurnStatus = TurnStatus(
        turnId = payload.strOrNull("turnId") ?: "",
        requestId = payload.textOrNull("requestId"),
        conversationId = payload.textOrNull("conversationId"),
        characterId = payload.textOrNull("characterId"),
        status = payload.textOrNull("status") ?: "unknown",
        sequence = payload.intOrNull("sequence") ?: 0,
        userMessageId = payload.textOrNull("userMessageId"),
        assistantMessageId = payload.textOrNull("assistantMessageId"),
        revision = payload.longOrNull("revision"),
        duplicate = payload.boolOrNull("duplicate") ?: false,
        error = payload.textOrNull("error"),
        replayFrom = payload.intOrNull("replayFrom"),
        replayTo = payload.intOrNull("replayTo"),
    )

    fun handshake(payload: JSONObject): NodeHandshake = NodeHandshake(
        protocol = payload.intOrNull("protocol") ?: 0,
        serverVersion = payload.strOrNull("serverVersion") ?: "",
        fingerprint = payload.strOrNull("fingerprint") ?: "",
        dtoVersion = payload.intOrNull("dtoVersion") ?: 0,
        cursorModel = payload.objOrNull("sync")?.textOrNull("cursorModel") ?: "",
        capabilities = payload.arrOrNull("capabilities")?.strings() ?: emptyList(),
    )

    fun deviceProfile(obj: JSONObject): DeviceProfile = DeviceProfile(
        deviceId = obj.strOrNull("deviceId") ?: "",
        name = obj.strOrNull("name") ?: "",
        type = obj.strOrNull("type") ?: "",
        createdAt = obj.longOrNull("createdAt") ?: 0L,
        lastSeenAt = obj.longOrNull("lastSeenAt") ?: 0L,
        revoked = obj.boolOrNull("revoked") ?: false,
        tokenVersion = obj.intOrNull("tokenVersion") ?: 0,
        capabilities = obj.arrOrNull("capabilities")?.strings() ?: emptyList(),
        appForeground = obj.boolOrNull("appForeground") ?: false,
    )

    fun presence(obj: JSONObject): PresenceEntry = PresenceEntry(
        deviceId = obj.strOrNull("deviceId") ?: "",
        name = obj.strOrNull("name") ?: "",
        type = obj.strOrNull("type") ?: "",
        online = obj.boolOrNull("online") ?: false,
        lastSeenAt = obj.longOrNull("lastSeenAt") ?: 0L,
        appForeground = obj.boolOrNull("appForeground") ?: false,
    )
}
