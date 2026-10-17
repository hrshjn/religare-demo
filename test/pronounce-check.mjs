// Speaks a line through the deployed /api/tts with and without the pronunciation
// dictionary, transcribes both through /stt (Pulse, Hindi), and prints the results.
// Usage: node test/pronounce-check.mjs https://<host> <passcode> "text"
import WebSocket from 'ws';
const [base, key, text] = process.argv.slice(2);
const login = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
async function roundTrip(pronunciation) {
  const r = await fetch(`${base}/api/tts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, pronunciation }) });
  if (!r.ok) return `TTS ${r.status}`;
  const wav = Buffer.from(await r.arrayBuffer());
  const rate = wav.readUInt32LE(24);
  const src = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length - ((wav.length - 44) % 2)));
  const n = Math.floor(src.length * 16000 / rate), pcm = Buffer.alloc(n * 2 + 16000);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(src[Math.floor(i * rate / 16000)], i * 2);
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/stt?language=hi`, { headers: { Cookie: cookie } });
    const finals = [];
    ws.on('open', () => { let o = 0; const t = setInterval(() => { if (o >= pcm.length) { clearInterval(t); ws.send(JSON.stringify({ type: 'stop' })); return; } ws.send(pcm.subarray(o, o + 3200)); o += 3200; }, 100); });
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'final' && m.text.trim()) finals.push(m.text.trim()); });
    ws.on('close', () => resolve(finals.join(' ')));
    setTimeout(() => resolve(finals.join(' ') || 'TIMEOUT'), 40000);
  });
}
console.log('text:          ', text);
console.log('no dictionary: ', await roundTrip(false));
console.log('dictionary:    ', await roundTrip(true));
