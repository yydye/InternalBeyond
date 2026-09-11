package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * The solid one.
 *
 * One per screen. It is the only filled control in the product, which is what makes
 * "what happens if I press the obvious thing" a question with one answer.
 */
@Composable
fun IbPrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val fill = if (enabled && !busy) IbColors.AccentFill else IbColors.Glass
    val edge = if (enabled && !busy) IbColors.AccentSoft.copy(alpha = 0.35f) else IbColors.GlassEdge
    val labelColor = if (enabled && !busy) IbColors.Text else IbColors.TextFaint

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(IbShapes.control)
            .background(fill)
            .border(1.dp, edge, IbShapes.control)
            .clickable(enabled = enabled && !busy, onClick = onClick)
            .defaultMinSize(minHeight = 52.dp)
            .padding(horizontal = IbSpacing.controlPaddingH, vertical = IbSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                color = IbColors.Text,
                strokeWidth = 2.dp,
            )
            Spacer(Modifier.width(IbSpacing.sm))
        }
        Text(text = label, style = IbType.button, color = labelColor)
    }
}

/**
 * The quiet one.
 *
 * Glass, a hairline, and no fill of its own — it sits in the same world as [IbPrimaryButton]
 * without competing with it. Used for the disabled "scan a QR code" affordance too,
 * where [note] carries the reason it does nothing.
 */
@Composable
fun IbSecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    note: String? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(IbShapes.control)
            .background(IbColors.Glass)
            .border(1.dp, IbColors.GlassEdge, IbShapes.control)
            .clickable(enabled = enabled, onClick = onClick)
            .defaultMinSize(minHeight = 52.dp)
            .padding(horizontal = IbSpacing.controlPaddingH, vertical = IbSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = label,
            style = IbType.button,
            color = if (enabled) IbColors.Text else IbColors.TextFaint,
        )
        if (note != null) {
            Spacer(Modifier.width(IbSpacing.sm))
            Text(
                text = note,
                style = IbType.caption,
                color = IbColors.TextFaint,
                modifier = Modifier
                    .clip(IbShapes.chip)
                    .background(IbColors.GlassInput)
                    .padding(horizontal = IbSpacing.sm, vertical = 2.dp),
            )
        }
    }
}

/**
 * A link-weight action: no ground, no border, just words that happen to be pressable.
 *
 * Used for the two things on the pairing screen that must exist but must not look like
 * the way forward — 高级设置 and 开发帮助.
 */
@Composable
fun IbTextAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    color: Color = IbColors.TextFaint,
) {
    Box(
        modifier = modifier
            .clip(IbShapes.chip)
            .clickable(onClick = onClick)
            .padding(horizontal = IbSpacing.md, vertical = IbSpacing.sm),
    ) {
        Text(text = label, style = IbType.bodySmall, color = color)
    }
}
