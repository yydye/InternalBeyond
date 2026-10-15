# IB Visual Token Contract v1

- 状态：**FROZEN FOR D3 · D1 COMPLETE**
- 版本日期：2026-10-02
Canonical authority：本文件定义语义 token 的角色与映射；[IB Visual Language v1](IB_VISUAL_LANGUAGE_V1.md) 定义产品视觉规则。D2-D 接受与 D3 handoff 记录于 [IB UI Primitive Contract v1](IB_UI_PRIMITIVE_CONTRACT_V1.md) §30。

## 1. Purpose

把冻结的 IB Visual Language v1 映射为 Web 与 Android 可以共同理解的 token 角色。本阶段建立可复用的名字、主题映射、兼容关系和旧 token 分类；不迁移页面消费者。

核心链路：

Visual Language v1 → Semantic Token Contract → Web / Android aliases → D2 Primitives → Pages

Web 的 **--ib-token** 前缀是新 CSS 消费者的语义 API。Android 的 **IbSemanticTokens** 是对应门面。当前页面和 Compose 组件继续使用原有 token。

## 2. Authority

1. [IB Visual Language v1](IB_VISUAL_LANGUAGE_V1.md) 决定 token 必须表达的含义、状态和信息深度。
2. 本文件唯一决定语义 token 名称及 Web / Android 的映射。
3. Web 生产主题值由 **assets/css/core.css** 提供；不将视觉材料名或模块名提升为全局语义。
4. Android 原始值仍由 **IbColors**、**IbSpacing**、**IbShapes**、**IbType** 提供；**IbSemanticTokens** 只包装语义，不移除旧属性。
5. 既有 CSS / Compose 消费者不因本契约自动迁移。页面家族迁移时再逐步切换。

**Alias first, rename later.** 不重命名现有 token，不删现有值，不通过本阶段新增 CSS / Compose 使用点。

## 3. Naming and semantic taxonomy

### 3.1 Namespaces

- Web 新语义角色统一使用 **--ib-token-domain-role** 命名族。
- Android 新语义角色使用 **IbSemanticTokens.<Domain>.<role>**。
- 命名描述内容/交互/状态/结构职责，不描述玻璃、雾、阴影、渐变等材质。
- 现有 --content-*, --status-*, --surface-*, --glass-*, IbColors.* 保持原名和值，作为兼容输入。
- 同一语义允许跨平台变量名不同，值也可以因像素密度、系统窗口模型和主题有所不同。

### 3.2 Domains

| Domain | Roles |
|---|---|
| Canvas / World | canvas, canvas-subtle |
| Content | primary, secondary, muted, disabled, inverse |
| Accent / Interaction | brand, action, hover, active, action-fill, action-content, soft, selection, focus, link |
| Boundary | subtle, default, strong |
| Surface | surface, surface-interactive, surface-selected, surface-elevated, overlay, dialog, popover |
| Input | bg, boundary, content, placeholder, focus, disabled |
| State | success, info, warning, danger, neutral |
| Radius | compact, control, surface, dialog, round |
| Elevation | none, popover, dialog |
| Motion | micro, state, structural, easing-standard, easing-linear |
| Spacing / Density | 4 px base scale; relaxed, standard, dense layout presets |
| Typography | body, meta, page-title, section-title, reading, identity, technical |
| Focus | ring, width, offset |
| Layer | content, page-veil, navigation, popover, overlay, dialog, toast |

## 4. Web / Android / theme mapping matrix

“Android role”列指新增的语义别名；实现由 IbSemanticTokens.kt 提供。表内 ColorRole 是 IbSemanticTokens.ColorRole 的缩写。Android 目前只有 Infernal-like dark palette；Internal 值在 Web 有定义，Android 未实现 light theme。两端保持语义相同，不要求同一数值。

### 4.1 Color, content, surface and state

