package com.internalbeyond.mobile.ui.character

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.internalbeyond.mobile.app.AppGraph
import com.internalbeyond.mobile.domain.ErrorPresenter
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.ui.IbStrings
import com.internalbeyond.mobile.ui.common.IbAvatar
import com.internalbeyond.mobile.ui.common.IbBackground
import com.internalbeyond.mobile.ui.common.IbConnectionBadge
import com.internalbeyond.mobile.ui.common.IbEmptyState
import com.internalbeyond.mobile.ui.common.IbErrorCard
import com.internalbeyond.mobile.ui.common.IbGlow
import com.internalbeyond.mobile.ui.common.IbMark
import com.internalbeyond.mobile.ui.common.IbThinkingDots
import com.internalbeyond.mobile.ui.common.IbTopBar
import com.internalbeyond.mobile.ui.common.connectionBusy
import com.internalbeyond.mobile.ui.common.connectionColor
import com.internalbeyond.mobile.ui.common.connectionLabel
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbShapes
import com.internalbeyond.mobile.ui.theme.IbSpacing
import com.internalbeyond.mobile.ui.theme.IbType
import kotlinx.coroutines.launch

class CharacterListViewModel(private val graph: AppGraph) : ViewModel() {

    val characters = graph.characters.state

    init {
        // Phase 14: on start, drain the change log from the stored cursor so the
        // cache reflects anything that happened while the app was closed, then
        // refresh the catalog. The cached list is already on screen by then.
        viewModelScope.launch {
            graph.characters.loadCached()
            graph.sync.run(graph.nodeKey())
            graph.characters.refresh()
        }
    }

    fun refresh() {
        viewModelScope.launch {
            graph.sync.run(graph.nodeKey())
            graph.characters.refresh()
        }
    }

    companion object {
        fun factory(graph: AppGraph): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CharacterListViewModel(graph) as T
        }
    }
}

/**
 * Phase 10/11: characters, cache first.
 *
 * What is still deliberately NOT shown: provider, endpoint, API configuration, system
 * prompt, temperature. The phone does not have them and must not imply that it does —
 * the DTO does not carry them either, so this is a structural absence rather than a
 * display choice.
 *
 * What changed in M1-C.1 is the shape. The old screen was a Material list with a
 * divider and a "vision" chip; this is one glass panel of rows, with a 52dp portrait,
 * the character's name in the serif face the product uses for people, and one line of
 * who they are. There is no per-character presence dot, because the mobile DTO has no
 * per-character presence and inventing one would be inventing a fact — the roster shows
 * what it knows (archived, vision) and the connection badge above it shows whether
 * anything can be reached at all.
 */
@Composable
fun CharacterListScreen(
    graph: AppGraph,
    sessionState: ConnectionState,
    onOpenCharacter: (String) -> Unit,
    onOpenSettings: () -> Unit,
    viewModel: CharacterListViewModel = viewModel(factory = CharacterListViewModel.factory(graph)),
) {
    val state by viewModel.characters.collectAsStateWithLifecycle()
    val topInset = 76.dp

    IbBackground(glow = IbGlow.Quiet) {
        Column(modifier = Modifier.fillMaxSize()) {
            IbTopBar(
                title = IbStrings.charactersTitle,
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(
                            imageVector = Icons.Filled.Refresh,
                            contentDescription = IbStrings.charactersRefresh,
                            tint = IbColors.TextFaint,
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            imageVector = Icons.Filled.Settings,
                            contentDescription = IbStrings.charactersSettings,
                            tint = IbColors.TextFaint,
                        )
                    }
                },
            )

            Row(modifier = Modifier.padding(horizontal = IbSpacing.gutter)) {
                IbConnectionBadge(
                    color = connectionColor(sessionState),
                    label = connectionLabel(sessionState),
                    busy = connectionBusy(sessionState),
                )
            }

            state.error?.let { error ->
                Box(modifier = Modifier.padding(top = IbSpacing.lg, start = IbSpacing.gutter, end = IbSpacing.gutter)) {
                    IbErrorCard(ErrorPresenter.present(error))
                }
            }

            when {
                state.characters.isEmpty() && state.loading -> Centred { IbThinkingDots() }

                state.characters.isEmpty() && state.catalogConfirmedEmpty -> IbEmptyState(
                    title = IbStrings.charactersEmptyPublished,
                    detail = IbStrings.charactersEmptyPublishedDetail,
                    modifier = Modifier.padding(top = topInset),
                )

                state.characters.isEmpty() -> IbEmptyState(
                    title = IbStrings.charactersEmptyUnreachable,
                    detail = IbStrings.charactersEmptyUnreachableDetail,
                    modifier = Modifier.padding(top = topInset),
                )

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = IbSpacing.gutter,
                        end = IbSpacing.gutter,
                        top = IbSpacing.xl,
                        bottom = IbSpacing.xxxl,
                    ),
                ) {
                    if (state.fromCache) {
                        item(key = "cached-note") {
                            Text(
                                text = IbStrings.charactersFromCache,
                                style = IbType.caption,
                                color = IbColors.TextFaint,
                                modifier = Modifier.padding(
                                    start = IbSpacing.xs,
                                    bottom = IbSpacing.md,
                                ),
                            )
                        }
                    }
                    itemsIndexed(state.characters, key = { _, character -> character.id }) { index, character ->
                        CharacterRow(
                            character = character,
                            first = index == 0,
                            last = index == state.characters.lastIndex,
                            onClick = { onOpenCharacter(character.id) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * One row of the roster.
 *
 * The rounding and the hairline are applied per row rather than by wrapping the whole
 * list in one panel, so that the list stays virtualised: a desktop with two hundred
 * characters must not cost two hundred composed rows on every frame.
 */
@Composable
private fun CharacterRow(
    character: Character,
    first: Boolean,
    last: Boolean,
    onClick: () -> Unit,
) {
    val shape: Shape = when {
        first && last -> IbShapes.card
        first -> RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
        last -> RoundedCornerShape(bottomStart = 16.dp, bottomEnd = 16.dp)
        else -> RoundedCornerShape(0.dp)
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(IbColors.Glass)
                .clickable(onClick = onClick)
                .semantics { contentDescription = IbStrings.cdOpenCharacter(character.name) }
                .padding(horizontal = IbSpacing.lg, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IbAvatar(character = character, size = 52.dp)
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(IbSpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = character.name,
                        style = IbType.nameSmall,
                        color = IbColors.Text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (character.isArchived) IbMark(IbStrings.characterArchived)
                    if (character.capabilities.vision) IbMark(IbStrings.characterVision, accent = true)
                }
                // Signature before relationship on purpose. "同行者" is a category the
                // desktop assigned; "她说她记得每一场雨" is the line the person wrote
                // about them, and a roster of categories is a directory listing. Falls
                // back through relationship and bio so a character with no signature
                // still says something true about themselves.
                val subtitle = listOf(character.signature, character.relationship, character.bio)
                    .firstOrNull { it.isNotBlank() }
                    ?: character.handle
                if (subtitle.isNotBlank()) {
                    Spacer(Modifier.height(3.dp))
                    Text(
                        text = subtitle,
                        style = IbType.bodySmall,
                        color = IbColors.TextDim,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (!last) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = IbSpacing.lg)
                    .height(1.dp)
                    .background(IbColors.GlassEdge.copy(alpha = 0.55f)),
            )
        }
    }
}

@Composable
private fun Centred(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 72.dp),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
