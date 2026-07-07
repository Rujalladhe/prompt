# Voice Agent — two tiers

> **Tier 1 (LIVE now): browser mic + ElevenLabs multilingual TTS.**
> Working today with no extra infra. Speech-to-text uses the browser Web Speech
> API; the transcript hits the existing Orchestrator with a `mode:"voice"` prompt
> variant (shorter, speakable); the reply is spoken via ElevenLabs
> `eleven_multilingual_v2` (server `POST /api/voice/chat`, `src/voice/tts.ts`).
> No `ELEVENLABS_API_KEY` → it degrades to on-device `speechSynthesis`.
> Try it: the 🎙️ mic + 🔊 toggle in the Chat panel.
>
> NOTE: CLAUDE.md §3 names **Sarvam AI** as the spec default for ASR/TTS. ElevenLabs
> here is a deliberate operator override; swap `src/voice/tts.ts` to restore Sarvam.
>
> **Tier 2 (scaffold below): LiveKit realtime pipeline** — full VAD/barge-in,
> server-side ASR, IVR/telephony. Same Orchestrator brain, different transport.

## Pipeline (spec §3)
```
audio in ──▶ LiveKit room (VAD + barge-in)
        ──▶ Sarvam ASR ──▶ language / code-switch detection
        ──▶ POST /api/chat  (existing Orchestrator, text)
        ──▶ Sarvam TTS (stream first sentence early)
        ──▶ audio out
```

- **LiveKit Agents** handles turn-taking, voice-activity detection, and barge-in
  (user interrupting mid-response) — do not hand-roll this.
- **Sarvam AI** handles ASR / TTS / translation for Hindi, Hinglish code-switch,
  and Indic languages — the actual hard problem. The Orchestrator already returns
  a `language` tag per turn to drive TTS voice selection.
- **Voice-mode prompt variant**: generate shorter, speakable sentences than text
  mode (long paragraphs read poorly via TTS). Wire this by passing a `mode:"voice"`
  flag into the Orchestrator's generation prompts.
- **IVR fallback** (feature phones): a Twilio/Exotel number hitting the same
  `/api/chat`. Same brain, telephony transport.

## To implement
1. `npm i @livekit/agents @livekit/rtc-node` (+ Sarvam SDK / REST).
2. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SARVAM_API_KEY`.
3. Implement `worker.ts`: join room → Sarvam ASR → call `/api/chat` → Sarvam TTS.
4. Latency budget: sub-2s round trip; stream partial TTS as soon as the first
   sentence of the LLM response is ready.
