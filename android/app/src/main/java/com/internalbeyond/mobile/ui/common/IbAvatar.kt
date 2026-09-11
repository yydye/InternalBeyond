package com.internalbeyond.mobile.ui.common

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbType

/**
 * Decode a character's avatar, when there is one to decode.
 *
 * The mobile DTO truncates `avatar` to 512 characters (`assets/js/mobile-dto.js`), and
 * a real base64 avatar is far longer — so most published avatars arrive cut off and
 * cannot be decoded at all. This returns null in that case instead of throwing, and
 * [IbAvatar] draws its fallback. A phone that shows an initial is honest; a phone that
 * shows a broken image is not.
 */
@Composable
fun rememberAvatarImage(avatar: String): ImageBitmap? = remember(avatar) {
    if (!avatar.startsWith("data:image")) return@remember null
    val comma = avatar.indexOf(',')
    if (comma <= 0) return@remember null
    if (!avatar.substring(0, comma).contains("base64", ignoreCase = true)) return@remember null
    try {
        val bytes = Base64.decode(avatar.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    } catch (_: Throwable) {
        null
    }
}

/**
 * A character's face.
 *
 * Three layers, in order of what the data can actually support: a decoded portrait, or
 * the character's own first letter set in the serif face the product uses for names,
 * over a very slight accent gradient — never a flat grey circle, which is what a
 * placeholder looks like when nobody decided anything.
 *
 * The ring is deliberately one hairline rather than a glow: a roster of ten glowing
 * avatars reads as a game lobby, and this is a list of people the user talks to.
 */
@Composable
fun IbAvatar(
    character: Character,
    size: Dp = 52.dp,
    modifier: Modifier = Modifier,
) {
    val image = rememberAvatarImage(character.avatar)
    val shape = CircleShape
    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(IbColors.InkLift, IbColors.InkRaised),
                ),
            )
            .border(1.dp, IbColors.GlassEdgeStrong, shape)
            .semantics { contentDescription = "${IbStrings.cdAvatarOf} ${character.name}" },
        contentAlignment = Alignment.Center,
    ) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size),
            )
        } else {
            Text(
                text = character.initial,
                style = IbType.name,
                fontSize = (size.value / 2.3f).sp,
                color = IbColors.TextDim,
                textAlign = TextAlign.Center,
            )
        }
    }
}
