package com.internalbeyond.mobile.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.internalbeyond.mobile.ui.IbRoot
import com.internalbeyond.mobile.ui.theme.IbColors
import com.internalbeyond.mobile.ui.theme.IbTheme

/**
 * The single activity.
 *
 * `enableEdgeToEdge()` plus Compose's `safeDrawing` insets is the whole of Phase 30:
 * the status bar, the navigation bar, the display cutout and the IME are handled by
 * the platform's inset model instead of by guessing pixel offsets or copying a
 * browser `env(safe-area-inset-*)` hack.
 *
 * The bar styles are pinned to `dark` rather than left to the platform's automatic
 * light/dark decision. That decision follows the *system* setting, and this app is dark
 * regardless of it (see [IbTheme]) — so on a phone set to light mode the automatic
 * choice would put dark icons on a near-black status bar, which is how an app ends up
 * with an invisible clock.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        val graph = (application as IbApplication).graph
        setContent {
            IbTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = IbColors.Ink,
                ) {
                    IbRoot(graph = graph)
                }
            }
        }
    }
}
