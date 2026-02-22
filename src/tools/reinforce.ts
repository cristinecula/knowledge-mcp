import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getKnowledgeById,
  recordAccess,
  updateStatus,
  getLinksForEntry,
  getLinkedEntries,
} from '../db/queries.js';
import { REINFORCE_ACCESS_BOOST } from '../types.js';
import { calculateNetworkStrength } from '../memory/strength.js';

export function registerReinforceTool(server: McpServer): void {
  server.registerTool(
    'reinforce_knowledge',
    {
      description:
        'Explicitly reinforce a knowledge entry, significantly boosting its memory strength. ' +
        'Use this when you confirm that a piece of knowledge is still accurate and useful. ' +
        'This also clears any "needs_revalidation" flag on the entry. ' +
        'Reinforcement gives a +3 access boost (3x stronger than a normal query access).',
      inputSchema: {
        id: z.string().describe('ID of the knowledge entry to reinforce'),
      },
    },
    async ({ id }) => {
      try {
        const entry = getKnowledgeById(id);
        if (!entry) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Knowledge entry not found: ${id}`,
              },
            ],
            isError: true,
          };
        }

        // Boost access count
        recordAccess(id, REINFORCE_ACCESS_BOOST);

        // Clear needs_revalidation status if applicable
        if (entry.status === 'needs_revalidation') {
          updateStatus(id, 'active');
        }

        // Re-fetch and calculate new strength
        const updated = getKnowledgeById(id)!;
        const links = getLinksForEntry(id);
        const linkedEntries = getLinkedEntries(id);
        const newStrength = calculateNetworkStrength(updated, links, linkedEntries);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: updated.id,
                  title: updated.title,
                  previous_strength: Math.round(entry.strength * 1000) / 1000,
                  new_strength: Math.round(newStrength * 1000) / 1000,
                  access_count: updated.access_count,
                  status: updated.status === 'needs_revalidation' ? 'active' : updated.status,
                  revalidation_cleared: entry.status === 'needs_revalidation',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reinforcing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
