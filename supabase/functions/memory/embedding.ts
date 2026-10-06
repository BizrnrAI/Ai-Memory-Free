import {
  averageNormalizedEmbeddings,
  chunkEmbeddingText,
  EMBED_CHUNK_CHARS,
  MAX_CHUNKS_PER_TEXT,
} from './lib.ts';

export type EmbeddingProfile = {
  id: string;
  model: string;
  dimensions: number;
  strategy: string;
};

export type EmbeddingAdapter = {
  profile: EmbeddingProfile;
  embed(text: string): Promise<number[]>;
};

export const GTE_SMALL_PROFILE: EmbeddingProfile = {
  id: 'gte-small-v1',
  model: 'gte-small',
  dimensions: 384,
  strategy: 'bounded-chunk-average',
};

type SupabaseAiSession = {
  run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<number[]>;
};

// `maxChunks` is how many chunks one text is averaged from. It comes from the
// per-request embedding budget (see lib.ts): the model reads at most that many
// evenly spaced 1,800-character windows of a long text, and Postgres full-text
// search still indexes every word of it.
export function createGteSmallAdapter(
  session: SupabaseAiSession,
  maxChunks = MAX_CHUNKS_PER_TEXT,
): EmbeddingAdapter {
  return {
    profile: GTE_SMALL_PROFILE,
    async embed(text: string) {
      const chunks = chunkEmbeddingText(text, EMBED_CHUNK_CHARS, maxChunks);
      if (chunks.length === 0) throw new Error('embedding_empty');
      const embeddings = await Promise.all(
        chunks.map((chunk) => session.run(chunk, { mean_pool: true, normalize: true })),
      );
      return embeddings.length === 1 ? embeddings[0] : averageNormalizedEmbeddings(embeddings);
    },
  };
}
