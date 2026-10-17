/**
 * Daily lead backups (per company, inside its own database).
 *
 * createLeadBackup(): every lead document, as EJSON (dates kept exactly), gzip-compressed into one `leadBackups`
 * document { _id: 'yyyy-MM-dd' (IST), createdAt, count, bytes, data }. The daily cron makes one per day; "Back up now"
 * replaces today's. The newest KEEP_DAYS backups are kept.
 * getLeadBackup(id) returns the backed-up leads in the UI shape so the browser can save them as Excel.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { Binary, BSON } from 'mongodb';
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { toUiLead, type LeadDoc, type UiLead } from '../core/leadShape';
import { dateKey } from '../core/utils';

export const COLL_BACKUPS = 'leadBackups';
export const KEEP_DAYS = 14;

interface BackupDoc {
  _id: string;
  createdAt: Date;
  createdBy: string;
  count: number;
  bytes: number;
  data: Binary;
}

const backupsCol = () => col<BackupDoc>(COLL_BACKUPS);

export interface BackupInfo {
  id: string;
  createdAt: string;
  createdBy: string;
  count: number;
  sizeKB: number;
}

const info = (d: Omit<BackupDoc, 'data'>): BackupInfo => ({ id: d._id, createdAt: new Date(d.createdAt).toISOString(), createdBy: d.createdBy, count: d.count, sizeKB: Math.max(1, Math.round(d.bytes / 1024)) });

/** Back up every lead. `onlyIfMissing`: the daily job skips a day that already has a backup. */
export async function createLeadBackup(opts: { by?: string; onlyIfMissing?: boolean; now?: Date } = {}): Promise<BackupInfo | null> {
  const now = opts.now || new Date();
  const id = dateKey(now);
  const c = await backupsCol();
  if (opts.onlyIfMissing && (await c.findOne({ _id: id }, { projection: { _id: 1 } }))) return null;
  const leads = await (await col<LeadDoc>(CFG.COLL.LEADS)).find({}).sort({ _id: 1 }).toArray();
  const zipped = gzipSync(Buffer.from(BSON.EJSON.stringify(leads, { relaxed: false }), 'utf8'));
  const doc: BackupDoc = { _id: id, createdAt: now, createdBy: opts.by || 'Daily backup', count: leads.length, bytes: zipped.length, data: new Binary(zipped) };
  await c.replaceOne({ _id: id }, doc, { upsert: true });
  // keep the newest KEEP_DAYS
  const old = await c.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).skip(KEEP_DAYS).toArray();
  if (old.length) await c.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  return info(doc);
}

export async function listLeadBackups(): Promise<BackupInfo[]> {
  const rows = await (await backupsCol()).find({}, { projection: { data: 0 } }).sort({ _id: -1 }).toArray();
  return rows.map(info);
}

/** The leads of one backup, in the UI shape (for the Excel download). */
export async function getLeadBackup(id: unknown, ctx: Ctx | null): Promise<{ id: string; createdAt: string; leads: UiLead[] }> {
  const key = String(id ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw fail('VALIDATION', 'Choose a backup');
  const d = await (await backupsCol()).findOne({ _id: key });
  if (!d) throw fail('NOT_FOUND', 'Backup not found: ' + key);
  const docs = BSON.EJSON.parse(gunzipSync(Buffer.from(d.data.buffer)).toString('utf8'), { relaxed: false }) as LeadDoc[];
  await auditLog(ctx, 'Backup Downloaded', 'Settings', key, `${d.count} leads`);
  return { id: key, createdAt: new Date(d.createdAt).toISOString(), leads: docs.map((x) => toUiLead(x)).filter((x): x is UiLead => !!x) };
}

export const actions: ActionMap = {
  listLeadBackups: { fn: () => listLeadBackups(), perm: 'settings.edit' },
  getLeadBackup: { fn: (d, ctx) => getLeadBackup(d?.id, ctx), perm: 'settings.edit' },
  createLeadBackup: {
    fn: async (_d, ctx) => {
      const r = await createLeadBackup({ by: ctx?.user?.name || 'Admin' });
      await auditLog(ctx, 'Backup Created', 'Settings', r?.id || '', `${r?.count ?? 0} leads`);
      return r;
    },
    perm: 'settings.edit',
  },
};
