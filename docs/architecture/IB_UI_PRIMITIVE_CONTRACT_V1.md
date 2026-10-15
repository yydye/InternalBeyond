# IB UI Primitive Contract v1

- 状态：**FROZEN FOR D3 · D2-A/B/C 已接受 · D2-D 已封板**
- 版本日期：2026-10-03
适用范围：D2-A 冻结契约；D2-B / D2-C 实现记录见 §28 / §29；D2-D 验收与 D3 handoff 见 §30。

## 1. Purpose

本文件把 IB Visual Language v1 和 IB Visual Token Contract v1 落到共享 UI 原语的语义与行为契约。它先决定复用、收敛、语义化、新建、保留或延后，再决定未来的 Web class / helper 与 Android 等价概念。

D2-A 只冻结契约、盘点和施工边界。它不实现 Primitive，不迁移页面，也不把生产 Home 当测试场。

## 2. Authority

1. [IB Visual Language v1](IB_VISUAL_LANGUAGE_V1.md) 决定信息深度、Surface、State、Interaction、Motion、Responsive 和错误原则。
2. [IB Visual Token Contract v1](IB_VISUAL_TOKEN_CONTRACT_V1.md) 是颜色、间距、Typography、Surface、State、Focus、Elevation、Layer 的唯一 token 权威。
3. 本文件定义 Primitive 的语义、行为职责与复用决定。不得另行定义颜色、字号、半径、阴影或动效数值。
4. 生产页面和模块 CSS 是现状证据，不自动成为新 Primitive 的形状或行为标准。

## 3. Relationship to Visual Language

Primitive 首先是用户任务所需的语义与行为契约。Web class、JavaScript helper、Compose function 都只是各平台实现。

某段内容能删除而不丢失结构、对象边界、状态或交互意义时，它不是共享 Primitive。只为“让内容有个框”而存在的 Card / Panel 不属于 Primitive。

全局规则：

- Default Surface is transparent.
- Section 表达内容分组，不默认带背景、描边或阴影。
- Surface 表达真实对象、选择或临时空间边界。
- L1 是默认；L2 / L3 通过明确用户动作进入。
- Technical 字段不会因为被包进 Primitive 就变成 L1。
- State 用文字/图标/位置说明；颜色只是补充。
- Motion 只表达真实状态或结构变化。
- Desktop / Mobile 使用同一信息架构，布局可适配设备。

## 4. Relationship to Token Contract

- Web 实现消费 D1 的语义 token；不从旧 Glass ladder、页面私有 hex 或旧半径名开始选样式。
- Android 实现消费 D1 的 IbSemanticTokens 语义 facade；D2 不另造 palette、shape、status 或 motion source。
- Primitive 不定义 palette alias，不改 token value，不复制 Token Contract 表格。
- Token Contract 未覆盖的真实角色先记录为 contract gap，不能在 Primitive CSS 里临时加颜色或材质来绕过。

## 5. Primitive definition

当删除一个 Primitive 会使用户失去以下至少一种能力时，它才成立：

- 知道当前结构和内容归属。
- 识别一个独立对象或可选择对象。
- 理解状态和下一步。
- 通过键盘、触控或指针执行一个有清楚结果的操作。
- 在用户主动要求时深入查看高级/技术信息。

如果它只改变外观，它是 styling，不是 Primitive。

## 6. Shared contract envelope

每个 Primitive 的实现说明必须固定写出：

1. Purpose / semantic role
2. Surface role
3. Information depth
4. Supported state subset
5. Interaction and dismissal
6. Motion roles
7. Accessibility semantics
8. Desktop / narrow / mobile behavior
9. Existing implementation(s)
10. Migration decision and owning D2 phase

Surface Role vocabulary is closed: **none**, **transparent**, **surface**, **interactive-surface**, **elevated**, **overlay**, **dialog**. A modal composition may combine overlay + dialog; it does not introduce a new role. Web names map through the D1 Surface/Input aliases, while each Primitive states when a role is justified.

“mixed-but-controlled” 只允许用于明确的组合 Primitive，例如 Error Disclosure；必须逐个子区标 L1/L2/L3。

## 7. Foundation controls

Button、Input、Select、Textarea、Checkbox 和 Toggle 是基础控件，不另起一套新的组件产品。

| Foundation control | Existing Web | Existing Android | D2-A decision |
|---|---|---|---|
| Button | Global .btn base and .btn-primary in core/blog.css; .btn-danger in core.css; contextual overrides across modules | IbPrimaryButton, IbSecondaryButton, IbTextAction; platform IconButton in top bar | **REUSE**. Keep as foundation control; define primary/secondary/text/destructive/busy/focus semantics in D2-B. Do not create a second .ib-button family. |
| Input / Textarea | Native elements styled by api-form-group and module-local wrappers; labels/help/errors are inconsistently grouped | IbTextField supports label, placeholder, hint and enabled; no common validation/error slot | **REUSE + SEMANTICIZE**. Keep platform controls; Form Group defines label/control/help/error around them. |
| Select | Native select and module-owned custom select patterns | Platform menu/select behavior, localized per screen | **REUSE** current controls; only create a shared visual adapter if D2-B finds repeated semantic needs. |
| Checkbox / Toggle | Native checkbox in form-check-row and module-specific active-switch / ib-switch styles | Compose Checkbox exists in Settings; no shared toggle facade | **REUSE** platform semantics. Define labels, checked/disabled state and target size; do not replace all switches with a custom primitive. |

Foundation control states are control-specific. Disabled, busy, focus and destructive are supported only where the action makes sense. A Button may be busy; a read-only Label does not inherit that state.

The Web .btn base currently lives in core/blog.css even though the class is used across the application. Its hover rule moves the control by one pixel; it has no shared busy/loading or icon-button contract, and the shared danger modifier is limited to color/border. Treat these as existing behavior, not a template for a second button system. Android IbPrimaryButton already has an explicit busy state and a 52 dp minimum height.

Frozen foundation-control mapping:

- **Button:** primary = accent-action-fill + accent-action-content; secondary = transparent/interactive surface; text action = no fill/boundary; destructive = status-danger label and consequence. Depth is L1 unless explicitly placed inside L2/L3 disclosure.
- **Input / Select / Textarea:** consume Input token roles; depth follows the field’s task. Technical field content stays behind explicit L2/L3 entry.
- **Checkbox / Toggle:** checked/unchecked is a control state, not a status badge. Label is associated with the native control and remains operable without hover.
- **Icon button:** use only when the action is conventional and has an accessible name; it is not a new visual family.

All controls receive idle, focus, pressed and disabled contracts. Busy/loading exists only for an executing action that can be waited on. Web keyboard target and Android 48 dp target are part of the Foundation contract.

## 8. Primitive inventory matrix

Decision terms:

