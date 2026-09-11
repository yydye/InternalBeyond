package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * A modal.
 *
 * Material's `AlertDialog` is close to right and still wrong here: its surface, its
 * corner radius and its button row all come from the scheme rather than from this
 * product's shapes, and the two questions this app has to ask (rename this phone,
 * disconnect it) are both better served by a panel that looks like the rest of the app
 * sitting on a scrim.
 *
 * The caller supplies its own buttons so that a destructive confirmation can be
 * worded and weighted as one.
 */
@Composable
fun IbDialog(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .width(320.dp)
                .clip(IbShapes.card)
                .background(IbColors.SheetGround)
                .border(1.dp, IbColors.GlassEdge, IbShapes.card)
                .padding(IbSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(IbSpacing.lg),
        ) {
            Text(text = title, style = IbType.nameSmall, color = IbColors.Text)
            content()
        }
    }
}

/** A row of dialog actions, right-aligned, quiet-then-obvious. */
@Composable
fun IbDialogActions(content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(IbSpacing.xs)) {
        content()
    }
}
