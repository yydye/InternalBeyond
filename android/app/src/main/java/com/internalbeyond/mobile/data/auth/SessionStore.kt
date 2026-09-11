package com.internalbeyond.mobile.data.auth

import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import org.json.JSONObject

/**
 * What this app remembers about the Home Node it is paired with.
 *
 * Every field here is NON-SECRET on purpose (Phase 6: "deviceId 可以普通保存").
 * The reason it is stored unencrypted is functional, not laziness: the app must be
 * able to render "Connected to <node>" and decide whether it is paired *before*
 * it can open the Keystore, and it must be able to tell the user "your credential
 * is unreadable on this device, pair again" rather than showing nothing at all.
 *
 * The credential itself never appears here.
 */
data class SessionRecord(
    val endpoint: HomeNodeEndpoint,
    val deviceId: String,
    val deviceName: String,
    val nodeFingerprint: String,
    val serverVersion: String,
    val tokenVersion: Int,
    val pairedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("scheme", endpoint.scheme)
        .put("host", endpoint.host)
        .put("port", endpoint.port)
        .put("deviceId", deviceId)
        .put("deviceName", deviceName)
        .put("nodeFingerprint", nodeFingerprint)
        .put("serverVersion", serverVersion)
        .put("tokenVersion", tokenVersion)
        .put("pairedAt", pairedAt)

    companion object {
        fun fromJson(raw: String): SessionRecord? = try {
            val obj = JSONObject(raw)
            val endpoint = HomeNodeEndpoint.fromParts(
                scheme = obj.optString("scheme", "http"),
                host = obj.optString("host", ""),
                port = obj.optInt("port", HomeNodeEndpoint.DEFAULT_PORT),
            )
            if (endpoint == null) {
                null
            } else {
                SessionRecord(
                    endpoint = endpoint,
                    deviceId = obj.optString("deviceId", ""),
                    deviceName = obj.optString("deviceName", ""),
                    nodeFingerprint = obj.optString("nodeFingerprint", ""),
                    serverVersion = obj.optString("serverVersion", ""),
                    tokenVersion = obj.optInt("tokenVersion", 0),
                    pairedAt = obj.optLong("pairedAt", 0L),
                )
            }
        } catch (_: Exception) {
            null
        }
    }
}

class SessionStore(private val store: KeyValueStore) {

    fun load(): SessionRecord? {
        val raw = store.getString(KEY_SESSION) ?: return null
        return SessionRecord.fromJson(raw)
    }

    fun save(record: SessionRecord) {
        store.putString(KEY_SESSION, record.toJson().toString())
    }

    fun clear() {
        store.remove(KEY_SESSION)
    }

    companion object {
        const val KEY_SESSION = "session_v1"
    }
}
