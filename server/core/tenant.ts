/**
 * Multi-tenancy: every request runs inside one company's context.
 *
 * Each company (tenant) has its own MongoDB database; the platform (super admin, company registry,
 * user directory) lives in a separate database. `runWithTenant(company, fn)` sets the company for
 * everything awaited inside `fn` (AsyncLocalStorage), and `col()` in db.ts resolves collections in
 * that company's database. There is deliberately NO default tenant: code that reaches the database
 * without a company context throws instead of reading another company's data.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantFeatures {
  aiCopilot: boolean;
  chat360: boolean;
  calls: boolean;
  inventory: boolean;
  unitLocator: boolean;
  /** Amaya-specific project document library and Copilot knowledge (only for Amaya by Vera Vita). */
  projectLibrary: boolean;
  reports: boolean;
  segments: boolean;
  /** Website forms / generic webhook API (lead sources). */
  websiteApi: boolean;
  /** Meta (Facebook / Instagram) Lead Ads. */
  metaLeads: boolean;
  /** Google Sheets import / export. */
  googleSheets: boolean;
  /** Report lead results (Qualified, site visit, Booked) to the company's own ad accounts (Meta Conversions API). */
  adConversions: boolean;
  /** Google Ads lead form leads (webhook → lead source of type google_ads). */
  googleAdsLeads: boolean;
  /** Daily Meta ad spend per campaign into the campaign spend of Sales MIS (needs the Facebook connection of Ad conversions). */
  adSpend: boolean;
  /** Report lead results to the company's Google Ads conversion actions and GA4 property. */
  googleConversions: boolean;
  /** Daily Google Ads spend per campaign into the campaign spend of Sales MIS. */
  googleAdsSpend: boolean;
  /** Facebook / Instagram comments and messages and Google reviews in one inbox, answered from the CRM. */
  socialInbox: boolean;
  /** Write once, publish or schedule posts to the connected pages and profiles. */
  socialPosts: boolean;
  /** Pause / resume Meta and Google campaigns, change budgets, alerts for campaigns spending without leads. */
  adsControl: boolean;
  /** LinkedIn company page posts and Lead Gen Form leads. */
  linkedin: boolean;
  /** Pins to a Pinterest board from the post scheduler. */
  pinterest: boolean;
  /** Website analytics screen: the company's GA4 visitors next to CRM enquiries, site visits and bookings. */
  websiteAnalytics: boolean;
  /** Competitor ads screen: competitors, links to their ads on Meta and Google, what the team saw. */
  competitorAds: boolean;
  /** Search Console screen: Google search figures and indexed pages. */
  searchConsole: boolean;
  /** Business Profile screen: the Google listing as customers see it, and its figures. */
  businessProfile: boolean;
  /** Drip campaigns: WhatsApp, e-mail and RM task steps for new leads. */
  dripCampaigns: boolean;
  /** WhatsApp through Meta's Cloud API instead of Chat360, once a number is connected. */
  whatsappDirect: boolean;
  /** BroaddCast bills this company's WhatsApp messages from credits Super Admin adds. */
  whatsappCredits: boolean;
  /** Chatbots built by the company, on a direct WhatsApp connection. */
  whatsappBots: boolean;
}

export interface Tenant {
  id: string; // CMP-0001
  slug: string; // url-safe, unique
  name: string;
  dbName: string;
  status: 'Active' | 'Suspended';
  plan: string;
  maxUsers: number;
  features: TenantFeatures;
  logo: string; // small data URL or ''
  tagline: string;
}

const storage = new AsyncLocalStorage<Tenant>();

export function runWithTenant<T>(tenant: Tenant, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(storage.run(tenant, fn));
}

export function currentTenant(): Tenant | null {
  return storage.getStore() || null;
}

/** The current company; throws when code runs outside a company context. */
export function requireTenant(): Tenant {
  const t = storage.getStore();
  if (!t) throw new Error('No company context for this operation (tenant isolation guard).');
  return t;
}

/** Key for per-company in-memory caches/locks. */
export function tenantKey(suffix = '') {
  const t = storage.getStore();
  return (t ? t.dbName : '__none__') + (suffix ? ':' + suffix : '');
}
