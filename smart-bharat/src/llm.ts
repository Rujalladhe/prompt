import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config, hasGroq, hasGemini, llmBackend } from "./config.js";
import { mockStructured, mockText } from "./mock.js";
import { geminiStructured, geminiStructuredVision, geminiGenerate } from "./providers/gemini.js";

/**
 * Single choke-point for every LLM call. Three design goals:
 *  1) Structured output everywhere (spec §8) — callers pass a zod schema and get
 *     back a validated object, never a string they have to parse.
 *  2) Provider choice — Gemini (Google, preferred) or Groq, selected by
 *     llmBackend(); see config.ts. Callers are provider-agnostic.
 *  3) Never hard-fail a turn — providers are tried in order and ANY failure
 *     (missing key, outage, rate limit, bad output) cascades to the next, ending
 *     at the deterministic mock. Production stays up even if every external LLM is
 *     down (CLAUDE.md §5/§7: log with context, degrade gracefully).
 */

function groqTextModel(temperature = 0) {
  return new ChatGroq({ apiKey: config.groqApiKey, model: config.textModel, temperature });
}
function groqVisionModel() {
  return new ChatGroq({ apiKey: config.groqApiKey, model: config.visionModel, temperature: 0 });
}

/** Extract plain text from a LangChain message content (string or content-block array). */
function messageText(res: AIMessage): string {
  const c = res.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
  return String(c ?? "");
}

interface Attempt<R> {
  name: string;
  run: () => Promise<R>;
}

/**
 * Run providers in order, returning the first success. Each failure is logged with
 * context and we move on; the final attempt (always the mock) is expected to
 * succeed, so a turn is never dropped because an external provider misbehaved.
 */
async function withFallback<R>(task: string, attempts: Attempt<R>[]): Promise<R> {
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      return await a.run();
    } catch (e: any) {
      lastErr = e;
      console.warn(`[llm] ${a.name} ${task} failed (${e?.message ?? e}) — falling back to next provider`);
    }
  }
  throw lastErr ?? new Error(`[llm] no provider available for ${task}`);
}

/**
 * Order the real providers by preference, then append the mock as the guaranteed
 * final fallback. `gemini` / `groq` builders are only included when their key is set.
 */
function providerOrder(): ("gemini" | "groq")[] {
  const backend = llmBackend();
  const order: ("gemini" | "groq")[] = [];
  if (backend === "gemini") {
    order.push("gemini");
    if (hasGroq()) order.push("groq");
  } else if (backend === "groq") {
    order.push("groq");
    if (hasGemini()) order.push("gemini");
  }
  return order;
}

/** Structured text classification/extraction. `task` keys the mock fallback. */
export async function structured<T extends z.ZodTypeAny>(opts: {
  task: string;
  schema: T;
  system: string;
  user: string;
}): Promise<z.infer<T>> {
  const attempts: Attempt<z.infer<T>>[] = providerOrder().map((p) => ({
    name: p,
    run: () =>
      p === "gemini"
        ? geminiStructured(opts.schema, opts.system, opts.user)
        : groqStructured(opts),
  }));
  attempts.push({ name: "mock", run: async () => mockStructured(opts.task, opts.schema, opts.user) });
  return withFallback(opts.task, attempts);
}

async function groqStructured<T extends z.ZodTypeAny>(opts: { task: string; schema: T; system: string; user: string }): Promise<z.infer<T>> {
  const model = groqTextModel().withStructuredOutput(opts.schema, { name: opts.task });
  const out = await model.invoke([new SystemMessage(opts.system), new HumanMessage(opts.user)]);
  return opts.schema.parse(out); // validate at the boundary (CLAUDE.md §3) — never trust the cast
}

/** Structured output over an image (photo-to-complaint, document extraction). */
export async function structuredVision<T extends z.ZodTypeAny>(opts: {
  task: string;
  schema: T;
  system: string;
  user: string;
  imageDataUrl: string; // data:image/...;base64,....
}): Promise<z.infer<T>> {
  const attempts: Attempt<z.infer<T>>[] = providerOrder().map((p) => ({
    name: p,
    run: () =>
      p === "gemini"
        ? geminiStructuredVision(opts.schema, opts.system, opts.user, opts.imageDataUrl)
        : groqVision(opts),
  }));
  attempts.push({ name: "mock", run: async () => mockStructured(opts.task, opts.schema, opts.user) });
  return withFallback(opts.task, attempts);
}

async function groqVision<T extends z.ZodTypeAny>(opts: { task: string; schema: T; system: string; user: string; imageDataUrl: string }): Promise<z.infer<T>> {
  const model = groqVisionModel().withStructuredOutput(opts.schema, { name: opts.task });
  const out = await model.invoke([
    new SystemMessage(opts.system),
    new HumanMessage({
      content: [
        { type: "text", text: opts.user },
        { type: "image_url", image_url: { url: opts.imageDataUrl } },
      ],
    }),
  ]);
  return opts.schema.parse(out);
}

/** Free-form generation (RTI body, follow-up letter, chat reply). */
export async function generate(opts: {
  task: string;
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  const attempts: Attempt<string>[] = providerOrder().map((p) => ({
    name: p,
    run: () =>
      p === "gemini"
        ? geminiGenerate(opts.system, opts.user, opts.temperature ?? 0.3)
        : groqGenerate(opts),
  }));
  attempts.push({ name: "mock", run: async () => mockText(opts.task, opts.user) });
  return withFallback(opts.task, attempts);
}

async function groqGenerate(opts: { system: string; user: string; temperature?: number }): Promise<string> {
  const res = await groqTextModel(opts.temperature ?? 0.3).invoke([
    new SystemMessage(opts.system),
    new HumanMessage(opts.user),
  ]);
  return messageText(res);
}
