package com.internalbeyond.mobile.app

import com.internalbeyond.mobile.data.repository.SessionRecovery
import com.internalbeyond.mobile.domain.model.ConnectionState
import kotlinx.coroutines.flow.StateFlow

/**
 * The navigation rule, with no Android type in it.
 *
 * It exists as its own class for one reason: the M1-C.2e defect was a *rule* bug that
 * lived inside an AndroidX `ViewModel`, where a JVM test cannot reach it. The result
 * was a rule that could be — and was — wrong about its most important case without a
 * single test noticing. Splitting the rule out makes the two decisions that matter
 * assertable on the JVM:
 *
 *  * [initialRoute] — which screen a cold boot lands on, and
 *  * [onSessionState] — whether a session change resets the stack.
 *
 * Both delegate to [SessionRecovery], so there is exactly one definition of "this
 * device has no usable session" in the app.
 *
 * Kotlin, not Android: no `Context`, no `ViewModel`, no Compose.
 */
class NavModel(sessionState: StateFlow<ConnectionState>) {

    /**
     * The back stack, seeded from the session rather than from the default route.
     *
     * Seeding it this way is what makes a cold boot correct: a phone with no usable
     * session cannot start on an authenticated-looking screen, because the root
     * destination is derived from the session instead of assumed.
     */
    private val back = BackStack(SessionRecovery.rootDestination(sessionState.value))

    val stack: StateFlow<List<Route>> = back.stack

    val current: Route get() = back.current

    val canGoBack: Boolean get() = back.canGoBack

    /**
     * Apply a session change.
     *
     * When no usable session remains, every route below is meaningless, so the stack
     * collapses to pairing and Back cannot resurrect the old connected UI. When the
     * session is fine, navigation is left completely alone — this never *advances*, so
     * the pairing screen can still show "Connected to …" and a Continue button.
     */
    fun onSessionState(state: ConnectionState) {
        if (SessionRecovery.needsRepair(state) && back.current !is Route.Pairing) {
            back.reset(Route.Pairing)
        }
    }

    fun push(route: Route) = back.push(route)

    fun reset(route: Route) = back.reset(route)

    /** True when the stack consumed the event; false lets the platform exit. */
    fun onBack(): Boolean = back.pop()
}
