'use client';
/**
 * Companies › a company › Settings: the company's CRM settings, right here in the console — WhatsApp & AI keys,
 * alerts & follow-ups, visit booking, Facebook sync and backups. Requests go through /api/platform/company-rpc,
 * which runs them in the company as its Platform support account (audited under the super admin's name); the
 * console never switches to the company's CRM.
 */
import { useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, CalendarDays, DatabaseBackup, Plug } from 'lucide-react';
import type { CompanyDetail } from '@/server/platform/contract';
import type { ServerSettings, UserAccount } from '@/src/types/crm';
import { api, configureApi } from '@/src/core/api';
import { DEFAULT_SETTINGS } from '@/src/core/config';
import { toAppError } from '@/src/core/errors';
import { TenantProvider } from '@/src/core/tenant';
import { Toasts } from '@/src/components/Toasts';
import { IntegrationsSection } from '@/src/modules/settings/IntegrationsSection';
import { LeadAlertsSection } from '@/src/modules/settings/LeadAlertsSection';
import { VisitBookingSection } from '@/src/modules/settings/VisitBookingSection';
import { MetaSyncSection } from '@/src/modules/settings/MetaSyncSection';
import { BackupsSection } from '@/src/modules/settings/BackupsSection';
import type { ServerSettingsExt } from '@/src/modules/settings/types';
import { Button, Card, ErrorBox, Skeleton, cx, focusRing } from '../../../_components/ui';

type SectionId = 'integrations' | 'alerts' | 'visits' | 'meta' | 'backups';

const allow = () => true; // the support account holds every permission

export function CompanySettingsTab({ company }: { company: CompanyDetail }) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [error, setError] = useState('');
  const [section, setSection] = useState<SectionId>('integrations');
  const [attempt, setAttempt] = useState(0);

  // point the CRM settings screens at this company (and back when leaving the tab)
  useEffect(() => {
    configureApi({ url: `/api/platform/company-rpc?company=${encodeURIComponent(company.id)}` });
    return () => configureApi({ url: '' });
  }, [company.id]);

  useEffect(() => {
    let live = true;
    setError('');
    setSettings(null);
    configureApi({ url: `/api/platform/company-rpc?company=${encodeURIComponent(company.id)}` });
    Promise.all([api.settings.get(), api.settings.users.list().catch(() => [] as UserAccount[])]).then(
      ([s, u]) => { if (live) { setSettings(s); setUsers(Array.isArray(u) ? u : []); } },
      (e) => { if (live) setError(toAppError(e).userMessage); },
    );
    return () => { live = false; };
  }, [company.id, attempt]);

  const metaOn = !!company.features?.metaLeads;
  const sections = useMemo(
    () =>
      [
        { id: 'integrations' as const, label: 'WhatsApp, AI & calls', hint: 'Chat360 and Gemini keys, telephony, digest e-mail', icon: Plug },
        { id: 'alerts' as const, label: 'Alerts & follow-ups', hint: 'Lead alerts, auto-reassign, reminders, summary', icon: BellRing },
        { id: 'visits' as const, label: 'Visit booking', hint: 'Public site-visit booking page', icon: CalendarDays },
        ...(metaOn ? [{ id: 'meta' as const, label: 'Facebook sync', hint: 'Is every Facebook lead in the CRM?', icon: Activity }] : []),
        { id: 'backups' as const, label: 'Backups', hint: 'Daily lead backups and restore tests', icon: DatabaseBackup },
      ],
    [metaOn],
  );

  if (company.status !== 'Active') {
    return (
      <Card className="p-6 text-[14px] text-[#4E6779]">Reactivate the company (Danger zone) to change its settings — a suspended company cannot be opened.</Card>
    );
  }

  const ext = (settings || undefined) as ServerSettingsExt | undefined;
  const base = { settings: DEFAULT_SETTINGS as any, serverSettings: ext, currentUser: null, can: allow, onApplyServerSettings: (s: ServerSettings) => setSettings(s) };
  const rmOptions = users.filter((u) => u.status !== 'Disabled' && (u.role === 'RM' || u.role === 'Manager')).map((u) => u.name);

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <nav aria-label="Settings sections" className="w-full shrink-0 lg:sticky lg:top-6 lg:w-64">
        <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {sections.map((s) => {
            const on = section === s.id;
            const Icon = s.icon;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={on ? 'page' : undefined}
                  className={cx(
                    'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                    on ? 'border-[#0A1F33] bg-[#0A1F33] text-white shadow-[0_6px_16px_rgba(10,31,51,0.18)]' : 'border-[#D3E3F0] bg-white text-[#0A1F33] hover:border-[#9CC9EE]',
                    focusRing,
                  )}
                >
                  <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', on ? 'text-[#36B3F2]' : 'text-[#0B6BB0]')} aria-hidden />
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap text-[14px] font-semibold">{s.label}</span>
                    <span className={cx('hidden text-[12.5px] lg:block', on ? 'text-[#B9D4EA]' : 'text-[#5E778C]')}>{s.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 hidden text-[12.5px] leading-relaxed text-[#5E778C] lg:block">
          Changes apply to {company.name} straight away and are recorded in its audit log under your name.
        </p>
      </nav>

      <div className="crm-ocean min-w-0 flex-1">
        {error ? (
          <Card className="p-5">
            <ErrorBox message={error} />
            <Button className="mt-3" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          </Card>
        ) : !settings ? (
          <div role="status" aria-label="Loading settings" className="space-y-3">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <TenantProvider settings={settings}>
            {section === 'integrations' && <IntegrationsSection {...base} rmOptions={rmOptions} />}
            {section === 'alerts' && <LeadAlertsSection {...base} users={users} />}
            {section === 'visits' && <VisitBookingSection {...base} />}
            {section === 'meta' && metaOn && <MetaSyncSection canEdit />}
            {section === 'backups' && <BackupsSection />}
          </TenantProvider>
        )}
      </div>
      <Toasts />
    </div>
  );
}
