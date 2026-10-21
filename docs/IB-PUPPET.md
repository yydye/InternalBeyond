# IB Puppet

IB Puppet is a small, declarative 2D character renderer for the video-call stage. It uses the PixiJS renderer already present in this checkout. It does not load Cubism Core, `pixi-live2d-display`, or `.moc3` files, and it does not execute scripts from imported packs.

## Dependency license

- **PixiJS 6.5.10** — MIT. The pinned runtime is `assets/vendor/live2d/pixi.min.js`; its license text is `assets/vendor/live2d/licenses/pixi.js-MIT.txt`. IB Puppet uses the PixiJS renderer only.
- **IB Puppet runtime and bundle validator** — InternalBeyond-authored code; it adds no third-party runtime dependency.
- Imported character art remains user-provided and is stored in the local Tauri application data directory. The application does not ship a character model or sample character.

The existing Cubism renderer and its license files remain separate. IB Puppet bundles are never sent through the Cubism parser.

## Import a character

Choose a folder or ZIP in the role's **API → 视频通话形象 → IB Puppet 素材** section. The pack must include exactly one `puppet.json` and the raster images it references. Supported image formats are PNG, JPG, and WebP. The import validates paths, references, component counts, numeric ranges, and animation data before saving. Scripts and SVG are not accepted.

The role stores a bundle ID plus display scale and offsets. The bundle itself is stored under the application's local user data, independently of chat history and Memory. Existing DIY portraits stay available as the automatic/static fallback.

## Manifest format

```json
{
  "schema": "internalbeyond.puppet.v1",
  "name": "My layered character",
  "canvas": { "width": 800, "height": 1000 },
  "bones": [
    { "id": "root", "x": 0, "y": 0 },
    { "id": "body", "parent": "root", "x": 400, "y": 960 },
    { "id": "head", "parent": "body", "x": 0, "y": -470 }
  ],
  "layers": [
    { "id": "torso", "src": "layers/torso.png", "bone": "body", "x": 0, "y": 0, "anchorX": 0.5, "anchorY": 1, "zIndex": 1 },
    { "id": "head-art", "src": "layers/head.png", "bone": "head", "x": 0, "y": 0, "anchorX": 0.5, "anchorY": 0.5, "zIndex": 2 },
    { "id": "eyes-open", "src": "layers/eyes-open.png", "bone": "head", "x": 0, "y": 5, "anchorX": 0.5, "anchorY": 0.5, "zIndex": 3 },
    { "id": "eyes-closed", "src": "layers/eyes-closed.png", "bone": "head", "x": 0, "y": 5, "anchorX": 0.5, "anchorY": 0.5, "zIndex": 4 },
    { "id": "mouth-closed", "src": "layers/mouth-closed.png", "bone": "head", "x": 0, "y": 64, "anchorX": 0.5, "anchorY": 0.5, "zIndex": 5 },
    { "id": "mouth-open", "src": "layers/mouth-open.png", "bone": "head", "x": 0, "y": 64, "anchorX": 0.5, "anchorY": 0.5, "zIndex": 6 }
  ],
  "motions": {
    "breath": { "boneId": "body", "periodSeconds": 4, "amplitudeY": 2, "scaleY": 0.006 },
    "blink": { "openLayerId": "eyes-open", "closedLayerId": "eyes-closed", "minIntervalSeconds": 2.8, "maxIntervalSeconds": 5.2, "durationSeconds": 0.18 },
    "mouth": { "closedLayerId": "mouth-closed", "openLayerId": "mouth-open", "sensitivity": 1 },
    "actions": [
      {
        "id": "nod",
        "label": "点头",
        "durationSeconds": 0.75,
        "keyframes": [
          { "boneId": "head", "at": 0, "rotation": 0 },
          { "boneId": "head", "at": 0.18, "rotation": -0.12 },
          { "boneId": "head", "at": 0.42, "rotation": 0.08 },
          { "boneId": "head", "at": 0.75, "rotation": 0 }
        ]
      }
    ]
  }
}
```

Bone positions are relative to their parent; a root bone is relative to the canvas origin. Each layer is a transparent raster sprite attached to one bone. Blink and mouth layers are paired sprites that the runtime switches based on time and the active VoiceCall TTS audio level. Actions are short, user-invoked keyframe tracks over bone or layer transforms (`x`, `y`, `rotation` in radians, `scaleX`, `scaleY`, and layer `alpha`).

## v1.1 animation and performance

- A bundle can contain up to 2,048 raster layers and 512 bones, with 8,192 action keyframes. These are import safety ceilings; 128-layer characters are supported. Each layer keeps its own anchor, z-order, transform, opacity, and optional mesh.
- Per role, choose **automatic**, 30, 60, or 120 FPS in the Puppet display settings. Automatic follows the WebView's measured display refresh rate up to 120 FPS. Rendering is scheduled with `requestAnimationFrame`; breathing, actions, gaze, mouth smoothing, and mesh springs use elapsed time rather than frame counts.
- Sustained frame-time or missed-refresh pressure lowers the target from 120 to 60 and then 30 FPS. The runtime gradually returns to the configured target after a sustained healthy interval. `IBCallPuppet.peek(call)` reports measured WebView refresh rate, rendered FPS, average and 95th-percentile JS frame work, adaptive state, layers, bones, mesh vertices, and an approximate RGBA texture-memory footprint. The browser does not expose reliable per-canvas GPU time or per-page process memory, so those require external Windows process counters.
- Actions may key `boneId` or `layerId`. Tracks support `linear`, `smooth`, `easeIn`, `easeOut`, and `easeInOut` interpolation. Starting a new action fades the previous action out and blends the new action in.
- A layer's optional `mesh` declares a regular grid and spring-driven sway, suitable for light hair, cloth, and limb deformation. For example: `"mesh":{"columns":8,"rows":12,"pinY":0.15,"swayX":6,"swayY":2,"frequency":0.8,"stiffness":36,"damping":9}`. Mesh deformation is local to that layer and does not require Cubism.
- Optional `motions.gaze` adds subtle movement to a selected bone: `{"boneId":"head","periodSeconds":5,"amplitudeX":2,"amplitudeY":1}`.

Older `internalbeyond.puppet.v1` manifests remain readable. New mesh and gaze fields are optional, layer transforms default to their v1 values, and action fade durations default to 0.12 seconds.
