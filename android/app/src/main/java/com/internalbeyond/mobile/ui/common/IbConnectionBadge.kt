package com.internalbeyond.mobile.ui.common

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * Whether the computer is there.
 *
 * One control, one place, one meaning: this says something about the *link* and
 * nothing about a character. A roster that claims each character is "在线" would be
 * inventing a fact the mobile DTO does not carry — a character is not a device, and
 * there is no per-character presence on this protocol. So the roster shows what it
 * knows (archived, vision) and the liveness lives here.
 *
 * [busy] breathes the dot, which is the only motion this component has; a still dot
 * next to the word 正在连接 would look like a stalled one.
 */
@Composable
fun IbConnectionBadge(
    color: Color,
    label: String,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
) {
    val alpha = if (busy) {
        val transition = rememberInfiniteTransition(label = "link")
        val value by transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 900, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "link-dot",
        )
        value
    } else {
        1f
    }

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .alpha(alpha)
                .clip(CircleShape)
                .background(color),
        )
        Text(text = label, style = IbType.bodySmall, color = IbColors.TextDim)
    }
}

/**
 * The connection, in words a person can act on.
 *
 * Deliberately no address and no fingerprint: those are facts about a machine, and they
 * belong in 开发者信息. What belongs here is whether the thing the user is trying to do
 * will work.
 */
fun connectionLabel(state: ConnectionState): String = when (state) {
    is ConnectionState.Connected -> IbStrings.statusConnected
    is ConnectionState.Offline -> IbStrings.statusUnreachable
    is ConnectionState.Pairing -> when (state.step) {
        com.internalbeyond.mobile.domain.model.PairingStep.PARSING -> IbStrings.statusChecking
        com.internalbeyond.mobile.domain.model.PairingStep.EXCHANGING -> IbStrings.statusExchanging
        com.internalbeyond.mobile.domain.model.PairingStep.VERIFYING -> IbStrings.statusVerifying
    }
    is ConnectionState.Revoked,
    is ConnectionState.AuthExpired,
    -> IbStrings.errorRepair

    is ConnectionState.Failed -> IbStrings.statusUnreachable
    is ConnectionState.Unpaired -> IbStrings.statusNotConnected
}

fun connectionColor(state: ConnectionState): Color = when (state) {
    is ConnectionState.Connected -> IbColors.Ok
    is ConnectionState.Pairing -> IbColors.AccentSoft
    is ConnectionState.Unpaired -> IbColors.TextFaint
    else -> IbColors.Danger
}

fun connectionBusy(state: ConnectionState): Boolean = state is ConnectionState.Pairing
