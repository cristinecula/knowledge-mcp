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

## Understanding entry history

When git sync is configured, you can inspect how entries evolved over time:

- Use \`get_entry_history\` to see the commit log for an entry — who changed it, when, and how many times.
- Use \`get_entry_at_version\` with a commit hash to retrieve the full content of an entry at a specific point in time.
- This is useful when resolving conflicts, understanding why a decision was changed, or reviewing team activity.
`.trim();
