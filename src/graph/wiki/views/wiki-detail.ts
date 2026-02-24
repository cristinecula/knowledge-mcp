// <wiki-detail> — shows a single wiki page or KB entry with content rendered as markdown

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { marked } from 'marked';
import {
  fetchEntry,
  fetchWikiEntries,
  fetchKbEntries,
  deleteWikiEntry,
  flagWikiEntry,
  type WikiEntry,
  type WikiLink,
} from '../api.js';
import { escapeHtml, timeAgo, statusBadge, slugify } from '../util.js';
import { resolveWikiLinks } from '../wikilinks.js';
import { extractToc, renderTocHtml } from '../toc.js';

/** Display labels for entry types. */
const TYPE_LABELS: Record<string, string> = {
  wiki: 'wiki',
  convention: 'convention',
  decision: 'decision',
  pattern: 'pattern',
  pitfall: 'pitfall',
  fact: 'fact',
  debug_note: 'debug note',
  process: 'process',
};

/** Build breadcrumb chain from current entry up to root. */
function buildBreadcrumbs(entry: WikiEntry, allEntries: WikiEntry[]): WikiEntry[] {
  const byId = new Map<string, WikiEntry>();
  for (const e of allEntries) byId.set(e.id, e);

  const crumbs: WikiEntry[] = [];
  let current: WikiEntry | undefined = entry;
  const seen = new Set<string>();
  while (current && current.parent_page_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parent_page_id);
    if (parent) crumbs.unshift(parent);
    current = parent;
  }
  return crumbs;
}