| Semantic role | Web canonical / alias | Android mapping | Internal value | Infernal value | Legacy source / classification |
|---|---|---|---|---|---|
| canvas | --ib-token-canvas | ColorRole.canvas → IbColors.Ink | --pale | --bg-deep | --bg-deep remains old page ground |
| canvas-subtle | --ib-token-canvas-subtle | ColorRole.canvasSubtle → InkRaised | --white | --bg-mid | theme palette values |
| content-primary | --ib-token-content-primary | ColorRole.contentPrimary → Text | --content-primary | --content-primary | existing content token, compatibility source |
| content-secondary | --ib-token-content-secondary | ColorRole.contentSecondary → TextDim | --content-secondary | --content-secondary | existing content token, compatibility source |
| content-muted | --ib-token-content-muted | ColorRole.contentMuted → TextFaint | content-muted mixed 10% toward primary | --content-muted | avoids low opacity; Internal value clears 4.5:1 against canvas |
| content-disabled | --ib-token-content-disabled | ColorRole.contentDisabled → contentMuted | same as muted | same as muted | state is expressed separately; no opacity-only disabling |
| content-inverse | --ib-token-content-inverse | ColorRole.contentInverse → Text | --white | --light | only for a known opposite-surface context |
| accent-brand | --ib-token-accent-brand | ColorRole.accentBrand → Accent | --accent | --accent | legacy accent remains unchanged |
| accent-action | --ib-token-accent-action | ColorRole.accentAction → Accent | --accent | --accent-light | brand and action meanings are distinct |
| accent-hover | --ib-token-accent-hover | ColorRole.accentHover → AccentSoft | --accent-light | --accent | no existing hover consumers switched |
| accent-active | --ib-token-accent-active | ColorRole.accentActive → Accent | --accent | --accent-light | may equal a neighboring state value |
| accent-action-fill | --ib-token-accent-action-fill | ColorRole.accentActionFill → AccentFill | accent mixed 80/20 toward content-primary | --accent-light | primary action fill with verified foreground pairing |
| accent-action-content | --ib-token-accent-action-content | ColorRole.accentActionContent → Text | --white | --bg-deep | paired with action-fill; not a general inverse text role |
| accent-soft | --ib-token-accent-soft | ColorRole.accentSoft → AccentSoft wash | 14% accent tint | 14% accent-light tint | fill role, not text color |
| selection | --ib-token-selection | ColorRole.selection → GlassPressed | --surface-pressed | --surface-pressed | existing selection fill |
| focus ring | --ib-token-focus-ring | Focus.ring → AccentSoft | --accent | --accent-light | separate from boundary/shadow |
| link | --ib-token-link | ColorRole.link → AccentSoft | --content-secondary | --accent-light | preserves readable text contrast |
| boundary-subtle | --ib-token-boundary-subtle | ColorRole.boundarySubtle → GlassEdge wash | 45% of --border-soft | 65% of --border-soft | grouping only; not a key control edge |
| boundary-default | --ib-token-boundary-default | ColorRole.boundaryDefault → AccentSoft at 55% | semantic muted content color | --content-muted | contrast-capable key boundary |
| boundary-strong | --ib-token-boundary-strong | ColorRole.boundaryStrong → AccentSoft | --content-secondary | --content-secondary | selected / important boundary |
| surface | --ib-token-surface | ColorRole.surface → Color.Transparent | transparent | transparent | ordinary Section stays transparent |
| surface-interactive | --ib-token-surface-interactive | ColorRole.surfaceInteractive → GlassHigh | --surface-hover | --surface-hover | old interactive fill source |
| surface-selected | --ib-token-surface-selected | ColorRole.surfaceSelected → GlassPressed | --surface-pressed | --surface-pressed | selected state, not a generic card |
| surface-elevated | --ib-token-surface-elevated | ColorRole.surfaceElevated → SheetGround | --glass-bg-elevated | --glass-bg-elevated | glass allowed only for actual elevation |
| overlay | --ib-token-overlay | ColorRole.overlay → Scrim | --surface-overlay-scrim | --surface-overlay-scrim | old page veil filter is separate legacy behavior |
| dialog | --ib-token-dialog | ColorRole.dialog → SheetGround | --glass-bg-modal | --glass-bg-modal | modal material compatibility source |
| popover | --ib-token-popover | ColorRole.popover → SheetGround | --glass-bg-floating | --glass-bg-floating | anchored temporary surface only |
| input-bg | --ib-token-input-bg | ColorRole.inputBg → GlassInput | --surface-input | --surface-input | existing field fill |
| input-boundary | --ib-token-input-boundary | ColorRole.inputBoundary → boundaryDefault | boundary-default | boundary-default | real control edge |
| input-content | --ib-token-input-content | ColorRole.inputContent → Text | content-primary | content-primary | existing field text |
| input-placeholder | --ib-token-input-placeholder | ColorRole.inputPlaceholder → TextFaint | content-muted | content-muted | readable hint, not disabled opacity |
| input-focus | --ib-token-input-focus | ColorRole.inputFocus → AccentSoft | focus ring | focus ring | focus remains independent |
| input-disabled | --ib-token-input-disabled | ColorRole.inputDisabled → InkRaised | surface-hover | surface-hover | pair with disabled text/state |
| status-success | --ib-token-status-success | ColorRole.statusSuccess → Ok | --status-success | --status-success | color is secondary evidence |
| status-info | --ib-token-status-info | ColorRole.statusInfo → Info | --status-info | --status-info | color is secondary evidence |
| status-warning | --ib-token-status-warning | ColorRole.statusWarning → Warn | --status-warning | --status-warning | color is secondary evidence |
| status-danger | --ib-token-status-danger | ColorRole.statusDanger → Danger | --status-danger | --status-danger | color is secondary evidence |
| status-neutral | --ib-token-status-neutral | ColorRole.statusNeutral → TextFaint | content-muted | content-muted | no extra neutral hue |

