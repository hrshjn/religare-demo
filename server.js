import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { processTurn } from './lib/pipeline.js';
import { FIELDS, SCRIPT, LINES, CONCERNS, POLICY } from './lib/schema.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const ATOMS = 'https://api.smallest.ai/atoms/v1';
const KEY = process.env.SMALLEST_API_KEY;

for (const k of ['SMALLEST_API_KEY', 'OPENROUTER_API_KEY']) {
  if (!process.env[k]) console.warn(`! ${k} is not set (see README)`);
}

const STATIC = {
  '/': 'public/index.html',
  '/app.js': 'public/app.js',
  '/mic-worklet.js': 'public/mic-worklet.js',
  '/styles.css': 'public/styles.css',
  '/vendor/agent-sdk.js': 'node_modules/@smallest-ai/agent-sdk/dist/agent-sdk.browser.js',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const pushed = []; // mock LOS inbox, in memory

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

const routes = {
  'GET /api/config': async () => ({
    atomsAgentId: process.env.ATOMS_AGENT_ID || null,
    jevModel: process.env.JEV_MODEL || 'typesafe/jev-1.14',
    pulseLanguage: process.env.PULSE_LANGUAGE || 'hi',
    defaultEngine: process.env.DEFAULT_ENGINE || 'direct',
    fields: FIELDS,
    script: SCRIPT,
    lines: { ...LINES, consent: LINES.consent('{name}') }, // client fills in the first name
    concerns: CONCERNS,
    policy: POLICY,
  }),

  // Mint a single-use, 30-second Atoms web-call token; the API key never reaches the browser.
  'POST /api/call-token': async () => {
    const r = await fetch(`${ATOMS}/conversation/register-call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: process.env.ATOMS_AGENT_ID }),
    });
    const j = await r.json();
    if (!r.ok || !j.status) throw Object.assign(new Error(`register-call ${r.status}: ${JSON.stringify(j)}`), { status: 502 });
    return { ...j.data, agentId: process.env.ATOMS_AGENT_ID };
  },

  'POST /api/turn': async (req) => {
    const body = await readJson(req);
    if (!body.utterance?.trim()) return { form: body.form || {}, changes: [], missing: [], jev: null };
    return processTurn(body);
  },

  // Stand-in for the lender's LOS / CRM / ERP endpoint.
  'POST /api/push': async (req) => {
    const { target = 'los', application } = await readJson(req);
    const receipt = {
      status: 201,
      target,
      application_id: `RFL-MSE-${new Date().getFullYear()}-${String(crypto.randomInt(100000, 999999))}`,
      received_at: new Date().toISOString(),
      idempotency_key: crypto.randomUUID(),
    };
    pushed.push({ receipt, application });
    console.log(`[push → ${target}]`, receipt.application_id);
    return receipt;
  },
  'GET /api/inbox': async () => pushed,

  // Diagnostic: open a real Atoms web call from this server and report the first
  // events, to tell network problems apart from Atoms problems.
  'GET /api/atoms-check': async () => {
    const reg = await routes['POST /api/call-token']();
    const url = `wss://api.smallest.ai/atoms/v1/agent/connect?token=${reg.access_token}&agent_id=${reg.agentId}&mode=webcall&input_audio_format=pcm_24000`;
    return new Promise((resolve) => {
      const events = [];
      let audioBytes = 0;
      const ws = new WebSocket(url);
      let callId = null;
      const done = async (result) => {
        try { ws.terminate(); } catch {}
        let log = null;
        if (callId) {
          await new Promise((r) => setTimeout(r, 3000));
          const c = await fetch(`${ATOMS}/conversation/${callId}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
          const d = c.data || c;
          log = { status: d.status, disconnectionReason: d.disconnectionReason ?? d.disconnection_reason, duration: d.duration, transcript: (d.transcript || []).slice(0, 4), errors: d.errors ?? d.error };
        }
        resolve({ ...result, call_id: callId, events, agent_audio_seconds: +(audioBytes / 48000).toFixed(1), call_log: log });
      };
      ws.on('unexpected-response', (_, r) => { let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => done({ connected: false, status: r.statusCode, body: b })); });
      ws.on('error', (e) => done({ connected: false, error: e.message }));
      ws.on('open', () => {
        // Stream silence like an idle mic so the pipeline starts, then wait for the greeting.
        const silence = Buffer.alloc(4800).toString('base64'); // 100 ms @ 24 kHz
        const tick = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence })), 100);
        setTimeout(() => { clearInterval(tick); done({ connected: true }); }, 14000);
      });
      ws.on('message', (d) => {
        const e = JSON.parse(d);
        if (e.type === 'output_audio.delta') audioBytes += Buffer.from(e.audio || '', 'base64').length;
        else {
          if (e.type === 'session.created') callId = e.call_id;
          if (events.length < 12) events.push(JSON.stringify(e).slice(0, 300));
        }
      });
    });
  },
};

// Lightning TTS for Direct mode. Returns 502 on failure so the browser falls back
// to its own speech synthesis.
async function tts(req, res) {
  const { text } = await readJson(req);
  try {
    const r = await fetch('https://api.smallest.ai/waves/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text,
        voice_id: process.env.TTS_VOICE || 'srishti',
        model: process.env.TTS_MODEL || 'lightning_v3.1',
        language: 'hi',
        sample_rate: 24000,
        output_format: 'wav',
      }),
      signal: AbortSignal.timeout(8000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.subarray(0, 4).toString() !== 'RIFF') throw new Error(`${r.status} ${buf.toString().slice(0, 160)}`);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    console.warn('[tts] falling back to browser voice:', e.message);
    send(res, 502, { error: e.message });
  }
}

// Optional passcode for a publicly reachable deployment: open /?key=<DEMO_PASSCODE> once,
// a cookie remembers it. Everything (including /stt) requires it when set.
const PASS = process.env.DEMO_PASSCODE;
const authed = (req) => !PASS || (req.headers.cookie || '').split(/;\s*/).includes(`demo_key=${PASS}`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (PASS && url.searchParams.get('key') === PASS) {
    res.writeHead(302, { 'Set-Cookie': `demo_key=${PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, Location: '/' });
    return res.end();
  }
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Open the demo link that includes ?key=… to get access.');
  }
  if (req.method === 'POST' && url.pathname === '/api/tts') return tts(req, res);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      send(res, 200, await handler(req));
    } catch (e) {
      console.error(url.pathname, e.message);
      send(res, e.status || 500, { error: e.message });
    }
    return;
  }
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  const file = STATIC[url.pathname];
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(ROOT, file)).pipe(res);
    return;
  }
  res.writeHead(404).end();
});

