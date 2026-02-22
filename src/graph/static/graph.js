// Knowledge Graph Visualization — D3.js Force-Directed Graph

const TYPE_COLORS = {
  convention: '#58a6ff',
  decision: '#3fb950',
  pattern: '#bc8cff',
  pitfall: '#f85149',
  fact: '#79c0ff',
  debug_note: '#d29922',
  process: '#8b949e',
};

const LINK_COLORS = {
  depends: '#58a6ff',
  derived: '#3fb950',
  elaborates: '#bc8cff',
  contradicts: '#f85149',
  supersedes: '#d29922',
  related: '#8b949e',
};

const LINK_DASH = {
  depends: null,
  derived: null,
  elaborates: null,
  contradicts: '6,4',
  supersedes: null,
  related: '3,3',
};

const STATUS_OPACITY = {
  active: 1,
  needs_revalidation: 1,
  dormant: 0.3,
  deprecated: 0.15,
};

// State
let graphData = { nodes: [], links: [] };
let simulation = null;
let selectedNodeId = null;

// DOM refs
const svg = d3.select('#graph');
const tooltip = document.getElementById('tooltip');
const sidebar = document.getElementById('sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const statsEl = document.getElementById('stats');

// Filters
const filterType = document.getElementById('filter-type');
const filterScope = document.getElementById('filter-scope');
const filterStatus = document.getElementById('filter-status');
const btnRefresh = document.getElementById('btn-refresh');

// Zoom
const zoomGroup = svg.append('g');
const zoom = d3.zoom()
  .scaleExtent([0.1, 4])
  .on('zoom', (event) => {
    zoomGroup.attr('transform', event.transform);
  });
svg.call(zoom);

// Arrow markers for directed links
const defs = svg.append('defs');
Object.entries(LINK_COLORS).forEach(([type, color]) => {
  defs.append('marker')
    .attr('id', `arrow-${type}`)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', color)
    .attr('opacity', 0.6);
});

// Fetch data
async function fetchGraphData() {
  try {
    const res = await fetch('/api/graph');
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Failed to fetch graph data:', err);
    return { nodes: [], links: [] };
  }
}

async function fetchEntryDetail(id) {
  try {
    const res = await fetch(`/api/entry/${encodeURIComponent(id)}`);
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch entry detail:', err);
    return null;
  }
}

// Filter
function applyFilters(data) {
  const typeFilter = filterType.value;
  const scopeFilter = filterScope.value;
  const statusFilter = filterStatus.value;

  let nodes = data.nodes;

  if (typeFilter) {
    nodes = nodes.filter(n => n.type === typeFilter);
  }
  if (scopeFilter) {
    nodes = nodes.filter(n => n.scope === scopeFilter);
  }
  if (statusFilter && statusFilter !== 'all') {
    nodes = nodes.filter(n => n.status === statusFilter);
  } else if (!statusFilter) {
    // Default: active + needs_revalidation only
    nodes = nodes.filter(n => n.status === 'active' || n.status === 'needs_revalidation');
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  const links = data.links.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));

  return { nodes, links };
}

// Render
function render(data) {
  const filtered = applyFilters(data);

  // Update stats
  statsEl.textContent = `${filtered.nodes.length} entries, ${filtered.links.length} links`;

  // Clear previous
  zoomGroup.selectAll('*').remove();

  if (filtered.nodes.length === 0) {
    zoomGroup.append('text')
      .attr('x', window.innerWidth / 2)
      .attr('y', window.innerHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#8b949e')
      .attr('font-size', 16)
      .text('No knowledge entries found. Store some knowledge to see the graph.');
    return;
  }

  // Compute node sizes based on strength (min 6, max 30)
  const strengthExtent = d3.extent(filtered.nodes, d => d.strength);
  const radiusScale = d3.scaleSqrt()
    .domain([Math.min(strengthExtent[0], 0.1), Math.max(strengthExtent[1], 1)])
    .range([6, 30]);

  // Build simulation
  simulation = d3.forceSimulation(filtered.nodes)
    .force('link', d3.forceLink(filtered.links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2))
    .force('collision', d3.forceCollide().radius(d => radiusScale(d.strength) + 5));

  // Draw links
  const link = zoomGroup.append('g')
    .selectAll('line')
    .data(filtered.links)
    .join('line')
    .attr('stroke', d => LINK_COLORS[d.link_type] || '#30363d')
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.5)
    .attr('stroke-dasharray', d => LINK_DASH[d.link_type] || null)
    .attr('marker-end', d => `url(#arrow-${d.link_type})`);

  // Draw nodes
  const node = zoomGroup.append('g')
    .selectAll('circle')
    .data(filtered.nodes)
    .join('circle')
    .attr('r', d => radiusScale(d.strength))
    .attr('fill', d => TYPE_COLORS[d.type] || '#8b949e')
    .attr('opacity', d => STATUS_OPACITY[d.status] ?? 0.5)
    .attr('stroke', d => {
      if (d.status === 'needs_revalidation') return '#d29922';
      if (d.id === selectedNodeId) return '#f0f6fc';
      return 'none';
    })
    .attr('stroke-width', d => {
      if (d.status === 'needs_revalidation') return 3;
      if (d.id === selectedNodeId) return 2;
      return 0;
    })
    .style('cursor', 'pointer')
    .call(drag(simulation));

  // Pulsing for needs_revalidation
  node.filter(d => d.status === 'needs_revalidation')
    .style('animation', 'pulse 2s ease-in-out infinite');

  // Labels
  const label = zoomGroup.append('g')
    .selectAll('text')
    .data(filtered.nodes)
    .join('text')
    .attr('class', 'node-label')
    .attr('dy', d => radiusScale(d.strength) + 14)
    .text(d => d.title.length > 30 ? d.title.slice(0, 28) + '...' : d.title);

  // Hover tooltip
  node
    .on('mouseover', (event, d) => {
      tooltip.style.display = 'block';
      tooltip.querySelector('.tt-title').textContent = d.title;
      tooltip.querySelector('.tt-meta').textContent =
        `${d.type} | strength: ${d.strength.toFixed(3)} | ${d.status}`;
    })
    .on('mousemove', (event) => {
      tooltip.style.left = (event.pageX + 12) + 'px';
      tooltip.style.top = (event.pageY - 10) + 'px';
    })
    .on('mouseout', () => {
      tooltip.style.display = 'none';
    });

  // Click to open sidebar
  node.on('click', async (event, d) => {
    event.stopPropagation();
    selectedNodeId = d.id;
    node.attr('stroke', n => n.id === selectedNodeId ? '#f0f6fc' : (n.status === 'needs_revalidation' ? '#d29922' : 'none'))
      .attr('stroke-width', n => n.id === selectedNodeId ? 2 : (n.status === 'needs_revalidation' ? 3 : 0));
    await showSidebar(d.id);
  });

  // Click on background to close sidebar
  svg.on('click', () => {
    selectedNodeId = null;
    sidebar.classList.remove('open');
    node.attr('stroke', n => n.status === 'needs_revalidation' ? '#d29922' : 'none')
      .attr('stroke-width', n => n.status === 'needs_revalidation' ? 3 : 0);
  });

  // Tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);

    label
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  });
}

