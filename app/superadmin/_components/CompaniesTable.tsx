'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CompanySummary, Plan } from '@/server/platform/contract';
import { fmtDate, fmtMB, fmtNum, fmtSeats, planName } from '../_lib/format';
import { Pill, StatusBadge, Table, cx, focusRing, td, th } from './ui';

/** Companies table — rows link to the detail page (the name is a real link for keyboard users). */
export function CompaniesTable({ companies, plans, compact = false }: { companies: CompanySummary[]; plans: Plan[] | null; compact?: boolean }) {
  const router = useRouter();
  return (
    <Table label="Companies">
      <thead className="bg-[#FBF9F6]">
        <tr className="border-b border-[#EFE9E2]">
          <th scope="col" className={th}>
            Company
          </th>
          <th scope="col" className={th}>
            Plan
          </th>
          <th scope="col" className={cx(th, 'text-right')}>
            Users
          </th>
          {!compact && (
            <>
              <th scope="col" className={cx(th, 'text-right')}>
                Leads
              </th>
              <th scope="col" className={cx(th, 'text-right')}>
                Storage
              </th>
            </>
          )}
          <th scope="col" className={th}>
            Status
          </th>
          <th scope="col" className={th}>
            Created
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {companies.map((c) => {
          const href = `/superadmin/companies/${encodeURIComponent(c.id)}`;
          const full = c.maxUsers > 0 && c.activeUsers >= c.maxUsers;
          return (
            <tr key={c.id} onClick={() => router.push(href)} className="cursor-pointer transition-colors hover:bg-[#FBF9F6]">
              <td className={td}>
                <Link href={href} onClick={(e) => e.stopPropagation()} className={cx('block rounded font-medium text-[#14202B] hover:underline underline-offset-2', focusRing)}>
                  {c.name}
                </Link>
                <span className="font-mono text-[12.5px] text-[#7A6F64]">{c.slug}</span>
              </td>
              <td className={td}>
                <Pill>{planName(plans, c.plan)}</Pill>
              </td>
              <td className={cx(td, 'whitespace-nowrap text-right tabular-nums', full && 'text-[#B54708]')} title={full ? 'Seat limit reached' : undefined}>
                {fmtSeats(c.activeUsers, c.maxUsers)}
              </td>
              {!compact && (
                <>
                  <td className={cx(td, 'text-right tabular-nums')}>{fmtNum(c.leads)}</td>
                  <td className={cx(td, 'whitespace-nowrap text-right tabular-nums')}>{fmtMB(c.storageMB)}</td>
                </>
              )}
              <td className={td}>
                <StatusBadge status={c.status} />
              </td>
              <td className={cx(td, 'whitespace-nowrap text-[13.5px] text-[#5E554D]')}>{fmtDate(c.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