- **REUSE**: existing behavior/authority is adequate; use it as the basis.
- **SEMANTICIZE**: retain existing implementation but map it to a clear semantic role.
- **CONVERGE**: multiple implementations share one contract; future implementation can compose/adapt existing hosts.
- **NEW**: a semantic capability is missing and D2 must add it.
- **LEGACY**: keep current consumers; forbid it as the new default.
- **DEFER**: wait for the owning D2 subphase or family migration.

| Primitive | Existing Web | Existing JS behavior | Android equivalent | Decision | D2 phase |
|---|---|---|---|---|---|
| App Shell | navigation-shell.css; #app workspace; current top cornice / narrow left rail | navigation-shell.js presentation; core.js navTo owns route dispatch | IbRoot + NavModel / BackStack | **REUSE** shell and route owners; contract optional Inspector separately | D2-B contract only; no route/nav rewrite |
| Page Header | .module-intro pageChrome, Chat header, Workspace presence header | route-specific render/visibility | IbTopBar | **CONVERGE** context/title/action responsibilities; keep narrative/presence content separate | D2-B |
| Section | native section elements, .api-section, .plate, many glass-card wrappers | mostly page/module DOM ownership | Compose Column and IbGlassPanel | **NEW** transparent semantic Section contract; no card-lite wrapper | D2-B |
| Divider | hairlines, .module-intro-rule, borders and local separators | static CSS / module render | IbPanelDivider | **SEMANTICIZE** as a content relationship separator | D2-B |
| List Row | Home recent, Diagnostics rows, packaging history, memory and settings rows | local render/selection | IbFactRow and screen-local rows | **CONVERGE** read-only and interactive rows stay distinct | D2-B |
| Interactive Row | nav links, .friend-item, home quick links, selectable rows | navTo, per-row click handlers, local selection | Modifier.clickable in screens | **CONVERGE** selection/click behavior without wrapping every row in a card | D2-B |
| Form Group | .api-form-group and many local label/control/hint patterns | validation and disclosure are often page-owned | IbTextField | **SEMANTICIZE** label + control + help/error contract | D2-B |
| Inline Status | text, dots, badges, chips, Home status items, Diagnostics status | module-owned update / live-region behavior | IbConnectionBadge, IbMark | **SEMANTICIZE** existing status language; badge is optional presentation | D2-B |
| Error Disclosure | IBERR error model / card, Diagnostics technical details | IBERR.show, detailsText, recovery action, retry callback | ErrorPresenter + IbErrorCard + IbDisclosure | **REUSE** error model; converge the disclosure behavior and accessibility | D2-C |
| Popover | nav-more-panel, custom select/calendar menus, anchored widgets | nav-more closes on outside click and Escape; focus returns on Escape | no shared Popover; platform dropdown/sheet behavior is local | **CONVERGE** anchored, short, non-blocking content | D2-C |
| Dialog | .modal, group-dialog overlays, Memory/Credential/Voice overlays, native Packaging dialog | independent open/close, Escape, outside-click and focus behavior | IbDialog wraps Compose Dialog; IbSheet wraps ModalBottomSheet | **CONVERGE** semantics and behavior; preserve platform hosts | D2-C |
| Toast | global .toast / toast(m) | fixed timeout, text only | no shared Android Toast authority | **REUSE** for short successful confirmation only; failure-toast debt stays legacy | D2-C |

### 8.1 Duplicate pattern findings

| Pattern family | Existing variants | D2-A finding |
|---|---|---|
| Section / page opening | .module-intro, .api-section, .plate, .glass-card, Android IbGlassPanel | These patterns currently mix page context, semantic grouping and material. Page Header, Section and object Surface must remain separate contracts. |
| Rows | Home recent, chat friend, member manager, Memory, Economy, Packaging history, Diagnostics; Android IbFactRow | Similar spacing does not make a row interactive. Freeze separate read-only and whole-row-action contracts. |
| Status | text, dots, badges, chips, Home status cells, Diagnostics rows, Android IbConnectionBadge / IbMark | Most are presentations of the same few states; persistent pill styling is not their shared meaning. |
| Overlays | custom .modal, group-dialog overlays, Memory/Credential/Voice overlays, native Packaging dialog, Android Dialog/Sheet | Some share content arrangement but not lifecycle/focus/dismissal behavior. Converge those behaviors while retaining specialized hosts. |
| Errors | IBERR, Diagnostics details, inline validation, retry rows, legacy Toast calls; Android ErrorPresenter/IbErrorCard | IBERR is the Web model authority; the other versions are presentation or recovery contexts. Failure Toast is legacy debt, not a second error primitive. |

## 9. App Shell

**Purpose:** establish navigation, main workspace and an optional Inspector. It provides a stable place for page content without owning Home, Welcome, dashboard status or technical settings.

**Surface:** navigation/elevated roles only where the Token Contract allows; main workspace has no shell-created content surface. Overlay host is an implementation boundary, not page decoration.

**Depth:** L1 navigation labels and availability. Route contents retain their own L1/L2/L3 rules.

**States:** active route, collapsed/expanded navigation, open/closed contextual menu, optional busy navigation if a route truly loads.

**Interaction:** routes use the existing route dispatcher. Keyboard focus remains visible; menu Escape closes and restores focus. Mobile uses a device-appropriate presentation of the same route hierarchy.

**Existing / decision:** navigation-shell.css and navigation-shell.js own shell geometry/state; core.js navTo owns routing. Android IbRoot/NavModel owns its own navigation stack. **REUSE** these owners. The current desktop/narrow composition is not v1 final; D2-A does not change it.

## 10. Page Header

**Purpose:** answer where the user is, identify the page task, show only a necessary page-level action and L1 state.

**Surface:** transparent by default; no card, hero, or mandatory divider.

**Depth:** L1. L2/L3 controls belong in explicit disclosures or settings areas.

**States:** idle/active route; loading/error only when it affects the page task.

**Interaction / motion:** page actions use Foundation Button; no header-specific hover/animation. On small screens, title and actions wrap or move to a contextual menu.

**Existing / decision:** .module-intro is a transparent hairline pageChrome with title, caps subtitle and often a long description. Chat uses a contextual work header; Workspace uses presence branding; Android IbTopBar is compact and content-first. **CONVERGE** their responsibilities; retain each content owner. D2-B does not rename or replace markup.

## 11. Section

**Purpose:** group content that belongs to the same task or object.

**Surface:** transparent; no border or shadow. A semantic object boundary may contain one Surface, but Section itself is not that Surface.

**Depth:** inherits contained content. It cannot elevate L3 to L1.

**States / interaction / motion:** none by default. If the section itself collapses, that is an Interactive Row / disclosure behavior with explicit expanded state.

**Responsive / accessibility:** native section / heading relationships; stack content without changing semantics.

