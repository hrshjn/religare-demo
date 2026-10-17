// End-to-end check of a deployed instance.
// Usage: node test/remote-e2e.mjs https://<host> <DEMO_PASSCODE> [dir-of-owner-wavs]
// Checks: passcode login, config, Jev turn, Pulse over /stt (if WAVs given), TTS, push.
import WebSocket from 'ws';
import fs from 'node:fs';

const [base, key, wavDir] = process.argv.slice(2);
const ok = (name, pass, detail = '') => console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);

const login = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
ok('passcode login', login.status === 302 && cookie.startsWith('demo_key='), `HTTP ${login.status}`);
const H = { Cookie: cookie, 'Content-Type': 'application/json' };

const cfg = await fetch(`${base}/api/config`, { headers: H }).then((r) => r.json()).catch(() => null);
ok('config', !!cfg?.fields, cfg ? `${cfg.fields.length} fields, Jev ${cfg.jevModel}, Pulse ${cfg.pulseLanguage}` : '');

const t0 = Date.now();
const turn = await fetch(`${base}/api/turn`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ utterance: 'Mujhe pachas lakh chahiye. Nahi nahi, chalis lakh kar dijiye.', history: [{ role: 'agent', text: 'Aapko kitne amount ka loan chahiye?' }] }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));
ok('Jev turn (OpenRouter key)', turn.form?.requested_amount?.display === '₹40 lakh', turn.error || `${turn.form?.requested_amount?.display} · Jev ${turn.jev?.latency_ms} ms · round trip ${Date.now() - t0} ms`);

const tts = await fetch(`${base}/api/tts`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'Namaste, main Ananya.' }) });
ok('Lightning TTS (Smallest key)', tts.ok && tts.headers.get('content-type') === 'audio/wav', tts.ok ? 'audio returned' : `HTTP ${tts.status}: browser voice fallback will be used`);

if (wavDir) {
  const f = `${wavDir}/01.wav`;
  const b = fs.readFileSync(f);
  const rate = b.readUInt32LE(24);
  const src = new Int16Array(b.buffer, b.byteOffset + 44, (b.length - 44) >> 1);
  const r = rate / 16000, out = Buffer.alloc(Math.floor(src.length / r) * 2);
  for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(src[Math.floor(i * r)], i * 2);
  const text = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/stt?language=hi`, { headers: { Cookie: cookie } });
    const finals = [];
    ws.on('open', () => {
      let o = 0;
      const tick = setInterval(() => {
        if (o >= out.length) { clearInterval(tick); ws.send(JSON.stringify({ type: 'stop' })); return; }
        ws.send(out.subarray(o, o + 3200)); o += 3200;
      }, 100);
    });
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'final' && m.text.trim()) finals.push(m.text.trim()); if (m.type === 'error') finals.push('ERROR ' + m.error); });
    ws.on('close', () => resolve(finals.join(' ')));
    ws.on('error', (e) => resolve('ERROR ' + e.message));
    setTimeout(() => resolve(finals.join(' ') || 'TIMEOUT'), 30000);
  });
  ok('Pulse STT over /stt WebSocket (Smallest key)', /लाख/.test(text), text);
}

const push = await fetch(`${base}/api/push`, { method: 'POST', headers: H, body: JSON.stringify({ target: 'webhook', application: { test: true } }) }).then((r) => r.json()).catch(() => ({}));
ok('send to credit team (mock)', push.status === 201, push.application_id || '');
