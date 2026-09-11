package com.internalbeyond.mobile.ui.theme

import androidx.compose.ui.unit.dp

/**
 * The spacing scale.
 *
 * Steps 1–6 are the desktop's own `--space-1`…`--space-6` (4/8/12/16/20/24) so that
 * a card here and a card there breathe at the same rhythm. [xxl] and [huge] are added
 * because a phone has more vertical room to spend than a desktop panel does, and the
 * brief asks for more air rather than denser information.
 *
 * [gutter] is deliberately 20dp, not Material's 16dp. Four points of extra margin on
 * every screen is most of what separates "a list" from "a page".
 */
object IbSpacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
    val xxxl = 32.dp
    val huge = 40.dp

    /** Screen margin. Wider than Material's default on purpose. */
    val gutter = 20.dp

    /** Between two unrelated blocks on one screen. */
    val block = 28.dp

    /** Between a section's heading and its content. */
    val heading = 10.dp

    /** Inside a card. */
    val cardPadding = 16.dp

    /** Inside a control's touch target, horizontally. */
    val controlPaddingH = 18.dp

    /** Minimum touch target — the platform floor, not a preference. */
    val touchTarget = 48.dp
}