// Drag behavior
function drag(sim) {
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

// Sidebar
async function showSidebar(id) {
  const detail = await fetchEntryDetail(id);
  if (!detail) return;

  const { entry, links } = detail;
  const color = TYPE_COLORS[entry.type] || '#8b949e';

  const strengthPct = Math.min(100, Math.max(0, entry.strength * 100));
  const strengthColor = entry.strength >= 0.5 ? '#3fb950' : entry.strength >= 0.1 ? '#d29922' : '#f85149';

  let html = `
    <h2>${escapeHtml(entry.title)}</h2>
    <div>
      <span class="entry-type" style="background:${color}22;color:${color}">${entry.type}</span>
      <span class="status-badge status-${entry.status}">${entry.status}</span>
    </div>
    <div class="meta">
      <span>Scope: ${entry.scope}</span>
      ${entry.project ? `<span>Project: ${escapeHtml(entry.project)}</span>` : ''}
      <span>Accessed: ${entry.access_count}x</span>
      <span>Source: ${escapeHtml(entry.source)}</span>
    </div>
    <div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#8b949e;margin-bottom:4px">
        <span>Strength</span>
        <span>${entry.strength.toFixed(3)}</span>
      </div>
      <div class="strength-bar">
        <div class="strength-fill" style="width:${strengthPct}%;background:${strengthColor}"></div>
      </div>
    </div>
  `;

  if (entry.tags && entry.tags.length > 0) {
    const tags = typeof entry.tags === 'string' ? JSON.parse(entry.tags) : entry.tags;
    html += `<div class="tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`;
  }

  html += `<div class="content">${escapeHtml(entry.content)}</div>`;

  if (links && links.length > 0) {
    html += `<div class="links-section"><h3>Links (${links.length})</h3>`;
    for (const link of links) {
      const isOutgoing = link.source_id === entry.id;
      const otherId = isOutgoing ? link.target_id : link.source_id;
      const direction = isOutgoing ? '\u2192' : '\u2190';
      const linkColor = LINK_COLORS[link.link_type] || '#8b949e';

      html += `
        <div class="link-item" data-id="${otherId}" onclick="navigateToNode('${otherId}')">
          <span class="link-type-badge" style="background:${linkColor}22;color:${linkColor}">${link.link_type}</span>
          <span>${direction}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${otherId.slice(0, 8)}...</span>
        </div>
      `;
    }
    html += '</div>';
  }

  html += `
    <div class="meta" style="margin-top:8px">
      <span>Created: ${new Date(entry.created_at).toLocaleDateString()}</span>
      <span>Last accessed: ${new Date(entry.last_accessed_at).toLocaleDateString()}</span>
    </div>
    <div style="font-size:11px;color:#484f58;margin-top:4px;word-break:break-all">ID: ${entry.id}</div>
  `;

  sidebarContent.innerHTML = html;
  sidebar.classList.add('open');
}

// Navigate to a linked node
window.navigateToNode = async function(id) {
  selectedNodeId = id;
  await showSidebar(id);
  // Highlight the node in the graph
  d3.selectAll('circle')
    .attr('stroke', d => d.id === id ? '#f0f6fc' : (d.status === 'needs_revalidation' ? '#d29922' : 'none'))
    .attr('stroke-width', d => d.id === id ? 2 : (d.status === 'needs_revalidation' ? 3 : 0));
};

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Close sidebar
document.getElementById('sidebar-close').addEventListener('click', () => {
  sidebar.classList.remove('open');
  selectedNodeId = null;
  d3.selectAll('circle')
    .attr('stroke', d => d.status === 'needs_revalidation' ? '#d29922' : 'none')
    .attr('stroke-width', d => d.status === 'needs_revalidation' ? 3 : 0);
});

// Filter changes
filterType.addEventListener('change', () => render(graphData));
filterScope.addEventListener('change', () => render(graphData));
filterStatus.addEventListener('change', () => render(graphData));

// Refresh button
btnRefresh.addEventListener('click', async () => {
  graphData = await fetchGraphData();
  render(graphData);
});

// Handle window resize
window.addEventListener('resize', () => {
  if (simulation) {
    simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
    simulation.alpha(0.3).restart();
  }
});

// Initial load
(async () => {
  graphData = await fetchGraphData();
  render(graphData);
})();
