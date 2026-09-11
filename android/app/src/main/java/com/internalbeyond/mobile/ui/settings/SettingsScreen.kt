package com.internalbeyond.mobile.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.data.cache.CacheStats
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.ui.character.ConnectionRow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class SettingsViewModel(private val graph: AppGraph) : ViewModel() {

    val sessionState: StateFlow<ConnectionState> = graph.session.state

    private val _stats = MutableStateFlow(graph.cache.stats())
    val stats: StateFlow<CacheStats> = _stats.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val _disconnected = MutableStateFlow(false)
    val disconnected: StateFlow<Boolean> = _disconnected.asStateFlow()

    fun refreshStats() {
        _stats.value = graph.cache.stats()
    }

    fun syncNow() {
        viewModelScope.launch {
            _busy.value = true
            val error = graph.sync.run(graph.nodeKey())
            _notice.value = error.errorOrNull()?.let { "${it.code}: ${it.message}" } ?: "Synced."
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
                "This device was disconnected on the Home Node as well."
            } else {
                "This device was disconnected here, but the Home Node could not be reached to " +
                    "confirm it. Remove the device on the desktop if it still appears there."
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
        _notice.value = "Cached messages and characters were deleted on this device."
    }

    fun rename(name: String) {
        viewModelScope.launch {
            _busy.value = true
            val result = graph.client.deviceRename(name)
            _notice.value = when (result) {
                is com.internalbeyond.mobile.data.api.ApiResult.Ok -> "Device renamed."
                is com.internalbeyond.mobile.data.api.ApiResult.Err -> "Rename failed: ${result.error.code}"
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

@OptIn(ExperimentalMaterial3Api::class)
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

    var confirming by remember { mutableStateOf(false) }
    var deleteCacheToo by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = { Text("Settings") },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            ConnectionRow(sessionState)

            val node = sessionState.nodeOrNull
            Section("Connection") {
                if (node == null) {
                    FactRow("Status", "Not paired")
                } else {
                    FactRow("Address", node.endpoint.display, mono = true)
                    FactRow("Transport", node.endpoint.transportLabel)
                    FactRow("Device", node.deviceName.ifEmpty { "—" })
                    FactRow("Device id", node.deviceId, mono = true)
                    FactRow("Home Node", node.nodeFingerprint.ifEmpty { "—" }, mono = true)
                    FactRow("Server", node.serverVersion.ifEmpty { "—" })
                    if (node.protocol != 0) FactRow("Protocol", "v${node.protocol}")
                }
                Text(
                    text = "The credential for this device is stored encrypted with this " +
                        "phone's own key store.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Section("Data on this device") {
                FactRow("Cached characters", stats.characters.toString())
                FactRow("Cached messages", stats.messages.toString())
                FactRow("Conversations", stats.conversations.toString())
                FactRow("Unfinished sends", stats.openAttempts.toString())
                FactRow("Drafts", stats.drafts.toString())
                Text(
                    text = "Cache is a copy. The Home Node is the authority; the cache is " +
                        "refilled from it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                androidx.compose.foundation.layout.Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { viewModel.syncNow() }, enabled = !busy) {
                        Text("Sync now")
                    }
                    OutlinedButton(onClick = { viewModel.clearCachedData() }, enabled = !busy) {
                        Text("Delete cached data")
                    }
                }
            }

            notice?.let {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            if (!disconnected && node != null) {
                Section("This device") {
                    Text(
                        text = "Disconnecting removes this phone's credential. The desktop " +
                            "keeps the conversation history.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = { confirming = true },
                        enabled = !busy,
                    ) {
                        Text("Disconnect this device")
                    }
                }
            }

            Text(
                text = "InternalBeyond thin client · protocol v1",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Disconnect this device?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("The Home Node will stop accepting this phone's credential.")
                    androidx.compose.foundation.layout.Row {
                        Checkbox(checked = deleteCacheToo, onCheckedChange = { deleteCacheToo = it })
                        Text(
                            text = "Also delete cached messages on this device",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    viewModel.disconnect(deleteCacheToo)
                }) { Text("Disconnect") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            content()
        }
    }
}

@Composable
private fun FactRow(label: String, value: String, mono: Boolean = false) {
        androidx.compose.foundation.layout.Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        )
    }
}

