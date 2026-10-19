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
  /** Restore test: the backup was unpacked and every lead read back. */
  verifiedAt?: Date;
  verifyOk?: boolean;
  verifyNote?: string;
}

const backupsCol = () => col<BackupDoc>(COLL_BACKUPS);

export interface BackupInfo {
  id: string;
  createdAt: string;
  createdBy: string;
  count: number;
  sizeKB: number;
  /** Restore test result: 'ok', 'failed' or '' (not tested yet). */
  verified: '' | 'ok' | 'failed';
  verifyNote: string;
}

const info = (d: Omit<BackupDoc, 'data'>): BackupInfo => ({
  id: d._id, createdAt: new Date(d.createdAt).toISOString(), createdBy: d.createdBy, count: d.count, sizeKB: Math.max(1, Math.round(d.bytes / 1024)),
  verified: d.verifiedAt ? (d.verifyOk ? 'ok' : 'failed') : '', verifyNote: d.verifyNote || '',
});

/**
 * Restore test of the newest backup: unpack it, read every lead back and check it is complete (same count, every lead
 * has its id, no id twice, dates still dates, and not far fewer leads than the CRM has now). The result is stored on
 * the backup; a failure alerts the administrators.
 */
export async function verifyLatestBackup(): Promise<{ id: string; ok: boolean; note: string } | null> {
  const c = await backupsCol();
  const d = await c.find({}).sort({ _id: -1 }).limit(1).next();
  if (!d) return null;
  let ok = false, note = '';
  try {
    const docs = BSON.EJSON.parse(gunzipSync(Buffer.from(d.data.buffer)).toString('utf8'), { relaxed: false }) as LeadDoc[];
    const ids = new Set(docs.map((x) => x?._id).filter(Boolean));
    const live = await (await col(CFG.COLL.LEADS)).countDocuments({});
    if (docs.length !== d.count) note = `Backup says ${d.count} leads but holds ${docs.length}`;
    else if (ids.size !== docs.length) note = 'Some leads are missing their id or appear twice';
    else if (docs.some((x) => x.createdAt != null && !(x.createdAt instanceof Date))) note = 'Dates did not come back as dates';
    else if (live > 20 && docs.length < live * 0.8) note = `Only ${docs.length} leads backed up but the CRM has ${live}`;
    else { ok = true; note = `All ${docs.length} leads read back`; }
  } catch (e: any) {
    note = 'Could not unpack the backup: ' + (e?.message || e);
  }
  await c.updateOne({ _id: d._id }, { $set: { verifiedAt: new Date(), verifyOk: ok, verifyNote: note.slice(0, 300) } });
  if (!ok) {
    const { notifyAdmins } = await import('./adminAlerts');
    await notifyAdmins('backup-verify', 'Lead backup failed its restore test', `The backup of ${d._id} could not be read back: ${note}. Open Settings › Backups and click Back up now.`);
  }
  return { id: d._id, ok, note };
}

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
  verifyLeadBackup: { fn: () => verifyLatestBackup(), perm: 'settings.edit' },
  createLeadBackup: {
    fn: async (_d, ctx) => {
      const r = await createLeadBackup({ by: ctx?.user?.name || 'Admin' });
      await auditLog(ctx, 'Backup Created', 'Settings', r?.id || '', `${r?.count ?? 0} leads`);
      return r;
    },
    perm: 'settings.edit',
  },
};
