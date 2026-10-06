/**
 * Super-admin side of Meta Lead Ads (PlatformMetaActions, server/core/metaTypes.ts): the platform Meta app
 * (PCOLL.PLATFORM_SETTINGS {_id:'meta'}; the app secret and verify token are stored AES-GCM encrypted and the
 * app secret is never returned), a company's connected Pages, connecting a Page on a company's behalf with a
 * Page access token, and re-queuing failed webhook leads.
 */
import { fail } from '../core/errors';
import { encryptSecret } from '../core/settings';
import { runWithTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import type { PlatformMetaActions } from '../core/metaTypes';
import { checkAppToken, DEFAULT_GRAPH_VERSION, getPage, listForms, loadMetaConfig, metaSettingsCol, requireMetaConfig } from '../integrations/meta';
import { sourcesCol } from '../modules/intake';
import { defaultConfig, toSource } from '../modules/leadSources';
import { connectPage, errMsg, statusOf, validFormIds } from '../modules/meta';
import { queueCol, queueCounts } from '../modules/metaQueue';
import { actorLabel, platformAudit, type SaCtx } from './base';
import { companyActor, findCompany } from './companies';
import { toTenant } from './registry';

type Req<K extends keyof PlatformMetaActions> = PlatformMetaActions[K]['req'];
type Res<K extends keyof PlatformMetaActions> = PlatformMetaActions[K]['res'];

export async function getMetaSettings(): Promise<Res<'getMetaSettings'>> {
  const [cfg, doc, queue] = await Promise.all([loadMetaConfig(), (await metaSettingsCol()).findOne({ _id: 'meta' }), queueCounts()]);
  return {
    ...statusOf(cfg),
    verifyToken: cfg.verifyToken,
    loginConfigId: cfg.loginConfigId,
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : '',
    updatedBy: doc?.updatedBy || '',
    queue,
  };
}

const NO_SPACE = /^\S+$/;

export async function setMetaSettings(d: Req<'setMetaSettings'>, ctx: SaCtx): Promise<Res<'setMetaSettings'>> {
  const c = await metaSettingsCol();
  const cur = await c.findOne({ _id: 'meta' });
  const appId = String(d?.appId ?? '').trim();
  if (!appId) {
    // empty app id: remove the stored app (env values, if any, apply again)
    await c.deleteOne({ _id: 'meta' });
    await platformAudit(ctx, 'Meta App Removed', '', '');
    return getMetaSettings();
  }
  if (!/^\d{5,25}$/.test(appId)) throw fail('VALIDATION', 'The App ID is a number (Meta for Developers › App settings › Basic)');

  const secretIn = d?.appSecret === undefined || d?.appSecret === null ? '' : String(d.appSecret).trim();
  if (secretIn && (secretIn.length < 16 || secretIn.length > 128 || !NO_SPACE.test(secretIn))) throw fail('VALIDATION', 'The App Secret looks wrong (copy it from App settings › Basic)');
  const appSecret = secretIn ? encryptSecret(secretIn) : cur?.appSecret || '';

  const verifyIn = d?.verifyToken === undefined || d?.verifyToken === null ? '' : String(d.verifyToken).trim();
  let verifyPlain = '';
  if (verifyIn === '__generate__' || (!verifyIn && !cur?.verifyToken)) verifyPlain = randomToken(16);
  else if (verifyIn) {
    if (verifyIn.length < 8 || verifyIn.length > 128 || !NO_SPACE.test(verifyIn)) throw fail('VALIDATION', 'The verify token must be 8–128 characters without spaces');
    verifyPlain = verifyIn;
  }
  const verifyToken = verifyPlain ? encryptSecret(verifyPlain) : cur!.verifyToken;

  const graphVersion = String(d?.graphVersion ?? '').trim() || cur?.graphVersion || DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw fail('VALIDATION', 'Graph API version must look like v23.0');
  const loginConfigId = d?.loginConfigId === undefined ? cur?.loginConfigId || '' : String(d.loginConfigId ?? '').trim();
  if (loginConfigId && !/^\d{1,30}$/.test(loginConfigId)) throw fail('VALIDATION', 'The Facebook Login for Business configuration id is a number');

  await c.updateOne(
    { _id: 'meta' },
    { $set: { appId, appSecret, verifyToken, graphVersion, loginConfigId, updatedAt: new Date(), updatedBy: actorLabel(ctx) } },
    { upsert: true }
  );
  const changed = [secretIn ? 'app secret' : '', verifyPlain ? 'verify token' : ''].filter(Boolean).join(', ');
  await platformAudit(ctx, 'Meta App Set', '', `App ${appId}, Graph ${graphVersion}${loginConfigId ? `, login config ${loginConfigId}` : ''}${changed ? `; changed: ${changed}` : ''}`);
  return getMetaSettings();
}

export async function testMetaSettings(): Promise<Res<'testMetaSettings'>> {
  try {
    const cfg = await requireMetaConfig();
    await checkAppToken(cfg);
    return { ok: true, message: `Meta accepted the App ID and App Secret (app ${cfg.appId}).${cfg.verifyToken ? '' : ' Generate a webhook verify token next.'}` };
  } catch (e: any) {
    return { ok: false, message: errMsg(e) };
  }
}

export async function companyMeta(d: Req<'companyMeta'>): Promise<Res<'companyMeta'>> {
  const c = await findCompany(String(d?.companyId || ''));
  return runWithTenant(toTenant(c), async () => {
    const rows = await (await sourcesCol()).find({ type: 'meta' }).sort({ _id: 1 }).toArray();
    return rows.map((r) => {
      const s = toSource(r);
      return {
        sourceId: s.id,
        name: s.name,
        status: s.status,
        meta: s.config.meta!,
        stats: { received: s.stats.received, created: s.stats.created, duplicates: s.stats.duplicates, failed: s.stats.failed, lastReceivedAt: s.stats.lastReceivedAt },
      };
    });
  });
}

export async function connectCompanyMetaPage(d: Req<'connectCompanyMetaPage'>, ctx: SaCtx): Promise<Res<'connectCompanyMetaPage'>> {
  const c = await findCompany(String(d?.companyId || ''));
  const pageId = String(d?.pageId ?? '').trim();
  if (!/^\d{1,30}$/.test(pageId)) throw fail('VALIDATION', 'A Facebook Page id is a number');
  const token = String(d?.pageAccessToken ?? '').trim();
  if (!token || token.length > 1000 || /\s/.test(token)) throw fail('VALIDATION', 'Paste the Page access token');
  const formIds = validFormIds(d?.formIds);
  const cfg = await requireMetaConfig();
  const page = await getPage(pageId, token, cfg);
  if (page.id !== pageId) throw fail('VALIDATION', 'This token belongs to another Page (or is a user token) — use the Page access token of this Page');
  let forms: Array<{ id: string; name: string; status: string }> = [];
  try {
    forms = await listForms(pageId, token, cfg);
  } catch {
    /* best effort */
  }
  const r = await runWithTenant(toTenant(c), () =>
    connectPage({ pageId, pageName: page.name, pageToken: token, forms, formIds, config: defaultConfig('meta'), ctx: companyActor(ctx), cfg })
  );
  await platformAudit(ctx, r.reconnected ? 'Meta Page Reconnected' : 'Meta Page Connected', c._id, truncate(`${r.sourceId} Facebook Page ${page.name} (${pageId})`, 500));
  return { sourceId: r.sourceId };
}

export async function retryMetaQueue(d: Req<'retryMetaQueue'>, ctx: SaCtx): Promise<Res<'retryMetaQueue'>> {
  const companyId = String(d?.companyId ?? '').trim();
  if (companyId) await findCompany(companyId);
  const filter: Record<string, unknown> = { status: { $in: ['failed', 'dead'] } };
  if (companyId) filter.companyId = companyId;
  const r = await (await queueCol()).updateMany(filter as any, { $set: { status: 'pending', attempts: 0, nextAttemptAt: null, lastError: '' } });
  await platformAudit(ctx, 'Meta Queue Retried', companyId, `${r.modifiedCount} lead(s) queued again`);
  return { retried: r.modifiedCount };
}
