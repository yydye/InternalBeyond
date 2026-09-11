package com.internalbeyond.mobile.data.api

/**
 * Incremental `text/event-stream` decoder.
 *
 * The transport hands us arbitrary byte chunks; this class turns them into whole
 * frames. It is a pure function of the byte stream — no Android, no OkHttp — so
 * the split-a-frame-across-chunks case and the comment/heartbeat case are unit
 * tested directly rather than discovered on a phone.
 *
 * Implements the subset of the SSE grammar the Home Node actually emits
 * (`services/home-node/mobile-gateway.js: writeStreamFrame`):
 *
 * ```
 * event: chat.delta
 * id: <streamId>:<sequence>
 * data: {"type":…,"sequence":7,"payload":{…}}
 * <blank line>
 * ```
 *
 * plus `: open` / `: ping <t>` comment frames, which carry no data and must not
 * be mistaken for an empty event.
 */
class SseParser {

    data class Frame(
        val event: String?,
        /** `<streamId>:<sequence>` as sent by the server, or a bare sequence. */
        val id: String?,
        val data: String?,
    ) {
        val isCommentOnly: Boolean get() = event == null && data == null

        /** The `sequence` half of the SSE id, when present and numeric. */
        val idSequence: Int?
            get() {
                val text = id ?: return null
                val tail = text.substringAfterLast(':')
                return tail.toIntOrNull()
            }
    }

    private val buffer = StringBuilder()

    /** Feed a chunk; returns every frame that became complete. */
    fun feed(chunk: String): List<Frame> {
        if (chunk.isEmpty()) return emptyList()
        // Normalise CRLF so the terminator check below covers both dialects.
        buffer.append(chunk.replace("\r\n", "\n").replace('\r', '\n'))
        val frames = ArrayList<Frame>()
        while (true) {
            val index = buffer.indexOf("\n\n")
            if (index < 0) break
            val block = buffer.substring(0, index)
            buffer.delete(0, index + 2)
            parseBlock(block)?.let { frames.add(it) }
        }
        return frames
    }

    /** At end of stream: a trailing block without its blank-line terminator. */
    fun flush(): List<Frame> {
        if (buffer.isEmpty()) return emptyList()
        val block = buffer.toString()
        buffer.setLength(0)
        return listOfNotNull(parseBlock(block))
    }

    private fun parseBlock(block: String): Frame? {
        if (block.isEmpty()) return null
        var event: String? = null
        var id: String? = null
        val data = StringBuilder()
        var sawField = false
        for (line in block.split('\n')) {
            when {
                line.startsWith(":") -> Unit // comment / heartbeat
                line.startsWith("event:") -> {
                    event = line.substring(6).trim()
                    sawField = true
                }
                line.startsWith("id:") -> {
                    id = line.substring(3).trim()
                    sawField = true
                }
                line.startsWith("data:") -> {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substring(5).trim())
                    sawField = true
                }
                // Unknown fields (e.g. `retry:`) are ignored per spec.
                else -> Unit
            }
        }
        if (!sawField) return null
        return Frame(event = event, id = id, data = if (data.isEmpty()) null else data.toString())
    }
}
