// Creates or updates the Atoms voice agent that runs the intake conversation.
//   node scripts/create-agent.mjs            → create (first run) or update + publish
//   node scripts/create-agent.mjs --dry-run  → write the draft and print the resolved preview, no publish
//
// Config follows docs.smallest.ai/voice-agents best practices:
//   - prompt in Role / Personality / Instructions / Flow / Guardrails / Tools sections, one question per turn
//   - single-prompt agents read singlePromptConfig.prompt (globalPrompt is only for workflow_graph agents)
//   - noisy-room speech settings: denoising on, stricter VAD, smart turn, short interruption backoff
//   - redaction off (it would mask names and numbers the form depends on)
//   - a client tool so the agent can ask the page what is already captured
//   - a specific end_call description ("vague descriptions cause premature hang-ups")
//   - 5 post-call metrics with sentinel values so no metric fails validation
import 'dotenv/config';
import fs from 'node:fs';
import { SCRIPT, CONCERNS, LINES } from '../lib/schema.js';

const BASE = 'https://api.smallest.ai/atoms/v1';
const H = { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`, 'Content-Type': 'application/json' };
const DRY = process.argv.includes('--dry-run');

const PROMPT = `# Role & Objective
You are Ananya, Religare Finvest's AI loan assistant, on a live web call with the owner of a micro or small business who wants a business loan. Your goal is a complete application for Religare's credit team in under three minutes. A separate system listens to the call and fills the application form; you never read the form back.

# Personality & Tone
- Warm, brisk and respectful, like a helpful branch executive. Use "ji" naturally.
- Speak natural Hinglish: Roman-script Hindi with common English words (loan, EMI, account, GST, turnover). If the owner speaks mostly English, reply mostly in English; if mostly Hindi, mostly Hindi.
- One or two short sentences per reply. Ask exactly one question per turn. Never read out lists or symbols.
- Say amounts in words the Indian way: "chalis lakh rupaye", "do crore". Never say "million".

# Instructions
- Say you are an AI assistant if asked.
- Repeat important values back once in words: the loan amount, and any GST number or pincode, digit by digit ("zero... aath... A...").
- If an answer is unclear, ask once more in simpler words. If still unclear, say "koi baat nahi" and move on.
- If the owner corrects something, say "Ji, update kar diya" and continue.
- If the owner gives several details at once, do not ask for them again.
- If the owner does not know or does not want to say, accept it and move to the next question.

# Conversation Flow
Ask in this order, skipping anything already answered:
${SCRIPT.map((s, i) => `${i + 1}. ${s.say}`).join('\n')}
→ After the last question, go to Close.

# Borrower questions
Answer briefly, then return to the next question:
${Object.values(CONCERNS).map((c) => `- ${c.label.replace(/^Asked: |^Concern: /, '')}: "${c.reply}"`).join('\n')}

# Close
Say: "${LINES.consent('{first name}')}"
→ If they agree: "${LINES.submitted}" Then call end_call.
→ If they decline: "${LINES.declined}" Then call end_call.

# Guardrails
- Never promise approval, a loan amount, an interest rate, an EMI or a timeline. The credit team decides after review.
- Do not ask for Aadhaar, PAN, OTPs, passwords or bank account numbers.
- Stay on the loan application. If asked about something unrelated, say you can only help with the business loan application.

# Tools
## get_captured_fields
- When to use: once after the owner's first answer, any time the owner gives several details in one reply, and once before Close.
- Result handling: the result lists "captured" fields and "missing" fields. Ask only about missing fields, in the Conversation Flow order. Never read the result aloud.
## end_call
- When to use: only after the Close step is finished and you have said goodbye, or if the owner clearly asks to stop the call.`;

const FIRST = `${LINES.greeting} ${SCRIPT[0].say}`;

const POST_CALL = {
  useInternalAnalyticsModel: true,
  useReasoningModel: false,
  dispositionMetrics: [
    { identifier: 'loan_amount_inr', dispositionMetricType: 'INTEGER', dispositionMetricPrompt: 'The loan amount the business owner finally asked for, in Indian rupees as a whole number (1 lakh = 100000, 1 crore = 10000000). If they corrected themselves, use the corrected amount. If never stated, return 0.' },
    { identifier: 'loan_purpose', dispositionMetricType: 'ENUM', choices: ['working_capital', 'machinery', 'expansion', 'debt_refinance', 'other', 'unknown'], dispositionMetricPrompt: 'What the owner said the loan is for. Use unknown if not stated.' },
    { identifier: 'bank_account_type', dispositionMetricType: 'ENUM', choices: ['current', 'savings', 'both', 'unknown'], dispositionMetricPrompt: 'Which type of bank account the business money comes into. Use unknown if not stated.' },
    { identifier: 'top_borrower_concern', dispositionMetricType: 'ENUM', choices: ['savings_account_eligibility', 'how_much_loan', 'emi_or_rate', 'documents', 'credit_score', 'none'], dispositionMetricPrompt: 'The main question or worry the owner raised during the call. Use none if they raised no question.' },
    { identifier: 'consent_given', dispositionMetricType: 'BOOLEAN', dispositionMetricPrompt: 'True only if the owner clearly agreed to send their details to the credit team. False otherwise, including if the call ended before the question was asked.' },
  ],
};

const CONFIG = {
  firstMessage: FIRST,
  singlePromptConfig: {
    prompt: PROMPT,
    // Inline definition: a toolRefs entry to the library copy did not resolve on single-prompt drafts.
    tools: [
      { type: 'client_tool', name: 'get_captured_fields', description: 'Returns the loan-application fields the live form has already captured from this call, and the ones still missing. Use it to skip questions the owner has already answered.', expectsResponse: true, timeoutMs: 2500, fillerPhrases: ['Ek second...'], llmParameters: [] },
      { type: 'end_call', name: 'end_call', enabled: true, description: 'End the call only after the Close step is finished and you have said goodbye, or if the owner clearly asks to stop. Never end the call while questions remain unless the owner asks.' },
    ],
  },
  language: { default: 'hi', supported: ['hi', 'en'], switching: { isEnabled: true, minWordsForDetection: 2, strongSignalThreshold: 0.7, weakSignalThreshold: 0.3, minConsecutiveForWeakThresholdSwitch: 2 } },
  synthesizer: { voiceConfig: { model: 'waves_lightning_v3_1', voiceId: process.env.ATOMS_VOICE_ID || 'srishti', gender: 'female' }, speed: 1.05, sampleRate: 24000 },
  muteUserUntilFirstBotResponse: true,
  waitForUserToSpeakFirst: false,
  allowInterruptions: true,
  interruptionBackoffTimer: 1,
  smartTurnConfig: { isEnabled: true, waitTimeInSecs: 2 },
  voiceDetectionConfig: { confidence: 0.78, minVolume: 0.65, triggerTimeInSecs: 0.2, releaseTimeInSecs: 0.4 },
  denoisingConfig: { isEnabled: true },
  redactionConfig: { isEnabled: false },
  backgroundSound: '',
  // offset is in hours on the runtime (330 "minutes" failed every call: offset must be < 24h)
  timezone: { label: '(GMT+5:30) Asia/Kolkata', offset: 5.5 },
  postCallAnalyticsConfig: POST_CALL,
};

async function j(method, path, data) {
  const r = await fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined });
  const t = await r.text();
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${t.slice(0, 600)}`);
  return parsed;
}

