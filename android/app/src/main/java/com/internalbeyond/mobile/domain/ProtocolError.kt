package com.internalbeyond.mobile.domain

/**
 * Every way a Home Node interaction can fail, as a closed set.
 *
 * The point of this type is that the UI never has to say "HTTP 400" and never
 * has to parse an English message to decide what to do (Phase 5/34). A caller
 * branches on [code]; the human wording lives in [ErrorPresentation].
 */
sealed class ProtocolError {

    /** The protocol's error code, or a local pseudo-code for non-server failures. */
    abstract val code: String

    /** Server-supplied stable text (never a stack trace — the server strips those). */
    abstract val message: String

    /** Whether retrying the SAME request could plausibly succeed. */
    abstract val retryable: Boolean

    /**
     * A structured error from the server's closed vocabulary
     * (docs/MOBILE_GATEWAY.md §7.3).
     */
    data class Server(
        override val code: String,
        override val message: String,
        override val retryable: Boolean,
        val detail: String? = null,
        val httpStatus: Int = 0,
        val retryAfterMs: Long? = null,
    ) : ProtocolError()

    /** The server answered, but not in protocol v1: wrong `v`, or unparsable body. */
    data class Response(
        val detail: String,
        val httpStatus: Int = 0,
    ) : ProtocolError() {
        override val code: String = MALFORMED
        override val message: String = detail
        override val retryable: Boolean = false
    }

    /** No usable HTTP response at all — the request never produced an answer. */
    data class Transport(
        val kind: TransportKind,
        val detail: String,
    ) : ProtocolError() {
        override val code: String get() = kind.code
        override val message: String get() = detail
        override val retryable: Boolean get() = kind.retryable
    }

    /** A precondition failed locally; nothing was sent. */
    data class Local(val detail: String) : ProtocolError() {
        override val code: String = LOCAL
        override val message: String = detail
        override val retryable: Boolean = false
    }

    companion object {
        const val MALFORMED = "MALFORMED_RESPONSE"
        const val LOCAL = "LOCAL"

        /* ── The server's closed vocabulary, spelled out so that a typo in a
              comparison becomes a compile error rather than a silent miss. ── */
        const val AUTH_REQUIRED = "AUTH_REQUIRED"
        const val AUTH_INVALID = "AUTH_INVALID"
        const val DEVICE_REVOKED = "DEVICE_REVOKED"
        const val PAIRING_INVALID = "PAIRING_INVALID"
        const val PAIRING_EXPIRED = "PAIRING_EXPIRED"
        const val PAIRING_USED = "PAIRING_USED"
        const val PAIRING_NOT_FOUND = "PAIRING_NOT_FOUND"
        const val BAD_VERSION = "BAD_VERSION"
        const val BAD_REQUEST = "BAD_REQUEST"
        const val UNKNOWN_VERB = "UNKNOWN_VERB"
        const val NOT_FOUND = "NOT_FOUND"
        const val BUSY = "BUSY"
        const val CONFLICT = "CONFLICT"
        const val RATE_LIMITED = "RATE_LIMITED"
        const val TOO_LARGE = "TOO_LARGE"
        const val UNSUPPORTED = "UNSUPPORTED"
        const val INTERNAL = "INTERNAL"

        /**
         * Not from the v1 envelope. The Home Node answers a few requests with the
         * pre-envelope shape `{"ok":false,"error":"loopback-only"}` — emitted by
         * `services/home-node/http.js` before routing, so it covers the whole mobile
         * namespace too. Naming it turns "the answer made no sense" into the actual
         * reason a phone was refused.
         *
         * (Note for future editors: never write a glob like the mobile path with a
         * trailing star inside a Kotlin block comment — block comments NEST, and the
         * stray opener silently swallows the rest of the file.)
         */
        const val LOOPBACK_ONLY = "LOOPBACK_ONLY"

        /* ── Turn-level codes, from the `chat.error` / `stream.error` frames. ── */
        const val PROVIDER_ERROR = "PROVIDER_ERROR"
        const val TIMEOUT = "TIMEOUT"
        const val ABORT = "ABORT"
        const val REPLAY_GAP = "REPLAY_GAP"

        /** The server's detail string for "the desktop never published this character". */
        const val NO_RUNNABLE_CONFIG = "no runnable configuration"
    }

    /**
     * True when retrying could never succeed with this credential.
     *
     * `AUTH_REQUIRED` is included: this app always sends its token when it has one,
     * so being told a credential is required means the device no longer holds a
     * usable one — the same dead end as `AUTH_INVALID`, and the same correct
     * response (pair again).
     */
    val isAuthFatal: Boolean
        get() = code == AUTH_INVALID || code == DEVICE_REVOKED || code == AUTH_REQUIRED
}

enum class TransportKind(val code: String, val retryable: Boolean) {
    /** No route to the node at all (airplane mode, wrong network, node stopped). */
    OFFLINE("TRANSPORT_OFFLINE", true),

    /** Resolved the name but nothing answered — node down or firewalled. */
    UNREACHABLE("TRANSPORT_UNREACHABLE", true),

    /** Connect or read deadline elapsed. */
    TIMEOUT("TRANSPORT_TIMEOUT", true),

    /** The connection died mid-exchange (stream dropped, socket reset). */
    INTERRUPTED("TRANSPORT_INTERRUPTED", true),

    /** We closed it ourselves (revocation, app leaving the foreground). */
    CANCELLED("TRANSPORT_CANCELLED", false),
    ;

    companion object {
        fun of(throwableName: String, message: String): TransportKind {
            val text = (throwableName + " " + message).lowercase()
            return when {
                // "cancel" covers both spellings (cancelled / canceled).
                "cancel" in text -> CANCELLED
                "timeout" in text || "timed out" in text -> TIMEOUT
                "unknownhost" in text || "unable to resolve" in text || "nodename" in text -> OFFLINE
                "connectexception" in text || "refused" in text || "ehostunreach" in text ||
                    "enetunreach" in text || "network is unreachable" in text -> UNREACHABLE
                else -> INTERRUPTED
            }
        }
    }
}

/** Convenience for the (many) places that only care whether auth is dead. */
val ProtocolError.authFatal: Boolean
    get() = this is ProtocolError.Server && isAuthFatal