Status hues are approved for marks, subtle boundaries and small state accents. L1 status copy stays readable content color and includes a word/icon; old colored status text is retained until its family migration.

### 4.2 Shape, elevation, motion, spacing and typography

| Semantic role | Web canonical / alias | Android mapping | Web value | Android value | Legacy source / classification |
|---|---|---|---|---|---|
| radius-compact | --ib-token-radius-compact | Radius.compact | 4 px | 4 dp | no old compact token |
| radius-control | --ib-token-radius-control | Radius.control | 8 px | 8 dp | old --radius-control:10px / IbShapes.control:12dp remain legacy |
| radius-surface | --ib-token-radius-surface | Radius.surface | 12 px | 12 dp | old --radius-card value source |
| radius-dialog | --ib-token-radius-dialog | Radius.dialog | 16 px | 16 dp | old --radius-panel value source |
| radius-round | --ib-token-radius-round | Radius.round | 50% | 50% | only circles/short pills |
| elevation-none | --ib-token-elevation-none | Elevation.none | none | 0 dp | normal content has no shadow |
| elevation-popover | --ib-token-elevation-popover | Elevation.popover | legacy floating shadow value | 8 dp | only anchored temporary layer |
| elevation-dialog | --ib-token-elevation-dialog | Elevation.dialog | legacy modal shadow value | 16 dp | only blocking dialog |
| motion-micro | --ib-token-motion-micro | Motion.microMillis | 160 ms | 160 ms | new semantic value |
| motion-state | --ib-token-motion-state | Motion.stateMillis | --motion-fast (200 ms) | 200 ms | exact-value compatibility alias |
| motion-structural | --ib-token-motion-structural | Motion.structuralMillis | 280 ms | 280 ms | new semantic value |
| easing-standard | --ib-token-motion-easing-standard | Motion.standardEasing | --transition cubic-bezier(.4,0,.2,1) | FastOutSlowInEasing | common structural/state curve |
| easing-linear | --ib-token-motion-easing-linear | Motion.linearEasing | linear | LinearEasing | data interpolation only |
| space-xs / sm / md / lg / xl / xxl / xxxl | --ib-token-space-* | IbSemanticTokens.Space.* | 4 / 8 / 12 / 16 / 20 / 24 / 32 px | 4 / 8 / 12 / 16 / 20 / 24 / 32 dp | aliases to existing scale |
| density-relaxed | --ib-token-density-relaxed-* | Density.relaxed | section 32, group 24, control 12 px | section 32, group 24, control 12 dp | spacing only |
| density-standard | --ib-token-density-standard-* | Density.standard | section 24, group 16, control 8 px | section 24, group 16, control 8 dp | spacing only |
| density-dense | --ib-token-density-dense-* | Density.dense | section 16, group 12, control 8 px | section 16, group 12, control 8 dp | spacing only |
| text-body | --ib-token-text-body | Type.body | Noto Sans SC, 14 px / 1.5 | IbType.body, 14 sp | existing Web --fs-body remains legacy |
| text-meta | --ib-token-text-meta | Type.meta | Noto Sans SC, 12 px / 1.4 | IbType.caption, 12 sp | existing Web --fs-meta remains legacy |
| text-page-title | --ib-token-text-page-title | Type.pageTitle | UI sans, 24 px | IbType.screenTitle, 19 sp | screen dimensions may differ |
| text-section-title | --ib-token-text-section-title | Type.sectionTitle | UI sans, 18 px | IbType.nameSmall, 17 sp | serif role is permitted for reading/character content |
| text-reading | --ib-token-text-reading | Type.reading | Noto Serif SC, 16 px / 1.8 | IbType.speech, 16 sp | existing reading family remains |
| text-identity | --ib-token-text-identity | Type.identity | Cormorant Garamond, 28 px | IbType.display, 27 sp | narrative / identity contexts only |
| text-technical | --ib-token-text-technical | Type.technical | Fira Code / monospace, 12 px | IbType.mono, 12 sp | L3 only |
| focus-ring | --ib-token-focus-ring | Focus.ring | theme accent, contrast ≥3:1 against canvas | AccentSoft | never replaced by shadow |
| focus-ring-width | --ib-token-focus-ring-width | Focus.width | 2 px | 2 dp | new semantic role |
| focus-ring-offset | --ib-token-focus-ring-offset | Focus.offset | 2 px | 2 dp | new semantic role |
| layer-content / page-veil / navigation | --ib-token-layer-* | Layer.content / navigation | 0 / 1 / existing 100 | same-window 0 / 100 | semantic slots |
| layer-popover / overlay / dialog / toast | --ib-token-layer-* | Layer.popover / overlay / dialog / toast | 300 / 400 / 500 / 600 | same-window 300 / 400 / 500 / 600 | platform window overlays remain platform-owned |

