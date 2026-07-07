/**
 * Zero-dependency lexical embedder (TF-IDF over a fitted vocabulary), so RAG
 * retrieval runs with NO API key and NO network. This is deliberately swappable:
 * the Embedder interface is all the store/query agent depend on, so you can drop
 * in a real sentence-embedding model + pgvector later without touching callers.
 */

const STOP = new Set(
  "the a an and or of to in for on is are was were be been being with as at by from this that these those it its i you he she we they my your our their what which how when where who whom will shall can could would should do does did have has had not no yes hai ka ki ke ko me mera meri kya".split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 2 && !STOP.has(t));
}

export type SparseVec = Map<string, number>;

export interface Embedder {
  transform(text: string): SparseVec;
}

export class TfidfEmbedder implements Embedder {
  private idf = new Map<string, number>();

  /** Fit IDF weights over the full set of documents (chunks). */
  fit(docs: string[]): this {
    const df = new Map<string, number>();
    for (const d of docs) {
      const seen = new Set(tokenize(d));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = docs.length || 1;
    for (const [t, n] of df) this.idf.set(t, Math.log((N + 1) / (n + 1)) + 1);
    return this;
  }

  transform(text: string): SparseVec {
    const tf = new Map<string, number>();
    const toks = tokenize(text);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const vec: SparseVec = new Map();
    for (const [t, f] of tf) {
      const idf = this.idf.get(t);
      if (idf === undefined) continue; // out-of-vocabulary term
      vec.set(t, (f / toks.length) * idf);
    }
    return vec;
  }
}

/** L2 norm of a sparse vector. Precompute once at index time, not per query. */
export function sparseNorm(v: SparseVec): number {
  let n = 0;
  for (const w of v.values()) n += w * w;
  return Math.sqrt(n);
}

/** Dot product of two sparse vectors (iterate the smaller map). */
export function sparseDot(a: SparseVec, b: SparseVec): number {
  let dot = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const w2 = big.get(t);
    if (w2 !== undefined) dot += w * w2;
  }
  return dot;
}

/** Cosine similarity from a dot product and two precomputed norms. */
export function cosineFromNorms(dot: number, na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

export function cosine(a: SparseVec, b: SparseVec): number {
  return cosineFromNorms(sparseDot(a, b), sparseNorm(a), sparseNorm(b));
}

/** Dense-vector helpers (Gemini embeddings path). */
export function denseNorm(v: number[]): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}
export function denseDot(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}
