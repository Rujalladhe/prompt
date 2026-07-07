/**
 * Guardrails (spec §7). Three layers, all cheap and deterministic so they run on
 * every turn without an extra LLM round-trip:
 *   - inputGuard:   screen for prompt-injection / instruction-override, especially
 *                   important because RAG context comes from scraped gov pages
 *                   (retrieved content is DATA, never instructions).
 *   - outputGuard:  redact PII leaks — never echo a full Aadhaar/phone; last-4 only.
 *   - groundingGuard: any specific rupee amount / number in an answer must trace
 *                   to a retrieved citation, else the answer is rejected.
 */

const INJECTION_PATTERNS = [
  /ignore (all |your |previous )?(instructions|prompt|rules)/i,
  /disregard (the )?(above|previous|system)/i,
  /system prompt/i,
  /reveal (your )?(prompt|instructions|system)/i,
  /you are now/i,
  /developer mode/i,
  /pretend to be/i,
  /forget (everything|all|your)/i,
  /jailbreak/i,
];

export interface InputVerdict {
  allowed: boolean;
  reason?: string;
  flags: string[];
}

export function inputGuard(text: string): InputVerdict {
  const flags: string[] = [];
  for (const p of INJECTION_PATTERNS) if (p.test(text)) flags.push("prompt_injection");
  // bypass of mandatory human review (RTI / form submit) — English + Hinglish
  const submitIntent = /\b(rti|form|application|complaint)\b/i.test(text) && /\b(submit|file kar do|kar do|bhej do|daal do|jama kar)\b/i.test(text);
  const noReview = /(without (review|me|checking|my (consent|approval)))|(review nahi|bina review|bina mere|mujhe review nahi|without asking)/i.test(text);
  if (submitIntent && noReview) flags.push("bypass_human_review");

  // requests for ANOTHER person's private data
  const thirdParty = /\b(padosi|padoshi|neighbou?r|kisi aur|dusre|someone else'?s?|another (person|citizen|user)|friend'?s|dost (ki|ka|ke)|bhai ka|uncle ka|uske|uski|his |her )\b/i;
  const pii = /\b(aadhaar|aadhar|bank|account|details|otp|pension|ration|income|phone number|grievance id|complaint|status)\b/i;
  if (thirdParty.test(text) && pii.test(text)) flags.push("third_party_pii");

  // out-of-scope professional advice (medical / legal) — refer to a professional
  if (/\b(tablet|medicine|dawa|dose|dosage|symptom|bukhar|chest pain|prescri|diagnos)\b/i.test(text)) flags.push("out_of_scope_medical");
  if (/\b(court case|lawsuit|legal case|draft my (case|petition)|sue |kanooni case|mukadma)\b/i.test(text)) flags.push("out_of_scope_legal");

  const allowed = flags.length === 0;
  const reasons: Record<string, string> = {
    prompt_injection: "attempts to override the assistant's rules",
    bypass_human_review: "asks to skip the required human review of a legal document",
    third_party_pii: "asks for another person's private data",
    out_of_scope_medical: "asks for medical advice",
    out_of_scope_legal: "asks for legal advice",
  };
  return {
    allowed,
    flags,
    reason: allowed ? undefined : `Request ${flags.map((f) => reasons[f] ?? f).join(" / ")}.`,
  };
}

const AADHAAR = /\b(\d[ -]?){11}\d\b/g; // 12 digits, optional spaces/hyphens
const PHONE = /\b(?:\+?91[- ]?)?[6-9]\d{9}\b/g;

/** Redact PII in outgoing text: show only last 4 of long ID-like numbers. */
export function outputGuard(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text.replace(AADHAAR, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length !== 12) return m;
    redacted = true;
    return "XXXX XXXX " + digits.slice(-4);
  });
  out = out.replace(PHONE, (m) => {
    redacted = true;
    return "XXXXXX" + m.replace(/\D/g, "").slice(-4);
  });
  return { text: out, redacted };
}

// numbers that matter: rupee amounts, percentages, "X lakh/crore", explicit years-as-thresholds
const NUMERIC_CLAIM =
  /(₹\s?\d[\d,]*)|(\brs\.?\s?\d[\d,]*)|(\b\d+(\.\d+)?\s?(%|percent|lakh|crore|thousand)\b)|(\b\d{4,}\b)/i;

export interface GroundingVerdict {
  grounded: boolean;
  hasNumericClaim: boolean;
  reason?: string;
}

/**
 * If an answer asserts a specific amount/number, it must be backed by at least
 * one retrieved citation. Otherwise the caller should reject + regenerate with an
 * explicit "I couldn't verify this — check the official source" fallback.
 */
export function groundingGuard(answer: string, citationCount: number): GroundingVerdict {
  const hasNumericClaim = NUMERIC_CLAIM.test(answer);
  if (!hasNumericClaim) return { grounded: true, hasNumericClaim: false };
  if (citationCount > 0) return { grounded: true, hasNumericClaim: true };
  return {
    grounded: false,
    hasNumericClaim: true,
    reason: "Answer contains a specific number but has no supporting citation.",
  };
}

export const UNVERIFIED_FALLBACK =
  "I couldn't verify the exact figures from an official source right now, so I don't want to quote a number that might be wrong. Please check the official government portal, or ask me to look again.";
