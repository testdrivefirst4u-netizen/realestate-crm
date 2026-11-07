/** The WhatsApp profile customers see, for a company connected directly: photo, about, description, contact details, and asking Meta for a new name. */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { bumpVersion } from '../core/db';
import { fail } from '../core/errors';
import { decryptSecret } from '../core/settings';
import { str, truncate } from '../core/utils';
import { WhatsappApiError, call, connection, connectionCollection, refused, uploadSample } from './whatsappDirect';

export const PROFILE_LIMITS = { about: 139, address: 256, description: 512, email: 128, website: 256, websites: 2, name: 75 };
/** Meta's own list. It has no real estate category. */
export const VERTICALS = ['', 'ALCOHOL', 'APPAREL', 'AUTO', 'BEAUTY', 'EDU', 'ENTERTAIN', 'EVENT_PLAN', 'FINANCE', 'GOVT', 'GROCERY', 'HEALTH', 'HOTEL', 'NONPROFIT', 'ONLINE_GAMBLING', 'OTC_DRUGS', 'OTHER', 'PHYSICAL_GAMBLING', 'PROF_SERVICES', 'RESTAURANT', 'RETAIL', 'TRAVEL'];
const PHOTO_MAX = 3 * 1024 * 1024;
const PROFILE_READ = 'about,address,description,email,profile_picture_url,websites,vertical';

export interface ProfileFields { about: string; address: string; description: string; email: string; websites: string[]; vertical: string }
const FIELD_NAMES: Array<keyof ProfileFields> = ['about', 'address', 'description', 'email', 'websites', 'vertical'];

/** What Meta holds, in one shape. */
export function readProfile(raw: any): ProfileFields & { picture: string } {
  const p = (Array.isArray(raw?.data) ? raw.data[0] : raw) || {};
  const picture = str(p.profile_picture_url);
  return {
    about: str(p.about), address: str(p.address), description: String(p.description ?? '').trim(), email: str(p.email),
    websites: (Array.isArray(p.websites) ? p.websites : []).map((w: unknown) => str(w)).filter(Boolean),
    vertical: str(p.vertical) === 'UNDEFINED' ? '' : str(p.vertical),
    picture: /^https:\/\//i.test(picture) ? picture : '',
  };
}

