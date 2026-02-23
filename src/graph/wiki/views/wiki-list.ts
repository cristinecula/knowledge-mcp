// <wiki-list> — wiki home page with all pages listed

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { fetchWikiEntries, type WikiEntry } from '../api.js';
import { timeAgo, slugify } from '../util.js';

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

  // Sort alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.entry.title.localeCompare(b.entry.title));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);

  return roots;
}

function renderHomeTree(nodes: TreeNode[], depth: number): unknown {
  if (nodes.length === 0) return null;
  return nodes.map((node) => {
    const paddingLeft = depth * 20;
    return html`
      <a
        class="wiki-home-item"
        style="padding-left: ${12 + paddingLeft}px"
        href="/wiki/${node.entry.id}/${slugify(node.entry.title)}"
        @click=${(e: Event) => {
          e.preventDefault();
          navigate(
            `/wiki/${node.entry.id}/${slugify(node.entry.title)}`,
            null,
            { replace: false },
          );
        }}
      >
        <span class="wiki-home-item-title">${node.entry.title}</span>
        <span class="wiki-home-item-meta"
          >Updated ${timeAgo(node.entry.updated_at)}</span
        >
      </a>
      ${node.children.length > 0
        ? renderHomeTree(node.children, depth + 1)
        : null}
    `;
  });
}

function WikiList() {
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
      <div class="wiki-home">
        <div class="wiki-home-header">
          <h1>Wiki</h1>
          <p>
            Your knowledge base wiki. Create a page to get started &mdash;
            define a title and declaration, and agents will fill in the content.
          </p>
        </div>
        <div class="wiki-empty">
          <h3>No wiki pages yet</h3>
          <p style="margin-bottom:16px">Create your first wiki page to get started.</p>
          <button
            class="wiki-btn wiki-btn-primary"
            @click=${() => navigate('/wiki/new', null, { replace: false })}
          >
            Create First Page
          </button>
        </div>
      </div>
    `;
  }

  const roots = buildTree(entries);

  return html`
    <div class="wiki-home">
      <div class="wiki-home-header">
        <h1>All Pages</h1>
        <p>${entries.length} page${entries.length !== 1 ? 's' : ''} in this wiki</p>
      </div>
      <div class="wiki-home-grid">${renderHomeTree(roots, 0)}</div>
    </div>
  `;
}

customElements.define(
  'wiki-list',
  component(WikiList, { useShadowDOM: false }),
);
