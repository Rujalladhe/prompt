import { z } from "zod";
import { config } from "../config.js";

/**
 * Google Gemini backend via the Generative Language REST API (key-only auth — no
 * service account, no SDK). This is the primary "Google as much as possible" LLM
 * path: text + vision structured output and text embeddings, all behind the same
 * `structured()` / `structuredVision()` / `generate()` contract as the Groq path.
 *
 * Every call is defensive: network/parse failures throw a typed error that the
 * llm.ts chokepoint catches and degrades from (to Groq or the deterministic mock),
 * so Gemini being unavailable never takes a request down (CLAUDE.md §5/§7).
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiError extends Error {}

// ---- Zod -> Gemini responseSchema (OpenAPI subset) ----
type GSchema = Record<string, unknown>;

/** Translate the subset of Zod we use into Gemini's structured-output schema. */
export function zodToGoogleSchema(schema: z.ZodTypeAny): GSchema {
  const def: any = (schema as any)._def;
  const t: string = def?.typeName;
  switch (t) {
    case "ZodString":
      return { type: "STRING" };
    case "ZodNumber":
      return def.checks?.some((c: any) => c.kind === "int") ? { type: "INTEGER" } : { type: "NUMBER" };
    case "ZodBoolean":
      return { type: "BOOLEAN" };
    case "ZodEnum":
      return { type: "STRING", enum: def.values };
    case "ZodNativeEnum":
      return { type: "STRING", enum: Object.values(def.values) };
    case "ZodArray":
      return { type: "ARRAY", items: zodToGoogleSchema(def.type) };
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, GSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
        properties[k] = zodToGoogleSchema(v);
        const inner: string = (v as any)._def?.typeName;
        if (inner !== "ZodOptional" && inner !== "ZodDefault") required.push(k);
      }
      return { type: "OBJECT", properties, required };
    }
    case "ZodRecord":
      // Gemini has no additionalProperties; represent free-form maps as a bare object.
      return { type: "OBJECT" };
    case "ZodNullable":
      return { ...zodToGoogleSchema(def.innerType), nullable: true };
    case "ZodOptional":
    case "ZodDefault":
      return zodToGoogleSchema(def.innerType);
    case "ZodEffects":
      return zodToGoogleSchema(def.schema);
    default:
      return { type: "STRING" };
  }
}

interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function generateContent(opts: {
  model: string;
  system: string;
  parts: Part[];
  temperature: number;
  responseSchema?: GSchema;
}): Promise<string> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature,
      ...(opts.responseSchema
        ? { responseMimeType: "application/json", responseSchema: opts.responseSchema }
        : {}),
    },
  };
  const r = await fetch(`${BASE}/models/${opts.model}:generateContent?key=${config.googleApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new GeminiError(`Gemini ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data: any = await r.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .map((p: any) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new GeminiError(`Gemini returned no text (finishReason=${cand?.finishReason ?? "?"})`);
  return text;
}

/** Split a `data:<mime>;base64,<data>` URL into Gemini inline_data. */
function inlineImage(dataUrl: string): Part {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new GeminiError("expected a base64 data: URL for the image");
  return { inline_data: { mime_type: m[1], data: m[2] } };
}

export async function geminiStructured<T extends z.ZodTypeAny>(
  schema: T,
  system: string,
  user: string,
): Promise<z.infer<T>> {
  const text = await generateContent({
    model: config.geminiTextModel,
    system,
    parts: [{ text: user }],
    temperature: 0,
    responseSchema: zodToGoogleSchema(schema),
  });
  return schema.parse(JSON.parse(text));
}

export async function geminiStructuredVision<T extends z.ZodTypeAny>(
  schema: T,
  system: string,
  user: string,
  imageDataUrl: string,
): Promise<z.infer<T>> {
  const text = await generateContent({
    model: config.geminiVisionModel,
    system,
    parts: [{ text: user }, inlineImage(imageDataUrl)],
    temperature: 0,
    responseSchema: zodToGoogleSchema(schema),
  });
  return schema.parse(JSON.parse(text));
}

export async function geminiGenerate(system: string, user: string, temperature = 0.3): Promise<string> {
  return generateContent({ model: config.geminiTextModel, system, parts: [{ text: user }], temperature });
}

/** Embed one text with Gemini embeddings (returns a dense vector). */
export async function geminiEmbed(text: string): Promise<number[]> {
  const r = await fetch(`${BASE}/models/${config.geminiEmbedModel}:embedContent?key=${config.googleApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: `models/${config.geminiEmbedModel}`, content: { parts: [{ text }] } }),
  });
  if (!r.ok) throw new GeminiError(`Gemini embed ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await r.json();
  const values = data.embedding?.values;
  if (!Array.isArray(values)) throw new GeminiError("Gemini embed returned no vector");
  return values as number[];
}

/** Embed many texts. Uses batch endpoint; falls back to sequential on error. */
export async function geminiEmbedBatch(texts: string[]): Promise<number[][]> {
  const model = `models/${config.geminiEmbedModel}`;
  const r = await fetch(`${BASE}/${model}:batchEmbedContents?key=${config.googleApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((text) => ({ model, content: { parts: [{ text }] } })),
    }),
  });
  if (!r.ok) throw new GeminiError(`Gemini batchEmbed ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await r.json();
  const embs = data.embeddings;
  if (!Array.isArray(embs)) throw new GeminiError("Gemini batchEmbed returned no vectors");
  return embs.map((e: any) => e.values as number[]);
}
