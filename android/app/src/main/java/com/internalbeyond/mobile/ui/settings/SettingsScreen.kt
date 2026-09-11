package com.internalbeyond.mobile.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.data.cache.CacheStats
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.common.IbBackground
import com.internalbeyond.mobile.ui.common.IbConnectionBadge
import com.internalbeyond.mobile.ui.common.IbDialog
import com.internalbeyond.mobile.ui.common.IbDisclosure
import com.internalbeyond.mobile.ui.common.IbFactRow
import com.internalbeyond.mobile.ui.common.IbGlassCard
import com.internalbeyond.mobile.ui.common.IbGlow
import com.internalbeyond.mobile.ui.common.IbNoticeCard
import com.internalbeyond.mobile.ui.common.IbSectionHeader
import com.internalbeyond.mobile.ui.common.IbSecondaryButton
import com.internalbeyond.mobile.ui.common.IbTextAction
import com.internalbeyond.mobile.ui.common.IbTextField
import com.internalbeyond.mobile.ui.common.IbTopBar
import com.internalbeyond.mobile.ui.common.connectionBusy
import com.internalbeyond.mobile.ui.common.connectionColor
import com.internalbeyond.mobile.ui.common.connectionLabel
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Something to tell the user after an action.
 *
 * [technical] is the same idea as on a failure card: the code that explains what
 * happened to a developer is available one tap down and is not part of the sentence
 * anyone has to read.
 */
data class SettingsNotice(
    val text: String,
    val technical: String? = null,
    val failed: Boolean = false,
)

class SettingsViewModel(private val graph: AppGraph) : ViewModel() {

    val sessionState: StateFlow<ConnectionState> = graph.session.state

    private val _stats = MutableStateFlow(graph.cache.stats())
    val stats: StateFlow<CacheStats> = _stats.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _notice = MutableStateFlow<SettingsNotice?>(null)
    val notice: StateFlow<SettingsNotice?> = _notice.asStateFlow()

    private val _disconnected = MutableStateFlow(false)
    val disconnected: StateFlow<Boolean> = _disconnected.asStateFlow()

    fun refreshStats() {
        _stats.value = graph.cache.stats()
    }

    fun syncNow() {
        viewModelScope.launch {
            _busy.value = true
            val error = graph.sync.run(graph.nodeKey())
            _notice.value = error.errorOrNull()
                ?.let { SettingsNotice(IbStrings.settingsSyncFailed, "${it.code} · ${it.message}", failed = true) }
                ?: SettingsNotice(IbStrings.settingsSynced)
            _busy.value = false
            refreshStats()
        }
    }

    /**
     * Phase 23. The local credential always goes; whether the Home Node confirmed it
     * is reported rather than assumed, because a device left listed on the desktop is
     * something the user needs to know about.
     */
    fun disconnect(deleteCache: Boolean) {
        viewModelScope.launch {
            _busy.value = true
            val outcome = graph.session.disconnect()
            if (deleteCache) {
                graph.cache.clearAll()
                graph.characters.forget()
            }
            _notice.value = if (outcome.serverConfirmed) {
                SettingsNotice(IbStrings.settingsDisconnectedRemote)
            } else {
                SettingsNotice(IbStrings.settingsDisconnectedUnconfirmed)
            }
            _busy.value = false
            refreshStats()
            _disconnected.value = true
        }
    }

    fun clearCachedData() {
        graph.chat.closeAll()
        graph.cache.clearAll()
        graph.characters.forget()
        refreshStats()
        _notice.value = SettingsNotice(IbStrings.settingsCacheCleared)
    }

    fun rename(name: String) {
        viewModelScope.launch {
            _busy.value = true
            val result = graph.client.deviceRename(name)
            _notice.value = when (result) {
                is com.internalbeyond.mobile.data.api.ApiResult.Ok -> SettingsNotice(IbStrings.settingsRenamed)
                is com.internalbeyond.mobile.data.api.ApiResult.Err -> SettingsNotice(
                    text = IbStrings.settingsRenameFailed,
                    technical = "${result.error.code} · ${result.error.message}",
                    failed = true,
                )
            }
            _busy.value = false
        }
    }

    companion object {
        fun factory(graph: AppGraph): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = SettingsViewModel(graph) as T
        }
    }
}