Radius, Elevation, Motion, Focus, Layer, Type, Space and Density paths in this table are subobjects of IbSemanticTokens.

### 4.3 Theme and contrast policy

- Theme changes token values only; component structure and token meaning stay fixed.
- Android currently maps to its dark palette only. Internal / light values in this matrix are Web values, not a promise that Android has a light theme.
- Web Internal canvas is pale; Infernal canvas is deep navy. Android Ink is intentionally deeper for the OLED ground.
- Web Internal muted content is a 90/10 mix of existing muted and primary values, giving 4.60:1 against the semantic canvas. Infernal reuses its existing muted value, giving 5.13:1 against the dark canvas. Both meet the 4.5:1 ordinary text floor.
- Internal action-fill uses an 80/20 mix of accent and primary content with off-white action text (4.60:1); Infernal pairs accent-light fill with the deep canvas as action text. Accent-action itself is for marks/affordances, not small body copy.
- Focus tokens target 3:1 or higher against canvas. Status colors alone do not carry L1 copy.

## 5. Compatibility alias strategy

The new role declarations live in the existing Web root and theme blocks. They do not rewrite old variables:

New consumer → --ib-token-<role> → current core.css theme token/value

Examples:

- --ib-token-content-primary → --content-primary
- --ib-token-surface-interactive → --surface-hover
- --ib-token-surface-elevated → --glass-bg-elevated
- --ib-token-input-bg → --surface-input
- --ib-token-motion-state → --motion-fast

Theme-dependent aliases are repeated in both :root and body.theme-infernal. CSS custom
properties resolve var() references where they are declared; a root alias alone would
keep a light value when inherited into the dark theme.

Roles without a safe current equivalent receive a D1 value that has no consumers yet: canvas, compact/control radius, micro/structural motion, readable Web type sizes, and semantic layer slots. No old consumer points back to a new role, so the alias graph is one-way and acyclic.

