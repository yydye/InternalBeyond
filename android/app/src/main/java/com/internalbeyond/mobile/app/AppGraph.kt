package com.internalbeyond.mobile.app

import android.content.Context
import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.auth.AndroidKeyProvider
import com.internalbeyond.mobile.data.auth.EncryptedCredentialStore
import com.internalbeyond.mobile.data.auth.SecureEnvelope
import com.internalbeyond.mobile.data.auth.SessionStore
import com.internalbeyond.mobile.data.auth.SharedPrefsKeyValueStore
import com.internalbeyond.mobile.data.cache.CacheDatabase
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.repository.ChatRepository
import com.internalbeyond.mobile.data.repository.CharacterRepository
import com.internalbeyond.mobile.data.repository.SessionHolder
import com.internalbeyond.mobile.data.repository.SessionRepository
import com.internalbeyond.mobile.data.sync.SyncEngine
import com.internalbeyond.mobile.platform.IbLog
import com.internalbeyond.mobile.platform.StreamRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The object graph, assembled by hand.
 *
 * No DI framework: there are seven objects and they have a strict order, which is
 * clearer written once than expressed as annotations. The wiring itself is the
 * documentation of who is allowed to talk to whom — note that only
 * [HomeNodeClient] knows how to reach the network, and only [SessionRepository]
 * touches the credential.
 */
class AppGraph(context: Context) {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val holder = SessionHolder()

    /** The single HTTP client. Its endpoint and token come from [holder]. */
    val client = HomeNodeClient(
        endpointProvider = { holder.endpoint },
        tokenProvider = { holder.token },
    )

    val cache: LocalCache = LocalCache(CacheDatabase(context.applicationContext).asSqlDatabase())

    val streams = StreamRegistry()

    private val credentialStore: EncryptedCredentialStore = EncryptedCredentialStore(
        store = SharedPrefsKeyValueStore.secure(context.applicationContext),
        envelope = SecureEnvelope(keyProvider = AndroidKeyProvider),
    )

    private val sessionRecords: SessionStore = SessionStore(
        SharedPrefsKeyValueStore.session(context.applicationContext),
    )

    val sync = SyncEngine(client, cache)

    /**
     * Presence is plumbing only (Phase 22): the app reports `appForeground` and
     * nothing else. A failure here is logged and dropped — it must never surface as
     * an error in the UI, because nothing the user does depends on it.
     */
    private val presenceReporter: (Boolean) -> Unit = { foreground ->
        appScope.launch {
            when (val result = client.presenceReport(foreground)) {
                is ApiResult.Ok -> IbLog.debug("presence.reported", "appForeground" to foreground)
                is ApiResult.Err -> IbLog.debug(
                    "presence.failed",
                    IbLog.FIELD_CODE to result.error.code,
                )
            }
        }
    }

    val session: SessionRepository = SessionRepository(
        client = client,
        holder = holder,
        credentialStore = credentialStore,
        sessionStore = sessionRecords,
        streams = streams,
        presenceReporter = presenceReporter,
    )

    val characters = CharacterRepository(
        client = client,
        cache = cache,
        nodeKey = { nodeKey() },
        onFailure = { session.handleFailure(it) },
    )

    val chat = ChatRepository(
        client = client,
        cache = cache,
        sync = sync,
        streams = streams,
        scope = appScope,
        nodeKey = { nodeKey() },
        onFailure = { session.handleFailure(it) },
    )

    /** Every cached fact is scoped to one Home Node endpoint. */
    fun nodeKey(): String = holder.endpoint?.key ?: "unpaired"

    /**
     * Start-up order: restore the session, show the cached catalog immediately, then
     * let the network correct both.
     */
    fun boot() {
        cache.pruneAttempts(ATTEMPT_RETENTION_MS)
        val state = session.boot()
        characters.loadCached()
        IbLog.info(
            "graph.boot",
            IbLog.FIELD_STATUS to state::class.simpleName,
            "cachedCharacters" to characters.state.value.characters.size,
        )
    }
}

/** Terminal attempts are kept for this long so a failed bubble survives a restart. */
private const val ATTEMPT_RETENTION_MS = 7L * 24 * 60 * 60 * 1000
