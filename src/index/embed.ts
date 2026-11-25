/**
 * Pluggable local embedding engine.
 * Default: @huggingface/transformers with Xenova/bge-small-en-v1.5 (quantized q8, 384 dims, L2-normalized).
 * Set BRAIN_EMBED=off to disable embeddings and run FTS5 + graph mode only.
 */

export const DEFAULT_EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], mode: "document" | "query"): Promise<Float32Array[]>;
}

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let cachedPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let cachedModelName: string | null = null;

function isEmbeddingsDisabled(): boolean {
  const raw = process.env.BRAIN_EMBED?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "none";
}

function normalizeL2(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm <= 1e-12) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i]! / norm;
  }
  return out;
}

async function loadTransformersPipeline(
  model: string,
): Promise<FeatureExtractionPipeline> {
  if (cachedPipelinePromise && cachedModelName === model) {
    return cachedPipelinePromise;
  }
  cachedModelName = model;
  cachedPipelinePromise = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // Keep cache deterministic and avoid noisy stdout (MCP uses stdout for JSON-RPC)
    env.allowLocalModels = true;
    const extractor = await pipeline("feature-extraction", model, {
      dtype: "q8",
    });
    return extractor as unknown as FeatureExtractionPipeline;
  })();

  try {
    return await cachedPipelinePromise;
  } catch (err) {
    cachedPipelinePromise = null;
    cachedModelName = null;
    throw err;
  }
}

export function createLocalEmbedder(
  model = process.env.BRAIN_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
): Embedder {
  const isBge = /bge-/i.test(model);
  return {
    model,
    dims: 384,
    async embed(
      texts: string[],
      mode: "document" | "query",
    ): Promise<Float32Array[]> {
      if (!texts.length) return [];
      const extractor = await loadTransformersPipeline(model);
      const prepared = texts.map((t) => {
        const cleaned = t.replace(/\s+/g, " ").trim().slice(0, 2000);
        return mode === "query" && isBge
          ? `${BGE_QUERY_PREFIX}${cleaned}`
          : cleaned;
      });

      const batchSize = 32;
      const out: Float32Array[] = [];
      for (let i = 0; i < prepared.length; i += batchSize) {
        const batch = prepared.slice(i, i + batchSize);
        const tensor = await extractor(batch, {
          pooling: isBge ? "cls" : "mean",
          normalize: true,
        });
        const dims = tensor.dims[tensor.dims.length - 1]!;
        for (let b = 0; b < batch.length; b++) {
          const slice = tensor.data.slice(b * dims, (b + 1) * dims);
          out.push(normalizeL2(new Float32Array(slice)));
        }
      }
      return out;
    },
  };
}

/** Resolve default embedder unless disabled via BRAIN_EMBED=off. */
export function resolveDefaultEmbedder(): Embedder | null {
  if (isEmbeddingsDisabled()) return null;
  return createLocalEmbedder();
}

export function encodeEmbedding(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeEmbedding(blob: Uint8Array | ArrayBuffer): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Copy into aligned buffer if byteOffset is not 4-byte aligned
  if (u8.byteOffset % 4 === 0) {
    return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  }
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

/** Cosine similarity for L2-normalized vectors (= dot product). */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
