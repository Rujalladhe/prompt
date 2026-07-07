import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyIntent } from "../src/agents/intent.js";
import { inputGuard } from "../src/guardrails.js";
import { answerQuery } from "../src/agents/query.js";
import { ingestCorpus } from "../src/rag/ingest.js";
import { hasGroq } from "../src/config.js";

/**
 * Golden-set eval harness (spec §7). Run: `npm run eval`.
 * Tracks routing accuracy, language-switch accuracy, injection-refusal, and
 * grounding on needs-citation cases. Meant to run with a real GROQ_API_KEY;
 * in mock mode the classifier is a keyword heuristic, so scores will be lower —
 * that's expected and noted in the output.
 */

interface Case {
  id: string;
  input: string;
  expect_intent: string;
  expect_language: string;
  must_refuse: boolean;
  needs_citation: boolean;
  notes?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const cases: Case[] = JSON.parse(await readFile(join(__dirname, "golden.json"), "utf8"));
  await ingestCorpus();

  let routeOK = 0, routeTotal = 0;
  let langOK = 0, langTotal = 0;
  let refuseOK = 0, refuseTotal = 0;
  let groundOK = 0, groundTotal = 0;
  const failures: string[] = [];

  for (const c of cases) {
    if (c.must_refuse) {
      refuseTotal++;
      const g = inputGuard(c.input);
      // For no-source questions the Query agent also refuses; approximate here with inputGuard.
      if (!g.allowed) refuseOK++;
      else failures.push(`REFUSE  ${c.id}: not blocked — "${c.input.slice(0, 60)}"`);
      continue;
    }

    const intent = await classifyIntent(c.input);
    routeTotal++;
    if (intent.intent === c.expect_intent) routeOK++;
    else failures.push(`ROUTE   ${c.id}: got ${intent.intent}, want ${c.expect_intent} — "${c.input.slice(0, 50)}"`);

    langTotal++;
    if ((intent.language || "").toLowerCase().startsWith(c.expect_language.split("-")[0])) langOK++;

    if (c.needs_citation) {
      groundTotal++;
      const r = await answerQuery(c.input, intent.language);
      if (r.grounded && r.citations.length > 0 && !r.refused) groundOK++;
      else failures.push(`GROUND  ${c.id}: no citation — "${c.input.slice(0, 50)}"`);
    }
  }

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);
  console.log(`\n=== Smart Bharat eval (${cases.length} cases, LLM=${hasGroq() ? "groq" : "MOCK"}) ===`);
  console.log(`Routing accuracy   : ${routeOK}/${routeTotal}  (${pct(routeOK, routeTotal)}%)`);
  console.log(`Language accuracy  : ${langOK}/${langTotal}  (${pct(langOK, langTotal)}%)`);
  console.log(`Injection refusal  : ${refuseOK}/${refuseTotal}  (${pct(refuseOK, refuseTotal)}%)`);
  console.log(`Grounding (cited)  : ${groundOK}/${groundTotal}  (${pct(groundOK, groundTotal)}%)`);
  if (failures.length) {
    console.log(`\n--- ${failures.length} failure(s) ---`);
    failures.slice(0, 25).forEach((f) => console.log("  " + f));
  }
  if (!hasGroq()) console.log(`\nNote: running in MOCK mode — set GROQ_API_KEY for representative routing/language scores.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
