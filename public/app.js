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

const S = {
  history: [], form: {}, fresh: new Set(), assessment: null, concerns: [],
  queue: Promise.resolve(),
  running: false, mode: 'direct', ptt: false, submitted: false,
  askCount: {}, step: null, awaitingConsent: false,
  lastJev: null, jevTurns: 0, callId: null, session: null,
  agent: null, mic: null, listenCtl: null, speakingAudio: null,
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
        body: JSON.stringify({ utterance: text, history, form: S.form, turn: turnIdx, confirming: S.pendingConfirm, session: S.callId || S.session, engine: S.mode === 'atoms' ? 'atoms' : 'direct:' + CFG.pulseLanguage }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      S.form = r.form;
      S.fresh = new Set(r.changes);
      S.assessment = r.assessment;
      if (r.concern_label && !S.concerns.includes(r.concern_label)) S.concerns.push(r.concern_label);
      S.lastJev = { ...r.jev, utterance: text };
      S.jevTurns++;
      S.toConfirm = r.to_confirm || [];
      if (r.confirm_result === 'confirmed') tag(el, `confirmed ${[].concat(S.pendingConfirm || []).map((c) => c.label).join(' + ')}`);
      S.lastConfirm = S.pendingConfirm;
      S.pendingConfirm = null;
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
    const lang = CFG.pulseLanguage;
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
    await openMic();
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
    const heard = await listenOnce();
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
    else if (r?.changes?.includes('requested_amount')) pre.push(`Ji, ${S.form.requested_amount.display.replace('₹', '')}${r.corrected ? ', update kar diya' : ''}.`);
    else if (r?.corrected) pre.push(CFG.lines.ack_correction);
    else if (r?.changes?.length) pre.push(CFG.lines.ack[S.jevTurns % CFG.lines.ack.length]);

    // Anything captured under 90% (and every name spelled from Hindi script) is read
    // back once before moving on. "Haan" locks it in; a correction replaces it.
    if (r?.confirm_result === 'rejected') {
      line = `Maaf kijiye. Sahi ${spokenLabel(S.lastConfirm?.field)} ek baar phir bata dijiye?`;
      continue;
    }
    const nextConfirm = (r?.to_confirm || []).find((c) => !S.confirmAsked.has(c.field + '|' + c.value));
    if (nextConfirm) {
      S.confirmAsked.add(nextConfirm.field + '|' + nextConfirm.value);
      S.pendingConfirm = nextConfirm;
      line = [...pre, confirmLine(nextConfirm)].join(' ');
      continue;
    }

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

const SPOKEN_LABELS = {
  applicant_name: 'aapka naam', business: 'business ka naam', requested_amount: 'loan amount', turnover: 'turnover',
  existing_emi: 'abhi ki EMI', emi_comfort: 'comfortable EMI', location: 'sheher', vintage: 'business kab se hai',
  gst_udyam: 'GST aur Udyam', bank_account: 'bank account', constitution: 'business ka type', loan_purpose: 'loan ka purpose',
  itr: 'ITR', collateral: 'property',
};
const spokenLabel = (field) => SPOKEN_LABELS[field] || 'yeh detail';
const spokenValue = (c) => c.value.split(' · ')[0].replace(/₹/g, '').replace(' / year', ' saal ka').replace(' / month', ' mahine ka').replace('–', ' se ');
const confirmLine = (c) => `Ek baar confirm kar loon, ${spokenLabel(c.field)} ${spokenValue(c)}. Sahi hai?`;

// Atoms mode: Pulse can split one answer into several finals ("मेरा नाम है animesh।" then
// "raj gaikwad।"). Hold fragments until Ananya starts talking (or 1.5 s of quiet) and send
// them to Jev as one answer, the way Ananya hears them.
function bufferOwner(text) {
  S.ownerBuf.push(text.replace(/[।.]\s*$/, ''));
  clearTimeout(S.ownerTimer);
  S.ownerTimer = setTimeout(flushOwner, 1500);
}
function flushOwner() {
  clearTimeout(S.ownerTimer);
  if (!S.ownerBuf.length) return;
  const text = S.ownerBuf.join(' ').trim();
  S.ownerBuf = [];
  processOwner(text).then((r) => r?.consent && !S.submitted && push(true));
}

// Which field Ananya's latest question is about, so short answers and keyword-less
// read-backs can be tied to it.
const TOPICS = [
  ['business', /बिज़नेस का नाम|बिजनेस का नाम/], ['applicant_name', /शुभ नाम|आपका नाम/], ['loan_purpose', /किस काम/],
  ['location', /शहर/], ['constitution', /प्रोप्राइटरशिप/], ['vintage', /कितने साल/], ['turnover', /टर्नओवर/],
  ['bank_account', /अकाउंट|बैंक/], ['gst_udyam', /जी एस टी|उद्यम/], ['itr', /आई टी आर/], ['existing_emi', /ई एम आई चल|लोन या/],
  ['collateral', /घर, दुकान|सिक्योरिटी/], ['emi_comfort', /कम्फ़र्टेबल|कंफर्टेबल|comfortable/], ['requested_amount', /कितने अमाउंट|कितने लाख|कितना अमाउंट/],
];
function noteTopic(text) {
  const q = text.split(/सही है/).pop();
  // "आपका शुभ नाम क्या है, और बिज़नेस का नाम?" is about the name first: take the earliest topic in the question.
  const hits = TOPICS.map(([f, re]) => [f, q.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  if (hits.length) S.topicField = hits[0][0];
}

// Atoms mode: when Ananya reads a value back ("…सही है?"), remember which field it is,
// so the owner's next "haan" confirms that field in the form.
function noteReadBack(text) {
  if (!/सही है\s*\?|sahi hai\s*\?|कन्फ़र्म|कन्फर्म|confirm/i.test(text)) return;
  // Only the part before the first "सही है" says what is being confirmed
  // ("आपका नाम अनिमेश, सही है? और बिज़नेस का नाम क्या है?" confirms the name).
  text = text.split(/सही है|sahi hai/i)[0];
  // What she actually said back, without the framing ("एक बार कन्फ़र्म कर लूँ, बिज़नेस का नाम …")
  const spoken = text.replace(/एक बार कन्फ़र्म कर लूँ|एक बार कन्फर्म कर लूँ|आपका नाम|आपका शुभ नाम|बिज़नेस का नाम|बिजनेस का नाम|लोन अमाउंट|तो|जी[,]?$/g, ' ').replace(/[,—–]/g, ' ').replace(/\s+/g, ' ').trim();
  const field =
    /बिज़नेस का नाम|बिजनेस का नाम|business ka naam/i.test(text) ? 'business'
    : /टर्नओवर|turnover/i.test(text) ? 'turnover'
    : /कंफर्टेबल|कम्फर्टेबल|comfortable/i.test(text) ? 'emi_comfort'
    : /ई एम आई|EMI/i.test(text) ? 'existing_emi'
    : /नाम|naam/i.test(text) ? 'applicant_name'
    : /साल/i.test(text) && S.topicField === 'vintage' ? 'vintage'
    : /लाख|करोड़|अमाउंट|amount|lakh|crore/i.test(text) ? (['turnover', 'existing_emi', 'emi_comfort'].includes(S.topicField) ? S.topicField : 'requested_amount')
    : S.topicField; // "गुप्ता श्री गुप्ता, सही है?" has no keyword: it is about whatever she last asked
  if (!field) return;
  const item = (f, sp) => ({ field: f, label: (CFG.fields.find(([k]) => k === f) || [f, f])[1], value: S.form[f]?.display || '', spoken: sp });
  // "नाम पुष्पा भट्ट और बिज़नेस का नाम सिद्धार्थ, सही है?" confirms two fields at once.
  const both = text.match(/नाम\s+(.+?)\s+और\s+(?:बिज़नेस|बिजनेस) का नाम\s+(.+)$/);
  S.pendingConfirm = both ? [item('applicant_name', both[1].trim()), item('business', both[2].trim())] : item(field, spoken);
  for (const c of [].concat(S.pendingConfirm)) S.confirmAsked.add(c.field + '|' + c.value);
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
    // SDK 0.4.0 has no hooks for streaming deltas or client tools, so wrap its
    // event handler: show live captions, and answer the agent's
    // get_captured_fields client tool from the form Jev is filling.
    const orig = agent.handleEvent?.bind(agent);
    if (orig) agent.handleEvent = (evt) => {
      if (evt && /delta/.test(evt.type || '') && evt.type !== 'output_audio.delta' && typeof evt.text === 'string') showLive(evt.role === 'user' ? 'owner' : 'agent', evt.text);
      if (evt?.type === 'function_call' && evt.name === 'get_captured_fields') {
        S.queue.then(() => {
          const captured = Object.fromEntries(CFG.fields.filter(([k]) => S.form[k]).map(([k, l]) => [l, S.form[k].display]));
          const missing = CFG.fields.filter(([k]) => !S.form[k]).map(([, l]) => l);
          const please = (S.toConfirm || []).filter((c) => !S.confirmAsked.has(c.field + '|' + c.value)).slice(0, 1);
          for (const c of please) { S.confirmAsked.add(c.field + '|' + c.value); S.pendingConfirm = c; }
          const please_confirm = please.map((c) => ({ field: c.label, value: c.value.split(' · ')[0] }));
          agent.send({ type: 'function_call.result', call_id: evt.call_id, output: JSON.stringify({ captured, missing, please_confirm }) });
          const last = document.querySelector('#transcript .turn:last-child');
          tag(last, please.length ? `agent will confirm ${please[0].label}` : `agent checked form · ${missing.length} missing`, 'ask');
        });
      }
      orig(evt);
    };
    agent.on('session_started', (e) => { S.callId = e.call_id; S.atomsLive = true; setState('live', 'Live · listening'); });
    agent.on('agent_start_talking', () => { flushOwner(); setState('agent', 'Agent speaking'); });
    agent.on('agent_stop_talking', () => setState('live', 'Live · listening'));
    agent.on('transcript', (e) => {
      showLive(null, '');
      const text = (e.text || '').trim();
      if (!text) return;
      if (e.role === 'user') bufferOwner(text);
      else { flushOwner(); addTurn('agent', text); noteTopic(text); noteReadBack(text); }
    });
    agent.on('session_ended', (e) => {
      if (!S.atomsLive || S.mode !== 'atoms') return; // a refused connection: the fallback below takes over
      S.atomsLive = false;
      setState('', `Call ended${e?.reason ? ' · ' + e.reason : ''}`);
      if (S.callId) fetch('/api/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: S.callId }) }).catch(() => {});
      stopCall(true);
    });
    await agent.connect();
    if (S.ptt) agent.mute();
  } catch (e) {
    console.error(e);
    // Fall back to Pulse with the same live mic, without asking the presenter.
    S.atomsLive = false;
    try { S.agent?.disconnect(); } catch {}
    S.agent = null;
    S.mode = 'direct';
    setState('', 'Connecting…');
    runDirect();
  }
}

// ---------------- call controls ----------------

function setCallUi(on) {
  const b = $('#btnCall');
  b.textContent = on ? 'End call' : 'Start call';
  b.classList.toggle('end', on);
}

function startCall() {
  reset();
  // One live mode: the Atoms agent. Pulse + our own question flow only if Atoms is unavailable.
  S.mode = CFG.atomsAgentId && CFG.defaultEngine !== 'direct' ? 'atoms' : 'direct';
  S.mode === 'atoms' ? runAtoms() : runDirect();
}

function stopCall(silent) {
  S.running = false;
  S.listenCtl?.cancel();
  S.speakingAudio?.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  try { S.agent?.disconnect(); } catch {}
  S.agent = null;
  closeMic();
  setCallUi(false);
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
  const r = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, application: body, session: S.callId || S.session }) }).then((x) => x.json());
  els[3].className = 'step ok';
  els[3].querySelector('span').textContent = `${r.status} Created · ${r.application_id}`;
  $('#modalTitle').textContent = `Application ${r.application_id}`;
  S.submitted = true;
  renderGrid();
}

