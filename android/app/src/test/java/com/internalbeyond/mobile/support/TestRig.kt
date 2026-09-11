package com.internalbeyond.mobile.support

import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.auth.EncryptedCredentialStore
import com.internalbeyond.mobile.data.auth.InMemoryKeyValueStore
import com.internalbeyond.mobile.data.auth.KeyValueStore
import com.internalbeyond.mobile.data.auth.SecureEnvelope
import com.internalbeyond.mobile.data.auth.SessionStore
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.repository.ChatRepository
import com.internalbeyond.mobile.data.repository.CharacterRepository
import com.internalbeyond.mobile.data.repository.ConversationSession
import com.internalbeyond.mobile.data.repository.SessionHolder
import com.internalbeyond.mobile.data.repository.SessionRepository
import com.internalbeyond.mobile.data.sync.SyncEngine
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.platform.StreamRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.json.JSONObject
import javax.crypto.spec.SecretKeySpec

/**
 * Fixed DTOs used across the JVM tests.
 *
 * The token and pairing secret here are deliberately shaped like the real ones
 * (`ibd1_…`, 40+ characters) so that the redaction test proves something: the same
 * recognisers that guard logcat must match these.
 */
object DtoFixtures {

    const val CHARACTER_ID = "friend_test_a"
    const val CONVERSATION = "dm:friend_test_a"
    const val TIMESTAMP = 1_700_000_000_000L
    const val REQUEST_ID = "req_fixture_0001"
    const val TURN_ID = "turn_fixture_0001"
    const val USER_MESSAGE_ID = "msg_req_fixture_0001_u"
    const val TOKEN = "ibd1_FAKEtokenFAKEtokenFAKEtokenFAKEtoken00"
    const val PAIRING_ID = "pair_FAKEpairing0001"
    const val PAIRING_SECRET = "FAKEsecretFAKEsecretFAKEsecretFAKEsecret00"
    const val NODE_FINGERPRINT = "FAKEFINGERPRINT"

    fun character(id: String = CHARACTER_ID): JSONObject = JSONObject()
        .put("id", id)
        .put("name", "小满")
        .put("avatar", "")
        .put("relationship", "同桌")
        .put("handle", "xiaoman")
        .put("signature", "今天也要开心")
        .put("bio", "喜欢下雨天")
        .put("banner", "")
        .put("createdAt", TIMESTAMP)
        .put("model", "mock-model")
        .put("status", "active")
        .put(
            "capabilities",
            JSONObject().put("chat", true).put("stream", true).put("vision", false).put("webSearch", false),
        )

    fun assistantMessage(content: String, id: String = "msg_a1"): JSONObject = JSONObject()
        .put("id", id)
        .put("role", "assistant")
        .put("content", content)
        .put("timestamp", TIMESTAMP + 1000)
        .put("conversationId", CONVERSATION)
        .put("metadata", JSONObject().put("model_id", "mock-model"))

    fun userMessage(content: String, id: String = USER_MESSAGE_ID): JSONObject = JSONObject()
        .put("id", id)
        .put("role", "user")
        .put("content", content)
        .put("timestamp", TIMESTAMP)
        .put("conversationId", CONVERSATION)

    fun device(): JSONObject = JSONObject()
        .put("deviceId", "dev_fixture")
        .put("name", "Test Phone")
        .put("type", "android")
        .put("createdAt", TIMESTAMP)
        .put("lastSeenAt", TIMESTAMP)
        .put("revoked", false)
        .put("tokenVersion", 1)
        .put("capabilities", org.json.JSONArray().put("chat").put("sync"))
        .put("appForeground", true)

    /** A pairing payload exactly as `POST /pairing/session` returns it. */
    fun pairingSessionPayload(port: Int, host: String = "127.0.0.1"): JSONObject = JSONObject()
        .put("pairingId", PAIRING_ID)
        .put("secret", PAIRING_SECRET)
        .put("expiresAt", System.currentTimeMillis() + 300_000)
        .put("ttlMs", 300_000)
        .put("lanReachable", true)
        .put(
            "endpoints",
            JSONObject()
                .put("mobile", JSONObject().put("host", host).put("port", port).put("scheme", "http"))
                .put("pairPath", "/mobile/v1/pairing/complete"),
        )
        .put("fingerprint", NODE_FINGERPRINT)

