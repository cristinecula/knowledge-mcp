import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateKnowledgeFields, getKnowledgeById } from '../db/queries.js';
import { syncWriteEntry, touchedRepos, gitCommitAll, clearTouchedRepos } from '../sync/index.js';
import { KNOWLEDGE_TYPES, SCOPES } from '../types.js';

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
          syncWriteEntry(updated, oldEntry?.type, oldEntry?.scope, oldEntry?.project);
          
          for (const repoPath of touchedRepos) {
            gitCommitAll(repoPath, `knowledge: update ${updated.type} "${updated.title}"`);
          }
          clearTouchedRepos();

          return {
            content: [
              {
                type: 'text',
                text: `Updated knowledge entry: ${updated.title} (ID: ${id})`,
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
