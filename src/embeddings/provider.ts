/**
 * EmbeddingProvider interface — abstracts over different embedding backends.
 * Implementations must provide an embed() method that converts text to a vector.
 */
export interface EmbeddingProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Model identifier */
  readonly model: string;
  /** Vector dimensions */
  readonly dimensions: number;

  /**
   * Generate an embedding vector for the given text.
   * Returns a Float32Array of length `dimensions`.
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Generate embeddings for multiple texts in a single batch.
   * Default implementation calls embed() for each text.
   */
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingProviderType = 'none' | 'local' | 'openai';

/** Global embedding provider instance (null if disabled) */
let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider | null {
  return provider;
}

export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  provider = p;
}

/**
 * Create and initialize an embedding provider based on the type.
 */
export async function createEmbeddingProvider(
  type: EmbeddingProviderType,
  options?: { apiKey?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  if (type === 'none') return null;

  if (type === 'local') {
    const { LocalEmbeddingProvider } = await import('./local.js');
    const p = new LocalEmbeddingProvider(options?.model);
    await p.initialize();
    return p;
  }

  if (type === 'openai') {
    const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenAI embedding provider requires an API key. Set --openai-api-key or OPENAI_API_KEY env var.',
      );
    }
    const { OpenAIEmbeddingProvider } = await import('./openai.js');
    return new OpenAIEmbeddingProvider(apiKey, options?.model);
  }

  throw new Error(`Unknown embedding provider: ${type}`);
}
