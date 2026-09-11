package com.internalbeyond.mobile.ui.pairing

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.data.repository.PairingResult
import com.internalbeyond.mobile.domain.ErrorPresentation
import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.domain.model.NodeInfo
import com.internalbeyond.mobile.domain.model.PairingStep
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class PairingUiState(
    val busy: Boolean = false,
    val step: PairingStep? = null,
    val error: ErrorPresentation? = null,
    val connected: NodeInfo? = null,
)

/**
 * First pairing (Phase 7/8).
 *
 * Manual paste is the supported path and works with no extra permissions. QR
 * scanning is deliberately absent rather than a disabled button: Phase 38 defers it,
 * and a control that cannot succeed is worse than an honest sentence.
 */
class PairingViewModel(private val graph: AppGraph) : ViewModel() {

    private val _state = MutableStateFlow(PairingUiState())
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    val sessionState: StateFlow<ConnectionState> = graph.session.state

    fun pair(payload: String, addressOverride: String, deviceName: String) {
        if (_state.value.busy) return
        _state.value = PairingUiState(busy = true, step = PairingStep.PARSING)
        viewModelScope.launch {
            val result = graph.session.pair(
                rawPayload = payload,
                addressOverride = addressOverride.ifBlank { null },
                deviceName = deviceName.ifBlank { "Android" },
            )
            _state.value = when (result) {
                is PairingResult.Success -> PairingUiState(connected = result.node)
                is PairingResult.Invalid -> PairingUiState(
                    error = ErrorPresentation(title = result.title, detail = result.detail),
                )
                is PairingResult.Failed -> PairingUiState(error = ErrorPresenter.present(result.error))
            }
        }
    }

    fun clearResult() {
        _state.value = PairingUiState()
    }

    companion object {
        fun factory(graph: AppGraph): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = PairingViewModel(graph) as T
        }
    }
}

@Composable
fun PairingScreen(
    graph: AppGraph,
    onConnected: () -> Unit,
    viewModel: PairingViewModel = viewModel(factory = PairingViewModel.factory(graph)),
) {
    val ui by viewModel.state.collectAsStateWithLifecycle()
    val session by viewModel.sessionState.collectAsStateWithLifecycle()

    var payload by rememberSaveable { mutableStateOf("") }
    var override by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf(defaultDeviceName()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            text = "InternalBeyond",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "Connect to Home Node",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Why we are here, when the reason is not "first run" (Phase 24).
        when (val current = session) {
            is ConnectionState.Revoked -> NoticeCard(
                title = ErrorPresenter.present(current.error).title,
                detail = ErrorPresenter.present(current.error).detail,
            )

            is ConnectionState.AuthExpired -> NoticeCard(
                title = ErrorPresenter.present(current.error).title,
                detail = ErrorPresenter.present(current.error).detail,
            )

            else -> Unit
        }

        val connected = ui.connected
        if (connected == null) {
            Text(
                text = "On the desktop, open InternalBeyond and run this in the browser console " +
                    "(F12), then paste the result here:",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = "JSON.stringify((await IB.homeNode.pairing.create({deviceName:'Android'})).payload)",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
            )

            OutlinedTextField(
                value = payload,
                onValueChange = { payload = it },
                label = { Text("Paste pairing payload") },
                placeholder = { Text("{\"pairingId\":\"pair_…\",\"secret\":\"…\"}") },
                minLines = 4,
                maxLines = 10,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = override,
                onValueChange = { override = it },
                label = { Text("Address override (optional)") },
                placeholder = { Text("192.168.10.7:23118") },
                singleLine = true,
                supportingText = {
                    Text(
                        "Only if this phone cannot reach the address inside the payload — for " +
                            "example when the desktop reports that it is listening on its own " +
                            "machine only.",
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("Device name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Button(
                onClick = { viewModel.pair(payload, override, deviceName) },
                enabled = !ui.busy && payload.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (ui.busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (ui.busy) stepLabel(ui.step) else "Connect")
            }

            Text(
                text = "Scanning a QR code is not part of this version yet — paste the payload instead.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            ui.error?.let { ErrorCard(it) }
        } else {
            // Phase 8: pairing success states what was connected to, by fingerprint.
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("Connected to", style = MaterialTheme.typography.bodySmall)
                    Text(
                        text = connected.endpoint.display,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (connected.nodeFingerprint.isNotEmpty()) {
                        Text(
                            text = "Home Node ${connected.nodeFingerprint}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Text(
                        text = connected.endpoint.transportLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = onConnected) { Text("Continue") }
            }
        }
    }
}

@Composable
private fun stepLabel(step: PairingStep?): String = when (step) {
    PairingStep.PARSING -> "Checking payload…"
    PairingStep.EXCHANGING -> "Pairing…"
    PairingStep.VERIFYING -> "Verifying…"
    null -> "Connecting…"
}

@Composable
fun ErrorCard(presentation: ErrorPresentation) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = presentation.title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            presentation.detail?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
        }
    }
}

@Composable
fun NoticeCard(title: String, detail: String?) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            detail?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun defaultDeviceName(): String {
    val model = Build.MODEL
    return if (model.isNullOrBlank()) "Android" else model
}
