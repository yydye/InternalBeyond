package com.internalbeyond.mobile.data.sync

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.cache.SyncState
import com.internalbeyond.mobile.platform.IbLog

data class SyncOutcome(
    val pages: Int,
    val upserts: Int,
    val deletes: Int,
    val cursor: Long,
    val revision: Long,
)

/**
 * Drains `sync.changes` from the stored cursor to the head (Phase 14).
 *
 * The cursor IS the Home Node's revision — there is no client-side sequence to
 * keep in step (docs/MOBILE_GATEWAY.md §11.4). Two orderings matter and both are
 * deliberate:
 *
 * * **apply the page, THEN advance the cursor.** A crash between the two re-applies
 *   a page, which is harmless (upserts are keyed by canonical id, deletes are
 *   tombstoned). Advancing first would lose changes.
 * * **upserts before deletes within a page.** If a message was created and then
 *   deleted between two syncs, deleting last is the outcome that matches the
 *   server.
 */
class SyncEngine(
    private val client: HomeNodeClient,
    private val cache: LocalCache,
) {

    suspend fun run(nodeKey: String, pageLimit: Int? = null, maxPages: Int = DEFAULT_MAX_PAGES): ApiResult<SyncOutcome> {
        var state = cache.syncState(nodeKey)
        var pages = 0
        var upserts = 0
        var deletes = 0

        while (true) {
            val page = when (val result = client.syncChanges(state.cursor, pageLimit)) {
                is ApiResult.Err -> return result
                is ApiResult.Ok -> result.value
            }
            val appliedUpserts = cache.upsertMessages(page.upserts)
            val appliedDeletes = cache.applyDeletes(page.deletes)
            upserts += appliedUpserts
            deletes += appliedDeletes

            state = state.copy(
                cursor = page.cursor,
                revision = page.revision,
            )
            cache.saveSyncState(state)
            pages++

            IbLog.debug(
                "sync.page",
                "pages" to pages,
                IbLog.FIELD_COUNT to (appliedUpserts + appliedDeletes),
                "cursor" to page.cursor,
            )

            if (!page.hasMore) break
            if (pages >= maxPages) {
                // Bound the loop: a server that keeps reporting hasMore must not be
                // able to spin this forever. The next sync continues from the cursor.
                IbLog.warn("sync.page-limit", "pages" to pages, "cursor" to state.cursor)
                break
            }
        }

        return ApiResult.Ok(
            SyncOutcome(pages = pages, upserts = upserts, deletes = deletes, cursor = state.cursor, revision = state.revision),
        )
    }

    /** Cold start: forget the cursor and replay the whole change log. */
    suspend fun full(nodeKey: String): ApiResult<SyncOutcome> {
        cache.saveSyncState(SyncState(nodeKey = nodeKey, cursor = 0L))
        return run(nodeKey)
    }

    fun cursor(nodeKey: String): Long = cache.syncState(nodeKey).cursor

    companion object {
        const val DEFAULT_MAX_PAGES = 25
    }
}
