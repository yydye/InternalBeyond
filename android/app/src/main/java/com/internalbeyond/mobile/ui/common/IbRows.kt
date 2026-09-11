package com.internalbeyond.mobile.ui.common

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * A closed door that opens.
 *
 * This is the mechanism the whole of requirement 1 rests on: everything the product
 * would rather not say out loud — the protocol, the address, the raw error, the
 * command — is still available, one deliberate tap away, and never in the way. It
 * replaces both "show it always" and "hide it completely", which are the two ways this
 * normally goes wrong.
 */
@Composable
fun IbDisclosure(
    label: String,
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
    content: @Composable () -> Unit,
) {
    var expanded by rememberSaveable(label) { mutableStateOf(initiallyExpanded) }
    val turn by animateFloatAsState(if (expanded) 90f else 0f, label = "chevron")

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .clip(IbShapes.chip)
                .clickable { expanded = !expanded }
                .padding(vertical = IbSpacing.sm, horizontal = IbSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(IbSpacing.xs),
        ) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = IbColors.TextFaint,
                modifier = Modifier.size(16.dp).rotate(turn),
            )
            Text(text = label, style = IbType.bodySmall, color = IbColors.TextFaint)
        }
        AnimatedVisibility(visible = expanded) {
            Box(modifier = Modifier.padding(top = IbSpacing.xs, start = IbSpacing.xl)) {
                content()
            }
        }
    }
}

/** A quiet heading for a run of rows. No rule, no box — the space does the work. */
@Composable
fun IbSectionHeader(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        style = IbType.caption,
        color = IbColors.TextFaint,
        modifier = modifier.padding(start = IbSpacing.xs, bottom = IbSpacing.heading),
    )
}

/** One labelled fact. The label is quietly placed; the value is what was asked for. */
@Composable
fun IbFactRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = IbType.caption,
            color = IbColors.TextFaint,
            modifier = Modifier.padding(end = IbSpacing.md),
        )
        Text(
            text = value,
            style = if (mono) IbType.mono else IbType.bodySmall,
            color = if (mono) IbColors.TextDim else IbColors.Text,
            textAlign = TextAlign.End,
        )
    }
}

/** A small mark: "视觉", "已归档". Never a badge that claims something unverified. */
@Composable
fun IbMark(
    text: String,
    modifier: Modifier = Modifier,
    accent: Boolean = false,
) {
    Text(
        text = text,
        style = IbType.mark,
        color = if (accent) IbColors.AccentSoft else IbColors.TextFaint,
        modifier = modifier
            .clip(IbShapes.chip)
            .background(if (accent) IbColors.Accent.copy(alpha = 0.18f) else IbColors.GlassInput)
            .padding(horizontal = IbSpacing.sm, vertical = 3.dp),
    )
}
