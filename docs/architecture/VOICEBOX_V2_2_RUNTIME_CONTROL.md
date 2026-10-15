# Voicebox v2.2 local runtime control

InternalBeyond continues to use the existing Voicebox REST adapter for health,
profiles, TTS and ASR. A small process controller is hosted inside the existing
IB Bridge; it is not a new server and does not implement inference.

## Launch behavior

- The user can save an absolute `Voicebox.exe` path in the existing Bridge
  `config.json` `voicebox.executablePath` field. The general `/api/config`
  snapshot masks this local path; the Voicebox page reads it only through the
  local runtime-control route.
- On Windows the controller accepts only a file named `voicebox.exe`, checks
  that the file exists, and invokes it directly with no shell and no arguments.
  It checks the official default install locations first; other locations can
  be pasted into the path field.
- Start is idempotent. If the configured local Voicebox health endpoint is
  already healthy, IB reuses it instead of spawning a second app instance.
- Stop sends the official local `POST /shutdown` request. It only closes the
  exact desktop app process spawned by IB; it does not kill processes by name
  or terminate an unrelated process listening on port 17493.
- The Bridge health response is authoritative for `running`. A closed local
  port is the normal `installed-stopped` state, not a system fault. A missing
  executable, spawn failure, unexpected child exit, remote endpoint, and
  unidentified port occupant have separate states.

## Install and test

The Voicebox page links to the upstream [official releases](https://github.com/jamiepine/voicebox/releases).
IB does not download or install Voicebox automatically. Voicebox binaries and
models are not bundled in the InternalBeyond installer.

Run focused checks:

```powershell
node tests/test_voicebox_runtime_control.js
node tests/test_voicebox_provider.js
node tests/test_chat_smoke.js
```

The process-control test uses an injected fake child process. A real installed
Voicebox launch requires the upstream Windows app to be installed and its
`Voicebox.exe` path available. This checkout's current machine had no matching
uninstall entry, process, or listener on port 17493, so real installed-state
startup could not be exercised here.
