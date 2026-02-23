// Wiki UI — declaration-driven wiki page management

const root = document.getElementById('wiki-root');
const btnCreate = document.getElementById('btn-create');

const STATUS_LABELS = {
  active: { label: 'Active', bg: '#23863622', color: '#3fb950' },
  needs_revalidation: { label: 'Pending', bg: '#d2992222', color: '#d29922' },
  dormant: { label: 'Dormant', bg: '#8b949e22', color: '#8b949e' },
  deprecated: { label: 'Deprecated', bg: '#f8514922', color: '#f85149' },
};

// --- API helpers ---

async function fetchWikiEntries() {
  const res = await fetch('/api/wiki');
  const data = await res.json();
  return data.entries || [];
}

async function fetchEntry(id) {
  const res = await fetch(`/api/entry/${encodeURIComponent(id)}`);
  return await res.json();
}

async function createWikiEntry(body) {
  const res = await fetch('/api/wiki', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function updateWikiEntry(id, body) {
  const res = await fetch(`/api/wiki/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function deleteWikiEntry(id) {
  const res = await fetch(`/api/wiki/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return await res.json();
}

// --- Rendering ---

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(dateString) {
  const now = new Date();
  const date = new Date(dateString);
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function statusBadge(status) {
  const s = STATUS_LABELS[status] || STATUS_LABELS.active;
  return `<span class="wiki-card-status" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

// --- Views ---

async function showList() {
  root.innerHTML = '<div class="wiki-empty">Loading...</div>';

  const entries = await fetchWikiEntries();

  if (entries.length === 0) {
    root.innerHTML = `
      <div class="wiki-empty">
        <h3>No wiki pages yet</h3>
        <p>Create your first wiki page to get started. Define a title and a declaration (prompt) — agents will fill in the content.</p>
      </div>
    `;
    return;
  }

  let html = '<div class="wiki-list">';
  for (const entry of entries) {
    const tags = (entry.tags || []);
    const tagsHtml = tags.length > 0
      ? `<div class="wiki-card-tags">${tags.map(t => `<span class="wiki-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    html += `
      <div class="wiki-card" data-id="${entry.id}">
        <div class="wiki-card-main">
          <div class="wiki-card-title">${escapeHtml(entry.title)}</div>
          <div class="wiki-card-meta">
            ${statusBadge(entry.status)}
            ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
            <span>${entry.scope}</span>
            <span>Updated ${timeAgo(entry.updated_at)}</span>
          </div>
          ${tagsHtml}
        </div>
      </div>
    `;
  }
  html += '</div>';
  root.innerHTML = html;

  // Wire up click handlers
  root.querySelectorAll('.wiki-card').forEach(card => {
    card.addEventListener('click', () => showDetail(card.dataset.id));
  });
}

async function showDetail(id) {
  root.innerHTML = '<div class="wiki-empty">Loading...</div>';

  const data = await fetchEntry(id);
  if (!data || !data.entry) {
    root.innerHTML = '<div class="wiki-empty">Entry not found</div>';
    return;
  }

  const { entry, links } = data;
  const tags = entry.tags || [];
  const tagsHtml = tags.length > 0
    ? `<div class="wiki-card-tags" style="margin-bottom:16px">${tags.map(t => `<span class="wiki-tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const contentHtml = entry.content && entry.content.trim()
    ? `<div class="wiki-content">${marked.parse(entry.content)}</div>`
    : '<div class="wiki-content"><div class="wiki-content-empty">No content yet. An agent will fill this in based on the declaration.</div></div>';

  const declarationHtml = entry.declaration
    ? `<div class="wiki-declaration">
        <div class="wiki-declaration-label">Declaration</div>
        ${escapeHtml(entry.declaration)}
      </div>`
    : '';

  let linksHtml = '';
  if (links && links.length > 0) {
    linksHtml = `<div style="margin-top:16px"><h4 style="font-size:13px;color:#8b949e;margin-bottom:8px">Links (${links.length})</h4>`;
    for (const link of links) {
      const isOutgoing = link.source_id === entry.id;
      const otherId = isOutgoing ? link.target_id : link.source_id;
      const direction = isOutgoing ? '\u2192' : '\u2190';
      linksHtml += `
        <div style="font-size:12px;color:#8b949e;padding:4px 0">
          <span style="color:#f778ba">${link.link_type}</span> ${direction} <code>${otherId.slice(0, 8)}...</code>
        </div>
      `;
    }
    linksHtml += '</div>';
  }

  root.innerHTML = `
    <div class="wiki-detail">
      <div class="wiki-detail-header">
        <div>
          <div class="wiki-detail-title">${escapeHtml(entry.title)}</div>
          <div class="wiki-detail-meta">
            ${statusBadge(entry.status)}
            ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
            <span>${entry.scope}</span>
            <span>Source: ${escapeHtml(entry.source)}</span>
            <span>Updated ${timeAgo(entry.updated_at)}</span>
          </div>
        </div>
        <div class="wiki-detail-actions">
          <button class="wiki-btn" id="btn-back">Back</button>
          <button class="wiki-btn" id="btn-edit">Edit</button>
          <button class="wiki-btn wiki-btn-danger" id="btn-delete">Delete</button>
        </div>
      </div>
      ${tagsHtml}
      ${declarationHtml}
      ${contentHtml}
      ${linksHtml}
      <div class="wiki-detail-id">ID: ${entry.id}</div>
    </div>
  `;

  document.getElementById('btn-back').addEventListener('click', showList);
  document.getElementById('btn-edit').addEventListener('click', () => showEditForm(entry));
  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (confirm(`Delete wiki page "${entry.title}"?`)) {
      await deleteWikiEntry(entry.id);
      showList();
    }
  });
}

function showCreateForm() {
  root.innerHTML = `
    <div class="wiki-form">
      <h3 style="color:#f0f6fc;margin-bottom:8px">New Wiki Page</h3>
      <div class="wiki-form-group">
        <label for="wiki-title">Title *</label>
        <input type="text" id="wiki-title" placeholder="Page title" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-declaration">Declaration</label>
        <textarea id="wiki-declaration" placeholder="Describe what this page should contain. Agents will use this to generate the content."></textarea>
        <div class="wiki-form-hint">This prompt tells agents what content to produce for this page.</div>
      </div>
      <div class="wiki-form-group">
        <label for="wiki-tags">Tags</label>
        <input type="text" id="wiki-tags" placeholder="Comma-separated tags" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-project">Project</label>
        <input type="text" id="wiki-project" placeholder="Optional project name" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-scope">Scope</label>
        <select id="wiki-scope">
          <option value="company">Company</option>
          <option value="project">Project</option>
          <option value="repo">Repo</option>
        </select>
      </div>
      <div class="wiki-form-actions">
        <button class="wiki-btn" id="btn-cancel">Cancel</button>
        <button class="wiki-btn wiki-btn-primary" id="btn-save">Create Page</button>
      </div>
    </div>
  `;

  document.getElementById('btn-cancel').addEventListener('click', showList);
  document.getElementById('btn-save').addEventListener('click', async () => {
    const title = document.getElementById('wiki-title').value.trim();
    if (!title) {
      alert('Title is required');
      return;
    }

    const declaration = document.getElementById('wiki-declaration').value.trim() || null;
    const tagsRaw = document.getElementById('wiki-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    const project = document.getElementById('wiki-project').value.trim() || null;
    const scope = document.getElementById('wiki-scope').value;

    const result = await createWikiEntry({ title, declaration, tags, project, scope });
    if (result.entry) {
      showDetail(result.entry.id);
    } else {
      alert('Failed to create wiki page');
    }
  });
}

function showEditForm(entry) {
  const tags = (entry.tags || []).join(', ');

  root.innerHTML = `
    <div class="wiki-form">
      <h3 style="color:#f0f6fc;margin-bottom:8px">Edit Wiki Page</h3>
      <div class="wiki-form-group">
        <label for="wiki-title">Title</label>
        <input type="text" id="wiki-title" value="${escapeHtml(entry.title)}" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-declaration">Declaration</label>
        <textarea id="wiki-declaration">${escapeHtml(entry.declaration || '')}</textarea>
        <div class="wiki-form-hint">Updating the declaration will re-mark this page for agent processing.</div>
      </div>
      <div class="wiki-form-group">
        <label for="wiki-tags">Tags</label>
        <input type="text" id="wiki-tags" value="${escapeHtml(tags)}" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-project">Project</label>
        <input type="text" id="wiki-project" value="${escapeHtml(entry.project || '')}" />
      </div>
      <div class="wiki-form-group">
        <label for="wiki-scope">Scope</label>
        <select id="wiki-scope">
          <option value="company" ${entry.scope === 'company' ? 'selected' : ''}>Company</option>
          <option value="project" ${entry.scope === 'project' ? 'selected' : ''}>Project</option>
          <option value="repo" ${entry.scope === 'repo' ? 'selected' : ''}>Repo</option>
        </select>
      </div>
      <div class="wiki-form-actions">
        <button class="wiki-btn" id="btn-cancel">Cancel</button>
        <button class="wiki-btn wiki-btn-primary" id="btn-save">Save Changes</button>
      </div>
    </div>
  `;

  document.getElementById('btn-cancel').addEventListener('click', () => showDetail(entry.id));
  document.getElementById('btn-save').addEventListener('click', async () => {
    const title = document.getElementById('wiki-title').value.trim();
    if (!title) {
      alert('Title is required');
      return;
    }

    const declaration = document.getElementById('wiki-declaration').value.trim() || null;
    const tagsRaw = document.getElementById('wiki-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    const project = document.getElementById('wiki-project').value.trim() || null;
    const scope = document.getElementById('wiki-scope').value;

    const result = await updateWikiEntry(entry.id, { title, declaration, tags, project, scope });
    if (result.entry) {
      showDetail(result.entry.id);
    } else {
      alert('Failed to update wiki page');
    }
  });
}

// --- Event wiring ---

btnCreate.addEventListener('click', showCreateForm);

// Initial load
showList();
