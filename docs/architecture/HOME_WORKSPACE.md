# P37 — Home Workspace

## Welcome / Home ownership map

Welcome/Landing and Home Workspace are separate product surfaces. The legacy route names remain stable:

| Surface | Route | DOM root | Contents |
|---|---|---|---|
| Welcome / Landing | `#home` → `navTo('home')` | `#page-home` | Original Internal Beyond title, subtitle, credit, theme entrance animation, and the existing welcome/background elements. The `#splash` intro remains the launch overlay. |
| Home Workspace | `#workspace` → `navTo('workspace')` | `#page-workspace` | P37 Personal Workspace, Recent, Quick Access, and Workspace Status dashboard. Sidebar label: Home. |
| Active | `#active` → `navTo('active')` | `#page-active` | Existing Active work page. |

The existing brand control `#nav-home` still calls `navTo('home')`; it is a legacy Welcome entry and remains the Tauri secret-gesture target. The P37 sidebar Home link has its own ID and targets `workspace`. The existing `navTo()` router updates active navigation state from the actual route, so Welcome has no Home sidebar item active, Home Workspace activates Home, and Active activates Active.

## 1. Purpose

Home Workspace is the personal entry point to the existing InternalBeyond workspace. It combines a brief welcome, a small recent list, navigation shortcuts, and a read-only capability glance. It does not introduce a second source of business state.

The initial audit and data-source findings are recorded in [HOME_WORKSPACE_AUDIT.md](HOME_WORKSPACE_AUDIT.md).

## 2. Information architecture

The P37 dashboard preserves its current visual language and presents:

- A personal workspace greeting and local-device note.
- Up to four recent conversation or activity metadata items, each limited to title, type, and time.
- Navigation-only quick access to Chat, Memory, Blog/Create, Active, Apps/Tools, Packaging, and API settings (which also contains Middle Brain settings).
- A compact read-only status row for local storage, Memory count, Packaging availability, and the location of Voice in Chat.

When both recent sources are available and empty, Home shows a welcome state and links to Chat, Memory, and Apps. A failure in one source leaves the other sections available and reports “Some workspace information unavailable.”

## 3. Data sources and lifecycle

| Home information | Existing source | Read shape |
|---|---|---|
| Recent conversations | IndexedDB `chatThreads` through `dbScan` | At most 24 cursor records; project `name` and `created` only |
| Recent activities | IndexedDB `activities` through `dbScan` | At most 24 cursor records; project `title`, `kind`/`type`, and update time only |
| Memory count | `_ibCount('memories')` | Object-store count only; no Memory rows are enumerated |
| Storage readiness | Successful bounded `chatThreads` scan | Read-only readiness signal |
| Packaging availability | Existing Packaging Center client `jobs()` read | Keep only the `available` boolean; discard job details |
| Voice | Existing Chat route | Navigation location only; no availability or provider probe |

The P37 controller is mounted with the app but performs no aggregation while Welcome or another route is active. It reads the existing sources when `#page-workspace` becomes active, and refreshes on a later Home re-entry. It does not poll. The page does not use Chat messages or summaries, `IB.activity.listActivities()`, or Memory rendering APIs. The bounded recent scan can omit conversations that lack a `chatThreads` metadata row.

## 4. Security boundary

Home Workspace is limited to aggregation and navigation. It does not generate AI, execute Chat, change Memory, read credentials or secrets, call a provider, run Packaging preflight/build actions, or write application data. It does not display endpoints, tokens, API keys, or provider identities.

Dynamic recent text is inserted with `textContent`. The recent projection retains only title, type, and timestamp; it drops record IDs and all other fields.

## 5. Visual language reuse

Home Workspace reuses the existing `.glass-card`, `.btn`, semantic surface/content/border tokens, font tokens, and radius tokens. Its responsive styles are scoped to `#page-workspace`; the original `#page-home` layout and its animation remain owned by the Welcome surface. The implementation adds no dashboard framework, chart library, UI framework, or global token family.

## 6. Navigation integration

The P36 sidebar remains the navigation shell. Its Home entry targets the existing `navTo('workspace')` dispatcher and `#page-workspace`; quick shortcuts validate against existing `page-*` containers and use that same router. The brand control `#nav-home`, hash handling, the hidden Middle Brain direct route, and secret route handling remain unchanged.

## 7. Future extension rules

1. Keep Welcome and Home Workspace as separate surfaces even though legacy route names are ambiguous.
2. Reuse a bounded public read API or a count-only facade already owned by the source module.
3. Project only fields explicitly approved for Home; never add message, summary, Memory, credential, or provider payloads to the Home view model.
4. Load Home aggregation only while `#page-workspace` is active; preserve independent source failure handling.
5. Make shortcuts call existing routes; do not reproduce business actions or create hidden routes.
6. Keep the P36 sidebar and the `#nav-home` legacy behavior independent of Home dashboard ownership.

## 8. P2 update (2026-09-28)

- The dashboard header is no longer a Hero clone. `home-workspace-presence` renders the brand
  mark (Internal/Infernal Beyond, `--beyond-color`, `--fs-h2` scale) as a compact presence
  header in pageChrome language (caps eyebrow + quiet line + local state + bottom hairline).
- `#workspace-greeting` is retired; the greeter is no longer rendered. The pure helper
  `greetingFor` stays exported because `tests/test_home_workspace.js` locks it as part of the
  workspace helper contract.
- Surfaces: Recent = `--glass-bg-surface` tier, Quick Access = `--glass-bg-ambient` quieter
  layer, status items = default `glass-card` surface; all raw rgba/gradients removed from
  `home-workspace.css`.
- The "Work Mode" quick link is relabeled "Activity" (same `#active` route); the empty state
  no longer says "Welcome to InternalBeyond".
- Read boundaries are unchanged: §4 still holds (no API config, no content, no writes).
