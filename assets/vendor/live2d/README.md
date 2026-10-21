# Optional Live2D display dependencies

The Live2D call surface uses PixiJS 6.5.10 and `pixi-live2d-display` 0.4.0 (Cubism 4 bundle). Their MIT license texts are in `licenses/`. The standalone PixiJS renderer is also used by IB Puppet; Puppet loads PixiJS only and does not load this Cubism 4 bundle or Cubism Core.

Role models are imported from a user-selected folder or ZIP through the Tauri host and stored under the app's user-data `live2d/models/` directory. Role configuration stores a `live2dModelRef`, presentation mode, and layout values; model bytes are not copied into role records. Static fallback first reuses the existing per-role DIY Workshop portrait and its scale/position, then the role's existing API avatar.

The Tauri asset protocol is scoped to user model data and the packaged Live2D runtime. Model folder structure is preserved, so texture, motion, physics, pose, and expression paths resolve relative to each `.model3.json`. Existing same-origin and HTTPS `live2dModelUrl` settings remain supported.

Cubism Core is optional in source and is loaded from `assets/live2d/runtime/live2dcubismcore.min.js` when included in a licensed release. Isolated Dev can stage a locally authorized Core into its own app-data sandbox through `IB_LIVE2D_DEV_CORE_PATH`. No model or Cubism Core is included in ordinary source assets. Before release, determine the applicable Cubism SDK license for the Windows application and AI/chatbot use; sample model data has separate terms.