**Existing / decision:** HTML has native section elements but no common transparent Section API; .glass-card and .api-section are frequently used as grouping shorthand. Android has Columns and IbGlassPanel. **NEW** semantic Section is required in D2-B; implementation must default to transparent and should not mimic a card.

## 12. Divider

**Purpose:** show a real boundary when spacing and alignment alone do not adequately separate adjacent groups.

**Surface:** none; a one-pixel hairline is the maximum normal treatment. No background panel or shadow.

**Depth / state / interaction:** none.

**Responsive / accessibility:** decorative dividers are hidden from screen-reader semantics; meaningful separators use semantic list/group structure as well as a line.

**Existing / decision:** Web uses borders, .module-intro-rule and local rules; Android has IbPanelDivider. **SEMANTICIZE** the existing hairline role in D2-B; preserve module-private chart/grid lines.

## 13. List Row

**Purpose:** present one item in a related collection.

**Surface:** transparent by default; use spacing and a separator. A read-only row does not get hover/pressed states. A row that opens or selects an item is an Interactive Row.

**Depth:** inherits item content; row metadata cannot promote Technical to L1.

**States:** idle, active/selected when the collection has a current item, disabled only with reason.

**Accessibility / responsive:** list semantics and clear labels; row content wraps; mobile target is at least 44 CSS px / 48 dp when the row is actionable.

**Existing / decision:** recent, Diagnostics, Packaging, Memory, chat and settings implement different row classes; Android IbFactRow is read-only. **CONVERGE** the content rhythm and separation contract in D2-B, not the data or module markup.

## 14. Interactive Row

**Purpose:** make the whole row open, select or execute one clear action.

**Surface:** transparent at rest; surface-interactive for hover/pressed feedback, surface-selected for persistent selection. No card styling by default.

**Depth:** L1 action and user-facing description; L2/L3 only when the target explicitly enters that context.

**States:** idle, hover, focus, pressed, selected, disabled, optionally busy when the row starts an asynchronous task.

**Interaction:** anchor for navigation, button for action. Enter/Space match the semantic element. Disabled preserves readable explanation. Critical actions are not hidden in hover.

**Responsive / motion:** full-width and touch-first; micro/state motion only.

**Existing / decision:** .nav-links, .friend-item, Home links and module pickers duplicate parts of this pattern; Android screens use Modifier.clickable locally. **CONVERGE** the contract in D2-B. Do not turn read-only rows into buttons.

## 15. Form Group

**Purpose:** associate a field with its label, optional concise help, validation and error state.

**Surface:** transparent. No one-field-per-card behavior.

**Depth:** L1 for common inputs; L2 for user-selected advanced behavior; L3 fields only in explicit technical context.

**States:** idle, focus, disabled, warning/error, success only when confirming field validation adds useful information.

**Accessibility:** programmatic label association, description/error linkage, visible focus, keyboard operation, touch target, and color-independent error copy. Placeholder is not the label.

**Existing / decision:** .api-form-group provides label and input styling, but hint/error grouping varies across modules. Android IbTextField has label/placeholder/hint/enabled but no common validation slot. **SEMANTICIZE** these existing controls in D2-B; no new input runtime.

## 16. Inline Status

**Purpose:** explain an object's current availability or activity beside that object.

**Surface:** none by default. Plain text is the default rendering; icon + text is used when scanning benefits. A pill/badge is reserved for persistent compact states requiring at-a-glance recognition.

**Depth:** L1. No provider id, endpoint, request id or raw runtime. Technical details belong in an Error Disclosure or an explicit L3 view.

**States:** only semantically applicable statuses: loading, running, syncing, connected, degraded, offline, warning, error, success, disabled. No 14-color map.

**Accessibility / motion:** status word and accessible announcement; color is supplementary. Animate only real state change and respect reduced motion.

**Existing / decision:** Home status, Diagnostics rows, MB save status, badges and dots each render status differently; Android IbConnectionBadge/IbMark cover connection and small marks. **SEMANTICIZE** these forms in D2-B; do not make every state a chip.

## 17. Error Disclosure

**Purpose:** present a failure in the order a person needs it: explanation, recovery, then optional technical evidence.

**Surface:** inherits the host surface; technical block is a subdued nested disclosure, not a card inside a card.

**Depth:** mixed-but-controlled: title/message/action are L1; technicalDetails is L3 and collapsed. User action is required to reveal L3.

**States:** error, retrying/loading when actually running, success/recovered when recovery completes. Technical details preserve redaction rules.

**Interaction / accessibility:** disclosure exposes expanded/collapsed state to assistive technology; recovery actions have accessible names; retry is offered only when supported.

**Existing / decision:** IBERR already provides title, message, suggestion, action, retryability, redacted details and a fixed presentation builder. Diagnostics has a separate technical details toggle; Android ErrorPresenter / IbErrorCard / IbDisclosure already serve the same error meaning. **REUSE** IBERR as Web error model and converge presentation semantics in D2-C; do not build a second error catalog. Current gaps include IBERR details toggle lacking explicit aria-expanded/aria-controls and differing timeout/focus behavior.

## 18. Popover

**Purpose:** show short, anchored, non-blocking context for the triggering object.

**Surface:** elevated/popover role only while open.

**Depth:** normally L1/L2 content appropriate to the trigger. It must not become a way to put L3 metadata on an ordinary first screen.

**States / interaction:** closed/open; Escape closes and returns focus; outside click closes; keyboard can reach every item. Menu roles are used only when the content is actually a menu.

**Responsive / motion:** small contextual content; mobile may present the same context in a sheet, preserving the same semantics; structural motion only.

**Existing / decision:** nav-more-panel implements outside click, Escape and focus return; calendar selects/widgets and other local menus have separate behavior. Android has platform dropdowns/sheets but no shared Popover. **CONVERGE** behavior in D2-C without changing navigation or Calendar in D2-A.

## 19. Dialog

**Purpose:** block the surrounding task for one short decision, confirmation or required modal step.

**Surface:** overlay + dialog; independent scrim, fill, boundary and elevation tokens. One question, one primary action and one cancel/exit path.

**Depth:** L1 decision by default. L3 details remain behind Error Disclosure.

**States / interaction:** closed/open/busy/error as needed. Set initial focus, contain/restore focus, keep keyboard operation, define Escape and outside-click behavior. Escape/backdrop may dismiss only when it cannot silently discard input or approve a destructive action. Destructive consequence is explicit.

**Responsive / motion:** width fits viewport; long tasks move to a page/sheet. Structural motion only.

**Existing / decision:** Web has .modal, group-dialog overlays, Memory, Credential, Voice, API editor and native Packaging dialog. JS lifecycle is distributed; local-vault restores focus, API onboarding sets initial focus, some dialogs use only class toggles; native dialog delegates behavior to the browser. Android IbDialog wraps Compose Dialog and IbSheet wraps ModalBottomSheet. **CONVERGE** contracts and preserve hosts in D2-C; do not replace the modal system in D2-A.

