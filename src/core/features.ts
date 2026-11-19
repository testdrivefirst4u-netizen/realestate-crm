/**
 * Plan features and company branding — pure helpers shared by the browser and the server
 * (server components gate routes with the same rules the sidebar uses). React bindings live in tenant.tsx.
 */
import { FEATURES } from './config';
import type { ServerSettings } from '../types/crm';

/** Plan / settings features the server reports in `settings.features`. */
export type FeatureName =
  | 'aiCopilot'
  | 'chat360'
  | 'calls'
  | 'inventory'
  | 'inventorySync'
  | 'websiteApi'
  | 'metaLeads'
  | 'googleSheets'
  | 'adConversions'
  | 'googleAdsLeads'
  | 'adSpend'
  | 'googleConversions'
  | 'googleAdsSpend'
  | 'socialInbox'
  | 'socialPosts'
  | 'adsControl'
  | 'linkedin'
  | 'pinterest'
  | 'websiteAnalytics'
  | 'competitorAds'
  | 'searchConsole'
  | 'businessProfile'
  | 'dripCampaigns'
  | 'whatsappDirect'
  | 'whatsappCredits'
  | 'whatsappBots'
  | 'whatsappCampaigns'
  | 'unitLocator'
  | 'projectLibrary'
  | 'reports'
  | 'segments'
  | 'channelPartners'
  | 'developerMode'
  // UI-only switches that are not part of a plan (always on unless settings turn them off)
  | 'documents'
  | 'templates'
  | 'csvImport';

export interface CompanyInfo {
  id: string;
  slug: string;
  name: string;
  /** Small data URL, or '' when the company has no logo. */
  logo: string;
  tagline: string;
  plan: string;
  /** Vertical the company is in (see SECTORS); '' falls back to real estate. */
  sector?: string;
  /** 0 = unlimited. */
  maxUsers: number;
}

type SettingsLike = { features?: Record<string, boolean> | null } | null | undefined;

/** Is `name` enabled? Uses `settings.features` when it says so, else the built-in default. */
export function hasFeature(settings: SettingsLike, name: FeatureName): boolean {
  const f = settings?.features;
  if (f && typeof f[name] === 'boolean') return f[name];
  return !!(FEATURES as Record<string, boolean>)[name];
}

/** Every feature resolved (defaults overlaid with the server's values). */
export function resolveFeatures(settings: SettingsLike): Record<FeatureName, boolean> & Record<string, boolean> {
  return { ...(FEATURES as Record<string, boolean>), ...(settings?.features || {}) } as Record<FeatureName, boolean> & Record<string, boolean>;
}

/** Human labels for the plan features (Settings › Company & plan). */
export const FEATURE_LABELS: Partial<Record<FeatureName, string>> = {
  aiCopilot: 'AI Copilot',
  chat360: 'WhatsApp (Chat360)',
  calls: 'Call history & logging',
  inventory: 'Inventory',
  inventorySync: 'Inventory sync',
  unitLocator: 'Unit Locator',
  projectLibrary: 'Project library',
  reports: 'Reports',
  segments: 'Client segments',
  channelPartners: 'Channel Partners',
  websiteApi: 'Website forms & lead API',
  metaLeads: 'Meta Lead Ads',
  googleSheets: 'Google Sheets sync',
  adConversions: 'Ad conversions',
  googleAdsLeads: 'Google Ads lead forms',
  adSpend: 'Ad spend from Meta',
  googleConversions: 'Lead results to Google',
  googleAdsSpend: 'Ad spend from Google Ads',
  socialInbox: 'Social inbox',
  socialPosts: 'Post scheduler',
  adsControl: 'Ads control',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  websiteAnalytics: 'Website analytics',
  competitorAds: 'Competitor ads',
  searchConsole: 'Search Console',
  businessProfile: 'Business Profile',
  dripCampaigns: 'Drip campaigns',
  whatsappDirect: 'WhatsApp direct',
  whatsappCredits: 'WhatsApp credits',
  whatsappBots: 'WhatsApp chatbots',
  whatsappCampaigns: 'WhatsApp campaigns',
};

/**
 * Sellable modules — each bundles the feature flags that make up one thing a client can buy.
 * Used to seed ready-made plans (server/platform/plans.ts) and the one-click "package" buttons in Super Admin.
 * Core CRM is the base everyone gets; the rest are add-ons that can be combined. AI is its own add-on so the
 * chatbot/social modules work rule-based without it and gain AI replies with it.
 */
