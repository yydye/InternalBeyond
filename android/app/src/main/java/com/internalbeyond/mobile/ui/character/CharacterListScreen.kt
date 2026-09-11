package com.internalbeyond.mobile.ui.character

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.data.repository.CharacterListState
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.ui.common.CharacterAvatar
import com.internalbeyond.mobile.ui.common.StatusDot
import com.internalbeyond.mobile.ui.pairing.ErrorCard
import kotlinx.coroutines.launch

class CharacterListViewModel(private val graph: AppGraph) : ViewModel() {

    val characters = graph.characters.state

    init {
        // Phase 14: on start, drain the change log from the stored cursor so the
        // cache reflects anything that happened while the app was closed, then
        // refresh the catalog. The cached list is already on screen by then.
        viewModelScope.launch {
            graph.characters.loadCached()
            graph.sync.run(graph.nodeKey())
            graph.characters.refresh()
        }
    }

    fun refresh() {
        viewModelScope.launch {
            graph.sync.run(graph.nodeKey())
            graph.characters.refresh()
        }
    }

    companion object {
        fun factory(graph: AppGraph): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CharacterListViewModel(graph) as T
        }
    }
}

/**
 * Phase 10/11: characters, cache first.
 *
 * What is deliberately NOT shown: provider, endpoint, API configuration, system
 * prompt, temperature. The phone does not have them and must not imply that it does
 * — the DTO does not carry them either, so this is a structural absence rather than
 * a display choice.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharacterListScreen(
    graph: AppGraph,
    sessionState: ConnectionState,
    onOpenCharacter: (String) -> Unit,
    onOpenSettings: () -> Unit,
    viewModel: CharacterListViewModel = viewModel(factory = CharacterListViewModel.factory(graph)),
) {
    val state by viewModel.characters.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("Characters") },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            ConnectionRow(sessionState)
            state.error?.let { error ->
                ErrorCard(
                    com.internalbeyond.mobile.domain.ErrorPresenter.present(error),
                )
            }
            when {
                state.characters.isEmpty() && state.loading -> LoadingRow()
                state.characters.isEmpty() && state.catalogConfirmedEmpty -> EmptyState(
                    title = "No characters yet",
                    detail = "Open InternalBeyond on the desktop once — it publishes the " +
                        "character list to the Home Node.",
                )
                state.characters.isEmpty() -> EmptyState(
                    title = "No characters available",
                    detail = "The Home Node has not been reached yet, and nothing is cached on " +
                        "this device.",
                )
                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    if (state.fromCache) {
                        item {
                            Text(
                                text = "Showing the last list received from the Home Node",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                            )
                        }
                    }
                    items(state.characters, key = { it.id }) { character ->
                        CharacterRow(character = character, onClick = { onOpenCharacter(character.id) })
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun CharacterRow(character: Character, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CharacterAvatar(character = character, size = 46.dp)
        Column(modifier = Modifier.weight(1f)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = character.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (character.isArchived) {
                    Text(
                        text = "archived",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            val subtitle = listOf(character.relationship, character.signature, character.bio)
                .firstOrNull { it.isNotBlank() }
            Text(
                text = subtitle ?: character.handle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (character.capabilities.vision) {
            Text(
                text = "vision",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun ConnectionRow(state: ConnectionState) {
    val (color, label) = when (state) {
        is ConnectionState.Connected -> MaterialTheme.colorScheme.primary to
            "${state.node.endpoint.display} · ${state.node.endpoint.transportLabel}"
        is ConnectionState.Offline -> MaterialTheme.colorScheme.error to
            "Offline · ${state.node?.endpoint?.display ?: "no node"}"
        is ConnectionState.Revoked -> MaterialTheme.colorScheme.error to "Disconnected by the Home Node"
        is ConnectionState.AuthExpired -> MaterialTheme.colorScheme.error to "Credential rejected"
        is ConnectionState.Failed -> MaterialTheme.colorScheme.error to "Error"
        is ConnectionState.Pairing -> MaterialTheme.colorScheme.primary to "Pairing…"
        is ConnectionState.Unpaired -> MaterialTheme.colorScheme.outline to "Not paired"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(color = color, label = label)
    }
}

@Composable
private fun LoadingRow() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
    }
}

@Composable
fun EmptyState(title: String, detail: String, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            text = detail,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        action?.invoke()
    }
}

/** A tappable text used for secondary actions in empty states. */
@Composable
fun InlineAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Text(label, fontFamily = FontFamily.Default)
    }
}
