/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s, 6 digits) for two-step sign-in with an authenticator
 * app (Google Authenticator, Microsoft Authenticator, Authy…). Secrets are base32 (RFC 4648, no padding).
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits). */
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for `secret` at time `nowMs` (step offset in 30 s windows). */
export function totpCode(secret: string, nowMs = Date.now(), step = 0, digits = 6): string {
  const counter = Math.floor(nowMs / 1000 / 30) + step;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** True when `code` matches now or one window either side (phone clocks drift). Constant-time compare. */
export function verifyTotp(secret: string, code: unknown, nowMs = Date.now()): boolean {
  return totpStepOf(secret, code, nowMs) !== null;
}

/** The 30-second step `code` belongs to (now or one either side), or null — kept so a used code cannot be used again. */
export function totpStepOf(secret: string, code: unknown, nowMs = Date.now()): number | null {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  let found: number | null = null;
  for (const step of [-1, 0, 1]) {
    const want = Buffer.from(totpCode(secret, nowMs, step));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) found = Math.floor(nowMs / 1000 / 30) + step;
  }
  return found;
}

/** otpauth:// link an authenticator app understands (tap on a phone, or paste). */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* Secrets at rest: AES-256-GCM with SECRETS_ENCRYPTION_KEY (same key and 'iv.tag.data' format as core/settings). */
function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (raw) return crypto.createHash('sha256').update(raw).digest();
  if (process.env.NODE_ENV !== 'production') return crypto.createHash('sha256').update('amaya-dev-only-key').digest();
  throw new Error('SECRETS_ENCRYPTION_KEY is not set — two-step sign-in cannot be turned on');
}
export function sealTotpSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function openTotpSecret(blob: string | undefined | null): string {
  if (!blob) return '';
  try {
    const [iv, tag, data] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** "ABCD EFGH IJKL …" — easier to type into an app. */
export const groupSecret = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();
