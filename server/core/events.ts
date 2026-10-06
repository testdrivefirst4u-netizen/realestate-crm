/**
 * Events (notification feed), lead timeline and error log —
 * successors of apps-script/14_Events.gs, 15_Timeline.gs and Errors_* in 04_Router.gs.
 *
 * Events keep their stable, monotonically increasing ids (EVT-000123) so the browser's
 * de-duplication of notifications works exactly as before.
 */
import { CFG } from './config';
import { col, nextCounter } from './db';
import { shortId, str, toIso, truncate, safeJsonParse } from './utils';

/* -------------------------------- events -------------------------------- */

const padEvt = (n: number) => 'EVT-' + String(n).padStart(6, '0');

export async function addEvent(type: string, recordType: string, recordId: string, title: string, message?: string, actor?: string, payload?: unknown) {
  try {
    const n = await nextCounter('events');
    const id = padEvt(n);
    await (await col(CFG.COLL.EVENTS)).insertOne({
      _id: id as any,
      seq: n,
      key: `${type}:${recordId || '-'}:${id}`,
      type,
      recordType: recordType || '',
      recordId: recordId || '',
      title: truncate(title, 200),
      message: truncate(message || '', 500),
      createdAt: new Date(),
      actor: actor || 'System',
      payload: payload === undefined ? null : payload,
    });
    return id;
  } catch (e: any) {
    await logError('events.add', 'INTERNAL', e?.message, e?.stack, '', { type, recordId });
    return '';
  }
}

function serializeEvent(r: any) {
  return {
    id: str(r._id), key: str(r.key), type: str(r.type), recordType: str(r.recordType), recordId: str(r.recordId),
    title: str(r.title), message: str(r.message), createdAt: toIso(r.createdAt), actor: str(r.actor),
    payload: typeof r.payload === 'string' ? safeJsonParse(r.payload, null) : r.payload ?? null,
  };
}

export async function lastEventId() {
  const c = await (await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS)).findOne({ _id: 'events' });
  return c?.seq ? padEvt(c.seq) : '';
}

/** Events strictly after `sinceId` (max 100). Without sinceId → last 20. */
export async function eventsSince(sinceId?: string) {
  const events = await col(CFG.COLL.EVENTS);
  const sinceNum = sinceId ? parseInt(String(sinceId).replace(/\D/g, ''), 10) || 0 : 0;
  const rows = sinceId
    ? await events.find({ seq: { $gt: sinceNum } }).sort({ seq: 1 }).limit(100).toArray()
    : (await events.find({}).sort({ seq: -1 }).limit(20).toArray()).reverse();
  return { events: rows.map(serializeEvent), lastEventId: await lastEventId() };
}

export async function trimEvents() {
  const events = await col(CFG.COLL.EVENTS);
  const cutoff = await events.find({}).sort({ seq: -1 }).skip(CFG.EVENTS_KEEP).limit(1).next();
  if (cutoff) await events.deleteMany({ seq: { $lte: (cutoff as any).seq } });
}

/* ------------------------------- timeline ------------------------------- */

export async function addTimeline(leadId: string, type: string, title: string, details?: string, actor?: string, refType?: string, refId?: string) {
  if (!leadId) return '';
  try {
    const id = shortId('TL');
    await (await col(CFG.COLL.TIMELINE)).insertOne({
      _id: id as any,
      leadId: String(leadId),
      timestamp: new Date(),
      type,
      title: truncate(title, 200),
      details: truncate(details || '', 1000),
      actor: actor || 'System',
      refType: refType || '',
      refId: refId || '',
    });
    return id;
  } catch (e: any) {
    await logError('timeline.add', 'INTERNAL', e?.message, e?.stack, '', { leadId, type });
    return '';
  }
}

export function serializeTimeline(r: any) {
  return {
    id: str(r._id), leadId: str(r.leadId), timestamp: toIso(r.timestamp), type: str(r.type), title: str(r.title),
    details: str(r.details), actor: str(r.actor), refType: str(r.refType), refId: str(r.refId),
  };
}

/* ------------------------------- error log ------------------------------ */

export function scrub(s: unknown) {
  return String(s || '').replace(/(api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?[^"',\s]+/gi, '$1: [redacted]');
}

export async function logError(scope: string, code: string, message?: string, stack?: string, user?: string, context?: unknown) {
  try {
    const c = await col(CFG.COLL.ERROR_LOG);
    await c.insertOne({
      timestamp: new Date(),
      scope: truncate(scope, 80),
      code: truncate(code, 40),
      message: truncate(scrub(message), 1000),
      stack: truncate(scrub(stack), 1500),
      user: truncate(user || '', 120),
      context: truncate(scrub(typeof context === 'string' ? context : JSON.stringify(context || {})), 1500),
    });
  } catch (e) {
    console.error('[errors] log failed', e);
  }
}

export async function listErrors(limit = 100) {
  const rows = await (await col(CFG.COLL.ERROR_LOG)).find({}).sort({ timestamp: -1 }).limit(Math.min(Number(limit) || 100, 1000)).toArray();
  return rows.map((r: any) => ({
    timestamp: toIso(r.timestamp), scope: str(r.scope), code: str(r.code), message: str(r.message),
    stack: str(r.stack), user: str(r.user), context: str(r.context),
  }));
}

export async function trimErrors() {
  const c = await col(CFG.COLL.ERROR_LOG);
  const cutoff = await c.find({}).sort({ timestamp: -1 }).skip(CFG.ERROR_LOG_KEEP).limit(1).next();
  if (cutoff) await c.deleteMany({ timestamp: { $lte: (cutoff as any).timestamp } });
}
