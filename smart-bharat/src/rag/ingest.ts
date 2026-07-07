import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vectorStore, type Chunk } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "../../data/corpus.json");

interface CorpusDoc {
  id: string;
  title: string;
  department: string;
  source_url: string;
  published_date: string;
  sections: { heading: string; text: string }[];
}

/**
 * Ingestion pipeline (spec §5). Chunk BY SEMANTIC SECTION (not fixed windows) so
 * a scheme's eligibility clause is never split mid-sentence, embed, and index.
 * In production the corpus is refreshed by a BullMQ scraper cron; here we load a
 * curated seed file. Re-running index() re-embeds (cheap for the demo size).
 */
export async function ingestCorpus(): Promise<number> {
  let docs: CorpusDoc[];
  try {
    docs = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  } catch (e) {
    console.warn(`[rag] no corpus at ${CORPUS_PATH} — RAG will return no results until data/corpus.json exists`);
    return 0;
  }
  const chunks: Chunk[] = [];
  for (const d of docs) {
    d.sections.forEach((s, i) => {
      chunks.push({
        id: `${d.id}#${i}`,
        doc_id: d.id,
        title: d.title,
        department: d.department,
        source_url: d.source_url,
        published_date: d.published_date,
        heading: s.heading,
        text: s.text,
      });
    });
  }
  await vectorStore.index(chunks);
  console.log(`[rag] indexed ${chunks.length} chunks from ${docs.length} documents`);
  return chunks.length;
}
