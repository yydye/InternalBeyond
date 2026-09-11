package com.internalbeyond.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * A sheet, used for the two flows that are too big for a screen and too small for a
 * page: 手动连接 and 高级设置.
 *
 * Material's `ModalBottomSheet` does the hard part — drag-to-dismiss, the scrim, the
 * inset dance — and it does not have a visual opinion that survives being told the
 * ground colour and the corner radius, so it is worth keeping rather than
 * reimplementing. What is added is the grip: a hairline, not a Material drag handle,
 * because a pill in the middle of a sheet is one of the clearer tells that nobody chose
 * anything here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IbSheet(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = IbColors.SheetGround,
        scrimColor = IbColors.Scrim,
        shape = IbShapes.sheet,
        dragHandle = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = IbSpacing.md, bottom = IbSpacing.xs),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(width = 34.dp, height = 2.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(IbColors.GlassEdgeStrong),
                )
            }
        },
    ) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = IbSpacing.gutter)
                .padding(bottom = IbSpacing.xxl),
            verticalArrangement = Arrangement.spacedBy(IbSpacing.lg),
        ) {
            Text(text = title, style = IbType.screenTitle, color = IbColors.Text)
            content()
        }
    }
}
