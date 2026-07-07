// Browser-side voice: speech-to-text via the Web Speech API (no key, works in
// Chromium/Edge), and playback that prefers server ElevenLabs audio but falls back
// to on-device speechSynthesis when the server returns no audio (degraded mode).

export const sttSupported = () =>
  typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

// --- Server-side STT (ElevenLabs Scribe): record mic audio, upload for transcription.
// This is what enables true spoken code-switching (no language pre-selection). ---
export const recorderSupported = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

/** Start recording the mic. Returns a stop() that resolves with the recorded audio blob. */
export async function startRecording(): Promise<{ stop: () => Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" })); };
        rec.stop();
      }),
  };
}

/** Upload audio to the server for Scribe transcription. null => server STT unavailable (204). */
export async function transcribeViaServer(blob: Blob): Promise<{ text: string; languageCode: string } | null> {
  const fd = new FormData();
  fd.append("audio", blob, "speech.webm");
  const r = await fetch("/api/stt", { method: "POST", body: fd });
  if (r.status === 204) return null; // degraded: caller should use browser recognition
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as any).error || "transcription failed");
  return r.json();
}

/** One-shot dictation. Resolves with the recognized transcript (or "" if nothing). */
export function listenOnce(lang: string): { promise: Promise<string>; stop: () => void } {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return { promise: Promise.reject(new Error("Speech recognition not supported in this browser")), stop: () => {} };
  const rec = new Ctor();
  rec.lang = lang; // "en-IN" handles Hinglish reasonably; "hi-IN" for Devanagari Hindi
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let settled = false;
  const promise = new Promise<string>((resolve, reject) => {
    rec.onresult = (e: any) => { settled = true; resolve(e.results[0][0].transcript as string); };
    rec.onerror = (e: any) => { if (!settled) reject(new Error(e.error || "speech error")); };
    rec.onend = () => { if (!settled) resolve(""); };
    rec.start();
  });
  return { promise, stop: () => { try { rec.stop(); } catch {} } };
}

let currentAudio: HTMLAudioElement | null = null;

/** Stop any in-flight playback (server audio or browser speech). */
export function stopSpeaking() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/**
 * Speak a reply. If the server returned ElevenLabs audio, play that; otherwise fall
 * back to the browser's speechSynthesis so voice still works without a key.
 */
export function speak(audioBase64: string | null, contentType: string | null, text: string, lang: string, onEnd?: () => void) {
  stopSpeaking();
  if (audioBase64) {
    const audio = new Audio(`data:${contentType || "audio/mpeg"};base64,${audioBase64}`);
    currentAudio = audio;
    audio.onended = () => { if (currentAudio === audio) currentAudio = null; onEnd?.(); };
    audio.play().catch(() => browserSpeak(text, lang, onEnd)); // autoplay blocked -> try browser TTS
    return;
  }
  browserSpeak(text, lang, onEnd);
}

function browserSpeak(text: string, lang: string, onEnd?: () => void) {
  if (typeof speechSynthesis === "undefined") { onEnd?.(); return; }
  const u = new SpeechSynthesisUtterance(text.replace(/\[\d+\]/g, "").replace(/[*_`#>•]/g, ""));
  u.lang = lang === "hi" ? "hi-IN" : "en-IN";
  u.onend = () => onEnd?.();
  speechSynthesis.speak(u);
}
