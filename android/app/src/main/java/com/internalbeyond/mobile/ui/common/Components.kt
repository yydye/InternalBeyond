package com.internalbeyond.mobile.ui.common

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import com.internalbeyond.mobile.domain.model.ChatMessage
import com.internalbeyond.mobile.domain.model.Character
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * An avatar, degraded honestly.
 *
 * The character DTO truncates `avatar` to 512 characters (`mobile-dto.js`), and a
 * real base64 avatar is far longer than that — so most published avatars cannot be
 * decoded at all. Rather than show a broken image, this decodes when it can and
 * falls back to the character's initial otherwise (Phase 10's "自然降级").
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
        // A truncated or otherwise unusable data URL is expected, not exceptional.
        null
    }
}

@Composable
fun CharacterAvatar(
    character: Character,
    size: Dp = 48.dp,
    modifier: Modifier = Modifier,
) {
    val image = rememberAvatarImage(character.avatar)
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = character.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size),
            )
        } else {
            Text(
                text = character.initial,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value / 2.4f).sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** A small coloured dot plus a word. Never says "secure" without TLS (Phase 27). */
@Composable
fun StatusDot(color: Color, label: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(color),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Three animated dots shown while the Home Node is generating (Phase 31). */
@Composable
fun StreamingDots(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "streaming")
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(3) { index ->
            val alpha by transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 620, delayMillis = index * 170, easing = LinearEasing),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "dot$index",
            )
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = alpha)),
            )
        }
    }
}

/**
 * Attachment placeholders (Phase 33).
 *
 * The model carries image/file/voice METADATA and the canonical record keeps the
 * bytes, but this stage does not download or render them — so the bubble says what
 * is there instead of pretending the message is text-only.
 */
@Composable
fun AttachmentChips(message: ChatMessage, modifier: Modifier = Modifier) {
    if (!message.hasAttachments) return
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (image in message.images) {
            Chip(
                text = buildString {
                    append("Image · ")
                    append(image.mime.removePrefix("image/"))
                    image.width?.let { w -> image.height?.let { h -> append(" · ${w}×$h") } }
                },
            )
        }
        for (file in message.files) {
            Chip(text = "File · ${file.name}")
        }
        message.voice?.let { voice ->
            Chip(
                text = buildString {
                    append("Voice")
                    voice.durationSeconds?.let { append(" · ${it.toInt()}s") }
                    voice.transcript?.let { append(" · transcript available") }
                },
            )
        }
    }
}

@Composable
private fun Chip(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

private val timeFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val dateTimeFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

/** Local wall-clock time; a bare HH:mm for today, a date for anything older. */
fun formatTimestamp(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp <= 0) return ""
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(timestamp).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return if (moment.toLocalDate() == today) {
        timeFormatter.format(moment)
    } else {
        dateTimeFormatter.format(moment)
    }
}

/** "3 minutes ago", for last-seen style facts. */
fun formatRelative(timestamp: Long, now: Long = System.currentTimeMillis()): String {
    if (timestamp <= 0) return "never"
    val delta = (now - timestamp).coerceAtLeast(0)
    val seconds = delta / 1000
    return when {
        seconds < 45 -> "just now"
        seconds < 3600 -> "${seconds / 60} min ago"
        seconds < 86_400 -> "${seconds / 3600} h ago"
        else -> "${seconds / 86_400} d ago"
    }
}

@Composable
fun isDark(): Boolean = isSystemInDarkTheme()
