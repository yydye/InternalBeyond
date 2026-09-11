package com.internalbeyond.mobile.data.api

import org.json.JSONArray
import org.json.JSONObject

/**
 * Small helpers over org.json.
 *
 * org.json ships inside the Android platform, so these cost no APK bytes, and
 * because every accessor below is explicit the protocol's strictness stays
 * visible in the call sites: a missing key yields `null` rather than a silent
 * `0`/`""`, which is exactly the distinction the version check depends on.
 */
internal fun JSONObject.strOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key, "")
}

internal fun JSONObject.longOrNull(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    val raw = opt(key)
    return when (raw) {
        is Number -> raw.toLong()
        is String -> raw.toLongOrNull()
        else -> null
    }
}

internal fun JSONObject.intOrNull(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    val raw = opt(key)
    return when (raw) {
        is Number -> raw.toInt()
        is String -> raw.toIntOrNull()
        else -> null
    }
}

internal fun JSONObject.doubleOrNull(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    val raw = opt(key)
    return when (raw) {
        is Number -> raw.toDouble()
        is String -> raw.toDoubleOrNull()
        else -> null
    }
}

internal fun JSONObject.boolOrNull(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    val raw = opt(key)
    return when (raw) {
        is Boolean -> raw
        is Number -> raw.toInt() != 0
        is String -> when (raw.lowercase()) {
            "true", "1", "yes" -> true
            "false", "0", "no" -> false
            else -> null
        }
        else -> null
    }
}

internal fun JSONObject.objOrNull(key: String): JSONObject? {
    if (!has(key) || isNull(key)) return null
    return optJSONObject(key)
}

internal fun JSONObject.arrOrNull(key: String): JSONArray? {
    if (!has(key) || isNull(key)) return null
    return optJSONArray(key)
}

/** Non-blank trimmed string, or null. */
internal fun JSONObject.textOrNull(key: String): String? = strOrNull(key)?.trim()?.takeIf { it.isNotEmpty() }

internal fun JSONArray.strings(): List<String> {
    val out = ArrayList<String>(length())
    for (i in 0 until length()) {
        val value = opt(i)
        if (value == null || value == JSONObject.NULL) continue
        val text = value.toString()
        if (text.isNotEmpty()) out.add(text)
    }
    return out
}

internal fun JSONArray.objects(): List<JSONObject> {
    val out = ArrayList<JSONObject>(length())
    for (i in 0 until length()) {
        optJSONObject(i)?.let { out.add(it) }
    }
    return out
}

/** Put a key only when the value is non-null — used to build request bodies. */
internal fun JSONObject.putIfPresent(key: String, value: Any?): JSONObject {
    if (value != null) put(key, value)
    return this
}
