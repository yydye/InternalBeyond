package com.internalbeyond.mobile.domain.model

/**
 * The mobile-safe Character DTO.
 *
 * This is a MIRROR of the server's projection (`assets/js/mobile-dto.js`,
 * `characterDto`) and nothing more. The Home Node owns the character runtime
 * configuration — provider, endpoint, apiKey, systemPrompt — and none of those
 * fields exist here, on purpose: a field that does not exist cannot be rendered
 * by mistake, cached, or logged. See docs/MOBILE_GATEWAY.md §8.
 *
 * `model` is the one field that looks like it might be a credential and is not:
 * it is a display label the user typed ("DeepSeek-V4.1-Flash"). Knowing a model
 * name grants access to nothing — unlike `endpoint`.
 */
data class Character(
    val id: String,
    val name: String,
    val avatar: String = "",
    val relationship: String = "",
    val handle: String = "",
    val signature: String = "",
    val bio: String = "",
    val banner: String = "",
    val createdAt: Long = 0L,
    val model: String = "",
    val status: String = "active",
    val capabilities: CharacterCapabilities = CharacterCapabilities(),
) {
    val isArchived: Boolean get() = status == "archived"

    /** The letter shown when there is no usable avatar image (Phase 10 "自然降级"). */
    val initial: String
        get() = name.trim().takeIf { it.isNotEmpty() }?.substring(0, 1)?.uppercase() ?: "•"
}

/** What a character supports. Contains no runtime parameters at all. */
data class CharacterCapabilities(
    val chat: Boolean = true,
    val stream: Boolean = true,
    val vision: Boolean = false,
    val webSearch: Boolean = false,
    /** Absent (false) unless the character really has image generation enabled. */
    val imageGen: Boolean = false,
)

/** Attachment metadata only — never pixels. See [ChatMessage]. */
data class ImageMeta(
    val mime: String = "image/jpeg",
    val name: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val size: Long? = null,
    /** The full record exists on the Home Node; this DTO deliberately does not carry it. */
    val inline: Boolean = false,
)

data class FileMeta(
    val name: String,
    val ext: String? = null,
    val size: Long? = null,
)

data class VoiceMeta(
    val mime: String? = null,
    val durationSeconds: Double? = null,
    val transcript: String? = null,
    val inline: Boolean = false,
)

/**
 * A canonical chat message as projected for a device.
 *
 * `id` is the CANONICAL id from the Home Node's store. The client never invents
 * one (Phase 15): an optimistic bubble in the UI is a local send-attempt, not a
 * message row. Runtime-only fields (`reasoning_content`, `wsSearches`, `memOps`,
 * `calNotes`, `upstreamRaw`) are not in this DTO because the server does not
 * send them — and if a future server did, they would simply be ignored here.
 */
data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val timestamp: Long,
    val conversationId: String,
    val threadId: String? = null,
    val senderName: String? = null,
    val images: List<ImageMeta> = emptyList(),
    val files: List<FileMeta> = emptyList(),
    val voice: VoiceMeta? = null,
    val truncated: Boolean = false,
    val withdrawn: Boolean = false,
    val withdrawnBy: String? = null,
    /** Whitelisted display metadata (`model`, `model_id`, `source`, …). */
    val metadata: Map<String, String> = emptyMap(),
    val revision: Long? = null,
) {
    val isUser: Boolean get() = role == "user"

    /** True when this message carries something other than plain text (Phase 33). */
    val hasAttachments: Boolean get() = images.isNotEmpty() || files.isNotEmpty() || voice != null
}

/** One page of `chat.history`, with M1-A's keyset anchors verbatim. */
data class HistoryPage(
    val conversationId: String,
    val messages: List<ChatMessage>,
    val count: Int,
    val cursor: String?,
    val oldest: String?,
    val newest: String?,
    val hasMore: Boolean,
    val hasOlder: Boolean,
    val hasNewer: Boolean,
    val revision: Long?,
) {
    /**
     * The anchor to pass as `cursor=` to fetch the page BEFORE this one.
     * M1-A semantics: `cursor` continues backwards, and `oldest` is the first
     * (oldest) message of the page that was just returned.
     */
    val olderAnchor: String? get() = oldest ?: cursor
}

/** One page of `sync.changes` — M1-A's `changesAfter` exposed directly. */
data class SyncPage(
    val cursor: Long,
    val revision: Long,
    val upserts: List<ChatMessage>,
    val deletes: List<MessageDeletion>,
    val hasMore: Boolean,
    val serverTime: Long,
)

data class MessageDeletion(
    val messageId: String,
    val conversationId: String?,
    val revision: Long?,
)

/** `turns.get` — the status of one generation turn (Phase 19/21). */
data class TurnStatus(
    val turnId: String,
    val requestId: String?,
    val conversationId: String?,
    val characterId: String?,
    /** running | done | error | duplicate */
    val status: String,
    val sequence: Int,
    val userMessageId: String?,
    val assistantMessageId: String?,
    val revision: Long?,
    val duplicate: Boolean,
    val error: String?,
    val replayFrom: Int?,
    val replayTo: Int?,
) {
    val isTerminal: Boolean get() = status != "running"
    val isSuccess: Boolean get() = status == "done" || status == "duplicate"
}

/** Handshake / identity of the connected Home Node. */
data class NodeHandshake(
    val protocol: Int,
    val serverVersion: String,
    val fingerprint: String,
    val dtoVersion: Int,
    val cursorModel: String,
    val capabilities: List<String>,
)

/** The authenticated device's own record. Contains no credential. */
data class DeviceProfile(
    val deviceId: String,
    val name: String,
    val type: String,
    val createdAt: Long,
    val lastSeenAt: Long,
    val revoked: Boolean,
    val tokenVersion: Int,
    val capabilities: List<String>,
    val appForeground: Boolean,
)

/** Minimal presence. Deliberately nothing else is even modelled (Phase 22). */
data class PresenceEntry(
    val deviceId: String,
    val name: String,
    val type: String,
    val online: Boolean,
    val lastSeenAt: Long,
    val appForeground: Boolean,
)