Android adds IbSemanticTokens.kt as an unused facade over the existing theme values. Existing Android consumers continue to call IbColors, IbSpacing, IbShapes, and IbType directly.

## 6. Surface token policy

- --ib-token-surface is transparent. A Section is not a Surface.
- Interactive / selected roles map to interaction fills, not cards.
- Elevated / popover / dialog roles may use a glass material only when the layout establishes a real temporary layer.
- Boundary and elevation are separate domains: a filled Surface does not automatically receive a border and shadow.
- Overlay is a scrim role. The old page-veil blur is not part of the new overlay token.
- Input surfaces have explicit background, boundary, content, placeholder, focus and disabled roles.
- No module may create a new global surface role to preserve its historic card treatment. Module-specific semantic objects stay local.

## 7. Glass legacy policy

The glass ladder combines surface fill, blur, border, shadow and elevation. D1 keeps it available for existing pages while removing it from the future semantic entry point.

| Existing name / family | Classification | Semantic disposition |
|---|---|---|
| --glass-bg-ambient, --glass-bg-surface | LEGACY_SUPPORTED, deprecated for new UI | Old canvas mist / generic card fills; no direct mapping to canonical surface |
| --glass-bg-elevated | LEGACY_SUPPORTED | Compatibility value for the rare semantic elevated Surface |
| --glass-bg-floating | LEGACY_SUPPORTED | Compatibility value for old Popover / floating controls |
| --glass-bg-modal | LEGACY_SUPPORTED | Compatibility value for Dialog |
| --glass-border-* | LEGACY_SUPPORTED | Old glass edge recipes; new boundary roles are independent |
| --glass-shadow-soft | LEGACY_ONLY | Ordinary content has no elevation |
| --glass-shadow-elevated | LEGACY_SUPPORTED | Existing elevated surface only |
| --glass-shadow-floating/modal | COMPAT_ALIAS | Values for actual popover/dialog depth only |
| --glass-filter-*, --glass-blur-* | LEGACY_ONLY / deprecated for new UI | Existing page veil, music surface or narrative scene only |
| --glass-radius-* | COMPAT_ALIAS | Old radius names remain mapped to old radius values |
| .glass-card, IbGlassCard, IbColors.Glass | LEGACY_SUPPORTED, deprecated for new UI | Keep existing consumers; do not use as the new Surface primitive |
| --surface-object*, --surface-chat-bubble-* | MODULE_PRIVATE | Image Router object / conversation bubble semantics only |
| --surface-hover / --surface-pressed | COMPAT_ALIAS | Interactive / selected fill values |
| --surface-input | COMPAT_ALIAS | Input background value |
| --surface-panel / --surface-card | LEGACY_SUPPORTED, deprecated for new UI | Existing panels and generic cards; not the canonical Surface role |
| --surface-overlay-scrim / --surface-dialog-scrim | COMPAT_ALIAS | Overlay and dialog scrim values; the old overlay filter is separate legacy behavior |
| --content-* / --status-* | LEGACY_SUPPORTED value sources | Existing theme colors remain; new consumers use their ib-token role |
| --accent / --accent-light | LEGACY_SUPPORTED value sources | Brand/interaction source values; new roles separate their meanings |
| --radius-control / --radius-card / --radius-panel | LEGACY_SUPPORTED, deprecated for new UI where out of v1 range | Existing consumer geometry stays unchanged |
| --fs-body / --fs-meta | LEGACY_SUPPORTED, deprecated for new UI | Existing page sizes stay until family migration |
| --space-* | CANONICAL base scale | Existing 4–32 px spacing values remain the source |
| --layer-nav / --layer-floating-panel | LEGACY_SUPPORTED value sources | Existing shell stacks; new semantic layer slots do not change them |

The Core CSS glass names stay intact. This policy does not remove, reskin or bulk-migrate existing pages. The P36-VL-D1 canonical Web and Android API is role-based.

## 8. Typography mapping

Canonical Web shorthand tokens are font: var(--ib-token-text-*) roles. Android aliases point to the equivalent TextStyle roles in IbType. Platform sizes may differ.