function WikiDetail(this: HTMLElement & { entryId: string }) {
  const entryId = this.entryId;
  const [entry, setEntry] = useState<WikiEntry | null>(null);
  const [allEntries, setAllEntries] = useState<WikiEntry[]>([]);
  const [kbEntries, setKbEntries] = useState<WikiEntry[]>([]);
  const [links, setLinks] = useState<WikiLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    Promise.all([fetchEntry(entryId), fetchWikiEntries(), fetchKbEntries()]).then(
      ([data, wikiEntries, kb]) => {
        if (cancelled) return;
        if (!data || !data.entry) {
          setNotFound(true);
        } else {
          setEntry(data.entry);
          setLinks(data.links || []);
          setAllEntries(wikiEntries);
          setKbEntries(kb);
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  if (loading) {
    return html`<div class="wiki-empty">Loading...</div>`;
  }

  if (notFound || !entry) {
    return html`<div class="wiki-empty">Entry not found</div>`;
  }

  const isWiki = entry.type === 'wiki';

  // Render content: resolve wiki links -> markdown -> extract TOC
  let contentHtml = '';
  let tocHtml = '';

  if (entry.content && entry.content.trim()) {
    const withLinks = resolveWikiLinks(entry.content, allEntries, kbEntries);
    const rawHtml = marked.parse(withLinks) as string;
    const { toc, html: htmlWithIds } = extractToc(rawHtml);
    contentHtml = htmlWithIds;
    // Only show TOC if there are 3+ headings
    if (toc.length >= 3) {
      tocHtml = renderTocHtml(toc);
    }
  } else {
    contentHtml = isWiki
      ? '<div class="wiki-content-empty">No content yet. An agent will fill this in based on the declaration.</div>'
      : '<div class="wiki-content-empty">No content yet.</div>';
  }

  // Build breadcrumbs (ancestors) — only for wiki entries
  const breadcrumbs = isWiki ? buildBreadcrumbs(entry, allEntries) : [];

  // Find child pages — only for wiki entries
  const children = isWiki ? allEntries.filter((e) => e.parent_page_id === entry.id) : [];

  // Build a lookup map for linked entry titles (both wiki + KB)
  const allKnownEntries = new Map<string, WikiEntry>();
  for (const e of allEntries) allKnownEntries.set(e.id, e);
  for (const e of kbEntries) allKnownEntries.set(e.id, e);

  const handleDelete = async () => {
    if (confirm(`Delete wiki page "${entry.title}"?`)) {
      await deleteWikiEntry(entry.id);
      navigate('/wiki', null, { replace: false });
    }
  };

  const handleFlag = async () => {
    const reason = prompt(
      'Flag this page as inaccurate.\n\nOptionally describe what is wrong (or leave blank):',
    );
    // prompt returns null on Cancel
    if (reason === null) return;
    const result = await flagWikiEntry(entry.id, reason || undefined);
    if (result.entry) {
      setEntry(result.entry);
    }
  };

  const typeLabel = TYPE_LABELS[entry.type] || entry.type;

  return html`
    <div class="wiki-detail">
      <!-- Breadcrumbs — wiki entries only -->
      ${isWiki && breadcrumbs.length > 0
        ? html`<nav class="wiki-breadcrumbs">
            <a
              class="wiki-breadcrumb-link"
              @click=${(e: Event) => {
                e.preventDefault();
                navigate('/wiki', null, { replace: false });
              }}
              href="/wiki"
              >Wiki</a
            >
            ${breadcrumbs.map(
              (bc) => html`
                <span class="wiki-breadcrumb-sep">/</span>
                <a
                  class="wiki-breadcrumb-link"
                  href="/wiki/${bc.id}/${slugify(bc.title)}"
                  @click=${(e: Event) => {
                    e.preventDefault();
                    navigate(
                      `/wiki/${bc.id}/${slugify(bc.title)}`,
                      null,
                      { replace: false },
                    );
                  }}
                  >${bc.title}</a
                >
              `,
            )}
            <span class="wiki-breadcrumb-sep">/</span>
            <span class="wiki-breadcrumb-current">${entry.title}</span>
          </nav>`
        : null}

      <!-- Page header -->
      <div class="wiki-detail-header">
        <div style="flex:1;min-width:0">
          <h1 class="wiki-detail-title">
            ${!isWiki
              ? html`<span class="wiki-type-badge wiki-type-badge-${entry.type}">${typeLabel}</span>`
              : null}
            ${entry.title}
          </h1>
        </div>
        ${isWiki
          ? html`<div class="wiki-detail-actions">
              <button
                class="wiki-btn wiki-btn-sm"
                @click=${() =>
                  navigate(`/wiki/${entry.id}/edit`, null, { replace: false })}
              >
                Edit
              </button>
              <button
                class="wiki-btn wiki-btn-sm wiki-btn-warning"
                @click=${handleFlag}
              >
                Flag
              </button>
              <button
                class="wiki-btn wiki-btn-sm wiki-btn-danger"
                @click=${handleDelete}
              >
                Delete
              </button>
            </div>`
          : null}
      </div>

      <!-- Meta line -->
      <div
        class="wiki-detail-meta"
        .innerHTML=${`
          ${statusBadge(entry.status, entry.inaccuracy)}
          ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
          <span>${entry.scope}</span>
          <span>Source: ${escapeHtml(entry.source)}</span>
          <span>Updated ${timeAgo(entry.updated_at)}</span>
        `}
      ></div>

      <!-- Flag warning banner — wiki entries only -->
      ${isWiki && entry.flag_reason != null
        ? html`<div class="wiki-flag-banner">
            <strong>Flagged as inaccurate</strong>${entry.flag_reason
              ? html`: ${entry.flag_reason}`
              : null}
          </div>`
        : null}

      <!-- Tags -->
      ${entry.tags && entry.tags.length > 0
        ? html`<div class="wiki-detail-tags">
            ${entry.tags.map(
              (t) => html`<span class="wiki-tag">${t}</span>`,
            )}
          </div>`
        : null}

      <!-- Declaration — wiki entries only -->
      ${isWiki && entry.declaration
        ? html`<div class="wiki-declaration">
            <div class="wiki-declaration-label">Declaration</div>
            ${entry.declaration}
          </div>`
        : null}

      <!-- Table of Contents -->
      ${tocHtml
        ? html`<div .innerHTML=${tocHtml}></div>`
        : null}

      <!-- Article content -->
      <div
        class="wiki-content"
        .innerHTML=${contentHtml}
        @click=${(e: Event) => {
          // Intercept wiki link clicks and TOC anchor clicks for client-side navigation
          const target = e.target as HTMLElement;
          const anchor = target.closest('a') as HTMLAnchorElement | null;
          if (!anchor) return;

          // Wiki link — navigate via router
          if (anchor.classList.contains('wiki-link')) {
            e.preventDefault();
            navigate(anchor.getAttribute('href')!, null, { replace: false });
            return;
          }

          // TOC anchor link — smooth scroll
          const href = anchor.getAttribute('href');
          if (href && href.startsWith('#')) {
            e.preventDefault();
            const el = document.getElementById(href.slice(1));
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}
      ></div>

      <!-- Knowledge graph links — clickable with descriptions -->
      ${links.length > 0
        ? html`<div class="wiki-links-section">
            <h4>Knowledge Links (${links.length})</h4>
            ${links.map((link) => {
              const isOutgoing = link.source_id === entry.id;
              const otherId = isOutgoing ? link.target_id : link.source_id;
              const direction = isOutgoing ? '\u2192' : '\u2190';
              const linkedEntry = allKnownEntries.get(otherId);
              const linkedTitle = linkedEntry
                ? linkedEntry.title
                : `${otherId.slice(0, 8)}...`;
              const linkedType = linkedEntry?.type;

              return html`<div class="wiki-link-entry">
                <span class="wiki-link-type">${link.link_type}</span>
                ${direction}
                ${linkedEntry
                  ? html`<a
                      class="wiki-link-entry-link"
                      href="/wiki/${otherId}/${slugify(linkedTitle)}"
                      @click=${(e: Event) => {
                        e.preventDefault();
                        navigate(
                          `/wiki/${otherId}/${slugify(linkedTitle)}`,
                          null,
                          { replace: false },
                        );
                      }}
                    >${linkedType && linkedType !== 'wiki'
                        ? html`<span class="wiki-type-badge-inline wiki-type-badge-${linkedType}">${TYPE_LABELS[linkedType] || linkedType}</span> `
                        : null}${linkedTitle}</a
                  >`
                  : html`<code>${linkedTitle}</code>`}
                ${link.description
                  ? html`<span class="wiki-link-description">${link.description}</span>`
                  : null}
              </div>`;
            })}
          </div>`
        : null}

      <!-- Child pages — wiki entries only -->
      ${isWiki && children.length > 0
        ? html`<div class="wiki-children">
            <h4 class="wiki-children-heading">
              Child Pages (${children.length})
            </h4>
            <ul class="wiki-children-list">
              ${children.map(
                (child) => html`
                  <li>
                    <a
                      class="wiki-children-link"
                      href="/wiki/${child.id}/${slugify(child.title)}"
                      @click=${(e: Event) => {
                        e.preventDefault();
                        navigate(
                          `/wiki/${child.id}/${slugify(child.title)}`,
                          null,
                          { replace: false },
                        );
                      }}
                      >${child.title}</a
                    >
                  </li>
                `,
              )}
            </ul>
          </div>`
        : null}

      <div class="wiki-detail-id">ID: ${entry.id}</div>
    </div>
  `;
}

WikiDetail.observedAttributes = ['entry-id'] as const;

customElements.define(
  'wiki-detail',
  component<{ entryId: string }>(WikiDetail, { useShadowDOM: false }),
);
