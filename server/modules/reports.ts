/**
 * Report snapshots — port of apps-script/22_Reports.gs. Snapshots are stored in MongoDB and downloadable
 * as CSV from `/api/reports/<id>` instead of a monthly Drive spreadsheet.
 *
 * Stored document (CFG.COLL.REPORTS): { _id: 'RPT_…', title, range, headers: string[], rows: unknown[][],
 * generatedAt: Date, generatedBy }. Rows are kept as arrays aligned with `headers` so arbitrary column
 * names (dots, '$' …) never become MongoDB field names.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { isDate, shortId, str, truncate } from '../core/utils';

export const REPORT_MAX_ROWS = 50000;

export interface ReportSnapshotDoc {
  _id: string;
  title: string;
  range: string;
  headers: string[];
  rows: Array<Array<string | number | boolean>>;
  generatedAt: Date;
  generatedBy: string;
}

function cell(v: unknown): string | number | boolean {
  if (v === undefined || v === null) return '';
  if (isDate(v)) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function saveReportSnapshot(d: { title: string; range: string; rows: Array<Record<string, any>> }, ctx: Ctx): Promise<{ url: string }> {
  if (!d || !Array.isArray(d.rows) || !d.rows.length) throw fail('VALIDATION', 'rows[] is required');
  if (d.rows.length > REPORT_MAX_ROWS) throw fail('VALIDATION', `A report snapshot can hold at most ${REPORT_MAX_ROWS.toLocaleString('en-IN')} rows`);
  const title = truncate(str(d.title) || 'CRM Report', 200);
  const range = truncate(str(d.range), 200);

  // union of the columns, in first-seen order (GAS used the first row's keys)
  const seen = new Set<string>();
  for (const r of d.rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw fail('VALIDATION', 'Each row must be an object');
    for (const k of Object.keys(r)) seen.add(k);
  }
  const headers = [...seen];
  if (!headers.length) throw fail('VALIDATION', 'rows[] has no columns');
  const rows = d.rows.map((r) => headers.map((h) => cell(r[h])));

  const id = shortId('RPT');
  const doc: ReportSnapshotDoc = { _id: id, title, range, headers, rows, generatedAt: new Date(), generatedBy: ctx?.user?.name || 'System' };
  await (await col<ReportSnapshotDoc>(CFG.COLL.REPORTS)).insertOne(doc);
  await auditLog(ctx, 'Report Exported', 'System', id, title + ' (' + range + ')');
  const out = { url: `/api/reports/${id}`, id };
  return out;
}

export async function getReportSnapshot(id: string): Promise<ReportSnapshotDoc | null> {
  const key = str(id);
  if (!/^RPT_[A-Za-z0-9_]{1,40}$/.test(key)) return null;
  return (await col<ReportSnapshotDoc>(CFG.COLL.REPORTS)).findOne({ _id: key });
}

export const actions: ActionMap = {
  saveReportSnapshot: { fn: (d, ctx) => saveReportSnapshot(d, ctx), perm: 'reports.export' },
};