## 20. Toast

**Purpose:** confirm a completed, noncritical action briefly, for example saved/copied/added.

**Surface:** elevated/floating while visible.

**Depth / state:** L1 success only. Never the only error, recovery instruction, long-running status or durable result.

**Accessibility / responsive:** announce as a polite status; remain readable, avoid covering controls/keyboard, and do not require hover.

**Existing / decision:** global toast(m) creates text-only .toast nodes and removes them after 2.8 seconds. It has no role/live-region contract and is also used for validation and failures. **REUSE** the implementation only for short confirmations; classify failure-toast callers as LEGACY_SUPPORTED until family migration. D2-C owns the status contract; D2-A does not rewrite callers.

## 21. Accessibility contract

Every interactive Primitive must provide:

- Correct native element or equivalent role and accessible name.
- Visible keyboard focus using D1 focus tokens; minimum touch target 44 CSS px / 48 dp.
- Keyboard behavior consistent with button, link, disclosure, menu or dialog semantics.
- State conveyed without color alone.
- Live announcement only for actual status changes, with polite/assertive level matching urgency.
- Expandable controls expose expanded state and controlled content.
- Modals have labelled dialog semantics, initial focus, focus containment/return and defined dismissal.
- Disabled states retain readable text and explain missing prerequisites when needed.
- Reduced-motion behavior preserves status and completion information.

## 22. Responsive contract

Desktop, narrow desktop, mobile Web and Android may use different presentation, not different information architecture.

- App Shell keeps the same route hierarchy; current top cornice/left rail remain unmodified in D2-A.
- Page Header wraps/reorders title/actions without duplicate title content.
- Section, Divider and Form Group stack without gaining card backgrounds.
- List/Interactive Rows become full-width and touch-first; no hover-only actions.
- Inline Status wraps as text; badges do not force horizontal scrolling.
- Popover may become a sheet on mobile with the same trigger, content and dismissal meaning.
- Dialog stays one short decision; long tasks use page/sheet.
- Error details remain collapsed and scrollable on narrow viewports.

## 23. Motion contract

Primitives consume only D1 roles: micro, state, structural, standard easing and linear data easing. Hard maximum is 350 ms; reduced motion is honored.

No primitive owns a bespoke duration, spring, bounce or infinite decorative pulse. Thinking/presence activity may animate while the real state is active, then stops. Existing 680/900 ms loops and page transitions remain legacy evidence for later family migration.

## 24. Legacy mapping

| Existing implementation | D2-A classification | Future handling |
|---|---|---|
| .glass-card / Android IbGlassCard | LEGACY_SUPPORTED + DEPRECATED_FOR_NEW_UI | Keep consumers; new Section/Row stays transparent |
| .module-intro | LEGACY_SUPPORTED; pageChrome | SEMANTICIZE as one Page Header variant; no page markup change now |
| .modal / group-dialog overlays | LEGACY_SUPPORTED | CONVERGE lifecycle contract in D2-C; do not bulk-replace |
| Credential / Memory / Voice overlays | MODULE_PRIVATE or LEGACY_SUPPORTED by task | Keep specialized state/content; share behavior contract only |
| native Packaging dialog | LEGACY_SUPPORTED | Preserve native Dialog behavior |
| global toast(m) | LEGACY_SUPPORTED | Success confirmation only for new consumers; failure callers deferred |
| .btn / IbPrimaryButton / IbSecondaryButton / IbTextAction | FOUNDATION | Reuse; no second button system |
| native Web fields / IbTextField | FOUNDATION | Reuse; Form Group owns composition and validation contract |
| IBERR model | CANONICAL error model | Reuse as sole Web error authority |
| Android ErrorPresenter | CANONICAL Android error mapping | Keep aligned with IBERR depth and recovery order |
| Module-specific status chips | MODULE_PRIVATE or RAW_VALUE_DEBT | Map during the family migration; do not globalize merely by appearance |

## 25. Implementation boundaries

D2-A adds no production class, function, component runtime, HTML markup or Android consumer. It freezes the semantic/behavior contract and inventory only.

No Home playground, no Sidebar or route change, no Chat/Memory/API/Middle Brain rewrite, no modal replacement, no Toast rewrite, and no page CSS search/replace.

A genuine contract hole must be reported with its evidence and left unresolved here unless D1 token meaning itself is insufficient. Do not redesign tokens within D2-A.

## 26. D2-B / D2-C split

### D2-B · Structural Primitives

1. App Shell capability boundary (keep current navigation/route owners).
2. Page Header contract and compatibility mapping from module-intro / chat / workspace headers.
3. Transparent Section and Divider.
4. Read-only List Row and Interactive Row split.
5. Form Group using existing buttons and native input controls.
6. Inline Status semanticization.
7. Foundation Control mapping for Button / Input / Select / Checkbox / Toggle.

This order first establishes content grouping and row/control semantics; overlay lifecycle remains outside the structural layer.

### D2-C · Feedback / Overlay Primitives

1. Error Disclosure rendering over the existing IBERR model.
2. Popover dismissal, focus return and responsive sheet mapping.
3. Dialog lifecycle and focus/dismissal behavior over existing platform hosts.
4. Toast success-only semantics and accessibility.
5. Overlay z-order/state mapping.

D2-A sections freeze scope only. D2-B / D2-C implementation evidence is recorded in §28 / §29 without changing the normative contract. D2-D closes acceptance and freezes the contract in §30; page and feature implementation remain excluded.

## 27. Acceptance criteria and verification

D2-A is accepted when:

- Every candidate and Foundation Control has a documented decision, owning phase and existing implementation evidence.
- Each contract states semantic role, Surface, depth, applicable states, interaction, motion, accessibility and responsive behavior.
- Section is transparent by default; glass is not promoted into the new shared primitive.
- IBERR remains the only Web error model; Error Disclosure maps human explanation/recovery to L1 and technicalDetails to collapsed L3.
- Dialog, Popover and Toast have distinct responsibilities and dismissal/announcement rules.
- Button and input controls are reused rather than duplicated.
- D2-B and D2-C scopes are bounded; D3 Home and all production migrations remain deferred.
- Authority chain is Visual Language → Token Contract → Primitive Contract, with no token/value redefinition here.

Verification for D2-A was documentation-only: source inventory and cross-reference review; git diff --check; local links and required decision rows. D2-B implementation verification is recorded in §28.

## 28. D2-B implementation record · Web only

**Phase result:** `D2-B COMPLETE — D2-C MAY PROCEED`. Structural primitives are implemented and verified as an opt-in Web authority. No production page or module consumer was migrated.

### 28.1 Implementation and test authorities