// Direct mode: browser mic PCM16 @16 kHz → this socket → Pulse streaming STT.
// One Pulse session per owner turn; browser sends {"type":"stop"} when the turn ends.
const wss = new WebSocketServer({ server, path: '/stt', verifyClient: ({ req }) => authed(req) });
wss.on('connection', (client, req) => {
  const lang = new URL(req.url, 'http://x').searchParams.get('language') || process.env.PULSE_LANGUAGE || 'hi';
  const u = new URL('wss://api.smallest.ai/waves/v1/stt/live');
  const params = {
    model: 'pulse', language: lang, encoding: 'linear16', sample_rate: '16000', eou_timeout_ms: '1000',
    keywords: 'Religare:2,GST:2,Udyam:2,ITR:2,EMI:2,CIBIL:2,SBI:2,HDFC:2,ICICI:2,savings account:2,current account:2',
  };
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const pulse = new WebSocket(u, { headers: { Authorization: `Bearer ${KEY}` } });
  const pending = [];
  const toClient = (m) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(m));

  pulse.on('open', () => { pending.splice(0).forEach((b) => pulse.send(b)); toClient({ type: 'ready' }); });
  pulse.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.type && m.type !== 'transcription') return toClient({ type: 'info', data: m });
    toClient({ type: m.is_final ? 'final' : 'partial', text: m.transcript || '', last: !!m.is_last, language: m.language });
    if (m.is_last) { pulse.close(); client.close(); }
  });
  pulse.on('unexpected-response', (_, r) => {
    let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => { toClient({ type: 'error', error: `Pulse ${r.statusCode}: ${b}` }); client.close(); });
  });
  pulse.on('error', (e) => { toClient({ type: 'error', error: e.message }); client.close(); });
  pulse.on('close', () => client.readyState === WebSocket.OPEN && client.close());

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      pulse.readyState === WebSocket.OPEN ? pulse.send(data) : pending.push(data);
      return;
    }
    const m = JSON.parse(String(data));
    if (m.type === 'stop' && pulse.readyState === WebSocket.OPEN) pulse.send(JSON.stringify({ type: 'close_stream' }));
  });
  client.on('close', () => pulse.readyState === WebSocket.OPEN && pulse.close());
});

server.keepAliveTimeout = 65_000; // outlive client keep-alive pools between turns
server.listen(PORT, () => console.log(`Religare SME demo → http://localhost:${PORT}`));
