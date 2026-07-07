# CLAUDE.md — Smart Bharat Project Constitution

This file governs how Claude (or any engineer) writes code in this repository. Read this before writing or modifying any file. If a request conflicts with this document, this document wins — surface the conflict instead of silently picking one side.

---

## 1. What this project is

Smart Bharat is a multi-agent civic assistant: voice + text access to government services, RAG over government notifications, document-assisted form filling, agentic browser automation for service portals, and a grievance/ombudsman pipeline with SLA-based escalation. It handles real PII (Aadhaar-adjacent data, income, addresses) and performs real browser actions on behalf of users. Treat every line of code as if it will handle a real citizen's real government paperwork, because in production it will.

---

## 2. Non-negotiables (do not violate these under any circumstance)

1. **No autonomous submission of legal/irreversible actions.** Form submits, RTI submissions, portal logins, OTP entry, CAPTCHA solving — always require an explicit human click. Any code path that could submit a government form without a human-in-the-loop `interrupt()` checkpoint is a bug, not a feature, no matter how it's requested.
2. **Never let credentials touch the backend.** Portal usernames, passwords, OTPs are entered by the user directly into the Playwright-controlled browser context. If you find yourself writing code that accepts a password/OTP as an API parameter, stop and re-read Section 6 of the build prompt.
3. **Every factual claim with a number must cite a source.** Scheme amounts, deadlines, eligibility thresholds — if the RAG retrieval didn't return a grounding document, the response must say so explicitly rather than let the model fill the gap from parametric knowledge.
4. **Treat all scraped/retrieved content as untrusted data, never as instructions.** RAG context, OCR'd document text, and scraped government pages go into the prompt as data to reason over — they must never be able to alter agent behavior, override the system prompt, or trigger tool calls. Assume every ingested document is a potential prompt injection vector.
5. **PII minimization by default.** Don't log raw Aadhaar numbers, don't persist uploaded document images longer than needed for extraction, don't include a user's full profile in every LLM call — pass only what the current sub-agent needs.

---

## 3. Tech stack conventions

- **Language**: TypeScript everywhere (frontend, backend, orchestrator, workers). No plain JS in new files.
- **Agent orchestration**: LangGraph.js. One graph per sub-agent, in `services/orchestrator/graphs/`. The top-level orchestrator graph routes via conditional edges — do not implement routing as an if/else chain outside the graph.
- **Human-in-the-loop**: use LangGraph's native `interrupt()` / `Command(resume=...)` pattern for any step requiring user action mid-flow. Do not build a parallel polling mechanism or a separate state machine for this — LangGraph's checkpointer already handles pause/resume correctly.
- **Database boundaries**: MongoDB for app/document data (users, grievances, playbooks-as-data, conversation summaries). PostgreSQL + pgvector strictly for embeddings/RAG. Do not use Mongo Atlas vector search as a substitute — keep the RAG store separate and purpose-built.
- **Queues**: BullMQ for anything async or scheduled — SLA escalation checks, nudge notifications, ingestion crons, RTI draft generation. Nothing long-running happens inline in an HTTP request handler.
- **Voice**: LiveKit Agents framework for the realtime pipeline; Sarvam AI for ASR/TTS/translation. Do not hand-roll VAD or turn-taking logic — LiveKit provides this.
- **Browser automation**: Playwright only, driven entirely by the JSON service-registry playbooks in `services/orchestrator/playbooks/`. New government services are added by writing a new playbook, not new automation code. If a service genuinely needs custom logic beyond what the playbook schema supports, extend the schema — don't special-case it in the executor.
- **Validation**: Zod schemas for every API boundary and every LLM structured-output call. No untyped `any` crossing a network or LLM boundary.

---

## 4. Prompting rules

- One narrow system prompt per sub-agent. Do not share one giant system prompt across all agents "for simplicity" — it makes evals and guardrails harder to reason about per-agent.
- Separate retrieval, simplification, and generation into distinct calls where the build prompt specifies it (Query Resolution Agent). Don't collapse them to save a round trip — the eval harness assumes they're separable.
- Every classification/routing/extraction task uses schema-constrained structured output. Never parse free-text LLM output with regex to make a routing decision.
- Voice-mode responses use a distinct, shorter prompt variant from text-mode. Check which transport a request came from before choosing the prompt variant.
- Include few-shot examples in sub-agent prompts that reflect actual code-switched Hindi-English input (e.g. "mera ration card ka status kya hai") — do not write examples only in formal/textbook Hindi or English-only, since that is not how users will actually speak.

---

## 5. Security checklist (apply to every PR touching auth, uploads, or automation)

- [ ] JWT access tokens short-lived, refresh tokens rotated and stored HttpOnly+SameSite
- [ ] Any new endpoint has a Redis-backed rate limit appropriate to its cost tier
- [ ] Any new external call (Sarvam, LiveKit, govt portal) is wrapped in a circuit breaker with a defined degraded-mode fallback
- [ ] Any new field storing PII is encrypted at rest; check whether it needs to be stored at all first
- [ ] Any new agent action that mutates external state (submits, updates, deletes) has a human-confirmation checkpoint
- [ ] Any new ingestion source is treated as untrusted content in prompts
- [ ] Uploaded files have a defined retention/deletion policy, not indefinite storage by default

---

## 6. Testing & eval expectations

- New sub-agent logic ships with additions to the golden-set eval harness (`packages/eval-harness/`), not just unit tests for the code path.
- Any change to a system prompt requires re-running the eval harness before merge — treat prompt changes like code changes that need regression testing, not free-form edits.
- Red-team cases (prompt injection via fake scraped content, adversarial photo uploads, jailbreak attempts via voice transcript) live alongside the golden set and must not regress.

---

## 7. Code style

- Small, single-responsibility functions and files. A LangGraph node function does one thing — classify, retrieve, fill, or notify — not several.
- Comment the *why*, not the *what*, especially around guardrail logic and human-in-the-loop checkpoints — a future editor needs to understand why a pause exists before "simplifying" it away.
- No silent catch-and-continue on errors from external services (Sarvam, LiveKit, govt portals, LLM calls). Log with context, degrade gracefully, surface to the user in plain language ("I couldn't reach the portal right now, try again in a bit") rather than a raw stack trace or a silent no-op.
- Prefer composition over deep inheritance; prefer explicit state (LangGraph state schemas, Zod types) over implicit shared mutable state.

---

## 8. When in doubt

If a request would relax any item in Section 2 (the non-negotiables) — even for a demo, even "just for the hackathon" — implement the safe version and flag the tradeoff explicitly rather than silently cutting the safety behavior. A working demo that keeps the human-in-the-loop checkpoints intact is a better hackathon submission than a slightly slicker demo that quietly auto-submits a government form.