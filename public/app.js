// Browser side.
//   Direct mode: our scripted Hinglish agent speaks (Lightning TTS, browser voice as
//     fallback), the owner answers into the mic, Pulse streams the transcript,
//     and each final owner turn goes to /api/turn (candidates + one Jev call).
//   Atoms mode:  an Atoms voice agent runs the conversation; its final user
//     transcripts go to the same /api/turn.

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let CFG = null;

const REHEARSAL = [
  'Mujhe pachas lakh chahiye. Nahi nahi, chalis lakh kar dijiye.',
  'Diwali ke liye stock lena hai, maal bharna hai dukaan mein.',
  'Mera naam Ramesh Gupta hai, Gupta General Store naam se dukaan hai.',
  'Kirana ki wholesale aur retail dono, Lucknow mein. Pincode two two six zero one six.',
  'Akela hi chalata hoon, proprietor hoon.',
  'Barah saal ho gaye.',
  'Mahine ka lagbhag aath lakh ka maal bikta hai.',
  'Savings account hai SBI mein. Savings account se chalega na?',
  'GST hai, Udyam ka pata nahi.',
  'Haan, teen saal se ITR bharta hoon.',
  'Bajaj se ek loan hai, pandrah hazaar EMI jaati hai.',
  'Dukaan kiraye ki hai, par ghar apna hai.',
  'Bees pachchis hazaar tak de sakta hoon. Rate kitna lagega?',
  'Haan ji, bhej dijiye.',
];

const S = {
  history: [], form: {}, fresh: new Set(), assessment: null, concerns: [],
  queue: Promise.resolve(),
  running: false, mode: 'direct', ptt: false, submitted: false,
  askCount: {}, step: null, awaitingConsent: false,
  lastJev: null, jevTurns: 0, callId: null,
  agent: null, mic: null, listenCtl: null, rehearsing: false, speakingAudio: null,
};

// ---------------- rendering ----------------

function renderGrid() {
  const g = $('#grid');
  g.innerHTML = '';
  for (const [key, label, wide] of CFG.fields) {
    const f = S.form[key];
    const el = document.createElement('div');
    el.className = `field ${wide || ''} ${S.fresh.has(key) ? 'fresh flash' : ''}`;
    el.innerHTML = `<div class="label"><span>${label}</span></div><div class="value ${f ? '' : 'empty'}"></div><div class="meta"></div>`;
    el.querySelector('.value').textContent = f ? f.display : '—';
    if (f) {
      const meta = el.querySelector('.meta');
      const chip = (cls, html) => meta.insertAdjacentHTML('beforeend', `<span class="chip-s ${cls}">${html}</span>`);
      el.querySelector('.label').insertAdjacentHTML('beforeend', `<span class="conf ${f.confirm ? 'warn' : ''}">${f.confirm ? 'confirm · ' : ''}${pct(f.confidence)}</span>`);
      if (f.previous && f.previous !== f.display) chip('', `was <s>${esc(f.previous)}</s>`);
      el.addEventListener('mouseenter', () => highlightTurn(f.turn));
      el.addEventListener('mouseleave', () => highlightTurn(null));
    }
    g.append(el);
  }
  // Credit-team summary
  const a = S.assessment;
  $('#summary').innerHTML = `<div class="label">For credit team · indicative, not a decision</div>
    <div class="value ${a?.track ? '' : 'empty'}">${esc(a?.track || '—')}</div>
    <div class="meta">${(a?.flags || []).map((f) => `<span class="chip-s ${f.level}">${esc(f.t)}</span>`).join('')}${
      S.concerns.map((c) => `<span class="chip-s ask">${esc(c)}</span>`).join('')}</div>`;

  const missing = CFG.fields.filter(([k]) => !S.form[k]);
  const chips = $('#chips');
  chips.innerHTML = missing.slice(0, 4).map(([, l]) => `<span class="chip">${l}</span>`).join('') +
    (missing.length > 4 ? `<span class="chip">+${missing.length - 4} more</span>` : '') +
    (!missing.length ? '<span class="chip done">All fields captured</span>' : '');

  $('.needed').classList.toggle('hidden', !missing.length);
  const filled = CFG.fields.length - missing.length;
  const badge = $('#appBadge');
  badge.className = 'badge ' + (S.submitted ? 'submitted' : !missing.length ? 'complete' : filled ? 'capturing' : '');
  badge.textContent = S.submitted ? 'Submitted' : !missing.length ? 'Complete' : filled ? `Capturing · ${filled}/${CFG.fields.length}` : 'Waiting';
  $('#btnPush').disabled = filled < 4;
}

