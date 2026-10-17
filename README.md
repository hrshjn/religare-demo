# Religare MSE loan capture: live voice demo

People in the audience talk to a Hinglish loan assistant. **Pulse** (Smallest STT) transcribes them live. **Jev** (TypeSafe's decision model, via OpenRouter) decides what each answer means, and the application on the right fills in field by field. The finished application goes to the credit team as JSON (a mock webhook, CRM, LOS or Oracle Fusion target).

```
mic ─▶ /stt (server) ─▶ Pulse streaming STT (language=hi)
                         │ partials → live caption
                         └ finals  → /api/turn
                                      ├ lib/extract.js   code proposes candidates: amounts in lakh/crore,
                                      │                  Hindi number words, years, GSTIN (+checksum),
                                      │                  pincode, banks, name spans; Devanagari → Roman
                                      └ lib/pipeline.js  ONE Jev Decisions call per turn (~20–30 typed
                                                         questions answered in parallel) → field patches
                                                         with probability + evidence
agent voice ◀─ /api/tts (Lightning) ── falls back to the browser's hi-IN voice if TTS fails
```

Jev does not generate text. It answers Choice, Noul (yes/no) and Score questions. That is why code proposes the values (for example "₹40 lakh" or "Ramesh Gupta") and Jev only decides where each one goes ("is ₹40 lakh the loan amount, the turnover, or the EMI?"). Each decision comes with a probability, and anything under 80% is marked **confirm** on screen.

## Access

- **The demo is public.** Anyone with the URL can start a call. Each IP gets hourly limits on the endpoints that spend API credits: 30 calls, 400 Jev turns, 400 TTS requests, 150 speech-to-text streams.
- **The decision log is not public.** `/logs` and the `/api/logs`, `/api/review`, `/api/history`, `/api/labels`, `/api/inbox` and `/api/atoms-check` endpoints hold what callers said, so they need `DEMO_PASSCODE`. Open `/logs`, enter the passcode once, and a cookie keeps that browser signed in for 7 days.

## Deploy (Render)

[Deploy to Render](https://render.com/deploy?repo=https://github.com/hrshjn/religare-demo): Render reads `render.yaml`, asks for `SMALLEST_API_KEY` and `OPENROUTER_API_KEY`, and generates `DEMO_PASSCODE`. When it's live, open `https://<service>.onrender.com/?key=<DEMO_PASSCODE>` once in Chrome; a cookie keeps you signed in for 7 days. Render serves HTTPS, so the microphone works.

## Run it locally

**Quickest:** install Node.js LTS from nodejs.org, then double-click `start-mac.command` (macOS; if it's blocked, right-click → Open) or `start-windows.bat` (Windows). The script installs dependencies on first run, starts the server and opens Chrome at http://localhost:8787.

Manual:

```bash
cp .env.example .env      # add both keys
npm install
npm start                 # http://localhost:8787
```

Open the page in **Chrome on localhost**. The browser only allows microphone access on localhost or HTTPS. For a projector, use full screen at 1920×1080.

| Control | What it does |
|---|---|
| **Start call** | One live mode: the Atoms agent (Rhea voice, Pulse STT) talks to whoever is at the mic and Jev fills the form. If Atoms can't connect, the call carries on automatically with Pulse and the app's own question flow, with no prompt and no choice for the presenter. |
| **Open mic / Push-to-talk** | In a noisy room switch to push-to-talk, then hold **Space** while the person speaks. |
| **Decisions** (or press `d`) | Shows the Jev request behind the latest turn: candidates, every question, probabilities, latency, cost. |
| **Send to credit team** | Shows the JSON payload and a mock `201 Created` receipt. It also fires on its own when the owner gives consent. |

Hover over any filled field to highlight the sentence it came from.

## Read-back confirmation (under 90%)

Any field captured with less than 90% confidence is read back before the agent moves on: "एक बार कन्फ़र्म कर लूँ, बिज़नेस का नाम …, सही है?". Names spelled from Hindi script are capped at 85% because the spelling is a guess, so they are always confirmed.
- **"Haan"** locks the value in at 97% and marks it confirmed.
- **A correction** replaces the value, and the new one is read back if it is still uncertain.
- **"No"** without a new value makes the agent ask for it again.

In Atoms mode, the `get_captured_fields` tool returns `please_confirm`, and the prompt makes Ananya read it back. Each value is confirmed at most once.

## Call history

When an Atoms call ends, the server waits about 20 s for Atoms' post-call analytics, then saves the full record to `LOG_DIR/calls.jsonl`: every line the agent and the owner said with timestamps, the summary, the post-call metrics, the recording link and the final application Jev built. `/logs` shows this as **Conversation**, with what Jev extracted under each owner line. `GET /api/history?session=CALL-…` returns it. A call made before saving existed is fetched live from Atoms and saved the first time it is opened.

## Atoms agent (best-practice config)

`node scripts/create-agent.mjs` writes the whole agent config to the Main branch draft, checks the draft's resolved config, then publishes it. Use `--dry-run` to stop before publishing. It follows docs.smallest.ai/voice-agents:

- **Prompt** goes in `singlePromptConfig.prompt`. `globalPrompt` is read only by workflow-graph agents, so the first version of this agent was silently running the template prompt. The prompt uses sections: Role & Objective, Personality & Tone, Instructions, Conversation Flow, Borrower questions, Close, Guardrails, Tools. It asks one question per turn and repeats amounts and GST or pincode digits back. It is generated from `lib/schema.js`, so it matches Direct mode exactly.
- **Client tool `get_captured_fields`** is defined inline. The agent calls it after the first answer, whenever the owner volunteers several details, and before Close. The page answers with what Jev has already captured, so the agent skips questions that are already answered. The transcript shows "agent checked form".
- **`end_call`** has a specific description (only after Close and goodbye), because the docs warn that vague descriptions cause early hang-ups.
- **Noisy-room speech settings:**
  - denoising on
  - voice detection `confidence 0.78`, `minVolume 0.65`, `releaseTimeInSecs 0.4`
  - smart turn on with a 2 s wait
  - interruptions on with a 1 s backoff
  - user muted until the agent's first line

  If the crowd keeps cutting the agent off, set `allowInterruptions: false`.
- **Redaction off.** It masks names and numbers, which the form needs.
- **Hindi + English** with language switching, the `rhea` voice on Lightning v3.1 Pro only (Indian accent, Hindi-recommended), and the Asia/Kolkata timezone.
- **Five post-call metrics**: loan amount, purpose, bank account type, top borrower concern, consent. Each has a sentinel value ("unknown", 0, false) so a metric can't fail validation and drop the whole result.

## Decision log (for improving the agent)

Every owner turn is logged as one JSON line: session or call id, engine, the agent's question, what Pulse heard, the romanized text Jev saw, the candidates code proposed, Jev's pick and probability for each question, the fields applied, latency and cost. Each "Send to credit team" is logged too, with the full payload.

- **Review:** open `/logs`. Sessions are listed on the left. Amber turns mention a number or duration but changed no field; these are the ones to look at. Red turns hit an error.
- **Export:** `/api/logs.jsonl` downloads everything.
- **Storage:** `LOG_DIR`, which is a 1 GB persistent disk at `/var/data` on Render. Lines are also echoed to the Render log stream with a `[turn]` prefix.
- **Replay a real Atoms call** through the current pipeline: `node test/replay-call.mjs CALL-…`, using the call id from the Atoms dashboard or `/logs`.
- **Review panel:** each session on `/logs` starts with a review: the final application, missing fields, low-confidence fields, possible misses and borrower questions. For Atoms calls it also shows the call recording, Atoms' post-call summary and metrics, and where those disagree with what Jev filled.
- **Flag:** every turn has a Flag button. Pick the field, type what it should have been, and add a note. Flags are saved to `LOG_DIR/labels.jsonl`.
- **Close the loop:** `npm run pull-labels -- https://<host> <passcode>` writes the flags to `test/labeled-cases.json`. `npm test` then runs them with the 36 built-in cases in `test/hard-cases.mjs`. Fix the parser, prompt or Jev question until they pass, then commit the labeled cases.
- **Replay a real call:** `node test/replay-call.mjs CALL-…` re-runs any Atoms call through the current pipeline, including calls made before logging existed.

## Pronunciation

The Hindi voice says Latin-script terms badly ("religar"). Three layers fix this:
1. The prompt tells the agent to write replies in Devanagari, with fixed spellings for brand and finance terms (रेलिगेयर फिनवेस्ट, आई टी आर, जी एस टी, ई एम आई, उद्यम, सिबिल).
2. The same terms are set as the agent's `pronunciationDicts`.
3. Direct-mode TTS sends a Lightning pronunciation dictionary (`PRONUNCIATION_DICT_ID`).

The list lives in `lib/schema.js → PRONUNCIATIONS`. `node test/pronounce-check.mjs <host> <passcode> "<text>"` speaks a line with and without the dictionary and transcribes both with Pulse, for a quick A/B.

## Measured (this build, Oct 17 2026)

- **Real audio (synthetic Hindi voice) → Pulse `hi` → Jev**: all 14 fields filled on the kirana script (`test/audio-e2e.mjs`). Jev took 105–375 ms per turn. The first Pulse partial arrived about 1.2 s after audio started.
- **Text-only scripts** (`node test/script-run.mjs kirana|devanagari|english`): median Jev latency about 140 ms, about **$0.0014 for a whole 14-turn call**.
- **Pulse `en` mangles Hindi speech** ("Mujhipachas Lakchahi"). Use `hi`: it returns Devanagari with English words left in Latin ("सेविन्स account"), and `lib/extract.js` transliterates that.
- **Pulse `north_indic` returned no transcript** from this machine, so it is not offered in the engine list.

## Known issues

1. **Smallest TTS was down from this environment**: every `POST /waves/v1/tts` returned `400 {"error":"Client network socket disconnected before secure TLS connection was established"}` (e.g. x-request-id `ad4fb2b6-7e85-43da-9aa2-bae9e46997b1`). Direct mode falls back to the browser voice. Check this from your own network before the demo; Lightning sounds much better.
2. **Atoms web calls fail from Claude's build container but work from Render** (verified Oct 17: greeting, Hindi answer transcribed, amount read back). The earlier failures were that container's proxy. Separately, a timezone `offset` of 330 broke every call ("offset must be strictly between -24h and 24h"), because the runtime reads the offset in hours. It is now 5.5. Before that was understood, this note said: Atoms web call was refused from this environment: `wss://api.smallest.ai/atoms/v1/agent/connect?token=wct_…` returned `401 Unauthorized: No tokens provided` from both the official browser SDK (v0.4.0) and a raw WebSocket. `register-call` succeeded. Agent `6ad32773e1ae60d96042155b` exists and uses Pulse STT. If Atoms works from your network, choose *Atoms voice agent* in the engine select. If it fails, the app offers to switch to Direct mode.
3. **Policy numbers** (unsecured loans up to ₹40 lakh, 3+ years of trading for secured loans) come from Religare Finvest product pages written before the 2025 relaunch. Confirm them with Religare. They live in `lib/schema.js → POLICY`.
4. **The borrower-question answers** in `lib/schema.js → CONCERNS` are deliberately neutral (no approvals, amounts or rates). Have Religare sign off on the wording.

## Files

- `lib/schema.js` holds the fields, the agent's Hinglish script, the borrower-question replies and the policy thresholds. Edit this file to change the conversation. `scripts/create-agent.mjs` builds the Atoms prompt from it.
- `lib/extract.js` generates candidates deterministically: Indian number formats, Hindi number words and ranges ("bees pachchis hazaar" = up to ₹25k), spoken GSTIN with checksum, Devanagari transliteration.
- `lib/pipeline.js` builds the Jev request, applies the answers, composes the visible fields, and computes the indicative credit-team routing.
- `server.js` serves the static app, `/api/turn`, `/api/tts`, `/api/call-token`, `/api/push`, and `/stt` (a WebSocket proxy to Pulse that keeps the API key on the server).
- `public/` holds the presenter UI.
- `test/` holds scripted conversations, the audio end-to-end run and an Atoms smoke test.

## Keys

Both API keys were pasted into a chat to build this. **Rotate them after the demo.** They are read only from `.env`, which git ignores, and never reach the browser.