| Concern | Authority | Compatibility boundary |
|---|---|---|
| Structural primitive CSS | `assets/css/ui-primitives.css`, scoped by `.ib-primitives` | Uses D1 `--ib-token-*` roles; is not linked from `InternalBeyond.html` in D2-B. |
| Isolated composition fixture | `tests/fixtures/ui-primitives/index.html` | Loads the real core token source and primitive CSS; `?theme=infernal` selects the existing theme class. Contains no navigation or production route wiring. |
| Fixture host canvas | `tests/fixtures/ui-primitives/fixture.css` | Test-only body canvas using `--ib-token-canvas`; primitive surfaces remain transparent. |
| Structural and CSS policy gate | `tests/test_ui_primitives.js` | Node built-ins only; no DOM runtime, component framework or product JS helper. |

### 28.2 Implemented mapping

| Primitive | Web implementation | D2-B boundary |
|---|---|---|
| App Shell capability boundary | `.ib-app-shell__main` | Main-content sizing hook only. `navigation-shell.js`, `core.js` `navTo`, routes and mobile navigation remain the owners. |
| Page Header | `.ib-page-header` with context, title, supporting, actions and optional inline-status slots | Transparent structural header; no page state or module metadata. |
| Section | `.ib-section`, heading, description and body slots | Transparent fill token, no border or elevation; spacing and type express grouping. |
| Divider | `.ib-divider` | Decorative use is `aria-hidden`; meaningful separation uses separator semantics. Consumers choose it explicitly. |
| List Row | `.ib-list-row` and named content slots | Read-only, transparent, no hover or pressed behavior. |
| Interactive Row | `.ib-interactive-row` on native `<a>` / `<button>` | Hover, focus-visible, pressed, persistent `aria-current` / `aria-pressed` selection and native disabled button state. Minimum target is 44 CSS px. |
| Form Group | `.ib-form-group` with label/control/help/error slots | Native fields; label `for`/`id` and help/error `aria-describedby` links; visible error copy accompanies `aria-invalid`. |
| Inline Status | `.ib-inline-status[data-status]` and optional decorative marker | All ten frozen status values map to the four D1 status roles; readable text stays content-colored. Live-region semantics are supplied only by a dynamic consumer. |
| Foundation Controls | Existing `.btn`, `.btn-primary`, native input/select/textarea/checkbox | Scoped token semanticization; text/destructive/icon variants extend `.btn`; no `.ib-button` / `.ib-input` family. Native checkbox and switch semantics remain. |

### 28.3 Compatibility and deferred work

- Existing `.module-intro`, `.glass-card`, `.api-form-group`, module rows/status and shell markup are unchanged. D2-B does not reclassify or silently restyle their consumers.
- Existing `.btn` keeps its legacy behavior outside `.ib-primitives`. Inside the new scope, semantic tokens replace the legacy consumer path and the inherited one-pixel hover translation is suppressed.
- The fixture is a contract consumer, not a production page. Future families may adopt the authority in their own migration phase; D2-B adds no production link or markup.
- Android was checked against the existing `IbSemanticTokens` mapping only. No Compose primitive, page consumer, theme or production source was added.
- D2-C Error Disclosure, Popover, Dialog, Toast and overlay lifecycle remain deferred. D3 Home and all family migrations remain deferred.

### 28.4 Verification record

- `node tests/test_ui_primitives.js`: **38 checks passed**. This includes semantic-token resolution, transparent Section/List Row, selected and disabled Interactive Row, form associations, all status values, L1-only fixture content, foundation-control reuse and CSS guardrails.
- Primitive CSS policy counts: **raw hex 0; raw rgba 0; arbitrary shadow 0; arbitrary radius 0; arbitrary motion duration 0; glass consumer 0**.
- Browser fixture: Internal and Infernal themes; 1280 px desktop and 375 / 320 px narrow widths; no horizontal overflow; minimum interactive/control target 44 CSS px; keyboard Tab reaches native controls and link with visible focus; selected fill persists after pointer leaves; read-only row stays unchanged on hover; reduced-motion sets transitions to `none`.
- axe 4.12.1: **0 violations** in each theme. One color-contrast check for the page-context text is reported as incomplete by axe because its background composition cannot be inferred. Resolved foreground/canvas values were manually checked at **7.45:1 Internal** and **8.30:1 Infernal**; the sampled text point has no overlapping element.
- `node tests/test_frontend_structure.js`: before **2 failures**, after **the same 2**, delta **0**: `assets/js/memory-authority.js` BOM and `imageRouterSettings.statesCredentialOrigin` wording.
- `node scripts/ui-guardrail.js check`: before/after reports the same `memory-authority.js` BOM structure regression; CSS totals are unchanged (gradient 215, backdropFilter 109, bgRgba 32, bgHex 11, smallFont 12, bigRadius 18, important 59, rawHex 127, violet 0); inline styles remain static 190 / total 458. Delta **0**.
- `git diff --check`: **PASS**. Windows line-ending warnings belong to the pre-existing dirty files. The new CSS asset retains the repository-required UTF-8 BOM.

### 28.5 Production impact and remaining status

Page-level visual impact: **None.** `InternalBeyond.html`, production navigation, page CSS consumers and route authority were not changed by D2-B.

The structural authority intentionally has no production page consumer yet. That is the migration boundary, not a missing D2-B implementation. Home, family pages and Android consumers remain outside D2-B.

## 29. D2-C implementation record · Web only

**Phase result:** `D2-C COMPLETE — D2-D MAY PROCEED`. Error Disclosure, Toast, Popover and Dialog behavior now have a shared, testable Web authority. Existing business Dialog hosts and Toast callers were not bulk-migrated.

### 29.1 Implementation and test authorities

| Concern | Authority | Compatibility boundary |
|---|---|---|
| Error model and presentation | `assets/js/error-catalog.js` (`IBERR`) | IBERR remains the only Web error model and sanitizer; the change adds disclosure ARIA and promise-aware retry behavior. |
| Toast renderer | `assets/js/core.js` (`toast`, `toast.success`) | Existing `toast(message)` calls remain supported; new consumers use the explicit success entry point. |
| Native overlay lifecycle adapter | `assets/js/ui-overlay-lifecycle.js` | Opt-in adapter for native Popover/Dialog elements. It adds disclosure state, dialog focus policy and async submit state; it is not a component or event-bus framework. |
| Overlay semantic CSS | `assets/css/ui-overlay-primitives.css` | Loaded only by the feedback fixture; consumes D1 Popover, Dialog, Overlay, Elevation, Radius, Motion and Layer roles. |
| Toast layer / Dialog bridge | `assets/css/core/widgets.css` plus the Toast host in `assets/js/core.js` | Shared Toast host uses the D1 fixed Toast layer role; only an opt-in D2-C native Dialog temporarily owns the host. Existing outside-Dialog placement/timing remain compatible. |
| Behavior fixture | `tests/fixtures/feedback-overlays/index.html` and `fixture.js` | Loads the real IBERR, core Toast and lifecycle helper. It is a behavior lab, not a page or visual reference. |
| Test authority | `tests/test_ui_overlays.js` | Node built-ins plus a small DOM fake for IBERR / Toast behavior; real browser lifecycle is verified against the isolated fixture. |

