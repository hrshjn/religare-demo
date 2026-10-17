import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { processTurn } from './lib/pipeline.js';
import { logEntry, summarizeTurn, readLog, sessions, review, addLabel, readLabels, saveCall, readCall, LOG_FILE } from './lib/turnlog.js';
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
  '/logs': 'public/logs.html',
  '/religare-logo.png': 'public/religare-logo.png',
  '/vendor/agent-sdk.js': 'node_modules/@smallest-ai/agent-sdk/dist/agent-sdk.browser.js',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const pushed = []; // mock LOS inbox, in memory

// test/fixtures/owner-amount-hi.wav (16-bit mono) resampled to 24 kHz PCM, for the Atoms check.
function fixturePcm24k() {
  const b = fs.readFileSync(path.join(ROOT, 'test/fixtures/owner-amount-hi.wav'));
  const rate = b.readUInt32LE(24);
  const src = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)));
  const n = Math.floor(src.length * 24000 / rate), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(src[Math.min(src.length - 1, Math.floor(i * rate / 24000))], i * 2);
  return out;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

// Fetch an Atoms call and shape it for the history view.
async function fetchAtomsCall(callId) {
  const c = await fetch(`${ATOMS}/conversation/${encodeURIComponent(callId)}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json()).catch(() => null);
  const d = c?.data || c;
  if (!d?.callId) return null;
  return {
    session: d.callId,
    status: d.status,
    duration: d.duration,
    disconnection: d.disconnectionReason,
    recording: d.recordingUrl || null,
    summary: d.postCallAnalytics?.summary || null,
    metrics: Object.fromEntries((d.postCallAnalytics?.dispositionMetrics || []).map((x) => [x.identifier, x.value])),
    transcript: (d.transcript || []).map((t) => ({ role: t.role === 'user' ? 'owner' : 'agent', text: t.content, at: t.timestamp })),
    tool_calls: (d.events || []).filter((e) => /tool_call/.test(e.eventType)).map((e) => ({ type: e.eventType, at: e.eventTime })),
  };
}

// Save a finished call's history once Atoms has its post-call analytics (a few seconds after hang-up).
function archiveSoon(session, delayMs = 20000) {
  if (!/^CALL-/.test(session || '')) return;
  setTimeout(async () => {
    const call = await fetchAtomsCall(session).catch(() => null);
    if (call) saveCall({ ...call, final: review(session).final });
  }, delayMs);
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
    try {
      const result = await processTurn(body);
      logEntry(summarizeTurn(body, result));
      return result;
    } catch (e) {
      logEntry(summarizeTurn(body, null, e));
      throw e;
    }
  },

  'GET /api/review': async (req) => {
    const session = new URL(req.url, 'http://x').searchParams.get('session');
    const r = review(session);
    // For Atoms calls, add Atoms' own record: recording, summary, post-call metrics,
    // and flag where those metrics disagree with what Jev filled.
    if (/^CALL-/.test(session || '')) {
      const c = await fetch(`${ATOMS}/conversation/${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json()).catch(() => null);
      const d = c?.data || c;
      if (d?.callId) {
        const m = Object.fromEntries((d.postCallAnalytics?.dispositionMetrics || []).map((x) => [x.identifier, x.value]));
        const f = r.final;
        const purposeMap = { working_capital: ['working_capital', 'receivables_gap'], machinery: ['machinery'], expansion: ['expansion'], debt_refinance: ['debt_refinance'] };
        const accountMap = { current: ['current_account', 'both'], savings: ['savings_account', 'both'], both: ['both'] };
        const disagreements = [];
        if (!r.turns) { r.atoms = { summary: d.postCallAnalytics?.summary, metrics: m, recording: d.recordingUrl || null, duration: d.duration, disconnection: d.disconnectionReason, disagreements, note: 'No decision log for this call (made before logging, or not from this page).' }; return r; }
        if (m.loan_amount_inr && f.requested_amount?.raw && Number(m.loan_amount_inr) !== Number(f.requested_amount.raw)) disagreements.push({ field: 'requested_amount', atoms: m.loan_amount_inr, jev: f.requested_amount.raw });
        if (m.loan_amount_inr && !f.requested_amount) disagreements.push({ field: 'requested_amount', atoms: m.loan_amount_inr, jev: null });
        if (purposeMap[m.loan_purpose] && f.loan_purpose?.raw && !purposeMap[m.loan_purpose].includes(f.loan_purpose.raw)) disagreements.push({ field: 'loan_purpose', atoms: m.loan_purpose, jev: f.loan_purpose.raw });
        if (accountMap[m.bank_account_type] && f.bank_account && !accountMap[m.bank_account_type].some((a) => String(f.bank_account.value).toLowerCase().includes(a.split('_')[0]))) disagreements.push({ field: 'bank_account', atoms: m.bank_account_type, jev: f.bank_account.value });
        r.atoms = { summary: d.postCallAnalytics?.summary, metrics: m, recording: d.recordingUrl || null, duration: d.duration, disconnection: d.disconnectionReason, disagreements };
      }
    }
    return r;
  },

  'POST /api/archive': async (req) => {
    const { session } = await readJson(req);
    archiveSoon(session);
    return { scheduled: !!session };
  },

  // Full history of one call: what the agent and owner said (Atoms transcript), with
  // what Jev extracted from each owner line. Saved copy first, live Atoms as fallback.
  'GET /api/history': async (req) => {
    const session = new URL(req.url, 'http://x').searchParams.get('session');
    let call = readCall(session);
    if (!call && /^CALL-/.test(session || '')) {
      call = await fetchAtomsCall(session);
      if (call && call.status !== 'in_progress') saveCall({ ...call, final: review(session).final });
    }
    const turns = readLog({ session, limit: 1000 }).filter((r) => r.type === 'turn');
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const lines = (call?.transcript || []).map((l) => {
      if (l.role !== 'owner') return l;
      const t = turns.find((x) => norm(x.heard) === norm(l.text));
      return { ...l, extracted: t?.applied || null, decided: !!t };
    });
    return { session, saved: !!readCall(session), call: call ? { ...call, transcript: undefined } : null, lines };
  },

  'POST /api/labels': async (req) => {
    const b = await readJson(req);
    if (!b.session || !b.heard || !b.field) throw Object.assign(new Error('session, heard and field are required'), { status: 400 });
    return addLabel({ session: b.session, turn_ts: b.turn_ts, agent_question: b.agent_question || null, heard: b.heard, field: b.field, expected: b.expected ?? '', verdict: b.verdict || 'wrong', note: b.note || '' });
  },
  'GET /api/labels': async () => readLabels(),

  // Decision log for reviewing and improving the agent.
  'GET /api/logs': async (req) => {
    const u = new URL(req.url, 'http://x');
    const session = u.searchParams.get('session');
    return session ? readLog({ session, limit: 1000 }) : { sessions: sessions(), file: LOG_FILE };
  },

  // Stand-in for the lender's LOS / CRM / ERP endpoint.
  'POST /api/push': async (req) => {
    const { target = 'los', application, session = 'api' } = await readJson(req);
    const receipt = {
      status: 201,
      target,
      application_id: `RFL-MSE-${new Date().getFullYear()}-${String(crypto.randomInt(100000, 999999))}`,
      received_at: new Date().toISOString(),
      idempotency_key: crypto.randomUUID(),
    };
    pushed.push({ receipt, application });
    logEntry({ type: 'push', session, target, application_id: receipt.application_id, application });
    archiveSoon(session, 30000);
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
      let speakNow = () => {};
      const counts = {};
      const done = async (result) => {
        try { ws.terminate(); } catch {}
        let log = null;
        if (callId) {
          await new Promise((r) => setTimeout(r, 3000));
          const c = await fetch(`${ATOMS}/conversation/${callId}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
          const d = c.data || c;
          log = { status: d.status, disconnectionReason: d.disconnectionReason ?? d.disconnection_reason, duration: d.duration, transcript: (d.transcript || []).slice(0, 4), errors: d.errors ?? d.error };
        }
        resolve({ ...result, call_id: callId, event_counts: counts, events, agent_audio_seconds: +(audioBytes / 48000).toFixed(1), call_log: log });
      };
      ws.on('unexpected-response', (_, r) => { let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => done({ connected: false, status: r.statusCode, body: b })); });
      ws.on('error', (e) => done({ connected: false, error: e.message }));
      ws.on('open', () => {
        // Stream silence like an idle mic; after the greeting ends, "speak" a recorded
        // Hindi answer, then keep streaming silence and collect what comes back.
        const silence = Buffer.alloc(4800); // 100 ms @ 24 kHz
        const speech = fixturePcm24k();
        let off = -1;
        const tick = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          let chunk = silence;
          if (off >= 0 && off < speech.length) { chunk = speech.subarray(off, off + 4800); off += 4800; }
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
        }, 100);
        speakNow = () => { if (off < 0) off = 0; };
        setTimeout(speakNow, 16000); // fallback if no stop_talking event
        setTimeout(() => { clearInterval(tick); done({ connected: true }); }, 34000);
      });
      ws.on('message', (d) => {
        const e = JSON.parse(d);
        counts[e.type] = (counts[e.type] || 0) + 1;
        if (e.type === 'agent_stop_talking' || e.type === 'agent.stop_talking') setTimeout(() => speakNow(), 600);
        if (e.type === 'output_audio.delta') audioBytes += Buffer.from(e.audio || '', 'base64').length;
        else {
          if (e.type === 'session.created') callId = e.call_id;
          // keep non-delta events and the last delta per role, so the list stays readable
          const isDelta = /delta/.test(e.type);
          if (!isDelta || e.final === true) events.push(JSON.stringify(e).slice(0, 300));
          if (events.length > 40) events.splice(1, 1);
        }
      });
    });
  },
};

// Lightning TTS for Direct mode. Returns 502 on failure so the browser falls back
// to its own speech synthesis.
async function tts(req, res) {
  const { text, pronunciation = true } = await readJson(req);
  const dict = process.env.PRONUNCIATION_DICT_ID;
  try {
    const r = await fetch('https://api.smallest.ai/waves/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text,
        voice_id: process.env.TTS_VOICE || 'rhea',
        model: process.env.TTS_MODEL || 'lightning_v3.1_pro',
        language: 'hi',
        sample_rate: 24000,
        output_format: 'wav',
        ...(dict && pronunciation ? { pronunciation_dicts: [dict] } : {}),
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

// Sign-in page for the passcode gate (instead of a bare 401).
function signInPage(wrong) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Religare SME Loan Capture</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --ink:#111214; --muted:#74787e; --line:#e7e8ea; --accent:#076533; --bad:#b3261e; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#fff; color:var(--ink); font:16px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; padding:16px; }
  .card { width:min(420px,100%); border:1px solid var(--line); border-radius:14px; padding:28px; }
  img { height:52px; width:auto; display:block; margin-bottom:22px; }
  h1 { font-size:20px; margin:0 0 6px; font-weight:600; }
  p { color:var(--muted); margin:0 0 18px; font-size:14px; }
  label { font-size:13px; color:var(--muted); display:block; margin-bottom:6px; }
  input { width:100%; font:inherit; padding:11px 12px; border:1px solid var(--line); border-radius:10px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:14px; width:100%; font:inherit; font-weight:500; padding:11px; border:0; border-radius:999px; background:var(--ink); color:#fff; cursor:pointer; }
  .err { color:var(--bad); font-size:14px; margin:10px 0 0; }
</style></head><body>
<form class="card" method="get" action="/">
  <img src="/religare-logo.png" alt="Religare SME Loans">
  <h1>SME loan capture demo</h1>
  <p>Enter the demo passcode. This browser stays signed in for 7 days.</p>
  <label for="key">Passcode</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  ${wrong ? '<div class="err">That passcode is not right. Check it and try again.</div>' : ''}
  <button type="submit">Open demo</button>
</form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (url.pathname === '/religare-logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(path.join(ROOT, 'public/religare-logo.png')).pipe(res);
  }
  if (PASS && url.searchParams.get('key') === PASS) {
    res.writeHead(302, { 'Set-Cookie': `demo_key=${PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, Location: '/' });
    return res.end();
  }
  if (!authed(req)) {
    if (url.pathname.startsWith('/api/') || req.headers.upgrade) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Passcode required' }));
    }
    const wrong = url.searchParams.has('key');
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(signInPage(wrong));
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
  if (url.pathname === '/api/logs.jsonl') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="religare-demo-turns.jsonl"' });
    return res.end(readLog({ limit: 100000 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
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
