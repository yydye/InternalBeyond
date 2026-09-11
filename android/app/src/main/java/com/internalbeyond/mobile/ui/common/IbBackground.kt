package com.internalbeyond.mobile.ui.common

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.theme.IbColors
import kotlin.math.cos
import kotlin.math.sin

/**
 * How much ambient light a screen gets.
 *
 * One source of light for the whole app, at two strengths — not a gradient per screen.
 * The pairing screen is the only place the light is allowed to be a subject; everywhere
 * else it is there so the glass has something to be translucent against.
 */
enum class IbGlow { Hero, Quiet }

/**
 * The app's ground.
 *
 * Two off-screen lights over the page colour: an indigo wash from above and a violet
 * one from the lower left, both of which stop well before their edges become visible.
 * The desktop gets the same atmosphere from a blurred backdrop; a phone has no room for
 * one, and this costs nothing to draw.
 *
 * Everything drawn on top is glass — `rgba(155,180,218,α)` fills — which is only legible
 * because the ground underneath is dark and slightly uneven.
 */
@Composable
fun IbBackground(
    glow: IbGlow = IbGlow.Quiet,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val indigo = if (glow == IbGlow.Hero) 0.34f else 0.20f
    val violet = if (glow == IbGlow.Hero) 0.26f else 0.10f

    Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(color = IbColors.Ink)
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(IbColors.GlowIndigo.copy(alpha = indigo), Color.Transparent),
                        center = Offset(size.width * 0.5f, size.height * 0.14f),
                        radius = size.width * 1.05f,
                    ),
                )
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(IbColors.GlowViolet.copy(alpha = violet), Color.Transparent),
                        center = Offset(size.width * 0.06f, size.height * 0.92f),
                        radius = size.width * 0.95f,
                    ),
                )
            },
    ) {
        content()
    }
}

/**
 * The bridge mark.
 *
 * Two piers and an arch between them: one larger (the computer), one smaller (this
 * phone), joined by a single brighter span over a barely-there orbit. It is the one
 * piece of drawing in the app, and it exists because the pairing screen has exactly one
 * job — to say that these two things are about to share a world — and a stock icon
 * cannot say it.
 *
 * The motion is one slow breath on the span. Nothing rotates: rotation would read as
 * "searching", and this app is not searching. It is waiting to be introduced.
 */
@Composable
fun IbBridgeMark(
    size: Dp = 96.dp,
    modifier: Modifier = Modifier,
) {
    val breath = rememberInfiniteTransition(label = "bridge")
    val lit by breath.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 3000, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "span",
    )

    Box(
        modifier = modifier
            .size(size)
            .semantics { contentDescription = IbStrings.cdBridgeMark },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(size)) {
            val stroke = 2.dp.toPx()
            val radius = size.toPx() / 2f - stroke
            val centre = Offset(this.size.width / 2f, this.size.height / 2f)
            val topLeft = Offset(centre.x - radius, centre.y - radius)
            val box = Size(radius * 2f, radius * 2f)

            // The shared world: present, but not a boundary.
            drawArc(
                color = IbColors.GlassEdge.copy(alpha = 0.7f),
                startAngle = 0f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = topLeft,
                size = box,
                style = Stroke(width = stroke * 0.75f),
            )

            // The span: 168° (lower left) over the top to 12° (lower right).
            //
            // A solid stroke, not a sweep gradient. The first version used one and it
            // was a mistake worth recording: a sweep gradient is keyed to absolute
            // angle, so the arc — which is 204° of a 360° circle — picked up colours
            // from wherever it happened to lie, and most of it landed on the faded end.
            // On a real screen the arch simply vanished and the mark read as a loading
            // ring. The breath is the motion; the colour does not need to move too.
            drawArc(
                color = IbColors.AccentSoft.copy(alpha = 0.45f + 0.55f * lit),
                startAngle = 168f,
                sweepAngle = 204f,
                useCenter = false,
                topLeft = topLeft,
                size = box,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )

            // This phone.
            drawCircle(
                color = IbColors.AccentSoft,
                radius = 3.4.dp.toPx(),
                center = onOrbit(centre, radius, 168f),
            )
            // The computer.
            drawCircle(
                color = IbColors.Text,
                radius = 4.6.dp.toPx(),
                center = onOrbit(centre, radius, 12f),
            )
        }
    }
}

private fun onOrbit(centre: Offset, radius: Float, degrees: Float): Offset {
    val radians = Math.toRadians(degrees.toDouble())
    return Offset(
        x = centre.x + radius * cos(radians).toFloat(),
        y = centre.y + radius * sin(radians).toFloat(),
    )
}
