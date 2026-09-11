package com.internalbeyond.mobile.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import com.internalbeyond.mobile.ui.IbRoot
import com.internalbeyond.mobile.ui.theme.IbTheme

/**
 * The single activity.
 *
 * `enableEdgeToEdge()` plus Compose's `safeDrawing` insets is the whole of Phase 30:
 * the status bar, the navigation bar, the display cutout and the IME are handled by
 * the platform's inset model instead of by guessing pixel offsets or copying a
 * browser `env(safe-area-inset-*)` hack.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as IbApplication).graph
        setContent {
            IbTheme(darkTheme = isSystemInDarkTheme()) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    com.internalbeyond.mobile.ui.IbRoot(graph = graph)
                }
            }
        }
    }
}
