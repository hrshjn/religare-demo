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
    applied: Object.fromEntries((result.changes || []).map((f) => [f, { value: result.form[f]?.display, p: result.form[f]?.confidence, confirm: result.form[f]?.confirm }])),
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

export const LOG_FILE = FILE;
