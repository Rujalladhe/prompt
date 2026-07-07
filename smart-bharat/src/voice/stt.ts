import { config, hasElevenLabs, hasGoogleStt } from "../config.js";
import { googleTranscribe } from "../providers/google-cloud.js";

/**
 * Speech-to-Text across an ordered provider list (config.sttOrder): default Google
 * Cloud STT (Hindi + English alternatives for code-switching) first, then ElevenLabs
 * Scribe (auto-detects language / handles Hinglish in one stream). Both handle mixed
 * speech the browser Web Speech API can't (it needs one language hint up front).
 *
 * External calls → per CLAUDE.md §5 each has a circuit breaker + a defined degraded
 * mode: on missing key / open breaker / failure we move to the next provider, and
 * null means the browser falls back to on-device Web Speech. STT never throws into
 * the request path.
 */

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = "scribe_v1";

// --- circuit breaker (same shape as tts.ts) ---
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
let consecutiveFailures = 0;
let openUntil = 0;
const breakerOpen = (now: number) => now < openUntil;
function recordSuccess() { consecutiveFailures = 0; openUntil = 0; }
function recordFailure(now: number) {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAIL_THRESHOLD) openUntil = now + COOLDOWN_MS;
}

export interface SttResult {
  text: string;
  languageCode: string; // detected language (e.g. "hin"/"eng" or "hi-IN")
  provider: "elevenlabs" | "google";
}

/** Transcribe an audio clip across the configured provider order. null => unavailable. */
export async function transcribe(audio: Buffer, mimeType: string, now = Date.now()): Promise<SttResult | null> {
  for (const provider of config.sttOrder) {
    if (provider === "google" && hasGoogleStt()) {
      const g = await googleTranscribe(audio, mimeType, now);
      if (g && g.text) return { text: g.text, languageCode: g.languageCode, provider: "google" };
    } else if (provider === "elevenlabs" && hasElevenLabs()) {
      const e = await elevenLabsTranscribe(audio, mimeType, now);
      if (e && e.text) return e;
    }
  }
  return null; // degraded mode: browser Web Speech
}

/** ElevenLabs Scribe transcription with its own circuit breaker. */
async function elevenLabsTranscribe(audio: Buffer, mimeType: string, now: number): Promise<SttResult | null> {
  if (breakerOpen(now)) {
    console.warn("[stt] ElevenLabs circuit breaker open — using browser fallback");
    return null;
  }
  try {
    const form = new FormData();
    form.append("model_id", MODEL);
    // Omit language_code on purpose → Scribe auto-detects + handles code-switching.
    form.append("file", new Blob([audio], { type: mimeType || "audio/webm" }), "speech.webm");

    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabsKey }, // let fetch set the multipart boundary
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      recordFailure(now);
      console.warn(`[stt] ElevenLabs Scribe ${r.status}: ${detail.slice(0, 200)} — using browser fallback`);
      return null;
    }
    const data: any = await r.json();
    recordSuccess();
    return { text: (data.text ?? "").trim(), languageCode: data.language_code ?? "", provider: "elevenlabs" };
  } catch (e: any) {
    recordFailure(now);
    console.warn(`[stt] ElevenLabs Scribe failed (${e?.message ?? e}) — using browser fallback`);
    return null;
  }
}
