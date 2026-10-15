# Voice Library v2 Static Resource Contract

This document defines the static-only Voice Library feed. It does not provision, write to,
or deploy the VPS. The Voicebox v2 client accepts one portable resource type: a Voicebox
preset Profile descriptor. It never downloads audio, reference samples, model weights, or
credentials.

## Required static layout

```text
/voice-library/
  voice-library-stable.json
  profiles/
    <resource-id>.json
```

The client requests `https://dl.chatvault.top/voice-library/voice-library-stable.json` and
only constructs resource URLs beneath `https://dl.chatvault.top/voice-library/profiles/`.
The manifest and profile files must be HTTPS JSON responses, allow anonymous CORS `GET`,
and must not redirect. No service process, upload route, inference, TTS, or background task
is required on the VPS. Recommended cache headers are a short public cache for the manifest
and immutable public cache for versioned profile files.

## Manifest v1

```json
{
  "schema": "internalbeyond.voice-library-manifest",
  "schemaVersion": 1,
  "generatedAt": "2026-10-14T12:00:00Z",
  "resources": [
    {
      "id": "kokoro-heart-en",
      "kind": "voicebox-preset-profile",
      "title": "Kokoro Heart · English",
      "description": "Voicebox Kokoro preset profile",
      "provider": "voicebox",
      "engine": "kokoro",
      "presetVoiceId": "af_heart",
      "language": "en",
      "source": { "name": "Upstream Voice Library", "url": "https://example.org/voices" },
      "license": { "id": "CC-BY-4.0", "name": "CC BY 4.0", "url": "https://example.org/license" },
      "path": "profiles/kokoro-heart-en.json",
      "sizeBytes": 284,
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

The client rejects unknown schema versions, extra or malformed fields, duplicate IDs, path
traversal, non-HTTPS source/license links, non-Voicebox resources, invalid digests, and files
larger than 64 KiB. `sizeBytes` and `sha256` describe the exact UTF-8 bytes of the profile
file.

## Profile file v1

```json
{
  "schema": "internalbeyond.voice-profile-package",
  "schemaVersion": 1,
  "profile": {
    "provider": "voicebox",
    "voiceType": "preset",
    "name": "Kokoro Heart · English",
    "description": "Voicebox Kokoro preset profile",
    "language": "en",
    "engine": "kokoro",
    "presetVoiceId": "af_heart"
  }
}
```

Only preset Profile metadata is accepted. Before import, InternalBeyond checks the Voicebox
Bridge capability map, the selected engine's preset/language support, and the exact preset
voice ID returned by Voicebox. Voicebox creates the local Profile through its existing
Bridge API; the user must explicitly bind it to a role. The package carries no Voicebox
runtime Profile ID, sample ID, audio, local path, model file, API key, or other credential.

## Client failure behavior

- Offline Manifest: show an unavailable state; local Voicebox Profiles and role voices remain
  usable.
- Provider or preset mismatch: show as unsupported and disable import.
- Size/hash/JSON mismatch: reject before calling the Voicebox Profile API.
- Bridge/Voicebox unavailable: browse the manifest if available, but do not claim the voice is
  locally available or create a Profile.
- Clone Profiles: they remain owned by Voicebox and are neither packaged nor imported by this
  contract.
