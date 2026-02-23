// <wiki-list> — displays wiki pages as a collapsible tree hierarchy

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { fetchWikiEntries, type WikiEntry } from '../api.js';
import { escapeHtml, timeAgo, statusBadge, slugify } from '../util.js';

interface TreeNode {
  entry: WikiEntry;
  children: TreeNode[];
}

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

  return roots;
}

function renderCard(entry: WikiEntry) {
  return html`
    <div
      class="wiki-card"
      @click=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(`/wiki/${entry.id}/${slugify(entry.title)}`, null, {
          replace: false,
        });
      }}
    >
      <div class="wiki-card-main">
        <div class="wiki-card-title">${entry.title}</div>
        <div
          class="wiki-card-meta"
          .innerHTML=${`
          ${statusBadge(entry.status)}
          ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
          <span>${entry.scope}</span>
          <span>Updated ${timeAgo(entry.updated_at)}</span>
        `}
        ></div>
        ${entry.tags && entry.tags.length > 0
          ? html`<div class="wiki-card-tags">
              ${entry.tags.map(
                (t) => html`<span class="wiki-tag">${t}</span>`,
              )}
            </div>`
          : null}
      </div>
    </div>
  `;
}

function renderTree(
  nodes: TreeNode[],
  collapsed: Set<string>,
  toggle: (id: string) => void,
): unknown {
  if (nodes.length === 0) return null;
  return html`
    <ul class="wiki-tree">
      ${nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.entry.id);
        return html`
          <li class="wiki-tree-item">
            <div class="wiki-tree-row">
              ${hasChildren
                ? html`<button
                    class="wiki-tree-toggle"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      toggle(node.entry.id);
                    }}
                  >
                    ${isCollapsed ? '\u25B6' : '\u25BC'}
                  </button>`
                : html`<span class="wiki-tree-leaf"></span>`}
              ${renderCard(node.entry)}
            </div>
            ${hasChildren && !isCollapsed
              ? renderTree(node.children, collapsed, toggle)
              : null}
          </li>
        `;
      })}
    </ul>
  `;
}

function WikiList() {
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchWikiEntries().then((e) => {
      if (!cancelled) {
        setEntries(e);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return html`<div class="wiki-empty">Loading...</div>`;
  }

  if (entries.length === 0) {
    return html`
      <div class="wiki-empty">
        <h3>No wiki pages yet</h3>
        <p>
          Create your first wiki page to get started. Define a title and a
          declaration (prompt) — agents will fill in the content.
        </p>
      </div>
    `;
  }

  const roots = buildTree(entries);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setCollapsed(next);
  };

  return html`<div class="wiki-list">${renderTree(roots, collapsed, toggle)}</div>`;
}

customElements.define(
  'wiki-list',
  component(WikiList, { useShadowDOM: false }),
);
