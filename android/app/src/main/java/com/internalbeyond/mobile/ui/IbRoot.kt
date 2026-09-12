package com.internalbeyond.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.app.NavModel
import com.internalbeyond.mobile.app.Route
import com.internalbeyond.mobile.data.repository.SessionRecovery
import com.internalbeyond.mobile.ui.character.CharacterListScreen
import com.internalbeyond.mobile.ui.chat.ChatScreen
import com.internalbeyond.mobile.ui.pairing.PairingScreen
import com.internalbeyond.mobile.ui.settings.SettingsScreen
import kotlinx.coroutines.launch

/**
 * The screen container.
 *
 * Everything visual sits inside one `safeDrawing`-padded column so that the status
 * bar, the cutout, the navigation bar and the keyboard are all accounted for by the
 * platform inset model (Phase 30). Individual screens do not re-derive insets;
 * a screen that needs to react to the IME (the chat composer) asks for
 * `imePadding()` itself.
 */
@Composable
fun IbRoot(graph: AppGraph) {
    val nav: NavViewModel = viewModel(factory = NavViewModel.factory(graph))
    val stack by nav.stack.collectAsStateWithLifecycle()
    val sessionState by graph.session.state.collectAsStateWithLifecycle()

    // Phase 29's ladder, in one place: modal > chat > list > root > system.
    // `false` means "not handled", so the platform performs its own Back (exit).
    BackHandler(enabled = stack.size > 1) { nav.onBack() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        when (val route = stack.lastOrNull() ?: Route.Pairing) {
            is Route.Pairing -> PairingScreen(
                graph = graph,
                onConnected = { nav.reset(Route.Characters) },
            )

            is Route.Characters -> CharacterListScreen(
                graph = graph,
                sessionState = sessionState,
                onOpenCharacter = { nav.push(Route.Chat(it)) },
                onOpenSettings = { nav.push(Route.Settings) },
            )

            is Route.Chat -> ChatScreen(
                graph = graph,
                characterId = route.characterId,
                onBack = { nav.onBack() },
            )

            is Route.Settings -> SettingsScreen(
                graph = graph,
                sessionState = sessionState,
                onBack = { nav.onBack() },
            )
        }
    }
}

/**
 * Owns the back stack.
 *
 * It observes the session for exactly one reason (Phase 24, tightened in M1-C.2e):
 * whenever the device holds no usable session, every route below is meaningless, so
 * the app returns to pairing instead of leaving the user on a screen that will fail
 * every request. It never *advances* on its own — reaching the character list is
 * always an explicit step, which is what lets the pairing screen show "Connected to …"
 * and a Continue button (Phase 8).
 *
 * The reset condition is [SessionRecovery.needsRepair], NOT a hand-written list of
 * states. That distinction is the M1-C.2e fix: the previous version reacted only to
 * `Revoked` and `AuthExpired`, so a user-initiated `disconnect()` — which correctly
 * reports `Unpaired` — left the back stack sitting on Settings with an empty,
 * credential-less character list underneath it and no way to reach pairing. The rule
 * now asks the canonical session truth instead of enumerating it, so a state that
 * means "no usable session" cannot be forgotten again.
 *
 * The rule itself lives in [NavModel] — no Android type in it, so both halves are
 * asserted directly on the JVM by `NavModelTest`. That is not tidiness for its own
 * sake: this rule was wrong on a real device and no unit test could reach it, which is
 * exactly why it stayed wrong.
 */
class NavViewModel(private val graph: AppGraph) : ViewModel() {

    /** The rule and the stack live in [NavModel] so a JVM test can assert both. */
    private val nav = NavModel(graph.session.state)
    val stack = nav.stack

    init {
        viewModelScope.launch {
            graph.session.state.collect(nav::onSessionState)
        }
    }

    fun push(route: Route) = nav.push(route)

    fun reset(route: Route) = nav.reset(route)

    /** True when the stack consumed the event; false lets the platform exit. */
    fun onBack(): Boolean = nav.onBack()

    companion object {
        fun factory(graph: AppGraph): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = NavViewModel(graph) as T
        }
    }
}
