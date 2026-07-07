import { config, hasElevenLabs, hasGoogleTts } from "../config.js";
import { googleSynthesize } from "../providers/google-cloud.js";

/**
 * Text-to-Speech with an ordered list of providers (config.ttsOrder), default
 * Google Cloud TTS first (Indic-native voices) then ElevenLabs multilingual, then
 * the browser's on-device speechSynthesis. Every provider is an EXTERNAL call, so
 * per CLAUDE.md §5 each is wrapped in a circuit breaker with a defined degraded
 * mode: when a provider's key is missing / breaker is open / call fails we move to
 * the next, and null means "no server audio — browser TTS". Voice output is a
 * convenience layer — it must never take the whole turn down.
 */

const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const VOICES_ENDPOINT = "https://api.elevenlabs.io/v1/voices";
const MAX_CHARS = 800; // keep latency and free-tier character spend bounded

// The configured voice can be unusable on the current plan (free-tier API rejects
// Voice Library voices with 402 "cannot use library voices"). We resolve to a
// usable "premade" voice once and cache it, so a bad ELEVENLABS_VOICE_ID self-heals
// instead of permanently degrading to browser TTS.
let resolvedVoiceId = "";
let triedResolve = false;

async function usablePremadeVoiceId(): Promise<string | null> {
  try {
    const r = await fetch(VOICES_ENDPOINT, { headers: { "xi-api-key": config.elevenLabsKey } });
    if (!r.ok) return null;
    const data: any = await r.json();
    const premade = (data.voices ?? []).find((v: any) => v.category === "premade");
    return premade?.voice_id ?? data.voices?.[0]?.voice_id ?? null;
  } catch {
    return null;
  }
}

// --- tiny circuit breaker: after N consecutive failures, stop calling for a cooldown ---
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
let consecutiveFailures = 0;
let openUntil = 0;

function breakerOpen(now: number) {
  return now < openUntil;
}
function recordSuccess() {
  consecutiveFailures = 0;
  openUntil = 0;
}
function recordFailure(now: number) {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAIL_THRESHOLD) openUntil = now + COOLDOWN_MS;
}

/** Strip markdown/emoji/citation markers so the TTS reads clean spoken text. */
export function speakableText(text: string): string {
  return text
    .replace(/\[\d+\]/g, "") // citation markers
    .replace(/[*_`#>]/g, "") // markdown
    .replace(/•/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}←-⇿⬀-⯿]/gu, "") // emoji/symbols
    .replace(/https?:\/\/\S+/g, "") // URLs read terribly
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

export interface TtsResult {
  audioBase64: string;
  contentType: string;
  provider: "elevenlabs" | "google";
}

/**
 * Synthesize speech across the configured provider order. Returns null (never
 * throws) when no provider produces audio, so the caller can degrade to browser
 * TTS. `now` is injectable for testing; defaults to wall clock.
 */
export async function synthesize(text: string, now = Date.now()): Promise<TtsResult | null> {
  const clean = speakableText(text);
  if (!clean) return null;
  for (const provider of config.ttsOrder) {
    if (provider === "google" && hasGoogleTts()) {
      const g = await googleSynthesize(clean, now);
      if (g) return { ...g, provider: "google" };
    } else if (provider === "elevenlabs" && hasElevenLabs()) {
      const e = await elevenLabsSynthesize(clean, now);
      if (e) return e;
    }
  }
  return null; // degraded mode: browser speechSynthesis
}

/** ElevenLabs synthesis with its own circuit breaker + voice self-heal. */
async function elevenLabsSynthesize(clean: string, now: number): Promise<TtsResult | null> {
  if (breakerOpen(now)) {
    console.warn("[tts] ElevenLabs circuit breaker open — skipping, using browser fallback");
    return null;
  }
  if (!resolvedVoiceId) resolvedVoiceId = config.elevenVoiceId;

  const call = async (voiceId: string) =>
    fetch(`${ENDPOINT}/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: clean,
        model_id: config.elevenModel, // eleven_multilingual_v2 — auto-detects Hindi/Indic/English
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

  try {
    let r = await call(resolvedVoiceId);

    // Self-heal: a 402 usually means the configured voice isn't usable on this plan
    // (e.g. a Voice Library voice on free tier). Resolve to a premade voice once, retry.
    if (r.status === 402 && !triedResolve) {
      triedResolve = true;
      const alt = await usablePremadeVoiceId();
      if (alt && alt !== resolvedVoiceId) {
        console.warn(`[tts] voice ${resolvedVoiceId} rejected (402) — switching to premade voice ${alt}`);
        resolvedVoiceId = alt;
        r = await call(resolvedVoiceId);
      }
    }

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      recordFailure(now);
      console.warn(`[tts] ElevenLabs ${r.status}: ${detail.slice(0, 200)} — falling back to browser TTS`);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    recordSuccess();
    return { audioBase64: buf.toString("base64"), contentType: "audio/mpeg", provider: "elevenlabs" };
  } catch (e: any) {
    recordFailure(now);
    console.warn(`[tts] ElevenLabs call failed (${e?.message ?? e}) — falling back to browser TTS`);
    return null;
  }
}
