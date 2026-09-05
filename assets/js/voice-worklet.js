/* InternalBeyond VoiceCapture AudioWorklet processor.
   Static module loaded via audioContext.audioWorklet.addModule('assets/js/voice-worklet.js').
   Down-samples the mic to 16kHz PCM16 and posts {pcm, rms} to the main thread.
   Must stay behavior-identical to the previous inline BLob module (VAD / barge-in /
   mute all rely on this message shape). */
class IBVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.ratio = sampleRate / 16000;
  }
  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    var out = [];
    for (var i = 0; i < ch.length; i++) {
      this.acc++;
      if (this.acc >= this.ratio) { this.acc -= this.ratio; out.push(ch[i]); }
    }
    var sum = 0;
    for (var j = 0; j < ch.length; j++) sum += ch[j] * ch[j];
    var pcm = new Int16Array(out.length);
    for (var k = 0; k < out.length; k++) {
      var v = Math.max(-1, Math.min(1, out[k]));
      pcm[k] = v < 0 ? v * 32768 : v * 32767;
    }
    this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / Math.max(1, ch.length)) }, [pcm.buffer]);
    return true;
  }
}
registerProcessor('ib-voice-capture', IBVoiceCapture);