### 29.2 Existing feedback and overlay inventory

| Existing implementation | Current behavior / owner | D2-C decision |
|---|---|---|
| `IBERR.show` / `error-catalog.js` | Sole model, copy, retryability and redaction authority; human copy and recovery lead; technical details use the existing `redact` / `redactUrl` allowlist. Details were hidden visually but lacked `aria-expanded` / `aria-controls`; promise retries had no busy state. | **REUSE + SEMANTICIZE** the existing view. L1 remains title/message/suggestion/action; L3 remains collapsed. No new model or sanitizer. |
| Diagnostics technical details | Separate page-owned `detailsOpen` state; button text changes, but it does not expose expanded/control relationships. | **LEGACY_SUPPORTED**; Diagnostics is not migrated in this phase. |
| Global Toast | `core.js` appends text-only `.toast` nodes to a four-item stack; CSS animates them out and removal occurs at 2.8 s. Existing callers mix success, validation, failure and progress. | **REUSE** renderer, add polite live semantics and a named `toast.success` path; do not rewrite callers. |
| Navigation Popover | `navigation-shell.js` owns one route menu, outside click, Escape and trigger focus restoration; it uses menu roles because it is a link menu. | **REUSE** untouched; D2-C does not change navigation. |
| Calendar / contextual controls | Calendar and local controls own their own short menus and date contexts. | **LEGACY_SUPPORTED**; no Calendar migration. |
| Dialog / modal hosts | Native Packaging `<dialog>`; custom group, Memory, Credential, API onboarding, local-vault, Middle Brain, Setup and Voice overlays; Calendar/bridge panels also use dialog-like semantics. Behavior ranges from native modal handling to local class toggles, with different focus and dismissal policies. | **CONVERGE** lifecycle requirements using native platform hosts in the fixture; preserve production DOM and owners. |

### 29.3 Existing Toast caller inventory

The pre-D2-C static inventory found **524 direct `toast()` call sites across 37 JS files**. The largest caller files are Social (76), Memory (59), Workspace files (51), Core (49), Communication (48), Voice (27), Active Diary (20), Site Operations (20), Calendar (17), Social Network (17) and Moments (16).

A lexical message scan flags 133 call expressions with failure/validation wording, 23 with progress wording, 75 with clear success wording and 293 with dynamic, mixed or ambiguous wording. These are wording buckets, not a semantic verdict: many calls are conditional expressions or receive a runtime message. All 524 sites remain legacy-compatible; none was rewritten.

Future destinations are: validation → Form Group error; operation failure → IBERR Error Disclosure; persistent degraded state → Inline Status; long-running work → the task surface/status; completed short success → `toast.success`. Failure-Toast calls remain migration debt.

### 29.4 Error Disclosure behavior

- `IBERR` remains the only Web model. L1 title, message, impact/suggestion and available recovery action remain before the technical region.
- Technical details still come from `IBERR.technicalDetails` / `detailsText` and the existing `redact` / `redactUrl` paths. No second secret filter was added.
- Details now start with `hidden`, `aria-expanded="false"` and an `aria-controls` target. Native button activation updates all three states; expanding does not move focus.
- Retry is still rendered only when `model.retryable` and `onRetry` both exist. Promise-returning retries set `aria-busy`, disable retry/close to prevent duplicates and remove the card only on success. A false/rejected retry restores the existing explanation and action. Synchronous legacy fire-and-forget callbacks remain compatible.
- The existing 30-second card expiry is unchanged. Focus entering the card now prevents timer removal underneath keyboard interaction.

### 29.5 Popover lifecycle

- New consumers use native `<button popovertarget>` with `<section popover="auto">`; the browser owns open state, re-toggle, outside pointer dismissal and topmost Escape dismissal.
- The helper synchronizes `aria-expanded` and assigns a CSS anchor relationship. Native Popover stays nonmodal; fixture content uses ordinary links/buttons and does not claim menu semantics.
- Native auto-popover nesting was browser-verified: Escape closes the inner Popover first and restores its trigger; the next Escape closes the outer Popover and restores its trigger. An outside pointer closes without stealing focus from the outside target.
- CSS anchor placement flips/clamps at the viewport edge. Mobile remains the same contextual surface; no Sheet migration is included.

### 29.6 Dialog, Toast and Overlay layers

- New Dialog consumers use native `<dialog>.showModal()`, which supplies modal Top Layer, background inertness and native scroll blocking. The helper chooses initial focus, prevents unsafe Escape/backdrop dismissal, blocks duplicate/busy submission and returns focus to the trigger; a fallback focus owner is used only if that trigger no longer exists.
- Real Chromium testing exposed a Tab escape from the final native Dialog control. The helper now wraps Tab and Shift+Tab at the focus boundaries; intermediate navigation remains native.
- Destructive confirmation focuses its title, ignores Escape/backdrop, and still provides an explicit cancel action. Busy submission disables its primary/cancel actions, blocks duplicate submits and prevents Escape dismissal until the result is known.
- Layer mapping uses the D1 roles: Popover 300, Dialog Overlay 400 (native `::backdrop` immediately below its Dialog), Dialog Surface 500 and Toast 600. Native Top Layer order remains platform-owned. New CSS contains no literal z-index escalation. The old IBERR inline host value and specialized legacy host stacks remain compatibility debt.
- Toast continues to use the existing 2.8-second compatibility value, not a new token. `toast.success` is the explicit new-consumer API; all Toasts use a polite live region and never take focus. Outside an opt-in Dialog, the host stays on the D1 fixed Toast layer. During an opt-in `.ib-primitives .ib-overlay-dialog`, the host is reparented inside that Dialog, remains pointer-transparent, uses the Toast layer role, and moves back to the page layer on close. One latest Toast is retained while an opt-in Dialog is active; at short heights the Dialog reserves space and scrolls internally so its controls are not covered, then keeps that layout stable until close. Legacy native/custom Dialog hosts are not migrated.
- No error, progress, persistent warning or validation Toast example was added. Existing such callers remain legacy debt.

### 29.7 Verification record

