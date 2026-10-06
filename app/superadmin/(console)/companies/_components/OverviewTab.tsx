'use client';
import type { ReactNode } from 'react';
import { Activity, CalendarCheck, Database, MessageSquare, Phone, Target, Warehouse } from 'lucide-react';
import type { CompanyDetail, Plan } from '@/server/platform/contract';
import { fmtDateTime, fmtMB, fmtNum, fmtSeats } from '../../../_lib/format';
import { Card, CardHeader } from '../../../_components/ui';
import { EditCompanyForm } from './EditCompanyForm';

function Usage({ label, value, icon }: { label: string; value: ReactNode; icon: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#E4DCD2] bg-white p-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[#6B6158]">
        <span aria-hidden className="text-[#A9825A]">
          {icon}
        </span>
        {label}
      </div>
      <p className="mt-1.5 text-[1.3rem] font-semibold text-[#14202B] tabular-nums">{value}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-[13px] text-[#7A6F64]">{label}</dt>
      <dd className="min-w-0 text-right text-[13.5px] text-[#26211E] safe-text-wrap">{children || '—'}</dd>
    </div>
  );
}

export function OverviewTab({ company, plans, onSaved }: { company: CompanyDetail; plans: Plan[]; onSaved: (c: CompanyDetail) => void }) {
  const u = company.usage;
  return (
    <div className="space-y-6">
      <section aria-label="Usage" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Usage label="Leads" value={fmtNum(u?.leads)} icon={<Target className="h-4 w-4" />} />
        <Usage label="Tasks" value={fmtNum(u?.tasks)} icon={<CalendarCheck className="h-4 w-4" />} />
        <Usage label="Units" value={fmtNum(u?.units)} icon={<Warehouse className="h-4 w-4" />} />
        <Usage label="Calls" value={fmtNum(u?.calls)} icon={<Phone className="h-4 w-4" />} />
        <Usage label="Messages" value={fmtNum(u?.messages)} icon={<MessageSquare className="h-4 w-4" />} />
        <Usage label="Storage" value={fmtMB(u?.storageMB ?? company.storageMB)} icon={<Database className="h-4 w-4" />} />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <EditCompanyForm company={company} plans={plans} onSaved={onSaved} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="At a glance" />
            <dl className="divide-y divide-[#F1ECE6] px-5 py-2">
              <Row label="Company ID">
                <span className="font-mono">{company.id}</span>
              </Row>
              <Row label="Database">
                <span className="font-mono">{company.dbName}</span>
              </Row>
              <Row label="Seats">{fmtSeats(company.activeUsers, company.maxUsers)}</Row>
              <Row label="Created">{fmtDateTime(company.createdAt)}</Row>
              <Row label="Updated">{fmtDateTime(company.updatedAt)}</Row>
              <Row label="Last activity">
                <span className="inline-flex items-center gap-1">
                  <Activity className="h-3.5 w-3.5 text-[#A9825A]" aria-hidden />
                  {fmtDateTime(u?.lastActivityAt)}
                </span>
              </Row>
            </dl>
          </Card>
          <Card>
            <CardHeader title="Contact" />
            <dl className="divide-y divide-[#F1ECE6] px-5 py-2">
              <Row label="Name">{company.contactName}</Row>
              <Row label="E-mail">
                {company.contactEmail ? (
                  <a href={`mailto:${company.contactEmail}`} className="text-[#1D2F3F] underline underline-offset-2">
                    {company.contactEmail}
                  </a>
                ) : null}
              </Row>
              <Row label="Phone">
                {company.contactPhone ? (
                  <a href={`tel:${company.contactPhone}`} className="text-[#1D2F3F] underline underline-offset-2">
                    {company.contactPhone}
                  </a>
                ) : null}
              </Row>
            </dl>
            {company.notes && (
              <div className="border-t border-[#EFE9E2] px-5 py-3">
                <p className="text-[12.5px] font-medium uppercase tracking-wide text-[#7A6F64]">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-[#4A423B] safe-text-wrap">{company.notes}</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
