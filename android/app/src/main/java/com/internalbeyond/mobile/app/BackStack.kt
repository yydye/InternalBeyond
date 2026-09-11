package com.internalbeyond.mobile.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The screens this stage has (Phase 32): Pairing, Character list, Chat, Settings.
 * Nothing else — no Moments, Diary, Letters, Music, Cinema or editor.
 */
sealed interface Route {
    object Pairing : Route
    object Characters : Route
    data class Chat(val characterId: String) : Route
    object Settings : Route
}

/**
 * An explicit back ladder (Phase 29), as a pure Kotlin stack.
 *
 * Not `navigation-compose`, for two reasons: this stage has four destinations and
 * one precise rule set, and a plain class is unit-testable on the JVM — so
 * "Back from a chat returns to the character list, and Back at the root exits" is
 * asserted by a test rather than discovered by a user.
 *
 * Rules, in order:
 *  * a chat → the character list (never straight out of the app);
 *  * settings → whatever pushed it;
 *  * the root → `false`, i.e. the system's own back (exit / recents).
 */
class BackStack(initial: Route = Route.Pairing) {

    private val _stack = MutableStateFlow(listOf(initial))
    val stack: StateFlow<List<Route>> = _stack.asStateFlow()

    val current: Route get() = _stack.value.last()

    val depth: Int get() = _stack.value.size

    val canGoBack: Boolean get() = _stack.value.size > 1

    fun push(route: Route) {
        val currentStack = _stack.value
        // Never stack the same destination on top of itself, and never stack a chat
        // on a chat of the same character.
        if (currentStack.last() == route) return
        _stack.value = currentStack + route
    }

    /** Replace everything with [route] — used when the session changes underneath us. */
    fun reset(route: Route) {
        _stack.value = listOf(route)
    }

    /**
     * Pop one level. Returns false at the root, which the caller translates into
     * "let the system handle Back" so the app can actually be left (Phase 29:
     * "不要每次 Back 都 finish Activity" — and equally, not never).
     */
    fun pop(): Boolean {
        val currentStack = _stack.value
        if (currentStack.size <= 1) return false
        _stack.value = currentStack.dropLast(1)
        return true
    }
}
