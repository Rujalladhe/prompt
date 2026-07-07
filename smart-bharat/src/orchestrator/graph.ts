import { StateGraph, Annotation, MemorySaver, START, END } from "@langchain/langgraph";
import { generate } from "../llm.js";
import { type Intent } from "../schemas.js";
import { classifyIntent } from "../agents/intent.js";
import { fileGrievanceFromText } from "../agents/grievance.js";
import { answerQuery, type Citation } from "../agents/query.js";
import { runSchemeTurn, type SchemeSlots } from "../agents/scheme.js";
import { grievances } from "../db.js";
import { getProfile, profileToSlots } from "../memory/profile.js";
import { inputGuard, outputGuard } from "../guardrails.js";
import { humanize } from "../domain.js";

/**
 * Orchestrator graph (spec §2.1). Genuine LangGraph state machine:
 *   ingest (input guardrail) → [scheme continuation? | classify] → sub-agent → merge
 * Short-term memory = MemorySaver checkpointer keyed by session (thread_id),
 * which also carries mid-conversation slot-filling state for the Scheme agent.
 * Long-term memory (profile) is loaded to prefill scheme slots. Every reply passes
 * the output guardrail (PII redaction). Every node appends to `trace`.
 */

export interface TraceStep { node: string; at: string; detail: string }
type Msg = { role: "user" | "assistant"; content: string };

