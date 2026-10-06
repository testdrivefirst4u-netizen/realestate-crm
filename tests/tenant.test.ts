/**
 * Per-company UI: the feature helper (plan features with the built-in defaults as fallback), company
 * branding, plan usage, and the Copilot / Sidebar / sign-in screen following the company's plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TenantProvider,
  companyInitials,
  companyOf,
  documentTitleFor,
  hasFeature,
  isPlanLimitMessage,
  planUsage,
  platformProductName,
  resolveFeatures,
} from '../src/core/tenant';
import { FEATURES } from '../src/core/config';
import { Sidebar } from '../src/components/Sidebar';
import { AppLogo } from '../src/components/AppLogo';
import { LoginScreen, isCompanyAccountMessage } from '../src/modules/auth/LoginScreen';
import { AMAYA_KNOWLEDGE } from '../src/modules/ai/amayaKnowledge';
import {
  GENERAL_QUICK_PROMPTS,
  GENERIC_QUICK_PROMPTS,
  SYSTEM_PROMPT,
  executeReadTool,
  quickPromptsFor,
  toolDeclarationsFor,
  type ToolContext,
} from '../src/modules/ai/copilotTools';
import { GENERIC_SUGGEST_REPLY_SYSTEM, SUGGEST_REPLY_SYSTEM, buildSuggestReplyPrompt, suggestReplySystem } from '../src/modules/chat360/Chat360View';
import { AppError } from '../src/core/errors';
import type { ServerSettings, UserAccount } from '../src/types/crm';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const COMPANY = { id: 'c1', slug: 'acme', name: 'Acme Homes', logo: '', tagline: 'Homes for every family', plan: 'Starter', maxUsers: 3 };

describe('hasFeature', () => {
  it('falls back to the built-in defaults while settings are not loaded', () => {
    expect(hasFeature(undefined, 'chat360')).toBe(true);
    expect(hasFeature(null, 'projectLibrary')).toBe(true);
    expect(hasFeature({}, 'reports')).toBe(true);
    expect(hasFeature({ features: {} }, 'inventory')).toBe(true);
    expect(hasFeature(undefined, 'developerMode')).toBe(false);
  });
  it('follows the company plan when the server says so', () => {
    const s = { features: { chat360: false, calls: true, unitLocator: false, projectLibrary: false } };
    expect(hasFeature(s, 'chat360')).toBe(false);
    expect(hasFeature(s, 'calls')).toBe(true);
    expect(hasFeature(s, 'unitLocator')).toBe(false);
    expect(hasFeature(s, 'projectLibrary')).toBe(false);
    expect(hasFeature(s, 'segments')).toBe(true); // not reported → default
  });
  it('resolveFeatures overlays the server values on the defaults', () => {
    const f = resolveFeatures({ features: { reports: false } });
    expect(f.reports).toBe(false);
    expect(f.aiCopilot).toBe(FEATURES.aiCopilot);
  });
});

describe('company branding', () => {
  it('initials, product name and document title', () => {
    expect(companyInitials('Acme Homes')).toBe('AH');
    expect(companyInitials('acme')).toBe('A');
    expect(companyInitials('  ')).toBe('');
    expect(documentTitleFor(COMPANY)).toBe('Acme Homes · CRM');
    expect(documentTitleFor(null)).toBe('CRM');
    expect(platformProductName()).toBe('CRM');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_NAME', 'Nest');
    expect(platformProductName()).toBe('Nest CRM');
  });
  it('companyOf ignores a missing or nameless company', () => {
    expect(companyOf({ company: null })).toBeNull();
    expect(companyOf({})).toBeNull();
    expect(companyOf({ company: COMPANY })?.slug).toBe('acme');
  });
  it('AppLogo shows the company logo, else its initials, else a neutral mark', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const logo = (settings: ServerSettings | null) => renderToStaticMarkup(createElement(TenantProvider, { settings }, createElement(AppLogo, { size: 'sm' })));
    const PNG = 'data:image/png;base64,QUJD';
    expect(logo({ company: { ...COMPANY, logo: PNG } })).toContain(`src="${PNG}"`);
    const initials = logo({ company: COMPANY });
    expect(initials).toContain('>AH</div>');
    expect(initials).not.toContain('<img');
    const none = logo(null);
    expect(none).toContain('<svg');
    expect(none).not.toMatch(/RM Logo/);
  });
});

describe('Sidebar follows the plan', () => {
  const user: UserAccount = { id: 'U1', name: 'Asha Rao', email: 'asha@acme.test', role: 'Admin', createdAt: '2026-10-01T09:00:00.000Z' };
  const render = (settings: ServerSettings) => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    return renderToStaticMarkup(
      createElement(TenantProvider, { settings }, createElement(Sidebar, {
        currentView: 'dashboard', isCollapsed: false, onToggleCollapse: () => {}, isMobileOpen: false, onCloseMobile: () => {},
        sync: { status: 'idle', hasLoadedOnce: true }, isOnline: true, currentUser: user, can: () => true, features: resolveFeatures(settings), onLogout: () => {},
      }))
    );
  };
  it('shows the company name and tagline instead of the old branding', () => {
    const html = render({ company: COMPANY });
    expect(html).toContain('Acme Homes');
    expect(html).toContain('Homes for every family');
    expect(html).not.toMatch(/Rahul|Amaya|Vera Vita/);
  });
  it('hides the views the plan does not include', () => {
    const all = render({ company: COMPANY });
    for (const label of ['WhatsApp (Chat360)', 'Call History', 'Inventory', 'Client Segments', 'Reports']) expect(all).toContain(label);
    const lean = render({ company: COMPANY, features: { chat360: false, calls: false, inventory: false, segments: false, reports: false } });
    for (const label of ['WhatsApp (Chat360)', 'Call History', 'Inventory', 'Client Segments', 'Reports']) expect(lean).not.toContain(label);
    expect(lean).toContain('All Leads');
  });
});

describe('plan usage', () => {
  it('counts active users against the limit', () => {
    const users = [{ status: 'Active' }, { status: 'Disabled' }, {}, { status: 'Active' }];
    expect(planUsage(users, 3)).toEqual({ active: 3, max: 3, atLimit: true, label: '3 of 3 active users' });
    expect(planUsage(users, 5).atLimit).toBe(false);
    expect(planUsage(users, 0)).toMatchObject({ max: 0, atLimit: false, label: '3 active users · no plan limit' });
  });
  it('recognises the server messages worth highlighting', () => {
    expect(isPlanLimitMessage('Your plan allows 3 active users. Disable a user first.')).toBe(true);
    expect(isPlanLimitMessage('Email already in use')).toBe(false);
    expect(isCompanyAccountMessage('This company account is suspended. Please contact your platform administrator.')).toBe(true);
  });
  it('FORBIDDEN and suspended AUTH_REQUIRED keep the server explanation', () => {
    expect(new AppError('FORBIDDEN', "Reports are not included in your company's plan.").userMessage).toBe("Reports are not included in your company's plan.");
    expect(new AppError('AUTH_REQUIRED', 'This company account is suspended. Please contact your platform administrator.').userMessage).toMatch(/suspended/);
    expect(new AppError('AUTH_REQUIRED', 'Please sign in').userMessage).toBe('Your session has expired. Please sign in again.');
  });
});

describe('sign-in screen', () => {
  const render = (lastError?: string) => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    return renderToStaticMarkup(createElement(LoginScreen, { status: 'login', lastError, onLogin: async () => {} }));
  };
  it('is one generic sign-in form without first-run setup', () => {
    const html = render();
    expect(html).toContain('Sign in');
    expect(html).toContain('Accounts are created by your company administrator.');
    expect(html).not.toMatch(/first administrator|Full name|Amaya|Rahul/);
  });
  it('shows a suspended company clearly', () => {
    const html = render('This company account is suspended. Please contact your platform administrator.');
    expect(html).toContain('Company account suspended');
    expect(html).toContain('This company account is suspended');
  });
});

describe('Copilot without the project library', () => {
  const ctx = (projectLibrary?: boolean): ToolContext => ({ leads: [], tasks: [], inventory: [], now: new Date('2026-10-01T18:00:00.000Z'), projectLibrary, companyName: 'Acme Homes' });
  it('uses a generic real-estate prompt without the Amaya knowledge', () => {
    const generic = SYSTEM_PROMPT(ctx(false));
    expect(generic).not.toContain(AMAYA_KNOWLEDGE);
    expect(generic).not.toMatch(/Amaya/);
    expect(generic).toContain('Acme Homes');
    expect(generic).toMatch(/never invent or estimate a figure/);
    expect(SYSTEM_PROMPT(ctx(true))).toContain(AMAYA_KNOWLEDGE);
    expect(SYSTEM_PROMPT(ctx())).toContain(AMAYA_KNOWLEDGE); // default: unchanged behaviour
  });
  it('drops the document tool and refuses it if called anyway', () => {
    expect(toolDeclarationsFor(ctx(false)).map((d) => d.name)).not.toContain('search_project_documents');
    expect(toolDeclarationsFor(ctx(true)).map((d) => d.name)).toContain('search_project_documents');
    expect(executeReadTool('search_project_documents', { query: 'parking' }, ctx(false)).error).toMatch(/not available/);
  });
  it('offers generic quick prompts', () => {
    expect(quickPromptsFor(undefined, { projectLibrary: false }).map((p) => p.text)).toEqual(GENERIC_QUICK_PROMPTS);
    expect(quickPromptsFor(undefined).map((p) => p.text)).toEqual(GENERAL_QUICK_PROMPTS);
  });
  it('WhatsApp "Suggest reply" drops the Amaya knowledge and labels our side with the company', () => {
    expect(suggestReplySystem(true)).toBe(SUGGEST_REPLY_SYSTEM);
    expect(suggestReplySystem(false)).toBe(GENERIC_SUGGEST_REPLY_SYSTEM);
    expect(GENERIC_SUGGEST_REPLY_SYSTEM).not.toContain(AMAYA_KNOWLEDGE);
    const prompt = buildSuggestReplyPrompt({
      messages: [{ id: 'm1', phone: '919000011111', direction: 'Outbound', text: 'Hello', timestamp: '2026-10-01T09:00:00.000Z', agent: 'Asha' } as never],
      business: 'Acme Homes',
      now: new Date('2026-10-01T10:00:00.000Z'),
    });
    expect(prompt).toContain('Acme Homes (Asha): Hello');
    expect(prompt).toContain('Acme Homes sent the last message');
  });
});
