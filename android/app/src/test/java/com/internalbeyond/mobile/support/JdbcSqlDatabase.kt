package com.internalbeyond.mobile.support

import com.internalbeyond.mobile.data.cache.SqlDatabase
import com.internalbeyond.mobile.data.cache.SqlRow
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet

/**
 * A [SqlDatabase] over JDBC, for JVM tests only.
 *
 * This is the reason the cache package has a [SqlDatabase] seam at all: the SQL in
 * `CacheSchema` and `LocalCache` runs here for real (SQLite via sqlite-jdbc), so
 * upsert/delete/tombstone behaviour is asserted rather than assumed. The Android
 * build uses `AndroidSqlDatabase` over `SQLiteDatabase` with the same statements.
 */
class JdbcSqlDatabase private constructor(private val connection: Connection) : SqlDatabase {

    private var depth = 0

    override fun exec(sql: String, args: List<Any?>) {
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.execute()
        }
    }

    override fun <T> query(sql: String, args: List<Any?>, map: (SqlRow) -> T): List<T> {
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeQuery().use { rows ->
                val out = ArrayList<T>()
                while (rows.next()) out.add(map(JdbcRow(rows)))
                return out
            }
        }
    }

    override fun <T> transaction(block: () -> T): T {
        if (depth > 0) return block()
        connection.autoCommit = false
        depth++
        return try {
            val result = block()
            connection.commit()
            result
        } catch (error: Throwable) {
            connection.rollback()
            throw error
        } finally {
            depth--
            connection.autoCommit = true
        }
    }

    override fun close() = connection.close()

    private fun bind(statement: PreparedStatement, args: List<Any?>) {
        for ((index, value) in args.withIndex()) {
            when (value) {
                null -> statement.setObject(index + 1, null)
                is Int -> statement.setInt(index + 1, value)
                is Long -> statement.setLong(index + 1, value)
                is Boolean -> statement.setInt(index + 1, if (value) 1 else 0)
                is Double -> statement.setDouble(index + 1, value)
                else -> statement.setString(index + 1, value.toString())
            }
        }
    }

    private class JdbcRow(private val rows: ResultSet) : SqlRow {
        override fun isNull(index: Int): Boolean = rows.getObject(index + 1) == null
        override fun getString(index: Int): String? = rows.getString(index + 1)
        override fun getLong(index: Int): Long = rows.getLong(index + 1)
        override fun getInt(index: Int): Int = rows.getInt(index + 1)
    }

    companion object {
        /**
         * [path] is a file so a test can close the database and reopen it — which is
         * how "the process died and came back" is simulated.
         */
        fun open(path: String): JdbcSqlDatabase {
            Class.forName("org.sqlite.JDBC")
            val connection = DriverManager.getConnection("jdbc:sqlite:$path")
            return JdbcSqlDatabase(connection)
        }
    }
}
