// Decision log: one JSON line per owner turn (what Pulse heard → what Jev decided →
// what the form got) and one per pushed application. Written to LOG_DIR/turns.jsonl
// (point LOG_DIR at a persistent disk in production) and echoed to stdout with a
// "[turn]" prefix so the host's log stream has a copy too.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.LOG_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'turns.jsonl');
const MAX_MEMORY = 3000;
let memory = [];

try {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    memory = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-MAX_MEMORY).map((l) => JSON.parse(l));
  }
} catch (e) {
  console.warn('[turnlog] cannot use', DIR, e.message);
}

export function logEntry(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  memory.push(line);
  if (memory.length > MAX_MEMORY) memory = memory.slice(-MAX_MEMORY);
  try { fs.appendFileSync(FILE, JSON.stringify(line) + '\n'); } catch {}
  console.log('[turn]', JSON.stringify(line));
  return line;
}

// Compact form of one processTurn call, for review.
export function summarizeTurn({ session = 'api', engine = 'api', turn, utterance, history }, result, error) {
  const lastAgent = [...(history || [])].reverse().find((t) => t.role === 'agent')?.text || null;
  if (error) return { type: 'turn', session, engine, turn, agent_question: lastAgent, heard: utterance, error: String(error.message || error) };
  const j = result.jev || {};
  const decisions = Object.fromEntries(Object.entries(j.answers || {}).map(([k, a]) => [
    k,
    a.type === 'noul' ? { yes: a.noul } : { pick: a.choice, p: a.probabilities?.[a.choice] },
  ]));
  return {
    type: 'turn',
    session,
    engine,
    turn,
    agent_question: lastAgent,
    heard: utterance,
    romanized: j.romanized || null,
    candidates: j.candidates,
    decisions,
    applied: Object.fromEntries((result.changes || []).map((f) => [f, { value: result.form[f]?.display, raw: result.form[f]?.value ?? null, p: result.form[f]?.confidence, confirm: result.form[f]?.confirm }])),
    concern: result.concern,
    consent: result.consent,
    missing_after: result.missing,
    jev_ms: j.latency_ms,
    cost_usd: j.cost_usd,
  };
}

export function readLog({ session, limit = 500 } = {}) {
  const rows = session ? memory.filter((r) => r.session === session) : memory;
  return rows.slice(-limit);
}

export function sessions() {
  const by = new Map();
  for (const r of memory) {
    if (!r.session) continue;
    const s = by.get(r.session) || { session: r.session, engine: r.engine, started: r.ts, last: r.ts, turns: 0, filled: 0, pushed: false, errors: 0, misses: 0 };
    s.last = r.ts;
    if (r.type === 'turn') {
      s.turns++;
      if (r.error) s.errors++;
      if (r.applied && Object.keys(r.applied).length === 0 && /\d|lakh|crore|लाख|करोड़|साल|saal/i.test(r.heard || '')) s.misses++;
      if (r.missing_after) s.filled = 14 - r.missing_after.length;
    }
    if (r.type === 'push') s.pushed = true;
    by.set(r.session, s);
  }
  return [...by.values()].reverse();
}

// Human labels: "this turn should have produced X". Pulled into the regression set.
const LABELS = path.join(DIR, 'labels.jsonl');

export function addLabel(label) {
  const line = { ts: new Date().toISOString(), ...label };
  try { fs.appendFileSync(LABELS, JSON.stringify(line) + '\n'); } catch {}
  console.log('[label]', JSON.stringify(line));
  return line;
}

export function readLabels() {
  try { return fs.readFileSync(LABELS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// What a reviewer should look at for one session.
export function review(session) {
  const rows = readLog({ session, limit: 1000 });
  const turns = rows.filter((r) => r.type === 'turn');
  const final = {};
  for (const t of turns) for (const [f, v] of Object.entries(t.applied || {})) final[f] = { ...v, turn_ts: t.ts, heard: t.heard };
  const lastMissing = [...turns].reverse().find((t) => t.missing_after)?.missing_after || [];
  const numberish = /\d|lakh|crore|लाख|करोड़|हज़ार|साल|saal|hazaar/i;
  return {
    session,
    turns: turns.length,
    filled: Object.keys(final).length,
    final,
    missing: lastMissing,
    low_confidence: Object.entries(final).filter(([, v]) => v.confirm).map(([f, v]) => ({ field: f, value: v.value, p: v.p, heard: v.heard })),
    possible_misses: turns.filter((t) => !t.error && !Object.keys(t.applied || {}).length && numberish.test(t.heard || '')).map((t) => ({ ts: t.ts, heard: t.heard, agent_question: t.agent_question })),
    errors: turns.filter((t) => t.error).map((t) => ({ ts: t.ts, heard: t.heard, error: t.error })),
    borrower_questions: turns.filter((t) => t.concern).map((t) => ({ heard: t.heard, concern: t.concern })),
    pushed: rows.some((r) => r.type === 'push'),
    labels: readLabels().filter((l) => l.session === session),
  };
}

// Call history: the full Atoms record (everything the agent and the owner said, post-call
// metrics, recording) saved next to the decision log, so it outlives Atoms' retention.
const CALLS = path.join(DIR, 'calls.jsonl');

export function saveCall(record) {
  const line = { saved_at: new Date().toISOString(), ...record };
  try { fs.appendFileSync(CALLS, JSON.stringify(line) + '\n'); } catch {}
  console.log('[call]', record.session, (record.transcript || []).length, 'lines');
  return line;
}

export function readCall(session) {
  try {
    const rows = fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return rows.reverse().find((r) => r.session === session) || null;
  } catch { return null; }
}

export const LOG_FILE = FILE;
