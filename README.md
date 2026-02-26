# knowledge-mcp

A shared agent knowledge system exposed as an [MCP](https://modelcontextprotocol.io/) server. It gives AI agents (and humans) a persistent, queryable knowledge base with associative linking and cascade revalidation — when knowledge changes, dependent entries are automatically flagged for review.

Built for teams where multiple agents work across many repositories. Store conventions, architectural decisions, patterns, pitfalls, debugging notes, and process documentation in one place, and let agents query it as they work.

## Features

- **Associative knowledge graph** — Link entries with typed relationships (depends, derived, elaborates, contradicts, supersedes, related, conflicts_with). When an entry is updated, linked entries accumulate inaccuracy based on how closely they are connected.
- **Cascade revalidation** — When a knowledge entry is updated, entries that depend on it or are derived from it are automatically flagged as "needs revalidation."
- **Full-text search** — FTS5-powered keyword search across titles, content, and tags.
- **Semantic search** — Optional vector similarity search using local embeddings or OpenAI. Results are merged with keyword search via Reciprocal Rank Fusion.
- **Knowledge graph visualization** — Built-in D3.js force-directed graph UI served on `localhost:3333`.
- **Hierarchical scoping** — Entries can be scoped to company, project, or repo. Queries inherit upward (repo queries include project and company knowledge).
- **Git-based team sync** — Share knowledge across a team via a git repo. Markdown files with YAML frontmatter are the source of truth; local SQLite acts as a personal index. Conflict detection keeps both versions and lets agents resolve naturally.
- **Entry version history** — When git sync is configured, inspect the full commit history of any entry and retrieve its content at any point in time.
- **11 MCP tools** — Store, query, get, list, reinforce, deprecate, update, delete, sync knowledge, plus entry version history.

## Installation

### Prerequisites

- **Node.js** 20 or later
- **npm** (included with Node.js)
- A C++ compiler toolchain for `better-sqlite3` native compilation:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux (Debian/Ubuntu):** `sudo apt install build-essential python3`
  - **Linux (Fedora):** `sudo dnf install gcc-c++ make python3`
  - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload

### From source

```bash
git clone https://github.com/cristinecula/knowledge-mcp.git
cd knowledge-mcp
npm install
npm run build
```

Verify the installation:

```bash
node build/index.js --help
```

### As a CLI tool

To make the `knowledge-mcp` command available globally:

```bash
npm link
knowledge-mcp --help
```

### Quick start

1. Add to your MCP client config (see [Configuration](#configuration) for full details).

   **Recommended** — with git sync for team sharing and persistent history:

   ```json
   {
     "knowledge": {
       "type": "local",
       "command": [
         "node", "/path/to/knowledge-mcp/build/index.js",
         "--sync-repo", "/path/to/shared-knowledge-repo"
       ],
       "enabled": true
     }
   }
   ```

   The sync repo can be any git repository (empty or existing). If it has a configured remote, the system will automatically push and pull changes.

   **Simpler alternative** — local-only, no sync:

   ```json
   {
     "knowledge": {
       "type": "local",
       "command": ["node", "/path/to/knowledge-mcp/build/index.js"],
       "enabled": true
     }
   }
   ```

2. The SQLite database is automatically created at `~/.knowledge-mcp/knowledge.db` on first run.
3. Open `http://localhost:3333` to see the knowledge graph visualization.

### Agent instructions

The server ships with built-in agent instructions that are sent to MCP clients
during the initialization handshake. Compatible clients (Claude Code, OpenCode,
etc.) automatically inject these into the agent's system prompt, telling it to
query, store, and maintain knowledge during sessions. No manual setup is needed.

However, the built-in instructions describe *how* to use the tools — agents
also benefit from a top-level nudge that tells them *when* to use them. We
recommend adding the following to your global rules file
(`~/.config/opencode/AGENTS.md` for OpenCode, `~/.claude/CLAUDE.md` for Claude
Code):

~~~markdown
## Knowledge Base

A persistent knowledge base is available via the `knowledge_*` MCP tools. Use it for non-trivial tasks (multi-step work, debugging, feature implementation -- not quick one-off questions).

### Session Start
- Query the knowledge base for entries relevant to the current project or task before diving into work. This avoids re-discovering things learned in previous sessions.

### During Work
- Store non-obvious discoveries: architectural decisions, conventions, debugging insights, gotchas, and patterns that would save time if known in a future session.
- Link new entries to related existing knowledge.
- Reinforce entries you verify are still accurate.
- Deprecate or update entries that are outdated.

### After Completing Tasks
- If the task involved significant findings or decisions worth remembering, store them before finishing.
~~~

If you want to add project-specific guidance on top, you can create an
`AGENTS.md` (OpenCode) or `CLAUDE.md` (Claude Code) in your project root.

## Configuration

### MCP Client Setup

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`, OpenCode `opencode.json`, etc.):

```json
{
  "knowledge": {
    "type": "local",
    "command": [
      "node",
      "/path/to/knowledge-mcp/build/index.js"
    ],
    "enabled": true
  }
}
```

With git sync enabled:

```json
{
  "knowledge": {
    "type": "local",
    "command": [
      "node",
      "/path/to/knowledge-mcp/build/index.js",
      "--sync-repo",
      "/path/to/shared-knowledge-repo"
    ],
    "enabled": true
  }
}
```

With semantic search enabled (local embeddings):

```json
{
  "knowledge": {
    "type": "local",
    "command": [
      "node",
      "/path/to/knowledge-mcp/build/index.js",
      "--embedding-provider",
      "local"
    ],
    "enabled": true
  }
}
```

### CLI Options

| Option | Description | Default |
|---|---|---|
| `--db-path <path>` | Path to SQLite database | `~/.knowledge-mcp/knowledge.db` |
| `--graph-port <port>` | Port for knowledge graph visualization | `3333` |
| `--no-graph` | Disable the graph visualization server | — |
| `--embedding-provider <type>` | Embedding provider: `none`, `local`, or `openai` | `none` |
| `--openai-api-key <key>` | API key for OpenAI embeddings (or set `OPENAI_API_KEY` env var) | — |
| `--embedding-model <model>` | Override the default embedding model | Provider default |
| `--sync-repo <path>` | Path to a single git repo for team knowledge sync | — |
| `--sync-config <path>` | Path to a JSON config file for multi-repo sync | — |
| `--sync-interval <seconds>` | Automatic sync interval in seconds (0 to disable) | `300` |
| `--backfill-embeddings` | Generate embeddings for all existing entries on startup | — |
| `--help` | Show help message | — |

### Multi-Repo Configuration

To sync across multiple repositories (e.g., separate repos for company-wide vs. project-specific knowledge), use `--sync-config` with a JSON file:

```json
{
  "repos": [
    {
      "name": "company-knowledge",
      "path": "/path/to/company-repo",
      "scope": "company",
      "remote": "git@github.com:org/company-knowledge.git"
    },
    {
      "name": "project-alpha",
      "path": "/path/to/project-alpha-repo",
      "project": "alpha",
      "remote": "git@github.com:org/project-alpha-knowledge.git"
    },
    {
      "name": "personal",
      "path": "/path/to/personal-repo"
    }
  ]
}
```

The system routes entries to the first matching repo based on `scope` and `project`. If `remote` is provided, the system will automatically clone the repo if it doesn't exist locally.

### Embedding Providers

| Provider | Model | Dimensions | Notes |
|---|---|---|---|
| `none` | — | — | No semantic search, keyword search only |
| `local` | `all-MiniLM-L6-v2` | 384 | Runs locally via `@xenova/transformers`. ~30MB model download on first use. |
| `openai` | `text-embedding-3-small` | 1536 | Requires API key. |

## Tools

### `store_knowledge`
Store a new piece of knowledge. Supports optional links to existing entries and automatic embedding generation.

### `query_knowledge`
Search the knowledge base using free-text queries. Combines FTS5 keyword search with optional vector similarity search (Reciprocal Rank Fusion). Automatically reinforces accessed entries.

### `list_knowledge`
Browse and filter entries without a search query. Filter by type, project, scope, or status. Does not auto-reinforce.

### `get_knowledge`
Retrieve the full content of a knowledge entry by ID. Supports short ID prefixes (minimum 4 characters) — if the prefix uniquely identifies an entry, it resolves automatically. If ambiguous, returns candidate matches to help disambiguate.

### `reinforce_knowledge`
Explicitly revalidate an entry, resetting its inaccuracy score to 0. Use this when you verify an entry is still accurate.

### `deprecate_knowledge`
Mark an entry as deprecated. Deprecated entries are excluded from default query results. The entry is not deleted.

### `delete_knowledge`
Permanently delete an entry and all its associated links and embeddings. Irreversible. Use for entries created by mistake.

### `update_knowledge`
Update an entry's content, title, tags, type, project, or scope. Automatically triggers cascade revalidation on dependent entries and re-generates embeddings.

### `sync_knowledge`
Manually trigger a sync with the git repo. Supports `pull` (import remote changes), `push` (export local changes), or `both`. Only available when `--sync-repo` is configured.

### `get_entry_history`
Retrieve the git commit history for a knowledge entry. Returns a list of commits (newest first) showing when the entry was created, modified, and by whom. Requires git sync to be configured.

### `get_entry_at_version`
Retrieve the full content of a knowledge entry at a specific git commit. Use after `get_entry_history` to inspect what an entry looked like at a particular point in time. Requires git sync to be configured.

## Git Sync

The sync layer enables team knowledge sharing via a shared git repository. Each team member runs their own local instance with `--sync-repo` pointing to a shared repo.

### How it works

- **Source of truth:** Markdown files in the git repo (`entries/{type}/{slug}_{id8}.md`) with YAML frontmatter containing metadata and links. No separate links directory — links are embedded in each entry's frontmatter.
- **Local DB:** SQLite acts as a personal index/cache. Local-only fields (access count, last accessed) stay local — each person's usage is personal.
- **Write-through:** Every local write (store, update, delete, link, deprecate) is immediately written to the repo as Markdown files and committed locally. Rapid writes are batched into a single commit (150ms debounce). Push to remote happens automatically on the sync interval (default 5 minutes) or on demand via the `sync_knowledge` tool.
- **Pull on startup:** When the server starts, it pulls all changes from the configured repos into the local DB.
- **Manual sync:** Use the `sync_knowledge` tool to pull/push mid-session (e.g. to immediately share a just-stored entry).
- **Auto-clone:** If a repo path is missing but has a `remote` URL, the system automatically clones it on startup.
- **Git operations:** The sync layer handles `git add/commit/push/pull` automatically.

### Conflict resolution

When both local and remote have changed since last sync:

1. The remote version wins as canonical and overwrites the local entry
2. The local version is saved as a new `[Sync Conflict]` entry
3. A `conflicts_with` link is created from the conflict copy to the canonical entry
4. The conflict copy is flagged with high inaccuracy so agents know to resolve it
5. The agent resolves naturally by reviewing both versions and keeping the correct one

### Repo structure

```
shared-knowledge-repo/
  entries/
    convention/
      {slug}_{id8}.md
    decision/
      {slug}_{id8}.md
    pattern/
      {slug}_{id8}.md
    ...
```

### Setup

```bash
# Start the server with a sync repo
node build/index.js --sync-repo /path/to/shared-knowledge

# OR with a multi-repo config
node build/index.js --sync-config config.json
```

## Architecture

### Inaccuracy Model

When a knowledge entry is updated, linked entries accumulate inaccuracy based on the change magnitude and link type weights. Entries whose inaccuracy exceeds a configurable threshold are flagged as "needs revalidation." Reinforcing an entry resets its inaccuracy to 0.

**Inaccuracy link type weights:** derived (1.0), contradicts (0.7), depends (0.6), elaborates (0.4), supersedes (0.3), related (0.1), conflicts_with (0).

**Status transitions:**
- `active` — default status
- `needs_revalidation` — virtual status for entries with inaccuracy above threshold
- `deprecated` — manually deprecated, excluded from default query results

### Data Model

- **knowledge** — Main entries table with FTS5 full-text search index
- **knowledge_links** — Typed associations between entries (unique constraint on source + target + type)
- **knowledge_embeddings** — Vector embeddings for semantic search

All tables use UUID primary keys and ISO 8601 timestamps. Conflict detection uses `version` and `synced_version` columns — each content-changing operation increments `version`, and `synced_version` tracks the last version reconciled with the remote. If both local and remote have advanced beyond `synced_version`, it's a true conflict. The `synced_at` column records when an entry was last synced with the repo.

### Scoping

Entries are scoped hierarchically:
- **company** — Visible to all queries
- **project** — Visible to project and repo queries
- **repo** — Visible only to repo queries

Queries at a given scope automatically inherit entries from broader scopes.

## Knowledge Graph Visualization

When the server is running, open `http://localhost:3333` to view the knowledge graph. The D3.js force-directed graph shows:

- **Nodes** — Color-coded by knowledge type, sized by access count
- **Edges** — Typed and labeled link relationships
- **Sidebar** — Click a node to inspect its details, including rendered markdown content and collapsible version history (when git sync is configured)
- **Filters** — Filter by type, scope, status, or project (dynamic dropdown populated from your entries)

## Development

```bash
# Build
npm run build

# Watch mode (TypeScript compilation)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
src/
  index.ts              # Entry point, CLI args, tool registration
  instructions.ts       # Built-in agent instructions for MCP clients
  types.ts              # Types, enums, constants, conversion helpers
  db/
    connection.ts       # SQLite connection (WAL mode, auto-create)
    schema.ts           # DDL: tables, indexes, FTS5, triggers
    queries.ts          # All CRUD, search, link, embedding queries
  tools/
    store.ts            # store_knowledge
    query.ts            # query_knowledge
    get.ts              # get_knowledge
    list.ts             # list_knowledge
    reinforce.ts        # reinforce_knowledge
    deprecate.ts        # deprecate_knowledge
    delete.ts           # delete_knowledge
    update.ts           # update_knowledge
    sync.ts             # sync_knowledge
    history.ts          # get_entry_history, get_entry_at_version
  sync/
    config.ts           # Sync repo path management
    serialize.ts        # Entry/link JSON serialization
    fs.ts               # Repo file I/O (read, write, delete, list)
    git.ts              # Git operations (add, commit, push, pull, log, show)
    routing.ts          # Entry-to-repo routing based on scope/project
    history.ts          # Entry version history resolution (DB → routing → git)
    merge.ts            # Conflict detection (no_change, remote_wins, local_wins, conflict)
    pull.ts             # Import remote changes, handle conflicts
    push.ts             # Export local entries/links to repo
    write-through.ts    # Immediate sync on local writes
    commit-scheduler.ts # Batched commit scheduling
  embeddings/
    provider.ts         # Embedding provider interface + factory
    local.ts            # Local provider (@xenova/transformers)
    openai.ts           # OpenAI provider
    similarity.ts       # Cosine similarity, vector search, RRF, backfill
  graph/
    server.ts           # Graph visualization HTTP server
    handler.ts          # API routes + static file serving
    static/             # D3.js graph UI (HTML, JS, CSS)
  __tests__/
    db.test.ts          # Database layer tests
    tools.test.ts       # Tool integration tests
    similarity.test.ts  # Similarity/RRF math tests
    inaccuracy.test.ts  # Inaccuracy propagation tests
    sync.test.ts        # Sync layer tests
    e2e-sync.test.ts    # End-to-end sync tests with real git repos
    e2e-helpers.ts      # E2E test infrastructure
    history.test.ts     # Entry version history tests
    commit-scheduler.test.ts # Commit scheduler tests
    handler.test.ts     # Graph API handler tests
```

## License

MIT
