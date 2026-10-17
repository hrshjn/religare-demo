// Replays a real Atoms call's transcript through the form pipeline, turn by turn.
// Usage: node test/replay-call.mjs CALL-…
import 'dotenv/config';
import { processTurn } from '../lib/pipeline.js';
import { FIELDS } from '../lib/schema.js';
const id = process.argv[2];
const c = await fetch(`https://api.smallest.ai/atoms/v1/conversation/${id}`, { headers: { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}` } }).then((r) => r.json());
const turns = (c.data || c).transcript || [];
let form = {}, history = [];
for (const t of turns) {
  const role = t.role === 'user' ? 'owner' : 'agent';
  if (role === 'agent') { history.push({ role, text: t.content }); continue; }
  const r = await processTurn({ utterance: t.content, history, form, turn: history.length });
  history.push({ role, text: t.content });
  form = r.form;
  console.log(`\nOWNER: ${t.content}\n  roman: ${r.jev.romanized || '-'}\n  cands: ${r.jev.candidates.map((x) => x.kind + ':' + x.text).join(' | ') || '-'}\n  → ${r.changes.map((f) => `${f}=${form[f].display}`).join(' · ') || '(nothing)'}`);
}
console.log('\nMISSING:', FIELDS.filter(([k]) => !form[k]).map(([, l]) => l).join(', ') || 'none');
