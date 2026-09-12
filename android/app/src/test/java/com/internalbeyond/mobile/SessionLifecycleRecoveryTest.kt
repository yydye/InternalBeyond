package com.internalbeyond.mobile

import com.internalbeyond.mobile.app.BackStack
import com.internalbeyond.mobile.app.Route
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.auth.DeviceCredential
import com.internalbeyond.mobile.data.auth.EncryptedCredentialStore
import com.internalbeyond.mobile.data.auth.InMemoryKeyValueStore
import com.internalbeyond.mobile.data.auth.KeyValueStore
import com.internalbeyond.mobile.data.auth.SecureEnvelope
import com.internalbeyond.mobile.data.auth.SessionRecord
import com.internalbeyond.mobile.data.auth.SessionStore
import com.internalbeyond.mobile.data.repository.PairingResult
import com.internalbeyond.mobile.data.repository.SessionHolder
import com.internalbeyond.mobile.data.repository.SessionRecovery
import com.internalbeyond.mobile.data.repository.SessionRepository
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.TransportKind
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.domain.model.NodeInfo
import com.internalbeyond.mobile.domain.model.PairingStep
import com.internalbeyond.mobile.platform.StreamRegistry
import com.internalbeyond.mobile.support.DtoFixtures
import com.internalbeyond.mobile.support.FakeHomeNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.spec.SecretKeySpec

/**
 * M1-C.2e · Android re-pair recovery.
 *
 * A real device reached a state that survived process death:
 *
 * ```
 * not connected  +  cannot pair  =  unrecoverable without clearing app data
 * ```
 *
 * This file is the regression test for that state. It deliberately does NOT assert
 * "click disconnect → PairingScreen": that is not the bug, and a test that only did
 * that passes on the broken build. Every case here reproduces the *persisted* facts a
 * real phone actually had, then asks the app's own navigation rule where the user
 * would land.
 *
 * The state machine under test is the production one — the real [SessionRepository],
 * [SessionStore] and [EncryptedCredentialStore], with only the backing bytes replaced
 * by in-memory stores and the Home Node by [FakeHomeNode]. A "restart" is a second
 * repository sharing nothing but those bytes, which is exactly what a restarted
 * process keeps.
 */
class SessionLifecycleRecoveryTest {

    private val fake = FakeHomeNode().start()

    /** The device's bytes at rest: what a restarted process still has. */
    private val secureBytes: KeyValueStore = InMemoryKeyValueStore()
    private val sessionBytes: KeyValueStore = InMemoryKeyValueStore()

    /** The key a unit test can use instead of the Android Keystore. */
    private fun envelope(): SecureEnvelope =
        SecureEnvelope { SecretKeySpec(ByteArray(32) { it.toByte() }, "AES") }

    private fun credentials(store: KeyValueStore = secureBytes) =
        EncryptedCredentialStore(store, envelope())

    private fun records(store: KeyValueStore = sessionBytes) = SessionStore(store)

    /**
     * A repository with EMPTY in-memory state, sharing only [secureBytes] and
     * [sessionBytes]. Calling it twice is "the app was force-stopped and relaunched".
     */
    private fun coldStart(
        secure: KeyValueStore = secureBytes,
        session: KeyValueStore = sessionBytes,
    ): SessionRepository {
        val holder = SessionHolder()
        return SessionRepository(
            client = HomeNodeClient(
                endpointProvider = { holder.endpoint },
                tokenProvider = { holder.token },
            ),
            holder = holder,
            credentialStore = credentials(secure),
            sessionStore = records(session),
            streams = StreamRegistry(),
            presenceReporter = {},
        )
    }

    private fun payload(): String = DtoFixtures.pairingEnvelope(fake.port).toString()

    /** Pair through the production path — the only way this app can hold a credential. */
    private fun pairSuccessfully(repo: SessionRepository): ConnectionState = runBlocking {
        val result = repo.pair(payload(), "127.0.0.1:${fake.port}", "Test Phone")
        assertTrue("the harness must pair successfully: $result", result is PairingResult.Success)
        repo.state.value
    }

    // ── T1 · disconnect is an explicit transition, not partial cleanup ───────────

    @Test
    fun t01_disconnect_leaves_no_usable_session_locally() = runBlocking {
        val repo = coldStart()
        assertTrue(pairSuccessfully(repo) is ConnectionState.Connected)
        assertNotNull("pairing must persist a session record", records().load())
        assertNotNull("pairing must persist a credential", credentials().read())

        repo.disconnect()
        assertEquals(ConnectionState.Unpaired, repo.state.value)

        // Nothing that could be mistaken for a configured device may survive.
        assertNull("the session record must not survive disconnect", records().load())
        assertNull("the credential must not survive disconnect", credentials().read())
        assertFalse(credentials().hasStoredCredential())
    }

