import { generate } from "../llm.js";
import { hasGroq, hasGemini, hasGoogleTranslate } from "../config.js";
import { googleTranslate } from "../providers/google-cloud.js";
import { vectorStore, type Hit } from "../rag/store.js";
import { groundingGuard, UNVERIFIED_FALLBACK } from "../guardrails.js";

const MS_PER_DAY = 86_400_000;
const SNIPPET_LEN = 240;

/**
 * Query Resolution Agent / RAG (spec §2.2).
 *  - Always answers WITH citations (source_url + snippet).
 *  - Refuses scheme/financial questions when nothing relevant is retrieved
 *    (primary hallucination guardrail).
 *  - Runs the grounding guardrail: a numeric claim with no citation is rejected.
 *  - Warns when the source document is stale.
 * Retrieval is lexical + key-free, so this agent is grounded even in mock mode.
 */

export interface Citation {
  n: number;
  title: string;
  source_url: string;
  snippet: string;
  published_date: string;
  stale: boolean;
}

const STALE_DAYS = 365;

interface CitedHit extends Citation {
  heading: string;
  text: string;
}

function markStale(hits: Hit[]): CitedHit[] {
  const now = Date.now();
  return hits.map((h, i) => ({
    n: i + 1,
    title: h.title,
    source_url: h.source_url,
    snippet: h.text.length > SNIPPET_LEN ? h.text.slice(0, SNIPPET_LEN - 3) + "…" : h.text,
    published_date: h.published_date,
    stale: (now - new Date(h.published_date).getTime()) / MS_PER_DAY > STALE_DAYS,
    heading: h.heading,
    text: h.text,
  }));
}

export interface QueryResult {
  answer: string;
  citations: Citation[];
  refused: boolean;
  grounded: boolean;
}

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Cross-lingual retrieval bridge. A non-English query can miss the English corpus
 * (lexically in TF-IDF mode; also helps semantic recall in dense mode), so on a
 * zero-hit we translate the query to English for the RETRIEVAL step ONLY — the
 * answer is still generated in the user's language, keeping retrieval / generation
 * separable as the spec's Query agent requires.
 *
 * Preference: Google Translate (fast, no LLM round-trip, works even in mock mode) →
 * an LLM keyword-translation fallback. Triggered on any zero-hit non-ASCII/Devanagari
 * query, not just Devanagari, so romanized Hinglish also gets a second attempt.
 */
async function translateForRetrieval(question: string): Promise<string> {
  if (hasGoogleTranslate()) {
    const t = await googleTranslate(question, "en");
    if (t) return t;
  }
  if (hasGroq() || hasGemini()) {
    const english = await generate({
      task: "translate_for_retrieval",
      temperature: 0,
      system:
        "Translate the user's civic/government query into a short English keyword phrase for a search index. Output ONLY the English keywords (scheme names, amounts, topics) — no translation notes, no punctuation, no explanation.",
      user: question,
    });
    return english.trim();
  }
  return "";
}

async function retrievalHits(question: string): Promise<Hit[]> {
  let hits = await vectorStore.search(question, 4);
  const needsBridge = hits.length === 0 && (DEVANAGARI.test(question) || /[^\x00-\x7F]/.test(question));
  if (needsBridge) {
    const english = await translateForRetrieval(question);
    if (english) hits = await vectorStore.search(english, 4);
  }
  return hits;
}

export async function answerQuery(question: string, language = "en"): Promise<QueryResult> {
  const hits = await retrievalHits(question);

  if (hits.length === 0) {
    return {
      answer:
        "I couldn't find this in my verified government sources, so I won't guess. Please check the official portal, or rephrase and I'll try again.",
      citations: [],
      refused: true,
      grounded: true,
    };
  }

  const cited = markStale(hits);
  const context = cited.map((c) => `[${c.n}] ${c.title} (${c.source_url})\n${c.heading}: ${c.text}`).join("\n\n");
  // Strip the internal heading/text before returning to the client (snippet is enough).
  const citations: Citation[] = cited.map(({ heading, text, ...c }) => c);

  let answer: string;
  if (!hasGroq() && !hasGemini()) {
    // Extractive fallback (no generative LLM): quote the top source directly
    // (still grounded, bounded length).
    answer = `According to ${cited[0].title}: ${cited[0].snippet} [1]`;
  } else {
    answer = await generate({
      task: "rag_answer",
      temperature: 0.2,
      system: `You are the Query agent of an Indian civic assistant. Answer ONLY from the provided sources. Cite each claim with its bracket number like [1]. If the sources don't cover it, say so — never invent amounts, dates, or eligibility. Reply in the user's language (${language}); keep it short and plain. Do NOT include full Aadhaar or phone numbers.`,
      user: `Question: ${question}\n\nSources:\n${context}\n\nAnswer with citations:`,
    });
  }

  // Grounding guardrail: numeric claim must be backed by a citation.
  const g = groundingGuard(answer, citations.length);
  if (!g.grounded) {
    return { answer: UNVERIFIED_FALLBACK, citations, refused: false, grounded: false };
  }

  const staleNote = citations.some((c) => c.stale)
    ? `\n\n⚠️ Some of this is from older notifications (see dates) — verify current rules on the official portal.`
    : "";

  return { answer: answer + staleNote, citations, refused: false, grounded: true };
}
