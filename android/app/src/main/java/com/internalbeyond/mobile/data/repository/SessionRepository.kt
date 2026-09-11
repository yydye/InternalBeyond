package com.internalbeyond.mobile.data.repository

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.auth.AndroidKeyProvider
import com.internalbeyond.mobile.data.auth.DeviceCredential
import com.internalbeyond.mobile.data.auth.EncryptedCredentialStore
import com.internalbeyond.mobile.data.auth.SessionRecord
import com.internalbeyond.mobile.data.auth.SessionStore
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.domain.model.NodeInfo
import com.internalbeyond.mobile.domain.model.PairingStep
import com.internalbeyond.mobile.platform.IdGen
import com.internalbeyond.mobile.platform.IbLog
import com.internalbeyond.mobile.platform.StreamRegistry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.api.PairingParse
import com.internalbeyond.mobile.data.api.PairingPayload
import com.internalbeyond.mobile.data.api.PairingPayloadParser

/** Mutable "where am I and what credential do I hold" holder shared by the graph. */
class SessionHolder {
    @Volatile
    var endpoint: HomeNodeEndpoint? = null

    @Volatile
    var token: String? = null

    @Volatile
    var credential: DeviceCredential? = null
}

sealed class PairingResult {
    data class Success(val node: NodeInfo) : PairingResult()

    /** The payload itself is unusable. [title]/[detail] are user-facing. */
    data class Invalid(val title: String, val detail: String) : PairingResult()

    /** The payload was fine but the exchange failed. */
    data class Failed(val error: ProtocolError) : PairingResult()
}

/**
 * Owns the connection lifecycle: restore, pair, verify, disconnect, and the two
 * fatal outcomes (Phase 9/23/24).
 *
 * The invariant this class exists to protect: **a credential is deleted the moment
 * the Home Node says it is no longer valid, and never before.** It does not delete
 * the credential on a network error (the node may simply be off), and it does not
 * keep one after `DEVICE_REVOKED` or `AUTH_INVALID` (retrying could never succeed).
 */