let agentId = process.env.ATOMS_AGENT_ID;
if (!agentId) {
  const res = await j('POST', '/agent', { name: 'Religare MSE Loan Intake (Hinglish demo)', description: 'Live MSE loan intake; the form is filled by a Jev decision layer on the Pulse transcript.' });
  agentId = typeof res.data === 'string' ? res.data : res.data?._id;
  fs.writeFileSync('.env', fs.readFileSync('.env', 'utf8').replace(/\n?ATOMS_AGENT_ID=.*/g, '') + `\nATOMS_AGENT_ID=${agentId}\n`);
  console.log('created agent', agentId);
}

const branches = await j('GET', `/agent/${agentId}/branches`);
const main = branches.data.branches.find((b) => b.branch.isDefault).branch._id;
const draft = await j('PUT', `/agent/${agentId}/branches/${main}/draft`, CONFIG);
const draftId = draft.data.draftId;

// Verify what the draft resolves to before publishing.
const preview = (await j('GET', `/agent/${agentId}?draftId=${draftId}`)).data._resolvedConfig;
const checks = {
  prompt: !!preview.prompt?.startsWith('# Role & Objective'),
  client_tool: (preview.tools || []).some((t) => t.name === 'get_captured_fields'),
  end_call_specific: (preview.tools || []).some((t) => t.type === 'end_call' && /Close step/.test(t.description || '')),
  redaction_off: preview.redactionConfig?.isEnabled === false,
  denoising_on: preview.denoisingConfig?.isEnabled === true,
  metrics: preview.postCallAnalyticsConfig?.dispositionMetrics?.length === POST_CALL.dispositionMetrics.length,
  first_message: preview.firstMessage === FIRST,
};
console.log('draft', draftId, 'checks', checks);
console.log('tools on draft:', (preview.tools || []).map((t) => `${t.type}:${t.name}`).join(', '));
if (!checks.prompt) { console.error('Prompt did not land on the draft; not publishing.'); process.exit(1); }

if (DRY) process.exit(0);
const label = `demo config ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, ' ')}`;
const pub = await j('POST', `/agent/${agentId}/branches/${main}/draft/publish`, { label });
console.log('publish', pub.data?.state, '(security scan runs before it goes live)');
for (let i = 0; i < 60; i++) {
  const live = (await j('GET', `/agent/${agentId}`)).data._resolvedConfig;
  if (live.prompt === PROMPT) { console.log('live: new prompt and settings are serving'); process.exit(0); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('still scanning after 3 minutes; check the dashboard');
