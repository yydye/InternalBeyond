package com.internalbeyond.mobile.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
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
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.common.IbBackground
import com.internalbeyond.mobile.ui.common.IbBridgeMark
import com.internalbeyond.mobile.ui.common.IbConnectionBadge
import com.internalbeyond.mobile.ui.common.IbDisclosure
import com.internalbeyond.mobile.ui.common.IbErrorCard
import com.internalbeyond.mobile.ui.common.IbFactRow
import com.internalbeyond.mobile.ui.common.IbGlassCard
import com.internalbeyond.mobile.ui.common.IbGlow
import com.internalbeyond.mobile.ui.common.IbNoticeCard
import com.internalbeyond.mobile.ui.common.IbPrimaryButton
import com.internalbeyond.mobile.ui.common.IbSecondaryButton
import com.internalbeyond.mobile.ui.common.IbSheet
import com.internalbeyond.mobile.ui.common.IbTextAction
import com.internalbeyond.mobile.ui.common.IbTextField
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

data class PairingUiState(
    val busy: Boolean = false,
    val step: PairingStep? = null,
    val error: ErrorPresentation? = null,
    val connected: NodeInfo? = null,
)

/**
 * First pairing (Phase 7/8).
 *
 * Manual paste is the supported path and works with no extra permissions. QR scanning
 * is deliberately absent rather than a hidden button: Phase 38 defers it, and a control
 * that cannot succeed is worse than an honest sentence — so the button is present, says
 * 即将加入, and does nothing.
 *
 * Nothing in this ViewModel changed in M1-C.1. `pair()` calls exactly what it called
 * before, with exactly the same arguments; only the words the screen puts around the
 * result are new.
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

private enum class PairingSheet { None, Manual, Advanced }

/**
 * The first screen.
 *
 * What the brief changed here, and why each change was made:
 *
 *  · The heading no longer names the architecture. The user is not connecting to a
 *    "Home Node"; they are connecting to their InternalBeyond. The address and the
 *    protocol are still available, one level down, in 高级设置 — which is where someone
 *    who needs them will look.
 *  · The pasted payload is no longer the screen. A text area with a JSON blob in it
 *    reads as an API console, so the paste field moved into 手动连接 and the first
 *    screen became what it should always have been: a promise and two ways to keep it.
 *  · The console command is gone from the normal UI entirely. It survives inside
 *    开发帮助, which is the one place in this app allowed to speak developer.
 *  · The status line reports real state and nothing else. It does not say "正在寻找
 *    附近的电脑" while idle: this build has no discovery, and a permanent "searching"
 *    indicator would be an animation pretending to be a feature.
 */
@Composable
fun PairingScreen(
    graph: AppGraph,
    onConnected: () -> Unit,
    viewModel: PairingViewModel = viewModel(factory = PairingViewModel.factory(graph)),
) {
    val ui by viewModel.state.collectAsStateWithLifecycle()
    val session by viewModel.sessionState.collectAsStateWithLifecycle()

    var sheet by rememberSaveable { mutableStateOf(PairingSheet.None) }
    var payload by rememberSaveable { mutableStateOf("") }
    var override by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf(defaultDeviceName()) }

    // A successful pairing closes the sheet and lets the first screen report it, which
    // is where the user already is (Phase 8: pairing success states what happened).
    LaunchedEffect(ui.connected) {
        if (ui.connected != null) sheet = PairingSheet.None
    }

    IbBackground(glow = IbGlow.Hero) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val headroom = maxHeight * 0.10f
            val gap = maxHeight * 0.13f
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .padding(horizontal = IbSpacing.gutter),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(headroom))
                IbBridgeMark(size = 104.dp)
                Spacer(Modifier.height(IbSpacing.xxxl))

                Text(
                    text = IbStrings.pairTitle,
                    style = IbType.display,
                    color = IbColors.Text,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(IbSpacing.md))
                Text(
                    text = IbStrings.pairSubtitle,
                    style = IbType.body,
                    color = IbColors.TextDim,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(gap))

                when {
                    ui.connected != null -> PairedCard(onGoOn = onConnected)
                    session is ConnectionState.Connected ->
                        PairedCard(onGoOn = onConnected, already = true)

                    else -> ConnectActions(
                        session = session,
                        onScanQr = { /* Phase 38: not implemented, and the button says so. */ },
                        onManual = { sheet = PairingSheet.Manual },
                    )
                }

                Spacer(Modifier.height(IbSpacing.xxl))

                IbConnectionBadge(
                    color = connectionColor(session),
                    label = connectionLabel(session),
                    busy = connectionBusy(session),
                )

                Spacer(Modifier.height(IbSpacing.xs))

                IbTextAction(
                    label = IbStrings.pairAdvanced,
                    onClick = { sheet = PairingSheet.Advanced },
                )

                (session as? ConnectionState.Revoked)?.let { revoked ->
                    Spacer(Modifier.height(IbSpacing.lg))
                    IbErrorCard(ErrorPresenter.present(revoked.error))
                }
                (session as? ConnectionState.AuthExpired)?.let { expired ->
                    Spacer(Modifier.height(IbSpacing.lg))
                    IbErrorCard(ErrorPresenter.present(expired.error))
                }

                Spacer(Modifier.height(IbSpacing.lg))
            }
        }
    }

    when (sheet) {
        PairingSheet.Manual -> IbSheet(
            title = IbStrings.manualTitle,
            onDismiss = {
                sheet = PairingSheet.None
                viewModel.clearResult()
            },
        ) {
            Text(text = IbStrings.manualIntro, style = IbType.body, color = IbColors.TextDim)

            IbTextField(
                value = payload,
                onValueChange = { payload = it },
                label = IbStrings.manualPasteLabel,
                placeholder = IbStrings.manualPastePlaceholder,
                minLines = 4,
                maxLines = 8,
            )

            IbTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = IbStrings.manualDeviceNameLabel,
                hint = IbStrings.manualDeviceNameHint,
                singleLine = true,
            )

            IbPrimaryButton(
                label = stepLabel(ui.step),
                onClick = { viewModel.pair(payload, override, deviceName) },
                enabled = payload.isNotBlank(),
                busy = ui.busy,
            )

            ui.error?.let { IbErrorCard(it) }

            DeveloperHelp()

            IbSecondaryButton(label = IbStrings.manualCancel, onClick = { sheet = PairingSheet.None })
        }

        PairingSheet.Advanced -> IbSheet(
            title = IbStrings.advancedTitle,
            onDismiss = { sheet = PairingSheet.None },
        ) {
            IbTextField(
                value = override,
                onValueChange = { override = it },
                label = IbStrings.advancedAddressLabel,
                hint = IbStrings.advancedAddressHint,
                placeholder = IbStrings.advancedAddressPlaceholder,
                singleLine = true,
            )

            val node = session.nodeOrNull
            if (node == null) {
                Text(
                    text = IbStrings.advancedNothingYet,
                    style = IbType.bodySmall,
                    color = IbColors.TextFaint,
                )
            } else {
                NodeFacts(node)
            }

            IbSecondaryButton(label = IbStrings.advancedDone, onClick = { sheet = PairingSheet.None })
        }

        PairingSheet.None -> Unit
    }
}

