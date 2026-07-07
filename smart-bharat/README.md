# Smart Bharat — AI-Powered Civic Companion

A GenAI-native, **multi-agent** platform that lets any Indian citizen talk to their
government through one intelligent companion. Built on a real LangGraph.js
orchestrator with human-in-the-loop safety, RAG grounding, and an accountability
pipeline (SLA escalation → auto-drafted RTI).

## Runs before you have keys
- **No LLM key** (`GOOGLE_API_KEY` / `GROQ_API_KEY`) → a deterministic mock LLM
  answers (keyword heuristics), so the app boots and demos. RAG retrieval is
  **key-free** (local lexical embedder), so citations work in mock mode too. Add a
  key + restart for real inference and vision.
- **No `MONGODB_URI`** → an in-memory store is used (resets on restart). Add your
  Atlas string for persistence.

## Google Cloud integration (all optional, key-gated, graceful)
A **single `GOOGLE_API_KEY`** unlocks the whole Google suite via REST (no service
account). Each is used only when the key is present and falls back cleanly otherwise:
| Service | Where | Fallback |
|---|---|---|
| **Gemini** (text + vision structured output) | `src/providers/gemini.ts`, `src/llm.ts` — becomes the default LLM (`LLM_PROVIDER=auto`) | Groq → deterministic mock |
| **Gemini embeddings** (dense RAG vectors) | `src/rag/store.ts` | key-free TF-IDF lexical |
| **Cloud Text-to-Speech** (Indic voices) | `src/voice/tts.ts` (`TTS_PROVIDER_ORDER`) | ElevenLabs → browser TTS |
| **Cloud Speech-to-Text** (Hinglish code-switch) | `src/voice/stt.ts` (`STT_PROVIDER_ORDER`) | ElevenLabs Scribe → browser Web Speech |
| **Cloud Vision OCR** (document field reads) | `src/agents/document.ts` | vision-LLM alone |
| **Cloud Translation** (cross-lingual retrieval) | `src/agents/query.ts` | LLM keyword translation |
| **Maps Geocoding** (photo-complaint location) | `src/agents/photo.ts` | raw note text |
| **reCAPTCHA** (auth bot defense) | `src/providers/recaptcha.ts`, `/api/auth/*` | disabled (demo) |

## Security posture
- **Identity is always server-derived** — a valid JWT `sub`, or a fixed demo citizen
  in `AUTH_MODE=demo`. A client-supplied `userId` is never trusted (closes the IDOR).
  Set `AUTH_MODE=strict` to require a token on user-scoped endpoints.
- Security headers (CSP/HSTS/nosniff/frame-deny) + CORS allowlist (`CORS_ORIGINS`),
  timing-safe JWT verification, mandatory `JWT_SECRET` in production, rate-limiter
  eviction, and `/api/dev/*` disabled in production (or via `ENABLE_DEV_ROUTES=false`).

## Run
```bash
cd smart-bharat
cp .env.example .env         # optional: GROQ_API_KEY + MONGODB_URI
npm install
npm run dev                  # API on http://localhost:8787   (use PowerShell on Windows)
```
```bash
cd smart-bharat/web
npm install
npm run dev                  # UI on http://localhost:5173  (proxies /api)
```
```bash
npm run eval                 # golden-set eval harness (routing / grounding / refusal)
```

## Agents & subsystems (all implemented)
| Feature | Where | Notes |
|---|---|---|
| **Orchestrator** | `src/orchestrator/graph.ts` | LangGraph: ingest→(guard)→classify→route; session memory via MemorySaver; carries slot-filling state |
| **Query / RAG** | `src/agents/query.ts`, `src/rag/*` | citations, grounding guardrail, stale-source warning; key-free lexical retrieval (swap in pgvector later) |
| **Scheme Matchmaker** | `src/agents/scheme.ts` | conversational slot-filling → deterministic match over 30 real schemes; profile prefill |
| **Document Assistant** | `src/agents/document.ts` | vision extraction → cross-ref a service's required docs; ID redaction |
| **Grievance / Ombudsman** | `src/agents/grievance.ts`, `ombudsman.ts` | classify → SLA deadline → persist; follow-up + RTI drafting |
| **SLA escalation** | `src/workers/sla-escalation.ts` | scan → L1 follow-up → L2 **RTI auto-draft** (never auto-submitted) |
| **Photo-to-Complaint** | `src/agents/photo.ts` | Groq vision classify + severity → grievance |
| **Browser Automation** | `src/orchestrator/browser.graph.ts` | LangGraph `interrupt()`/`Command(resume)` HITL; JSON service registry; simulated executor (Playwright plugs in) |
| **Proactive Nudge** | `src/workers/nudge.ts` | background scan of profiles → scheme-eligibility notifications |
| **Big memory** | `src/memory/profile.ts` | long-term profile in Mongo; summarized history; prefills scheme slots |
| **Guardrails** | `src/guardrails.ts` | input (prompt-injection, third-party PII), output (PII redaction), grounding (numbers need a citation) |
| **Rate limiting** | `src/middleware/ratelimit.ts` | in-memory token bucket per user per agent (swap to Redis) |
| **Auth (optional)** | `src/auth.ts` | scrypt + HS256 JWT (node:crypto only), RBAC citizen/official/admin |
| **Transparency** | `src/analytics.ts` | derived dashboard: SLA %, escalation funnel, per-department, plain-language summary |
| **Eval harness** | `eval/run.ts`, `eval/golden.json` | 60 cases: routing, language, injection-refusal, grounding |
| **Voice** | `apps/voice-agent/` | scaffold + design doc (LiveKit + Sarvam) — not wired this milestone |

