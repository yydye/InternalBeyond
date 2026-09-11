package com.internalbeyond.mobile.domain.model

import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.domain.ProtocolError

/** The Home Node this app is currently paired with. No credential in here. */
data class NodeInfo(
    val endpoint: HomeNodeEndpoint,
    val deviceId: String,
    val deviceName: String,
    /** Non-secret visual check that this is the intended machine. */
    val nodeFingerprint: String = "",
    val serverVersion: String = "",
    val protocol: Int = 0,
)

/**
 * Connection state as a domain type (Phase 9).
 *
 * There is deliberately no `isConnected: Boolean` anywhere in this app. The five
 * situations below need five different screens — "offline, retrying" and "your
 * device was revoked" are not the same thing to a user, and collapsing them into a
 * boolean is how an app ends up retrying forever against a credential that can
 * never work again.
 */
sealed interface ConnectionState {

    /** No Home Node, no credential. */
    object Unpaired : ConnectionState

    /** A pairing attempt is in flight. */
    data class Pairing(val step: PairingStep, val error: ProtocolError? = null) : ConnectionState

    /** Paired and confirmed reachable. */
    data class Connected(val node: NodeInfo) : ConnectionState

    /** Paired, but the Home Node cannot be reached right now. Retryable. */
    data class Offline(val node: NodeInfo?, val error: ProtocolError) : ConnectionState

    /** The credential is gone or unusable; the app still remembers the pairing. */
    data class AuthExpired(val node: NodeInfo?, val error: ProtocolError) : ConnectionState

    /** The Home Node revoked this device. Terminal — only pairing can recover. */
    data class Revoked(val node: NodeInfo?, val error: ProtocolError) : ConnectionState

    /** Anything else, e.g. a protocol version mismatch. */
    data class Failed(val node: NodeInfo?, val error: ProtocolError) : ConnectionState

    val nodeOrNull: NodeInfo?
        get() = when (this) {
            is Connected -> node
            is Offline -> node
            is AuthExpired -> node
            is Revoked -> node
            is Failed -> node
            else -> null
        }

    /** True while the app should keep trying without user action. */
    val isRecoverable: Boolean
        get() = this is Offline || this is Pairing

    /** True when the user must pair again. */
    val needsRepair: Boolean
        get() = this is AuthExpired || this is Revoked || this is Unpaired
}

enum class PairingStep {
    /** Parsing and validating the pasted payload. */
    PARSING,

    /** Exchanging the pairing secret for a device credential. */
    EXCHANGING,

    /** Confirming identity with the freshly issued credential. */
    VERIFYING,
}