@Composable
private fun ConnectActions(
    session: ConnectionState,
    onScanQr: () -> Unit,
    onManual: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(IbSpacing.md),
    ) {
        IbSecondaryButton(
            label = IbStrings.pairScanQr,
            onClick = onScanQr,
            enabled = false,
            note = IbStrings.pairScanQrSoon,
        )
        IbPrimaryButton(label = IbStrings.pairManual, onClick = onManual)
        if (session is ConnectionState.Failed) {
            IbNoticeCard(ErrorPresenter.present(session.error).title)
        }
    }
}

@Composable
private fun PairedCard(onGoOn: () -> Unit, already: Boolean = false) {
    IbGlassCard(accent = IbColors.Ok) {
        Text(text = IbStrings.pairedTitle, style = IbType.nameSmall, color = IbColors.Text)
        Text(
            text = IbStrings.pairedRemember,
            style = IbType.bodySmall,
            color = IbColors.TextDim,
        )
        Spacer(Modifier.height(IbSpacing.xs))
        IbPrimaryButton(label = IbStrings.pairedGoOn, onClick = onGoOn)
    }
}

/**
 * The one place a console command is allowed to exist.
 *
 * It is collapsed, labelled in the user's language, and it is the only way to obtain a
 * pairing payload in this version of the desktop — so removing it entirely would leave
 * the app unusable rather than merely plainer. The command is selectable and has a copy
 * button, because asking someone to retype a `JSON.stringify(...)` call by hand would
 * be its own kind of insult.
 */
@Composable
private fun DeveloperHelp() {
    val clipboard = LocalClipboardManager.current
    IbDisclosure(label = IbStrings.Dev.devHelpTitle) {
        Column(verticalArrangement = Arrangement.spacedBy(IbSpacing.sm)) {
            Text(
                text = IbStrings.Dev.pairingHelpBody,
                style = IbType.bodySmall,
                color = IbColors.TextFaint,
            )
            Text(text = IbStrings.Dev.pairingCommand, style = IbType.mono, color = IbColors.AccentSoft)
            IbTextAction(
                label = IbStrings.Dev.copy,
                onClick = { clipboard.setText(AnnotatedString(IbStrings.Dev.pairingCommand)) },
                color = IbColors.AccentSoft,
            )
        }
    }
}

/** Where the architecture is allowed to say its own name. */
@Composable
private fun NodeFacts(node: NodeInfo) {
    IbGlassCard {
        IbFactRow(IbStrings.Dev.nodeLabel, node.endpoint.display, mono = true)
        IbFactRow(IbStrings.Dev.transport, node.endpoint.transportLabel)
        if (node.serverVersion.isNotEmpty()) {
            IbFactRow(IbStrings.Dev.serverVersion, node.serverVersion)
        }
        if (node.protocol != 0) {
            IbFactRow(IbStrings.Dev.protocolVersion, "v${node.protocol}")
        }
        if (node.nodeFingerprint.isNotEmpty()) {
            IbFactRow(IbStrings.Dev.fingerprint, node.nodeFingerprint, mono = true)
        }
    }
}

private fun stepLabel(step: PairingStep?): String = when (step) {
    PairingStep.PARSING -> IbStrings.statusChecking
    PairingStep.EXCHANGING -> IbStrings.statusExchanging
    PairingStep.VERIFYING -> IbStrings.statusVerifying
    null -> IbStrings.manualConnect
}

private fun defaultDeviceName(): String {
    val model = android.os.Build.MODEL
    return if (model.isNullOrBlank()) "Android" else model
}
