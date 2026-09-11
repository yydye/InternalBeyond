package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * A field, without Material's field.
 *
 * `OutlinedTextField` is the single strongest tell that an app was assembled rather
 * than designed: a 56dp box, a floating label, a 4dp focused outline in a colour from a
 * generated scheme, repeated down the page. This is the same job done with the
 * product's own vocabulary — the label sits above in the quiet grey the desktop uses
 * for labels, the fill is the desktop's `--surface-input`, and focus is shown by
 * moving the hairline from one weight to another instead of by drawing an outline.
 *
 * [hint] is for the sentence that would otherwise have to live in supporting text
 * under a box. It is deliberately outside the field, so it reads as advice rather than
 * as part of the answer.
 */
@Composable
fun IbTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    hint: String? = null,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    enabled: Boolean = true,
    shape: Shape = IbShapes.control,
    textStyle: TextStyle = IbType.field,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val edge = if (focused) IbColors.GlassEdgeStrong else IbColors.GlassEdge

    Column(modifier = modifier.fillMaxWidth()) {
        label?.let {
            Text(
                text = it,
                style = IbType.caption,
                color = IbColors.TextFaint,
                modifier = Modifier.padding(start = IbSpacing.xs, bottom = IbSpacing.sm),
            )
        }

        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            textStyle = textStyle.copy(color = if (enabled) IbColors.Text else IbColors.TextFaint),
            cursorBrush = SolidColor(IbColors.AccentSoft),
            visualTransformation = visualTransformation,
            interactionSource = interaction,
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(IbColors.GlassInput)
                .border(1.dp, edge, shape)
                .padding(horizontal = IbSpacing.lg, vertical = IbSpacing.md),
            decorationBox = { inner ->
                if (value.isEmpty() && placeholder != null) {
                    Text(text = placeholder, style = textStyle, color = IbColors.TextFaint)
                }
                inner()
            },
        )

        hint?.let {
            Text(
                text = it,
                style = IbType.caption,
                color = IbColors.TextFaint,
                modifier = Modifier.padding(start = IbSpacing.xs, top = IbSpacing.sm),
            )
        }
    }
}
