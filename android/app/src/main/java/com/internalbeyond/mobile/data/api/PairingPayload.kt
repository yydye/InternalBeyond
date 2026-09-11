package com.internalbeyond.mobile.data.api

import org.json.JSONObject

/**
 * The pairing payload — the one credential-bearing blob a user transfers by hand
 * (Phase 7). Everything here is *validated*, not trusted: a truncated paste, a
 * payload from a future protocol, or a payload whose address cannot work all
 * produce a specific, actionable message instead of a generic failure.
 */
data class PairingPayload(
    val pairingId: String,
    val secret: String,
    /**
     * Null when the payload carries no usable address — which is what a
     * loopback-only Home Node reports (`lanReachable:false` plus an empty host)
     * rather than handing out an address that can never work.
     *
     * Nullable rather than a parse failure on purpose: the pairing screen offers an
     * address override, and that override is most needed in exactly this case. A
     * parser that refused here would make its own escape hatch unreachable.
     */
    val endpoint: HomeNodeEndpoint?,
    val pairPath: String,
    val expiresAt: Long?,
    val ttlMs: Long?,
    val lanReachable: Boolean,
    /** Non-secret visual check that this is the intended machine. Never a key. */
    val nodeFingerprint: String,
    /** The exact JSON that was accepted, echoed back for confirmation UI. */
    val raw: String,
) {
    fun isExpired(now: Long = System.currentTimeMillis()): Boolean =
        expiresAt != null && expiresAt <= now

    /** Seconds left, for a countdown; null when the payload carries no TTL. */
    fun secondsRemaining(now: Long = System.currentTimeMillis()): Long? =
        expiresAt?.let { ((it - now) / 1000).coerceAtLeast(0) }
}

sealed class PairingParse {
    data class Ok(val payload: PairingPayload) : PairingParse()

    /** [title] is the headline; [detail] says precisely what to do next. */
    data class Fail(val title: String, val detail: String) : PairingParse()
}

object PairingPayloadParser {

    private const val SUPPORTED_VERSION = 1

    /**
     * Accepts every shape a user can plausibly paste (Phase 7 "manual payload"):
     *
     *  1. the payload object itself — `JSON.stringify(IB.homeNode.pairing.create(...).payload)`,
     *     which is what docs/MOBILE_GATEWAY.md §14 tells the user to copy;
     *  2. the whole HTTP envelope — `{v, ok, type:"pairing.session", payload:{...}}`,
     *     which is what you get if you copy one level too high;
     *  3. either of the above wrapped in surrounding text (a chat message, a log line).
     *
     * Liberal about envelopes, strict about contents. `v` is checked when present
     * and accepted when absent: the server's `POST /pairing/session` payload does
     * not currently carry `v` (only its envelope does), so requiring it here would
     * reject real payloads.
     */
    fun parse(input: String): PairingParse {
        val text = input.trim()
        if (text.isEmpty()) {
            return PairingParse.Fail(
                "Nothing pasted",
                "Copy the pairing payload on the desktop and paste it here.",
            )
        }

        val root = parseJsonLoosely(text)
            ?: return PairingParse.Fail(
                "That is not a pairing payload",
                "It does not contain JSON. On the desktop, run: " +
                    "JSON.stringify((await IB.homeNode.pairing.create({deviceName:'Android'})).payload)",
            )

        // Envelope level (shape 2). Only unwrap when the inner object really is a
        // pairing payload — otherwise `payload` could be something else entirely.
        val inner = root.objOrNull("payload")
        val body = if (inner != null && (inner.has("pairingId") || inner.has("secret"))) inner else root

        val version = body.intOrNull("v") ?: root.intOrNull("v")
        if (version != null && version != SUPPORTED_VERSION) {
            return PairingParse.Fail(
                "That pairing payload is from a different protocol version",
                "It says v$version and this app speaks v$SUPPORTED_VERSION. " +
                    "Update whichever side is older.",
            )
        }

        val pairingId = body.textOrNull("pairingId")
            ?: return PairingParse.Fail(
                "The payload has no pairing id",
                "It may have been truncated when it was copied. Copy it again, whole.",
            )
        val secret = body.textOrNull("secret")
            ?: return PairingParse.Fail(
                "The payload has no pairing secret",
                "It may have been truncated when it was copied. Copy it again, whole.",
            )
        // The real secret is 32 random bytes as base64url (43 chars). This is a
        // truncation check, not a format lock: a future longer secret still passes.
        if (secret.length < 16) {
            return PairingParse.Fail(
                "The pairing secret looks truncated",
                "It is ${secret.length} characters; a complete one is much longer. " +
                    "Copy the payload again, whole.",
            )
        }

        val lanReachable = body.boolOrNull("lanReachable") ?: true
        val endpoint = resolveEndpoint(body)

        val pairPath = body.objOrNull("endpoints")?.textOrNull("pairPath")
            ?: body.textOrNull("pairPath")
            ?: "/mobile/v1/pairing/complete"

        return PairingParse.Ok(
            PairingPayload(
                pairingId = pairingId,
                secret = secret,
                endpoint = endpoint,
                pairPath = if (pairPath.startsWith("/")) pairPath else "/$pairPath",
                expiresAt = body.longOrNull("expiresAt"),
                ttlMs = body.longOrNull("ttlMs"),
                lanReachable = lanReachable,
                nodeFingerprint = body.textOrNull("fingerprint") ?: "",
                raw = body.toString(),
            ),
        )
    }

    /**
     * What to tell the user when there is no usable address, in the two cases that
     * are genuinely different: a Node that never left its own machine, and a payload
     * that is simply missing the field.
     */
    fun missingAddressExplanation(lanReachable: Boolean): Pair<String, String> =
        if (!lanReachable) {
            "That pairing payload has no network address" to
                "The desktop's Home Node is listening on its own machine only " +
                "(127.0.0.1), so a phone cannot reach it. Either start InternalBeyond so the " +
                "Home Node listens on the network (IB_HOME_NODE_HOST=0.0.0.0) and create a " +
                "new pairing payload, or type the desktop's address below."
        } else {
            "That pairing payload has no address" to
                "It carries no host/port under endpoints.mobile. Create a new pairing " +
                "payload on the desktop, or type the address below."
        }

    /** `endpoints.mobile` first (what the server sends), flat fields as a fallback. */
    private fun resolveEndpoint(body: JSONObject): HomeNodeEndpoint? {
        val mobile = body.objOrNull("endpoints")?.objOrNull("mobile")
        val fromMobile = HomeNodeEndpoint.fromParts(
            scheme = mobile?.strOrNull("scheme"),
            host = mobile?.textOrNull("host"),
            port = mobile?.intOrNull("port"),
        )
        if (fromMobile != null) return fromMobile

        return HomeNodeEndpoint.fromParts(
            scheme = body.strOrNull("scheme"),
            host = body.textOrNull("host"),
            port = body.intOrNull("port"),
        )
    }

    /** Direct parse, else the outermost `{...}` span, so surrounding text is tolerated. */
    private fun parseJsonLoosely(text: String): JSONObject? {
        try {
            return JSONObject(text)
        } catch (_: Exception) {
            // fall through
        }
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return try {
            JSONObject(text.substring(start, end + 1))
        } catch (_: Exception) {
            null
        }
    }
}
