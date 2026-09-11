package com.internalbeyond.mobile.ui.common

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Time, in the words a Chinese speaker would use.
 *
 * The old build said "3 min ago" and "never", which is what an English prototype
 * looks like when it is translated by not translating it. These two formatters are
 * the only place the app turns a stored millisecond count into something readable, so
 * a timestamp cannot drift into a second style on a screen that nobody re-checked.
 */
private val clockFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val sameYearFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("M月d日 HH:mm")
private val olderFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy年M月d日")

/** A bare clock for today, a date for anything older. Empty for a missing timestamp. */
fun formatTimestamp(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp <= 0) return ""
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(timestamp).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return when {
        moment.toLocalDate() == today -> clockFormat.format(moment)
        moment.year == today.year -> sameYearFormat.format(moment)
        else -> olderFormat.format(moment)
    }
}

/** "刚刚", "12 分钟前", "3 小时前", "2 天前". */
fun formatRelative(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp <= 0) return "从未"
    val seconds = ((now - timestamp).coerceAtLeast(0)) / 1000
    return when {
        seconds < 60 -> "刚刚"
        seconds < 3600 -> "${seconds / 60} 分钟前"
        seconds < 86_400 -> "${seconds / 3600} 小时前"
        else -> "${seconds / 86_400} 天前"
    }
}
