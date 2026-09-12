package com.internalbeyond.mobile.data.repository

import com.internalbeyond.mobile.app.Route
import com.internalbeyond.mobile.domain.model.ConnectionState

/**
 * M1-C.2e · the canonical session truth, and the one place a screen is chosen from it.
 *
 * ## Why this type exists
 *
 * A real phone reached a state that survived force-stop: *not connected* and yet
 * *unable to pair*, which is unrecoverable without clearing app data. The cause was
 * not one missing button. There were two competing answers to "is this device paired?":
 *
 *  * [SessionRepository]'s `state` flow — the authoritative one, which correctly knows
 *    a session is gone; and
 *  * a *derived* rule in the navigation layer (`nodeOrNull != null`, "does a record
 *    exist?") which treated history as configuration and therefore kept the user on an
 *    authenticated-looking screen.
 *
 * Nothing forced those two to agree, so a state could exist where the session flow said
 * `Unpaired` while the screen said "you are set up".
 *
 * This object removes the second answer. It is the only rule that decides whether the
 * app treats a session as usable for navigation and recovery, and it derives that
 * decision from the session state alone — never from a stored record, an endpoint, or
 * the fact that pairing once succeeded.
 *
 * ## The three facts, kept distinct
 *
 * ```
 * previously paired   ≠   currently configured   ≠   currently connected
 * ```
 *
 * * **configured** — usable endpoint + usable credential material, locally. Survives
 *   being offline; this is the fact that must not be destroyed by a network error.
 * * **connected** — configured and the Home Node has just confirmed it.
 * * **previously paired** — nothing. It is history, and it is deliberately not an input
 *   to [needsRepair] or [rootDestination].
 *
 * ## Deliberately not a new boolean
 *
 * There is no `hasEverPaired` / `pairingCompleted` / `setupDone` here, and adding one
 * would reintroduce exactly the bug: those flags are indistinguishable from the stale
 * record that caused it. The only durable question is whether usable credentials exist
 * *now*, which [ConnectionState] already answers.
 *
 * Offline is not the same as unpaired, and this is where that distinction is enforced:
 * [ConnectionState.Offline] is a *configured* device whose computer cannot be reached,
 * so it stays on the character list and keeps its credentials. Only the states where
 * no usable session remains route to pairing.
 */
object SessionRecovery {

    /**
     * True when the device holds no usable session and the user must be able to pair
     * again. Covers the two ways that happens: nothing was ever configured
     * ([ConnectionState.Unpaired]), and something was configured but is now
     * permanently unusable ([ConnectionState.AuthExpired], [ConnectionState.Revoked],
     * [ConnectionState.Failed]).
     *
     * [ConnectionState.Pairing] is excluded on purpose: a pairing attempt is already
     * standing on the pairing screen, and yanking the navigation stack out from under
     * it would fight the user's own action.
     */
    fun needsRepair(state: ConnectionState): Boolean = when (state) {
        is ConnectionState.Connected, is ConnectionState.Offline, is ConnectionState.Pairing -> false
        is ConnectionState.Unpaired,
        is ConnectionState.AuthExpired,
        is ConnectionState.Revoked,
        is ConnectionState.Failed,
        -> true
    }

    /**
     * Where the app belongs, given only the canonical session state.
     *
     * This is the whole navigation rule: canonical session state in, root destination
     * out. It is a pure function of one value, which is what makes the invariant
     * testable — and what makes "disconnect immediately offers pairing" a consequence
     * of the state change rather than a `navigate("pairing")` call someone has to
     * remember to write.
     */
    fun rootDestination(state: ConnectionState): Route =
        if (needsRepair(state)) Route.Pairing else Route.Characters
}