Current Web values --fs-body:.86rem (13.76 px) and --fs-meta:.74rem (11.84 px) remain legacy-supported for current pages. New body and meta roles are 14 px and 12 px. This bridge does not resize any current page.

text-technical / IbSemanticTokens.Type.technical is for L3 only. Fira Code / monospace does not promote technical content into an ordinary first screen.

## 9. Spacing and density mapping

Web --ib-token-space-* and Android IbSemanticTokens.Space.* map to the same 4 px/dp scale: 4, 8, 12, 16, 20, 24, 32.

Density presets select gaps from that scale:

| Preset | Section | Group | Control |
|---|---:|---:|---:|
| Relaxed | 32 | 24 | 12 |
| Standard | 24 | 16 | 8 |
| Dense | 16 | 12 | 8 |

The preset changes gaps and arrangement only. Body/meta sizes, focus, touch targets and line-height do not shrink. Existing Android huge=40dp, block=28dp, heading=10dp, card padding and screen gutter remain legacy/component-scoped inputs; they do not expand the shared base scale.

## 10. State mapping

All 14 Visual Language states map to a small palette. They do not get independent colors:

| State | Color role | Additional meaning |
|---|---|---|
| idle | status-neutral | stable, no movement |
| active | accent / selection | current user-selected object |
| loading | status-info | only while an operation is waiting |
| thinking | status-info | attached to the agent/task |
| typing | status-info | attached to the role/conversation |
| running | status-info | show current step or real progress |
| syncing | status-info | name the object being synchronized |
| connected | status-success | confirmed availability |
| degraded | status-warning | say what remains usable |
| offline | status-warning or status-danger by impact | show effect and recovery |
| warning | status-warning | task may continue |
| error | status-danger | human explanation + recovery first |
| success | status-success | short or attached to the changed object |
| disabled | status-neutral | explain prerequisites; no opacity-only state |

Text / icon / location carries the state meaning. status-neutral aliases content-muted; it adds no new hue.

## 11. Motion mapping

Canonical time tiers are 160 / 200 / 280 ms, with a 350 ms hard maximum. Web standard easing maps to the existing --transition; Android maps to FastOutSlowInEasing. Linear easing is only for data interpolation.

Existing --motion-fast and --motion-normal stay unchanged. Existing 0.9–4 second fades, background crossfades and loops are not semantic aliases. They are classified as legacy / narrative / deprecated-for-new-UI; D1 does not delete them.

Reduced motion remains governed by existing Web prefers-reduced-motion rules and Android accessibility/platform settings. No D1 token creates a repeating animation.

## 12. Radius and elevation mapping

Web --ib-token-radius-control is 8px; the current --radius-control:10px remains supported for old controls but is deprecated for new UI. Android Radius.control is 8dp; current IbShapes.control:12dp remains for old components.

Radius roles:

- compact 4
- control 8
- surface 12
- dialog 16
- round 50% only for circular or short pill objects

Elevation roles:

- ordinary content: none
- popover: floating shadow only while it is a real temporary layer
- dialog: modal shadow only while it blocks the surrounding page

Current --shadow-card, IbGlassCard and old 28dp Android sheet geometry are supported legacy values; they are not new elevation defaults.

## 13. Focus

Focus is a dedicated token family. It is not supplied by border, elevation or accent fill.

Web aliases: --ib-token-focus-ring, --ib-token-focus-ring-width:2px, --ib-token-focus-ring-offset:2px. Android maps them to IbSemanticTokens.Focus with 2dp width and offset. Focus colors meet at least 3:1 against each platform's canvas. Existing :focus-visible and platform accessibility behavior remain unchanged in D1.

## 14. Layering

New Web same-document layers use semantic order slots: content 0, page veil 1, navigation 100, popover 300, overlay 400, dialog 500, toast 600. Android values apply only within a Compose window; Popup, Dialog and Sheet windows remain owned by the platform.

