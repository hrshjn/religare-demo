// Creates (or updates) the Atoms voice agent that runs the intake conversation.
// Usage: node scripts/create-agent.mjs   → prints ATOMS_AGENT_ID and writes it to .env
import 'dotenv/config';
import fs from 'node:fs';
import { SCRIPT, CONCERNS, LINES } from '../lib/schema.js';

const BASE = 'https://api.smallest.ai/atoms/v1';
const H = { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`, 'Content-Type': 'application/json' };

// The prompt is generated from lib/schema.js so the Atoms agent and Direct mode
// ask the same questions and give the same compliant answers.
const PROMPT = `## Role
You are Ananya, Religare Finvest's AI loan assistant, on a live call with the owner of a micro or small business who is interested in a business loan. Collect the details below so Religare's credit team gets a complete application. A separate system listens to the call and fills the form; you never read the form back.

## Who you are talking to
Mostly proprietors of small shops, traders and small manufacturers. They care about how much they can get, whether they qualify, and an EMI they can manage. They are not interested in a long business discussion. Keep the whole call under three minutes.

## Language and style
- Speak natural Hinglish (Roman-script Hindi with common English words like loan, EMI, account, GST). Follow the owner: if they speak mostly English, reply mostly in English; if mostly Hindi, reply mostly in Hindi.
- One short question per turn, under 20 words. Never stack questions.
- Say amounts the Indian way: "chalis lakh", "do crore". Use "ji" naturally.
- Say you are an AI assistant if asked.
- No markdown, lists or emojis.

## Questions, in order (skip anything already answered, even if answered early)
${SCRIPT.map((s, i) => `${i + 1}. ${s.say}`).join('\n')}

## When the owner asks something
${Object.values(CONCERNS).map((c) => `- ${c.label.replace(/^Asked: |^Concern: /, '')}: "${c.reply}"`).join('\n')}
- If an answer is unclear, ask once more briefly. If a number sounds odd, confirm it once: "Chalis lakh, sahi?"
- If they correct themselves, say "Ji, update kar diya" and move on.
- If they do not know or do not want to say, that is fine; move to the next question.
- Never promise approval, amount, interest rate or timelines.

## Close
After the last question say: "${LINES.consent('{first_name}').replace('{first_name}', '{first name}')}"
If they agree: "${LINES.submitted}" Then end the call.
If they decline: "${LINES.declined}" Then end the call.`;

const FIRST = `${LINES.greeting} ${SCRIPT[0].say}`;

const body = {
  name: 'Religare MSE Loan Intake (Hinglish demo)',
  description: 'Live SME working-capital intake demo. Form is filled by a Jev decision layer on the Pulse transcript.',
  globalPrompt: PROMPT,
  firstMessage: FIRST,
  language: { default: 'hi', supported: ['hi', 'en'], switching: { isEnabled: true } },
  synthesizer: { voiceConfig: { model: 'waves_lightning_v3_1', voiceId: process.env.ATOMS_VOICE_ID || 'srishti', gender: 'female' }, speed: 1, sampleRate: 24000 },
  allowInterruptions: true,
  backgroundSound: '',
};

async function j(method, path, data) {
  const r = await fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined });
  const t = await r.text();
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${t.slice(0, 500)}`);
  return parsed;
}

let agentId = process.env.ATOMS_AGENT_ID;
if (!agentId) {
  const res = await j('POST', '/agent', body);
  agentId = typeof res.data === 'string' ? res.data : res.data?._id || res.data?.id;
  console.log('created agent', agentId);
  const env = fs.readFileSync('.env', 'utf8');
  fs.writeFileSync('.env', env.replace(/\n?ATOMS_AGENT_ID=.*/g, '') + `\nATOMS_AGENT_ID=${agentId}\n`);
} else {
  // Existing agent: push prompt changes through the Main branch draft → publish.
  const br = await j('GET', `/agent/${agentId}/branches`);
  const main = br.data.branches.find((b) => b.branch.isDefault).branch._id;
  const { name, description, ...cfg } = body;
  await j('PUT', `/agent/${agentId}/branches/${main}/draft`, cfg);
  const pub = await j('POST', `/agent/${agentId}/branches/${main}/draft/publish`, { label: 'demo update' });
  console.log('published', pub.data?.state);
}

const a = await j('GET', `/agent/${agentId}`);
console.log(JSON.stringify({ id: agentId, name: a.data.name, voice: a.data.synthesizer?.voiceConfig, transcriber: a.data.transcriberType, firstMessage: a.data.firstMessage, promptChars: (a.data.globalPrompt || a.data._versionedWorkflow?.prompt || '').length }, null, 1));
