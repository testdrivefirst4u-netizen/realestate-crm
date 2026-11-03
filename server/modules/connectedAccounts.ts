/**
 * Settings › Connected accounts: every outside account this company has connected (Meta ad account, Facebook Pages
 * and Instagram, Google, LinkedIn, Pinterest), who connected it, when, and what the CRM uses it for — so the
 * company's administrator always sees, and can remove, the access it gave. Permission integrations.connect
 * (Admins; Platform support). Disconnecting is done with each connection's own action.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { currentTenant } from '../core/tenant';

export interface ConnectedAccount {
  key: 'meta' | 'facebook' | 'google' | 'linkedin' | 'pinterest';
  platform: string;
  account: string;
  connectedBy: string;
  at: string;
  usedFor: string[];
  status: 'connected' | 'error';
  note: string;
  /** Settings section that manages it. */
  section: string;
  /** Where the company can also remove the access at the source. */
  revokeAt: string;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : '');

export async function getConnectedAccounts(): Promise<ConnectedAccount[]> {
  const f = (currentTenant()?.features || {}) as Record<string, boolean>;
  const docs = new Map((await (await col<any>(CFG.COLL.INTEGRATIONS)).find({ _id: { $in: ['metaCapi', 'metaSocial', 'google', 'linkedin', 'pinterest'] } }).toArray()).map((d) => [String(d._id), d]));
  const out: ConnectedAccount[] = [];
  const uses = (list: Array<[boolean, string]>) => list.filter(([on]) => on).map(([, s]) => s);

  const m = docs.get('metaCapi');
  if (m?.token) out.push({
    key: 'meta', platform: 'Meta ad account', section: 'adConversions', revokeAt: 'Facebook › Settings › Business integrations',
    account: [m.datasetName || m.datasetId ? `Dataset ${m.datasetName || m.datasetId}` : '', ...(m.adAccounts || []).map((a: any) => a.name)].filter(Boolean).join(' · '),
    connectedBy: m.updatedBy || '', at: iso(m.updatedAt), status: 'connected', note: m.connectedVia === 'manual' ? 'Token entered by hand' : '',
    usedFor: uses([[!!f.adConversions && !!m.enabled, 'Sends lead results (hashed) to your Meta dataset'], [!!f.adSpend, 'Reads campaign spend'], [!!f.adsControl, 'Pauses campaigns / changes budgets when your team clicks']]),
  });
  const s = docs.get('metaSocial');
  if (s?.pages?.length) out.push({
    key: 'facebook', platform: 'Facebook Pages and Instagram', section: 'social', revokeAt: 'Facebook › Settings › Business integrations',
    account: s.pages.map((p: any) => p.name + (p.igUsername ? ` (+ @${p.igUsername})` : '')).join(', '),
    connectedBy: s.connectedBy || '', at: iso(s.updatedAt), status: 'connected', note: s.lastError || '',
    usedFor: uses([[!!f.socialInbox, 'Receives comments and messages; sends your replies'], [!!f.socialPosts, 'Publishes the posts your team writes']]),
  });
  const g = docs.get('google');
  if (g?.connectionId) {
    const conn = await (await col<any>('googleConnections')).findOne({ _id: g.connectionId });
    out.push({
      key: 'google', platform: 'Google', section: 'google', revokeAt: 'Google Account › Security › Third-party connections',
      account: [g.email, g.adsCustomerId ? `Ads ${String(g.adsCustomerId).replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}` : '', g.gbpLocation?.title || ''].filter(Boolean).join(' · '),
      connectedBy: g.updatedBy || '', at: iso(g.updatedAt), status: conn && conn.status !== 'Error' ? 'connected' : 'error', note: conn?.status === 'Error' ? conn.lastError || 'Access expired' : g.setupError || '',
      usedFor: uses([
        [!!f.googleConversions, 'Sends lead results to Google Ads / Analytics'], [!!f.googleAdsSpend, 'Reads Google Ads spend'], [!!f.websiteAnalytics, 'Reads website visitors (Analytics, read only)'],
        [!!(f.socialInbox || f.socialPosts), 'Reads Google reviews, posts replies and your Google posts'], [!!f.adsControl, 'Pauses campaigns / changes budgets when your team clicks'],
      ]),
    });
  }
  const l = docs.get('linkedin');
  if (l?.token) out.push({
    key: 'linkedin', platform: 'LinkedIn', section: 'social', revokeAt: 'LinkedIn › Settings › Data privacy › Permitted services',
    account: (l.orgs || []).find((o: any) => o.urn === l.orgUrn)?.name || (l.orgs || []).map((o: any) => o.name).join(', '),
    connectedBy: l.updatedBy || '', at: iso(l.updatedAt), status: 'connected', note: l.leadsError || '',
    usedFor: uses([[!!f.socialPosts, 'Publishes the posts your team writes'], [!!l.leadAccount, 'Reads Lead Gen Form leads']]),
  });
  const p = docs.get('pinterest');
  if (p?.token) out.push({
    key: 'pinterest', platform: 'Pinterest', section: 'social', revokeAt: 'Pinterest › Settings › Security and logins › Apps',
    account: [p.username, (p.boards || []).find((b: any) => b.id === p.boardId)?.name].filter(Boolean).join(' · '),
    connectedBy: p.updatedBy || '', at: iso(p.updatedAt), status: 'connected', note: '',
    usedFor: uses([[!!f.socialPosts, 'Pins the posts your team writes']]),
  });
  return out;
}

export const actions: ActionMap = {
  getConnectedAccounts: { fn: () => getConnectedAccounts(), perm: 'integrations.connect' },
};
