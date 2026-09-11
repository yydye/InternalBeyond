package com.internalbeyond.mobile.data.auth

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM sealing for the one value this app must keep secret: the device
 * token.
 *
 * Format: `base64( iv[12] || ciphertext+tag )`. The IV is random per seal (GCM
 * requires uniqueness per key, and the Keystore key is created with
 * `setRandomizedEncryptionRequired(true)` to enforce it at the provider).
 *
 * The key comes from a [KeyProvider] rather than from this class, which is what
 * makes the whole thing JVM-testable: on Android the provider is the Android
 * Keystore (non-exportable, hardware-backed where available); in a unit test it
 * is an in-memory `SecretKeySpec`. The sealing logic is identical in both.
 *
 * [open] returns null for ANY failure — a truncated blob, a tampered tag, a
 * Keystore key that was invalidated. It never throws and never returns partial
 * data, because the caller's only correct response is "this credential is
 * unusable, ask for a new one".
 */
class SecureEnvelope(
    private val random: SecureRandom = SecureRandom(),
    /**
     * Declared LAST so that `SecureEnvelope { key }` reads as "seal with this key",
     * which is how every call site in the app and the tests is written.
     */
    private val keyProvider: KeyProvider,
) {

    fun interface KeyProvider {
        fun key(): SecretKey
    }

    fun seal(plaintext: String): String? = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider.key())
        val iv = cipher.iv
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val out = ByteArray(iv.size + sealed.size)
        System.arraycopy(iv, 0, out, 0, iv.size)
        System.arraycopy(sealed, 0, out, iv.size, sealed.size)
        Base64.getEncoder().encodeToString(out)
    } catch (_: Exception) {
        null
    }

    fun open(sealed: String): String? = try {
        val bytes = Base64.getDecoder().decode(sealed)
        if (bytes.size <= IV_BYTES) {
            null
        } else {
            val iv = bytes.copyOfRange(0, IV_BYTES)
            val body = bytes.copyOfRange(IV_BYTES, bytes.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, keyProvider.key(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        }
    } catch (_: Exception) {
        null
    }

    /** Deterministic IV, for tests that need to prove uniqueness matters. */
    internal fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}
