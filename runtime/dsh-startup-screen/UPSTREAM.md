# Upstream provenance

The splash runtime and Cordis client/host integration in `lib/` are adapted from
[`6shenhonghong9/dsh-startup-screen`](https://github.com/6shenhonghong9/dsh-startup-screen)
at commit `4a2cfe642867fac013fdef90095981544a819a2a`, under its MIT license
(see `LICENSE`). This adaptation adds a task-scoped Permission overlay whose
decisions are forwarded to InternalBeyond's existing Home Node Work Run and
Consent flow.

The upstream repository explicitly excludes its recorded voice and sound
effects from the MIT grant. Those audio files are not copied or distributed.
The plugin uses local system TTS and WebAudio synthesis only.
