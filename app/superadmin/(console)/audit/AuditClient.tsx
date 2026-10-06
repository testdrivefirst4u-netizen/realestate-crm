'use client';
import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { call, useResource } from '../../_lib/api';
import { AuditTable } from '../../_components/AuditTable';
import { Button, Card, ErrorBox, PageHeader, cx, toolbarControl } from '../../_components/ui';

const LIMITS = [50, 100, 200, 500];

export function AuditClient() {
  const [limit, setLimit] = useState(100);
  const [q, setQ] = useState('');
  const audit = useResource(() => call('auditLog', { limit }), [limit]);
  const companies = useResource(() => call('listCompanies', {}), []);

  const names = useMemo(() => Object.fromEntries((companies.data || []).map((c) => [c.id, c.name])), [companies.data]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!audit.data || !term) return audit.data;
    return audit.data.filter((e) => [e.actor, e.action, e.companyId, names[e.companyId] || '', e.details].some((v) => v.toLowerCase().includes(term)));
  }, [audit.data, q, names]);

  return (
    <>
      <PageHeader title="Audit log" description="Every change made from this console. Times are shown in IST (Asia/Kolkata)." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-[#EFE9E2] p-4 sm:flex-row sm:items-center">
          <div role="search" className="relative flex-1">
            <label htmlFor="audit-filter" className="sr-only">
              Filter entries
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9A8F84]" aria-hidden />
            <input id="audit-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by actor, action, company or details" className={cx(toolbarControl, 'pl-9')} />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="audit-limit" className="text-[13px] font-medium whitespace-nowrap text-[#3B342E]">
              Show
            </label>
            <select id="audit-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={cx(toolbarControl, 'w-32')}>
              {LIMITS.map((l) => (
                <option key={l} value={l}>
                  Last {l}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={audit.reload} loading={audit.loading && Boolean(audit.data)} icon={<RefreshCw className="h-4 w-4" aria-hidden />} aria-label="Refresh audit log">
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
        <ErrorBox message={audit.error} onRetry={audit.reload} className="m-4" />
        <div className={cx('transition-opacity', audit.loading && audit.data && 'opacity-60')}>
          <AuditTable entries={filtered} loading={audit.loading} companyNames={names} />
        </div>
        {filtered && audit.data && (
          <p aria-live="polite" className="border-t border-[#EFE9E2] px-4 py-3 text-[13px] text-[#7A6F64]">
            {q.trim() ? `${filtered.length} of ${audit.data.length} entries` : `${audit.data.length} entries`}
          </p>
        )}
      </Card>
    </>
  );
}