    /** The whole HTTP envelope, which a user may also paste. */
    fun pairingEnvelope(port: Int): JSONObject = JSONObject()
        .put("v", 1)
        .put("ok", true)
        .put("type", "pairing.session")
        .put("payload", pairingSessionPayload(port))
}

/**
 * Assembles the production objects a repository test needs, against either the
 * in-process [FakeHomeNode] or a real Home Node on [baseUrl].
 */
class TestRig(
    dbPath: String,
    private val fake: FakeHomeNode? = null,
    private val realBaseUrl: String? = null,
) {
    val db = JdbcSqlDatabase.open(dbPath)
    val cache = LocalCache(db)

    private val endpoint: HomeNodeEndpoint = when {
        fake != null -> HomeNodeEndpoint("http", "127.0.0.1", fake.port)
        realBaseUrl != null -> HomeNodeEndpoint.parseOverride(realBaseUrl, "http")!!
        else -> error("TestRig needs a fake or a real Home Node")
    }

    /** Mirrors the app: the endpoint and credential live in a holder the client reads. */
    val holder = SessionHolder().apply {
        endpoint = this@TestRig.endpoint
        token = DtoFixtures.TOKEN
    }

    val failureSink = mutableListOf<ProtocolError>()

    val client = HomeNodeClient(
        endpointProvider = { holder.endpoint },
        tokenProvider = { holder.token },
    )

    val streams = StreamRegistry()
    val sync = SyncEngine(client, cache)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** A JVM stand-in for the Keystore-backed store; the sealing code is the same. */
    fun credentialStore(store: KeyValueStore = InMemoryKeyValueStore()): EncryptedCredentialStore =
        EncryptedCredentialStore(store, SecureEnvelope { SecretKeySpec(ByteArray(32) { it.toByte() }, "AES") })

    val credentials: EncryptedCredentialStore = credentialStore()
    val sessions: SessionStore = SessionStore(InMemoryKeyValueStore())

    /**
     * ONE repository per rig. A test that pairs through this instance and then asks
     * a freshly built one whether it is connected would be testing nothing.
     */
    val session: SessionRepository by lazy {
        SessionRepository(
            client = client,
            holder = holder,
            credentialStore = credentials,
            sessionStore = sessions,
            streams = streams,
            presenceReporter = {},
        )
    }

    fun sessionRepository(): SessionRepository = session

    /**
     * A second repository with EMPTY in-memory state, sharing only what a restarted
     * process would still have: the encrypted credential and the session record.
     * This is how "the app comes back up and reconnects to the same Home Node" is
     * tested without pretending.
     */
    fun restartedSessionRepository(): SessionRepository {
        val freshHolder = SessionHolder()
        val freshClient = HomeNodeClient(
            endpointProvider = { freshHolder.endpoint },
            tokenProvider = { freshHolder.token },
        )
        return SessionRepository(
            client = freshClient,
            holder = freshHolder,
            credentialStore = credentials,
            sessionStore = sessions,
            streams = streams,
            presenceReporter = {},
        )
    }

    /** The real character repository, so cache-first behaviour is tested, not simulated. */
    val characters: CharacterRepository by lazy {
        CharacterRepository(
            client = client,
            cache = cache,
            nodeKey = { endpoint.key },
            onFailure = { failureSink.add(it) },
        )
    }

    fun endpointForDisplay(): HomeNodeEndpoint = endpoint

    fun session(characterId: String = DtoFixtures.CHARACTER_ID): ConversationSession = ConversationSession(
        characterId = characterId,
        client = client,
        cache = cache,
        sync = sync,
        streams = streams,
        scope = scope,
        nodeKey = { endpoint.key },
        onFailure = { failureSink.add(it) },
    )
    fun chatRepository(): ChatRepository = ChatRepository(
        client = client,
        cache = cache,
        sync = sync,
        streams = streams,
        scope = scope,
        nodeKey = { endpoint.key },
        onFailure = { failureSink.add(it) },
    )

    fun close() {
        streams.cancelAll()
        db.close()
    }
}
