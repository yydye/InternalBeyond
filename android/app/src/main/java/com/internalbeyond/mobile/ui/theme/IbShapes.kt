package com.internalbeyond.mobile.ui.theme

import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * The corner scale.
 *
 * 16 / 12 / 10 are the desktop's `--radius-panel` / `--radius-card` /
 * `--radius-control`, unchanged. That correspondence is the whole point: "IB 风格圆角"
 * is not a new invention, it is this ratio, and a phone that uses it looks like it
 * belongs to the same product as the window it is talking to.
 *
 * [bubble] is the one shape the desktop does not have, because a desktop has no chat
 * bubbles on a phone's narrow column. It keeps the IB ratio and adds the tail the
 * platform's chat convention expects.
 */
object IbShapes {

    /** Modal sheets. The largest radius in the system, so it reads as "above" everything. */
    val sheet = RoundedCornerShape(28.dp)

    /** Panels and cards. Desktop `--radius-panel`. */
    val card = RoundedCornerShape(16.dp)

    /** Buttons, fields, list surfaces. Desktop `--radius-card`. */
    val control = RoundedCornerShape(12.dp)

    /** Chips, small marks, the badge. Desktop `--radius-control`. */
    val chip = RoundedCornerShape(10.dp)

    val pill = RoundedCornerShape(percent = 50)

    /**
     * A message bubble: IB's ratio, with the corner nearest the speaker pulled in so
     * the tail points at whoever said it without drawing an actual tail.
     */
    fun bubble(fromUser: Boolean): CornerBasedShape = if (fromUser) {
        RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 6.dp)
    } else {
        RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 6.dp, bottomEnd = 18.dp)
    }

    /** Handed to MaterialTheme so stock components inherit IB's geometry, not M3's. */
    val material = Shapes(
        extraSmall = chip,
        small = control,
        medium = card,
        large = card,
        extraLarge = sheet,
    )
}
