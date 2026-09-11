package com.internalbeyond.mobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * InternalBeyond's palette, on a phone.
 *
 * These are not invented colours. They are the dark half of the desktop's own
 * token set (`assets/css/core.css`), read across: `--bg-deep`/`--bg-mid`,
 * `--content-primary`/`--text-secondary`/`--text-muted`, `--accent`/`--accent-light`,
 * the `rgba(155,180,218,…)` glass family, and the four `--status-*` hues. A phone
 * that is the companion to that desktop should look like the same room lit the same
 * way — not like a Material sample that happens to be dark.
 *
 * Two deliberate departures from the desktop values:
 *
 *  · [Ink] is one step deeper than `--bg-deep`. On an OLED phone the ground is most
 *    of the screen, and glass only reads as glass when there is something dark
 *    behind it to be translucent *against*.
 *  · [GlowIndigo]/[GlowViolet] do not exist upstream. They are the ambient light
 *    behind the pairing screen and appear nowhere else, at low alpha, and never as
 *    the colour of a word or a control.
 *
 * Every colour a screen may use is here. A screen that writes its own literal is
 * how four screens end up looking like four apps.
 */
object IbColors {

    // ── Ground ───────────────────────────────────────────────────────────────
    /** The page. Deeper than the desktop's `--bg-deep` so glass has something to sit on. */
    val Ink = Color(0xFF0F1424)

    /** Raised ground: sheets, the composer rail, anything above the page. */
    val InkRaised = Color(0xFF181E32)

    /** The desktop's `--bg-mid`. Used for selected/pressed ground, sparingly. */
    val InkLift = Color(0xFF263050)

    // ── Text ─────────────────────────────────────────────────────────────────
    /** Body and titles. Desktop `--content-primary`. */
    val Text = Color(0xFFE0E6F2)
    /** Secondary lines: signatures, captions, explaining sentences. */
    val TextDim = Color(0xFFADB8D0)
    /** Metadata that is present but not asking to be read: timestamps, labels. */
    val TextFaint = Color(0xFF7E90B2)

    // ── Accent ───────────────────────────────────────────────────────────────
    /** Desktop `--accent`. The one blue the product owns. */
    val Accent = Color(0xFF5080B0)
    /** Desktop `--accent-light`. Hover/focus, glyph highlights, running state. */
    val AccentSoft = Color(0xFF72A8D8)

    /**
     * The accent as a *fill you put text on*.
     *
     * Material's own on-primary would be dark text here, which reads as a different
     * product. Keeping pale text on the accent instead means the accent has to be
     * darker than `--accent`: at #5080B0 the contrast against [Text] is 3.3:1, which is
     * under the 4.5:1 floor for a 15sp label. This is the same hue, deepened until the
     * label is readable (4.5:1).
     */
    val AccentFill = Color(0xFF3F6A96)

    // ── Glass ────────────────────────────────────────────────────────────────
    // The desktop builds every surface out of one hue at a few alphas
    // (`--surface-card`, `--surface-input`, `--surface-hover`, `--glass-border-*`).
    // Same idea, same numbers, expressed as ARGB so Compose can composite them.
    /** A card. Desktop `--surface-card`. */
    val Glass = Color(0x1A9BB4DA)
    /** A field's fill. Desktop `--surface-input`, the faintest of the family. */
    val GlassInput = Color(0x139BB4DA)
    /** Pressed / selected ground. Desktop `--surface-hover`. */
    val GlassHigh = Color(0x299BB4DA)
    /** The strongest fill; reserved for the sheet and the pressed state. */
    val GlassPressed = Color(0x389BB4DA)
    /** Hairline edge on glass. Desktop `--glass-border-soft`. */
    val GlassEdge = Color(0x33A5BCE6)
    /** Edge that must be seen: focused field, the connected badge. */
    val GlassEdgeStrong = Color(0x57A5BCE6)

    /** The sheet's own fill — opaque enough to be read over the page behind it. */
    val SheetGround = Color(0xFF161C2E)

    // ── Conversation ─────────────────────────────────────────────────────────
    // Two bubbles that have to be told apart at a glance without either of them
    // shouting. Incoming is the glass every other surface uses; outgoing is the same
    // tint taken through the accent hue, so "what I said" reads as the accented one
    // without becoming a solid block of colour down the right-hand side.
    val BubbleIn = Color(0x249BB4DA)
    val BubbleOut = Color(0x385080B0)
    val BubbleOutEdge = Color(0x4072A8D8)

    // ── Status ───────────────────────────────────────────────────────────────
    // Exactly the desktop's four, unmodified: muted enough to sit quietly in a
    // dark room, which a saturated red or green would not.
    val Ok = Color(0xFF6F9F83)
    val Warn = Color(0xFFB58A55)
    val Danger = Color(0xFFC78282)
    val Info = Color(0xFF5080B0)

    /** A fill for a failure surface: the danger hue, barely there. */
    val DangerWash = Color(0x1FC78282)
    val DangerEdge = Color(0x4DC78282)
    val OkWash = Color(0x1F6F9F83)
    val OkEdge = Color(0x4D6F9F83)

    // ── Ambient light ────────────────────────────────────────────────────────
    // Not a palette. Light. Rendered only by [com.internalbeyond.mobile.ui.common.IbBackground],
    // only at low alpha, and never used to tint text or a control.
    val GlowIndigo = Color(0xFF3B4A8C)
    val GlowViolet = Color(0xFF5B4FA8)

    // ── Scrim ────────────────────────────────────────────────────────────────
    /** Behind a sheet. Deep enough that the page behind stops competing. */
    val Scrim = Color(0xCC070A14)
}
