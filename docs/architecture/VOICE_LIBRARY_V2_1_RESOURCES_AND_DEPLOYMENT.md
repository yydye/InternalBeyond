# Voice Library v2.1 resource batch and deployment

## Prepared resources

The deployable directory is [`deploy/voice-library`](../../deploy/voice-library). It contains
one version-1 Manifest and four Voicebox preset Profile descriptors:

| Manifest ID | Voicebox preset ID | Language |
| --- | --- | --- |
| `kokoro-af-heart-en` | `af_heart` | `en` |
| `kokoro-af-bella-en` | `af_bella` | `en` |
| `kokoro-am-michael-en` | `am_michael` | `en` |
| `kokoro-zf-xiaobei-zh` | `zf_xiaobei` | `zh` |

The IDs and languages were checked against Voicebox's upstream Kokoro preset catalogue.
The source reports Kokoro-82M as Apache 2.0; the Manifest links that model card as the
license provenance. The files on this static host are only JSON Profile references: no
voice recording, model weight, generated audio, credential, or user data is included.
InternalBeyond checks the connected Voicebox Runtime's current preset endpoint again before
enabling import, so a stale or different Runtime cannot make an unsupported ID appear usable.

## VPS mapping

Copy the contents of `deploy/voice-library/` under the existing static host document root at
`/voice-library/`:

```text
deploy/voice-library/voice-library-stable.json
  -> <document-root>/voice-library/voice-library-stable.json
deploy/voice-library/profiles/*.json
  -> <document-root>/voice-library/profiles/*.json
```

The public URLs are:

```text
https://dl.chatvault.top/voice-library/voice-library-stable.json
https://dl.chatvault.top/voice-library/profiles/<resource-id>.json
```

Serve anonymous HTTPS `GET` with `Access-Control-Allow-Origin: *`,
`Content-Type: application/json`, an exact `Content-Length`, and HTTP 200 without redirects.
No app server, upload route, worker, inference endpoint, or dynamic Manifest generation is
needed. A short cache lifetime is suitable for the Manifest; resource files are immutable
for a given ID and digest.

## Local verification

From the repository root:

```powershell
node tests/test_voice_library_catalog.js
node tests/test_chat_smoke.js
```

The browser smoke's local mock host serves the exact files from `deploy/voice-library` and
exercises the app's fixed HTTPS URL through an isolated browser fetch adapter. It verifies
Manifest display, provider compatibility, byte count, SHA-256, Profile import/export, the
existing audition handoff, corrupt bytes, and offline behavior. It does not contact the VPS.

## Post-deployment checks

After an authorized static upload, verify that the Manifest returns 200 and does not redirect:

```powershell
curl.exe -fsS -D - -o NUL https://dl.chatvault.top/voice-library/voice-library-stable.json
curl.exe -fsS -D - -o NUL https://dl.chatvault.top/voice-library/profiles/kokoro-af-heart-en.json
```

Compare a downloaded resource's byte count and SHA-256 with its Manifest entry:

```powershell
curl.exe -fsS -o "$env:TEMP\kokoro-af-heart-en.json" https://dl.chatvault.top/voice-library/profiles/kokoro-af-heart-en.json
(Get-Item "$env:TEMP\kokoro-af-heart-en.json").Length
(Get-FileHash "$env:TEMP\kokoro-af-heart-en.json" -Algorithm SHA256).Hash.ToLowerInvariant()
```

No deployment was performed for this change. The current Manifest URL was unavailable at
audit time. Voicebox v2.2 authorized a static upload, but this workspace still needs an
authenticated deployment method and the static document-root path for `dl.chatvault.top`.
