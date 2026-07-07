import express, { type Request } from "express";
import cors from "cors";
import multer from "multer";
import {
  config,
  isProd,
  hasMongo,
  hasElevenLabs,
  wantsLiveBrowser,
  hasGoogle,
  hasGoogleMaps,
  hasRecaptcha,
  hasGoogleTts,
  llmBackend,
} from "./config.js";
import { initDb, grievances, closeDb } from "./db.js";
import { runOrchestrator } from "./orchestrator/graph.js";
import { photoToComplaint } from "./agents/photo.js";
import { extractDocument, checkAgainstService, SERVICE_REQUIRED_DOCS } from "./agents/document.js";
import { loadSchemes } from "./agents/scheme.js";
import { computeTransparency } from "./analytics.js";
import { ingestCorpus } from "./rag/ingest.js";
import { vectorStore } from "./rag/store.js";
import { startSlaWorker, stopSlaWorker, scanOnce } from "./workers/sla-escalation.js";
import { startNudgeWorker, stopNudgeWorker, runNudgeScan } from "./workers/nudge.js";
import { listNotifications } from "./memory/notifications.js";
import { getProfile, upsertProfile, addDocOnFile } from "./memory/profile.js";
import { loadPlaybooks } from "./agents/browser-executor.js";
import { startAutomation, resumeAutomation } from "./orchestrator/browser.graph.js";
import { optionalAuth, requireUser, registerUser, findUser, verifyPassword, signToken, requireRole } from "./auth.js";
import { rateLimit, ipLimit } from "./middleware/ratelimit.js";
import { securityHeaders, corsOptions } from "./middleware/security.js";
import { verifyRecaptcha } from "./providers/recaptcha.js";
import { synthesize } from "./voice/tts.js";
import { transcribe } from "./voice/stt.js";
import type { TimelineEntry } from "./schemas.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const uid = (req: Request) => (req as any).userId as string;
const dataUrl = (f: Express.Multer.File) => `data:${f.mimetype};base64,${f.buffer.toString("base64")}`;

