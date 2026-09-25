# P32-2 · Tauri 2 Host Foundation

状态：Windows-first host skeleton and first native capability implemented; existing Web Core and local services remain the authority.

## Boundary

`InternalBeyond.html` still loads the existing JavaScript/CSS application. Business modules use `IB.host`; only `assets/js/host-capability.js` decides whether the current surface is the Browser adapter or the Tauri adapter.

The first native capability is Project Knowledge:

- read-only commands: `list_project_docs`, `search_project_docs`, `read_project_doc`, `project_knowledge_status`;
- allowlist: `docs/**/*.md|markdown|txt` plus root `README*`/`GUIDE*` text files;
- denylist: `.git`, dependencies, virtual environments, credentials, `.env`, logs, database/backup/upload areas, `dist`, and `target`;
- symlinks are rejected and every read is canonicalized back inside the project/resource root;
- indexed results carry `docId`, relative path, section, authority, update time, and content hash;
- read/search bounds are fixed in both the Browser/Home Node adapter and the Rust adapter.

No write, delete, shell, arbitrary path, or model-call command is exposed.

## Development and packaging

The skeleton is deliberately hand-authored rather than produced by `tauri init` so the existing Web Core stays untouched. The current config uses the existing static server at `127.0.0.1:23120/InternalBeyond.html` for development and embeds only the UI directories needed by the current page for a future packaged build. `docs/` and `README.md` are declared as package resources for the Project Knowledge root.

The Tauri CLI is not vendored in this repository. With the CLI available, the intended commands are:

```text
cargo tauri dev
cargo tauri build
```

`cargo check --manifest-path src-tauri/Cargo.toml` is the no-window validation path. The project does not grant shell/opener/fs permissions; the capability file contains only `core:default`.

## Compatibility

The existing local service Origin guards accept `http://tauri.localhost` in addition to their existing loopback/file rules. Existing service tokens, ports, Home Node storage, Bridge, Active companion, runner, and launcher behavior remain unchanged.

Android remains readiness-only in this phase. The Tauri Android target is not claimed until a JDK, Android SDK, Gradle/NDK as required, and `adb` are present on the build machine.