/**
 * Settings, in the order a person needs it.
 *
 * The brief's list — 当前设备 / 已连接的电脑 / 连接状态 / 断开连接 / 关于 InternalBeyond —
 * is the whole screen. Everything else this app knows about itself (address, transport,
 * device id, node fingerprint, server version, protocol version, cache counts, the two
 * maintenance actions) moved into a collapsed 开发者信息, because none of it is a
 * decision a user makes; it is a decision a user *reports*.
 */
@Composable
fun SettingsScreen(
    graph: AppGraph,
    sessionState: ConnectionState,
    onBack: () -> Unit,
    viewModel: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(graph)),
) {
    val stats by viewModel.stats.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val notice by viewModel.notice.collectAsStateWithLifecycle()
    val disconnected by viewModel.disconnected.collectAsStateWithLifecycle()

    var disconnecting by remember { mutableStateOf(false) }
    var deleteCacheToo by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }

    val node = sessionState.nodeOrNull

    IbBackground(glow = IbGlow.Quiet) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            IbTopBar(title = IbStrings.settingsTitle, onBack = onBack)

            Column(
                modifier = Modifier.padding(
                    start = IbSpacing.gutter,
                    end = IbSpacing.gutter,
                    bottom = IbSpacing.huge,
                ),
                verticalArrangement = Arrangement.spacedBy(IbSpacing.block),
            ) {
                // ── 当前设备 ────────────────────────────────────────────────────
                Column {
                    IbSectionHeader(IbStrings.settingsThisDevice)
                    IbGlassCard {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = node?.deviceName?.takeIf { it.isNotEmpty() } ?: "Android",
                                    style = IbType.nameSmall,
                                    color = IbColors.Text,
                                )
                                Text(
                                    text = IbStrings.settingsAboutBody,
                                    style = IbType.caption,
                                    color = IbColors.TextFaint,
                                )
                            }
                            if (node != null) {
                                IbTextAction(
                                    label = IbStrings.settingsRename,
                                    onClick = {
                                        newName = node.deviceName
                                        renaming = true
                                    },
                                    color = IbColors.AccentSoft,
                                )
                            }
                        }
                    }
                }

                // ── 已连接的电脑 ────────────────────────────────────────────────
                Column {
                    IbSectionHeader(IbStrings.settingsThisComputer)
                    IbGlassCard {
                        IbConnectionBadge(
                            color = connectionColor(sessionState),
                            label = connectionLabel(sessionState),
                            busy = connectionBusy(sessionState),
                        )
                        if (node == null) {
                            Text(
                                text = IbStrings.settingsNotPairedDetail,
                                style = IbType.bodySmall,
                                color = IbColors.TextDim,
                            )
                        }
                    }
                }

                // ── The result of whatever was just done ────────────────────────
                notice?.let { current ->
                    IbNoticeCard(
                        text = current.text,
                        accent = if (current.failed) IbColors.Danger else null,
                    )
                    current.technical?.let { technical ->
                        IbDisclosure(label = IbStrings.errorDetailToggle) {
                            Text(text = technical, style = IbType.mono, color = IbColors.TextFaint)
                        }
                    }
                }

                // ── 断开连接 ────────────────────────────────────────────────────
                // No heading above this. It briefly had one — 连接状态 — and that was
                // wrong twice over: the connection's *state* is the badge in the card
                // above, and a heading announcing a state over a button that changes it
                // is a label pointing at the wrong thing.
                if (!disconnected && node != null) {
                    IbSecondaryButton(
                        label = IbStrings.settingsDisconnect,
                        onClick = { disconnecting = true },
                        enabled = !busy,
                    )
                }

                // ── 关于 ────────────────────────────────────────────────────────
                Column {
                    IbSectionHeader(IbStrings.settingsAbout)
                    IbGlassCard {
                        Text(
                            text = IbStrings.brand,
                            style = IbType.nameSmall,
                            color = IbColors.Text,
                        )
                        Text(
                            text = IbStrings.settingsAboutDetail,
                            style = IbType.bodySmall,
                            color = IbColors.TextDim,
                        )
                    }
                }

                DeveloperInfo(
                    node = node,
                    stats = stats,
                    busy = busy,
                    onSyncNow = { viewModel.syncNow() },
                    onClearCache = { viewModel.clearCachedData() },
                )
            }
        }
    }

    if (disconnecting) {
        IbDialog(
            title = IbStrings.settingsDisconnectTitle,
            onDismiss = { disconnecting = false },
        ) {
            Text(
                text = IbStrings.settingsDisconnectBody,
                style = IbType.bodySmall,
                color = IbColors.TextDim,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = deleteCacheToo,
                    onCheckedChange = { deleteCacheToo = it },
                    colors = CheckboxDefaults.colors(
                        checkedColor = IbColors.Accent,
                        uncheckedColor = IbColors.TextFaint,
                        checkmarkColor = IbColors.Text,
                    ),
                )
                Spacer(Modifier.width(IbSpacing.xs))
                Text(
                    text = IbStrings.settingsDisconnectAlsoCache,
                    style = IbType.bodySmall,
                    color = IbColors.TextDim,
                )
            }
            IbSecondaryButton(
                label = IbStrings.settingsCancel,
                onClick = { disconnecting = false },
            )
            IbSecondaryButton(
                label = IbStrings.settingsDisconnectConfirm,
                onClick = {
                    disconnecting = false
                    viewModel.disconnect(deleteCacheToo)
                },
                enabled = !busy,
            )
        }
    }

    if (renaming) {
        IbDialog(title = IbStrings.settingsRenameTitle, onDismiss = { renaming = false }) {
            IbTextField(
                value = newName,
                onValueChange = { newName = it },
                label = IbStrings.settingsRenameLabel,
                singleLine = true,
            )
            IbSecondaryButton(label = IbStrings.settingsCancel, onClick = { renaming = false })
            IbSecondaryButton(
                label = IbStrings.settingsSave,
                enabled = newName.isNotBlank() && !busy,
                onClick = {
                    renaming = false
                    viewModel.rename(newName.trim())
                },
            )
        }
    }
}

