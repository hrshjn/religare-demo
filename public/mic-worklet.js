// Downsamples the mic to 16 kHz mono PCM16 and posts ~100 ms chunks, plus a level for the meter.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.buf = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let peak = 0;
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
      peak = Math.max(peak, Math.abs(s));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer.slice(0), level: peak });
        this.n = 0;
        peak = 0;
      }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
