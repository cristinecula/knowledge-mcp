// Wiki UI utilities

const STATUS_LABELS: Record<string, { label: string; cssClass: string }> = {
  active: { label: 'Active', cssClass: 'status-active' },
  needs_revalidation: { label: 'Pending', cssClass: 'status-needs_revalidation' },
  deprecated: { label: 'Deprecated', cssClass: 'status-deprecated' },
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
  return `<span class="wiki-card-status ${s.cssClass}">${s.label}</span>`;
}