/**
 * Everything the app knows about itself, and nothing a person came here to do.
 *
 * The collapsed state is the point: this block exists so that the screen above it can
 * stay short. It is also the only surface in the app that prints an address, a
 * fingerprint or a protocol version, and the only one that names the Home Node.
 */
@Composable
private fun DeveloperInfo(
    node: com.internalbeyond.mobile.domain.model.NodeInfo?,
    stats: CacheStats,
    busy: Boolean,
    onSyncNow: () -> Unit,
    onClearCache: () -> Unit,
) {
    Column {
        IbDisclosure(label = IbStrings.Dev.devInfoTitle) {
            Column(verticalArrangement = Arrangement.spacedBy(IbSpacing.md)) {
                IbGlassCard {
                    if (node == null) {
                        IbFactRow(IbStrings.Dev.nodeLabel, "—")
                    } else {
                        IbFactRow(IbStrings.Dev.address, node.endpoint.display, mono = true)
                        IbFactRow(IbStrings.Dev.transport, node.endpoint.transportLabel)
                        IbFactRow(
                            IbStrings.Dev.deviceId,
                            node.deviceId.ifEmpty { "—" },
                            mono = true,
                        )
                        IbFactRow(
                            IbStrings.Dev.fingerprint,
                            node.nodeFingerprint.ifEmpty { "—" },
                            mono = true,
                        )
                        IbFactRow(
                            IbStrings.Dev.serverVersion,
                            node.serverVersion.ifEmpty { "—" },
                        )
                        IbFactRow(
                            IbStrings.Dev.protocolVersion,
                            if (node.protocol == 0) "—" else "v${node.protocol}",
                        )
                    }
                    IbFactRow(IbStrings.Dev.appVersion, IbStrings.settingsAboutBody)
                }

                IbGlassCard {
                    Text(
                        text = IbStrings.Dev.cacheTitle,
                        style = IbType.caption,
                        color = IbColors.TextFaint,
                    )
                    IbFactRow(IbStrings.Dev.cacheCharacters, stats.characters.toString())
                    IbFactRow(IbStrings.Dev.cacheMessages, stats.messages.toString())
                    IbFactRow(IbStrings.Dev.cacheConversations, stats.conversations.toString())
                    IbFactRow(IbStrings.Dev.cachePendingSends, stats.openAttempts.toString())
                    IbFactRow(IbStrings.Dev.cacheDrafts, stats.drafts.toString())
                }

                IbSecondaryButton(
                    label = IbStrings.Dev.syncNow,
                    onClick = onSyncNow,
                    enabled = !busy,
                )
                IbSecondaryButton(
                    label = IbStrings.Dev.clearCache,
                    onClick = onClearCache,
                    enabled = !busy,
                )
            }
        }
    }
}