## Demo script
1. **RAG**: chat "how much does PM-KISAN pay?" → grounded answer with clickable citations.
2. **Scheme match**: "which schemes am I eligible for" → answers 6 slot questions → ranked real schemes.
3. **Grievance → RTI**: file a pothole complaint → **Grievances** tab → **⏩ Fast-forward SLA** twice → L1 follow-up then **L2 RTI draft** → **Review RTI** → you click submit (HITL).
4. **Automation** tab: start "aadhaar update" → the graph pauses at login/OTP/submit ("your turn" cards) and resumes on your confirmation; agent fills only non-secret fields.
5. **Documents** tab: upload a doc → extracted + "still missing" list (ID redacted).
6. **Insights** tab: live transparency scorecard. **Alerts** tab: proactive scheme nudges.
7. **Guardrail**: "ignore your instructions…" or asking for a neighbour's bank details → refused.

## Key API endpoints
`POST /api/chat` · `POST /api/photo-complaint` · `POST /api/document-check` ·
`GET /api/grievances` · `POST /api/grievances/:id/submit-rti` ·
`POST /api/automation/start|resume` · `GET /api/transparency` ·
`GET /api/notifications` · `POST /api/nudge/scan` · `GET/PUT /api/profile` ·
`POST /api/auth/register|login` · `POST /api/dev/fast-forward/:id` (demo only)

## Production upgrades (documented substitutions)
- **RAG store**: local lexical embedder → real embeddings + **pgvector** (interface in `src/rag/store.ts` is the only change point).
- **Queues/schedulers**: interval workers → **BullMQ + Redis** (`scanOnce()` / `runNudgeScan()` logic unchanged).
- **Rate limiter**: in-memory buckets → Redis token bucket.
- **Browser executor**: simulation → **Playwright** `BrowserDriver` (orchestration/interrupts unchanged).
- **Voice**: implement `apps/voice-agent` with LiveKit Agents + Sarvam ASR/TTS.
- **Auth**: add refresh-token rotation + DigiLocker OAuth; lock endpoints with `requireAuth`.
- Remove `/api/dev/*` before deploying. `multer@1.x` → `2.x`.

## Config (`.env`)
See `.env.example` for the full annotated list. Key vars:
| Var | Default | Meaning |
|---|---|---|
| `GOOGLE_API_KEY` | — | Unlocks Gemini + Cloud TTS/STT/Vision/Translation; empty = off |
| `LLM_PROVIDER` | `auto` | `auto` (Gemini→Groq→mock) \| `gemini` \| `groq` |
| `GEMINI_TEXT_MODEL` | `gemini-2.0-flash` | Gemini reasoning/vision model |
| `TTS_PROVIDER_ORDER` / `STT_PROVIDER_ORDER` | `google,elevenlabs` | voice provider preference (browser is final fallback) |
| `GOOGLE_MAPS_API_KEY` | `GOOGLE_API_KEY` | photo-complaint geocoding |
| `RECAPTCHA_SECRET` | — | reCAPTCHA on `/api/auth/*`; empty = disabled |
| `GROQ_API_KEY` | — | Alternative LLM; used when no Google key |
| `MONGODB_URI` | — | Atlas string; empty = in-memory |
| `JWT_SECRET` | random (dev) | **required in production** |
| `AUTH_MODE` | `demo` | `demo` \| `strict` (require JWT) |
| `CORS_ORIGINS` | — | browser origin allowlist |
| `ENABLE_DEV_ROUTES` | `true` | `/api/dev/*`; always off in production |
| `SLA_HOURS` | `48` | new-grievance deadline |
| `SLA_SCAN_INTERVAL_SECONDS` | `15` | escalation scan cadence |
