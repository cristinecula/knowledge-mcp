/** Type declarations for @xenova/transformers (optional dependency) */
declare module '@xenova/transformers' {
  export function pipeline(
    task: string,
    model: string,
  ): Promise<(text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>>;
}
