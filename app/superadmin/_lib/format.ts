import type { FeatureKey, Plan } from '@/server/platform/contract';

const TZ = 'Asia/Kolkata';

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function fmtDate(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function fmtNum(n: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN').format(Number(n) || 0);
}

export function fmtMB(mb: number | null | undefined): string {
  const n = Number(mb) || 0;
  if (n === 0) return '0 MB';
  if (n < 1) return `${Math.max(1, Math.round(n * 1024))} KB`;
  if (n < 1024) return `${n < 10 ? n.toFixed(1) : Math.round(n)} MB`;
  return `${(n / 1024).toFixed(2)} GB`;
}

export function fmtSeats(active: number, max: number): string {
  return `${fmtNum(active)} / ${max === 0 ? '∞' : fmtNum(max)}`;
}

export function fmtPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(
      Number(amount) || 0,
    );
  } catch {
    return `${currency} ${fmtNum(amount)}`;
  }
}

export function planName(plans: Plan[] | null | undefined, id: string): string {
  return plans?.find((p) => p.id === id)?.name || id || '—';
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

/**
 * Mirror of FEATURE_LABELS in server/platform/contract.ts. The client may only import *types* from the
 * contract, so the labels are repeated here; `Record<FeatureKey, string>` makes tsc flag any drift in keys.
 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  aiCopilot: 'AI Copilot & AI tools',
  chat360: 'WhatsApp (Chat360)',
  calls: 'Calls & recordings',
  inventory: 'Inventory',
  unitLocator: 'Unit locator (floor plans)',
  projectLibrary: 'Amaya project library',
  reports: 'Reports & exports',
  segments: 'Client segments',
  websiteApi: 'Website forms & lead API',
  metaLeads: 'Meta (Facebook/Instagram) Lead Ads',
  googleSheets: 'Google Sheets sync',
};
export const FEATURE_KEYS = Object.keys(FEATURE_LABELS) as FeatureKey[];

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function slugError(slug: string): string {
  if (!slug) return 'Enter a slug.';
  if (slug.length < 2) return 'Use at least 2 characters.';
  if (!SLUG_RE.test(slug)) return 'Use 2–40 lowercase letters, digits or hyphens; start and end with a letter or digit.';
  return '';
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Date-time with seconds (en-GB, IST) — for logs. */
export function fmtDateTimeSec(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}
