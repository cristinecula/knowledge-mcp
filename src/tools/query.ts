import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES, INACCURACY_THRESHOLD } from '../types.js';
import { searchKnowledge, batchRecordAccess, getLinksForEntries } from '../db/queries.js';
import { getEmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearch, reciprocalRankFusion, type ScoredEntry } from '../embeddings/similarity.js';

export const CONTENT_TRUNCATE_LENGTH = 300;

export function truncateContent(content: string): string {
  if (content.length <= CONTENT_TRUNCATE_LENGTH) return content;
  // Find last space before limit to avoid cutting mid-word
  const truncated = content.slice(0, CONTENT_TRUNCATE_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutPoint = lastSpace > CONTENT_TRUNCATE_LENGTH * 0.5 ? lastSpace : CONTENT_TRUNCATE_LENGTH;
  return content.slice(0, cutPoint) + '… (truncated, use `get_knowledge` for full content)';
}

export function registerQueryTool(server: McpServer): void {
  server.registerTool(
    'query_knowledge',
    {
      description:
        'Search the shared knowledge base using free-text queries. ' +
        'Results are ranked by relevance. ' +
        'Accessing knowledge automatically records the access for analytics. ' +
        'Use this to find conventions, decisions, patterns, pitfalls, and other team knowledge. ' +
        'Content is truncated in results — use `get_knowledge` to read full entries.',
      inputSchema: {
        query: z.string().describe('Free-text search query (searches title, content, and tags)'),
        type: z.enum(KNOWLEDGE_TYPES).optional().describe('Filter by knowledge type'),
        tags: z.array(z.string()).optional().describe('Filter by tags (entries must match ALL specified tags)'),
        project: z.string().optional().describe('Filter by project name'),
        scope: z.enum(SCOPES).optional().describe(
          'Scope filter with inheritance: repo returns repo+project+company, ' +
          'project returns project+company, company returns only company-wide',
        ),
        above_threshold: z.boolean().optional().describe('Only return entries with inaccuracy above threshold (needs revalidation). Default: false'),
        limit: z.number().min(1).max(50).optional().describe('Max results to return (default: 10, max: 50)'),
      },
    },
    async ({ query, type, tags, project, scope, above_threshold, limit }) => {
      try {
        const maxResults = limit ?? 10;

        // 1. FTS5 keyword search
        const ftsEntries = searchKnowledge({
          query,
          type,
          tags,
          project,
          scope,
          aboveThreshold: above_threshold,
          limit: maxResults * 2, // fetch more for merging
        });

        // 2. Semantic vector search (if embedding provider is configured)
        let finalEntries = ftsEntries;
        const provider = getEmbeddingProvider();

        if (provider && query) {
          try {
            // Get a broad set of candidates for vector search (filtered by params)
            const candidates = searchKnowledge({
              type,
              tags,
              project,
              scope,
              aboveThreshold: above_threshold,
              limit: 200, // broad pool for vector search
            });

            const vecResults = await vectorSearch(query, candidates, maxResults * 2);

            if (vecResults.length > 0) {
              // Convert FTS results to ScoredEntry format
              const ftsScored: ScoredEntry[] = ftsEntries.map((entry, i) => ({
                entry,
                score: 1 / (i + 1), // rank-based score
              }));

              // Merge via Reciprocal Rank Fusion
              const merged = reciprocalRankFusion(ftsScored, vecResults);
              finalEntries = merged.slice(0, maxResults).map((m) => m.entry);
            }
          } catch (vecError) {
            // Fall back to FTS-only results if vector search fails
            console.error('Warning: vector search failed, using FTS only:', vecError);
          }
        }

        // Trim to limit
        finalEntries = finalEntries.slice(0, maxResults);

        if (finalEntries.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No knowledge entries found matching your query.',
              },
            ],
          };
        }

        // Auto-reinforce: bump access count for returned entries (batched in 1 transaction)
        batchRecordAccess(finalEntries.map((e) => e.id), 1);

        // Enrich with link info (batched in 1 query instead of N)
        const allLinks = getLinksForEntries(finalEntries.map((e) => e.id));
        const warnings: string[] = [];
        const results = finalEntries.map((entry) => {
          const links = allLinks.get(entry.id) ?? [];

          // Check for conflicts_with links (sync conflict indicators)
          const conflictLinks = links.filter((l) => l.link_type === 'conflicts_with');
          if (conflictLinks.length > 0) {
            for (const cl of conflictLinks) {
              const isConflictCopy = cl.source_id === entry.id;
              if (isConflictCopy) {
                warnings.push(
                  `Entry "${entry.title}" (${entry.id}) is a sync conflict copy. ` +
                  `The canonical version is ${cl.target_id}. ` +
                  `Review both versions, update the canonical entry if needed, then delete this conflict copy and its conflicts_with link.`,
                );
              } else {
                warnings.push(
                  `Entry "${entry.title}" (${entry.id}) has an unresolved sync conflict. ` +
                  `A conflict copy with local changes exists at ${cl.source_id}. ` +
                  `Review both versions, update this entry if the local changes should be kept, then delete the conflict copy and its conflicts_with link.`,
                );
              }
            }
          }

          const result: Record<string, unknown> = {
            id: entry.id,
            type: entry.type,
            title: entry.title,
            content: truncateContent(entry.content),
            tags: entry.tags,
            project: entry.project,
            scope: entry.scope,
            status: entry.status,
            access_count: entry.access_count + 1, // reflect the access we just recorded
            last_accessed_at: new Date().toISOString(),
            needs_revalidation: entry.inaccuracy >= INACCURACY_THRESHOLD,
            inaccuracy: Math.round(entry.inaccuracy * 1000) / 1000,
            link_count: links.length,
            links: links.map((l) => ({
              link_id: l.id,
              linked_entry_id: l.source_id === entry.id ? l.target_id : l.source_id,
              link_type: l.link_type,
              direction: l.source_id === entry.id ? 'outgoing' : 'incoming',
            })),
          };
          if (entry.declaration) {
            result.declaration = entry.declaration;
          }
          if (entry.deprecation_reason) {
            result.deprecation_reason = entry.deprecation_reason;
          }
          if (entry.flag_reason) {
            result.flag_reason = entry.flag_reason;
          }
          return result;
        });

        const responseEnvelope: Record<string, unknown> = {
          count: results.length,
          results,
        };
        if (warnings.length > 0) {
          responseEnvelope.warnings = warnings;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseEnvelope),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error querying knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
