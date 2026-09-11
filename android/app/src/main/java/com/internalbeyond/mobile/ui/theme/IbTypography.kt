package com.internalbeyond.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Type.
 *
 * The desktop runs two families (`--font-ui: 'Noto Sans SC'`, `--font-reading:
 * 'Noto Serif SC'`) plus a Latin display face. Shipping CJK webfonts into an APK would
 * cost megabytes for a result the platform already has, so the two roles are expressed
 * with the families Android itself ships: `FontFamily.Default` resolves to Noto Sans
 * CJK, and `FontFamily.Serif` to Noto Serif CJK. Same division of labour, zero bytes.
 *
 * The division is meaningful, not decorative:
 *
 *  · **Serif is the voice of the characters** — the pairing screen's promise, a
 *    character's name, and the words inside a message bubble. It is the "reading" face.
 *  · **Sans is the voice of the app** — buttons, status, settings, labels, timestamps.
 *    It is the "chrome" face.
 *
 * A chat screen where the character speaks serif and the app speaks sans is legible at
 * a glance: what is content and what is furniture never need to be worked out.
 *
 * Sizes follow a 1.25-ish scale. Chinese has no ascender/descender variety to lean on,
 * so every step carries extra leading relative to a Latin equivalent, and serif body
 * text carries more than sans — the desktop's own reading style does the same.
 */
object IbType {

    /** The hero. One per app, on the pairing screen. Sizes above this do not exist. */
    val display = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 27.sp,
        lineHeight = 39.sp,
    )

    /** A screen's title in the top bar. */
    val screenTitle = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 19.sp,
        lineHeight = 26.sp,
    )

    /** A character's name — on a card, and in the chat's top bar. */
    val name = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 19.sp,
        lineHeight = 27.sp,
    )

    /** A character's name at list scale, where the row is not the whole screen. */
    val nameSmall = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 17.sp,
        lineHeight = 24.sp,
    )

    /** What a character says. The reading style: serif, generous leading. */
    val speech = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 27.sp,
    )

    /** Interface prose: explaining sentences, empty states, dialog bodies. */
    val body = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 22.sp,
    )

    /** Secondary lines under a name: relationship, signature. */
    val bodySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    )

    /** Metadata. Present, not asking to be read. */
    val caption = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    )

    /** Buttons, and only buttons. */
    val button = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 15.sp,
        lineHeight = 20.sp,
    )

    /** A field's own text. Matches [body] so a form does not look like a different app. */
    val field = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
    )

    /** A single glyph or two: the avatar initial, a capability mark. */
    val mark = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 16.sp,
    )

    /** Values that are identifiers: fingerprints, versions, addresses. Dev surfaces only. */
    val mono = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 18.sp,
    )
}

/**
 * The Material slots, filled from [IbType].
 *
 * Stock components (dialogs, sheets, checkboxes) read these, so a component written
 * before this stage still lands inside the system instead of beside it.
 */
internal val IbMaterialTypography = Typography(
    displayLarge = IbType.display,
    displayMedium = IbType.display,
    displaySmall = IbType.display,
    headlineLarge = IbType.screenTitle,
    headlineMedium = IbType.name,
    headlineSmall = IbType.nameSmall,
    titleLarge = IbType.screenTitle,
    titleMedium = IbType.nameSmall,
    titleSmall = IbType.bodySmall,
    bodyLarge = IbType.speech,
    bodyMedium = IbType.body,
    bodySmall = IbType.bodySmall,
    labelLarge = IbType.button,
    labelMedium = IbType.mark,
    labelSmall = IbType.caption,
)
