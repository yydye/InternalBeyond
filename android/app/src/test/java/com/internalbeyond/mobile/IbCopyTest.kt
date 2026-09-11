package com.internalbeyond.mobile

import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.TransportKind
import com.internalbeyond.mobile.ui.IbStrings
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Field
import java.lang.reflect.Modifier

/**
 * Unit · the copy contract (M1-C.1).
 *
 * The stage's acceptance criterion is "Android 所有用户可见主流程中文化" and, more
 * precisely, that a user never meets the architecture: no "Home Node", no payload, no
 * JSON, no HTTP, no F12, no protocol version. That is a rule about *words*, and a rule
 * about words is worth exactly as much as the check that enforces it — otherwise the
 * next screen added puts "Home Node" back on the first line and nobody notices until a
 * user does.
 *
 * The check is structural rather than a convention:
 *
 *  · every value directly on [IbStrings] is user-facing, so none of them may contain a
 *    developer term;
 *  · [IbStrings.Dev] is where those terms are allowed, so the second test asserts they
 *    are still *there* — proving the first test passes because the vocabulary was moved
 *    rather than deleted, which is the failure mode a guard like this can hide.
 *
 * Error text is checked too, because the eight situations of Phase 34 are read by users
 * and were the largest single surface of English in the old build.
 */
class IbCopyTest {

    private val jargon = listOf(
        "Home Node", "payload", "JSON", "HTTP", "F12", "endpoint", "protocol",
        "token", "Keystore", "SSE", "revision", "cursor", "localhost", "console",
        "WebSocket", "API", "URL", "ID",
    )

    @Test
    fun `no user-facing string names the architecture`() {
        val values = stringsOf(IbStrings)
        assertTrue("IbStrings produced no values to check", values.size >= 40)

        for ((name, value) in values) {
            for (term in jargon) {
                assertFalse(
                    "IbStrings.$name leaks the developer term \"$term\": $value",
                    value.contains(term, ignoreCase = true),
                )
            }
        }
    }

    @Test
    fun `every user-facing string is actually written`() {
        for ((name, value) in stringsOf(IbStrings)) {
            assertTrue("IbStrings.$name is blank", value.isNotBlank())
        }
    }

    @Test
    fun `the developer block still names what the user never sees`() {
        val values = stringsOf(IbStrings.Dev).map { it.second }
        assertTrue(values.isNotEmpty())
        assertTrue(
            "the term check would pass vacuously if the vocabulary had been deleted " +
                "rather than moved",
            values.any { it.contains("Home Node", ignoreCase = true) },
        )
        assertTrue(values.any { it.contains("F12") })
        assertTrue(values.any { it.contains("JSON") })
    }

    @Test
    fun `nothing a user reads in an error names the architecture`() {
        val errors = mutableListOf<ProtocolError>()
        for (kind in TransportKind.entries) errors += ProtocolError.Transport(kind, "no route to host")
        errors += ProtocolError.Response("The Home Node sent an empty body (HTTP 502).", 502)
        // The one known English surface left in a user-visible error, kept here so the
        // exclusion below is visible rather than silent: `ProtocolError.Local` carries
        // the caller's own sentence, and its two English producers live in
        // HomeNodeClient, which the M1-C.1 brief freezes.
        errors += ProtocolError.Local("This app is not connected to a Home Node.")
        for (code in listOf(
            ProtocolError.AUTH_REQUIRED,
            ProtocolError.AUTH_INVALID,
            ProtocolError.DEVICE_REVOKED,
            ProtocolError.PAIRING_INVALID,
            ProtocolError.PAIRING_EXPIRED,
            ProtocolError.PAIRING_USED,
            ProtocolError.PAIRING_NOT_FOUND,
            ProtocolError.BAD_VERSION,
            ProtocolError.BAD_REQUEST,
            ProtocolError.UNKNOWN_VERB,
            ProtocolError.NOT_FOUND,
            ProtocolError.BUSY,
            ProtocolError.CONFLICT,
            ProtocolError.RATE_LIMITED,
            ProtocolError.TOO_LARGE,
            ProtocolError.LOOPBACK_ONLY,
            ProtocolError.UNSUPPORTED,
            ProtocolError.PROVIDER_ERROR,
            ProtocolError.TIMEOUT,
            ProtocolError.ABORT,
            ProtocolError.REPLAY_GAP,
            ProtocolError.INTERNAL,
        )) {
            errors += ProtocolError.Server(code, "server said $code", retryable = true, detail = "raw $code")
        }

        for (error in errors) {
            val presentation = ErrorPresenter.present(error)
            assertTrue("${error.code} has no title", presentation.title.isNotBlank())
            for (term in jargon) {
                assertFalse(
                    "${error.code} leaks \"$term\" into its title: ${presentation.title}",
                    presentation.title.contains(term, ignoreCase = true),
                )
                presentation.detail?.let {
                    // ProtocolError.Local is deliberately excluded: its detail is the
                    // caller's own sentence, and the two HomeNodeClient callers that
                    // produce an English one are frozen by the M1-C.1 brief.
                    if (error is ProtocolError.Local) return@let
                    assertFalse(
                        "${error.code} leaks \"$term\" into its detail: $it",
                        it.contains(term, ignoreCase = true),
                    )
                }
            }
        }
    }

    /**
     * Every `String` property of a Kotlin `object`.
     *
     * Nested objects are excluded automatically (the field's type is not `String`),
     * which is what lets [IbStrings] and [IbStrings.Dev] be audited under opposite
     * rules without either one listing its own members.
     */
    private fun stringsOf(instance: Any): List<Pair<String, String>> =
        instance.javaClass.declaredFields.mapNotNull { field: Field ->
            if (field.type != String::class.java) return@mapNotNull null
            if (Modifier.isStatic(field.modifiers)) {
                field.isAccessible = true
                (field.get(null) as? String)?.let { field.name to it }
            } else {
                field.isAccessible = true
                (field.get(instance) as? String)?.let { field.name to it }
            }
        }
}
