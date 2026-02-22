import type { EmbeddingProvider } from './provider.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI embedding provider using the embeddings API.
 * Requires an API key. Uses text-embedding-3-small by default.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
    // text-embedding-3-small = 1536, text-embedding-3-large = 3072, ada-002 = 1536
    this.dimensions =
      this.model === 'text-embedding-3-large' ? 3072 : DIMENSIONS;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.callApi([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // OpenAI supports batch embedding natively (up to 2048 inputs)
    // Process in chunks of 100 to be safe
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100);
      const chunkResults = await this.callApi(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  private async callApi(inputs: string[]): Promise<Float32Array[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI API error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    // Sort by index to maintain input order
    const sorted = data.data.sort((a, b) => a.index - b.index);

    return sorted.map((item) => new Float32Array(item.embedding));
  }
}
