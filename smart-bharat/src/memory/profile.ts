import { mongoDbHandle } from "../db.js";
import { generate } from "../llm.js";
import type { SchemeSlots } from "../agents/scheme.js";

/**
 * Big memory / long-term profile (spec §4). Persisted per user, distinct from the
 * LangGraph session checkpointer (small memory). Stored in Mongo when available,
 * else in-memory. History is SUMMARIZED, not raw-logged, to keep context
 * injection cheap and avoid leaking stale detail into every future prompt.
 */

export interface UserProfile {
  user_id: string;
  canonical_profile: {
    name?: string;
    dob?: string; // ISO
    address?: string;
    state?: string;
    income_band?: string; // e.g. "under_1L", "1L_2.5L", "above_8L"
    annual_income?: number;
    category?: string;
    gender?: "male" | "female" | "any";
    occupation?: string;
    documents_on_file: string[];
  };
  history_summary: string;
  preferences: { language: string; voice_or_text: "voice" | "text" };
  updated_at: string;
}

function blank(user_id: string): UserProfile {
  return {
    user_id,
    canonical_profile: { documents_on_file: [] },
    history_summary: "",
    preferences: { language: "en", voice_or_text: "text" },
    updated_at: new Date().toISOString(),
  };
}

const mem = new Map<string, UserProfile>();

function col() {
  return mongoDbHandle()?.collection<UserProfile>("user_profiles") ?? null;
}

export async function getProfile(user_id: string): Promise<UserProfile> {
  const c = col();
  if (c) return ((await c.findOne({ user_id })) as UserProfile) ?? blank(user_id);
  return mem.get(user_id) ?? blank(user_id);
}

export async function upsertProfile(p: UserProfile): Promise<UserProfile> {
  p.updated_at = new Date().toISOString();
  const c = col();
  if (c) await c.updateOne({ user_id: p.user_id }, { $set: p }, { upsert: true });
  else mem.set(p.user_id, p);
  return p;
}

export async function listProfiles(): Promise<UserProfile[]> {
  const c = col();
  if (c) return (await c.find({}).toArray()) as UserProfile[];
  return [...mem.values()];
}

// Fields to scaffold when an atomic update inserts a brand-new profile document,
// so the inserted doc has the same shape as blank() (never a partial record).
const insertScaffold = () => ({
  history_summary: "",
  preferences: { language: "en", voice_or_text: "text" as const },
});

export async function patchCanonical(user_id: string, patch: Partial<UserProfile["canonical_profile"]>) {
  const c = col();
  if (c) {
    // Atomic field-level $set so two concurrent patches don't clobber each other
    // (a whole-document read-modify-write would lose one update).
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) set[`canonical_profile.${k}`] = v;
    const onInsert: Record<string, unknown> = { user_id, ...insertScaffold() };
    if (!("documents_on_file" in patch)) onInsert["canonical_profile.documents_on_file"] = [];
    await c.updateOne({ user_id }, { $set: set, $setOnInsert: onInsert }, { upsert: true });
    return getProfile(user_id);
  }
  const p = await getProfile(user_id);
  p.canonical_profile = { ...p.canonical_profile, ...patch };
  return upsertProfile(p);
}

export async function addDocOnFile(user_id: string, doc: string) {
  const c = col();
  if (c) {
    // Atomic $addToSet — no read, no lost update, no duplicate.
    await c.updateOne(
      { user_id },
      {
        $addToSet: { "canonical_profile.documents_on_file": doc },
        $set: { updated_at: new Date().toISOString() },
        $setOnInsert: { user_id, ...insertScaffold() },
      },
      { upsert: true },
    );
    return getProfile(user_id);
  }
  const p = await getProfile(user_id);
  if (!p.canonical_profile.documents_on_file.includes(doc)) {
    p.canonical_profile.documents_on_file.push(doc);
    await upsertProfile(p);
  }
  return p;
}

/** Derive scheme-matcher slots from the stored profile to skip questions. */
export function profileToSlots(p: UserProfile): SchemeSlots {
  const cp = p.canonical_profile;
  const slots: SchemeSlots = {};
  if (cp.dob) {
    const age = Math.floor((Date.now() - new Date(cp.dob).getTime()) / (365.25 * 86400 * 1000));
    if (age > 0 && age < 130) slots.age = age;
  }
  if (cp.annual_income !== undefined) slots.annual_income = cp.annual_income;
  if (cp.occupation) slots.occupation = cp.occupation;
  if (cp.category) slots.category = cp.category;
  if (cp.state) slots.state = cp.state;
  if (cp.gender) slots.gender = cp.gender;
  return slots;
}

/**
 * Session-end summarization job: compress conversation turns into history_summary
 * rather than storing every message. Runs on demand (or a cron in production).
 */
export async function summarizeSession(user_id: string, turns: { role: string; content: string }[]) {
  if (turns.length === 0) return;
  const p = await getProfile(user_id);
  const convo = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  const summary = await generate({
    task: "summarize_history",
    temperature: 0.2,
    system: "Compress the conversation into a 1-2 sentence factual summary of what the citizen did/asked (schemes, complaints, documents). Merge with the prior summary. No PII beyond first name.",
    user: `Prior summary: ${p.history_summary || "(none)"}\n\nNew conversation:\n${convo}`,
  });
  p.history_summary = summary.trim();
  await upsertProfile(p);
}
