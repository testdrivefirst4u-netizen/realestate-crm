/**
 * Phone notifications (Web Push) — free: they go through Apple's / Google's push services, no WhatsApp or SMS.
 *
 * Each signed-in user can turn notifications on for their devices (My profile › Phone notifications); a device's
 * subscription is stored in the company's `pushSubscriptions` collection. On iPhone this works once the CRM is added
 * to the Home Screen (iOS 16.4+). sendPush() delivers to every device of the given users and forgets devices the push
 * service says are gone (404 / 410).
 *
 * Server keys: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generate once with `npx web-push generate-vapid-keys`) and
 * optionally VAPID_SUBJECT (a mailto: or https: contact). Without them nothing is sent.
 */
import webpush from 'web-push';
import type { ActionMap } from '../core/actions';
import { listUsers, type Ctx, type PublicUser } from '../core/auth';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { logError } from '../core/events';
import { sha256Hex, truncate } from '../core/utils';

export const COLL_PUSH = 'pushSubscriptions';
const MAX_DEVICES = 10;

interface PushSubDoc {
  _id: string; // sha256 of the endpoint
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device: string;
  createdAt: Date;
  lastOkAt?: Date | null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Page to open when the notification is tapped (same site), e.g. /leads?lead=ENQ-0001. */
  url?: string;
  /** Notifications with the same tag replace each other (e.g. one per lead). */
  tag?: string;
}

const subs = () => col<PushSubDoc>(COLL_PUSH);

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

let vapidSet = '';
function ensureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY!.trim();
  const priv = process.env.VAPID_PRIVATE_KEY!.trim();
  const from = process.env.MAIL_FROM?.match(/[^<\s]+@[^>\s]+/)?.[0];
  const subject = process.env.VAPID_SUBJECT?.trim() || (from ? `mailto:${from}` : 'mailto:admin@example.com');
  const key = pub + priv + subject;
  if (vapidSet !== key) {
    webpush.setVapidDetails(subject, pub, priv);
    vapidSet = key;
  }
}

/** A short device name from the browser's user agent, so a user can tell their devices apart. */
export function deviceName(ua: string): string {
  const u = String(ua || '');
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Device';
  const browser = /Edg\//.test(u) ? 'Edge' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /FxiOS|Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

function validSubscription(d: any): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const endpoint = String(d?.endpoint || '');
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw fail('VALIDATION', 'Invalid push subscription');
  }
  if (u.protocol !== 'https:' || endpoint.length > 1000) throw fail('VALIDATION', 'Invalid push subscription');
  const p256dh = String(d?.keys?.p256dh || '');
  const auth = String(d?.keys?.auth || '');
  if (!/^[A-Za-z0-9_-]{20,200}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}={0,2}$/.test(auth)) throw fail('VALIDATION', 'Invalid push subscription keys');
  return { endpoint, keys: { p256dh, auth } };
}

export async function pushStatus(ctx: Ctx): Promise<{ configured: boolean; publicKey: string; devices: Array<{ id: string; device: string; createdAt: string }> }> {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const rows = await (await subs()).find({ userId: ctx.user.id }).sort({ createdAt: -1 }).toArray();
  return {
    configured: pushConfigured(),
    publicKey: process.env.VAPID_PUBLIC_KEY?.trim() || '',
    devices: rows.map((r) => ({ id: r._id, device: r.device, createdAt: new Date(r.createdAt).toISOString() })),
  };
}

/** Save this device's subscription for the signed-in user (a device moving to another user is taken over). */
export async function pushSubscribe(d: any, ctx: Ctx) {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  if (!pushConfigured()) throw fail('NOT_CONFIGURED', 'Phone notifications are not set up on the server yet (VAPID keys). Ask your platform administrator.');
  const sub = validSubscription(d?.subscription);
  const c = await subs();
  const id = sha256Hex(sub.endpoint);
  await c.updateOne(
    { _id: id },
    { $set: { userId: ctx.user.id, endpoint: sub.endpoint, keys: sub.keys, device: deviceName(ctx.userAgent) }, $setOnInsert: { createdAt: new Date(), lastOkAt: null } },
    { upsert: true },
  );
  // keep the newest MAX_DEVICES per user
  const old = await c.find({ userId: ctx.user.id }, { projection: { _id: 1 } }).sort({ createdAt: -1 }).skip(MAX_DEVICES).toArray();
  if (old.length) await c.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  return pushStatus(ctx);
}

/** Forget a device: this one (by endpoint) or one from the list (by id). */
export async function pushUnsubscribe(d: any, ctx: Ctx) {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const id = d?.endpoint ? sha256Hex(String(d.endpoint)) : String(d?.id || '');
  if (id) await (await subs()).deleteOne({ _id: id, userId: ctx.user.id });
  return pushStatus(ctx);
}

/** Deliver to every device of these users. Never throws; returns how many devices got it. */
export async function sendPush(userIds: string[], payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const out = { sent: 0, removed: 0, failed: 0 };
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length || !pushConfigured()) return out;
  try {
    ensureVapid();
    const c = await subs();
    const rows = await c.find({ userId: { $in: ids } }).toArray();
    const body = JSON.stringify({ title: truncate(payload.title, 120), body: truncate(payload.body, 300), url: payload.url || '/', tag: payload.tag || '' });
    await Promise.all(
      rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: r.keys }, body, { TTL: 6 * 3600, urgency: 'high' });
          out.sent++;
          await c.updateOne({ _id: r._id }, { $set: { lastOkAt: new Date() } });
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await c.deleteOne({ _id: r._id }); // the device unsubscribed or the app was removed
            out.removed++;
          } else {
            out.failed++;
            await logError('push.send', 'SERVER', truncate(`${e?.statusCode || ''} ${e?.body || e?.message || e}`, 300), undefined, '', { userId: r.userId });
          }
        }
      }),
    );
  } catch (e: any) {
    await logError('push', 'INTERNAL', e?.message, e?.stack);
  }
  return out;
}

/** Active users matched by display name (how leads store their RM) → ids. */
export function idsByName(names: string[], users: PublicUser[]): string[] {
  const want = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return users.filter((u) => u.status !== 'Disabled' && want.has(u.name.trim().toLowerCase())).map((u) => u.id);
}

/** Active users matched by e-mail → ids. */
export function idsByEmail(emails: string[], users: PublicUser[]): string[] {
  const want = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  return users.filter((u) => u.status !== 'Disabled' && want.has(u.email.toLowerCase())).map((u) => u.id);
}

export async function pushTest(ctx: Ctx) {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  if (!pushConfigured()) throw fail('NOT_CONFIGURED', 'Phone notifications are not set up on the server yet (VAPID keys).');
  const r = await sendPush([ctx.user.id], { title: 'Notifications are working', body: 'New leads assigned to you will show up here.', url: '/dashboard', tag: 'test' });
  if (!r.sent) throw fail('VALIDATION', r.removed ? 'This device was no longer subscribed — turn notifications on again.' : 'No device is subscribed yet — turn notifications on first.');
  return r;
}

export const actions: ActionMap = {
  pushStatus: { fn: (_d, ctx) => pushStatus(ctx) },
  pushSubscribe: { fn: (d, ctx) => pushSubscribe(d, ctx) },
  pushUnsubscribe: { fn: (d, ctx) => pushUnsubscribe(d, ctx) },
  pushTest: { fn: (_d, ctx) => pushTest(ctx) },
};

