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
     *     which is what the Android app's 开发帮助 tells the user to copy;
     *  2. the whole HTTP envelope — `{v, ok, type:"pairing.session", payload:{...}}`,
     *     which is what you get if you copy one level too high;
     *  3. either of the above wrapped in surrounding text (a chat message, a log line).
     *
     * Liberal about envelopes, strict about contents. `v` is checked when present
     * and accepted when absent: the server's `POST /pairing/session` payload does
     * not currently carry `v` (only its envelope does), so requiring it here would
     * reject real payloads.
     *
     * The [PairingParse.Fail] texts are user-facing copy and were translated in M1-C.1
     * along with the rest of the interface. Nothing about the validation changed: the
     * same inputs fail at the same points, for the same reasons, in the same order.
     */
    fun parse(input: String): PairingParse {
        val text = input.trim()
        if (text.isEmpty()) {
            return PairingParse.Fail(
                "还没有粘贴内容",
                "在电脑上复制配对信息，然后粘贴到这里。",
            )
        }

        val root = parseJsonLoosely(text)
            ?: return PairingParse.Fail(
                "这段内容不是配对信息",
                "它看起来不是从电脑上复制过来的那一段。请重新完整复制一次再试。",
            )

        // Envelope level (shape 2). Only unwrap when the inner object really is a
        // pairing payload — otherwise `payload` could be something else entirely.
        val inner = root.objOrNull("payload")
        val body = if (inner != null && (inner.has("pairingId") || inner.has("secret"))) inner else root

        val version = body.intOrNull("v") ?: root.intOrNull("v")
        if (version != null && version != SUPPORTED_VERSION) {
            return PairingParse.Fail(
                "这段配对信息来自另一个版本",
                "它说的是第 $version 版，这台手机说的是第 $SUPPORTED_VERSION 版。" +
                    "哪一边旧就更新哪一边。",
            )
        }

        val pairingId = body.textOrNull("pairingId")
            ?: return PairingParse.Fail(
                "配对信息少了开头",
                "复制的时候可能漏掉了前面一段。请重新完整复制一次。",
            )
        val secret = body.textOrNull("secret")
            ?: return PairingParse.Fail(
                "配对信息少了关键的一段",
                "复制的时候可能漏掉了中间一段。请重新完整复制一次。",
            )
        // The real secret is 32 random bytes as base64url (43 chars). This is a
        // truncation check, not a format lock: a future longer secret still passes.
        if (secret.length < 16) {
            return PairingParse.Fail(
                "配对信息像是被截断了",
                "它只有 ${secret.length} 个字符，完整的一长得多。请重新完整复制一次。",
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
     *
     * User-facing copy, translated in M1-C.1. The desktop-side switch
     * (`IB_HOME_NODE_HOST`) deliberately does NOT appear here any more — it is a term
     * from the architecture, and the app now keeps such terms behind 开发帮助
     * (`IbStrings.Dev`). What a person needs at this point is the address box.
     */
    fun missingAddressExplanation(lanReachable: Boolean): Pair<String, String> =
        if (!lanReachable) {
            "电脑目前只对本机开放" to
                "电脑上的 InternalBeyond 现在只接受本机的连接，手机访问不到它。" +
                "可以到「高级设置」里手动填写电脑地址，或者让电脑开放给同一网络之后再生成一段新的。"
        } else {
            "这段配对信息里没有地址" to
                "它没有带上电脑的地址。可以重新生成一段，或者到「高级设置」里手动填写。"
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