    @Test
    fun t02_disconnect_is_immediately_recoverable_in_process() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        repo.disconnect()

        // The app's own navigation rule, asked the question the UI asks it.
        assertEquals(
            "with no usable session the root destination must be pairing",
            Route.Pairing,
            SessionRecovery.rootDestination(repo.state.value),
        )
        assertTrue(
            "an unpaired session must be classed as needing re-pair",
            SessionRecovery.needsRepair(repo.state.value),
        )
    }

    // ── T2 · cold-start recovery: the real-device regression ─────────────────────

    @Test
    fun t03_cold_boot_after_disconnect_reaches_pairing() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        repo.disconnect()

        // Process death, then a cold boot reading ONLY what was persisted.
        val restarted = coldStart()
        val booted = restarted.boot()

        assertEquals(
            "a disconnected device must boot as unpaired, not as merely expired",
            ConnectionState.Unpaired,
            booted,
        )
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    @Test
    fun t04_cold_boot_then_re_pair_establishes_a_fresh_session() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        repo.disconnect()

        val restarted = coldStart()
        restarted.boot()
        assertTrue(pairSuccessfully(restarted) is ConnectionState.Connected)

        assertNotNull("the new pairing must persist its own record", records().load())
        assertNotNull("the new pairing must persist its own credential", credentials().read())
        assertEquals(Route.Characters, SessionRecovery.rootDestination(restarted.state.value))
    }

    // ── T3 · partial stale state can never hide pairing ──────────────────────────

    /**
     * A record with no credential material is a state the real implementation can
     * persist: `SessionRepository.pair()` writes the credential first and the record
     * second precisely so this is survivable.
     */
    @Test
    fun t05_a_session_record_with_no_credential_material_is_unpaired() {
        records().save(recordFor(fake.port))

        val booted = coldStart().boot()

        assertEquals("an endpoint plus a record is not a session", ConnectionState.Unpaired, booted)
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    @Test
    fun t06_an_unopenable_credential_blob_is_unpaired_and_pairing_is_reachable() {
        records().save(recordFor(fake.port))
        // A real shape and a real length, unopenable with the device key: what a lost
        // Keystore key or a half-written blob looks like from here.
        secureBytes.putString(
            EncryptedCredentialStore.KEY_CREDENTIAL,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )

        val booted = coldStart().boot()

        assertTrue("an unreadable credential is not a session: got $booted", SessionRecovery.needsRepair(booted))
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    @Test
    fun t07_an_empty_credential_blob_is_unpaired() {
        records().save(recordFor(fake.port))
        secureBytes.putString(EncryptedCredentialStore.KEY_CREDENTIAL, "")

        val booted = coldStart().boot()

        // An empty blob IS stored credential material that cannot be opened, so
        // AuthExpired is the honest report — the invariant under test is that it still
        // reaches pairing, not which of the two honest labels it wears.
        assertTrue(
            "an unopenable blob must not boot as configured: $booted",
            booted is ConnectionState.Unpaired || booted is ConnectionState.AuthExpired,
        )
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
        assertTrue(SessionRecovery.needsRepair(booted))
    }

    @Test
    fun t08_a_malformed_session_record_is_unpaired() {
        sessionBytes.putString(SessionStore.KEY_SESSION, "{not json at all")

        val booted = coldStart().boot()

        assertEquals(ConnectionState.Unpaired, booted)
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    @Test
    fun t09_a_credential_with_no_session_record_is_unpaired() {
        credentials().write(
            DeviceCredential(DtoFixtures.TOKEN, "dev_fixture", "Test Phone", 1, 1L),
        )

        val booted = coldStart().boot()

        assertEquals(ConnectionState.Unpaired, booted)
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    /**
     * The same question asked of four independent persisted states, each seeded into
     * its own bytes. This is the "no partial state can orphan the pairing screen"
     * gate stated once, rather than four times.
     */
    @Test
    fun t10_no_persisted_partial_state_orphans_the_pairing_screen() {
        val seeds: List<Pair<String, (KeyValueStore, KeyValueStore) -> Unit>> = listOf(
            "endpoint record only" to { _, session ->
                SessionStore(session).save(recordFor(fake.port))
            },
            "credential only" to { secure, _ ->
                EncryptedCredentialStore(secure, envelope()).write(
                    DeviceCredential(DtoFixtures.TOKEN, "dev_fixture", "Test Phone", 1, 1L),
                )
            },
            "record + empty blob" to { secure, session ->
                SessionStore(session).save(recordFor(fake.port))
                secure.putString(EncryptedCredentialStore.KEY_CREDENTIAL, "")
            },
            "record + garbage blob" to { secure, session ->
                SessionStore(session).save(recordFor(fake.port))
                secure.putString(EncryptedCredentialStore.KEY_CREDENTIAL, "%%not-base64%%")
            },
            "nothing at all" to { _, _ -> },
        )

        for ((label, seed) in seeds) {
            val secure = InMemoryKeyValueStore()
            val session = InMemoryKeyValueStore()
            seed(secure, session)

            val booted = coldStart(secure, session).boot()

            assertTrue(
                "[$label] must not boot into an unrecoverable root, got $booted",
                SessionRecovery.needsRepair(booted),
            )
            assertEquals("[$label]", Route.Pairing, SessionRecovery.rootDestination(booted))
        }
    }

    // ── T4 · offline is not unpaired ─────────────────────────────────────────────

    @Test
    fun t11_an_unreachable_home_node_does_not_destroy_a_valid_session() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        val record = records().load()!!
        val credential = credentials().read()!!

        fake.stop()

        val restarted = coldStart()
        val booted = restarted.boot()
        assertTrue(
            "a locally valid session must boot as configured, got $booted",
            booted is ConnectionState.Connected || booted is ConnectionState.Offline,
        )

        val error = restarted.verify()
        assertNotNull("verification against a dead node must fail", error)
        assertTrue(
            "an unreachable node must report offline, not unpaired: ${restarted.state.value}",
            restarted.state.value is ConnectionState.Offline,
        )

        // The whole point: retryable, not destructive.
        assertEquals("the endpoint must be retained", record.endpoint, records().load()?.endpoint)
        assertEquals("the credential must be retained", credential.token, credentials().read()?.token)
        assertEquals(
            "an offline device stays configured, so it does not fall back to pairing",
            Route.Characters,
            SessionRecovery.rootDestination(restarted.state.value),
        )
    }

    // ── T5 · permanent authentication rejection ──────────────────────────────────

    @Test
    fun t12_a_revoked_credential_exposes_a_re_pair_path() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)

        repo.handleFailure(
            ProtocolError.Server(ProtocolError.DEVICE_REVOKED, "revoked", retryable = false),
        )

        assertTrue(
            "a revoked device must be offered re-pairing: ${repo.state.value}",
            SessionRecovery.needsRepair(repo.state.value),
        )
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(repo.state.value))
        assertNull("nothing usable may remain after a revocation", credentials().read())
    }

    @Test
    fun t13_a_generic_timeout_never_triggers_a_destructive_reset() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        val record = records().load()!!

        repo.handleFailure(ProtocolError.Transport(TransportKind.TIMEOUT, "slow"))

        assertTrue("a timeout is offline, got ${repo.state.value}", repo.state.value is ConnectionState.Offline)
        assertNotNull("a timeout must never delete the credential", credentials().read())
        assertEquals("a timeout must never delete the record", record.deviceId, records().load()?.deviceId)
        assertFalse("a timeout is not a re-pair", SessionRecovery.needsRepair(repo.state.value))
    }

    // ── T6 · pair A → disconnect → pair B ────────────────────────────────────────

    @Test
    fun t14_re_pairing_after_disconnect_cannot_inherit_the_old_session() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)
        val first = records().load()!!

        repo.disconnect()
        assertNull("disconnect must clear the record before a re-pair", records().load())

        assertTrue(pairSuccessfully(repo) is ConnectionState.Connected)
        val second = records().load()!!

        assertEquals("the device identity comes from the new exchange", first.deviceId, second.deviceId)
        assertEquals("the node facts come from the new exchange", first.endpoint, second.endpoint)
        assertEquals("the new record carries the new pairing time", second.tokenVersion, 1)
        assertNotNull(credentials().read())
        assertEquals(Route.Characters, SessionRecovery.rootDestination(repo.state.value))
    }

    @Test
    fun t15_a_rejected_pairing_payload_leaves_the_device_unpaired() = runBlocking {
        val repo = coldStart()
        val result = repo.pair("{ not a pairing payload }", null, "Test Phone")
        assertTrue("a malformed payload must not pair", result is PairingResult.Invalid)

        val booted = coldStart().boot()
        assertEquals("a failed pairing must leave the device unpaired: $booted", ConnectionState.Unpaired, booted)
        assertEquals(Route.Pairing, SessionRecovery.rootDestination(booted))
    }

    // ── T7 · Back cannot resurrect a stale configured screen ─────────────────────

    @Test
    fun t16_back_cannot_resurrect_a_disconnected_session() = runBlocking {
        val repo = coldStart()
        pairSuccessfully(repo)

        val stack = BackStack(SessionRecovery.rootDestination(repo.state.value))
        assertEquals(Route.Characters, stack.current)

        repo.disconnect()
        stack.reset(SessionRecovery.rootDestination(repo.state.value))

        assertEquals(Route.Pairing, stack.current)
        assertFalse("there must be nothing below pairing to go Back to", stack.canGoBack)
        assertFalse("Back at the root must let the platform exit", stack.pop())
        assertEquals(Route.Pairing, stack.current)
    }

    // ── T8 · the navigation rule covers every session state ──────────────────────

    /**
     * The M1-C.2e bug was not a wrong branch — it was a **missing** one. The navigation
     * reset enumerated `Revoked` and `AuthExpired` by hand and silently omitted
     * `Unpaired`, so a state meaning "no usable session" produced no recovery.
     *
     * [allStates] below is an exhaustive `when` over [ConnectionState], so adding a
     * variant is a COMPILE ERROR here until it is classified — the check the old
     * hand-written rule lacked, obtained without adding reflection or an annotation
     * processor to the build.
     */
    @Test
    fun t17_every_connection_state_is_routed_one_way_or_the_other() {
        val node = NodeInfo(
            endpoint = HomeNodeEndpoint("http", "127.0.0.1", HomeNodeEndpoint.DEFAULT_PORT),
            deviceId = "dev",
            deviceName = "phone",
        )
        val error = ProtocolError.Local("stub")

        val unusable = listOf(
            ConnectionState.Unpaired,
            ConnectionState.AuthExpired(node, error),
            ConnectionState.Revoked(node, error),
            ConnectionState.Failed(node, error),
        )
        val usable = listOf(
            ConnectionState.Connected(node),
            ConnectionState.Offline(node, error),
            ConnectionState.Pairing(PairingStep.EXCHANGING),
        )

        assertEquals("every ConnectionState variant must be classified", 7, (unusable + usable).size)
        assertEquals(
            "the seven variants must all be named",
            listOf("unpaired", "auth-expired", "revoked", "failed", "connected", "offline", "pairing"),
            (unusable + usable).map(::allStates),
        )

        // The verdict and the destination can never disagree, for any state.
        for (state in unusable + usable) {
            assertEquals(
                "$state: destination and repair must agree",
                if (SessionRecovery.needsRepair(state)) Route.Pairing else Route.Characters,
                SessionRecovery.rootDestination(state),
            )
        }

        // A device holding no usable session is exactly the case that must never be
        // left without a way back to pairing.
        for (state in unusable) {
            assertTrue("$state must offer pairing", SessionRecovery.needsRepair(state))
            assertEquals("$state", Route.Pairing, SessionRecovery.rootDestination(state))
        }

        // Configured-or-busy states must NOT be yanked to pairing.
        for (state in usable) {
            assertFalse("$state must not be treated as unpaired", SessionRecovery.needsRepair(state))
            assertEquals("$state", Route.Characters, SessionRecovery.rootDestination(state))
        }
    }

    /** Exhaustive on purpose: a new [ConnectionState] fails to COMPILE until classified. */
    private fun allStates(state: ConnectionState): String = when (state) {
        is ConnectionState.Unpaired -> "unpaired"
        is ConnectionState.AuthExpired -> "auth-expired"
        is ConnectionState.Revoked -> "revoked"
        is ConnectionState.Failed -> "failed"
        is ConnectionState.Connected -> "connected"
        is ConnectionState.Offline -> "offline"
        is ConnectionState.Pairing -> "pairing"
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private fun recordFor(port: Int): SessionRecord = SessionRecord(
        endpoint = HomeNodeEndpoint("http", "127.0.0.1", port),
        deviceId = "dev_fixture",
        deviceName = "Test Phone",
        nodeFingerprint = DtoFixtures.NODE_FINGERPRINT,
        serverVersion = "fake-1.0",
        tokenVersion = 1,
        pairedAt = System.currentTimeMillis(),
    )
}
