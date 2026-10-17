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

## Deploy (Render)

[Deploy to Render](https://render.com/deploy?repo=https://github.com/hrshjn/religare-mse-voice-demo): Render reads `render.yaml`, asks for `SMALLEST_API_KEY` and `OPENROUTER_API_KEY`, and generates `DEMO_PASSCODE`. When it's live, open `https://<service>.onrender.com/?key=<DEMO_PASSCODE>` once in Chrome; a cookie keeps you signed in for 7 days. Render serves HTTPS, so the microphone works.

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
| **Start call** | Direct mode: the scripted Hinglish agent speaks, the mic listens through Pulse, and Jev fills the form. |
| Engine select | `Pulse · Hindi` (default, best for Hinglish), `Pulse · English`, `Atoms voice agent` |
| **Open mic / Push-to-talk** | In a noisy room switch to push-to-talk, then hold **Space** while the person speaks. |
| **Rehearse** | Runs a scripted kirana-owner conversation through the real Jev pipeline, with no mic or voice. Use it as the fallback if the network or mic fails. |
| **Decisions** (or press `d`) | Shows the Jev request behind the latest turn: candidates, every question, probabilities, latency, cost. |
| **Send to credit team** | Shows the JSON payload and a mock `201 Created` receipt. It also fires on its own when the owner gives consent. |

Hover over any filled field to highlight the sentence it came from.

## Measured (this build, Oct 17 2026)

- **Real audio (synthetic Hindi voice) → Pulse `hi` → Jev**: all 14 fields filled on the kirana script (`test/audio-e2e.mjs`). Jev took 105–375 ms per turn. The first Pulse partial arrived about 1.2 s after audio started.
- **Text-only scripts** (`node test/script-run.mjs kirana|devanagari|english`): median Jev latency about 140 ms, about **$0.0014 for a whole 14-turn call**.
- **Pulse `en` mangles Hindi speech** ("Mujhipachas Lakchahi"). Use `hi`: it returns Devanagari with English words left in Latin ("सेविन्स account"), and `lib/extract.js` transliterates that.
- **Pulse `north_indic` returned no transcript** from this machine, so it is not offered in the engine list.

## Known issues

1. **Smallest TTS was down from this environment**: every `POST /waves/v1/tts` returned `400 {"error":"Client network socket disconnected before secure TLS connection was established"}` (e.g. x-request-id `ad4fb2b6-7e85-43da-9aa2-bae9e46997b1`). Direct mode falls back to the browser voice. Check this from your own network before the demo; Lightning sounds much better.
2. **Atoms web call was refused from this environment**: `wss://api.smallest.ai/atoms/v1/agent/connect?token=wct_…` returned `401 Unauthorized: No tokens provided` from both the official browser SDK (v0.4.0) and a raw WebSocket. `register-call` succeeded. Agent `6ad32773e1ae60d96042155b` exists and uses Pulse STT. If Atoms works from your network, choose *Atoms voice agent* in the engine select. If it fails, the app offers to switch to Direct mode.
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
