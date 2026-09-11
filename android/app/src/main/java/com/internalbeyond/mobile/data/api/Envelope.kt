package com.internalbeyond.mobile.data.api

import com.internalbeyond.mobile.domain.ProtocolError
import org.json.JSONObject

/** The outcome of one Home Node call. */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Err(val error: ProtocolError) : ApiResult<Nothing>()

    fun getOrNull(): T? = (this as? Ok)?.value
    fun errorOrNull(): ProtocolError? = (this as? Err)?.error
    val isOk: Boolean get() = this is Ok

    fun <R> map(transform: (T) -> R): ApiResult<R> = when (this) {
        is Ok -> Ok(transform(value))
        is Err -> this
    }
}

/**
 * The v1 envelope (docs/MOBILE_GATEWAY.md §7).
 *
 * ```
 * success: { "v":1, "ok":true,  "type":"…", "requestId":"…", "serverTime":0, "payload":{} }
 * failure: { "v":1, "ok":false, "type":"error", "error":{"code","message","retryable","detail"} }
 * ```
 *
 * The android client validates the response's `v` too. It is cheap, and a client
 * that only checks the version it SENT is not really doing version negotiation.
 */
object Envelope {

    const val PROTOCOL_VERSION = 1

    /** Parse a JSON envelope into its payload, or a typed [ProtocolError]. */
    fun payload(raw: String, httpStatus: Int, retryAfterMs: Long? = null): ApiResult<JSONObject> {
        val root = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return ApiResult.Err(
                ProtocolError.Response(
                    detail = if (raw.isBlank()) {
                        "The Home Node sent an empty body (HTTP $httpStatus)."
                    } else {
                        "The Home Node sent a body that is not JSON (HTTP $httpStatus)."
                    },
                    httpStatus = httpStatus,
                ),
            )
        }

        val version = root.intOrNull("v")
        if (version != PROTOCOL_VERSION) {
            // The Home Node also replies to some requests with a PRE-envelope shape
            // (`{"ok":false,"error":"loopback-only"}`), emitted by
            // `services/home-node/http.js` before routing — so it applies to
            // `/mobile/v1/*` as well. Reporting that as "the answer had no version
            // field" would hide the one fact the user needs.
            refusalSlug(root, httpStatus)?.let { return ApiResult.Err(it) }
            return ApiResult.Err(
                ProtocolError.Response(
                    detail = "The Home Node answered with protocol " +
                        (version?.let { "v$it" } ?: "no version field") +
                        "; this app speaks v$PROTOCOL_VERSION.",
                    httpStatus = httpStatus,
                ),
            )
        }

        val ok = root.boolOrNull("ok")
            ?: return ApiResult.Err(
                ProtocolError.Response("The Home Node's answer had no ok flag.", httpStatus),
            )

        if (ok) return ApiResult.Ok(root.objOrNull("payload") ?: JSONObject())

        return ApiResult.Err(serverError(root, httpStatus, retryAfterMs))
    }

    /**
     * The pre-envelope refusal shape: `{"ok":false,"error":"<slug>"}`.
     *
     * Guarded on `error` being a STRING: a v1 envelope's `error` is an object, and
     * `optString` would happily stringify it into a false match.
     */
    private fun refusalSlug(root: JSONObject, httpStatus: Int): ProtocolError? {
        if (root.boolOrNull("ok") != false) return null
        val slug = root.opt("error") as? String ?: return null
        val code = when (slug.trim().lowercase()) {
            "loopback-only" -> ProtocolError.LOOPBACK_ONLY
            "unauthenticated", "unauthorized" -> ProtocolError.AUTH_REQUIRED
            "not-found" -> ProtocolError.NOT_FOUND
            "body-too-large" -> ProtocolError.TOO_LARGE
            "internal-error" -> ProtocolError.INTERNAL
            else -> null
        } ?: return null
        return ProtocolError.Server(
            code = code,
            message = slug,
            retryable = false,
            detail = slug,
            httpStatus = httpStatus,
        )
    }

    /** An error that is not from a v1 envelope (e.g. a 404 from something else). */    fun bareError(httpStatus: Int, detail: String): ProtocolError = ProtocolError.Server(
        code = when (httpStatus) {
            401 -> ProtocolError.AUTH_REQUIRED
            403 -> ProtocolError.AUTH_INVALID
            404 -> ProtocolError.NOT_FOUND
            405 -> ProtocolError.UNKNOWN_VERB
            413 -> ProtocolError.TOO_LARGE
            429 -> ProtocolError.RATE_LIMITED
            501 -> ProtocolError.UNSUPPORTED
            in 500..599 -> ProtocolError.INTERNAL
            else -> ProtocolError.BAD_REQUEST
        },
        message = detail,
        retryable = httpStatus == 429 || httpStatus >= 500,
        httpStatus = httpStatus,
    )

    private fun serverError(root: JSONObject, httpStatus: Int, retryAfterMs: Long?): ProtocolError {
        val error = root.objOrNull("error")
            ?: return ProtocolError.Response(
                "The Home Node reported a failure without an error object (HTTP $httpStatus).",
                httpStatus,
            )
        val code = error.textOrNull("code")
            ?: return ProtocolError.Response(
                "The Home Node reported a failure without an error code (HTTP $httpStatus).",
                httpStatus,
            )
        return ProtocolError.Server(
            code = code,
            message = error.strOrNull("message") ?: "",
            retryable = error.boolOrNull("retryable") ?: false,
            detail = error.textOrNull("detail"),
            httpStatus = httpStatus,
            retryAfterMs = retryAfterMs,
        )
    }

    /** The success envelope for a locally-answered call (tests and fakes). */
    fun success(type: String, payload: JSONObject = JSONObject()): JSONObject = JSONObject()
        .put("v", PROTOCOL_VERSION)
        .put("ok", true)
        .put("type", type)
        .put("serverTime", System.currentTimeMillis())
        .put("payload", payload)

    /** The failure envelope, so error mapping can be tested without a server. */
    fun failure(code: String, message: String = "", retryable: Boolean = false, detail: String? = null): JSONObject {
        val error = JSONObject().put("code", code).put("message", message).put("retryable", retryable)
        if (detail != null) error.put("detail", detail)
        return JSONObject()
            .put("v", PROTOCOL_VERSION)
            .put("ok", false)
            .put("type", "error")
            .put("serverTime", System.currentTimeMillis())
            .put("error", error)
    }
}
