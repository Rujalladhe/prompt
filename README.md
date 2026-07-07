# Smart Bharat — AI-Powered Civic Companion (Hackathon Submission)

A GenAI-native, **multi-agent** platform that lets any Indian citizen talk to their government through one intelligent companion. Built on a real LangGraph.js orchestrator with human-in-the-loop safety, RAG grounding, and an accountability pipeline (SLA escalation → auto-drafted RTI).

## 1. Project Vertical
- **Vertical Chosen**: Civic services assistant / Government services automation and retrieval (multi-modal ‘Smart Bharat’ service). This project targets workflows around citizen-facing government services: identity (Aadhaar, PAN), licences (driving licence, passport), ration cards, social benefits, grievance and ombudsman handling.

---

## 2. Approach and Logic
- **Core Idea**: Provide a safe, auditable, human-in-the-loop assistant that helps users find information, prepare documents, and guide or automate browser interactions up to—but never including—final irreversible submissions.
- **Design Principles**:
  - **Human-in-the-loop**: Any irreversible or credentialed action requires explicit human confirmation before submission.
  - **Least Privilege & PII Minimization**: Store and transmit only the minimal personal data necessary for the current operation. Do not persist raw sensitive identifiers other than temporary ephemeral values used for immediate flows.
  - **Separation of Concerns**: Retrieval, simplification, decision-making, and generation are distinct steps.
  - **Schema-first validation**: All API boundaries and LLM structured outputs are validated with Zod-like schemas.
  - **Defend against prompt injection**: Treat all RAG/scraped data as untrusted input; never allow it to change system behavior or tool permissions.

---

## 3. How the Solution Works (High-Level Flow)
- **User Requests**: Text or voice request enters the system.
- **Transport & Preprocessing**: Voice is transcribed ([stt.ts](file:///smart-bharat/src/voice/stt.ts)), text is normalized, and request metadata is recorded with rate-limiting.
- **Intent Classification**: [intent.ts](file:///smart-bharat/src/agents/intent.ts) classifies intent and routes the request to the appropriate sub-agent (e.g., `scheme`, `grievance`, `photo`).
- **Retrieval (RAG)**: The system uses [ingest.ts](file:///smart-bharat/src/rag/ingest.ts) and [store.ts](file:///smart-bharat/src/rag/store.ts) to perform embedding-based retrieval against the indexed government corpus.
- **Simplification & Structured Extraction**: Retrieval results are normalized and passed through schema validators ([schemas.ts](file:///smart-bharat/src/schemas.ts)) and guardrails ([guardrails.ts](file:///smart-bharat/src/guardrails.ts)). Structured outputs are enforced using typed schemas.
- **Action Planning & Browser Automation**: For steps that require browser actions (filling forms, navigation), a playbook is executed by [playwright-driver.ts](file:///smart-bharat/src/agents/playwright-driver.ts) and [browser-executor.ts](file:///smart-bharat/src/agents/browser-executor.ts). [browser.graph.ts](file:///smart-bharat/src/orchestrator/browser.graph.ts) coordinates graph-based steps.
- **Human Confirmation Checkpoint**: Before any final submission or state-changing action, the system presents a clear confirmation and halts automatic progression until human approval is received (using LangGraph `interrupt()`). This preserves safety and auditability.
- **Execution & Logging**: Actions run in background workers ([nudge.ts](file:///smart-bharat/src/workers/nudge.ts), [sla-escalation.ts](file:///smart-bharat/src/workers/sla-escalation.ts)) and are logged to the database.

---

## 4. Architecture & Components

### Frontend ([smart-bharat/web](file:///smart-bharat/web/))
- **[App.tsx](file:///smart-bharat/web/src/App.tsx)**: Main UI, voice integration, panels, and tab routing.
- **[ErrorBoundary.tsx](file:///smart-bharat/web/src/ErrorBoundary.tsx)**: Handles uncaught exceptions cleanly to prevent application crashes.
- **[voice.ts](file:///smart-bharat/web/src/voice.ts)**: Client-side voice helpers that call STT/TTS endpoints.

### Server / Core ([smart-bharat/src](file:///smart-bharat/src/))
- **[server.ts](file:///smart-bharat/src/server.ts)**: HTTP server and route wiring.
- **[auth.ts](file:///smart-bharat/src/auth.ts)**: Auth patterns and token handling; ensures no credentials are proxied to the backend.
- **[guardrails.ts](file:///smart-bharat/src/guardrails.ts)**: System guardrails for human-in-the-loop enforcement, prompt-safety rules, and PII redaction.
- **[schemas.ts](file:///smart-bharat/src/schemas.ts)**: Zod schemas for all API and LLM structured outputs.
- **[config.ts](file:///smart-bharat/src/config.ts)**: Environment configuration, feature flags, and constants.

### Evaluation & Unit Tests ([smart-bharat/eval](file:///smart-bharat/eval/))
- **[run.ts](file:///smart-bharat/eval/run.ts)** & **[golden.json](file:///smart-bharat/eval/golden.json)**: Golden-set evaluation harness for routing accuracy, language-switch, and grounding.
- **[test-runner.ts](file:///smart-bharat/eval/test-runner.ts)**: Node.js native unit tests covering Zod schemas, input/output/grounding security guardrails, and PII redactions.

---

## 5. Assumptions Made
- **No automated OTP or credential capture**: The system will never accept OTPs, passwords, or CAPTCHAs as API parameters. Humans must input those into the browser UI context directly.
- **RAG Corpus is curated**: [corpus.json](file:///smart-bharat/data/corpus.json) is assumed to be authoritative; the ingestion pipeline keeps vectors up-to-date.
- **Local dev uses mocks**: Fallbacks are provided for LLMs and external services to allow offline local testing when API limits are reached.

---

## 6. Security & Privacy Safeguards
- **Human confirmation checkpoint**: Every path that mutates external portal state includes an explicit checkpoint and audit log entry.
- **PII minimization**: Automatically redacts sensitive fields like full Aadhaar numbers and phone numbers in outgoing LLM contexts, displaying only the last 4 digits.
- **Rate limiting**: API surfaces are protected by token bucket rate limiters to avoid DDoS or cost exhaustion.

---

## 7. How to Run the Project

### Prerequisite Setup
Configure the environment file in `smart-bharat/.env` (refer to `smart-bharat/.env.example`).

### 1. Install dependencies
```bash
cd smart-bharat
npm install
cd web && npm install
```

### 2. Run backend development server
```bash
# From smart-bharat/
npm run dev
```

### 3. Run frontend Vite server
```bash
# From smart-bharat/web/
npm run dev
```

### 4. Run unit test suite
```bash
# From smart-bharat/
npm run test
```

### 5. Run evaluation harness
```bash
# From smart-bharat/
npm run eval
```
