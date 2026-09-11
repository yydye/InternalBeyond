package com.internalbeyond.mobile.data.auth

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The Android Keystore half of credential storage.
 *
 * The key is created once, lives in the Keystore (never in app storage), is not
 * exportable, and is hardware-backed on devices that have a TEE/StrongBox. That
 * is the whole point: an attacker with the app's data directory gets ciphertext
 * and no key.
 *
 * Deliberate choice — **no** `setUserAuthenticationRequired(true)`. Requiring the
 * lock screen per read would mean the app cannot reconnect in the background or
 * after a reboot without a prompt, which is not what this stage needs. The
 * documented tradeoff: someone who can already unlock the phone and read app
 * storage is not the threat this defends against; a stolen data directory or a
 * backup is.
 *
 * `setRandomizedEncryptionRequired(true)` is set so the provider itself refuses a
 * caller-supplied (and therefore possibly reused) IV — GCM fails catastrophically
 * on IV reuse, and this makes that failure impossible rather than merely unlikely.
 */
object AndroidKeyProvider : SecureEnvelope.KeyProvider {

    private const val ALIAS = "ib.device.credential.v1"
    private const val PROVIDER = "AndroidKeyStore"

    @Volatile
    private var cached: SecretKey? = null

    override fun key(): SecretKey {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val key = loadExisting() ?: generate()
            cached = key
            return key
        }
    }

    /** True when a key exists; false means the credential is unrecoverable. */
    fun hasKey(): Boolean = try {
        keyStore().containsAlias(ALIAS)
    } catch (_: Exception) {
        false
    }

    /**
     * Drop the cached reference so a subsequent [key] re-reads the Keystore.
     * Used after the app detects that the stored credential no longer opens.
     */
    fun invalidateCache() {
        cached = null
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun loadExisting(): SecretKey? = try {
        keyStore().getKey(ALIAS, null) as? SecretKey
    } catch (_: Exception) {
        null
    }

    private fun generate(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }
}

/** SharedPreferences as a [KeyValueStore]. */
class SharedPrefsKeyValueStore(
    private val prefs: SharedPreferences,
) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)

    override fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }

    override fun keys(): Set<String> = prefs.all.keys.toSet()

    companion object {
        /**
         * The sealed credential lives in its own preferences file, so that
         * clearing cached data cannot accidentally clear it and vice versa.
         */
        fun secure(context: Context): SharedPrefsKeyValueStore =
            SharedPrefsKeyValueStore(context.getSharedPreferences("ib_secure", Context.MODE_PRIVATE))

        /** Non-secret session facts. See [SessionStore] for why these are plain. */
        fun session(context: Context): SharedPrefsKeyValueStore =
            SharedPrefsKeyValueStore(context.getSharedPreferences("ib_session", Context.MODE_PRIVATE))
    }
}
