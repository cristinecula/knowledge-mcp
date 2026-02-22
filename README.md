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
- **8 MCP tools** — Store, query, list, reinforce, deprecate, link, update, and delete knowledge.
- **Sync-ready data model** — UUIDs, timestamps, and source tracking are designed for future team sync.

## Installation

```bash
git clone https://github.com/cristinecula/knowledge-mcp.git
cd knowledge-mcp
npm install
npm run build
```

The database is automatically created at `~/.knowledge-mcp/knowledge.db` on first run.

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
| `--backfill-embeddings` | Generate embeddings for all existing entries on startup | — |
| `--help` | Show help message | — |

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

All tables use UUID primary keys and ISO 8601 timestamps, designed for future sync support.

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
    memory.test.ts      # Memory model tests
    tools.test.ts       # Tool integration tests
    similarity.test.ts  # Similarity/RRF math tests
```

## License

MIT
