package com.internalbeyond.mobile.ui.theme

import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Semantic bridge for IB Visual Language v1.
 *
 * Existing IbColors / IbSpacing / IbShapes / IbType values remain the compatibility
 * source for current screens. New components can resolve a role here without choosing
 * a material name such as "glass" or copying a value into a screen.
 *
 * This facade is additive and intentionally has no consumers in D1. The Web equivalent
 * is the --ib-token-* family in assets/css/core.css.
 */
object IbSemanticTokens {

    object ColorRole {
        val canvas: Color = IbColors.Ink
        val canvasSubtle: Color = IbColors.InkRaised

        val contentPrimary: Color = IbColors.Text
        val contentSecondary: Color = IbColors.TextDim
        val contentMuted: Color = IbColors.TextFaint
        val contentDisabled: Color = contentMuted
        val contentInverse: Color = IbColors.Text

        val accentBrand: Color = IbColors.Accent
        val accentAction: Color = IbColors.Accent
        val accentHover: Color = IbColors.AccentSoft
        val accentActive: Color = IbColors.Accent
        val accentActionFill: Color = IbColors.AccentFill
        val accentActionContent: Color = IbColors.Text
        val accentSoft: Color = IbColors.AccentSoft.copy(alpha = 0.14f)
        val selection: Color = IbColors.GlassPressed
        val link: Color = IbColors.AccentSoft

        val boundarySubtle: Color = IbColors.GlassEdge.copy(alpha = 0.6f)
        val boundaryDefault: Color = IbColors.AccentSoft.copy(alpha = 0.55f)
        val boundaryStrong: Color = IbColors.AccentSoft

        val surface: Color = Color.Transparent
        val surfaceInteractive: Color = IbColors.GlassHigh
        val surfaceSelected: Color = IbColors.GlassPressed
        val surfaceElevated: Color = IbColors.SheetGround
        val overlay: Color = IbColors.Scrim
        val dialog: Color = IbColors.SheetGround
        val popover: Color = IbColors.SheetGround

        val inputBg: Color = IbColors.GlassInput
        val inputBoundary: Color = boundaryDefault
        val inputContent: Color = IbColors.Text
        val inputPlaceholder: Color = IbColors.TextFaint
        val inputFocus: Color = IbColors.AccentSoft
        val inputDisabled: Color = IbColors.InkRaised

        val statusSuccess: Color = IbColors.Ok
        val statusInfo: Color = IbColors.Info
        val statusWarning: Color = IbColors.Warn
        val statusDanger: Color = IbColors.Danger
        val statusNeutral: Color = IbColors.TextFaint
    }

    object Space {
        val xs: Dp = IbSpacing.xs
        val sm: Dp = IbSpacing.sm
        val md: Dp = IbSpacing.md
        val lg: Dp = IbSpacing.lg
        val xl: Dp = IbSpacing.xl
        val xxl: Dp = IbSpacing.xxl
        val xxxl: Dp = IbSpacing.xxxl
    }

    data class DensityPreset(
        val sectionGap: Dp,
        val groupGap: Dp,
        val controlGap: Dp,
    )

    object Density {
        val relaxed = DensityPreset(Space.xxxl, Space.xxl, Space.md)
        val standard = DensityPreset(Space.xxl, Space.lg, Space.sm)
        val dense = DensityPreset(Space.lg, Space.md, Space.sm)
    }

    object Radius {
        val compact = RoundedCornerShape(4.dp)
        val control = RoundedCornerShape(8.dp)
        val surface = RoundedCornerShape(12.dp)
        val dialog = RoundedCornerShape(16.dp)
        val round = RoundedCornerShape(percent = 50)
    }

    object Elevation {
        val none: Dp = 0.dp
        val popover: Dp = 8.dp
        val dialog: Dp = 16.dp
    }

    object Motion {
        const val microMillis = 160
        const val stateMillis = 200
        const val structuralMillis = 280
        const val hardMaximumMillis = 350

        val standardEasing: Easing = FastOutSlowInEasing
        val linearEasing: Easing = LinearEasing
    }

    object Focus {
        val ring: Color = IbColors.AccentSoft
        val width: Dp = 2.dp
        val offset: Dp = 2.dp
    }

    object Layer {
        // These order values apply only to nodes in the same Compose window.
        const val content = 0f
        const val pageVeil = 1f
        const val navigation = 100f
        const val popover = 300f
        const val overlay = 400f
        const val dialog = 500f
        const val toast = 600f
    }

    object Type {
        val body = IbType.body
        val meta = IbType.caption
        val pageTitle = IbType.screenTitle
        val sectionTitle = IbType.nameSmall
        val reading = IbType.speech
        val identity = IbType.display
        val technical = IbType.mono
    }
}
