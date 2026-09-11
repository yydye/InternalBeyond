package com.internalbeyond.mobile.platform

/**
 * Structured logging with a redaction pass (Phase 35).
 *
 * Three deliberate design choices, because "remember not to log the token" is not
 * a control:
 *
 * 1. **No free-text overload.** Events are a name plus named fields
 *    (`endpoint`, `requestId`, `turnId`, `status`, `sequence`, `latencyMs`, `code`).
 *    There is no `log(String)` that a message body could be passed to by accident.
 * 2. **A redaction pass runs on every value.** Anything shaped like a credential
 *    (`ibd1_…`, a long base64url run, `sk-…`, a Bearer header) is replaced before
 *    it reaches the sink — so even a careless future call site cannot emit one.
 * 3. **The sink is injectable and silent by default.** Release installs no sink at
 *    all; the integration test installs a recording sink and asserts afterwards
 *    that no secret appeared.
 */
object IbLog {

    enum class Level { DEBUG, INFO, WARN, ERROR }

    fun interface Sink {
        fun log(level: Level, event: String, fields: Map<String, String>)
    }

    /** Names of the fields this app is allowed to log. Keeps call sites honest. */
    const val FIELD_ENDPOINT = "endpoint"
    const val FIELD_REQUEST_ID = "requestId"
    const val FIELD_TURN_ID = "turnId"
    const val FIELD_STATUS = "status"
    const val FIELD_SEQUENCE = "sequence"
    const val FIELD_LATENCY_MS = "latencyMs"
    const val FIELD_CODE = "code"
    const val FIELD_COUNT = "count"
    const val FIELD_DETAIL = "detail"

    @Volatile
    var enabled: Boolean = false

    @Volatile
    var sink: Sink = Sink { _, _, _ -> }

    private val SECRET_PATTERNS = listOf(
        Regex("""ibd\d+_[A-Za-z0-9_\-]{8,}"""),          // device token
        Regex("""pair_[A-Za-z0-9_\-]{8,}"""),            // pairing id
        Regex("""sk-[A-Za-z0-9_\-]{8,}"""),              // provider API key
        Regex("""Bearer\s+\S+""", RegexOption.IGNORE_CASE),
        Regex("""\b[A-Za-z0-9_\-]{40,}\b"""),            // long opaque secret / base64 secret
    )

    /** Exposed so the redaction itself can be unit tested. */
    fun sanitize(value: String): String {
        var out = value
        for (pattern in SECRET_PATTERNS) {
            out = pattern.replace(out, "«redacted»")
        }
        return out
    }

    fun debug(event: String, vararg fields: Pair<String, Any?>) = emit(Level.DEBUG, event, fields)
    fun info(event: String, vararg fields: Pair<String, Any?>) = emit(Level.INFO, event, fields)
    fun warn(event: String, vararg fields: Pair<String, Any?>) = emit(Level.WARN, event, fields)
    fun error(event: String, vararg fields: Pair<String, Any?>) = emit(Level.ERROR, event, fields)

    private fun emit(level: Level, event: String, fields: Array<out Pair<String, Any?>>) {
        if (!enabled) return
        val sanitized = LinkedHashMap<String, String>(fields.size)
        for ((key, value) in fields) {
            sanitized[key] = sanitize(value?.toString() ?: "null")
        }
        sink.log(level, sanitize(event), sanitized)
    }

    /** Test helper: capture into a list and return the text. */
    fun recordingSink(into: MutableList<String>): Sink = Sink { level, event, fields ->
        into.add(
            level.name + " " + event +
                (if (fields.isEmpty()) "" else " " + fields.entries.joinToString(" ") { "${it.key}=${it.value}" }),
        )
    }
}
