# knowledge-mcp

A shared agent knowledge system exposed as an [MCP](https://modelcontextprotocol.io/) server. It gives AI agents (and humans) a persistent, queryable knowledge base with brain-inspired memory dynamics — frequently accessed knowledge stays strong, unused knowledge fades, and well-connected knowledge reinforces itself.

Built for teams where multiple agents work across many repositories. Store conventions, architectural decisions, patterns, pitfalls, debugging notes, and process documentation in one place, and let agents query it as they work.

## Features

- **Brain-inspired memory decay** — Entries start at full strength and decay with a 14-day half-life. Accessing knowledge reinforces it. Deprecated entries decay 10x faster.
- **Associative knowledge graph** — Link entries with typed relationships (depends, derived, elaborates, contradicts, supersedes, related). Connected entries reinforce each other's strength via spreading activation.
- **Cascade revalidation** — When a knowledge entry is updated, entries that depend on it or are derived from it are automatically flagged as "needs revalidation."
- **Full-text search** — FTS5-powered keyword search across titles, content, and tags.
- **Semantic search** — Optional vector similarity search using local embeddings or OpenAI. Results are merged with keyword search via Reciprocal Rank Fusion.
- **Knowledge graph visualization** — Built-in D3.js force-directed graph UI served on `localhost:3333`.
- **Hierarchical scoping** — Entries can be scoped to company, project, or repo. Queries inherit upward (repo queries include project and company knowledge).
- **Git-based team sync** — Share knowledge across a team via a git repo. JSON files are the source of truth; local SQLite acts as a personal index. Conflict detection keeps both versions and lets agents resolve naturally.
- **9 MCP tools** — Store, query, list, reinforce, deprecate, link, update, delete, and sync knowledge.

## Installation

### Prerequisites

- **Node.js** 18 or later
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

1. Add to your MCP client config (see [Configuration](#configuration) for full details):

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

If you want to add project-specific guidance on top, you can still create an
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

### `reinforce_knowledge`
Explicitly boost an entry's memory strength (+3 access boost). Clears the "needs revalidation" flag if present.

### `deprecate_knowledge`
Mark an entry as deprecated. It decays 10x faster and fades from query results — like a fading memory. The entry is not deleted.

### `delete_knowledge`
Permanently delete an entry and all its associated links and embeddings. Irreversible. Use for entries created by mistake.

### `link_knowledge`
Create typed links between entries. Supports bidirectional linking. Link types: `related`, `derived`, `depends`, `contradicts`, `supersedes`, `elaborates`.

### `update_knowledge`
Update an entry's content, title, tags, type, project, or scope. Automatically triggers cascade revalidation on dependent entries and re-generates embeddings.

### `sync_knowledge`
Manually trigger a sync with the git repo. Supports `pull` (import remote changes), `push` (export local changes), or `both`. Only available when `--sync-repo` is configured.

## Git Sync

The sync layer enables team knowledge sharing via a shared git repository. Each team member runs their own local instance with `--sync-repo` pointing to a shared repo.

### How it works

- **Source of truth:** JSON files in the git repo (`entries/{type}/{id}.json`, `links/{id}.json`)
- **Local DB:** SQLite acts as a personal index/cache. Memory fields (strength, access count, last accessed) stay local — each person's memory is personal.
- **Write-through:** Every local write (store, update, delete, link, deprecate) is immediately written to the repo as JSON files and committed (`git commit`).
- **Pull on startup:** When the server starts, it pulls all changes from the configured repos into the local DB.
- **Manual sync:** Use the `sync_knowledge` tool to pull/push mid-session.
- **Auto-clone:** If a repo path is missing but has a `remote` URL, the system automatically clones it on startup.
- **Git operations:** The sync layer handles `git add/commit/push/pull` automatically.

### Conflict resolution

When both local and remote have changed since last sync:

1. The local entry is flagged as `needs_revalidation`
2. A new `[Sync Conflict]` entry is created containing the remote version
3. A `contradicts` link is created between the conflict entry and the original
4. Both are flagged `needs_revalidation`
5. The agent resolves naturally by reviewing both versions and keeping the correct one

### Repo structure

```
shared-knowledge-repo/
  entries/
    convention/
      {id}.json
    decision/
      {id}.json
    pattern/
      {id}.json
    ...
  links/
    {id}.json
```

### Setup

```bash
# Start the server with a sync repo
node build/index.js --sync-repo /path/to/shared-knowledge

# OR with a multi-repo config
node build/index.js --sync-config config.json
```

## Architecture

### Memory Model

Strength is calculated as:

```
baseStrength = decayFactor * accessBoost
decayFactor  = 0.5 ^ (timeSinceLastAccess / HALF_LIFE)
accessBoost  = 1 + log2(1 + accessCount)
```

Network-enhanced strength adds a bonus from linked entries via spreading activation, capped at 50% of base strength:

```
networkBonus = sum(linkedBaseStrength * linkTypeWeight)
finalStrength = baseStrength + min(networkBonus, baseStrength * 0.5)
```

**Link type weights:** depends (0.3), derived (0.2), elaborates (0.2), contradicts (0.15), supersedes (0.15), related (0.1).

**Status transitions:**
- `active` — strength >= 0.5
- `needs_revalidation` — flagged by cascade revalidation
- `dormant` — strength < 0.1 (excluded from queries by default)
- `deprecated` — manually deprecated, decays 10x faster

### Data Model

- **knowledge** — Main entries table with FTS5 full-text search index
- **knowledge_links** — Typed associations between entries (unique constraint on source + target + type)
- **knowledge_embeddings** — Vector embeddings for semantic search

All tables use UUID primary keys and ISO 8601 timestamps. The `content_updated_at` column tracks content changes for sync conflict detection, and `synced_at` records when an entry was last synced with the repo.

### Scoping

Entries are scoped hierarchically:
- **company** — Visible to all queries
- **project** — Visible to project and repo queries
- **repo** — Visible only to repo queries

Queries at a given scope automatically inherit entries from broader scopes.

## Knowledge Graph Visualization

When the server is running, open `http://localhost:3333` to view the knowledge graph. The D3.js force-directed graph shows:

- **Nodes** — Color-coded by knowledge type, sized by strength
- **Edges** — Typed and labeled link relationships
- **Sidebar** — Click a node to inspect its details
- **Filters** — Filter by type, scope, or status

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
  types.ts              # Types, enums, constants, conversion helpers
  db/
    connection.ts       # SQLite connection (WAL mode, auto-create)
    schema.ts           # DDL: tables, indexes, FTS5, triggers
    queries.ts          # All CRUD, search, link, embedding queries
  memory/
    strength.ts         # Base + network strength calculations
    maintenance.ts      # Periodic sweep: recalculate strengths, transition dormant
  tools/
    store.ts            # store_knowledge
    query.ts            # query_knowledge
    list.ts             # list_knowledge
    reinforce.ts        # reinforce_knowledge
    deprecate.ts        # deprecate_knowledge
    delete.ts           # delete_knowledge
    link.ts             # link_knowledge
    update.ts           # update_knowledge
    sync.ts             # sync_knowledge
  sync/
    config.ts           # Sync repo path management
    serialize.ts        # Entry/link JSON serialization
    fs.ts               # Repo file I/O (read, write, delete, list)
    merge.ts            # Conflict detection (no_change, remote_wins, local_wins, conflict)
    pull.ts             # Import remote changes, handle conflicts
    push.ts             # Export local entries/links to repo
    write-through.ts    # Immediate sync on local writes
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
    db.test.ts          # Database layer tests (50 tests)
    memory.test.ts      # Memory model tests (15 tests)
    tools.test.ts       # Tool integration tests (26 tests)
    similarity.test.ts  # Similarity/RRF math tests (12 tests)
    sync.test.ts        # Sync layer tests (32 tests)
```

## License

MIT
