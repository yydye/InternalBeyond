# Puppet Auto Rig third-party notices

## Anime2.5DRig

`assets/js/puppet-studio-rigger.js` and `assets/js/puppet-studio-genericparts.js` are adapted from [852wa/Anime2.5DRig](https://github.com/852wa/Anime2.5DRig), Copyright (c) 2026 hakoniwa, under the MIT License. The rigger includes a local compatibility change for See-through's explicit `-l` / `-r` PSD layer names. The full license is in `Anime2.5DRig-MIT.txt`.

The upstream sample PSDs (`sample.psd`, `sample2.psd`, `eye_close.psd`, and `mouth_close.psd`) and MediaPipe FaceMesh files are not included in IB. The generic closed-eye and closed-mouth shapes are generated from the MIT-licensed `GenericParts` code, not from those sample PSDs.

## ag-psd

`assets/vendor/puppet/ag-psd.min.js` is the ag-psd PSD parser, Copyright (c) 2016 Agamnentzar, under the MIT License. The full license is in `ag-psd-MIT.txt`.

## Experiment-only models and source art

The DWPose ONNX weight used in a local comparison is Apache-2.0 and is not bundled with IB. See-through's source and weights are not bundled. Character artwork and derivatives used during development are not included in the source package, installer, or sample bundles; their separate licenses continue to apply to their owners.

## Optional See-through component

IB v1.3 invokes See-through as a separately installed local component. The See-through source is selected by the user and is not copied into the IB installer; its upstream code is Apache-2.0. Model files remain in the user-selected cache and are not bundled. The LayerDiff and Marigold NF4 weights include Apache-2.0 grants for See-through's contributions and inherit OpenRAIL++-M / OpenRAIL-M and base-model restrictions. Users must review and comply with those terms for each use; downloading weights does not grant IB distribution rights. See the official [LayerDiff NF4 model card](https://huggingface.co/24yearsold/seethroughv0.0.2_layerdiff3d_nf4) and [Marigold NF4 model card](https://huggingface.co/24yearsold/seethroughv0.0.1_marigold_nf4).

The Rust host's new direct dependencies are `base64 0.22.1` (MIT), `sha2 0.10.9` (MIT), `zip 2.6.1` (MIT), and `tauri-plugin-dialog 2.2.2` (MIT). Copies of their MIT license texts are included beside this notice. The dialog plugin is registered only for normal non-RecoveryOnly windows.

StretchyStudio source was not copied into IB. Its current root LICENSE is MIT, while `docs/README_internal.md` still labels the project proprietary; resolve that upstream inconsistency before adapting its source.

No Cubism Core or example character assets are added by this integration.
