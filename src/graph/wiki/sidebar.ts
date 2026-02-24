// <wiki-sidebar> — persistent sidebar with page tree, KB entries, and search

import { component, html, useState, useEffect, useCallback } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { fetchWikiEntries, fetchKbEntries, type WikiEntry } from './api.js';
import { slugify } from './util.js';

interface TreeNode {
  entry: WikiEntry;
  children: TreeNode[];
}

/** The 7 non-wiki knowledge types in display order. */
const KB_TYPE_LABELS: Record<string, string> = {
  convention: 'Conventions',
  decision: 'Decisions',
  pattern: 'Patterns',
  pitfall: 'Pitfalls',
  fact: 'Facts',
  debug_note: 'Debug Notes',
  process: 'Processes',
};

/** Build a forest (array of root trees) from a flat list of entries. */
function buildTree(entries: WikiEntry[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const entry of entries) {
    byId.set(entry.id, { entry, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.entry.parent_page_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort roots and children alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.entry.title.localeCompare(b.entry.title));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);

  return roots;
}

/** Check if a node or any of its descendants matches the query. */
function treeMatches(node: TreeNode, query: string): boolean {
  if (node.entry.title.toLowerCase().includes(query)) return true;
  return node.children.some((child) => treeMatches(child, query));
}

/** Filter tree to only include nodes matching query (and their ancestors). */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes;
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (treeMatches(node, query)) {
      result.push({
        entry: node.entry,
        children: filterTree(node.children, query),
      });
    }
  }
  return result;
}

function renderSidebarTree(
  nodes: TreeNode[],
  collapsed: Set<string>,
  toggle: (id: string) => void,
  activeId: string | null,
  searchQuery: string,
): unknown {
  if (nodes.length === 0) return null;
  return html`
    <ul class="wiki-sidebar-tree">
      ${nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        // When searching, expand all matches
        const isCollapsed = searchQuery
          ? false
          : collapsed.has(node.entry.id);
        const isActive = node.entry.id === activeId;

        return html`
          <li class="wiki-sidebar-item">
            <div class="wiki-sidebar-item-row">
              ${hasChildren
                ? html`<button
                    class="wiki-sidebar-toggle"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      toggle(node.entry.id);
                    }}
                  >
                    ${isCollapsed ? '\u25B6' : '\u25BC'}
                  </button>`
                : html`<span class="wiki-sidebar-leaf"></span>`}
              <a
                class="wiki-sidebar-link ${isActive ? 'active' : ''}"
                href="/wiki/${node.entry.id}/${slugify(node.entry.title)}"
                @click=${(e: Event) => {
                  e.preventDefault();
                  navigate(
                    `/wiki/${node.entry.id}/${slugify(node.entry.title)}`,
                    null,
                    { replace: false },
                  );
                }}
                >${node.entry.title}</a
              >
            </div>
            ${hasChildren && !isCollapsed
              ? renderSidebarTree(
                  node.children,
                  collapsed,
                  toggle,
                  activeId,
                  searchQuery,
                )
              : null}
          </li>
        `;
      })}
    </ul>
  `;
}

