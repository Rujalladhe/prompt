import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMES_PATH = join(__dirname, "../../data/schemes.json");

/**
 * Scheme Matchmaker (spec §2.3). Conversational slot-filling collected one
 * question at a time (NOT a giant form), then deterministic eligibility matching
 * against the curated schemes table with a plain-language "why you qualify".
 * Matching is deterministic (not an LLM guess) so it's reliable and eval-able.
 */

export interface Scheme {
  id: string;
  name: string;
  department: string;
  benefit: string;
  eligibility: {
    min_age: number | null;
    max_age: number | null;
    occupations: string[];
    max_annual_income: number | null;
    categories: string[];
    gender: "any" | "male" | "female";
    states: string[];
    requires_disability: boolean;
    notes?: string;
  };
  why: string;
  documents: string[];
  source_url: string;
  disclaimer?: string;
}

export interface SchemeSlots {
  age?: number;
  occupation?: string;
  annual_income?: number;
  category?: string;
  state?: string;
  gender?: "male" | "female" | "any";
  disability?: boolean;
}

let cache: Scheme[] | null = null;
export async function loadSchemes(): Promise<Scheme[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(SCHEMES_PATH, "utf8")) as Scheme[];
  } catch {
    console.warn("[scheme] no data/schemes.json — matchmaker returns nothing");
    cache = [];
  }
  return cache;
}

// --- slot collection: one question at a time, in this order ---
const SLOT_ORDER: (keyof SchemeSlots)[] = ["age", "gender", "occupation", "annual_income", "category", "state"];
const QUESTIONS: Record<string, string> = {
  age: "To find schemes you're eligible for, what's your age?",
  gender: "What's your gender? (male / female)",
  occupation: "What's your occupation? (farmer, student, worker, self-employed, salaried, homemaker, unemployed, senior)",
  annual_income: "What's your household's approximate annual income in ₹? (e.g. 150000, or say '2 lakh')",
  category: "Your social category? (General / OBC / SC / ST / EWS / Minority)",
  state: "Which state do you live in?",
};

export function nextSlot(slots: SchemeSlots): keyof SchemeSlots | null {
  return SLOT_ORDER.find((s) => slots[s] === undefined) ?? null;
}

/** Parse a user's reply as the value of the specific slot we just asked for. */
export function parseSlot(slot: keyof SchemeSlots, message: string): Partial<SchemeSlots> {
  const t = message.toLowerCase();
  switch (slot) {
    case "age": {
      const m = t.match(/\d{1,3}/);
      return m ? { age: Number(m[0]) } : {};
    }
    case "annual_income": {
      const lakh = t.match(/(\d+(?:\.\d+)?)\s*lakh/);
      if (lakh) return { annual_income: Math.round(Number(lakh[1]) * 100000) };
      const cr = t.match(/(\d+(?:\.\d+)?)\s*crore/);
      if (cr) return { annual_income: Math.round(Number(cr[1]) * 10000000) };
      const m = t.replace(/[, ]/g, "").match(/\d{3,}/);
      return m ? { annual_income: Number(m[0]) } : {};
    }
    case "occupation": {
      const map: [RegExp, string][] = [
        [/farm|kisan|krishi/, "farmer"],
        [/student|padh|scholar/, "student"],
        [/labor|labour|worker|mazdoor|daily wage/, "worker"],
        [/self.?employ|business|vendor|shop/, "self-employed"],
        [/salar|job|private|govt|government employee/, "salaried"],
        [/home ?maker|housewife|grihini/, "homemaker"],
        [/unemploy|no job|jobless/, "unemployed"],
        [/senior|retire|pension|old/, "senior"],
      ];
      for (const [re, val] of map) if (re.test(t)) return { occupation: val };
      return { occupation: t.trim().split(/\s+/)[0] || "other" };
    }
    case "category": {
      if (/\bst\b|scheduled tribe|adivasi/.test(t)) return { category: "st" };
      if (/\bsc\b|scheduled caste|dalit/.test(t)) return { category: "sc" };
      if (/obc|backward/.test(t)) return { category: "obc" };
      if (/ews|economically weak/.test(t)) return { category: "ews" };
      if (/minorit|muslim|christian|sikh|jain|buddhist|parsi/.test(t)) return { category: "minority" };
      return { category: "general" };
    }
    case "gender": {
      if (/\bfemale\b|\bwoman\b|\bwomen\b|\bgirl\b|mahila|ladki|stri/.test(t)) return { gender: "female" };
      if (/\bmale\b|\bman\b|\bboy\b|purush|ladka/.test(t)) return { gender: "male" };
      return { gender: "any" };
    }
    case "state":
      return { state: message.trim().toLowerCase() };
    default:
      return {};
  }
}

