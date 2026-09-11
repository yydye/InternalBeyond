package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * The top of a screen.
 *
 * Not `TopAppBar`. Material's version drags along an elevation model, a tonal surface
 * and a 64dp box with a divider, none of which this app wants: the header here is part
 * of the page and floats on the same light as everything below it, with no fill and no
 * rule.
 *
 * The three-slot shape is deliberate. A chat header is an avatar, a name and a status
 * line, and the status has to be *under* the name where it belongs — which is exactly
 * what a Material app bar cannot express without a hack.
 */
@Composable
fun IbTopBar(
    title: String,
    modifier: Modifier = Modifier,
    titleStyle: TextStyle = IbType.screenTitle,
    subtitle: @Composable (() -> Unit)? = null,
    onBack: (() -> Unit)? = null,
    leading: @Composable (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 60.dp)
            .padding(
                start = if (onBack != null || leading != null) IbSpacing.sm else IbSpacing.gutter,
                end = IbSpacing.md,
                top = IbSpacing.sm,
                bottom = IbSpacing.md,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = IbStrings.chatBack,
                    tint = IbColors.TextDim,
                )
            }
        }
        leading?.invoke()

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                style = titleStyle,
                color = IbColors.Text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.invoke()
        }

        Box(contentAlignment = Alignment.CenterEnd) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(IbSpacing.xs),
                content = actions,
            )
        }
    }
}
