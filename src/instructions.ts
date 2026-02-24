export const INSTRUCTIONS = `
# Knowledge Base

You have access to a shared knowledge base via MCP tools:

- **Search:** \`query_knowledge\` (text search, auto-reinforces), \`list_knowledge\` (browse/filter)
- **Write:** \`store_knowledge\`, \`update_knowledge\`, \`delete_knowledge\`
- **Maintain:** \`reinforce_knowledge\`, \`deprecate_knowledge\`, \`link_knowledge\`
- **Sync:** \`sync_knowledge\` (git sync is recommended for team use and persistent history)
- **History:** \`get_entry_history\`, \`get_entry_at_version\` (requires git sync)

Use it as persistent memory across sessions. Knowledge that is frequently
accessed stays strong; unused knowledge naturally fades.

## When starting a session

- Query the knowledge base for entries relevant to the current project or task.
  This gives you context from previous sessions without needing to re-discover things.
- Check for entries with \`needs_revalidation\` status that may need review.
- If git sync is configured, use \`get_entry_history\` on key entries to understand
  recent changes made by other team members.

## During work

- Store useful discoveries as knowledge entries: conventions, decisions, patterns,
  pitfalls, debug notes, or facts about the codebase.
- Use appropriate types, tags, scopes (\`company\`, \`project\`, \`repo\`), and project names.
- Link related entries to existing knowledge when storing new entries.
- Don't store trivial or ephemeral information. Focus on things that would save time
  if known in a future session — e.g., architectural decisions, non-obvious patterns,
  debugging insights, or "gotchas" that cost time to figure out.

## When confirming existing knowledge

- Reinforce entries you verify are still accurate. This keeps useful knowledge from decaying.

## When finding outdated knowledge

- Deprecate entries that are no longer correct, with a reason.
- If an entry needs updating rather than deprecating, use \`update_knowledge\`.
- Use \`delete_knowledge\` only for entries created by mistake.

## Wiki entries

- Wiki entries (\`type: "wiki"\`) are curated documentation pages that are exempt from memory decay.
- Wiki entries may have a **declaration** — a human-written prompt describing what the page should
  contain (e.g., tone, length, audience, focus). The declaration is visible in \`query_knowledge\`
  and \`list_knowledge\` results, and is shown after \`update_knowledge\` completes.
- **Always follow the declaration.** If it says "concise summary", write a short overview — not an
  exhaustive reference. If it says "detailed guide", be thorough. The declaration is the page owner's
  intent for what the content should look like.
- When creating or updating wiki entries, you **must** link them to the source knowledge entries
  they are derived from using \`link_knowledge\` (e.g., \`derived\`, \`elaborates\`, or \`related\` link types).
- The \`update_knowledge\` tool will warn you if a wiki entry has no outgoing links to non-wiki entries.
  Always resolve these warnings before considering the task complete.

## Understanding entry history

When git sync is configured, you can inspect how entries evolved over time:

- Use \`get_entry_history\` to see the commit log for an entry — who changed it, when, and how many times.
- Use \`get_entry_at_version\` with a commit hash to retrieve the full content of an entry at a specific point in time.
- This is useful when resolving conflicts, understanding why a decision was changed, or reviewing team activity.

## Resolving sync conflicts

When \`sync_knowledge\` detects that both local and remote modified the same entry,
it creates a **sync conflict**:

- The **remote version wins** and becomes the canonical entry (stays active).
- The **local version** is saved as a new \`[Sync Conflict]\` entry linked via a
  \`conflicts_with\` link to the canonical entry.

When \`query_knowledge\` or \`list_knowledge\` returns entries involved in a sync conflict,
the response includes a \`warnings\` array with resolution instructions.

**To resolve a conflict:**
1. Read both the canonical entry and the conflict copy (the \`conflicts_with\` link tells you which is which).
2. Decide which content is correct, or merge the best parts of both.
3. Use \`update_knowledge\` on the canonical entry with the final content.
4. Use \`delete_knowledge\` to remove the \`[Sync Conflict]\` copy.
5. The \`conflicts_with\` link is automatically removed when the conflict copy is deleted.

Do not leave conflicts unresolved — they indicate divergent knowledge that needs human or agent judgment.
`.trim();