async function main() {
  await initDb();
  await ingestCorpus();
  startSlaWorker();
  startNudgeWorker(60);

  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "8mb" })); // matches the multer upload cap; smaller attack surface
  app.use(optionalAuth); // resolves req.userId from the JWT (or the fixed demo user in demo mode)

  const voiceProvider = () => (hasGoogleTts() ? "google" : hasElevenLabs() ? "elevenlabs" : "browser");

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      llm: llmBackend(), // "gemini" | "groq" | "mock"
      db: hasMongo() ? "mongodb" : "memory",
      voice: voiceProvider(),
      google: hasGoogle(), // whole Cloud suite (Gemini/TTS/STT/Vision/Translate) on one key
      maps: hasGoogleMaps(),
      automation: wantsLiveBrowser() ? "live" : "sim",
      auth_mode: config.authMode,
      rag_chunks: vectorStore.size,
      schemes: (await loadSchemes()).length,
      services: (await loadPlaybooks()).map((p) => p.service_id),
      sla_hours: config.slaHours,
    });
  });

  // In strict AUTH_MODE, every user-scoped endpoint requires a valid token; public
  // endpoints (health, auth, static catalog data) are exempt. In demo mode this is a
  // no-op because optionalAuth always resolves the fixed demo user.
  const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\//, /^\/api\/schemes$/, /^\/api\/services$/, /^\/api\/transparency$/, /^\/api\/automation\/services$/];
  app.use((req, res, next) => {
    if (config.authMode !== "strict") return next();
    if (PUBLIC.some((re) => re.test(req.path))) return next();
    return requireUser(req, res, next);
  });

  // ---- Chat -> Orchestrator ----
  app.post("/api/chat", rateLimit({ name: "chat", capacity: 30, refillPerSec: 1 }), async (req, res) => {
    try {
      const { sessionId = "sess-" + uid(req), message } = req.body ?? {};
      if (!message || typeof message !== "string") return res.status(400).json({ error: "message (string) required" });
      res.json(await runOrchestrator({ userId: uid(req), sessionId, message }));
    } catch (e: any) {
      console.error("[chat]", e);
      res.status(500).json({ error: e?.message ?? "orchestrator failed" });
    }
  });

  // ---- Speech-to-Text (ElevenLabs Scribe; handles code-switched Hinglish audio) ----
  // Returns 204 when server STT is unavailable so the browser falls back to Web Speech.
  app.post("/api/stt", rateLimit({ name: "voice", capacity: 20, refillPerSec: 0.5 }), upload.single("audio"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "audio file required (field 'audio')" });
      const out = await transcribe(req.file.buffer, req.file.mimetype);
      if (!out) return res.status(204).end(); // degraded: use browser recognition
      res.json({ text: out.text, languageCode: out.languageCode, provider: out.provider });
    } catch (e: any) {
      console.error("[stt]", e);
      res.status(500).json({ error: e?.message ?? "transcription failed" });
    }
  });

  // ---- Voice -> Orchestrator (voice-mode prompt) -> ElevenLabs TTS ----
  // STT happens in the browser (Web Speech API); we receive the transcript here.
  // Reply is synthesized to speech via ElevenLabs multilingual; on any failure we
  // return audio=null and the browser speaks it with on-device TTS (degraded mode).
  app.post("/api/voice/chat", rateLimit({ name: "voice", capacity: 20, refillPerSec: 0.5 }), async (req, res) => {
    try {
      const { sessionId = "voice-" + uid(req), message } = req.body ?? {};
      if (!message || typeof message !== "string") return res.status(400).json({ error: "message (string) required" });
      const result = await runOrchestrator({ userId: uid(req), sessionId, message, mode: "voice" });
      const tts = await synthesize(result.reply);
      res.json({
        ...result,
        audioBase64: tts?.audioBase64 ?? null,
        audioContentType: tts?.contentType ?? null,
        voiceProvider: tts?.provider ?? "browser", // "elevenlabs" or "browser" fallback
      });
    } catch (e: any) {
      console.error("[voice]", e);
      res.status(500).json({ error: e?.message ?? "voice turn failed" });
    }
  });

  // Standalone TTS (replay a message aloud). Returns audio/mpeg, or 204 to signal
  // "no server voice — use browser speechSynthesis".
  app.post("/api/tts", rateLimit({ name: "voice", capacity: 20, refillPerSec: 0.5 }), async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== "string") return res.status(400).json({ error: "text (string) required" });
    const tts = await synthesize(text);
    if (!tts) return res.status(204).end();
    res.setHeader("Content-Type", tts.contentType);
    res.send(Buffer.from(tts.audioBase64, "base64"));
  });

  // ---- Photo-to-Complaint ----
  app.post("/api/photo-complaint", rateLimit({ name: "vision", capacity: 10, refillPerSec: 0.3 }), upload.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "image file required (field 'image')" });
      const out = await photoToComplaint({ user_id: uid(req), imageDataUrl: dataUrl(req.file), note: req.body.note || "" });
      if (!out.grievance) return res.json({ filed: false, classification: out.classification, message: "That photo doesn't look like a civic issue I can file." });
      res.json({ filed: true, grievance: out.grievance, classification: out.classification });
    } catch (e: any) {
      console.error("[photo]", e);
      res.status(500).json({ error: e?.message ?? "photo classification failed" });
    }
  });

  // ---- Document Assistant ----
  app.get("/api/services", (_req, res) => res.json(Object.entries(SERVICE_REQUIRED_DOCS).map(([id, v]) => ({ id, ...v }))));
  app.post("/api/document-check", rateLimit({ name: "vision", capacity: 10, refillPerSec: 0.3 }), upload.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "image file required (field 'image')" });
      const serviceId = req.body.serviceId || "aadhaar_update";
      const extracted = await extractDocument(dataUrl(req.file));
      await addDocOnFile(uid(req), extracted.doc_type);
      const profile = await getProfile(uid(req));
      res.json(checkAgainstService(serviceId, extracted, profile.canonical_profile.documents_on_file));
    } catch (e: any) {
      console.error("[document]", e);
      res.status(500).json({ error: e?.message ?? "extraction failed" });
    }
  });

  // ---- Grievances ----
  app.get("/api/grievances", async (req, res) => res.json(await grievances().list({ user_id: uid(req) })));
  app.get("/api/grievances/:id", async (req, res) => {
    const g = await grievances().get(req.params.id);
    if (!g) return res.status(404).json({ error: "not found" });
    res.json(g);
  });
  app.post("/api/grievances/:id/submit-rti", async (req, res) => {
    const g = await grievances().get(req.params.id);
    if (!g) return res.status(404).json({ error: "not found" });
    if (!g.rti_draft) return res.status(400).json({ error: "no RTI draft on this grievance" });
    const entry: TimelineEntry = { at: new Date().toISOString(), actor: "user", event: "rti_submitted", detail: "user confirmed and submitted the RTI" };
    res.json(await grievances().update(g._id, { rti_draft: { ...g.rti_draft, submitted_by_user: true }, timeline: [...g.timeline, entry] }));
  });

  // ---- Schemes / Transparency / Notifications ----
  app.get("/api/schemes", async (_req, res) => res.json(await loadSchemes()));
  app.get("/api/transparency", async (_req, res) => res.json(await computeTransparency()));
  app.get("/api/notifications", async (req, res) => res.json(await listNotifications(uid(req))));
  app.post("/api/nudge/scan", async (_req, res) => res.json({ created: await runNudgeScan() }));

  // ---- Profile (big memory) ----
  app.get("/api/profile", async (req, res) => res.json(await getProfile(uid(req))));
  app.put("/api/profile", async (req, res) => {
    const cur = await getProfile(uid(req));
    const next = { ...cur, ...req.body, user_id: uid(req), canonical_profile: { ...cur.canonical_profile, ...(req.body?.canonical_profile ?? {}) } };
    res.json(await upsertProfile(next));
  });

  // ---- Browser Automation (human-in-the-loop) ----
  app.get("/api/automation/services", async (_req, res) => {
    const pbs = await loadPlaybooks();
    res.json(pbs.map((p) => ({ service_id: p.service_id, portal_url: p.portal_url, required_docs: p.required_docs, steps: p.steps.length })));
  });
  app.post("/api/automation/start", rateLimit({ name: "automation", capacity: 5, refillPerSec: 0.1 }), async (req, res) => {
    try {
      res.json(await startAutomation(req.body.serviceId, uid(req)));
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "failed to start" });
    }
  });
  app.post("/api/automation/resume", async (req, res) => {
    try {
      res.json(await resumeAutomation(req.body.runId, req.body.note || "done"));
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "failed to resume" });
    }
  });

  // ---- Auth (optional; demo works without it) ----
  // reCAPTCHA (Google) gates register/login when RECAPTCHA_SECRET is set (bot /
  // credential-stuffing defense, CLAUDE.md §5); a no-op in the keyless demo.
  app.post("/api/auth/register", ipLimit(10, 0.2), async (req, res) => {
    try {
      const { email, password, role, recaptchaToken } = req.body ?? {};
      if (!email || !password) return res.status(400).json({ error: "email + password required" });
      if (!(await verifyRecaptcha(recaptchaToken, req.ip))) return res.status(403).json({ error: "captcha verification failed" });
      const u = await registerUser(email, password, role === "official" ? "official" : "citizen");
      res.json({ token: signToken({ sub: u.user_id, role: u.role }), user: { user_id: u.user_id, email: u.email, role: u.role } });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "register failed" });
    }
  });
  app.post("/api/auth/login", ipLimit(20, 0.3), async (req, res) => {
    const { email, password, recaptchaToken } = req.body ?? {};
    if (!(await verifyRecaptcha(recaptchaToken, req.ip))) return res.status(403).json({ error: "captcha verification failed" });
    const u = await findUser(email || "");
    if (!u || !verifyPassword(password || "", u.pw_hash)) return res.status(401).json({ error: "invalid credentials" });
    res.json({ token: signToken({ sub: u.user_id, role: u.role }), user: { user_id: u.user_id, email: u.email, role: u.role } });
  });

  // Example RBAC-protected official view (department dashboard).
  app.get("/api/official/grievances", requireRole("official", "admin"), async (_req, res) => res.json(await grievances().list()));

  // ---- DEV helpers (demo only) ----
  // These mutate SLA clocks and force escalation scans — never exposed in production,
  // and disableable anywhere via ENABLE_DEV_ROUTES=false.
  const devRoutesEnabled = config.enableDevRoutes && !isProd();
  if (devRoutesEnabled) {
    app.post("/api/dev/fast-forward/:id", async (req, res) => {
      const g = await grievances().get(req.params.id);
      if (!g) return res.status(404).json({ error: "not found" });
      const shift = config.slaHours * 3600 * 1000 + 24 * 3600 * 1000;
      const back = (iso: string) => new Date(new Date(iso).getTime() - shift).toISOString();
      await grievances().update(g._id, { created_at: back(g.created_at), sla_deadline: back(g.sla_deadline), timeline: g.timeline.map((t) => ({ ...t, at: back(t.at) })) });
      const n = await scanOnce();
      res.json({ scanned: n, grievance: await grievances().get(g._id) });
    });
    app.post("/api/dev/scan", async (_req, res) => res.json({ escalated_candidates: await scanOnce() }));
  }

  app.listen(config.port, () => {
    const llm = llmBackend();
    console.log(`\nSmart Bharat API on http://localhost:${config.port}`);
    console.log(`  LLM: ${llm === "gemini" ? "Google Gemini (" + config.geminiTextModel + ")" : llm === "groq" ? "Groq (" + config.textModel + ")" : "MOCK (no GOOGLE_API_KEY / GROQ_API_KEY)"}`);
    console.log(`  DB:  ${hasMongo() ? "MongoDB Atlas" : "in-memory (resets on restart)"}`);
    console.log(`  Voice: ${voiceProvider()}${hasGoogleMaps() ? " · Maps geocoding on" : ""}`);
    console.log(`  Google Cloud suite: ${hasGoogle() ? "ENABLED (Gemini/embeddings/TTS/STT/Vision/Translate)" : "off (set GOOGLE_API_KEY)"}`);
    console.log(`  Browser automation: ${wantsLiveBrowser() ? "LIVE Playwright (headful)" : "simulation"}`);
    console.log(`  Auth mode: ${config.authMode}${hasRecaptcha() ? " · reCAPTCHA on" : ""} · dev routes: ${devRoutesEnabled ? "on" : "off"}`);
    console.log(`  RAG: ${vectorStore.size} chunks indexed\n`);
  });

  const shutdown = async () => { stopSlaWorker(); stopNudgeWorker(); await closeDb(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