// ---------------- wiring ----------------

function reset() {
  Object.assign(S, { history: [], form: {}, fresh: new Set(), assessment: null, concerns: [], submitted: false, lastJev: null, jevTurns: 0, askCount: {}, awaitingConsent: false, callId: null, ownerBuf: [], ownerTimer: null, pendingConfirm: null, toConfirm: [], confirmAsked: new Set(), session: `web-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}` });
  $('#transcript').innerHTML = `<div class="empty"><p>Press <b>Start call</b>. The agent asks in Hinglish; answer however you like — Hindi, English, or both.</p><p class="muted">Try giving amounts in lakh, correcting yourself, or asking "savings account se chalega?"</p></div>`;
  $('#headline').textContent = 'Bolkar business loan apply kijiye.';
  $('#jevBody').innerHTML = ''; $('#jevMeta').textContent = 'No turns yet';
  showLive(null, '');
  setState('idle', 'Not connected');
  renderGrid();
}

async function init() {
  CFG = await fetch('/api/config').then((r) => r.json());
  reset();

  $('#btnCall').addEventListener('click', () => (S.running || S.agent ? stopCall() : startCall()));
  $('#btnPtt').addEventListener('click', () => setPtt(!S.ptt));
  $('#btnPtt').addEventListener('pointerdown', () => S.ptt && talk(true));
  $('#btnPtt').addEventListener('pointerup', () => S.ptt && talk(false));
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
