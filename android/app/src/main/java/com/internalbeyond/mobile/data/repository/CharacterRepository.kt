package com.internalbeyond.mobile.data.repository

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.cache.LocalCache
import com.internalbeyond.mobile.data.cache.SyncState
import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.platform.IbLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class CharacterListState(
    val characters: List<Character> = emptyList(),
    /** True while what you are looking at came from disk rather than the node. */
    val fromCache: Boolean = true,
    val loading: Boolean = false,
    val error: ProtocolError? = null,
    val catalogUpdatedAt: Long? = null,
    /**
     * The Home Node has been asked and has no characters at all. Distinct from
     * "we have not asked yet" and from "we asked and failed" — the UI says
     * something different in each case.
     */
    val catalogConfirmedEmpty: Boolean = false,
)

/**
 * The character list, cache first (Phase 10/11).
 *
 * `cache != authority`: the cached list is shown immediately so a cold start on a
 * dead network still shows the user their characters, and the network answer
 * replaces it. The one asymmetry that matters — an EMPTY network answer never
 * deletes the cache — is enforced inside [LocalCache.replaceCharacters] as well as
 * here, so it cannot regress by a caller forgetting it.
 */
class CharacterRepository(
    private val client: HomeNodeClient,
    private val cache: LocalCache,
    private val nodeKey: () -> String,
    private val onFailure: (ProtocolError) -> Unit,
) {

    private val _state = MutableStateFlow(CharacterListState())
    val state: StateFlow<CharacterListState> = _state.asStateFlow()

    /** Show what is on disk right now. Safe with no network at all. */
    fun loadCached(): CharacterListState {
        val cached = cache.characters()
        val sync = cache.syncState(nodeKey())
        val next = _state.value.copy(
            characters = cached,
            fromCache = true,
            catalogUpdatedAt = sync.catalogUpdatedAt,
            catalogConfirmedEmpty = sync.catalogConfirmedEmpty && cached.isEmpty(),
        )
        _state.value = next
        return next
    }

    suspend fun refresh(): ProtocolError? {
        _state.value = _state.value.copy(loading = true)
        val result = client.characterList()
        return when (result) {
            is ApiResult.Err -> {
                onFailure(result.error)
                _state.value = _state.value.copy(loading = false, error = result.error)
                result.error
            }

            is ApiResult.Ok -> {
                val catalog = result.value
                val key = nodeKey()
                if (catalog.characters.isEmpty()) {
                    // "Home Node 返回为空时不要擅自删除历史 cache，除非确认 canonical empty."
                    // A null catalogUpdatedAt is the server saying "nothing was ever
                    // published", which is a confirmed empty; anything else is treated
                    // as inconclusive and the cache is left alone but flagged stale.
                    val confirmedEmpty = catalog.catalogUpdatedAt == null
                    cache.saveSyncState(
                        cache.syncState(key).copy(
                            catalogUpdatedAt = catalog.catalogUpdatedAt,
                            catalogConfirmedEmpty = confirmedEmpty,
                        ),
                    )
                    _state.value = CharacterListState(
                        characters = _state.value.characters,
                        fromCache = true,
                        loading = false,
                        error = null,
                        catalogUpdatedAt = catalog.catalogUpdatedAt,
                        catalogConfirmedEmpty = confirmedEmpty,
                    )
                    IbLog.info(
                        "characters.empty",
                        "confirmedEmpty" to confirmedEmpty,
                        "cached" to _state.value.characters.size,
                    )
                    null
                } else {
                    cache.replaceCharacters(catalog.characters, catalog.catalogUpdatedAt)
                    cache.saveSyncState(
                        cache.syncState(key).copy(
                            catalogUpdatedAt = catalog.catalogUpdatedAt,
                            catalogConfirmedEmpty = false,
                        ),
                    )
                    _state.value = CharacterListState(
                        characters = catalog.characters,
                        fromCache = false,
                        loading = false,
                        error = null,
                        catalogUpdatedAt = catalog.catalogUpdatedAt,
                        catalogConfirmedEmpty = false,
                    )
                    IbLog.info("characters.loaded", IbLog.FIELD_COUNT to catalog.characters.size)
                    null
                }
            }
        }
    }

    /** Used by the chat screen to fall back to the cache when the node is silent. */
    fun character(id: String): Character? = cache.character(id)

    /** Drop the cached catalog (Phase 23's opt-in "also delete cached data"). */
    fun forget() {
        cache.clearCharacters()
        _state.value = CharacterListState()
    }

    fun currentSyncState(): SyncState = cache.syncState(nodeKey())
}