Existing numeric z-indexes remain untouched. Current sources include nav 100, the old floating panel 9981, common modal layers 200/500, Toast 600, credential/error overlays 10050, and splash/preloader layers 9999–100000. These are compatibility stacks, not a reason to normalize all stacking contexts in D1.

## 15. Legacy classification

| Classification | Rule |
|---|---|
| CANONICAL | New consumers may use the semantic role. The --ib-token-* / IbSemanticTokens API is canonical. |
| COMPAT_ALIAS | A semantic role deliberately sources an existing value with equivalent meaning; the alias is one-way. |
| LEGACY_SUPPORTED | Existing pages may continue using it; no page rewrite is required. |
| LEGACY_ONLY | Historical/narrative visual with no honest default semantic equivalent. |
| DEPRECATED_FOR_NEW_UI | Do not add consumers; remove only during the owning family migration. |
| MODULE_PRIVATE | Represents real local content such as bubbles or an editable Image Router object; do not globalize it. |
| RAW_VALUE_DEBT | Unmapped value in an existing module; retain until its family migration establishes semantics. |

Classification summary:

- CANONICAL: --ib-token-*, IbSemanticTokens.*.
- COMPAT_ALIAS: bridge properties that point to existing core values, plus old alias names such as --glass-bg.
- LEGACY_SUPPORTED: existing --content-*, --surface-*, --glass-*, --radius-*, --shadow-*, --motion-*, --layer-*, Android legacy objects and current consumers.
- LEGACY_ONLY / DEPRECATED_FOR_NEW_UI: ambient glass as a universal fill, blur tiers as default style, soft card shadow, generic .glass-card creation, old body/meta sizes for new code.
- MODULE_PRIVATE: --surface-object*, --surface-chat-bubble-*, Android bubble roles and scene-only ambient colors.
- LEGACY_SUPPORTED: Android GlowIndigo / GlowViolet remain historic pairing atmosphere. IbTheme still assigns GlowViolet to Material tertiary; new semantic consumers must not treat that role as a product accent.
- RAW_VALUE_DEBT: direct values in shared/module CSS or JS, including current Diagnostics typography, voice waveform styling and narrative world/media layers.

## 16. Raw value audit

The scan covered core.css, navigation-shell.css, shared form/button styles in api-components.css, dialogs / Toast / widgets, Diagnostics and Voice, plus Android theme and common Compose components.

Findings and disposition:

- core.css raw colors mostly define the two themes, historic glass material and narrative layers. Theme palette values remain where semantic aliases reference them.
- Navigation has real geometry values and two stable layer tokens; its current media behavior is not changed.
- Shared controls combine token consumers with local px values. Tokenize during their owning family migration, not by search/replace.
- Widgets include music, page veil, global Toast, and the World canvas. World-canvas gradients/noise and audio waveform values belong to scene/media contexts; they are not color or elevation roles.
- Diagnostics contains local font sizes and status boundary values. Those remain RAW_VALUE_DEBT for the Diagnostics family.
- Voice-call contains active waveform/presence timing, local radius, glow and z-index values. D1 does not change live runtime feedback.
- Android theme values are centralized, while common components still contain a few direct dimensions and animations. No Android UI component is rewritten here.

Raw-value counts are not a D1 success metric. Semantic fit and compatibility are the measures.

## 17. New-code rules

1. Start from the task and information layer, then choose a semantic role. Do not start from a glass rung, color hex, radius or shadow.
2. New Web UI consumes --ib-token-*; it does not consume --glass-* or --surface-card as a default recipe.
3. New Android UI consumes IbSemanticTokens.*; it does not select IbColors.Glass as a default container.
4. Ordinary Section is transparent. Use surface-interactive/selected only for real controls/selection.
5. Compose elevation from independent fill, boundary and elevation roles; no automatic border+shadow+fill bundle.
6. Use status hue as secondary evidence and copy the same role with words/icons.
7. Technical typography remains L3. Theme changes values only.
8. Use density presets for gaps; never reduce font size or hit area to reach dense layout.
9. A semantic value with no safe legacy source must be defined in the theme block and noted in the mapping table. Do not fake an alias to an unrelated material.

## 18. Migration boundaries

D1 adds semantic definitions and authority links only. It does not replace old names or consumers.

