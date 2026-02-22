import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSyncRepo, isSyncEnabled, pull, push } from '../sync/index.js';

export function registerSyncTool(server: McpServer): void {
  server.registerTool(
    'sync_knowledge',
    {
      description:
        'Sync knowledge with the shared team git repository. ' +
        '"pull" imports remote changes into your local knowledge base. ' +
        '"push" exports your local changes to JSON files in the git repo. ' +
        '"both" does pull then push. ' +
        'Conflicts (both sides changed) create a [Sync Conflict] entry linked via ' +
        '"contradicts" — review both versions and keep the correct one. ' +
        'Your personal memory (strength, access counts) is never affected by sync.',
      inputSchema: {
        direction: z
          .enum(['pull', 'push', 'both'])
          .optional()
          .describe('Sync direction: pull (import remote), push (export local), both (default)'),
      },
    },
    async ({ direction }) => {
      try {
        if (!isSyncEnabled()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Sync is not enabled. Start the server with --sync-repo <path> to enable git-based knowledge sharing.',
              },
            ],
            isError: true,
          };
        }

        const repoPath = getSyncRepo()!;
        const dir = direction ?? 'both';
        const result: Record<string, unknown> = { direction: dir };

        if (dir === 'pull' || dir === 'both') {
          const pullResult = await pull(repoPath);
          result.pulled = {
            new: pullResult.new_entries,
            updated: pullResult.updated,
            deleted: pullResult.deleted,
            conflicts: pullResult.conflicts,
            new_links: pullResult.new_links,
            deleted_links: pullResult.deleted_links,
          };
          if (pullResult.conflict_details.length > 0) {
            result.conflict_details = pullResult.conflict_details;
          }
        }

        if (dir === 'push' || dir === 'both') {
          const pushResult = push(repoPath);
          result.pushed = {
            new: pushResult.new_entries,
            updated: pushResult.updated,
            deleted: pushResult.deleted,
            new_links: pushResult.new_links,
            deleted_links: pushResult.deleted_links,
          };
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
              text: `Error syncing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
