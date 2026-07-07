import { config, hasGoogleTts, hasGoogleStt, hasGoogleVision, hasGoogleTranslate, hasGoogleMaps } from "../config.js";

/**
 * Google Cloud REST services (Text-to-Speech, Speech-to-Text, Vision OCR,
 * Translation, Geocoding) — all via `?key=API_KEY`, so no service-account JSON.
 * Each function returns null / a safe empty value on any failure (never throws into
 * a request), matching the ElevenLabs circuit-breaker degraded-mode contract
 * (CLAUDE.md §5). These are convenience layers: none of them may take a turn down.
 */

// ---- shared tiny circuit breaker (per service) ----
function makeBreaker(threshold = 3, cooldownMs = 30_000) {
  let failures = 0;
  let openUntil = 0;
  return {
    open: (now: number) => now < openUntil,
    success: () => { failures = 0; openUntil = 0; },
    failure: (now: number) => { if (++failures >= threshold) openUntil = now + cooldownMs; },
  };
}

// ---------- Text-to-Speech ----------
const ttsBreaker = makeBreaker();
export interface GoogleTtsResult { audioBase64: string; contentType: string }

/** Synthesize speech with Cloud TTS. Returns null when unavailable/failed. */
export async function googleSynthesize(text: string, now = Date.now()): Promise<GoogleTtsResult | null> {
  if (!hasGoogleTts() || ttsBreaker.open(now) || !text.trim()) return null;
  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.googleApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: config.googleTtsLanguage, name: config.googleTtsVoice },
        audioConfig: { audioEncoding: "MP3" },
      }),
    });
    if (!r.ok) {
      ttsBreaker.failure(now);
      console.warn(`[tts:google] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)} — falling back`);
      return null;
    }
    const data: any = await r.json();
    if (!data.audioContent) { ttsBreaker.failure(now); return null; }
    ttsBreaker.success();
    return { audioBase64: data.audioContent, contentType: "audio/mpeg" };
  } catch (e: any) {
    ttsBreaker.failure(now);
    console.warn(`[tts:google] failed (${e?.message ?? e}) — falling back`);
    return null;
  }
}

// ---------- Speech-to-Text ----------
const sttBreaker = makeBreaker();
export interface GoogleSttResult { text: string; languageCode: string }

/**
 * Transcribe audio with Cloud STT. We don't pin a languageCode as primary but list
 * Hindi + English so code-switched Hinglish is transcribed faithfully. Returns null
 * when unavailable/failed so the caller can fall back to on-device recognition.
 */
export async function googleTranscribe(audio: Buffer, mimeType: string, now = Date.now()): Promise<GoogleSttResult | null> {
  if (!hasGoogleStt() || sttBreaker.open(now)) return null;
  // Map common browser MediaRecorder mime types to Cloud STT encodings.
  const encoding = /ogg|opus/i.test(mimeType) ? "OGG_OPUS" : /webm/i.test(mimeType) ? "WEBM_OPUS" : "ENCODING_UNSPECIFIED";
  try {
    const r = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${config.googleApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          encoding,
          languageCode: "hi-IN",
          alternativeLanguageCodes: ["en-IN", "en-US"],
          enableAutomaticPunctuation: true,
          model: "latest_long",
        },
        audio: { content: audio.toString("base64") },
      }),
    });
    if (!r.ok) {
      sttBreaker.failure(now);
      console.warn(`[stt:google] ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)} — falling back`);
      return null;
    }
    const data: any = await r.json();
    const alt = data.results?.[0]?.alternatives?.[0];
    sttBreaker.success();
    return { text: (alt?.transcript ?? "").trim(), languageCode: data.results?.[0]?.languageCode ?? "" };
  } catch (e: any) {
    sttBreaker.failure(now);
    console.warn(`[stt:google] failed (${e?.message ?? e}) — falling back`);
    return null;
  }
}

// ---------- Vision OCR ----------
/**
 * Extract printed text from a document image via Cloud Vision DOCUMENT_TEXT_DETECTION.
 * Used to ENRICH the vision-LLM extraction (better field reads on IDs), never to make
 * a decision on its own. Returns "" when unavailable — extraction proceeds without it.
 */
export async function googleOcr(imageDataUrl: string): Promise<string> {
  if (!hasGoogleVision()) return "";
  const m = /^data:[^;]+;base64,(.*)$/s.exec(imageDataUrl);
  if (!m) return "";
  try {
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${config.googleApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ image: { content: m[1] }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }],
      }),
    });
    if (!r.ok) {
      console.warn(`[vision:google] ${r.status} — skipping OCR enrichment`);
      return "";
    }
    const data: any = await r.json();
    return (data.responses?.[0]?.fullTextAnnotation?.text ?? "").trim();
  } catch (e: any) {
    console.warn(`[vision:google] OCR failed (${e?.message ?? e}) — skipping`);
    return "";
  }
}

// ---------- Translation ----------
/**
 * Translate text with Cloud Translation v2. Used only for the cross-lingual RETRIEVAL
 * bridge (query in one language, English corpus) — the user-facing answer is still
 * generated in the user's language. Returns "" on failure so the caller can degrade.
 */
export async function googleTranslate(text: string, target = "en"): Promise<string> {
  if (!hasGoogleTranslate() || !text.trim()) return "";
  try {
    const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${config.googleApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target, format: "text" }),
    });
    if (!r.ok) {
      console.warn(`[translate:google] ${r.status} — skipping translation`);
      return "";
    }
    const data: any = await r.json();
    return (data.data?.translations?.[0]?.translatedText ?? "").trim();
  } catch (e: any) {
    console.warn(`[translate:google] failed (${e?.message ?? e}) — skipping`);
    return "";
  }
}

// ---------- Geocoding ----------
export interface GeoResult { formatted_address: string; lat: number; lng: number }

/** Resolve a free-text place/landmark to coordinates. Returns null when unavailable. */
export async function googleGeocode(place: string): Promise<GeoResult | null> {
  if (!hasGoogleMaps() || !place.trim()) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&region=in&key=${config.googleMapsKey}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data: any = await r.json();
    const top = data.results?.[0];
    if (!top) return null;
    return {
      formatted_address: top.formatted_address,
      lat: top.geometry?.location?.lat,
      lng: top.geometry?.location?.lng,
    };
  } catch (e: any) {
    console.warn(`[maps:google] geocode failed (${e?.message ?? e})`);
    return null;
  }
}
