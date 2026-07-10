import { averageNormalizedEmbeddings, chunkEmbeddingText } from './lib.ts';

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

export function createGteSmallAdapter(session: SupabaseAiSession): EmbeddingAdapter {
  return {
    profile: GTE_SMALL_PROFILE,
    async embed(text: string) {
      const chunks = chunkEmbeddingText(text);
      if (chunks.length === 0) throw new Error('embedding_empty');
      const embeddings = await Promise.all(
        chunks.map((chunk) => session.run(chunk, { mean_pool: true, normalize: true })),
      );
      return embeddings.length === 1 ? embeddings[0] : averageNormalizedEmbeddings(embeddings);
    },
  };
}
