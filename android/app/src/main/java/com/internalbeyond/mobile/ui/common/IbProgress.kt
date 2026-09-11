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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors

/**
 * The character is thinking, and the app says so without a spinner.
 *
 * A rotating ring means "the app is busy"; three soft dots mean "someone is writing",
 * which is what is actually happening — the Home Node is streaming a person's reply.
 * The distinction is small and it is the difference between an app that feels like a
 * tool and one that feels like a conversation.
 */
@Composable
fun IbThinkingDots(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "thinking")
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(3) { index ->
            val alpha by transition.animateFloat(
                initialValue = 0.22f,
                targetValue = 0.95f,
                animationSpec = infiniteRepeatable(
                    animation = tween(
                        durationMillis = 680,
                        delayMillis = index * 180,
                        easing = LinearEasing,
                    ),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "dot$index",
            )
            Box(
                modifier = Modifier
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(IbColors.AccentSoft.copy(alpha = alpha)),
            )
        }
    }
}
