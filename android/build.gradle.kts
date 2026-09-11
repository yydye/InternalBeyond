/* Root build file. Versions are pinned here (no version catalog) so that the
   whole toolchain contract is readable in one screen — see android/README.md. */
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