class SessionRepository(
    private val client: HomeNodeClient,
    private val holder: SessionHolder,
    private val credentialStore: EncryptedCredentialStore,
    private val sessionStore: SessionStore,
    private val streams: StreamRegistry,
    private val presenceReporter: (Boolean) -> Unit = {},
) {

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Unpaired)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** Notified whenever the credential is discarded, so caches can be cleared. */
    private val _credentialCleared = MutableStateFlow(0)
    val credentialCleared: StateFlow<Int> = _credentialCleared.asStateFlow()

    val isConnected: Boolean get() = _state.value is ConnectionState.Connected

    /**
     * Cold start. Three honest outcomes, never a fourth:
     *
     *  * nothing stored → [ConnectionState.Unpaired];
     *  * a session but no openable credential → [ConnectionState.AuthExpired] (the
     *    Keystore key is gone, or the blob is damaged) — the app says so instead of
     *    pretending it was never paired;
     *  * both present → optimistically [ConnectionState.Connected], then [verify]
     *    confirms or corrects it.
     */
    fun boot(): ConnectionState {
        val record = sessionStore.load()
        if (record == null) {
            holder.endpoint = null
            holder.token = null
            holder.credential = null
            return setState(ConnectionState.Unpaired)
        }
        val credential = credentialStore.read()
        if (credential == null) {
            holder.endpoint = record.endpoint
            holder.token = null
            holder.credential = null
            return setState(
                ConnectionState.AuthExpired(
                    node = record.toNodeInfo(),
                    error = ProtocolError.Local(
                        if (credentialStore.hasStoredCredential()) {
                            "The stored credential could not be decrypted on this device."
                        } else {
                            "This device has no stored credential."
                        },
                    ),
                ),
            )
        }
        holder.endpoint = record.endpoint
        holder.token = credential.token
        holder.credential = credential
        return setState(ConnectionState.Connected(record.toNodeInfo()))
    }

    /**
     * Confirm the stored credential with the Home Node and refresh the node facts.
     * Returns null on success, or the failure that was recorded.
     */
    suspend fun verify(): ProtocolError? {
        if (holder.token == null || holder.endpoint == null) {
            val error = ProtocolError.Server(
                code = ProtocolError.AUTH_REQUIRED,
                message = "This device has no credential.",
                retryable = false,
            )
            setState(ConnectionState.AuthExpired(_state.value.nodeOrNull, error))
            return error
        }
        return when (val result = client.handshake()) {
            is ApiResult.Ok -> {
                val handshake = result.value
                val node = currentNodeInfo().copy(
                    nodeFingerprint = handshake.fingerprint,
                    serverVersion = handshake.serverVersion,
                    protocol = handshake.protocol,
                )
                persistNodeFacts(node)
                setState(ConnectionState.Connected(node))
                IbLog.info(
                    "session.verified",
                    IbLog.FIELD_ENDPOINT to node.endpoint.display,
                    "serverVersion" to node.serverVersion,
                    "protocol" to node.protocol,
                )
                null
            }

            is ApiResult.Err -> {
                handleFailure(result.error)
                result.error
            }
        }
    }

    /** Pair with a Home Node from a pasted payload (Phase 7/8). */
    suspend fun pair(
        rawPayload: String,
        addressOverride: String? = null,
        deviceName: String = "Android",
    ): PairingResult {
        setState(ConnectionState.Pairing(PairingStep.PARSING))
        val parsed = when (val outcome = PairingPayloadParser.parse(rawPayload)) {
            is PairingParse.Fail -> {
                val result = PairingResult.Invalid(outcome.title, outcome.detail)
                setState(ConnectionState.Unpaired)
                return result
            }
            is PairingParse.Ok -> outcome.payload
        }

        val endpoint = resolveEndpoint(parsed, addressOverride)
        if (endpoint == null) {
            // The override is checked FIRST, so a loopback-only payload — the case the
            // override exists for — can still be paired with by typing the address.
            val (title, detail) = when {
                parsed.endpoint == null -> PairingPayloadParser.missingAddressExplanation(parsed.lanReachable)
                else -> "That address is not usable" to
                    "Use host, host:port or scheme://host:port — for example 192.168.10.7:23118."
            }
            val result = PairingResult.Invalid(title, detail)
            setState(ConnectionState.Unpaired)
            return result
        }

        setState(ConnectionState.Pairing(PairingStep.EXCHANGING))
        val requestId = IdGen.requestId("req_pair")
        val exchange = client.pairingComplete(parsed, deviceName, DEVICE_TYPE, requestId, endpoint)
        if (exchange is ApiResult.Err) {
            setState(ConnectionState.Unpaired)
            return PairingResult.Failed(exchange.error)
        }
        val outcome = (exchange as ApiResult.Ok).value
        if (outcome.token.isEmpty()) {
            setState(ConnectionState.Unpaired)
            return PairingResult.Failed(
                ProtocolError.Response("The Home Node returned a pairing response with no credential."),
            )
        }

        // Credential first, then the non-secret record: a crash in between leaves
        // "credential but no session", which boot() treats as Unpaired and the next
        // pairing overwrites — strictly better than a session with no credential.
        val credential = DeviceCredential(
            token = outcome.token,
            deviceId = outcome.device.deviceId,
            deviceName = outcome.device.name.ifEmpty { deviceName },
            tokenVersion = outcome.device.tokenVersion,
            issuedAt = System.currentTimeMillis(),
        )
        try {
            credentialStore.write(credential)
        } catch (error: Exception) {
            setState(ConnectionState.Unpaired)
            return PairingResult.Failed(
                ProtocolError.Local(
                    "The credential could not be stored securely on this device: ${error.message}",
                ),
            )
        }

        holder.endpoint = endpoint
        holder.token = outcome.token
        // Held as well as the raw token: boot() and the identity refresh both read the
        // device's own facts from here, and leaving it null made a just-paired device
        // report an empty deviceId.
        holder.credential = credential
        val node = NodeInfo(
            endpoint = endpoint,
            deviceId = outcome.device.deviceId,
            deviceName = outcome.device.name.ifEmpty { deviceName },
            nodeFingerprint = outcome.handshake.fingerprint.ifEmpty { parsed.nodeFingerprint },
            serverVersion = outcome.handshake.serverVersion,
            protocol = outcome.handshake.protocol,
        )
        sessionStore.save(node.toRecord(credentialStore))
        setState(ConnectionState.Pairing(PairingStep.VERIFYING))

        // Prove the issued credential actually works before declaring success.
        val verifyError = verify()
        if (verifyError != null) return PairingResult.Failed(verifyError)

        reportPresence(true)
        return PairingResult.Success(currentNodeInfo())
    }

    /**
     * User-initiated disconnect (Phase 23).
     *
     * The local credential is cleared even if the Home Node could not be told, and
     * [DisconnectOutcome.serverConfirmed] says which happened — the UI states that
     * honestly rather than implying the desktop has forgotten the device.
     */
    suspend fun disconnect(): DisconnectOutcome {
        val node = _state.value.nodeOrNull
        val confirmed = when (val result = client.deviceRevoke()) {
            is ApiResult.Ok -> true
            is ApiResult.Err -> {
                IbLog.warn("session.revoke-failed", IbLog.FIELD_CODE to result.error.code)
                false
            }
        }
        clearCredential(clearSessionRecord = true)
        setState(ConnectionState.Unpaired)
        return DisconnectOutcome(node = node, serverConfirmed = confirmed)
    }

    /** Called by other repositories when a request hits a fatal auth error. */
    fun handleFailure(error: ProtocolError) {
        if (error is ProtocolError.Server) {
            when (error.code) {
                ProtocolError.DEVICE_REVOKED -> {
                    // Phase 24: delete the credential, stop every stream, go to Unpaired.
                    clearCredential(clearSessionRecord = false)
                    setState(ConnectionState.Revoked(_state.value.nodeOrNull, error))
                    return
                }

                ProtocolError.AUTH_INVALID, ProtocolError.AUTH_REQUIRED -> {
                    clearCredential(clearSessionRecord = false)
                    setState(ConnectionState.AuthExpired(_state.value.nodeOrNull, error))
                    return
                }
            }
        }
        // Anything else is a transport / server problem: the credential is kept.
        if (_state.value is ConnectionState.Connected || _state.value is ConnectionState.Offline) {
            setState(ConnectionState.Offline(_state.value.nodeOrNull ?: currentNodeInfoOrNull(), error))
        }
    }

    fun reportPresence(appForeground: Boolean) {
        presenceReporter(appForeground)
    }

    /**
     * Discard the credential. [clearSessionRecord] is true only for a
     * user-initiated disconnect: after a revocation the app keeps the record so it
     * can still name the Home Node it was talking to, and `boot()` will report
     * AuthExpired next time rather than silently starting from nothing.
     */
    private fun clearCredential(clearSessionRecord: Boolean) {
        credentialStore.clear()
        holder.token = null
        holder.credential = null
        if (clearSessionRecord) {
            sessionStore.clear()
            holder.endpoint = null
        }
        AndroidKeyProvider.invalidateCache()
        streams.cancelAll()
        _credentialCleared.value = _credentialCleared.value + 1
    }

    private fun resolveEndpoint(parsed: PairingPayload, override: String?): HomeNodeEndpoint? {
        val fallbackScheme = parsed.endpoint?.scheme ?: "http"
        if (override.isNullOrBlank()) return parsed.endpoint
        return HomeNodeEndpoint.parseOverride(override, fallbackScheme)
    }

    private fun currentNodeInfo(): NodeInfo =
        _state.value.nodeOrNull ?: currentNodeInfoOrNull() ?: NodeInfo(
            endpoint = holder.endpoint ?: HomeNodeEndpoint("http", "127.0.0.1", HomeNodeEndpoint.DEFAULT_PORT),
            deviceId = holder.credential?.deviceId ?: "",
            deviceName = holder.credential?.deviceName ?: "",
        )

    private fun currentNodeInfoOrNull(): NodeInfo? {
        val endpoint = holder.endpoint ?: return null
        val credential = holder.credential
        return NodeInfo(
            endpoint = endpoint,
            deviceId = credential?.deviceId ?: "",
            deviceName = credential?.deviceName ?: "",
        )
    }

    private fun persistNodeFacts(node: NodeInfo) {
        sessionStore.save(node.toRecord(credentialStore))
    }

    private fun setState(next: ConnectionState): ConnectionState {
        _state.value = next
        return next
    }

    private fun NodeInfo.toRecord(store: EncryptedCredentialStore): SessionRecord {
        val credential = store.read()
        return SessionRecord(
            endpoint = endpoint,
            deviceId = deviceId.ifEmpty { credential?.deviceId ?: "" },
            deviceName = deviceName.ifEmpty { credential?.deviceName ?: "" },
            nodeFingerprint = nodeFingerprint,
            serverVersion = serverVersion,
            tokenVersion = credential?.tokenVersion ?: 0,
            pairedAt = credential?.issuedAt ?: System.currentTimeMillis(),
        )
    }

    private fun SessionRecord.toNodeInfo(): NodeInfo = NodeInfo(
        endpoint = endpoint,
        deviceId = deviceId,
        deviceName = deviceName,
        nodeFingerprint = nodeFingerprint,
        serverVersion = serverVersion,
    )

    companion object {
        const val DEVICE_TYPE = "android"
    }
}

data class DisconnectOutcome(
    val node: NodeInfo?,
    val serverConfirmed: Boolean,
)