// --- matching ---
export interface SchemeMatch {
  scheme: Scheme;
  score: number;
  reasons: string[];
}

export function matchSchemes(slots: SchemeSlots, all: Scheme[]): SchemeMatch[] {
  const g = slots.gender ?? "any";
  const disabled = slots.disability ?? false;
  const results: SchemeMatch[] = [];

  for (const s of all) {
    const e = s.eligibility;
    const reasons: string[] = [];
    let ok = true;

    if (slots.age !== undefined) {
      if (e.min_age !== null && slots.age < e.min_age) ok = false;
      if (e.max_age !== null && slots.age > e.max_age) ok = false;
      if (ok && (e.min_age !== null || e.max_age !== null)) reasons.push(`your age fits (${e.min_age ?? "any"}–${e.max_age ?? "any"})`);
    }
    if (ok && slots.occupation && e.occupations.length && !e.occupations.includes("any")) {
      if (!e.occupations.includes(slots.occupation)) ok = false;
      else reasons.push(`for ${e.occupations.join("/")}`);
    }
    if (ok && slots.annual_income !== undefined && e.max_annual_income !== null) {
      if (slots.annual_income > e.max_annual_income) ok = false;
      else reasons.push(`income under ₹${e.max_annual_income.toLocaleString("en-IN")}`);
    }
    if (ok && slots.category && !e.categories.includes("all")) {
      if (!e.categories.includes(slots.category)) ok = false;
      else reasons.push(`open to ${slots.category.toUpperCase()}`);
    }
    if (ok && e.gender !== "any" && g !== "any") {
      if (e.gender !== g) ok = false;
      else reasons.push(`${e.gender}-focused`);
    }
    if (ok && !e.states.includes("all") && slots.state) {
      if (!e.states.some((st) => slots.state!.includes(st) || st.includes(slots.state!))) ok = false;
      else reasons.push(`available in your state`);
    }
    if (ok && e.requires_disability && !disabled) ok = false;

    if (ok) {
      reasons.unshift(s.why);
      results.push({ scheme: s, score: reasons.length, reasons });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

export interface SchemeTurn {
  slots: SchemeSlots;
  reply: string;
  done: boolean;
  matches?: { name: string; benefit: string; why: string; source_url: string }[];
}

/**
 * One turn of the matchmaker. `isFirstTurn` = the message that triggered scheme
 * intent (don't consume it as a slot answer). Otherwise the message answers the
 * slot we last asked for.
 */
export async function runSchemeTurn(
  prev: SchemeSlots,
  message: string,
  isFirstTurn: boolean,
): Promise<SchemeTurn> {
  let slots = { ...prev };

  if (!isFirstTurn) {
    const asked = nextSlot(prev); // the slot we were waiting on
    if (asked) slots = { ...slots, ...parseSlot(asked, message) };
  }

  const need = nextSlot(slots);
  if (need) {
    return { slots, reply: QUESTIONS[need], done: false };
  }

  const all = await loadSchemes();
  const matches = matchSchemes(slots, all).slice(0, 5);
  if (matches.length === 0) {
    return {
      slots,
      done: true,
      reply: "Based on what you shared, I couldn't confidently match a scheme. Rules change often — please check the National Scholarship Portal / MyScheme portal, or tell me more.",
    };
  }
  const reply =
    "Based on your details, you likely qualify for:\n\n" +
    matches
      .map((m, i) => `${i + 1}. **${m.scheme.name}** — ${m.scheme.benefit}\n   Why: ${m.reasons.slice(0, 3).join("; ")}\n   ${m.scheme.source_url}`)
      .join("\n\n") +
    "\n\n(Approximate — verify eligibility on the official portal.)";
  return {
    slots,
    done: true,
    reply,
    matches: matches.map((m) => ({ name: m.scheme.name, benefit: m.scheme.benefit, why: m.reasons[0], source_url: m.scheme.source_url })),
  };
}
