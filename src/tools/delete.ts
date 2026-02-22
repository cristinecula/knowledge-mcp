import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteKnowledge } from '../db/queries.js';
import { syncDeleteEntry, syncDeleteLink, touchedRepos, gitCommitAll, clearTouchedRepos } from '../sync/index.js';
import { getKnowledgeById } from '../db/queries.js';
import type { KnowledgeType } from '../types.js';

export function registerDeleteTool(server: McpServer): void {
  server.registerTool(
    'delete_knowledge',
    {
      description:
        'Permanently delete a knowledge entry and all its associated links and embeddings. ' +
        'This action is irreversible. Use this only for entries created by mistake or ' +
        'that should no longer exist. For outdated knowledge, use deprecate_knowledge instead.',
      inputSchema: {
        id: z.string().uuid().describe('The UUID of the entry to delete'),
      },
    },
    async ({ id }) => {
      try {
        const entry = getKnowledgeById(id);
        const deleted = deleteKnowledge(id);
        
        if (deleted) {
          syncDeleteEntry(id, entry?.type as KnowledgeType);
          
          for (const repoPath of touchedRepos) {
            gitCommitAll(repoPath, `knowledge: delete ${entry?.type || 'entry'} "${entry?.title || id}"`);
          }
          clearTouchedRepos();

          return {
            content: [{ type: 'text', text: `Deleted knowledge entry: ${id}` }],
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
              text: `Failed to delete entry: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
