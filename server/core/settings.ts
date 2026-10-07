/**
 * Settings and secrets — successor of apps-script/20_Settings.gs.
 *
 * - Non-secret settings: `settings` collection ({_id: key, value, updatedAt, updatedBy}).
 * - Secrets (Gemini, Chat360, webhook secrets): an environment variable of the same name always wins;
 *   otherwise they are stored AES-256-GCM encrypted in the `secrets` collection with
 *   SECRETS_ENCRYPTION_KEY. The API only ever returns a masked suffix.
 * - Chat360 base URL and the daily digest e-mail can no longer be pointed anywhere: the URL must be
 *   https on an allowed host and the digest goes only to an existing CRM user's address.
 */
import crypto from 'node:crypto';
import { CFG } from './config';
import { currentTenant, tenantKey } from './tenant';
import { bumpVersion, col } from './db';
import { fail } from './errors';
import { auditLog, can, createUser, Ctx, hasUsers, login, findUserByEmail } from './auth';
import { bool, maskSecret, randomToken, safeJsonParse } from './utils';

type SecretKey = (typeof CFG.SECRETS)[number];

/* -------------------------------- settings ------------------------------ */

/** Per-company settings cache (30 s). */
const settingsCache = new Map<string, { at: number; value: Record<string, string> }>();

export async function settingsAll(): Promise<Record<string, string>> {
  const hit = settingsCache.get(tenantKey());
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  const out: Record<string, string> = { ...CFG.SETTING_DEFAULTS };
  const rows = await (await col<{ _id: string; value: string }>(CFG.COLL.SETTINGS)).find({}).toArray();
  for (const r of rows) if (r._id) out[r._id] = String(r.value ?? '');
  settingsCache.set(tenantKey(), { at: Date.now(), value: out });
  return out;
}

/** Drop cached settings (all companies) — used when the database is reset underneath, e.g. in tests. */
export function clearSettingsCache() {
  settingsCache.clear();
}

export async function settingSet(key: string, value: unknown, actor: string) {
  await (await col<{ _id: string }>(CFG.COLL.SETTINGS)).updateOne(
    { _id: key },
    { $set: { value: value === null || value === undefined ? '' : String(value), updatedAt: new Date(), updatedBy: actor || 'System' } },
    { upsert: true }
  );
  settingsCache.delete(tenantKey());
}

/* --------------------------------- secrets ------------------------------ */

function encryptionKey(): Buffer | null {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (raw) return crypto.createHash('sha256').update(raw).digest();
  if (process.env.NODE_ENV !== 'production') return crypto.createHash('sha256').update('amaya-dev-only-key').digest();
  return null;
}

/** AES-256-GCM with SECRETS_ENCRYPTION_KEY → 'iv.tag.data' (base64). Also used for platform secrets (Google service account). */
export function encryptSecret(plain: string) {
  return encrypt(plain);
}

/** Reverse of encryptSecret; '' when the key is missing/changed or the blob is corrupt. */
export function decryptSecret(blob: string) {
  return decrypt(blob);
}

