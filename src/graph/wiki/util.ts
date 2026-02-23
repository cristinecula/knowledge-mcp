// Wiki UI utilities

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: 'Active', bg: '#23863622', color: '#3fb950' },
  needs_revalidation: { label: 'Pending', bg: '#d2992222', color: '#d29922' },
  dormant: { label: 'Dormant', bg: '#8b949e22', color: '#8b949e' },
  deprecated: { label: 'Deprecated', bg: '#f8514922', color: '#f85149' },
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function timeAgo(dateString: string): string {
  const now = Date.now();
  const date = new Date(dateString).getTime();
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

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function statusBadge(status: string): string {
  const s = STATUS_LABELS[status] || STATUS_LABELS.active;
  return `<span class="wiki-card-status" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}
