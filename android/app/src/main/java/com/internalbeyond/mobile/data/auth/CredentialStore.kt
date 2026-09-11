package com.internalbeyond.mobile.data.auth

import org.json.JSONObject

/**
 * The device credential the Home Node issued at pairing.
 *
 * `token` is the only secret in this app. It is an opaque `ibd1_…` string; there
 * is no JWT to parse, no expiry to count down, and nothing in it is meaningful to
 * the client (docs/MOBILE_GATEWAY.md §3.2). Revocation is decided entirely by the
 * server, which is why the client never tries to predict it.
 */
data class DeviceCredential(
    val token: String,
    val deviceId: String,
    val deviceName: String,
    val tokenVersion: Int,
    val issuedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("token", token)
        .put("deviceId", deviceId)
        .put("deviceName", deviceName)
        .put("tokenVersion", tokenVersion)
        .put("issuedAt", issuedAt)

    companion object {
        fun fromJson(raw: String): DeviceCredential? = try {
            val obj = JSONObject(raw)
            val token = obj.optString("token", "")
            if (token.isEmpty()) {
                null
            } else {
                DeviceCredential(
                    token = token,
                    deviceId = obj.optString("deviceId", ""),
                    deviceName = obj.optString("deviceName", ""),
                    tokenVersion = obj.optInt("tokenVersion", 0),
                    issuedAt = obj.optLong("issuedAt", 0L),
                )
            }
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * Where the device credential lives (Phase 6).
 *
 * Two hard rules, both structural rather than conventional:
 *
 * * the token is **encrypted** before it touches the backing store
 *   ([SecureEnvelope] with a Keystore key), so the bytes at rest are ciphertext;
 * * the [DeviceCredential] value never reaches a log call — and even if it did,
 *   [com.internalbeyond.mobile.platform.IbLog] redacts anything shaped like
 *   `ibd1_…` before writing.
 *
 * There is no `token` accessor without a successful decrypt, and no fallback to a
 * plaintext path: if the Keystore key is gone, [read] returns null and the app
 * asks the user to pair again. Degrading to "store it in the clear" is the one
 * outcome that must be impossible.
 */
class EncryptedCredentialStore(
    private val store: KeyValueStore,
    private val envelope: SecureEnvelope,
) {

    fun read(): DeviceCredential? {
        val sealed = store.getString(KEY_CREDENTIAL) ?: return null
        val plaintext = envelope.open(sealed) ?: return null
        return DeviceCredential.fromJson(plaintext)
    }

    fun write(credential: DeviceCredential) {
        val plaintext = credential.toJson().toString()
        val sealed = envelope.seal(plaintext)
        if (sealed == null) {
            // Not silently ignored: a credential that cannot be sealed must not be
            // written at all, and must not be written in the clear either.
            throw IllegalStateException("could not seal the device credential")
        }
        store.putString(KEY_CREDENTIAL, sealed)
    }

    fun clear() {
        store.remove(KEY_CREDENTIAL)
    }

    /** True when *something* is stored, whether or not it can still be opened. */
    fun hasStoredCredential(): Boolean = store.getString(KEY_CREDENTIAL) != null

    companion object {
        const val KEY_CREDENTIAL = "device_credential_v1"
    }
}
