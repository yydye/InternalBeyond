package com.internalbeyond.mobile.data.cache

/**
 * The narrowest SQL surface the cache needs.
 *
 * Two reasons it exists rather than using `android.database.sqlite` directly:
 *
 * 1. **The SQL gets tested.** Every statement in [CacheSchema] and [LocalCache]
 *    runs in JVM unit tests against a real SQLite engine (sqlite-jdbc) through
 *    [JdbcSqlDatabase], instead of only ever executing on a device. Cache bugs —
 *    a delete that misses, an upsert that resurrects a tombstone — are exactly the
 *    kind that would otherwise ship untested.
 * 2. **One place knows about Android.** [AndroidSqlDatabase] is the only file in
 *    the cache package that imports `android.database`.
 */
interface SqlDatabase {

    fun exec(sql: String, args: List<Any?> = emptyList())

    fun <T> query(sql: String, args: List<Any?> = emptyList(), map: (SqlRow) -> T): List<T>

    /**
     * Run [block] atomically. Nested calls must join the outer transaction rather
     * than open a second one — SQLite has no nested transactions and a cache sync
     * applies upserts and deletes as one unit on purpose.
     */
    fun <T> transaction(block: () -> T): T

    fun close()
}

/** 0-based column access, which is what both Cursor and ResultSet give us. */
interface SqlRow {
    fun isNull(index: Int): Boolean
    fun getString(index: Int): String?
    fun getLong(index: Int): Long
    fun getInt(index: Int): Int
}

internal fun SqlRow.longOrNull(index: Int): Long? = if (isNull(index)) null else getLong(index)

internal fun SqlRow.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)
