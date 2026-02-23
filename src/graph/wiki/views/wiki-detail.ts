// <wiki-detail> — shows a single wiki page with content rendered as markdown

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { marked } from 'marked';
import {
  fetchEntry,
  fetchWikiEntries,
  deleteWikiEntry,
  type WikiEntry,
  type WikiLink,
} from '../api.js';
import { escapeHtml, timeAgo, statusBadge, slugify } from '../util.js';
import { resolveWikiLinks } from '../wikilinks.js';

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
  const [links, setLinks] = useState<WikiLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    Promise.all([fetchEntry(entryId), fetchWikiEntries()]).then(
      ([data, entries]) => {
        if (cancelled) return;
        if (!data || !data.entry) {
          setNotFound(true);
        } else {
          setEntry(data.entry);
          setLinks(data.links || []);
          setAllEntries(entries);
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

  const contentHtml =
    entry.content && entry.content.trim()
      ? (marked.parse(resolveWikiLinks(entry.content, allEntries)) as string)
      : '<div class="wiki-content-empty">No content yet. An agent will fill this in based on the declaration.</div>';

  // Build breadcrumbs (ancestors)
  const breadcrumbs = buildBreadcrumbs(entry, allEntries);

  // Find child pages
  const children = allEntries.filter((e) => e.parent_page_id === entry.id);

  const handleDelete = async () => {
    if (confirm(`Delete wiki page "${entry.title}"?`)) {
      await deleteWikiEntry(entry.id);
      navigate('/wiki', null, { replace: false });
    }
  };

  return html`
    <div class="wiki-detail">
      ${breadcrumbs.length > 0
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

      <div class="wiki-detail-header">
        <div>
          <div class="wiki-detail-title">${entry.title}</div>
          <div
            class="wiki-detail-meta"
            .innerHTML=${`
            ${statusBadge(entry.status)}
            ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
            <span>${entry.scope}</span>
            <span>Source: ${escapeHtml(entry.source)}</span>
            <span>Updated ${timeAgo(entry.updated_at)}</span>
          `}
          ></div>
        </div>
        <div class="wiki-detail-actions">
          <button
            class="wiki-btn"
            @click=${() => navigate('/wiki', null, { replace: false })}
          >
            Back
          </button>
          <button
            class="wiki-btn"
            @click=${() =>
              navigate(`/wiki/${entry.id}/edit`, null, { replace: false })}
          >
            Edit
          </button>
          <button class="wiki-btn wiki-btn-danger" @click=${handleDelete}>
            Delete
          </button>
        </div>
      </div>

      ${entry.tags && entry.tags.length > 0
        ? html`<div class="wiki-card-tags" style="margin-bottom:16px">
            ${entry.tags.map(
              (t) => html`<span class="wiki-tag">${t}</span>`,
            )}
          </div>`
        : null}
      ${entry.declaration
        ? html`<div class="wiki-declaration">
            <div class="wiki-declaration-label">Declaration</div>
            ${entry.declaration}
          </div>`
        : null}

      <div
        class="wiki-content"
        .innerHTML=${contentHtml}
        @click=${(e: Event) => {
          // Intercept wiki link clicks for client-side navigation
          const target = e.target as HTMLElement;
          const anchor = target.closest('a.wiki-link') as HTMLAnchorElement | null;
          if (anchor) {
            e.preventDefault();
            navigate(anchor.getAttribute('href')!, null, { replace: false });
          }
        }}
      ></div>

      ${links.length > 0
        ? html`<div style="margin-top:16px">
            <h4 style="font-size:13px;color:#8b949e;margin-bottom:8px">
              Links (${links.length})
            </h4>
            ${links.map((link) => {
              const isOutgoing = link.source_id === entry.id;
              const otherId = isOutgoing ? link.target_id : link.source_id;
              const direction = isOutgoing ? '\u2192' : '\u2190';
              return html`<div
                style="font-size:12px;color:#8b949e;padding:4px 0"
              >
                <span style="color:#f778ba">${link.link_type}</span>
                ${direction}
                <code>${otherId.slice(0, 8)}...</code>
              </div>`;
            })}
          </div>`
        : null}

      ${children.length > 0
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
