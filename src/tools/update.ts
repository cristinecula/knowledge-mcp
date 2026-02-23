import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateKnowledgeFields, getKnowledgeById, getIncomingLinks, updateStatus } from '../db/queries.js';
import { syncWriteEntry, touchedRepos, gitCommitAll, clearTouchedRepos } from '../sync/index.js';
import { KNOWLEDGE_TYPES, SCOPES, REVALIDATION_LINK_TYPES } from '../types.js';
import { embedAndStore } from '../embeddings/similarity.js';

export function registerUpdateTool(server: McpServer): void {
  server.registerTool(
    'update_knowledge',
    {
      description:
        'Update an existing knowledge entry\'s content, title, tags, or type. ' +
        'When an entry is updated, entries that are linked to it via "derived" or "depends" ' +
        'links are automatically flagged as "needs_revalidation" — they may need to be ' +
        'reviewed to ensure they\'re still accurate given the change.',
      inputSchema: {
        id: z.string().uuid().describe('ID of the knowledge entry to update'),
        title: z.string().optional().describe('Updated title'),
        content: z.string().optional().describe('Updated content (markdown)'),
        tags: z.array(z.string()).optional().describe('Updated tags (replaces existing tags)'),
        type: z
          .enum(KNOWLEDGE_TYPES)
          .optional()
          .describe(
            'Updated knowledge type: convention, decision, pattern, pitfall, fact, debug_note, process',
          ),
        project: z.string().optional().describe('Updated project scope'),
        scope: z
          .enum(SCOPES)
          .optional()
          .describe('Updated scope level: company, project, repo'),
      },
    },
    async ({ id, title, content, tags, type, project, scope }) => {
      try {
        const oldEntry = getKnowledgeById(id);
        const updated = updateKnowledgeFields(id, {
          title,
          content,
          tags,
          type,
          project,
          scope,
        });

        if (updated) {
          // Clear needs_revalidation — updating the entry IS the revalidation
          if (oldEntry && oldEntry.status === 'needs_revalidation') {
            updateStatus(id, 'active');
          }

          syncWriteEntry(updated, oldEntry?.type, oldEntry?.scope, oldEntry?.project);
          
          for (const repoPath of touchedRepos) {
            gitCommitAll(repoPath, `knowledge: update ${updated.type} "${updated.title}"`);
          }
          clearTouchedRepos();

          // Regenerate embedding if content-affecting fields changed (non-fatal)
          if (title !== undefined || content !== undefined || tags !== undefined) {
            try {
              await embedAndStore(updated.id, updated.title, updated.content, updated.tags);
            } catch {
              // Embedding generation can fail (e.g., no provider configured)
            }
          }

          // Cascade revalidation: flag entries linked via 'derived' or 'depends'
          const revalidated: string[] = [];
          const incomingLinks = getIncomingLinks(id, REVALIDATION_LINK_TYPES);
          for (const link of incomingLinks) {
            const linkedEntry = getKnowledgeById(link.source_id);
            if (linkedEntry && linkedEntry.status !== 'deprecated' && linkedEntry.status !== 'dormant') {
              updateStatus(link.source_id, 'needs_revalidation');
              revalidated.push(link.source_id);
            }
          }

          let responseText = `Updated knowledge entry: ${updated.title} (ID: ${id})`;
          if (revalidated.length > 0) {
            responseText += `\n\nCascade revalidation: flagged ${revalidated.length} linked entries as needs_revalidation:\n${revalidated.map((rid) => `  - ${rid}`).join('\n')}`;
          }

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Entry not found: ${id}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to update entry: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