- `node tests/test_ui_overlays.js`: **39 checks passed**. It verifies D1 token use, zero raw color/Glass/radius/shadow/duration/z-index debt in the new CSS, IBERR redaction/disclosure/retry state, Toast live/timing/multiplicity/modal rehome, and Dialog lifecycle contracts.
- New overlay CSS deltas: raw hex **0**; raw rgba **0**; arbitrary radius **0**; arbitrary shadow **0**; arbitrary duration **0**; direct Glass consumer **0**; literal z-index escalation **0**. Layer declarations use D1 semantic slots.
- Browser fixture: Internal and Infernal themes; Popover nesting/Escape/outside/selection, dialog focus containment and restoration, safe/destructive dismissal, busy duplicate prevention, error details/retry, Toast over Dialog and timeout were exercised in Chromium.
- Responsive browser checks at 1280 / 375 / 320 px: no horizontal overflow. Popover remains in bounds. At 320 × 320, Toast and Dialog bounds do not overlap; dialog actions remain reachable by internal scroll. Reduced motion leaves open/close and state updates working with no transition dependency.
- axe 4.12.1: **0 violations** in both themes. One page-context contrast check is incomplete because axe cannot infer its composed background; the sampled point has no overlap and computed Internal/Infernal foreground-to-canvas ratios are 7.45:1 / 8.30:1. All fixture `popovertarget` / `data-ib-dialog-open` targets were structurally verified; axe no longer reports the prior hidden-target incompletes.
- `node tests/test_error_catalog.js`: baseline/after **124 passed**, delta **0**. `node tests/test_ui_primitives.js`: baseline/after **38 passed**, delta **0**.
- `node tests/test_frontend_structure.js`: before **2 failures**, after **the same 2**, delta **0**: `assets/js/memory-authority.js` BOM and `imageRouterSettings.statesCredentialOrigin` wording. New asset BOM checks pass.
- `node scripts/ui-guardrail.js check`: before/after the same `memory-authority.js` BOM regression; delta **0**. CSS totals remain gradient 215, backdropFilter 109, bgRgba 32, bgHex 11, smallFont 12, bigRadius 18, important 59, rawHex 127, violet 0; inline styles remain static 190 / total 458.
- `git diff --check`: **PASS**. Existing Windows line-ending warnings are from pre-existing dirty files.

### 29.8 Compatibility, production impact and deferred work

- `IBERR` presentation/behavior gained ARIA state and async retry feedback; Error model, copy, redaction, caller capabilities and card layout remain the same.
- Existing global Toast callers receive polite announcement and use the semantic Toast layer; their message meaning is not reclassified. The `toast.success` API is available for future consumers.
- `InternalBeyond.html`, route/nav owners, Home and all module pages were not modified. No existing `.modal`, group dialog, Credential, Memory, Voice, API, Diagnostics or Packaging host was migrated.
- Android was checked by concept mapping only: Error Disclosure → `ErrorPresenter` / `IbDisclosure`; Popover → platform menu / Sheet; Dialog → `IbDialog` / `IbSheet`; Toast → future platform equivalent. No Compose implementation was added.
- D2-D Acceptance & Freeze and the D3 handoff are recorded in §30. D3 Home, family migrations, legacy failure Toast callers, legacy modal hosts and Android implementation remain deferred.

## 30. D2-D Acceptance & Freeze · 2026-10-03

**Phase result:** `D2 COMPLETE — D3 HOME MAY PROCEED`.

Freeze means D3 pages prioritize these contracts. It does not prohibit a narrowly evidenced repair for a real contract hole, accessibility defect, cross-platform contradiction or proven semantic insufficiency; record the reason before changing the contract.

Frozen chain: **IB Visual Language v1 → IB Visual Token Contract v1 → this Primitive Contract → implementation → pages.** The Visual Language is frozen; the Token Contract remains the D1 semantic API and is frozen for D3; this contract is frozen for D3. Implementations and pages cannot redefine upstream meaning.

### 30.1 Authority and duplicate-authority audit

| Family | Frozen authority |
|---|---|
| Button | `.btn` remains the Foundation Control authority. `.ib-primitives .btn` only scopes semantic token behavior; it is not a second button family. |
| Input / Form | Native input/select/textarea/checkbox semantics own controls. Form Group owns label, help and validation composition. `.api-form-group` and module wrappers remain consumers, not foundation authorities. |
| Status | Inline Status is the shared meaning and state authority. Badge, pill, dot and module chip are optional presentation; they do not define separate status systems. |
| Error | `IBERR` is the sole Web error model. Error Disclosure owns shared presentation/lifecycle; Diagnostics is L3 context; field validation belongs to Form Group; failure Toast remains legacy debt. |
| Popover / Dialog / Overlay | Native Popover and Dialog APIs own platform open/close and top-layer behavior. `ui-overlay-lifecycle.js` adapts the shared lifecycle contract; host DOM may differ. There is no second overlay framework. |

### 30.2 Semantic token coverage

New D2 CSS consumes D1 `--ib-token-*` roles only. `none`, `inherited` and `host` below are intentional contract outcomes, not missing values. D1 roles whose theme value is sourced from legacy Glass are **compatibility aliases**; D2 styles reference the semantic role, not the Glass variable.

| Primitive | Color / state | Boundary | Radius | Motion | Focus | Elevation / layer |
|---|---|---|---|---|---|---|
| Page Header | content-primary / secondary | none | none | none | shared focus tokens on actions | page host |
| Section | content-primary / secondary | none | none | none | native child control contract | page host |
| Divider | none | boundary-subtle | none | none | none | none |
| List Row | content-primary / secondary | boundary-subtle separator | none | none | none for read-only rows | content layer |
| Interactive Row | content roles; surface-interactive / selected | boundary-subtle when disabled; accent-action for selected marker | radius-compact | motion-state + standard easing | focus-ring, width and offset | content layer |
| Form Group | content, input and status roles | input-boundary / focus; status-danger or warning for field state | radius-control on text/select fields; native checkbox geometry | none required | shared focus tokens | content layer |
| Inline Status | content-secondary plus status-neutral/info/success/warning/danger | none | radius-round only for its decorative marker; no default pill | no decorative motion | none | content layer |
| Foundation Controls | content, input, accent-action and applicable status roles | boundary/input roles | radius-control where the existing control supports it; native check/toggle geometry stays native | motion-state + standard easing on shared button states | focus-ring, width and offset | content layer |
| Error Disclosure | IBERR copy/redaction and existing host palette | existing host | existing host | existing host; no new timing | native actions and disclosure relationship | existing host |
| Popover | content-primary + `--ib-token-popover` | boundary-subtle | radius-control | native state update; no motion dependency | shared focus tokens; Escape returns focus | elevation-popover / layer-popover |
| Dialog | content roles + `--ib-token-dialog` / `--ib-token-overlay` | boundary-subtle | radius-dialog | native state update; no motion dependency | shared focus tokens; initial, contained and restored focus | elevation-dialog / layer-overlay + layer-dialog |
| Toast | existing shared Toast palette and surface remain compatibility presentation | existing shared Toast border | existing shared Toast radius | existing entrance/exit timing remains legacy behavior | never takes focus | layer-toast; opt-in Dialog rehome only |

