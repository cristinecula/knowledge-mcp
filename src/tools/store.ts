import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES, LINK_TYPES } from '../types.js';
import { insertKnowledge, insertLink, getKnowledgeById, updateStatus } from '../db/queries.js';
import { embedAndStore } from '../embeddings/similarity.js';

export function registerStoreTool(server: McpServer): void {
  server.registerTool(
    'store_knowledge',
    {
      description:
        'Store a new piece of knowledge in the shared knowledge base. ' +
        'Knowledge can be conventions, decisions, patterns, pitfalls, facts, debug notes, or process documentation. ' +
        'Entries start with full strength (1.0) and will naturally decay over time unless accessed. ' +
        'Optionally link this entry to existing entries. ' +
        'If a "supersedes" link is included, the target entry is automatically flagged as "needs_revalidation".',
      inputSchema: {
        title: z.string().describe('Short summary of the knowledge (1-2 sentences)'),
        content: z.string().describe('Full content in markdown format'),
        type: z.enum(KNOWLEDGE_TYPES).describe(
          'Type of knowledge: convention (coding standards), decision (architectural choices), ' +
          'pattern (reusable approaches), pitfall (things to avoid), fact (codebase facts), ' +
          'debug_note (debugging insights), process (workflow documentation)',
        ),
        tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["react", "auth", "api"])'),
        project: z.string().optional().describe('Project this knowledge belongs to (omit for company-wide)'),
        scope: z.enum(SCOPES).optional().describe('Scope level: company (default), project, or repo'),
        source: z.string().optional().describe('Who or what created this (e.g., agent name, human name)'),
        links: z
          .array(
            z.object({
              target_id: z.string().describe('ID of the knowledge entry to link to'),
              link_type: z.enum(LINK_TYPES).describe(
                'Type of link: related, derived (deduced from target), depends (requires target to be true), ' +
                'contradicts, supersedes (replaces target), elaborates (adds detail to target)',
              ),
              description: z.string().optional().describe('Why these entries are linked'),
            }),
          )
          .optional()
          .describe('Optional links to existing knowledge entries'),
      },
    },
    async ({ title, content, type, tags, project, scope, source, links }) => {
      try {
        const entry = insertKnowledge({
          type,
          title,
          content,
          tags,
          project,
          scope,
          source,
        });

        // Create any initial links
        const createdLinks = [];
        if (links && links.length > 0) {
          for (const link of links) {
            // Verify target exists
            const target = getKnowledgeById(link.target_id);
            if (!target) {
              createdLinks.push({
                target_id: link.target_id,
                error: 'Target entry not found',
              });
              continue;
            }

            const createdLink = insertLink({
              sourceId: entry.id,
              targetId: link.target_id,
              linkType: link.link_type,
              description: link.description,
              source: source ?? 'unknown',
            });

            // Flag target for revalidation when superseded
            let targetRevalidated = false;
            if (link.link_type === 'supersedes') {
              if (
                target.status !== 'deprecated' &&
                target.status !== 'dormant'
              ) {
                updateStatus(link.target_id, 'needs_revalidation');
                targetRevalidated = true;
              }
            }

            createdLinks.push({
              link_id: createdLink.id,
              target_id: link.target_id,
              link_type: link.link_type,
              ...(targetRevalidated && { target_revalidated: true }),
            });
          }
        }

        // Generate and store embedding (if provider configured)
        try {
          await embedAndStore(entry.id, entry.title, entry.content, entry.tags);
        } catch (embedError) {
          console.error('Warning: failed to generate embedding:', embedError);
        }

        const result: Record<string, unknown> = {
          id: entry.id,
          title: entry.title,
          type: entry.type,
          strength: entry.strength,
          status: entry.status,
        };

        if (createdLinks.length > 0) {
          result.links = createdLinks;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error storing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
