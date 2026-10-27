/**
 * YTD / MTD downloads: the Enquiry Performance report as a picture (PNG, drawn on a canvas in the browser — the same
 * blocks and colours as the screen, ready for WhatsApp or a slide) and as an Excel sheet with the same numbers.
 */
import { downloadXlsx } from '../../core/xlsx';

export interface PerfReport {
  company: string;
  /** e.g. "27 Oct 2026" */
  date: string;
  /** e.g. "All representatives · All sources" */
  filters: string;
  blocks: Array<{ title: string; sub: string; tiles: Array<{ label: string; value: number; color: string }> }>;
}

const two = (n: number) => String(n).padStart(2, '0');
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** One row per number: section, period, metric, count. */
export function perfRows(r: PerfReport): unknown[][] {
  const rows: unknown[][] = [];
  for (const b of r.blocks) for (const t of b.tiles) rows.push([b.title, b.sub, t.label, t.value]);
  return rows;
}

export function downloadPerfExcel(r: PerfReport): void {
  downloadXlsx(`Enquiry_Performance_${slug(r.date)}.xlsx`, ['Section', 'Period', 'Metric', 'Count'], [
    ['Report', `${r.company} · report date ${r.date}`, 'Filters', r.filters],
    ...perfRows(r),
  ], 'YTD MTD');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = 'Figtree, "Segoe UI", system-ui, sans-serif';

/** Draw the report (2× for a sharp picture) and return it as a PNG. */
export async function renderPerfPng(r: PerfReport): Promise<Blob> {
  try {
    await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  } catch {
    /* fall back to system fonts */
  }
  const W = 1400, P = 32, HEAD = 92, SUB = 44, BAND = 58, VAL = 92, LBL = 36, GAP = 18, FOOT = 40;
  const H = P + HEAD + SUB + GAP + r.blocks.length * (BAND + VAL + LBL + GAP) + FOOT + P - GAP;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw pictures');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#F2F7FB';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  // header
  let y = P;
  const inner = W - 2 * P;
  roundRect(ctx, P, y, inner, HEAD + SUB, 16);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.save();
  roundRect(ctx, P, y, inner, HEAD + SUB, 16);
  ctx.clip();
  const g = ctx.createLinearGradient(P, 0, P + inner, 0);
  g.addColorStop(0, '#0A1F33');
  g.addColorStop(0.5, '#0B2A44');
  g.addColorStop(1, '#0B4A7A');
  ctx.fillStyle = g;
  ctx.fillRect(P, y, inner, HEAD);
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8FB1CE';
  ctx.font = `700 13px ${FONT}`;
  ctx.fillText(r.company.toUpperCase(), W / 2, y + 28);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 28px ${FONT}`;
  ctx.fillText('Enquiry Performance Dashboard', W / 2, y + 60);
  ctx.fillStyle = '#0B2A44';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText(`Report date: ${r.date}  ·  ${r.filters}`, W / 2, y + HEAD + SUB / 2);
  ctx.strokeStyle = '#0A1F33';
  ctx.lineWidth = 1.5;
  roundRect(ctx, P, y, inner, HEAD + SUB, 16);
  ctx.stroke();
  y += HEAD + SUB + GAP;

  // blocks
  for (const b of r.blocks) {
    const bh = BAND + VAL + LBL;
    ctx.save();
    roundRect(ctx, P, y, inner, bh, 14);
    ctx.clip();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(P, y, inner, bh);
    ctx.fillStyle = '#E6EFF6';
    ctx.fillRect(P, y, inner, BAND);
    ctx.fillStyle = '#F5F9FC';
    ctx.fillRect(P, y + BAND + VAL, inner, LBL);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0B2A44';
    ctx.font = `800 16px ${FONT}`;
    ctx.fillText(b.title.toUpperCase(), W / 2, y + 22);
    ctx.fillStyle = '#5E778C';
    ctx.font = `500 12.5px ${FONT}`;
    ctx.fillText(b.sub, W / 2, y + 42);
    const tw = inner / b.tiles.length;
    b.tiles.forEach((t, i) => {
      const cx = P + tw * i + tw / 2;
      ctx.fillStyle = t.color;
      ctx.font = `800 44px ${FONT}`;
      ctx.fillText(two(t.value), cx, y + BAND + VAL / 2 + 2);
      ctx.fillStyle = '#2B4A63';
      ctx.font = `600 14px ${FONT}`;
      ctx.fillText(t.label, cx, y + BAND + VAL + LBL / 2);
      if (i) {
        ctx.strokeStyle = '#E6EFF6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(P + tw * i, y + BAND);
        ctx.lineTo(P + tw * i, y + bh);
        ctx.stroke();
      }
    });
    ctx.strokeStyle = '#D3E3F0';
    ctx.lineWidth = 1;
    roundRect(ctx, P, y, inner, bh, 14);
    ctx.stroke();
    y += bh + GAP;
  }

  // footer
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7E93A6';
  ctx.font = `500 12px ${FONT}`;
  const made = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  ctx.fillText(`Qualified, unqualified, non-responding and open add up to leads received.  ·  Made ${made}`, P, y + FOOT / 2 - GAP / 2);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture'))), 'image/png'));
}

export async function downloadPerfPng(r: PerfReport): Promise<void> {
  const blob = await renderPerfPng(r);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Enquiry_Performance_${slug(r.date)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