function encrypt(plain: string) {
  const key = encryptionKey();
  if (!key) throw fail('NOT_CONFIGURED', 'SECRETS_ENCRYPTION_KEY is not set on the server, so keys cannot be stored. Set it, or put the key in the environment instead.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob: string) {
  const key = encryptionKey();
  if (!key) return '';
  try {
    const [iv, tag, data] = blob.split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * A company's own secret. Only GEMINI_API_KEY may fall back to a platform-wide environment key
 * (AI provided by the platform); Chat360 keys and webhook secrets are always per company.
 */
export async function getSecret(key: SecretKey): Promise<string> {
  const doc = await (await col<{ _id: string; value: string }>(CFG.COLL.SECRETS)).findOne({ _id: key });
  const own = doc?.value ? decrypt(doc.value) : '';
  if (own) return own;
  return key === 'GEMINI_API_KEY' ? process.env.GEMINI_API_KEY?.trim() || '' : '';
}

/** In multi-company mode no secret is locked to the environment (each company manages its own). */
const secretFromEnv = (_key: SecretKey) => false;

export async function setSecret(key: string, value: unknown, ctx: Ctx) {
  if (!(CFG.SECRETS as readonly string[]).includes(key)) throw fail('VALIDATION', 'Unknown secret: ' + key);
  if (secretFromEnv(key as SecretKey)) throw fail('VALIDATION', `${key} is set in the server environment and cannot be changed here.`);
  let v = String(value || '').trim();
  if (v === '__generate__') v = randomToken(24);
  const c = await col<{ _id: string }>(CFG.COLL.SECRETS);
  if (v) await c.updateOne({ _id: key }, { $set: { value: encrypt(v), updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } }, { upsert: true });
  else await c.deleteOne({ _id: key });
  await auditLog(ctx, v ? 'Secret Updated' : 'Secret Cleared', 'Settings', key, '');
  await bumpVersion();
  return getSettings(ctx);
}

/* ----------------------------- read settings ---------------------------- */

export function appUrl() {
  return (process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Settings safe for any signed-in user (bootstrap). */
export async function settingsPublic() {
  const s = await settingsAll();
  return {
    appName: s.appName, timeZone: s.timeZone, aiModel: s.aiModel, aiFastModel: s.aiFastModel, aiTranscribeModel: s.aiTranscribeModel,
    aiConfigured: !!(await getSecret('GEMINI_API_KEY')),
    chat360Configured: !!(await getSecret('CHAT360_API_KEY')),
    chat360AutoCreateLeads: bool(s.chat360AutoCreateLeads), chat360DefaultRM: s.chat360DefaultRM,
    features: (() => {
      const own: Record<string, boolean> = { ...(safeJsonParse<Record<string, boolean>>(s.features, {}) || {}), developerMode: false };
      const t = currentTenant();
      if (!t) return own;
      const f = t.features;
      return { ...own, aiCopilot: own.aiCopilot !== false && f.aiCopilot, chat360: own.chat360 !== false && f.chat360, calls: own.calls !== false && f.calls, inventorySync: own.inventorySync !== false && f.inventory, ...f };
    })(),
    company: (() => {
      const t = currentTenant();
      return t ? { id: t.id, slug: t.slug, name: t.name, logo: t.logo, tagline: t.tagline, plan: t.plan, maxUsers: t.maxUsers } : null;
    })(),
    aiPlatformKey: !!process.env.GEMINI_API_KEY?.trim(),
    maxFollowups: Number(s.maxFollowups || CFG.MAX_FOLLOWUPS), version: CFG.VERSION,
    rmLeadVisibility: ['own', 'own_unassigned', 'all'].includes(s.rmLeadVisibility) ? s.rmLeadVisibility : 'own_unassigned',
  };
}

function webhookUrl(source: 'chat360' | 'telephony', secret: string, reveal: boolean) {
  const t = currentTenant();
  const base = `${appUrl()}/api/webhooks/${source}?company=${encodeURIComponent(t?.slug || '')}`;
  if (!secret) return `${base}&secret=<generate a secret first>`;
  return `${base}&secret=${reveal ? encodeURIComponent(secret) : '••••••••' + secret.slice(-4)}`;
}

/** Full settings for the Settings page. Secrets masked; webhook URLs revealed only to secrets.manage. */
export async function getSettings(ctx: Ctx) {
  const s = await settingsAll();
  const canSecrets = !!(ctx && ctx.user && can(ctx.user, 'secrets.manage'));
  const pub = await settingsPublic();
  const chatSecret = await getSecret('CHAT360_WEBHOOK_SECRET');
  const telSecret = await getSecret('TELEPHONY_WEBHOOK_SECRET');
  return {
    ...pub,
    geminiKeyMasked: maskSecret(await getSecret('GEMINI_API_KEY')),
    chat360KeyMasked: maskSecret(await getSecret('CHAT360_API_KEY')),
    chat360BaseUrl: s.chat360BaseUrl, chat360SendPath: s.chat360SendPath, chat360TemplatePath: s.chat360TemplatePath,
    chat360AuthHeader: s.chat360AuthHeader, chat360AuthPrefix: s.chat360AuthPrefix, chat360DefaultSource: s.chat360DefaultSource,
    chat360WebhookUrl: webhookUrl('chat360', chatSecret, canSecrets),
    telephonyWebhookUrl: telSecret ? webhookUrl('telephony', telSecret, canSecrets) + '&provider=<name>' : '',
    chat360WebhookSecretSet: !!chatSecret,
    telephonyWebhookSecretSet: !!telSecret,
    telephonyFieldMap: s.telephonyFieldMap,
    secretsFromEnv: Object.fromEntries(CFG.SECRETS.map((k) => [k, secretFromEnv(k)])),
    driveRootFolderId: '', driveRootFolderUrl: '',
    deploymentId: '', devAutoDeploy: false,
    dailyDigestEmail: s.dailyDigestEmail,
    leadAlerts: (await import('../modules/leadAlerts')).parseLeadAlerts(s.leadAlerts),
    followupSequence: (await import('../modules/sequences')).parseSequence(s.followupSequence),
    visitBooking: (await import('../modules/visits')).parseVisitBooking(s.visitBooking),
    mailConfigured: !!(process.env.SMTP_URL?.trim() && process.env.MAIL_FROM?.trim()),
    scriptId: '', webAppUrl: appUrl(),
    storage: 'MongoDB GridFS',
  };
}

const EDITABLE = ['appName', 'timeZone', 'aiModel', 'aiFastModel', 'aiTranscribeModel', 'chat360BaseUrl', 'chat360SendPath', 'chat360TemplatePath',
  'chat360AuthHeader', 'chat360AuthPrefix', 'chat360AutoCreateLeads', 'chat360DefaultRM', 'chat360DefaultSource', 'telephonyFieldMap',
  'features', 'dailyDigestEmail', 'rmLeadVisibility', 'leadAlerts', 'followupSequence', 'visitBooking'];

/** Hosts the Chat360 base URL may point at — stops an admin from redirecting the stored API key. */
const CHAT360_HOSTS = [/(^|\.)chat360\.io$/i];

export async function updateSettings(patch: any, ctx: Ctx) {
  if (!patch || typeof patch !== 'object') throw fail('VALIDATION', 'Nothing to update');
  const before = await settingsAll();
  const changed: string[] = [];
  for (const k of Object.keys(patch)) {
    if (!EDITABLE.includes(k)) continue;
    let v = patch[k];
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    if (typeof v === 'boolean') v = v ? 'true' : 'false';
    v = v === null || v === undefined ? '' : String(v);
    if (k === 'timeZone' && v) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: v }).format(new Date());
      } catch {
        throw fail('VALIDATION', 'Invalid time zone: ' + v);
      }
    }
    if (k === 'chat360BaseUrl' && v) {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        throw fail('VALIDATION', 'Chat360 base URL is not a valid URL');
      }
      const extra = (process.env.CHAT360_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
      const allowed = CHAT360_HOSTS.some((re) => re.test(u.hostname)) || extra.includes(u.hostname);
      if (u.protocol !== 'https:' || !allowed) throw fail('VALIDATION', `Chat360 base URL must be https on chat360.io (or a host listed in CHAT360_ALLOWED_HOSTS)`);
    }
    if (k === 'dailyDigestEmail' && v) {
      const list = v.split(/[,;\s]+/).filter(Boolean);
      for (const e of list) {
        const u = await findUserByEmail(e);
        if (!u || u.status === 'Disabled') throw fail('VALIDATION', `Digest recipients must be active CRM users (${e} is not)`);
      }
    }
    if (k === 'rmLeadVisibility' && !['own', 'own_unassigned', 'all'].includes(v)) throw fail('VALIDATION', 'Lead visibility must be own, own_unassigned or all');
    if (k === 'visitBooking') v = (await import('../modules/visits')).validateVisitBooking(patch[k]);
    if (k === 'followupSequence') v = (await import('../modules/sequences')).validateSequence(patch[k]);
    if (k === 'leadAlerts') {
      const { validateLeadAlerts } = await import('../modules/leadAlerts'); // lazy: avoids a settings ↔ modules import cycle
      v = await validateLeadAlerts(patch[k]);
    }
    if (k === 'features') {
      const f = safeJsonParse<Record<string, boolean>>(v, {}) || {};
      f.developerMode = false;
      v = JSON.stringify(f);
    }
    if (before[k] !== v) changed.push(k);
    await settingSet(k, v, ctx.user?.name || 'System');
  }
  await auditLog(ctx, 'Settings Updated', 'Settings', '', changed.join(', '), {
    before: Object.fromEntries(changed.map((k) => [k, before[k]])),
    after: Object.fromEntries(changed.map((k) => [k, String(patch[k])])),
  });
  await bumpVersion();
  return getSettings(ctx);
}

/** First run: allowed only while there are no users. Returns a login result. */
export async function createFirstAdmin(d: any, ctx: Ctx) {
  if (!d || !d.email || !d.password || !d.name) throw fail('VALIDATION', 'Name, email and password are required');
  if (process.env.SETUP_TOKEN && d.setupToken !== process.env.SETUP_TOKEN) throw fail('FORBIDDEN', 'Setup token is missing or wrong');
  if (await hasUsers()) throw fail('FORBIDDEN', 'An administrator already exists. Please sign in.');
  // A unique index on emailLower + the hasUsers check make a second concurrent first-run fail.
  await createUser({ name: d.name, email: d.email, password: d.password, role: 'Admin', mustChangePassword: false }, null);
  const users = await (await col(CFG.COLL.USERS)).countDocuments({});
  if (users > 1) throw fail('FORBIDDEN', 'An administrator already exists. Please sign in.');
  return login(d.email, d.password, ctx);
}
