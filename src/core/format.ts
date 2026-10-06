/** Number / currency / text formatting helpers. */

export function formatINR(amount: number | undefined | null): string {
  const n = Number(amount || 0);
  if (!isFinite(n) || n === 0) return '₹0';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

export function formatNumber(n: number | undefined | null): string {
  return Number(n || 0).toLocaleString('en-IN');
}

export function formatPercent(n: number | undefined | null, digits = 1): string {
  const v = Number(n || 0);
  if (!isFinite(v)) return '0%';
  return `${v.toFixed(digits)}%`;
}

export function pctChange(prev: number, curr: number): number | null {
  if (!isFinite(prev) || !isFinite(curr)) return null;
  if (prev === 0) return curr === 0 ? 0 : null; // null = "new" (not computable)
  return ((curr - prev) / Math.abs(prev)) * 100;
}

export function formatDuration(seconds: number | undefined | null): string {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || isNaN(hours)) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${hours.toFixed(1)} hrs`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function truncate(s: string | undefined | null, n = 80): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function initials(name: string | undefined | null): string {
  // Only words that start with a letter or digit count — "Admin (local)" → "A", "Dr. K. S. Rao" → "DK".
  return String(name || '')
    .split(/\s+/)
    .filter((p) => /^[\p{L}\p{N}]/u.test(p))
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || 'U';
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return '﻿' + lines.join('\r\n'); // BOM so Excel renders ₹ and Indic text
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pluralize(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}