const fieldsOf = (p: ProfileFields): ProfileFields => ({ about: p.about, address: p.address, description: p.description, email: p.email, websites: p.websites, vertical: p.vertical });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Tidies what was typed, and says what is wrong with it in the person's terms. A website without https:// gets it. */
export function cleanProfile(d: any): { fields: ProfileFields; problem: string } {
  const websites = (Array.isArray(d?.websites) ? d.websites : []).map((w: unknown) => str(w)).filter(Boolean).map((w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`));
  const fields: ProfileFields = { about: str(d?.about), address: str(d?.address), description: String(d?.description ?? '').trim(), email: str(d?.email), websites, vertical: str(d?.vertical).toUpperCase() };
  const problem = (() => {
    if (fields.about.length > PROFILE_LIMITS.about) return `The about line can be up to ${PROFILE_LIMITS.about} characters.`;
    if (fields.address.length > PROFILE_LIMITS.address) return `The address can be up to ${PROFILE_LIMITS.address} characters.`;
    if (fields.description.length > PROFILE_LIMITS.description) return `The description can be up to ${PROFILE_LIMITS.description} characters.`;
    if (fields.email.length > PROFILE_LIMITS.email) return `The e-mail can be up to ${PROFILE_LIMITS.email} characters.`;
    if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return 'That e-mail address does not look right.';
    if (websites.length > PROFILE_LIMITS.websites) return `WhatsApp shows up to ${PROFILE_LIMITS.websites} websites.`;
    for (const w of websites) {
      if (w.length > PROFILE_LIMITS.website) return `A website can be up to ${PROFILE_LIMITS.website} characters.`;
      try {
        if (!new URL(w).hostname.includes('.')) return `“${truncate(w, 60)}” does not look like a website.`;
      } catch {
        return `“${truncate(w, 60)}” does not look like a website.`;
      }
    }
    if (!VERTICALS.includes(fields.vertical)) return 'Choose a business category from the list.';
    return '';
  })();
  return { fields, problem };
}

/** Only what changed goes to Meta, so anything else stays as it is there. */
export function changedFields(cur: ProfileFields, next: ProfileFields): Partial<ProfileFields> {
  const out: Partial<ProfileFields> = {};
  for (const k of FIELD_NAMES) if (!same(cur[k], next[k])) (out as any)[k] = next[k];
  return out;
}

export function nameProblem(name: string, current: string): string {
  if (name.length < 3) return 'The name needs at least 3 characters.';
  if (name.length > PROFILE_LIMITS.name) return `The name can be up to ${PROFILE_LIMITS.name} characters.`;
  if (name.toLowerCase() === current.toLowerCase()) return 'That is already the name on WhatsApp.';
  return '';
}

const APPROVED = new Set(['APPROVED', 'AVAILABLE_WITHOUT_REVIEW']);

async function need() {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  return { c, token: decryptSecret(c.token) };
}

/** The name fields are partly in beta at Meta, so a refusal for those falls back to the plain name rather than losing the page. */
async function readName(id: string, token: string, stored: string) {
  let r: any = {};
  try {
    r = await call(id, token, { params: { fields: 'verified_name,name_status,new_display_name,new_name_status' } });
  } catch {
    try {
      r = await call(id, token, { params: { fields: 'verified_name' } });
    } catch {
      r = {};
    }
  }
  const current = str(r.verified_name) || stored;
  const asked = str(r.new_display_name);
  const pending = asked && asked !== current ? asked : '';
  const pendingStatus = pending ? str(r.new_name_status).toUpperCase() : '';
  return { current, status: str(r.name_status).toUpperCase(), pending, pendingStatus, finish: !!pending && APPROVED.has(pendingStatus) };
}

export async function getProfile() {
  const { c, token } = await need();
  let raw: any;
  try {
    raw = await call(`${c.phoneNumberId}/whatsapp_business_profile`, token, { params: { fields: PROFILE_READ } });
  } catch (e) {
    throw refused(e, 'Meta did not show this profile');
  }
  const name = await readName(c.phoneNumberId, token, c.verifiedName);
  if (name.current !== c.verifiedName) await (await connectionCollection()).updateOne({ _id: c._id }, { $set: { verifiedName: name.current } });
  const coexistence = c.mode === 'coexistence';
  return { profile: readProfile(raw), name: { ...name, canChange: !coexistence, pinSaved: !!c.pin }, displayPhone: c.displayPhone };
}

export async function saveProfile(d: any, ctx: Ctx) {
  const { c, token } = await need();
  const { fields, problem } = cleanProfile(d);
  if (problem) throw fail('VALIDATION', problem);
  let cur: ProfileFields;
  try {
    cur = fieldsOf(readProfile(await call(`${c.phoneNumberId}/whatsapp_business_profile`, token, { params: { fields: PROFILE_READ } })));
  } catch (e) {
    throw refused(e, 'Meta did not show this profile');
  }
  // someone changed it in WhatsApp Manager while this was open: never write over that unseen
  if (d?.base && !same(fieldsOf(readProfile(d.base)), cur)) throw fail('CONFLICT', 'This profile was changed outside the CRM after you opened it. Reload to see the latest, then make your changes again.');
  const changed = changedFields(cur, fields);
  if (changed.about === '') throw fail('VALIDATION', 'WhatsApp does not allow an empty about line. Write something short, or put the old one back.');
  const photo = d?.photo;
  if (photo) {
    if (!/^image\/(jpeg|png)$/.test(str(photo.mime).toLowerCase())) throw fail('VALIDATION', 'Use a JPG or PNG picture.');
    if (Buffer.byteLength(str(photo.base64), 'base64') > PHOTO_MAX) throw fail('VALIDATION', 'The picture is larger than 3 MB. Make it smaller first.');
  }
  const names = Object.keys(changed);
  if (!names.length && !photo) return getProfile();
  try {
    const handle = photo ? await uploadSample(photo, 'image', token) : '';
    await call(`${c.phoneNumberId}/whatsapp_business_profile`, token, { method: 'POST', asciiBody: true, body: { messaging_product: 'whatsapp', ...changed, ...(handle ? { profile_picture_handle: handle } : {}) } });
  } catch (e) {
    throw refused(e, 'Meta did not accept this');
  }
  await auditLog(ctx, 'WhatsApp Profile Updated', 'Settings', c.displayPhone, [...names, ...(photo ? ['photo'] : [])].join(', '));
  return getProfile();
}

export async function requestName(d: any, ctx: Ctx) {
  const { c, token } = await need();
  if (c.mode === 'coexistence') throw fail('VALIDATION', 'This number is also on the WhatsApp Business app, so its name is changed in the app on the phone.');
  const name = str(d?.name);
  const problem = nameProblem(name, c.verifiedName);
  if (problem) throw fail('VALIDATION', problem);
  try {
    await call(c.phoneNumberId, token, { method: 'POST', params: { new_display_name: name } });
  } catch (e) {
    throw refused(e, 'Meta did not accept this name');
  }
  await auditLog(ctx, 'WhatsApp Name Requested', 'Settings', c.displayPhone, name);
  return getProfile();
}

/** Meta's last step: an approved name only takes effect once the number is registered again, within 14 days, with its PIN. */
export async function finishName(d: any, ctx: Ctx) {
  const { c, token } = await need();
  const name = await readName(c.phoneNumberId, token, c.verifiedName);
  if (!name.finish) throw fail('VALIDATION', 'Meta has not approved a new name for this number yet.');
  const pin = str(d?.pin) || (c.pin ? decryptSecret(c.pin) : '');
  if (!/^\d{6}$/.test(pin)) throw fail('VALIDATION', "Enter this number's 6-digit two-step PIN.");
  try {
    await call(`${c.phoneNumberId}/register`, token, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });
  } catch (e) {
    if (e instanceof WhatsappApiError && e.metaCode === 133005) throw fail('VALIDATION', "That is not this number's two-step PIN. If it is lost, it can be reset in WhatsApp Manager.");
    throw refused(e, 'Meta did not finish this');
  }
  await auditLog(ctx, 'WhatsApp Name Changed', 'Settings', c.displayPhone, name.pending);
  await bumpVersion();
  return getProfile();
}

export const actions: ActionMap = {
  waDirectProfileGet: { fn: () => getProfile(), perm: 'integrations.connect' },
  waDirectProfileSave: { fn: (d, ctx) => saveProfile(d, ctx), perm: 'integrations.connect' },
  waDirectNameRequest: { fn: (d, ctx) => requestName(d, ctx), perm: 'integrations.connect' },
  waDirectNameFinish: { fn: (d, ctx) => finishName(d, ctx), perm: 'integrations.connect' },
};
