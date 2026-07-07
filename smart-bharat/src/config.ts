import "dotenv/config";

const list = (v: string | undefined, fallback: string[]) => {
  const parts = (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV?.trim() || "development",

  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  textModel: process.env.GROQ_TEXT_MODEL?.trim() || "llama-3.3-70b-versatile",
  visionModel:
    process.env.GROQ_VISION_MODEL?.trim() || "meta-llama/llama-4-scout-17b-16e-instruct",

  // --- Google Cloud suite ---
  // A SINGLE API key powers Gemini + Cloud Text-to-Speech / Speech-to-Text / Vision /
  // Translation via their REST endpoints (all accept ?key=API_KEY — no service-account
  // needed). Maps geocoding and reCAPTCHA use their own keys, defaulting to the same one.
  // Everything below is optional and key-gated: absent key => graceful fallback, exactly
  // like the Groq->mock and ElevenLabs->browser paths (CLAUDE.md §5 degraded-mode rule).
  googleApiKey: process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || "",
  geminiTextModel: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-2.0-flash",
  geminiVisionModel: process.env.GEMINI_VISION_MODEL?.trim() || "gemini-2.0-flash",
  geminiEmbedModel: process.env.GEMINI_EMBED_MODEL?.trim() || "text-embedding-004",
  // Preferred text/vision LLM backend: "gemini" | "groq" | "auto" (auto prefers Gemini
  // when its key is present, then Groq, then the deterministic mock).
  llmProvider: (process.env.LLM_PROVIDER?.trim() || "auto").toLowerCase(),

  // Google Cloud Text-to-Speech (Indic-native Chirp/Neural voices).
  googleTtsVoice: process.env.GOOGLE_TTS_VOICE?.trim() || "hi-IN-Wavenet-A",
  googleTtsLanguage: process.env.GOOGLE_TTS_LANGUAGE?.trim() || "hi-IN",
  // Ordered voice-provider preference. Default leans Google-first (per the operator's
  // "use Google as much as possible") but retains ElevenLabs, then browser on-device TTS.
  ttsOrder: list(process.env.TTS_PROVIDER_ORDER, ["google", "elevenlabs"]),
  sttOrder: list(process.env.STT_PROVIDER_ORDER, ["google", "elevenlabs"]),

  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "",
  recaptchaSecret: process.env.RECAPTCHA_SECRET?.trim() || "",

  mongoUri: process.env.MONGODB_URI?.trim() || "",
  mongoDb: process.env.MONGODB_DB?.trim() || "smart_bharat",

  // Voice output — ElevenLabs multilingual TTS. Empty key => browser speechSynthesis fallback.
  // NOTE: CLAUDE.md §3 names Sarvam AI as the spec default for ASR/TTS; ElevenLabs is a
  // deliberate override requested by the operator. Swap the tts module to keep the spec default.
  elevenLabsKey: process.env.ELEVENLABS_API_KEY?.trim() || "",
  elevenModel: process.env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2",
  // MUST be a "premade" voice — free-tier API 402s on Voice Library voices ("Free users
  // cannot use library voices via the API"). "Sarah"; multilingual_v2 speaks Hindi with it.
  elevenVoiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || "EXAVITQu4vr4xnSDxMaL",

  // Browser automation. "live" drives a real Chromium via Playwright; anything else
  // (or Playwright missing) uses the safe simulation. HEADFUL by default in live mode
  // so the user can type login/OTP directly into the real browser window (CLAUDE.md §2
  // non-negotiable #2 — credentials never touch the backend).
  browserLive: (process.env.BROWSER_AUTOMATION?.trim() || "sim") === "live",
  browserHeadless: process.env.BROWSER_HEADLESS?.trim() === "true", // default false (headful)

  port: Number(process.env.PORT) || 8787,

  // --- Security ---
  jwtSecret: process.env.JWT_SECRET?.trim() || "",
  // Comma-separated allowlist of browser origins for CORS. Empty => reflect any origin
  // in development only; in production an empty list denies cross-origin browser calls.
  corsOrigins: list(process.env.CORS_ORIGINS, []),
  // "demo" (default): unauthenticated requests act as a single fixed demo citizen.
  // "strict": user-scoped endpoints require a valid JWT (production posture).
  authMode: (process.env.AUTH_MODE?.trim() || "demo").toLowerCase(),
  // Enable the /api/dev/* demo helpers. Forced off in production regardless.
  enableDevRoutes: process.env.ENABLE_DEV_ROUTES?.trim() !== "false",

  slaHours: Number(process.env.SLA_HOURS) || 48,
  slaScanIntervalSeconds: Number(process.env.SLA_SCAN_INTERVAL_SECONDS) || 15,
};

export const isProd = () => config.nodeEnv === "production";

export const hasGroq = () => config.groqApiKey.length > 0;
export const hasMongo = () => config.mongoUri.length > 0;
export const hasElevenLabs = () => config.elevenLabsKey.length > 0;
export const wantsLiveBrowser = () => config.browserLive;

// --- Google capability flags (one key unlocks the whole REST suite) ---
export const hasGoogle = () => config.googleApiKey.length > 0;
export const hasGemini = hasGoogle;
export const hasGoogleTts = hasGoogle;
export const hasGoogleStt = hasGoogle;
export const hasGoogleVision = hasGoogle;
export const hasGoogleTranslate = hasGoogle;
export const hasGoogleMaps = () => config.googleMapsKey.length > 0;
export const hasRecaptcha = () => config.recaptchaSecret.length > 0;

/** Which text/vision LLM backend to use, honoring LLM_PROVIDER then key availability. */
export function llmBackend(): "gemini" | "groq" | "mock" {
  if (config.llmProvider === "gemini") return hasGemini() ? "gemini" : hasGroq() ? "groq" : "mock";
  if (config.llmProvider === "groq") return hasGroq() ? "groq" : hasGemini() ? "gemini" : "mock";
  // auto: prefer Google, then Groq, then deterministic mock.
  return hasGemini() ? "gemini" : hasGroq() ? "groq" : "mock";
}
