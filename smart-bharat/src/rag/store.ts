import {
  TfidfEmbedder,
  sparseNorm,
  sparseDot,
  denseNorm,
  denseDot,
  cosineFromNorms,
  type SparseVec,
} from "./embedder.js";
import { hasGemini } from "../config.js";
import { geminiEmbed, geminiEmbedBatch } from "../providers/gemini.js";

/**
 * In-memory vector store. Interface mirrors what a pgvector-backed store would
 * expose (index / search), so swapping to Postgres+pgvector later is localized.
 *
 * Two embedding modes, chosen at index time:
 *   - "dense":  Google Gemini text embeddings (semantic; used when a key is present).
 *   - "sparse": zero-dependency TF-IDF fallback (key-free, so RAG works offline).
 * A failure to build dense embeddings degrades to sparse — RAG never goes dark.
 *
 * Efficiency: every vector's L2 norm is precomputed at index time and reused, and
 * search scores by index (not by deep-copying every chunk) before slicing to k.
 */
export interface Chunk {
  id: string;
  doc_id: string;
  title: string;
  department: string;
  source_url: string;
  published_date: string; // ISO
  heading: string;
  text: string;
}

export interface Hit extends Chunk {
  score: number;
}

export class VectorStore {
  private embedder = new TfidfEmbedder();
  private chunks: Chunk[] = [];
  private mode: "dense" | "sparse" = "sparse";
  // Sparse mode
  private sparseVecs: SparseVec[] = [];
  // Dense mode
  private denseVecs: number[][] = [];
  // Precomputed per-chunk norms (parallel to the active vector array)
  private norms: number[] = [];
  private fitted = false;

  /** (Re)build the index from a full set of chunks. */
  async index(chunks: Chunk[]): Promise<void> {
    this.chunks = chunks;
    const texts = chunks.map((c) => `${c.heading} ${c.text}`);

    if (hasGemini()) {
      try {
        this.denseVecs = await geminiEmbedBatch(texts);
        this.norms = this.denseVecs.map(denseNorm);
        this.mode = "dense";
        this.fitted = true;
        console.log(`[rag] embedded ${chunks.length} chunks with Gemini (${this.denseVecs[0]?.length ?? 0}-dim)`);
        return;
      } catch (e: any) {
        console.warn(`[rag] Gemini embedding failed (${e?.message ?? e}) — falling back to lexical TF-IDF`);
      }
    }

    this.embedder.fit(texts);
    this.sparseVecs = texts.map((t) => this.embedder.transform(t));
    this.norms = this.sparseVecs.map(sparseNorm);
    this.mode = "sparse";
    this.fitted = true;
  }

  get size() {
    return this.chunks.length;
  }

  async search(query: string, k = 4, minScore = 0.02): Promise<Hit[]> {
    if (!this.fitted || this.chunks.length === 0) return [];

    // Score by index first (no per-chunk object allocation), then materialize only k.
    const scored: { i: number; score: number }[] = [];

    if (this.mode === "dense") {
      let qv: number[];
      try {
        qv = await geminiEmbed(query);
      } catch (e: any) {
        console.warn(`[rag] Gemini query embed failed (${e?.message ?? e}) — no results this query`);
        return [];
      }
      const qn = denseNorm(qv);
      for (let i = 0; i < this.chunks.length; i++) {
        scored.push({ i, score: cosineFromNorms(denseDot(qv, this.denseVecs[i]), qn, this.norms[i]) });
      }
    } else {
      const qv = this.embedder.transform(query);
      const qn = sparseNorm(qv);
      for (let i = 0; i < this.chunks.length; i++) {
        scored.push({ i, score: cosineFromNorms(sparseDot(qv, this.sparseVecs[i]), qn, this.norms[i]) });
      }
    }

    return scored
      .filter((s) => s.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => ({ ...this.chunks[s.i], score: s.score }));
  }
}

export const vectorStore = new VectorStore();
