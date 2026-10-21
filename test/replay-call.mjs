// Replays a real Atoms call's transcript through the form pipeline, turn by turn.
// Usage: node test/replay-call.mjs CALL-…
import 'dotenv/config';
import { processTurn } from '../lib/pipeline.js';
import { FIELDS } from '../lib/schema.js';
const id = process.argv[2];
const c = await fetch(`https://api.smallest.ai/atoms/v1/conversation/${id}`, { headers: { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}` } }).then((r) => r.json());
if (!(c.data || c).transcript?.length) { console.error('No transcript returned (retry):', JSON.stringify(c).slice(0, 300)); process.exit(1); }
// Merge consecutive owner lines, as the page does before sending them to Jev.
const turns = [];
for (const t of (c.data || c).transcript || []) {
  const last = turns[turns.length - 1];
  if (t.role === 'user' && last?.role === 'user') last.content = `${last.content.replace(/[।.]\s*$/, '')} ${t.content}`;
  else turns.push({ ...t });
}
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
