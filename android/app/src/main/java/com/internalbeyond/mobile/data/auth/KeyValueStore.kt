package com.internalbeyond.mobile.data.auth

/**
 * The smallest possible seam over "somewhere to keep bytes".
 *
 * It exists so that the credential logic — the part that must never be wrong —
 * can be exercised by JVM unit tests against an in-memory implementation, while
 * the Android build uses SharedPreferences. The abstraction deliberately has no
 * Android types in it.
 */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
    fun keys(): Set<String>
}

/** Test double, and a useful default when no platform store is available. */
class InMemoryKeyValueStore(initial: Map<String, String> = emptyMap()) : KeyValueStore {
    private val values = LinkedHashMap<String, String>(initial)

    override fun getString(key: String): String? = values[key]
    override fun putString(key: String, value: String) {
        values[key] = value
    }

    override fun remove(key: String) {
        values.remove(key)
    }

    override fun keys(): Set<String> = values.keys.toSet()

    /** Everything at rest, verbatim — used by tests to prove no token is stored plainly. */
    fun rawValues(): Map<String, String> = LinkedHashMap(values)
}
