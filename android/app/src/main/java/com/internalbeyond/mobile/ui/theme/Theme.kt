package com.internalbeyond.mobile.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * InternalBeyond's palette.
 *
 * Deliberately small: one accent per role, dark-first, and no gradients that would
 * have to be re-tuned for light mode. Phase 31 asks for the IB feel without letting
 * visual work delay the protocol closure — so this is a disciplined Material 3
 * scheme rather than a bespoke design system.
 */
private val IbBlue = Color(0xFF7CC4FF)
private val IbBlueDeep = Color(0xFF2C6FA8)
private val IbViolet = Color(0xFFB9A2FF)

private val VoidSurface = Color(0xFF0B0D12)
private val VoidSurfaceRaised = Color(0xFF141A24)
private val VoidOutline = Color(0xFF2A3444)

private val DarkScheme = darkColorScheme(
    primary = IbBlue,
    onPrimary = Color(0xFF04223A),
    primaryContainer = IbBlueDeep,
    onPrimaryContainer = Color(0xFFD7ECFF),
    secondary = IbViolet,
    onSecondary = Color(0xFF1E1240),
    background = VoidSurface,
    onBackground = Color(0xFFE6EAF2),
    surface = VoidSurface,
    onSurface = Color(0xFFE6EAF2),
    surfaceVariant = VoidSurfaceRaised,
    onSurfaceVariant = Color(0xFFAFB9CB),
    surfaceContainer = VoidSurfaceRaised,
    surfaceContainerHigh = Color(0xFF1B2330),
    outline = VoidOutline,
    outlineVariant = Color(0xFF212A38),
    error = Color(0xFFFF8A8A),
    onError = Color(0xFF3A0908),
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF1B6FA8),
    onPrimary = Color.White,
    secondary = Color(0xFF5B45A8),
    background = Color(0xFFF7F8FB),
    onBackground = Color(0xFF14181F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14181F),
    surfaceVariant = Color(0xFFE8ECF3),
    onSurfaceVariant = Color(0xFF47505F),
    surfaceContainer = Color(0xFFF1F3F8),
    surfaceContainerHigh = Color(0xFFE8ECF3),
    outline = Color(0xFFBFC7D4),
    outlineVariant = Color(0xFFDDE2EA),
    error = Color(0xFFB3261E),
)

private val IbTypography = Typography(
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun IbTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /**
     * Material You wallpaper colours are used when the platform offers them
     * (Android 12+). IB's own palette is the fallback, not the other way round:
     * a phone that can match its owner's wallpaper should be allowed to.
     */
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val scheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)

        darkTheme -> DarkScheme
        else -> LightScheme
    }
    MaterialTheme(colorScheme = scheme, typography = IbTypography, content = content)
}