export const FEATURE_PACKAGES: Array<{ id: string; label: string; features: FeatureName[] }> = [
  { id: 'crm', label: 'Core CRM', features: ['reports', 'segments', 'inventory', 'calls', 'channelPartners'] },
  { id: 'whatsapp', label: 'WhatsApp', features: ['chat360', 'whatsappCredits', 'whatsappCampaigns'] },
  { id: 'chatbot', label: 'Chatbot', features: ['whatsappBots'] },
  { id: 'social', label: 'Social Media', features: ['socialInbox', 'socialPosts', 'businessProfile', 'websiteAnalytics', 'searchConsole', 'competitorAds', 'adsControl', 'linkedin', 'pinterest'] },
  { id: 'ads', label: 'Ads & Lead-gen', features: ['metaLeads', 'googleAdsLeads', 'adConversions', 'adSpend', 'googleConversions', 'googleAdsSpend', 'websiteApi'] },
  { id: 'ai', label: 'AI add-on', features: ['aiCopilot'] },
];

/** The flags of the named packages, each set to true (union). Spread over a base feature map to enable those modules. */
export function featuresForPackages(ids: string[]): Partial<Record<FeatureName, boolean>> {
  const out: Partial<Record<FeatureName, boolean>> = {};
  for (const p of FEATURE_PACKAGES) if (ids.includes(p.id)) for (const f of p.features) out[f] = true;
  return out;
}

/**
 * Sectors (verticals) a company can be in. Each carries the modules it usually needs and a suggested pipeline/sources,
 * so the CRM can be sold and set up per sector. For now the sector is metadata + guidance; sector-native stage names and
 * terminology are a later phase (the funnel/won-loss logic is tied to the real-estate stages today).
 */
