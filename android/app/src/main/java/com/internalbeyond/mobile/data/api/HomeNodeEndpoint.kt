package com.internalbeyond.mobile.data.api

/**
 * Where the Home Node lives.
 *
 * Comes from the pairing payload's `endpoints.mobile` — never from a constant in
 * this app (Phase 25). The only default is the port, and only for a payload that
 * omits it, because 23118 is the Home Node's documented default
 * (docs/MOBILE_GATEWAY.md §18).
 */
data class HomeNodeEndpoint(
    val scheme: String,
    val host: String,
    val port: Int,
) {
    /** Authority with IPv6 literals bracketed correctly. */
    val authority: String
        get() = if (host.contains(':') && !host.startsWith("[")) "[$host]:$port" else "$host:$port"

    val baseUrl: String get() = "$scheme://$authority"

    /** Stable per-node cache key. Two addresses are two different caches. */
    val key: String get() = baseUrl

    /** What the UI shows. Never claims to be secure — Phase 27. */
    val display: String get() = authority

    /**
     * "局域网·未加密" / "仅本机" / "加密连接": a description, not a trust claim
     * (Phase 27). User-facing copy, translated in M1-C.1; it now appears only inside
     * the app's 开发者信息 disclosure, because "which transport" is a fact about a
     * machine rather than something a person has to act on.
     */
    val transportLabel: String
        get() = when {
            isEncrypted -> "加密连接"
            isLoopback -> "仅本机"
            else -> "局域网 · 未加密"
        }

    val isEncrypted: Boolean get() = scheme == "https"

    val isLoopback: Boolean
        get() = host == "localhost" || host == "::1" || host.startsWith("127.") || host == "10.0.2.2"

    fun path(relative: String): String = baseUrl + "/" + relative.trimStart('/')

    companion object {
        const val DEFAULT_PORT = 23118

        fun fromParts(scheme: String?, host: String?, port: Int?): HomeNodeEndpoint? {
            val h = host?.trim()?.removePrefix("[")?.removeSuffix("]") ?: return null
            if (h.isEmpty()) return null
            // A host has no spaces, no scheme, no path and no port of its own — and a
            // bare ':' means an unbracketed IPv6 literal, which is ambiguous in a
            // payload. Without this check a pasted sentence would be accepted as a
            // hostname and fail much later with an incomprehensible DNS error.
            if (h.any { it.isWhitespace() } || h.contains('/') || h.contains(':')) return null
            val s = normalizeScheme(scheme) ?: return null
            val p = port ?: DEFAULT_PORT
            if (p !in 1..65535) return null
            return HomeNodeEndpoint(s, h, p)
        }

        private fun normalizeScheme(scheme: String?): String? = when (scheme?.trim()?.lowercase()) {
            null, "" -> "http"
            "http", "https" -> scheme.trim().lowercase()
            else -> null
        }

        /**
         * Parse the optional manual override the pairing screen offers
         * ("192.168.10.7", "192.168.10.7:23118", "https://host:8443", "[::1]:23118").
         *
         * This exists because the address a desktop advertises is the address
         * *the desktop* believes it has, which is not always reachable from the
         * phone (second NIC, VPN/overlay, wrong subnet) — and because a loopback-only
         * Home Node deliberately reports no address at all. Without an override that
         * situation is a dead end.
         */
        fun parseOverride(input: String, fallbackScheme: String): HomeNodeEndpoint? {
            var text = input.trim()
            if (text.isEmpty()) return null
            var scheme = fallbackScheme
            val schemeSplit = text.indexOf("://")
            if (schemeSplit > 0) {
                scheme = text.substring(0, schemeSplit)
                text = text.substring(schemeSplit + 3)
            }
            val normalizedScheme = normalizeScheme(scheme) ?: return null
            text = text.trimEnd('/')
            if (text.isEmpty()) return null

            // Bracketed IPv6 literal: [::1] or [::1]:23118. Brackets are required,
            // which is why fromParts() can reject a bare colon in a host.
            if (text.startsWith("[")) {
                val close = text.indexOf(']')
                if (close < 0) return null
                val host = text.substring(1, close)
                if (host.isEmpty()) return null
                val rest = text.substring(close + 1)
                val port = when {
                    rest.isEmpty() -> DEFAULT_PORT
                    rest.startsWith(":") -> rest.substring(1).toIntOrNull() ?: return null
                    else -> return null
                }
                if (port !in 1..65535) return null
                return HomeNodeEndpoint(normalizedScheme, host, port)
            }

            val colon = text.lastIndexOf(':')
            if (colon >= 0 && text.indexOf(':') == colon) {
                val host = text.substring(0, colon)
                val port = text.substring(colon + 1).toIntOrNull() ?: return null
                return fromParts(normalizedScheme, host, port)
            }
            if (text.contains(':')) return null
            return fromParts(normalizedScheme, text, null)
        }
    }
}
