'use client';
import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import type { PlatformAuditEntry } from '@/server/platform/contract';
import { fmtDateTime } from '../_lib/format';
import { EmptyState, Table, TableSkeleton, cx, focusRing, td, th } from './ui';

export function AuditTable({
  entries,
  loading,
  companyNames,
  hideCompany = false,
  compact = false,
}: {
  entries: PlatformAuditEntry[] | null;
  loading?: boolean;
  companyNames?: Record<string, string>;
  hideCompany?: boolean;
  compact?: boolean;
}) {
  if (loading && !entries) return <TableSkeleton rows={compact ? 4 : 8} cols={hideCompany ? 4 : 5} />;
  if (!entries || entries.length === 0)
    return <EmptyState icon={<ScrollText className="h-5 w-5" aria-hidden />} title="No audit entries yet" description="Actions taken in the console will appear here." />;

  return (
    <Table label="Audit log">
      <thead className="bg-[#FBF9F6]">
        <tr className="border-b border-[#EFE9E2]">
          <th scope="col" className={th}>
            Time (IST)
          </th>
          <th scope="col" className={th}>
            Actor
          </th>
          <th scope="col" className={th}>
            Action
          </th>
          {!hideCompany && (
            <th scope="col" className={th}>
              Company
            </th>
          )}
          <th scope="col" className={th}>
            Details
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {entries.map((e) => (
          <tr key={e.id} className="hover:bg-[#FBF9F6]">
            <td className={cx(td, 'whitespace-nowrap text-[13px] text-[#5E554D] tabular-nums')}>{fmtDateTime(e.timestamp)}</td>
            <td className={cx(td, 'max-w-[220px] text-[13.5px]')}>
              <span className="block truncate" title={e.actor}>
                {e.actor || '—'}
              </span>
            </td>
            <td className={td}>
              <code className="rounded bg-[#F4EEE7] px-1.5 py-0.5 text-[12.5px] text-[#6B4F33]">{e.action}</code>
            </td>
            {!hideCompany && (
              <td className={cx(td, 'whitespace-nowrap text-[13.5px]')}>
                {e.companyId ? (
                  <Link href={`/superadmin/companies/${encodeURIComponent(e.companyId)}`} className={cx('rounded text-[#1D2F3F] underline-offset-2 hover:underline', focusRing)}>
                    {companyNames?.[e.companyId] || e.companyId}
                  </Link>
                ) : (
                  <span className="text-[#9A8F84]">—</span>
                )}
              </td>
            )}
            <td className={cx(td, 'min-w-[200px] text-[13.5px] text-[#4A423B]', compact && 'max-w-[320px]')}>
              <span className={cx('block safe-text-wrap', compact && 'line-clamp-2')} title={e.details}>
                {e.details || '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
