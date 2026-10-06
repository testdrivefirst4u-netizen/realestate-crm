import React from 'react';
import { Building2, Check, Info, Minus } from 'lucide-react';
import type { ServerSettings, UserAccount } from '../../types/crm';
import { Badge, Card, InlineNotice } from '../../components/ui';
import { AppLogo } from '../../components/AppLogo';
import { FEATURE_LABELS, FeatureName, companyOf, hasFeature, planUsage } from '../../core/tenant';

export interface CompanySectionProps {
  serverSettings?: ServerSettings | null;
  /** The company's users (bootstrap list) — counted against the plan's user limit. */
  users: UserAccount[];
}

/** Plan features listed on the card, in this order. */
const PLAN_FEATURES: FeatureName[] = ['aiCopilot', 'chat360', 'calls', 'inventory', 'unitLocator', 'projectLibrary', 'reports', 'segments'];

/** Read-only: the company, its plan, the user limit and the plan's features. Changed only by the platform administrator. */
export const CompanySection: React.FC<CompanySectionProps> = ({ serverSettings, users }) => {
  const company = companyOf(serverSettings);
  const usage = planUsage(users, company?.maxUsers);
  const enabled = PLAN_FEATURES.filter((f) => hasFeature(serverSettings, f));
  const disabled = PLAN_FEATURES.filter((f) => !hasFeature(serverSettings, f));

  return (
    <Card
      title="Company & plan"
      subtitle="Your company account on the platform"
      actions={<Badge tone="navy"><Building2 size={10} className="mr-1" />{company?.plan || 'Plan'}</Badge>}
    >
      {!company ? (
        <InlineNotice>Company details are not available yet — they load with the next sync.</InlineNotice>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF]">
            <AppLogo size="lg" />
            <div className="min-w-0">
              <div className="text-base font-bold text-[#1D2F3F] truncate">{company.name}</div>
              {company.tagline && <div className="text-xs text-[#6B5F57] truncate">{company.tagline}</div>}
              <div className="text-[11px] text-[#9E948D] font-mono mt-0.5">{company.slug}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl border border-[#D2C9BF] bg-white">
              <div className="text-[10px] uppercase tracking-wider font-bold text-[#6B5F57]">Plan</div>
              <div className="text-sm font-semibold text-[#1D2F3F] mt-0.5">{company.plan || '—'}</div>
            </div>
            <div className="p-3 rounded-xl border border-[#D2C9BF] bg-white">
              <div className="text-[10px] uppercase tracking-wider font-bold text-[#6B5F57]">Users</div>
              <div className="text-sm font-semibold text-[#1D2F3F] mt-0.5">{usage.max > 0 ? `${usage.active} of ${usage.max} active` : `${usage.active} active · no limit`}</div>
              {usage.atLimit && <div className="text-[11px] text-[#A9825A] mt-0.5">User limit reached</div>}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-[#6B5F57] mb-2">Features in your plan</div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs">
              {enabled.map((f) => (
                <li key={f} className="flex items-center gap-2 text-[#1D2F3F]"><Check size={13} className="text-[#3C573A] flex-shrink-0" />{FEATURE_LABELS[f] || f}</li>
              ))}
              {disabled.map((f) => (
                <li key={f} className="flex items-center gap-2 text-[#9E948D]"><Minus size={13} className="flex-shrink-0" />{FEATURE_LABELS[f] || f} <span className="text-[10px]">(not included)</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p className="text-[11px] text-[#6B5F57] mt-4 inline-flex items-start gap-1.5">
        <Info size={12} className="text-[#A9825A] flex-shrink-0 mt-0.5" />
        <span>The company name, logo, plan, user limit and features are managed by the platform administrator. Contact them to make changes.</span>
      </p>
    </Card>
  );
};