`ui-primitives.css` and `ui-overlay-primitives.css` have zero raw hex, rgba, direct Glass, literal z-index, un-tokenized radius/shadow or arbitrary duration declarations. The shared legacy Error Disclosure and Toast skins are not newly restyled by D2: their host appearance/timing is compatibility behavior; new D2 CSS adds no Glass consumer. Toast lifetime remains the existing 2.8 seconds. New surface styling must use D1 semantic roles; the inherited Error/Toast skin remains family-migration debt rather than a new token authority.

Surface roles are frozen: Page Header transparent; Section transparent; Divider none; List Row transparent; Interactive Row transparent at rest and interactive only when needed; Form Group transparent; Inline Status none; Error Disclosure inherits host; Popover elevated; Dialog overlay + dialog; Toast elevated/floating. No Section, read-only row, Form Group or Inline Status becomes a card, hover target or default pill. Dialog and Popover are token-first, not Glass-first.

Information depth is unchanged. Default paths and fixtures show L1 explanations/actions only; endpoint, credential reference, provider/request/trace identifiers and raw runtime do not lead. Error technical details remain redacted L3 behind an explicit disclosure; `hidden` and `aria-expanded` / `aria-controls` are synchronized.

### 30.3 Interaction, accessibility and responsive acceptance

- Interactive Row uses native anchors/buttons and has idle, hover, focus-visible, pressed, selected and disabled states; actions are not hover-only. Foundation controls keep native semantics, associated labels, disabled/busy/destructive states and accessible names for icon actions. Inline Status and validation retain readable text so color is supplementary. Actionable rows, fields, switches and buttons meet the 44 CSS px touch target.
- Popover uses native `popover=auto`: outside interaction and Escape dismiss; nested Escape closes the topmost layer; focus returns to the trigger. Dialog uses native `showModal()`, defined safe/destructive dismissal, initial focus, Tab and Shift+Tab containment, busy duplicate-submit prevention and focus restoration. The helper's boundary loop only closes the observed browser Tab-edge gap.
- Error Disclosure exposes the details relationship and expanded state. Async retry exposes busy state, disables duplicate retry/close, and restores the explanation on failure. Toast uses a polite status live region and never steals focus.
- Chromium fixture checks in Internal and Infernal: axe 4.12.1 reports **0 violations** in each theme. Its one page-context contrast item is incomplete because the composed background cannot be inferred; rendered, non-overlapped sample ratios are **7.45:1 Internal** and **8.30:1 Infernal**. Keyboard, labels, ARIA relationships, disabled readability, visible focus, dismissal, focus return, live announcement and reduced-motion behavior were exercised.
- At 1280 / 375 / 320 px the fixtures have no horizontal overflow; rows/status/header wrap, fields remain single-column, Popover stays in viewport, Dialog fits and scrolls internally, and Toast does not cover critical Dialog controls. At 320 × 320 the Toast and Dialog bounds do not overlap. Reduced motion removes transition dependence; lifecycle and focus updates still complete.

### 30.4 D3 allowed vocabulary and forbidden defaults

D3 Home may consume, according to actual content:

```text
App Shell boundary
Page Header
Section
Divider
List Row
Interactive Row
Form Group
Inline Status
Foundation Controls
Error Disclosure
Popover
Dialog
Toast
```

D3 must not bypass these primitives to recreate equivalent structures. **DO NOT:** create a new Card family; use `glass-card` as the default; add module-private status colors; create another modal lifecycle, Toast implementation or Error model; use raw visual values; default Home to a giant Hero; expose technical metadata on the first screen; or add decorative motion. A Home Surface must represent an independent object, choice, task or space boundary; “to hold content” is not sufficient.

D3 Home is the first real production adoption. It must use the Page Header, Section, at least one List/Interactive Row, Inline Status and Foundation Controls where the actual Home content needs them. Do not force unused primitives for coverage. Validate Quiet, Spatial, Alive, Personal, Deep, the first-screen contract, semantic tokens, structural primitives, responsive behavior and Internal/Infernal. Do not use D3 to claim full primitive coverage, clear all legacy debt, complete mobile migration or implement Android.

### 30.5 Legacy boundary, family migration and platform boundary

| Existing family | Frozen identity |
|---|---|
| `.glass-card` | `LEGACY_SUPPORTED`; deprecated for new UI. |
| `.module-intro` | `LEGACY_SUPPORTED` pageChrome compatibility. |
| `.modal` and specialized hosts | `LEGACY_SUPPORTED` hosts; lifecycle convergence does not require uniform DOM. |
| Old Toast callers | `LEGACY_SUPPORTED`; 524 direct calls in 37 JS files remain family-migration debt. |
| Module-private status chips | `MODULE_PRIVATE / MIGRATION DEBT`; shared meaning is Inline Status. |
| `IBERR` | Canonical Web error model. |

Toast family rule: completed short success → Toast; validation → Form Group; operation failure → Error Disclosure; persistent degraded state → Inline Status; long task → task/status surface. Do not bulk-rewrite the 524 callers during D2-D. Dialog migration standardizes lifecycle, not host DOM; native `<dialog>`, custom modal, Voice, Credential, Packaging, Compose Dialog and Sheet may continue when they meet the contract.

Android shares Visual Language and Token Contract; `IbSemanticTokens` is the compiled token bridge, while D2 Primitive production implementation is deferred. **Contract shared, implementation asynchronous.** Android does not block D3 Web Home.

### 30.6 Production impact and regression record

- **Page-level visual migration:** none. Home, Workspace layout, Welcome, Sidebar, route and module pages were not changed for D2-D.
- **Shared production behavior already introduced:** existing Toast callers now receive polite live announcement and use the D1 semantic Toast layer; `IBERR` details expose ARIA state, and async retry exposes busy / duplicate prevention. No caller was reclassified or bulk-migrated.
- Regression before / after / delta: D2-B **38 / 38 / 0**; IBERR **124 / 124 / 0**; frontend structure **2 existing failures / same 2 / 0** (`memory-authority.js` BOM and Image Router credential-origin wording); UI guardrail **same memory-authority BOM regression / same / 0**, with CSS and inline-style totals unchanged. D2-C overlay lifecycle **39 checks passed**. `git diff --check` **PASS**; existing Windows line-ending warnings remain.
- The guardrail's repository-wide raw CSS totals are inherited legacy inventory, not D2 CSS. D2-specific CSS checks are scoped to the two new primitive stylesheets and report zero raw visual debt.

### 30.7 D3 handoff

Start D3 as a Home reference implementation that consumes this frozen system in a real production page. Do not redesign the visual/token/primitive contracts while adopting them. D3 owns Home composition and first production usage; later family migration and Android implementation remain separate phases. Stop at this handoff: no D3 page changes are part of D2-D.