function WikiSidebar(this: HTMLElement & { activeId: string | null }) {
  const activeId = this.activeId || null;
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [kbEntries, setKbEntries] = useState<WikiEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [kbSectionCollapsed, setKbSectionCollapsed] = useState(true);
  const [kbGroupCollapsed, setKbGroupCollapsed] = useState<Set<string>>(new Set());

  // Fetch entries on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchWikiEntries(), fetchKbEntries()]).then(([wiki, kb]) => {
      if (!cancelled) {
        setEntries(wiki);
        setKbEntries(kb);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch when navigating to a different page (activeId changes)
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchWikiEntries(), fetchKbEntries()]).then(([wiki, kb]) => {
      if (!cancelled) {
        setEntries(wiki);
        setKbEntries(kb);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(collapsed);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setCollapsed(next);
    },
    [collapsed],
  );

  const toggleKbGroup = useCallback(
    (type: string) => {
      const next = new Set(kbGroupCollapsed);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      setKbGroupCollapsed(next);
    },
    [kbGroupCollapsed],
  );

  const handleSearch = useCallback(
    (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      // Debounce by 150ms
      if (searchTimer) clearTimeout(searchTimer);
      const timer = setTimeout(() => {
        setSearchQuery(value.toLowerCase().trim());
      }, 150);
      setSearchTimer(timer);
    },
    [searchTimer],
  );

  const roots = buildTree(entries);
  const filtered = filterTree(roots, searchQuery);

  // Group KB entries by type, filter by search query
  const filteredKb = searchQuery
    ? kbEntries.filter((e) => e.title.toLowerCase().includes(searchQuery))
    : kbEntries;
  const kbGroups = new Map<string, WikiEntry[]>();
  for (const entry of filteredKb) {
    const list = kbGroups.get(entry.type) || [];
    list.push(entry);
    kbGroups.set(entry.type, list);
  }
  // Sort within groups
  for (const list of kbGroups.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title));
  }

  // When searching, auto-expand the KB section and all groups
  const isKbExpanded = searchQuery ? true : !kbSectionCollapsed;

  return html`
    <div class="wiki-sidebar-header">
      <a
        class="wiki-sidebar-logo"
        href="/wiki"
        @click=${(e: Event) => {
          e.preventDefault();
          navigate('/wiki', null, { replace: false });
        }}
        >Wiki</a
      >
      <div class="wiki-sidebar-search">
        <span class="wiki-sidebar-search-icon">&#x1F50D;</span>
        <input
          type="text"
          placeholder="Search pages..."
          @input=${handleSearch}
        />
      </div>
    </div>

    <nav class="wiki-sidebar-nav">
      ${loading
        ? html`<div
            style="padding:16px;font-size:13px;color:var(--wiki-text-muted)"
          >
            Loading...
          </div>`
        : entries.length === 0 && kbEntries.length === 0
          ? html`<div
              style="padding:16px;font-size:13px;color:var(--wiki-text-muted)"
            >
              No pages yet
            </div>`
          : html`
              ${entries.length > 0 || !searchQuery
                ? html`
                    ${searchQuery && filtered.length === 0
                      ? null
                      : html`
                          <div class="wiki-sidebar-section-title">Pages</div>
                          ${renderSidebarTree(
                            filtered,
                            collapsed,
                            toggle,
                            activeId,
                            searchQuery,
                          )}
                        `}
                  `
                : null}
              ${filteredKb.length > 0
                ? html`
                    <div
                      class="wiki-sidebar-kb-section-header"
                      @click=${() => {
                        if (!searchQuery) setKbSectionCollapsed(!kbSectionCollapsed);
                      }}
                    >
                      <button class="wiki-sidebar-toggle">
                        ${isKbExpanded ? '\u25BC' : '\u25B6'}
                      </button>
                      <span class="wiki-sidebar-section-title" style="padding:0;cursor:pointer"
                        >Knowledge Base</span
                      >
                      <span class="wiki-sidebar-kb-badge">${filteredKb.length}</span>
                    </div>
                    ${isKbExpanded
                      ? html`
                          <div class="wiki-sidebar-kb-section">
                            ${Array.from(kbGroups.entries())
                              .sort(([a], [b]) => {
                                const order = Object.keys(KB_TYPE_LABELS);
                                return order.indexOf(a) - order.indexOf(b);
                              })
                              .map(([type, typeEntries]) => {
                                const label = KB_TYPE_LABELS[type] || type;
                                const isGroupCollapsed = searchQuery
                                  ? false
                                  : kbGroupCollapsed.has(type);
                                return html`
                                  <div class="wiki-sidebar-kb-group">
                                    <div
                                      class="wiki-sidebar-kb-group-header"
                                      @click=${() => toggleKbGroup(type)}
                                    >
                                      <button class="wiki-sidebar-toggle">
                                        ${isGroupCollapsed ? '\u25B6' : '\u25BC'}
                                      </button>
                                      <span class="wiki-sidebar-kb-group-label">${label}</span>
                                      <span class="wiki-sidebar-kb-badge">${typeEntries.length}</span>
                                    </div>
                                    ${!isGroupCollapsed
                                      ? html`
                                          <ul class="wiki-sidebar-tree">
                                            ${typeEntries.map((entry) => {
                                              const isActive = entry.id === activeId;
                                              return html`
                                                <li class="wiki-sidebar-item">
                                                  <div class="wiki-sidebar-item-row">
                                                    <span class="wiki-sidebar-leaf"></span>
                                                    <a
                                                      class="wiki-sidebar-link wiki-sidebar-link-kb ${isActive ? 'active' : ''}"
                                                      href="/wiki/${entry.id}/${slugify(entry.title)}"
                                                      @click=${(e: Event) => {
                                                        e.preventDefault();
                                                        navigate(
                                                          `/wiki/${entry.id}/${slugify(entry.title)}`,
                                                          null,
                                                          { replace: false },
                                                        );
                                                      }}
                                                      >${entry.title}</a
                                                    >
                                                  </div>
                                                </li>
                                              `;
                                            })}
                                          </ul>
                                        `
                                      : null}
                                  </div>
                                `;
                              })}
                          </div>
                        `
                      : null}
                  `
                : searchQuery
                  ? null
                  : null}
              ${searchQuery && filtered.length === 0 && filteredKb.length === 0
                ? html`<div class="wiki-sidebar-results-empty">
                    No results matching "${searchQuery}"
                  </div>`
                : null}
            `}
    </nav>

    <div class="wiki-sidebar-footer">
      <a href="/" class="wiki-btn wiki-btn-sm">Graph View</a>
      <button
        class="wiki-btn wiki-btn-primary wiki-btn-sm"
        @click=${() => navigate('/wiki/new', null, { replace: false })}
      >
        + New Page
      </button>
    </div>
  `;
}

WikiSidebar.observedAttributes = ['active-id'] as const;

customElements.define(
  'wiki-sidebar',
  component<{ activeId: string | null }>(WikiSidebar, {
    useShadowDOM: false,
  }),
);
