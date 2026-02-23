import type { EmbeddingProvider } from './provider.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

/**
 * Local embedding provider using @xenova/transformers.
 * Downloads and caches the model on first use (~30MB).
 * Runs entirely locally — no API key or network needed after first download.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model: string;
  readonly dimensions = DIMENSIONS;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic import from @xenova/transformers, type not available statically
  private pipeline: any = null;

  constructor(model?: string) {
    this.model = model ?? DEFAULT_MODEL;
  }

  async initialize(): Promise<void> {
    console.error(`Loading local embedding model: ${this.model}...`);
    try {
      // Dynamic import — only loaded when this provider is used
      const { pipeline } = await import('@xenova/transformers');
      this.pipeline = await pipeline('feature-extraction', this.model);
      console.error(`Local embedding model loaded (${DIMENSIONS} dimensions)`);
    } catch (error) {
      throw new Error(
        `Failed to load local embedding model. Make sure @xenova/transformers is installed: npm install @xenova/transformers\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      throw new Error('Local embedding provider not initialized. Call initialize() first.');
    }

    const output = await this.pipeline(text, {
      pooling: 'mean',
      normalize: true,
    });

    // output.data is a Float32Array
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Process sequentially to avoid memory issues with large batches
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
