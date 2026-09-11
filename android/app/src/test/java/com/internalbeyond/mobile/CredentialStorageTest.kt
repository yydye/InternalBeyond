package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.auth.DeviceCredential
import com.internalbeyond.mobile.data.auth.EncryptedCredentialStore
import com.internalbeyond.mobile.data.auth.InMemoryKeyValueStore
import com.internalbeyond.mobile.data.auth.SecureEnvelope
import com.internalbeyond.mobile.data.auth.SessionRecord
import com.internalbeyond.mobile.data.auth.SessionStore
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.support.DtoFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * Unit · device credential storage (Phase 6/36).
 *
 * The claim being tested is narrow and absolute: **the token is not readable in the
 * backing store.** The test has the raw bytes of the store in hand, so this is a
 * direct assertion rather than a check of an API's good intentions.
 *
 * The Keystore itself is Android-only, which is exactly why [SecureEnvelope] takes a
 * key provider: here it is an in-memory AES key, and the sealing logic under test is
 * the same code the phone runs.
 */
class CredentialStorageTest {

    private fun testKey(seed: Byte = 7): SecretKey =
        SecretKeySpec(ByteArray(32) { (it + seed).toByte() }, "AES")

    private fun credential(token: String = DtoFixtures.TOKEN) = DeviceCredential(
        token = token,
        deviceId = "dev_fixture",
        deviceName = "Test Phone",
        tokenVersion = 3,
        issuedAt = DtoFixtures.TIMESTAMP,
    )

    @Test
    fun `a credential round-trips`() {
        val store = InMemoryKeyValueStore()
        val credentials = EncryptedCredentialStore(store, SecureEnvelope { testKey() })
        credentials.write(credential())
        assertEquals(credential(), credentials.read())
    }

    @Test
    fun `the token is not present anywhere in the backing store`() {
        val store = InMemoryKeyValueStore()
        val credentials = EncryptedCredentialStore(store, SecureEnvelope { testKey() })
        credentials.write(credential())

        val raw = store.rawValues()
        assertEquals(1, raw.size)
        val blob = raw.values.first()
        assertFalse("ciphertext must not contain the token", blob.contains(DtoFixtures.TOKEN))
        assertFalse(blob.contains("ibd1_"))
        assertFalse(blob.contains("dev_fixture"))
        // ...and the plaintext must not appear as a decoded prefix either.
        assertFalse(String(java.util.Base64.getDecoder().decode(blob)).contains(DtoFixtures.TOKEN))
    }

    @Test
    fun `sealing twice with the same key produces different ciphertext`() {
        val envelope = SecureEnvelope { testKey() }
        val first = envelope.seal("same input")
        val second = envelope.seal("same input")
        assertNotNull(first)
        assertNotNull(second)
        assertFalse("a random IV per seal is required for GCM", first == second)
        assertEquals("same input", envelope.open(first!!))
        assertEquals("same input", envelope.open(second!!))
    }

    @Test
    fun `a tampered blob is refused instead of yielding partial data`() {
        val envelope = SecureEnvelope { testKey() }
        val sealed = envelope.seal("token-material")!!
        val bytes = java.util.Base64.getDecoder().decode(sealed)
        bytes[bytes.size - 1] = (bytes[bytes.size - 1] + 1).toByte()
        val tampered = java.util.Base64.getEncoder().encodeToString(bytes)
        assertNull(envelope.open(tampered))
    }

    @Test
    fun `truncated and unparsable blobs are refused`() {
        val envelope = SecureEnvelope { testKey() }
        assertNull(envelope.open(""))
        assertNull(envelope.open("not-base64!!"))
        assertNull(envelope.open(java.util.Base64.getEncoder().encodeToString(ByteArray(4))))
    }

    @Test
    fun `a blob sealed with another key cannot be opened`() {
        val sealed = SecureEnvelope { testKey(1) }.seal("secret")!!
        assertNull(SecureEnvelope { testKey(2) }.open(sealed))
    }

    @Test
    fun `a lost key leaves the stored blob in place but unreadable, so the app can say why`() {
        val store = InMemoryKeyValueStore()
        EncryptedCredentialStore(store, SecureEnvelope { testKey() }).write(credential())

        // Same store, different (e.g. regenerated) Keystore key.
        val afterKeystoreReset = EncryptedCredentialStore(store, SecureEnvelope { testKey(99) })
        assertNull(afterKeystoreReset.read())
        assertTrue(
            "the app must be able to distinguish 'unreadable' from 'never paired'",
            afterKeystoreReset.hasStoredCredential(),
        )
    }

    @Test
    fun `clear removes the credential entirely`() {
        val store = InMemoryKeyValueStore()
        val credentials = EncryptedCredentialStore(store, SecureEnvelope { testKey() })
        credentials.write(credential())
        credentials.clear()
        assertNull(credentials.read())
        assertFalse(credentials.hasStoredCredential())
        assertTrue(store.rawValues().isEmpty())
    }

    @Test
    fun `the session record holds no token and survives a round-trip`() {
        val store = InMemoryKeyValueStore()
        val sessions = SessionStore(store)
        val record = SessionRecord(
            endpoint = HomeNodeEndpoint("http", "192.168.1.5", 23118),
            deviceId = "dev_fixture",
            deviceName = "Test Phone",
            nodeFingerprint = DtoFixtures.NODE_FINGERPRINT,
            serverVersion = "1.0.0",
            tokenVersion = 3,
            pairedAt = DtoFixtures.TIMESTAMP,
        )
        sessions.save(record)
        assertEquals(record, sessions.load())
        assertFalse(store.rawValues().values.first().contains("ibd1_"))
    }

    @Test
    fun `an unreadable session record degrades to null rather than throwing`() {
        val store = InMemoryKeyValueStore(mapOf(SessionStore.KEY_SESSION to "{not json"))
        assertNull(SessionStore(store).load())
        val noHost = InMemoryKeyValueStore(
            mapOf(SessionStore.KEY_SESSION to """{"scheme":"http","host":"","port":1}"""),
        )
        assertNull(SessionStore(noHost).load())
    }
}
