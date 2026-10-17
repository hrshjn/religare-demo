// Runs scripted Hinglish conversations through the live Jev pipeline and prints
// the form after each turn. Usage: node test/script-run.mjs [scriptName]
import 'dotenv/config';
import { processTurn } from '../lib/pipeline.js';
import { SCRIPTS } from './scripts.mjs';

const name = process.argv[2] || 'kirana';
let form = {}, history = [], ms = [], cost = 0;
for (const [role, text] of SCRIPTS[name]) {
  if (role === 'agent') { history.push({ role, text }); continue; }
  const r = await processTurn({ utterance: text, history, form, turn: history.length });
  history.push({ role, text });
  form = r.form; ms.push(r.jev.latency_ms); cost += r.jev.cost_usd || 0;
  console.log(`\n> ${text}${r.jev.romanized ? `\n  (romanized: ${r.jev.romanized})` : ''}\n  ${r.jev.latency_ms}ms answered=${r.answered} concern=${r.concern} consent=${r.consent} corrected=${r.corrected}`);
  for (const f of r.changes) console.log(`    ${f.padEnd(17)} ${form[f].display}  (p=${form[f].confidence}${form[f].confirm ? ', CONFIRM' : ''}${form[f].previous ? ', was ' + form[f].previous : ''})`);
}
const r = await import('../lib/pipeline.js').then((m) => m.assess(form));
console.log('\nTRACK:', r.track, '\nFLAGS:', r.flags.map((f) => `${f.level === 'warn' ? '!' : '✓'} ${f.t}`).join(' | '));
console.log('filled:', Object.keys(form).filter((k) => !k.startsWith('_')).length, `· median Jev ${ms.sort((a, b) => a - b)[ms.length >> 1]}ms · total $${cost.toFixed(5)}`);
