package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.domain.ErrorPresentation
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * The one surface in the app.
 *
 * Translucent blue-grey over the ground, with a single hairline. It replaces Material's
 * `Card` entirely — not because Material's is wrong, but because a screen built from
 * `Card` + `OutlinedTextField` + `TopAppBar` looks like a Material sample no matter what
 * colours are fed into it, and the brief is for something that looks like InternalBeyond.
 *
 * [accent] tints both the fill and the edge for the two states that must be noticed
 * without shouting: a failure, and "you are connected".
 */
@Composable
fun IbGlassCard(
    modifier: Modifier = Modifier,
    accent: Color? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(IbShapes.card)
            .background(accent?.copy(alpha = 0.10f) ?: IbColors.Glass)
            .border(1.dp, accent?.copy(alpha = 0.30f) ?: IbColors.GlassEdge, IbShapes.card)
            .padding(IbSpacing.cardPadding),
        verticalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        content()
    }
}

/**
 * A failure.
 *
 * Three parts, in the order a person actually needs them: what happened, what to do
 * about it, and — only if asked — the protocol's own words. The raw text is what makes
 * a support conversation possible, and it is also what makes an app feel like a
 * developer tool, so it lives behind [IbDisclosure] rather than on the card.
 */
@Composable
fun IbErrorCard(
    presentation: ErrorPresentation,
    modifier: Modifier = Modifier,
    onAction: (() -> Unit)? = null,
) {
    IbGlassCard(modifier = modifier, accent = IbColors.Danger) {
        Text(text = presentation.title, style = IbType.nameSmall, color = IbColors.Text)
        presentation.detail?.let {
            Text(text = it, style = IbType.bodySmall, color = IbColors.TextDim)
        }
        presentation.technical?.let { technical ->
            IbDisclosure(label = IbStrings.errorDetailToggle) {
                Text(text = technical, style = IbType.mono, color = IbColors.TextFaint)
            }
        }
        if (onAction != null) {
            val label = when (presentation.action) {
                com.internalbeyond.mobile.domain.ErrorAction.RE_PAIR -> IbStrings.errorRepair
                com.internalbeyond.mobile.domain.ErrorAction.OPEN_SETTINGS -> IbStrings.errorOpenSettings
                else -> IbStrings.errorTryAgain
            }
            IbTextAction(label = label, onClick = onAction, color = IbColors.AccentSoft)
        }
    }
}

/**
 * A panel: one glass surface holding a run of rows, rather than one rounded card per
 * row.
 *
 * The distinction matters. Ten identical cards floating in a column is the "content
 * chopped into cards" look that says nothing about the content; a single panel with
 * hairlines reads as a *list of things that belong together*, and it leaves the card
 * shape free to mean something specific in the two places that need it (the paired
 * confirmation, the failure).
 */
@Composable
fun IbGlassPanel(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(IbShapes.card)
            .background(IbColors.Glass)
            .border(1.dp, IbColors.GlassEdge, IbShapes.card),
    ) {
        content()
    }
}

/** The line between two rows of a panel. Inset so it starts where the text does. */
@Composable
fun IbPanelDivider(modifier: Modifier = Modifier, inset: androidx.compose.ui.unit.Dp = 0.dp) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(1.dp)
            .background(IbColors.GlassEdge.copy(alpha = 0.55f)),
    )
}

/**
 * Something the app has to say that is not a failure: a reconnect notice, a
 * disconnected-without-confirmation report, "already up to date".
 */
@Composable
fun IbNoticeCard(
    text: String,
    modifier: Modifier = Modifier,
    accent: Color? = null,
) {
    IbGlassCard(modifier = modifier, accent = accent) {
        Text(text = text, style = IbType.bodySmall, color = IbColors.TextDim)
    }
}
