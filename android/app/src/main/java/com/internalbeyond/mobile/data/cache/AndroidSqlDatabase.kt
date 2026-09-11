package com.internalbeyond.mobile.data.cache

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The only file in the cache package that knows about Android.
 *
 * Value binding note: `SQLiteDatabase` binds every argument as TEXT, so this class
 * stringifies the arguments and lets SQLite's column affinity coerce them back.
 * That works for comparison and assignment, but NOT for `LIMIT`, which is why
 * [LocalCache] interpolates its page sizes (as bounded Ints) instead of binding
 * them.
 */
class AndroidSqlDatabase(private val db: SQLiteDatabase) : SqlDatabase {

    private var transactionDepth = 0

    override fun exec(sql: String, args: List<Any?>) {
        if (args.isEmpty()) {
            db.execSQL(sql)
        } else {
            db.execSQL(sql, args.map { it?.toString() }.toTypedArray())
        }
    }

    override fun <T> query(sql: String, args: List<Any?>, map: (SqlRow) -> T): List<T> {
        db.rawQuery(sql, args.map { it?.toString() }.toTypedArray()).use { cursor ->
            val out = ArrayList<T>(cursor.count)
            while (cursor.moveToNext()) out.add(map(AndroidSqlRow(cursor)))
            return out
        }
    }

    override fun <T> transaction(block: () -> T): T {
        // Android's SQLiteDatabase supports nested transactions by reference
        // counting, but joining the outer one here keeps the "one unit of work"
        // promise explicit and avoids a nested endTransaction() committing early.
        if (transactionDepth > 0) return block()
        db.beginTransaction()
        transactionDepth++
        return try {
            val result = block()
            db.setTransactionSuccessful()
            result
        } finally {
            transactionDepth--
            db.endTransaction()
        }
    }

    override fun close() {
        db.close()
    }
}

private class AndroidSqlRow(private val cursor: Cursor) : SqlRow {
    override fun isNull(index: Int): Boolean = cursor.isNull(index)
    override fun getString(index: Int): String? = if (cursor.isNull(index)) null else cursor.getString(index)
    override fun getLong(index: Int): Long = cursor.getLong(index)
    override fun getInt(index: Int): Int = cursor.getInt(index)
}

/**
 * Opens the cache database.
 *
 * There is no `onUpgrade` migration yet because nothing has shipped. When the
 * first real schema change arrives it must land here explicitly — a cache is
 * disposable, so the honest migration for a version bump is `DROP` + recreate,
 * never a silent assumption that old rows still mean what they used to.
 */
class CacheDatabase(context: Context) :
    SQLiteOpenHelper(context, DATABASE_NAME, null, CacheSchema.VERSION) {

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        // WAL keeps a background sync from blocking the UI's reads.
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        CacheSchema.create(AndroidSqlDatabase(db))
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        for (table in listOf(
            CacheSchema.TABLE_MESSAGES,
            CacheSchema.TABLE_TOMBSTONES,
            CacheSchema.TABLE_CHARACTERS,
            CacheSchema.TABLE_CONVERSATIONS,
            CacheSchema.TABLE_SYNC_STATE,
            CacheSchema.TABLE_ATTEMPTS,
            CacheSchema.TABLE_DRAFTS,
        )) {
            db.execSQL("DROP TABLE IF EXISTS $table")
        }
        CacheSchema.create(AndroidSqlDatabase(db))
    }

    /** Wrap the current handle as a [SqlDatabase] for [LocalCache]. */
    fun asSqlDatabase(): SqlDatabase = AndroidSqlDatabase(writableDatabase)

    companion object {
        const val DATABASE_NAME = "ib-mobile-cache.db"
    }
}
