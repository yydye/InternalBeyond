# IB Puppet Studio v1.2

IB Puppet Studio is an editor inside the existing DIY Workshop. It prepares editable projects and compiles them to the existing `internalbeyond.puppet.v1` runtime package. Rendering, video-call state, TTS amplitude, animation scheduling, import validation, local bundle storage, and role binding continue to use the existing IB Puppet and VoiceCall paths.

## Project and runtime files

- **Editable project**: `.ibpuppet-project.json`. It contains the original user reference image, selected view crop, per-layer source pixels and editable mask source, layer/bone metadata, motions, and AI proposal notes. Windows Tauri **保存工程** writes it to the dedicated `live2d/puppet-projects` area under the app user-data directory; the left library list can reopen it after a reload. **导出工程** writes a portable JSON copy to that directory's `exports` subfolder, and **导入工程** accepts an external project file.
- **Runtime package**: `.ibpuppet.zip`. It contains only `puppet.json` and visible raster layers. The original sheet, editor notes, AI proposal, hidden candidates, and raw edit sources stay out of the runtime package. In Windows Tauri, exporting installs through the existing Puppet library command and writes a ZIP copy under `live2d/puppet-projects/exports`; the user can then bind the installed bundle in the existing role API editor.
- Runtime bundle imports remain editable: the studio can reopen an installed bundle, inspect its layers, bones, mesh, and actions, and save it as an editable project. A runtime bundle does not contain the original reference sheet, so it cannot restore source pixels that were never exported.

## See-through PSD auto Rig

**导入 See-through PSD** reads a layered PSD locally with `ag-psd`, then runs the MIT-licensed Anime2.5DRig layer-name, alpha cleanup, anchor, eye-side, mouth-difference, and hair-strand routines. It does not invoke See-through or send the PSD to an API. See-through's `-l` / `-r` part names are preserved as separate source layers; generated layer PNGs are cropped from those real PSD pixels and keep their original canvas coordinates.

The importer creates editable Root, body, head, and left/right arm bones; estimates the head and shoulder pivots from the PSD; maps parts to those bones; and assigns separate spring meshes to front/back hair. Missing closed-eye and closed-mouth differences use Anime2.5DRig's bundled `GenericParts` code shapes, not its sample PSDs. The project stores left/right blink pairs, TTS mouth mapping, a small automatic head turn, breathing, and a playable head-turn action. Runtime export keeps the existing `internalbeyond.puppet.v1` schema and Pixi renderer; it adds optional `headTurn` and `blink.pairs` motion fields while keeping older single-pair blink manifests valid.

Non-character `objects` layers start hidden. Empty PSD parts stay absent. A missing skirt layer or a visible gap is recorded on the related layer for repainting; mesh motion must not be used to hide missing art. The existing edge-mask editor remains the repair path for halos and stray alpha pixels. Bone pivots and generic face differences need a visual pass before release.

## Reference image and layer workflow

1. Open **DIY → 角色动画工作室**. For existing artwork, import PNG, JPG, or WebP (18 MB maximum per image); for an already-layered See-through result, choose **导入 See-through PSD**.
2. Optionally choose an existing vision-capable API configuration and click **分析结构与分层建议**. The request uses `callApiChat` and its existing Provider adapter; non-local credentials remain on the existing Credential Vault path. The provider returns normalized view/part boxes, confidence, occlusion notes, and optional skeleton proposals. The result is a proposal only; nothing is cut or applied automatically.
3. Select a front view from the proposal or draw a view rectangle manually. Three-view and expression sheets remain references; they are never treated as animation layers by themselves.
4. Select a proposed part or draw a freehand lasso. The editor cuts pixels from the selected source view, clips them to the lasso, and optionally removes edge-connected white background. Each layer also retains its raw crop so the mask editor can erase or restore original pixels.
5. Review and edit layer bounds, bone, local transform, anchor, scale, alpha, z-order, notes, and optional spring mesh. The mask editor uses the original crop and writes only after the user selects **保存边缘修正**.

For a flat reference crop, the editor does not manufacture hidden image content. For a layered PSD, the importer only cleans noisy alpha and creates generic eye/mouth expression differences; it does not inpaint clothing or restore occluded arms. An optional per-layer completion action uses the current **Image Router → Editing** route after a cost confirmation. It produces a separate candidate preview; the user must explicitly add that candidate as a new layer. No API is called when opening the studio or importing a reference/PSD.

## Skeleton, motion, and preview

Bone positions are parent-local. Existing layers may be assigned to any bone and retain separate anchors, transform, z-order, opacity, and mesh settings. The time editor supports keyframes on bones or layers, time, easing, transform values, playhead scrubbing, action blending, and preview through `IBCallPuppet.attachManifest`—the same Pixi/Puppet renderer used by video calls. It does not create a second animation runtime.

Breathing, gaze, and head turn use the existing bone hierarchy and optional manifest motion fields. Independent blink pairs hide each side's open-eye layers and show its closed-eye layer; legacy single-pair blink mappings remain supported. Mouth motion continues to read VoiceCall's TTS output level. AI action drafts are saved as editable proposals and are merged into the timeline only after the user accepts them.

## AI requests and privacy

The user selects an existing API configuration and explicitly starts visual analysis, motion drafting, or image completion. A request can include the selected reference image and the relevant rig or project summary. The studio does not attach chat history, role Memory, API key fields, or backups. Provider output is parsed as bounded data; it cannot run code or write files. Image completion uses the existing Image Router and asks for confirmation before a request that may incur charges.

Opening the studio, importing a reference image, and importing a PSD do not call an AI provider. PSD parsing and manual editing happen locally. The project and runtime bundle remain in local app storage unless the user exports them. The optional See-through component is separately installed by the user; its source and model weights are not included in this release.

## Current limits

- A flat reference image does not contain hidden character details. The editor does not invent missing pixels; imported layers and generated expression differences need review and may need manual repainting.
- Auto-rig output is an editable starting point. Layer boundaries, pivots, masks, mesh motion, and keyframes should be reviewed before binding the character to a role.
- The built-in runtime uses the IB Puppet schema and PixiJS renderer. It does not include sample character art or Cubism Core. Live2D Cubism models require separately obtained, properly licensed runtime components and model assets.
- Character bundles accept raster assets only. Imported scripts and SVG are rejected by the bundle validator.

Third-party code attributions and license texts are in `assets/vendor/puppet/licenses/NOTICE.md`. Source art and model weights are not included in the installer or sample bundles.