function addTurn(role, text) {
  const t = $('#transcript');
  t.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `turn ${role}`;
  el.dataset.idx = S.history.length;
  el.innerHTML = `<div class="who">${role === 'agent' ? 'Agent' : 'Owner'}</div><div class="txt"></div>`;
  el.querySelector('.txt').textContent = text;
  t.append(el);
  S.history.push({ role, text });
  t.scrollTop = t.scrollHeight;
  if (role === 'owner') setHeadline(text);
  return el;
}

function tag(el, text, cls = '') { el?.querySelector('.who').insertAdjacentHTML('beforeend', `<span class="tag ${cls}">${esc(text)}</span>`); }

function setHeadline(text) {
  const h = $('#headline');
  const first = text.split(/(?<=[.!?।])\s+/).find((s) => /\d|lakh|crore|लाख|करोड़|saal|account|GST|EMI/i.test(s)) || text;
  const line = first.length > 60 ? first.slice(0, 58).trimEnd() + '…' : first;
  h.classList.add('swap');
  setTimeout(() => { h.textContent = `"${line}"`; h.classList.remove('swap'); }, 200);
}

function highlightTurn(idx) {
  document.querySelectorAll('.turn.hl').forEach((e) => e.classList.remove('hl'));
  if (idx == null) return;
  const el = document.querySelector(`.turn[data-idx="${idx}"]`);
  if (el) { el.classList.add('hl'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function setState(cls, text) {
  const s = $('#callState');
  s.className = `state ${cls}`;
  s.querySelector('b').textContent = text;
}

function showLive(role, text) {
  const l = $('#live');
  if (!text) { l.classList.add('hidden'); return; }
  l.classList.remove('hidden');
  l.querySelector('.who').textContent = role === 'agent' ? 'Agent' : 'Owner';
  l.querySelector('.txt').textContent = text;
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
}

function setLevel(v) { $('#meter').style.setProperty('--lvl', Math.min(1, v * 3).toFixed(2)); }

// ---------------- Jev turn processing ----------------

async function processOwner(text) {
  const turnIdx = S.history.length;
  const el = addTurn('owner', text);
  const history = S.history.slice(0, turnIdx);
  let result = null;
  S.queue = S.queue.then(async () => {
    try {
      const r = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterance: text, history, form: S.form, turn: turnIdx }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      S.form = r.form;
      S.fresh = new Set(r.changes);
      S.assessment = r.assessment;
      if (r.concern_label && !S.concerns.includes(r.concern_label)) S.concerns.push(r.concern_label);
      S.lastJev = { ...r.jev, utterance: text };
      S.jevTurns++;
      if (r.corrected) tag(el, 'correction');
      if (r.concern_label) tag(el, r.concern_label, 'ask');
      renderGrid();
      renderJev();
      result = r;
    } catch (e) {
      console.error(e);
      tag(el, 'decision layer error', 'bad');
    }
  });
  await S.queue;
  return result;
}

function renderJev() {
  const j = S.lastJev;
  if (!j) return;
  $('#jevMeta').textContent = `${j.model} · ${j.latency_ms} ms · ${j.input_tokens ?? '?'} input tokens · $${(j.cost_usd ?? 0).toFixed(6)} · turn ${S.jevTurns}`;
  const cands = j.candidates.map((c) => `<span class="chip-s">${c.id} · ${esc(c.kind)} · ${esc(c.text)}</span>`).join('') || '<span class="muted">none</span>';
  let html = `<div class="muted small">Owner said</div><div style="margin:2px 0 6px">${esc(j.utterance)}</div>
    ${j.romanized ? `<div class="muted small">Romanised for the decision layer</div><div style="margin:2px 0 6px">${esc(j.romanized)}</div>` : ''}
    <div class="muted small">Candidates proposed by code</div><div class="cands">${cands}</div>
    <div class="muted small">Questions answered by Jev in one request</div>`;
  const entries = Object.entries(j.answers || {}).sort(([, a], [, b]) => interesting(b) - interesting(a));
  for (const [k, a] of entries) {
    if (a.type === 'noul') {
      html += `<div class="q"><div class="qa"><span class="qk">${esc(k)}</span><span class="pick">${a.noul >= 0.5 ? 'yes' : 'no'} · ${pct(a.noul)}</span></div>
        <div class="bars"><div class="barrow top"><span class="t">p(yes)</span><span class="b"><i style="width:${pct(a.noul)}"></i></span><span>${pct(a.noul)}</span></div></div></div>`;
    } else {
      const probs = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
      html += `<div class="q"><div class="qa"><span class="qk">${esc(k)}</span><span class="pick">${esc(a.choice)}</span></div><div class="bars">${
        probs.map(([o, p]) => `<div class="barrow ${o === a.choice ? 'top' : ''}"><span class="t">${esc(o)}</span><span class="b"><i style="width:${pct(p)}"></i></span><span>${pct(p)}</span></div>`).join('')
      }</div></div>`;
    }
  }
  $('#jevBody').innerHTML = html;
}
// Show decisions that picked something before the "not mentioned" ones.
const interesting = (a) => (a.type === 'noul' ? 0.5 : ['not_mentioned', 'none', 'other'].includes(a.choice) ? 0 : 1);

// ---------------- agent voice (Direct mode) ----------------

let voices = [];
const loadVoices = () => { voices = speechSynthesis.getVoices(); };
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

async function speak(text) {
  if (S.rehearsing) {
    // Rehearsal is silent: agent lines are shown, not spoken.
    addTurn('agent', text);
    setState('agent', 'Agent');
    return sleep(600 + text.length * 12);
  }
  addTurn('agent', text);
  setState('agent', 'Agent speaking');
  showLive(null, '');
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error('tts ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    await new Promise((res, rej) => {
      const a = new Audio(url);
      S.speakingAudio = a;
      a.onended = res; a.onerror = rej;
      a.play().catch(rej);
    });
  } catch {
    await browserSpeak(text);
  } finally {
    S.speakingAudio = null;
  }
}

