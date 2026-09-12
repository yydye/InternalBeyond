package com.internalbeyond.mobile.app

import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.repository.SessionRecovery
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.TransportKind
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.domain.model.NodeInfo
import com.internalbeyond.mobile.domain.model.PairingStep
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M1-C.2e · the navigation rule, asserted where it is decided.
 *
 * The bug these tests exist for was live on a real device:
 *
 * ```
 * 08:15:15  graph.boot status=Connected cachedCharacters=4
 * 08:15:16  /mobile/v1/sync/changes        401 AUTH_INVALID
 * 08:15:16  /mobile/v1/character/list       401 AUTH_INVALID
 * 08:15:17  ...only now does the app offer pairing
 * ```
 *
 * The device booted believing it was configured because a record and a credential file
 * existed, and it stayed on an authenticated-looking screen that could not work. The
 * rule that chose that screen was inside an AndroidX `ViewModel`, so no JVM test could
 * reach it — which is precisely how it stayed wrong. It now lives in [NavModel], and
 * this file is the assertion that was missing.
 */
class NavModelTest {

    private val node = NodeInfo(
        endpoint = HomeNodeEndpoint("http", "192.168.10.7", HomeNodeEndpoint.DEFAULT_PORT),
        deviceId = "dev_test",
        deviceName = "Pixel 8",
    )
    private val error = ProtocolError.Local("stub")

    private fun model(state: ConnectionState): Pair<NavModel, MutableStateFlow<ConnectionState>> {
        val flow = MutableStateFlow(state)
        return NavModel(flow) to flow
    }

    @Test
    fun cold_boot_with_no_usable_session_starts_on_pairing() {
        for (state in listOf(
            ConnectionState.Unpaired,
            ConnectionState.AuthExpired(node, error),
            ConnectionState.Revoked(node, error),
            ConnectionState.Failed(node, error),
        )) {
            val (nav, _) = model(state)
            assertEquals("$state must boot into pairing", Route.Pairing, nav.current)
            assertFalse("$state must not offer a stale screen under pairing", nav.canGoBack)
        }
    }

    @Test
    fun cold_boot_with_a_usable_session_starts_on_the_character_list() {
        for (state in listOf(ConnectionState.Connected(node), ConnectionState.Offline(node, error))) {
            val (nav, _) = model(state)
            assertEquals("$state must boot into the roster", Route.Characters, nav.current)
        }
    }

    /**
     * The exact persisted dead state from the device, replayed as a state transition:
     * the user was on Settings, and the session reported a 401. Everything below must
     * be discarded, or Back returns to a screen whose every request fails.
     */
    @Test
    fun an_auth_rejection_from_settings_collapses_the_stack_to_pairing() {
        val (nav, flow) = model(ConnectionState.Connected(node))
        nav.push(Route.Settings)
        assertEquals(Route.Settings, nav.current)

        flow.value = ConnectionState.AuthExpired(node, error)
        nav.onSessionState(ConnectionState.AuthExpired(node, error))

        assertEquals(Route.Pairing, nav.current)
        assertFalse("Back must not resurrect the stale screen", nav.canGoBack)
    }

    /**
     * A user-initiated disconnect reports `Unpaired`, not `AuthExpired`. The old rule
     * enumerated only `Revoked` and `AuthExpired`, so this case — the one the user
     * actually performed — left them on Settings with an empty roster underneath.
     */
    @Test
    fun a_user_disconnect_from_settings_collapses_the_stack_to_pairing() {
        val (nav, _) = model(ConnectionState.Connected(node))
        nav.push(Route.Settings)

        nav.onSessionState(ConnectionState.Unpaired)

        assertEquals(Route.Pairing, nav.current)
        assertFalse(nav.canGoBack)
        assertFalse("Back at the root lets the platform exit", nav.onBack())
    }

    @Test
    fun a_disconnect_from_a_chat_does_not_leave_the_chat_below_pairing() {
        val (nav, _) = model(ConnectionState.Connected(node))
        nav.push(Route.Chat("friend_test_a"))
        assertEquals(Route.Chat("friend_test_a"), nav.current)

        nav.onSessionState(ConnectionState.Unpaired)

        assertEquals(Route.Pairing, nav.current)
        assertFalse("the chat must not be reachable with Back", nav.canGoBack)
    }

    /**
     * A confident-but-rejected credential is what the device actually had: the local
     * session looked valid until a request came back 401. The stack must recover
     * whichever screen it was on.
     */
    @Test
    fun a_rejected_credential_recovers_from_every_screen() {
        for (route in listOf(Route.Characters, Route.Settings, Route.Chat("friend_test_a"))) {
            val (nav, _) = model(ConnectionState.Connected(node))
            if (route !is Route.Characters) nav.push(route)

            nav.onSessionState(
                ConnectionState.AuthExpired(
                    node,
                    ProtocolError.Server(ProtocolError.AUTH_INVALID, "no", retryable = false),
                ),
            )

            assertEquals("from $route", Route.Pairing, nav.current)
            assertFalse("from $route", nav.canGoBack)
        }
    }

    /**
     * Offline is not unpaired. A phone that cannot reach its computer right now keeps
     * the screen it was on — that is the distinction the whole state machine exists to
     * preserve, and it must survive the new rule.
     */
    @Test
    fun going_offline_does_not_move_the_user_off_a_working_screen() {
        val (nav, _) = model(ConnectionState.Connected(node))
        nav.push(Route.Chat("friend_test_a"))

        nav.onSessionState(
            ConnectionState.Offline(node, ProtocolError.Transport(TransportKind.OFFLINE, "no route")),
        )

        assertEquals("an offline device must stay where it was", Route.Chat("friend_test_a"), nav.current)
        assertTrue(nav.canGoBack)
    }

    /** A pairing attempt is already on the pairing screen; the rule must not fight it. */
    @Test
    fun an_in_flight_pairing_does_not_disturb_the_stack() {
        val (nav, _) = model(ConnectionState.Unpaired)
        nav.onSessionState(ConnectionState.Pairing(PairingStep.EXCHANGING))

        assertEquals(Route.Pairing, nav.current)

        // ...and the successful end of that flow still needs an explicit step forward,
        // which is what lets the pairing screen say "已经连上了" with a Continue button.
        assertEquals(Route.Characters, SessionRecovery.rootDestination(ConnectionState.Connected(node)))
    }
}