export const SECTORS: Array<{ id: string; label: string; packages: string[]; pipeline: string[]; sources: string[] }> = [
  { id: 'realestate', label: 'Real Estate', packages: ['crm', 'whatsapp', 'chatbot'], pipeline: ['New', 'Open', 'Warm', 'Hot', 'Qualified', 'Site visit', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  { id: 'automobile', label: 'Automobile', packages: ['crm', 'whatsapp', 'chatbot'], pipeline: ['New', 'Enquiry', 'Test drive', 'Negotiation', 'Booked', 'Delivered', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  { id: 'healthcare', label: 'Healthcare / Clinic', packages: ['crm', 'whatsapp'], pipeline: ['New', 'Enquiry', 'Appointment', 'Consulted', 'In treatment', 'Follow-up', 'Closed'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  { id: 'education', label: 'Education / Coaching', packages: ['crm', 'whatsapp', 'chatbot'], pipeline: ['New', 'Enquiry', 'Counselling', 'Demo', 'Enrolled', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  { id: 'hospitality', label: 'Hospitality / Hotel', packages: ['crm', 'whatsapp'], pipeline: ['New', 'Enquiry', 'Quote sent', 'Booked', 'Stayed', 'Closed', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Google', 'Facebook', 'Instagram'] },
  { id: 'retail', label: 'Retail / Showroom', packages: ['crm', 'whatsapp'], pipeline: ['New', 'Enquiry', 'Quote sent', 'Purchased', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  { id: 'finance', label: 'Financial Services', packages: ['crm', 'whatsapp'], pipeline: ['New', 'Enquiry', 'Documents', 'Under review', 'Approved', 'Disbursed', 'Rejected'], sources: ['Website', 'Referral', 'Facebook', 'Google'] },
  { id: 'other', label: 'Other', packages: ['crm'], pipeline: ['New', 'Enquiry', 'Qualified', 'Won', 'Lost'], sources: ['Website', 'Walk-in', 'Referral'] },
];
export const SECTOR_IDS = SECTORS.map((s) => s.id);
export const sectorById = (id: string | null | undefined) => SECTORS.find((s) => s.id === id) || null;
/** A known sector id, or 'realestate' as the default. */
export const normalizeSector = (id: string | null | undefined) => (SECTOR_IDS.includes(String(id || '')) ? String(id) : 'realestate');

/** Terminology: the words a sector uses for the shared nouns, so the CRM reads naturally per vertical. */
export const SECTOR_LABELS: Record<string, { leads: string; inventory: string; partners: string }> = {
  realestate: { leads: 'Leads', inventory: 'Inventory', partners: 'Channel Partners' },
  automobile: { leads: 'Leads', inventory: 'Vehicles', partners: 'Dealers' },
  healthcare: { leads: 'Patients', inventory: 'Services', partners: 'Referrers' },
  education: { leads: 'Students', inventory: 'Courses', partners: 'Referrers' },
  hospitality: { leads: 'Guests', inventory: 'Rooms', partners: 'Travel agents' },
  retail: { leads: 'Customers', inventory: 'Products', partners: 'Partners' },
  finance: { leads: 'Applicants', inventory: 'Products', partners: 'Agents' },
  other: { leads: 'Leads', inventory: 'Inventory', partners: 'Partners' },
};
/** The word a company's sector uses for a shared noun ('leads' | 'inventory' | 'partners'). */
export function sectorLabel(sector: string | null | undefined, key: 'leads' | 'inventory' | 'partners'): string {
  return (SECTOR_LABELS[normalizeSector(sector)] || SECTOR_LABELS.realestate)[key];
}

/**
 * The lead pipeline (stage options + Kanban order + sources) a sector uses. The terminal stages stay the canonical
 * 'New'/'Booked'/'Lost' so the won-loss KPI engine is untouched and correct for every sector — only the intermediate
 * stages change per vertical. Real estate has no entry here and keeps the built-in defaults (config DEFAULT_OPTIONS).
 */
export const SECTOR_STAGE_PIPELINES: Record<string, { stages: string[]; funnel: string[]; sources: string[] }> = {
  automobile: { funnel: ['New', 'Enquiry', 'Test drive', 'Negotiation', 'Booked'], stages: ['New', 'Enquiry', 'Test drive', 'Negotiation', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google', 'OLX'] },
  healthcare: { funnel: ['New', 'Enquiry', 'Appointment', 'Consulted', 'Booked'], stages: ['New', 'Enquiry', 'Appointment', 'Consulted', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  education: { funnel: ['New', 'Enquiry', 'Counselling', 'Demo', 'Booked'], stages: ['New', 'Enquiry', 'Counselling', 'Demo', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  hospitality: { funnel: ['New', 'Enquiry', 'Quote sent', 'Booked'], stages: ['New', 'Enquiry', 'Quote sent', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Google', 'Facebook', 'Instagram'] },
  retail: { funnel: ['New', 'Enquiry', 'Quote sent', 'Booked'], stages: ['New', 'Enquiry', 'Quote sent', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google'] },
  finance: { funnel: ['New', 'Enquiry', 'Documents', 'Under review', 'Booked'], stages: ['New', 'Enquiry', 'Documents', 'Under review', 'Booked', 'Lost'], sources: ['Website', 'Referral', 'Facebook', 'Google'] },
  other: { funnel: ['New', 'Enquiry', 'Qualified', 'Booked'], stages: ['New', 'Enquiry', 'Qualified', 'Booked', 'Lost'], sources: ['Website', 'Walk-in', 'Referral'] },
};
/** The sector's pipeline, or null for real estate (and unknown sectors) which use the built-in defaults. */
export const pipelineFor = (sector: string | null | undefined) => SECTOR_STAGE_PIPELINES[String(sector || '')] || null;

/** Up to two initials of a company name ("Vera Vita Living" → "VV", "acme" → "A"). */
export function companyInitials(name: string | null | undefined): string {
  const words = String(name || '').trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (!words.length) return '';
  const first = (w: string) => (w.match(/[A-Za-z0-9]/) || [''])[0].toUpperCase();
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[1]);
}

/** Product name shown before sign-in (no company is known yet). */
export function platformProductName(): string {
  const platform = (process.env.NEXT_PUBLIC_PLATFORM_NAME || '').trim();
  return platform ? `${platform} CRM` : 'CRM';
}

/** Browser tab title: "<Company> · CRM", or just "CRM" without a company. */
export function documentTitleFor(company: Pick<CompanyInfo, 'name'> | null | undefined): string {
  return company?.name ? `${company.name} · CRM` : platformProductName();
}

export function companyOf(settings: ServerSettings | null | undefined): CompanyInfo | null {
  const c = settings?.company;
  return c && typeof c === 'object' && c.name ? c : null;
}
