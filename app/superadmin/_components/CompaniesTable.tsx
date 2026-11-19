'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CompanySummary, Plan } from '@/server/platform/contract';
import { sectorById } from '@/src/core/features';
import { fmtDate, fmtMB, fmtNum, fmtSeats, planName } from '../_lib/format';
import { Pill, StatusBadge, Table, cx, focusRing, td, th } from './ui';

/** Gradient avatar for a company logo-mark, picked deterministically from the name. */
const GRADS: Array<[string, string]> = [
  ['#5b57eb', '#7a76ff'], ['#6366f1', '#8b8bf6'], ['#0ea5a3', '#2dd4bf'], ['#e4634f', '#f4876f'],
  ['#2563eb', '#60a5fa'], ['#9333ea', '#c084fc'], ['#d97706', '#fbbf24'], ['#0891b2', '#22d3ee'],
];
const gradOf = (s: string) => GRADS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADS.length];
const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const SECTOR_COLOR: Record<string, string> = { realestate: '#6366f1', automobile: '#0ea5a3', healthcare: '#e4634f', education: '#2563eb', hospitality: '#9333ea', retail: '#d97706', finance: '#0891b2', other: '#94a3b8' };

/** Companies table — rows link to the detail page (the name is a real link for keyboard users). */
export function CompaniesTable({ companies, plans, compact = false }: { companies: CompanySummary[]; plans: Plan[] | null; compact?: boolean }) {
  const router = useRouter();
  const maxMB = Math.max(1, ...companies.map((c) => c.storageMB || 0));
  return (
    <Table label="Companies">
      <thead>
        <tr className="border-b border-[#E3EDF5]">
          <th scope="col" className={th}>Company</th>
          {!compact && <th scope="col" className={th}>Sector</th>}
          <th scope="col" className={th}>Plan</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={cx(th, 'text-right')}>Seats</th>
          {!compact && (
            <>
              <th scope="col" className={cx(th, 'text-right')}>Leads</th>
              <th scope="col" className={th}>Storage</th>
            </>
          )}
          <th scope="col" className={th}>Created</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#EDF3F8]">
        {companies.map((c) => {
          const href = `/superadmin/companies/${encodeURIComponent(c.id)}`;
          const full = c.maxUsers > 0 && c.activeUsers >= c.maxUsers;
          const [g1, g2] = gradOf(c.name || c.slug);
          const sector = sectorById(c.sector);
          const seatPct = c.maxUsers > 0 ? Math.min(100, Math.round((c.activeUsers / c.maxUsers) * 100)) : 0;
          return (
            <tr key={c.id} onClick={() => router.push(href)} className="cursor-pointer transition-colors hover:bg-[#F7FAFD]">
              <td className={td}>
                <span className="flex items-center gap-3">
                  <span aria-hidden className="grid h-10 w-10 flex-none place-items-center rounded-xl text-[14px] font-extrabold text-white shadow-sm" style={{ backgroundImage: `linear-gradient(135deg, ${g1}, ${g2})` }}>
                    {initials(c.name || c.slug)}
                  </span>
                  <span className="min-w-0">
                    <Link href={href} onClick={(e) => e.stopPropagation()} className={cx('block truncate rounded font-bold tracking-tight text-[#0A1F33] hover:underline underline-offset-2', focusRing)}>
                      {c.name}
                    </Link>
                    <span className="font-mono text-[12px] text-[#7E93A6]">{c.slug}</span>
                  </span>
                </span>
              </td>
              {!compact && (
                <td className={td}>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-bold text-[#233B50]">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: SECTOR_COLOR[c.sector] || SECTOR_COLOR.realestate }} />
                    {sector?.label || 'Real Estate'}
                  </span>
                </td>
              )}
              <td className={td}><Pill>{planName(plans, c.plan)}</Pill></td>
              <td className={td}><StatusBadge status={c.status} /></td>
              <td className={cx(td, 'text-right')}>
                <span className="inline-flex items-center justify-end gap-2">
                  <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-[#EAF0F6]">
                    <span className="block h-full rounded-full" style={{ width: `${seatPct}%`, backgroundImage: full ? 'linear-gradient(90deg,#d97706,#f59e0b)' : 'linear-gradient(90deg,#5b57eb,#7a76ff)' }} />
                  </span>
                  <span className={cx('tabular-nums whitespace-nowrap', full && 'font-semibold text-[#B54708]')} title={full ? 'Seat limit reached' : undefined}>{fmtSeats(c.activeUsers, c.maxUsers)}</span>
                </span>
              </td>
              {!compact && (
                <>
                  <td className={cx(td, 'text-right tabular-nums font-medium')}>{fmtNum(c.leads)}</td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden className="h-1.5 w-14 overflow-hidden rounded-full bg-[#EAF0F6]">
                        <span className="block h-full rounded-full bg-[#9db4cc]" style={{ width: `${Math.max(3, Math.round(((c.storageMB || 0) / maxMB) * 100))}%` }} />
                      </span>
                      <span className="tabular-nums whitespace-nowrap text-[13px] text-[#3F5A70]">{fmtMB(c.storageMB)}</span>
                    </span>
                  </td>
                </>
              )}
              <td className={cx(td, 'whitespace-nowrap text-[13px] text-[#5E778C]')}>{fmtDate(c.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
