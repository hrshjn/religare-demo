// Full path minus the browser: owner WAVs → /stt (Pulse) → /api/turn (Jev), with the kirana agent questions.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { SCRIPTS } from './scripts.mjs';
const dir = process.argv[2];
const agentQs = SCRIPTS.kirana.filter(([r]) => r === 'agent').map(([, t]) => t);
let form = {}, history = [];
for (let i = 0; i < agentQs.length; i++) {
  const f = `${dir}/${String(i + 1).padStart(2, '0')}.wav`;
  const out = execFileSync('node', ['test/stt-files.mjs', 'hi', f]).toString();
  const heard = out.split('→  ')[1]?.trim() || '';
  history.push({ role: 'agent', text: agentQs[i] });
  const r = await fetch(`http://localhost:${process.env.PORT || 8787}/api/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ utterance: heard, history, form, turn: history.length }) }).then((x) => x.json());
  history.push({ role: 'owner', text: heard });
  form = r.form;
  console.log(`\nPULSE: ${heard}\n  jev ${r.jev?.latency_ms}ms concern=${r.concern} consent=${r.consent}  ${r.changes.map((c) => `${c}=${form[c].display}${form[c].confirm ? ' (confirm)' : ''}`).join(' | ')}`);
}
const last = await fetch(`http://localhost:${process.env.PORT || 8787}/api/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ utterance: ' ', form }) });
console.log('\nfilled', Object.keys(form).filter((k) => !k.startsWith('_')).length, '/ 14');
