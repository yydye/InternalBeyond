package com.internalbeyond.mobile

import com.internalbeyond.mobile.domain.ErrorAction
import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.TransportKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit · error mapping (Phase 34).
 *
 * The requirement is that the eight situations below are DISTINGUISHABLE, so this
 * test asserts both that each maps to its own wording and that no two collapse onto
 * the same title. It also pins the actions, because an error with the wrong action
 * is worse than a vague one: a "Re-pair" button on a rate limit trains the user to
 * destroy a working credential.
 */
class ErrorMappingTest {

    private fun server(code: String, detail: String? = null, retryable: Boolean = false) =
        ProtocolError.Server(code, "server said $code", retryable, detail)

    @Test
    fun `the eight situations of Phase 34 all read differently`() {
        val offline = ErrorPresenter.present(
            ProtocolError.Transport(TransportKind.OFFLINE, "no route"),
        )
        val authInvalid = ErrorPresenter.present(server(ProtocolError.AUTH_INVALID))
        val revoked = ErrorPresenter.present(server(ProtocolError.DEVICE_REVOKED))
        val unpublished = ErrorPresenter.present(
            server(ProtocolError.CONFLICT, ProtocolError.NO_RUNNABLE_CONFIG),
        )
        val busy = ErrorPresenter.present(server(ProtocolError.BUSY, retryable = true))
        val providerError = ErrorPresenter.present(server(ProtocolError.PROVIDER_ERROR, retryable = true))
        val replayGap = ErrorPresenter.present(server(ProtocolError.REPLAY_GAP))
        val timeout = ErrorPresenter.present(
            ProtocolError.Transport(TransportKind.TIMEOUT, "read timed out"),
        )

        val titles = listOf(
            offline, authInvalid, revoked, unpublished, busy, providerError, replayGap, timeout,
        ).map { it.title }

        assertEquals(titles.size, titles.toSet().size)
        assertTrue(titles.none { it.contains("Something went wrong", ignoreCase = true) })
    }

    @Test
    fun `actions match what the situation actually needs`() {
        assertEquals(
            ErrorAction.RE_PAIR,
            ErrorPresenter.present(server(ProtocolError.AUTH_INVALID)).action,
        )
        assertEquals(
            ErrorAction.RE_PAIR,
            ErrorPresenter.present(server(ProtocolError.DEVICE_REVOKED)).action,
        )
        assertEquals(
            ErrorAction.DESKTOP_ACTION,
            ErrorPresenter.present(server(ProtocolError.CONFLICT, ProtocolError.NO_RUNNABLE_CONFIG)).action,
        )
        assertEquals(
            ErrorAction.RETRY_LATER,
            ErrorPresenter.present(server(ProtocolError.BUSY, retryable = true)).action,
        )
        // A rate limit must not offer "re-pair".
        assertNotEquals(
            ErrorAction.RE_PAIR,
            ErrorPresenter.present(server(ProtocolError.RATE_LIMITED, retryable = true)).action,
        )
    }

    @Test
    fun `rate limiting reports the wait the server asked for`() {
        val error = ProtocolError.Server(
            ProtocolError.RATE_LIMITED,
            "too many",
            retryable = true,
            retryAfterMs = 4000,
        )
        assertTrue(ErrorPresenter.present(error).detail!!.contains("4 秒"))
    }

    @Test
    fun `pairing failures are told apart rather than merged`() {
        val invalid = ErrorPresenter.present(server(ProtocolError.PAIRING_INVALID))
        val expired = ErrorPresenter.present(server(ProtocolError.PAIRING_EXPIRED))
        val used = ErrorPresenter.present(server(ProtocolError.PAIRING_USED))
        assertNotEquals(invalid.title, expired.title)
        assertNotEquals(expired.title, used.title)
        assertTrue(used.detail!!.contains("只能用一次"))
    }

    @Test
    fun `a protocol version mismatch names both sides`() {
        val presentation = ErrorPresenter.present(server(ProtocolError.BAD_VERSION, detail = "2"))
        assertTrue(presentation.title.contains("版本"))
        assertTrue(presentation.detail!!.contains("第 1 版"))
        assertTrue(presentation.detail.contains("第 2 版"))
    }

    @Test
    fun `transport kinds are classified from exception names`() {
        assertEquals(TransportKind.OFFLINE, TransportKind.of("UnknownHostException", "no address"))
        assertEquals(TransportKind.UNREACHABLE, TransportKind.of("ConnectException", "Connection refused"))
        assertEquals(TransportKind.TIMEOUT, TransportKind.of("InterruptedIOException", "timeout"))
        assertEquals(TransportKind.CANCELLED, TransportKind.of("IOException", "Canceled"))
        assertEquals(TransportKind.INTERRUPTED, TransportKind.of("SocketException", "Connection reset"))
    }

    @Test
    fun `only the fatal auth codes are treated as fatal`() {
        assertTrue(server(ProtocolError.AUTH_INVALID).isAuthFatal)
        assertTrue(server(ProtocolError.DEVICE_REVOKED).isAuthFatal)
        assertTrue(server(ProtocolError.AUTH_REQUIRED).isAuthFatal)
        assertTrue(!server(ProtocolError.BUSY).isAuthFatal)
        assertTrue(!server(ProtocolError.NOT_FOUND).isAuthFatal)
        assertTrue(!ProtocolError.Transport(TransportKind.OFFLINE, "down").isAuthFatal)
    }

    @Test
    fun `a local failure has no retry action but says what is missing`() {
        val presentation = ErrorPresenter.present(ProtocolError.Local("This app is not connected."))
        assertEquals(ErrorAction.NONE, presentation.action)
        assertEquals("This app is not connected.", presentation.detail)
    }
}
