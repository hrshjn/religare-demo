// Streams WAV files through the demo's /stt proxy (→ Pulse) in real time and prints finals.
// Usage: node test/stt-files.mjs <language> file1.wav file2.wav ...
import WebSocket from 'ws';
import fs from 'node:fs';

function wavTo16k(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24), ch = b.readUInt16LE(22);
  let off = 12; while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const data = b.subarray(off + 8, off + 8 + b.readUInt32LE(off + 4));
  const n = data.length / 2 / ch, src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = data.readInt16LE(i * 2 * ch) / 32768;
  const r = rate / 16000, outN = Math.floor(n / r), out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) { const x = i * r, k = Math.floor(x), f = x - k; const s = src[k] * (1 - f) + (src[k + 1] ?? 0) * f; out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2); }
  return Buffer.concat([out, Buffer.alloc(16000)]); // + 0.5 s silence
}

const [lang, ...files] = process.argv.slice(2);
for (const f of files) {
  const pcm = wavTo16k(f);
  const t0 = Date.now();
  const text = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${process.env.PORT || 8787}/stt?language=${lang}`);
    const finals = []; let firstPartial = null;
    ws.on('open', () => {
      let o = 0;
      const tick = setInterval(() => {
        if (o >= pcm.length) { clearInterval(tick); ws.send(JSON.stringify({ type: 'stop' })); return; }
        ws.send(pcm.subarray(o, o + 3200)); o += 3200; // 100 ms
      }, 100);
    });
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'partial' && m.text && !firstPartial) firstPartial = Date.now() - t0; if (m.type === 'final' && m.text.trim()) finals.push(m.text.trim()); if (m.type === 'error') console.log('ERR', m.error); });
    ws.on('close', () => resolve({ text: finals.join(' '), firstPartial }));
  });
  console.log(`${f.split('/').pop()}  [${lang}] first-partial ${text.firstPartial}ms  →  ${text.text}`);
}
