// Opens a real Atoms web call, records the agent's audio, sends one text turn, logs events.
import 'dotenv/config';
import WebSocket from 'ws';
import fs from 'node:fs';
const out = process.argv[2] || 'agent.wav';
const tok = await fetch('https://api.smallest.ai/atoms/v1/conversation/register-call', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: process.env.ATOMS_AGENT_ID }) }).then(r => r.json());
const ws = new WebSocket(`wss://api.smallest.ai/atoms/v1/agent/connect?token=${tok.data.access_token}&input_audio_format=pcm_24000`);
const pcm = []; const types = {}; const t0 = Date.now();
const silence = Buffer.alloc(4800); // 100ms @24k
let tick;
ws.on('open', () => { console.log('open'); tick = setInterval(() => ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') })), 100); });
ws.on('message', (d) => {
  const e = JSON.parse(d); types[e.type] = (types[e.type] || 0) + 1;
  if (e.type === 'output_audio.delta') pcm.push(Buffer.from(e.audio, 'base64'));
  else console.log(((Date.now() - t0) / 1000).toFixed(1), e.type, JSON.stringify(e).slice(0, 220));
});
ws.on('unexpected-response', (q, r) => { console.log('HTTP', r.statusCode); r.on('data', x => console.log(String(x))); });
ws.on('error', (e) => console.log('err', e.message));
setTimeout(() => ws.send(JSON.stringify({ type: 'input_text.send', text: 'Haan ji, main Rakesh Agarwal bol raha hoon. Agarwal Packaging, Jaipur se.' })), 12000);
setTimeout(() => {
  clearInterval(tick); ws.close();
  const data = Buffer.concat(pcm); const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
  console.log('event counts', types, 'agent audio sec', (data.length / 48000).toFixed(1));
}, 24000);
