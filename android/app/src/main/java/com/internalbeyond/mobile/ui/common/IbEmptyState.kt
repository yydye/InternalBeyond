package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * Nothing here yet, and that is a place to stand rather than a dead end.
 *
 * The rule the copy follows: an empty screen either explains what will put something on
 * it, or offers the action that does. "暂无数据" does neither, so it is not used
 * anywhere in this app.
 *
 * The mark above the words is the bridge's orbit on its own — the same circle, without
 * the span — so an empty screen still belongs to the same product as the pairing screen
 * that preceded it.
 */
@Composable
fun IbEmptyState(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = IbSpacing.xxl, vertical = IbSpacing.huge),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(IbSpacing.sm),
    ) {
        Canvas(modifier = Modifier.size(34.dp).padding(bottom = IbSpacing.lg)) {
            val stroke = 1.6.dp.toPx()
            drawArc(
                color = IbColors.GlassEdge,
                startAngle = 150f,
                sweepAngle = 240f,
                useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset(stroke, stroke),
                size = androidx.compose.ui.geometry.Size(
                    size.width - stroke * 2f,
                    size.height - stroke * 2f,
                ),
                style = Stroke(width = stroke),
            )
            drawCircle(
                color = IbColors.AccentSoft.copy(alpha = 0.7f),
                radius = 2.4.dp.toPx(),
                center = androidx.compose.ui.geometry.Offset(size.width * 0.5f, size.height * 0.5f),
            )
        }
        Text(text = title, style = IbType.nameSmall, color = IbColors.Text, textAlign = TextAlign.Center)
        Text(
            text = detail,
            style = IbType.bodySmall,
            color = IbColors.TextFaint,
            textAlign = TextAlign.Center,
        )
        action?.invoke()
    }
}
