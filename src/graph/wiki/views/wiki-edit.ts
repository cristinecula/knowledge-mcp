// <wiki-edit> — form to edit an existing wiki page

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import {
  fetchEntry,
  fetchWikiEntries,
  updateWikiEntry,
  type WikiEntry,
} from '../api.js';
import { slugify } from '../util.js';

/** Collect all descendant IDs of a given entry to prevent cycle in parent selection. */
function getDescendantIds(entryId: string, entries: WikiEntry[]): Set<string> {
  const ids = new Set<string>();
  const queue = [entryId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const e of entries) {
      if (e.parent_page_id === current && !ids.has(e.id)) {
        ids.add(e.id);
        queue.push(e.id);
      }
    }
  }
  return ids;
}

function WikiEdit(this: HTMLElement & { entryId: string }) {
  const entryId = this.entryId;
  const [entry, setEntry] = useState<WikiEntry | null>(null);
  const [allEntries, setAllEntries] = useState<WikiEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [declaration, setDeclaration] = useState('');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState('');
  const [scope, setScope] = useState('company');
  const [parentPageId, setParentPageId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    Promise.all([fetchEntry(entryId), fetchWikiEntries()]).then(
      ([data, entries]) => {
        if (cancelled) return;
        if (data && data.entry) {
          const e = data.entry;
          setEntry(e);
          setTitle(e.title);
          setDeclaration(e.declaration || '');
          setTags((e.tags || []).join(', '));
          setProject(e.project || '');
          setScope(e.scope);
          setParentPageId(e.parent_page_id);
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

  if (!entry) {
    return html`<div class="wiki-empty">Entry not found</div>`;
  }

  // Exclude self + all descendants from parent options to prevent cycles
  const excludedIds = getDescendantIds(entry.id, allEntries);
  excludedIds.add(entry.id);
  const parentOptions = allEntries.filter((e) => !excludedIds.has(e.id));

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      alert('Title is required');
      return;
    }
    setSaving(true);
    const result = await updateWikiEntry(entry.id, {
      title: trimmedTitle,
      declaration: declaration.trim() || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      project: project.trim() || null,
      scope,
      parentPageId,
    });
    if (result.entry) {
      navigate(
        `/wiki/${result.entry.id}/${slugify(result.entry.title)}`,
        null,
        { replace: false },
      );
    } else {
      alert('Failed to update wiki page');
      setSaving(false);
    }
  };

  return html`
    <div class="wiki-form">
      <h3 style="color:#f0f6fc;margin-bottom:8px">Edit Wiki Page</h3>

      <div class="wiki-form-group">
        <label>Title</label>
        <input
          type="text"
          .value=${title}
          @input=${(e: Event) =>
            setTitle((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Declaration</label>
        <textarea
          .value=${declaration}
          @input=${(e: Event) =>
            setDeclaration((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="wiki-form-hint">
          Updating the declaration will re-mark this page for agent processing.
        </div>
      </div>

      <div class="wiki-form-group">
        <label>Parent Page</label>
        <select
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value;
            setParentPageId(val || null);
          }}
        >
          <option value="">None (top-level)</option>
          ${parentOptions.map(
            (opt) =>
              html`<option
                value=${opt.id}
                ?selected=${opt.id === parentPageId}
              >
                ${opt.title}
              </option>`,
          )}
        </select>
        <div class="wiki-form-hint">
          Move this page under another wiki page. Cannot select itself or
          descendants.
        </div>
      </div>

      <div class="wiki-form-group">
        <label>Tags</label>
        <input
          type="text"
          .value=${tags}
          @input=${(e: Event) =>
            setTags((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Project</label>
        <input
          type="text"
          .value=${project}
          @input=${(e: Event) =>
            setProject((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Scope</label>
        <select
          .value=${scope}
          @change=${(e: Event) =>
            setScope((e.target as HTMLSelectElement).value)}
        >
          <option value="company" ?selected=${scope === 'company'}>
            Company
          </option>
          <option value="project" ?selected=${scope === 'project'}>
            Project
          </option>
          <option value="repo" ?selected=${scope === 'repo'}>Repo</option>
        </select>
      </div>

      <div class="wiki-form-actions">
        <button
          class="wiki-btn"
          @click=${() =>
            navigate(
              `/wiki/${entry.id}/${slugify(entry.title)}`,
              null,
              { replace: false },
            )}
        >
          Cancel
        </button>
        <button
          class="wiki-btn wiki-btn-primary"
          ?disabled=${saving}
          @click=${handleSave}
        >
          ${saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  `;
}

WikiEdit.observedAttributes = ['entry-id'] as const;

customElements.define(
  'wiki-edit',
  component<{ entryId: string }>(WikiEdit, { useShadowDOM: false }),
);
