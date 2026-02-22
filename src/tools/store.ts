import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { insertKnowledge, insertLink } from '../db/queries.js';
import { syncWriteEntry, syncWriteLink, touchedRepos, gitCommitAll, clearTouchedRepos } from '../sync/index.js';
import { KNOWLEDGE_TYPES, LINK_TYPES, SCOPES } from '../types.js';

export function registerStoreTool(server: McpServer): void {
  server.registerTool(
    'store_knowledge',
    {
      description:
        'Store a new piece of knowledge in the shared knowledge base. Knowledge can be ' +
        'conventions, decisions, patterns, pitfalls, facts, debug notes, or process ' +
        'documentation. Entries start with full strength (1.0) and will naturally decay ' +
        'over time unless accessed. Optionally link this entry to existing entries.',
      inputSchema: {
        title: z.string().describe('Short summary of the knowledge (1-2 sentences)'),
        content: z.string().describe('Full content in markdown format'),
        type: z
          .enum(KNOWLEDGE_TYPES)
          .describe(
            'Type of knowledge: convention (coding standards), decision (architectural choices), pattern (reusable approaches), pitfall (things to avoid), fact (codebase facts), debug_note (debugging insights), process (workflow documentation)',
          ),
        tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["react", "auth", "api"])'),
        scope: z
          .enum(SCOPES)
          .optional()
          .describe('Scope level: company (default), project, or repo'),
        project: z.string().optional().describe('Project this knowledge belongs to (omit for company-wide)'),
        source: z.string().optional().describe('Who or what created this (e.g., agent name, human name)'),
        links: z
          .array(
            z.object({
              target_id: z.string().uuid(),
              link_type: z.enum(LINK_TYPES),
              description: z.string().optional(),
            }),
          )
          .optional()
          .describe('Optional links to existing knowledge entries'),
      },
    },
    async ({ title, content, type, tags, scope, project, source, links }) => {
      try {
        const entry = insertKnowledge({
          title,
          content,
          type,
          tags: tags || [],
          scope: scope || 'company',
          project: project || null,
          source: source || 'agent',
        });
        syncWriteEntry(entry);

        if (links && links.length > 0) {
          for (const link of links) {
            const newLink = insertLink({
              sourceId: entry.id,
              targetId: link.target_id,
              linkType: link.link_type,
              description: link.description,
              source: source || 'agent',
            });
            syncWriteLink(newLink, entry);
          }
        }

        // Commit all changes
        for (const repoPath of touchedRepos) {
          gitCommitAll(repoPath, `knowledge: store ${entry.type} "${entry.title}"` + (links ? ` with ${links.length} links` : ''));
        }
        clearTouchedRepos();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entry, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to store knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
