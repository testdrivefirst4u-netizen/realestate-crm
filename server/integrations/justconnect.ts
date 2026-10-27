/**
 * JustConnect API client (https://api.justconnect.biz/api/v1) — the company's cloud telephony.
 *
 * The key (secret JUSTCONNECT_API_KEY, per company, encrypted) is sent as `Authorization: Bearer …` from the server
 * only; it never reaches a browser. Errors come back as { error, details?, code? }; `error` is written to be shown.
 */
import crypto from 'node:crypto';
import { fail } from '../core/errors';
import { getSecret } from '../core/settings';

export const JC_BASE = 'https://api.justconnect.biz/api/v1';
const TIMEOUT_MS = 20000;

export class JustConnectError extends Error {
  constructor(public status: number, message: string, public code = '', public details: unknown = null) {
    super(message);
  }
}

export async function jcKey(): Promise<string> {
  const key = (await getSecret('JUSTCONNECT_API_KEY')).trim();
  if (!key) throw fail('NOT_CONFIGURED', 'JustConnect is not connected yet. A super admin adds the API key under the company’s Settings › WhatsApp, AI & calls.');
  return key;
}

/** One API call; JSON in and out. Throws JustConnectError with JustConnect's own message. */
export async function jc<T = any>(path: string, opts: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const key = opts.key || (await jcKey());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(JC_BASE + path, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new JustConnectError(0, e?.name === 'AbortError' ? 'JustConnect did not answer in time. Try again in a moment.' : 'Could not reach JustConnect. Try again in a moment.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = String(data?.error || '') || (res.status === 401 ? 'The JustConnect API key is wrong, revoked or expired.' : `JustConnect answered HTTP ${res.status}.`);
    throw new JustConnectError(res.status, msg, String(data?.code || ''), data?.details ?? null);
  }
  return data as T;
}

export interface JcAgent {
  id: string;
  name: string;
  role: string;
  extension: string;
  email: string;
  loginId: string;
  status: string;
  canCallOut: boolean;
}

/** The guide's check: HMAC-SHA256 of "<t>.<raw body>", hex, constant-time, at most 5 minutes old. */
export function validJcSignature(rawBody: string, header: string, secret: string, nowSec = Date.now() / 1000): boolean {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((kv) => kv.length === 2)) as Record<string, string>;
  const t = Number(parts.t);
  if (!parts.t || !parts.v1 || !Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts.v1, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
