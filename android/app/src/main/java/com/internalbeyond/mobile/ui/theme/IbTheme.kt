package com.internalbeyond.mobile.ui.theme

import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * The IB colour scheme, as Material expects to see it.
 *
 * Material's names are a translation layer, not the source of truth — [IbColors] is.
 * Where a Material role has no honest IB equivalent the nearest one is used rather
 * than inventing a colour for it.
 */
private val IbScheme = darkColorScheme(
    primary = IbColors.Accent,
    onPrimary = IbColors.Text,
    primaryContainer = IbColors.Accent,
    onPrimaryContainer = IbColors.Text,
    secondary = IbColors.AccentSoft,
    onSecondary = IbColors.Ink,
    tertiary = IbColors.GlowViolet,
    onTertiary = IbColors.Text,
    background = IbColors.Ink,
    onBackground = IbColors.Text,
    surface = IbColors.Ink,
    onSurface = IbColors.Text,
    surfaceVariant = IbColors.InkRaised,
    onSurfaceVariant = IbColors.TextDim,
    surfaceContainerLowest = IbColors.Ink,
    surfaceContainerLow = IbColors.InkRaised,
    surfaceContainer = IbColors.InkRaised,
    surfaceContainerHigh = IbColors.InkLift,
    surfaceContainerHighest = IbColors.InkLift,
    outline = IbColors.GlassEdge,
    outlineVariant = IbColors.GlassEdge,
    error = IbColors.Danger,
    onError = IbColors.Ink,
    errorContainer = IbColors.DangerWash,
    onErrorContainer = IbColors.Danger,
    scrim = IbColors.Scrim,
)

/**
 * The one theme.
 *
 * Three decisions are made here rather than per screen:
 *
 *  · **Dark, always.** The system's light setting is ignored, and so is Material You.
 *    Wallpaper-derived colours are exactly what turns a product's palette into "a
 *    Material app that happens to be dark", and IB already has a palette — the
 *    desktop's. A companion app is the same room as the thing it accompanies.
 *  · **The desktop's geometry.** [IbShapes.material] hands stock Material components
 *    IB's corner scale, so a dialog written later still looks like this app.
 *  · **Text colour is not opt-in.** [IbColors.Text] becomes the ambient content colour,
 *    so a `Text` that nobody coloured is still readable on the dark ground.
 */
@Composable
fun IbTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = IbScheme,
        typography = IbMaterialTypography,
        shapes = IbShapes.material,
    ) {
        CompositionLocalProvider(LocalContentColor provides IbColors.Text, content = content)
    }
}
