import { z } from "zod";

/**
 * Deterministic, key-free fallbacks. These are NOT trying to be smart — they use
 * cheap keyword heuristics so the app behaves plausibly in a demo before a real
 * GROQ_API_KEY is added. Every branch is keyed by the `task` string the caller
 * passes to llm.structured()/generate().
 */

const kw = (t: string, words: string[]) => words.some((w) => t.toLowerCase().includes(w));

export function mockStructured<T extends z.ZodTypeAny>(
  task: string,
  schema: T,
  user: string,
): z.infer<T> {
  const t = user.toLowerCase();
  // Every branch returns through schema.parse() so the mock (the DEFAULT demo mode
  // with no keys) is held to the exact same contract as a real LLM (CLAUDE.md §3/§8):
  // a mock that drifts from the schema fails loudly here instead of routing wrong.

  if (task === "classify_intent") {
    let intent = "smalltalk";
    // Order matters: interactive/action intents before factual query, complaints last-ish.
    if (kw(t, ["status", "kahan tak", "track", "progress"]) && kw(t, ["complaint", "grievance", "shikayat", "my"]))
      intent = "grievance_status";
    else if (kw(t, ["which scheme", "am i eligible", "eligible for", "schemes for", "kaun si yojana", "scheme match", "which schemes"]))
      intent = "scheme_match";
    else if (
      kw(t, ["how much", "kitna", "kitne", "amount", "how to", "how do i", "what is", "documents required", "required documents", "eligibility", "process", "rti", "pm-kisan", "pmkisan", "ayushman", "pmay", "awas", "ujjwala", "scholarship", "ration card", "pension"]) &&
      !kw(t, ["file a", "there is", "complaint about", "pothole", "garbage"])
    )
      intent = "query";
    else if (kw(t, ["complaint", "pothole", "garbage", "streetlight", "drain", "sewage", "power cut", "file", "shikayat", "problem"]))
      intent = "grievance_file";
    else if (kw(t, ["scheme", "yojana", "eligible", "subsidy"])) intent = "scheme_match";
    else if (kw(t, ["check my", "verify", "upload", "certificate", "my aadhaar", "my pan"])) intent = "document_help";
    const language = /[ऀ-ॿ]/.test(user) ? "hi" : kw(t, ["hai", "kya", "mera", "banwana"]) ? "hi-en" : "en";
    return schema.parse({ intent, language, confidence: 0.6, reason: "mock keyword heuristic (no LLM key set)" });
  }

  if (task === "classify_grievance") {
    let category = "other";
    let department = "municipal_corporation";
    if (kw(t, ["pothole", "gaddha", "road"])) { category = "pothole"; department = "public_works"; }
    else if (kw(t, ["garbage", "kachra", "trash", "waste"])) { category = "garbage"; department = "sanitation"; }
    else if (kw(t, ["streetlight", "light", "batti"])) { category = "streetlight"; department = "electricity_board"; }
    else if (kw(t, ["drain", "sewage", "nali"])) { category = "drainage"; department = "sanitation"; }
    else if (kw(t, ["water", "paani", "supply"])) { category = "water_supply"; department = "water_board"; }
    else if (kw(t, ["power", "electricity", "bijli", "cut"])) { category = "power_cut"; department = "electricity_board"; }
    const severity = kw(t, ["urgent", "dangerous", "accident", "big", "बड़ा", "flood"]) ? "high" : "medium";
    return schema.parse({
      department,
      category,
      severity,
      title: `${category.replace(/_/g, " ")} complaint`,
      summary: user.slice(0, 240),
      location_hint: null,
    });
  }

  if (task === "classify_photo") {
    return schema.parse({
      is_civic_issue: true,
      category: "pothole",
      severity: "high",
      severity_reason: "mock: large surface break blocking part of the carriageway",
      description: "A damaged road surface is visible (mock classification — no LLM key set).",
    });
  }

  if (task === "extract_document") {
    return schema.parse({
      doc_type: "aadhaar",
      holder_name: "Demo User",
      id_number: "XXXX XXXX 1234",
      issue_date: null,
      address_present: true,
      fields: { note: "mock extraction — add a GOOGLE_API_KEY or GROQ_API_KEY for real vision OCR" },
      confidence: 0.5,
    });
  }

  // Fallback: return schema-shaped defaults isn't generically possible, so throw
  // a clear error for unknown tasks rather than guessing.
  throw new Error(`mockStructured: no mock defined for task "${task}"`);
}

export function mockText(task: string, user: string): string {
  if (task === "chat_reply")
    return "[mock mode — add GROQ_API_KEY for real answers] I can help you file complaints, check their status, and find government schemes. What would you like to do?";
  if (task === "follow_up_letter")
    return "Subject: Follow-up on pending civic complaint\n\nRespected Officer,\n\nThis is a polite reminder regarding a complaint that has crossed its expected resolution time. Kindly provide an update on the action taken. [mock draft]";
  if (task === "rti_body")
    return "To,\nThe Public Information Officer\n\nUnder the Right to Information Act, 2005, I request the following information regarding my complaint and the action taken on it, including dates, responsible officials, and current status. [mock draft — add GROQ_API_KEY for a tailored RTI]";
  return `[mock:${task}] ${user.slice(0, 120)}`;
}