function browserSpeak(text) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window)) return setTimeout(res, 400 + text.length * 45);
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => /hi[-_]IN/i.test(x.lang)) || voices.find((x) => /en[-_]IN/i.test(x.lang));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'hi-IN';
    u.rate = 1.02;
    u.onend = res; u.onerror = res;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(res, 2500 + text.length * 90); // safety: some browsers never fire onend
  });
}

// ---------------- mic + Pulse (Direct mode) ----------------

async function openMic() {
  if (S.mic) return S.mic;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/mic-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-capture');
  src.connect(node);
  S.mic = { stream, ctx, node, sink: null };
  node.port.onmessage = (e) => { setLevel(e.data.level); S.mic.sink?.(e.data.pcm); };
  return S.mic;
}

function closeMic() {
  if (!S.mic) return;
  S.mic.stream.getTracks().forEach((t) => t.stop());
  S.mic.ctx.close();
  S.mic = null;
  setLevel(0);
}

// Listen for one owner turn. Resolves with the final text ('' if nothing heard).
// Open mic: the turn ends ~1.3 s after Pulse's last final with no new speech.
// Push-to-talk: the turn ends when Space / the button is released.
function listenOnce() {
  return new Promise(async (resolve) => {
    const mic = await openMic();
    const lang = $('#engine').value.split(':')[1] || CFG.pulseLanguage;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stt?language=${lang}`);
    ws.binaryType = 'arraybuffer';
    const finals = [];
    let partial = '', done = false, endTimer = null, idleTimer = null, maxTimer = null, stopped = false;
    const finish = () => {
      if (done) return;
      done = true;
      mic.sink = null;
      clearTimeout(endTimer); clearTimeout(idleTimer); clearTimeout(maxTimer);
      try { ws.close(); } catch {}
      showLive(null, '');
      S.listenCtl = null;
      resolve(finals.join(' ').replace(/\s+/g, ' ').trim());
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      mic.sink = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      setTimeout(finish, 2500); // never hang if is_last doesn't arrive
    };
    S.listenCtl = { stop, cancel: finish };
    const live = () => showLive('owner', [...finals, partial].join(' ').trim() || '…');

    ws.onopen = () => {
      setState('live', S.ptt ? 'Hold Space to talk' : 'Listening · speak now');
      if (!S.ptt) {
        mic.sink = (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm);
        // A noisy room can keep Pulse from ever hearing silence; cap the turn.
        maxTimer = setTimeout(stop, 15000);
      }
      idleTimer = setTimeout(() => !finals.length && !partial && stop(), 12000);
    };
    S.listenCtl.talk = (down) => {
      if (down) { mic.sink = (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm); setState('live', 'Listening…'); clearTimeout(idleTimer); }
      else stop();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'partial') { partial = m.text.trim(); if (partial) { clearTimeout(endTimer); clearTimeout(idleTimer); } live(); }
      if (m.type === 'final') {
        if (m.text.trim()) finals.push(m.text.trim());
        partial = '';
        live();
        if (m.last) return finish();
        if (!S.ptt && finals.length) { clearTimeout(endTimer); endTimer = setTimeout(stop, 1300); }
      }
      if (m.type === 'error') { console.warn(m.error); setState('err', 'STT error'); finish(); }
    };
    ws.onerror = () => finish();
    ws.onclose = () => stopped && finish();
  });
}

// ---------------- conversation loop (Direct mode) ----------------

function nextStep() {
  for (const step of CFG.script) {
    const key = step.fields.join('+');
    if ((S.askCount[key] || 0) >= 2) continue;
    if (step.fields.some((f) => !S.form[f])) return { ...step, key };
  }
  return null;
}

async function ownerTurn(text) {
  if (!text) return { r: null };
  return { r: await processOwner(text) };
}

async function runDirect() {
  S.running = true;
  setCallUi(true);
  try {
    if (!S.rehearsing) await openMic();
  } catch (e) {
    alert('Microphone not available: ' + e.message);
    return stopCall();
  }
  let step = nextStep();
  let line = `${CFG.lines.greeting} ${step.say}`;
  S.askCount[step.key] = 1;
  let silentTries = 0;
  while (S.running) {
    await speak(line);
    if (!S.running) break;
    const heard = await (S.rehearsing ? rehearsalLine() : listenOnce());
    if (!S.running) break;
    if (!heard) {
      if (++silentTries >= 2) { line = 'Lagta hai aawaaz nahi aa rahi. Main baad mein call karti hoon. Dhanyavaad!'; await speak(line); break; }
      line = CFG.lines.reask + (S.awaitingConsent ? consentLine() : step.say);
      continue;
    }
    silentTries = 0;
    setState('', 'Thinking…');
    const { r } = await ownerTurn(heard);
    if (!S.running) break;

    if (S.awaitingConsent && r) {
      if (r.consent) { await speak(CFG.lines.submitted); await push(true); break; }
      if (r.consent === false && r.answered) { await speak(CFG.lines.declined); break; }
    }
    const pre = [];
    if (r?.concern && CFG.concerns[r.concern]) pre.push(CFG.concerns[r.concern].reply);
    else if (r?.corrected) pre.push(CFG.lines.ack_correction);
    else if (r?.changes?.length) pre.push(CFG.lines.ack[S.jevTurns % CFG.lines.ack.length]);

    const answeredCurrent = step && step.fields.every((f) => S.form[f]);
    if (!answeredCurrent && step && r && !r.answered && (S.askCount[step.key] || 0) < 2) {
      S.askCount[step.key]++;
      line = [...pre, CFG.lines.reask + step.say].join(' ');
      continue;
    }
    step = nextStep();
    if (step) {
      S.askCount[step.key] = (S.askCount[step.key] || 0) + 1;
      line = [...pre, step.say].join(' ');
    } else {
      S.awaitingConsent = true;
      line = [...pre, consentLine()].join(' ');
    }
  }
  stopCall(true);
}

const consentLine = () => {
  const first = (S.form.applicant_name?.value || '').split(' ')[0];
  return CFG.lines.consent.replace(' {name} ji', first ? ` ${first} ji` : '');
};

// ---------------- Atoms mode ----------------

async function runAtoms() {
  setCallUi(true);
  setState('', 'Connecting…');
  try {
    const tok = await fetch('/api/call-token', { method: 'POST' }).then((r) => r.json());
    if (tok.error) throw new Error(tok.error);
    const agent = new window.AtomsSdk.AtomsAgent({ apiKey: tok.access_token, agentId: tok.agentId });
    S.agent = agent;
    const orig = agent.handleEvent?.bind(agent);
    if (orig) agent.handleEvent = (evt) => {
      if (evt && /delta/.test(evt.type || '') && evt.type !== 'output_audio.delta' && typeof evt.text === 'string') showLive(evt.role === 'user' ? 'owner' : 'agent', evt.text);
      orig(evt);
    };
    agent.on('session_started', (e) => { S.callId = e.call_id; setState('live', 'Live · listening'); });
    agent.on('agent_start_talking', () => setState('agent', 'Agent speaking'));
    agent.on('agent_stop_talking', () => setState('live', 'Live · listening'));
    agent.on('transcript', (e) => {
      showLive(null, '');
      const text = (e.text || '').trim();
      if (!text) return;
      if (e.role === 'user') processOwner(text).then((r) => r?.consent && !S.submitted && push(true));
      else addTurn('agent', text);
    });
    agent.on('session_ended', (e) => { setState('', `Call ended${e?.reason ? ' · ' + e.reason : ''}`); stopCall(true); });
    await agent.connect();
    if (S.ptt) agent.mute();
  } catch (e) {
    console.error(e);
    setState('err', 'Atoms connect failed');
    stopCall(true);
    if (confirm(`Atoms call could not start (${e.message}).\n\nSwitch to Direct mode (Pulse + scripted agent) and start?`)) {
      $('#engine').value = 'direct:' + CFG.pulseLanguage;
      startCall();
    }
  }
}

// ---------------- call controls ----------------

function setCallUi(on) {
  const b = $('#btnCall');
  b.textContent = on ? 'End call' : 'Start call';
  b.classList.toggle('end', on);
  $('#engine').disabled = on;
}

function startCall() {
  reset();
  S.mode = $('#engine').value.startsWith('atoms') ? 'atoms' : 'direct';
  S.mode === 'atoms' ? runAtoms() : runDirect();
}

function stopCall(silent) {
  S.running = false;
  S.rehearsing = false;
  S.listenCtl?.cancel();
  S.speakingAudio?.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  try { S.agent?.disconnect(); } catch {}
  S.agent = null;
  closeMic();
  setCallUi(false);
  $('#btnRehearse').disabled = false;
  if (!silent) setState('', 'Call ended');
  else if (!/ended|failed/.test($('#callState').textContent)) setState('', 'Call ended');
}

function setPtt(on) {
  S.ptt = on;
  const b = $('#btnPtt');
  b.textContent = on ? 'Push-to-talk' : 'Open mic';
  b.classList.toggle('on', on);
  if (S.agent) on ? S.agent.mute() : S.agent.unmute();
}
function talk(down) {
  if (!S.ptt) return;
  $('#btnPtt').classList.toggle('talking', down);
  if (S.agent) { down ? S.agent.unmute() : S.agent.mute(); return; }
  S.listenCtl?.talk?.(down);
}

// ---------------- rehearsal: scripted owner, live agent logic + Jev ----------------

let rehearsalIdx = 0;
async function rehearsalLine() {
  const text = REHEARSAL[rehearsalIdx++];
  if (!text) return '';
  setState('live', 'Rehearsal · scripted owner');
  await sleep(400);
  for (let i = 1; i <= text.length; i += 3) { showLive('owner', text.slice(0, i)); await sleep(16); }
  await sleep(250);
  showLive(null, '');
  return text;
}

async function rehearse() {
  if (S.running) return;
  reset();
  rehearsalIdx = 0;
  S.rehearsing = true;
  S.mode = 'direct';
  $('#btnRehearse').disabled = true;
  await runDirect();
  setState('', 'Rehearsal done');
}

// ---------------- push ----------------

function payload() {
  const f = S.form, v = (k) => f[k]?.value ?? null;
  return {
    schema: 'religare.mse.application/v1',
    channel: { type: 'voice', engine: S.mode === 'atoms' ? 'smallest-atoms' : 'smallest-pulse+jev', call_id: S.callId, language: 'hi-en', captured_at: new Date().toISOString() },
    applicant: { name: v('applicant_name') },
    business: {
      name: f._business_name?.value ?? null,
      industry: f._industry?.value ?? null,
      constitution: v('constitution'),
      city: f._city?.value ?? null,
      state: f._city?.state ?? null,
      pincode: f._pincode?.value ?? null,
      in_business_since: v('vintage'),
      gst_registered: f._gstin ? true : f._gst ? f._gst.value === 'has_gst' : null,
      gstin: f._gstin?.value?.gstin ?? null,
      udyam_registered: f._udyam ? f._udyam.value === 'has_udyam' : null,
    },
    loan: {
      amount_inr: v('requested_amount'),
      purpose: v('loan_purpose'),
      purpose_text: f.loan_purpose?.display ?? null,
      comfortable_emi_inr: f._emi_comfort?.value ?? null,
      preferred_tenure_months: f._tenure?.value ?? null,
    },
    financials: {
      monthly_turnover_inr: f.turnover?.value ?? null,
      bank_account_type: f._account_type?.value ?? null,
      bank: f._account_bank?.value ?? null,
      itr_filed: f._itr ? f._itr.value === 'filed' : null,
      itr_years: f._itr_years?.value ?? null,
    },
    existing_credit: {
      has_loans: f._existing ? f._existing.value === 'has_loans' : (f._existing_emi || f._lender) ? true : null,
      monthly_emi_inr: f._existing_emi?.value ?? null,
      lender: f._lender?.value ?? null,
      outstanding_inr: f._existing_outstanding?.value ?? null,
    },
    security: { property: f._collateral?.value ?? null },
    pre_screen: { ...S.assessment, borrower_questions: S.concerns, note: 'Indicative routing from captured answers. Not a credit decision.' },
    capture_quality: Object.fromEntries(CFG.fields.filter(([k]) => f[k]).map(([k]) => [k, { confidence: f[k].confidence, needs_confirmation: f[k].confirm, evidence: f[k].evidence }])),
    consent_to_share_with_credit_team: S.submitted || null,
  };
}

async function push(fromConsent = false) {
  if (S.submitted && fromConsent) return;
  const target = $('#target').value;
  const tName = $('#target').selectedOptions[0].textContent;
  if (fromConsent) S.submitted = true;
  const body = payload();
  $('#modal').classList.remove('hidden');
  $('#modalTitle').textContent = 'Sending application';
  $('#modalSub').textContent = tName;
  $('#payload').textContent = JSON.stringify(body, null, 2);
  const steps = ['Check required fields, GSTIN checksum and consent', `Map to ${tName.split(' · ')[0]} schema`, 'POST with idempotency key', 'Receipt from target system'];
  const box = $('#steps');
  box.innerHTML = steps.map((s) => `<div class="step"><i></i><span>${s}</span></div>`).join('');
  const els = [...box.children];
  for (let i = 0; i < 3; i++) { els[i].className = 'step run'; await sleep(350); els[i].className = 'step ok'; }
  els[3].className = 'step run';
  const r = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, application: body }) }).then((x) => x.json());
  els[3].className = 'step ok';
  els[3].querySelector('span').textContent = `${r.status} Created · ${r.application_id}`;
  $('#modalTitle').textContent = `Application ${r.application_id}`;
  S.submitted = true;
  renderGrid();
}

// ---------------- wiring ----------------

function reset() {
  Object.assign(S, { history: [], form: {}, fresh: new Set(), assessment: null, concerns: [], submitted: false, lastJev: null, jevTurns: 0, askCount: {}, awaitingConsent: false, callId: null });
  $('#transcript').innerHTML = `<div class="empty"><p>Press <b>Start call</b>. The agent asks in Hinglish; answer however you like — Hindi, English, or both.</p><p class="muted">Try giving amounts in lakh, correcting yourself, or asking "savings account se chalega?"</p></div>`;
  $('#headline').textContent = 'Bolkar business loan apply kijiye.';
  $('#jevBody').innerHTML = ''; $('#jevMeta').textContent = 'No turns yet';
  showLive(null, '');
  setState('idle', 'Not connected');
  renderGrid();
}

async function init() {
  CFG = await fetch('/api/config').then((r) => r.json());
  const eng = $('#engine');
  eng.innerHTML = `
    <option value="direct:hi">Pulse · Hindi</option>
    <option value="direct:en">Pulse · English</option>
    ${CFG.atomsAgentId ? '<option value="atoms">Atoms voice agent</option>' : ''}`;
  eng.value = CFG.defaultEngine === 'atoms' && CFG.atomsAgentId ? 'atoms' : 'direct:' + CFG.pulseLanguage;
  reset();

  $('#btnCall').addEventListener('click', () => (S.running || S.agent ? stopCall() : startCall()));
  $('#btnPtt').addEventListener('click', () => setPtt(!S.ptt));
  $('#btnPtt').addEventListener('pointerdown', () => S.ptt && talk(true));
  $('#btnPtt').addEventListener('pointerup', () => S.ptt && talk(false));
  $('#btnRehearse').addEventListener('click', rehearse);
  $('#btnReset').addEventListener('click', () => { stopCall(true); reset(); });
  $('#btnPush').addEventListener('click', () => push(false));
  $('#btnJev').addEventListener('click', () => $('#drawer').classList.toggle('hidden'));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.drawer, .modal').classList.add('hidden')));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' && S.ptt && !e.repeat) { e.preventDefault(); talk(true); }
    if (e.key === 'd') $('#drawer').classList.toggle('hidden');
    if (e.key === 'Escape') document.querySelectorAll('.drawer, .modal').forEach((x) => x.classList.add('hidden'));
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && S.ptt) talk(false); });
  window.addEventListener('beforeunload', () => stopCall(true));
}

init();
