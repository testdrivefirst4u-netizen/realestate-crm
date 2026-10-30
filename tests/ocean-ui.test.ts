/** Ocean design: the navy sidebar (sections, icons, counts, collapse) and the redesigned dashboard. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from '../src/components/Sidebar';
import { DashboardView } from '../src/modules/dashboard/DashboardView';
import { F } from '../src/core/config';
import type { Lead, UserAccount } from '../src/types/crm';

const user: UserAccount = { id: 'U1', name: 'Rahul Mehta', email: 'rahul@acme.test', role: 'Admin', createdAt: '2026-10-01T09:00:00.000Z' };
const base = {
  currentView: 'leads' as const, onToggleCollapse: () => {}, isMobileOpen: false, onCloseMobile: () => {},
  sync: { status: 'idle' as const, hasLoadedOnce: true, lastSyncAt: new Date().toISOString() }, isOnline: true, currentUser: user, can: () => true, features: {}, onLogout: () => {},
};
const sidebar = (props: Record<string, unknown> = {}) => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }); // AppLogo reads it
  return renderToStaticMarkup(createElement(Sidebar, { ...base, isCollapsed: false, ...props } as any));
};
afterEach(() => vi.unstubAllGlobals());

describe('sidebar', () => {
  it('lists every screen with its icon under its section, marks the current one and shows counts', () => {
    const html = sidebar({ counts: { leads: 248, followupsToday: 5, tasksPending: 12, unreadChats: 4 } });
    for (const g of ['Overview', 'Leads', 'Messages', 'Workspace', 'Admin']) expect(html).toContain(`>${g}</div>`);
    expect(html).not.toContain('>Property</div>');
    for (const s of ['Dashboard', 'Reports', 'Audit Log', 'All Leads', 'Enquiry Status', 'Follow-ups', 'Client Segments', 'WhatsApp (Chat360)', 'Call History', 'Templates', 'Tasks &amp; Notes', 'Documents', 'Inventory', 'Settings']) expect(html).toContain(`>${s}</span>`);
    // Inventory opens straight away (a link of its own, no pop-up)
    expect(html).toContain('href="/inventory"');
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toMatch(/aria-current="page"[^>]*>.*?<span class="truncate flex-1[^"]*">All Leads/);
    for (const n of ['248', '5', '12', '4']) expect(html).toContain(`>${n}</span>`);
    expect(html).not.toContain('New Enquiry');
    expect(html).toContain('Collapse navigation');
    expect(html).toContain('Developed by');
    expect(html).toContain('Rahul Mehta'); // the profile card
    expect(html).toContain('aria-label="Sign out"');
  });

  it('hides screens the plan leaves out', () => {
    const html = sidebar({ features: { inventory: false } });
    expect(html).toContain('>Tasks &amp; Notes</span>');
    expect(html).not.toContain('>Inventory</span>');
    expect(html).not.toContain('href="/inventory"');
  });

  it('collapsed: icons only (named for screen readers), with Expand navigation', () => {
    const html = sidebar({ isCollapsed: true, counts: { followupsToday: 3 } });
    expect(html).not.toContain('>All Leads</span>');
    expect(html).toContain('aria-label="All Leads"');
    expect(html).toContain('aria-label="Inventory"');
    expect(html).toContain('aria-label="Expand navigation"');
  });
});

describe('dashboard', () => {
  it('renders the Ocean layout with the funnel, calendar and lists', () => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const at = (h: number) => { const d = new Date(now); d.setHours(h, 30, 0, 0); return d; };
    const leads: Lead[] = [
      { [F.ID]: 'ENQ-1', [F.NAME]: 'Meera Kapoor', [F.ENQUIRY_DATE]: iso(now), [F.STAGE]: 'Hot', [F.SOURCE]: 'Website', [F.RM]: 'Priya', [F.SITE_VISIT_DATE]: iso(at(11)), [F.SITE_VISIT_STATUS]: 'Scheduled', [F.NEXT_FOLLOWUP]: iso(at(10)) } as Lead,
      { [F.ID]: 'ENQ-2', [F.NAME]: 'Rajiv Menon', [F.ENQUIRY_DATE]: iso(now), [F.STAGE]: 'Booked', [F.SOURCE]: 'Meta Lead Ads', [F.RM]: 'Rahul' } as Lead,
      { [F.ID]: 'ENQ-3', [F.NAME]: 'Anita Desai', [F.ENQUIRY_DATE]: iso(now), [F.STAGE]: 'New', [F.SOURCE]: 'Website', [F.RM]: 'Priya' } as Lead,
    ];
    const html = renderToStaticMarkup(createElement(DashboardView, {
      leads, tasks: [], rmOptions: ['Priya', 'Rahul'], sync: { status: 'idle', hasLoadedOnce: true, lastSyncAt: iso(now) } as any,
      greeting: 'Sales Dashboard', userName: 'Rahul Mehta', onRefresh: () => {}, onFilterClick: () => {}, onOpenLead: () => {},
    }));
    expect(html).toMatch(/Good (morning|afternoon|evening), Rahul/);
    expect(html).toContain('Sales Dashboard');
    for (const t of ['Conversion funnel', 'Total Enquiries', 'Lost / DQ', 'Monthly enquiry trend', 'Site visits ·', 'Source-wise enquiries', 'Lead-stage distribution', 'Follow-ups &amp; tasks', 'Follow-ups due today', 'RM-wise performance']) expect(html).toContain(t);
    expect(html).toContain('Meera Kapoor'); // due today and visiting today
    expect(html).toContain('3 enquiries by source');
  });
});

describe('phone tab bar', () => {
  it('shows Home, Leads, Follow-ups (with count), WhatsApp or Tasks and More — no + button', async () => {
    const { MobileTabBar } = await import('../src/components/MobileTabBar');
    const render = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(MobileTabBar, { currentView: 'leads', showChats: true, onMore: () => {}, ...p } as any));
    const html = render({ followupsToday: 5 });
    for (const l of ['Home', 'Leads', 'Follow-ups', 'WhatsApp', 'More screens']) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toMatch(/aria-label="Leads" aria-current="page"/);
    expect(html).toContain('>5</span>');
    expect(html).not.toContain('New enquiry');
    const noChat = render({ showChats: false, tasksPending: 3 });
    expect(noChat).toContain('aria-label="Tasks"');
    expect(noChat).not.toContain('aria-label="WhatsApp"');
    expect(noChat).not.toContain('New enquiry');
  });
});