const S = Annotation.Root({
  userId: Annotation<string>(),
  message: Annotation<string>(),
  mode: Annotation<"text" | "voice">({ default: () => "text", reducer: (_, x) => x }),
  turnStart: Annotation<string>({ default: () => "", reducer: (_, x) => x }),
  blocked: Annotation<boolean>({ default: () => false, reducer: (_, x) => x }),
  blockFlags: Annotation<string[]>({ default: () => [], reducer: (_, x) => x }),
  intent: Annotation<Intent | null>({ default: () => null, reducer: (_, x) => x }),
  reply: Annotation<string>({ default: () => "", reducer: (_, x) => x }),
  grievanceId: Annotation<string | null>({ default: () => null, reducer: (_, x) => x }),
  citations: Annotation<Citation[]>({ default: () => [], reducer: (_, x) => x }),
  schemeActive: Annotation<boolean>({ default: () => false, reducer: (_, x) => x }),
  schemeSlots: Annotation<SchemeSlots>({ default: () => ({}), reducer: (_, x) => x }),
  history: Annotation<Msg[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
  trace: Annotation<TraceStep[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
});

const step = (node: string, detail: string): TraceStep => ({ node, at: new Date().toISOString(), detail });

// --- nodes ---
async function ingest(s: typeof S.State) {
  const now = new Date().toISOString();
  const guard = inputGuard(s.message);
  return {
    turnStart: now,
    blocked: !guard.allowed,
    blockFlags: guard.flags,
    citations: [],
    history: [{ role: "user", content: s.message } as Msg],
    trace: [step("ingest", guard.allowed ? `ok: "${s.message.slice(0, 60)}"` : `BLOCKED: ${guard.flags.join(",")}`)],
  };
}

async function refuse(s: typeof S.State) {
  const f = s.blockFlags;
  let reply: string;
  if (f.includes("out_of_scope_medical"))
    reply = "I'm a civic-services assistant, not a doctor — I can't advise on medicines or symptoms. Please consult a qualified physician or call the national health helpline 104. I can help with health schemes like Ayushman Bharat if that's useful.";
  else if (f.includes("out_of_scope_legal"))
    reply = "I can't give legal advice or draft court cases. Please consult a lawyer or your District Legal Services Authority (free legal aid). I can, however, help you file a civic grievance or draft an RTI for a government department.";
  else if (f.includes("third_party_pii"))
    reply = "I can only access your own records, not another person's private data. Each citizen can view their own complaints and details when signed in.";
  else if (f.includes("bypass_human_review"))
    reply = "An RTI is a legal document, so I always show you the draft to review and you submit it yourself — I won't file it without your explicit confirmation. Here's how it works: I'll prepare it and you click submit.";
  else
    reply = "I can't help with that request — it looks like an attempt to override my rules. I can help you file complaints, find schemes, or check government info from verified sources.";
  return { reply, history: [{ role: "assistant", content: reply } as Msg], trace: [step("guardrail_refuse", `blocked: ${f.join(",")}`)] };
}

async function classify(s: typeof S.State) {
  const intent = await classifyIntent(s.message);
  return { intent, trace: [step("classify", `intent=${intent.intent} lang=${intent.language} (${intent.confidence.toFixed(2)})`)] };
}

async function nodeFileGrievance(s: typeof S.State) {
  const g = await fileGrievanceFromText(s.userId, s.message);
  const reply = `I've filed your complaint and routed it to the ${humanize(g.department)}.\n\n• Reference: ${g._id}\n• Category: ${humanize(g.category)} (severity: ${g.severity})\n• Resolution deadline (SLA): ${new Date(g.sla_deadline).toLocaleString()}\n\nIf the department misses the deadline I'll auto-draft a follow-up, and if it keeps slipping I'll prepare an RTI application for you to review.`;
  return { reply, grievanceId: g._id, history: [{ role: "assistant", content: reply } as Msg], trace: [step("grievance_agent", `filed ${g._id} -> ${g.department}/${g.category}`)] };
}

async function nodeGrievanceStatus(s: typeof S.State) {
  const list = await grievances().list({ user_id: s.userId });
  const reply = list.length
    ? "Here are your complaints:\n\n" + list.map((g) => `• [${g._id}] ${g.title} — ${humanize(g.status)}${g.escalation_level ? ` (L${g.escalation_level})` : ""}${g.rti_draft ? " · RTI draft ready" : ""}`).join("\n")
    : "You don't have any complaints on file yet. Describe an issue or upload a photo and I'll file one.";
  return { reply, history: [{ role: "assistant", content: reply } as Msg], trace: [step("grievance_status", `listed ${list.length}`)] };
}

async function nodeQuery(s: typeof S.State) {
  const r = await answerQuery(s.message, s.intent?.language ?? "en");
  return {
    reply: r.answer,
    citations: r.citations,
    history: [{ role: "assistant", content: r.answer } as Msg],
    trace: [step("query_rag", `${r.refused ? "refused (no source)" : `${r.citations.length} citation(s), grounded=${r.grounded}`}`)],
  };
}

async function nodeScheme(s: typeof S.State) {
  const first = !s.schemeActive;
  let slots = s.schemeSlots;
  if (first) {
    const p = await getProfile(s.userId);
    slots = { ...profileToSlots(p), ...slots }; // prefill from long-term memory
  }
  const turn = await runSchemeTurn(slots, s.message, first);
  return {
    reply: turn.reply,
    schemeSlots: turn.slots,
    schemeActive: !turn.done,
    history: [{ role: "assistant", content: turn.reply } as Msg],
    trace: [step("scheme_matchmaker", turn.done ? `matched (${turn.matches?.length ?? 0})` : `slot-filling: asking next`)],
  };
}

async function nodeGeneric(s: typeof S.State) {
  const intent = s.intent?.intent ?? "smalltalk";
  const hint =
    intent === "service_automation"
      ? " Tell them they can start a guided, human-in-the-loop portal automation from the Automation panel (e.g. Aadhaar update, ration card)."
      : intent === "document_help"
      ? " Tell them to upload the document in the Documents panel and I'll check it against a service's required documents."
      : intent === "photo_complaint"
      ? " Tell them to use the Photo panel to upload a photo of the civic issue."
      : "";
  const p = await getProfile(s.userId);
  const mem = p.history_summary ? `\nWhat I remember about this citizen: ${p.history_summary}` : "";
  const recent = s.history.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
  // Voice transport gets a distinct, tighter prompt variant (CLAUDE.md §4): long
  // paragraphs and bullet lists read poorly through TTS.
  const voiceStyle =
    s.mode === "voice"
      ? " This is a VOICE call: answer in 1–2 short, natural spoken sentences. No bullet points, no markdown, no URLs — just say it plainly as you would aloud."
      : "";
  const reply = await generate({
    task: "chat_reply",
    temperature: 0.4,
    system: `You are Smart Bharat, a warm, plain-spoken civic assistant for Indian citizens. Reply in the user's language/register (${s.intent?.language ?? "en"}), including natural Hinglish if they code-switched. Keep it short and speakable. Never invent scheme amounts, deadlines, or eligibility numbers.${voiceStyle}${hint}${mem}`,
    user: `Conversation so far:\n${recent}\n\nRespond to the last user message.`,
  });
  return { reply, history: [{ role: "assistant", content: reply } as Msg], trace: [step("generic_agent", `intent=${intent}`)] };
}

// --- routing ---
function afterIngest(s: typeof S.State): string {
  if (s.blocked) return "refuse";
  if (s.schemeActive) return "scheme"; // continue slot-filling without re-classifying answers
  return "classify";
}
function afterClassify(s: typeof S.State): string {
  switch (s.intent?.intent) {
    case "grievance_file": return "file_grievance";
    case "grievance_status": return "grievance_status";
    case "query": return "query";
    case "scheme_match": return "scheme";
    default: return "generic";
  }
}

const graph = new StateGraph(S)
  .addNode("ingest", ingest)
  .addNode("refuse", refuse)
  .addNode("classify", classify)
  .addNode("file_grievance", nodeFileGrievance)
  .addNode("grievance_status", nodeGrievanceStatus)
  .addNode("query", nodeQuery)
  .addNode("scheme", nodeScheme)
  .addNode("generic", nodeGeneric)
  .addEdge(START, "ingest")
  .addConditionalEdges("ingest", afterIngest, { refuse: "refuse", scheme: "scheme", classify: "classify" })
  .addConditionalEdges("classify", afterClassify, {
    file_grievance: "file_grievance",
    grievance_status: "grievance_status",
    query: "query",
    scheme: "scheme",
    generic: "generic",
  })
  .addEdge("refuse", END)
  .addEdge("file_grievance", END)
  .addEdge("grievance_status", END)
  .addEdge("query", END)
  .addEdge("scheme", END)
  .addEdge("generic", END);

const app = graph.compile({ checkpointer: new MemorySaver() });

export interface OrchestratorResult {
  reply: string;
  intent: Intent | null;
  grievanceId: string | null;
  citations: Citation[];
  schemeActive: boolean;
  trace: TraceStep[];
}

export async function runOrchestrator(input: { userId: string; sessionId: string; message: string; mode?: "text" | "voice" }): Promise<OrchestratorResult> {
  const out = await app.invoke(
    { userId: input.userId, message: input.message, mode: input.mode ?? "text" },
    { configurable: { thread_id: input.sessionId } },
  );
  const safe = outputGuard(out.reply); // output guardrail: redact PII before it leaves
  return {
    reply: safe.text,
    intent: out.intent,
    grievanceId: out.grievanceId,
    citations: out.citations,
    schemeActive: out.schemeActive,
    trace: out.trace.filter((t) => t.at >= out.turnStart),
  };
}