Explicitly deferred:

- D2: build primitives that consume these roles, including transparent Section, Interactive row, input, status, Error disclosure, Popover and Dialog.
- D3: implement Home as the first reference page and verify both themes/responsive behavior.
- Family Migration: update Home, Chat, Personal Space, System / Settings, Middle Brain, Memory, Voice, Economy / Packaging, then Web / Android mobile families.
- Long-tail: raw CSS/JS values, historic glass, old motion, module-private values and old radius/font aliases.

No bulk rename, search/replace, page restructuring or CSS cleanup is authorized by this contract.

## 19. Acceptance criteria

### Semantic

- Each role states one meaning and is not named after its material.
- Canvas, content, accent, boundary, surface, input, state, focus, radius, elevation, motion, spacing/density, typography and layer roles are present.
- Internal and Infernal use the same names and roles; only values change.
- Web and Android map every role in §4.

### Compatibility

- Legacy Web and Android names remain defined.
- New Web aliases resolve to existing theme values or an explicit new semantic value.
- The dependency graph is one-way and has no undefined alias targets or cycles.
- Existing consumers are unchanged; no large visual change occurs.

### Surface / depth

- Ordinary Section maps to transparent fill.
- Glass is not the new default Surface authority.
- Glass blur is not a normal new motion/surface role.
- L1 / L2 / L3 meaning is unchanged; technical type is L3 only.

### Typography / state / motion

- New body/meta styles meet 14px / 12px Web floors; current page values remain legacy until migration.
- State colors reuse five roles and never create per-module palettes.
- Motion tiers are 160 / 200 / 280 ms and never exceed 350 ms.
- Reduced motion and focus behavior remain present.

### Platform

- Android aliases are usable without changing old component consumers.
- Dp/sp and CSS px may differ while semantic meaning stays equal.
- Desktop/mobile layouts remain presentations of the same navigation and state information architecture.

## 20. Verification record

### Android compile

- Runtime: Eclipse Temurin JDK 17.0.20.1+1, user-local ZIP install; official SHA-256 verified. JAVA_HOME and PATH were set only in the test PowerShell process.
- Project toolchain: Gradle wrapper 8.10.2, AGP 8.7.3, Kotlin 2.0.21, compile SDK 35, JVM target 17.
- Task: gradlew.bat :app:compileDebugKotlin --no-daemon
- Result: PASS, BUILD SUCCESSFUL. The first run compiled the facade; after the baseline comparison the facade was restored and the task passed again.
- IbSemanticTokens.kt was not edited during the compile gate. No semantic contract change was needed.

### Android unit tests

- Task: gradlew.bat :app:testDebugUnitTest --no-daemon
- With IbSemanticTokens.kt present: 178 tests, 6 failures in HomeNodeIntegrationTest.
- Baseline comparison with only the new facade temporarily moved out of the Android source tree: the same 178 tests and same 6 failures.
- Delta: 0. The failures are a05 send/readback, a05b history pagination, a06 requestId retry, a07 disconnect/resume, a08 change-log sync, and a10 offline cache startup. No test failure was introduced by the facade.

### Web and token checks

- tests/test_frontend_structure.js: before 2 failures; after 2 failures; delta 0. The existing failures are memory-authority.js BOM and Image Router credential-origin wording.
- scripts/ui-guardrail.js check: existing memory-authority.js BOM failure remains; CSS totals and inline counts match the pre-D1 baseline.
- Static alias graph: 83 semantic role names; 0 undefined CSS targets; 0 cycles; 0 missing Infernal overrides.
- Static Android source mapping: 0 unresolved legacy token symbols. The semantic facade still has no Compose component consumers.
- git diff --check: PASS for changed tracked files. No emulator, instrumentation test, or screenshot was required for this compile gate.

### Environment and production impact

The host initially had no Java/JAVA_HOME. Temurin JDK 17 was extracted under the user-local JDKs directory. No system environment variable, registry, Android SDK, Gradle wrapper, AGP, Kotlin version, project SDK setting or production component was changed. The semantic aliases remain unused; page-level visual impact is none.
