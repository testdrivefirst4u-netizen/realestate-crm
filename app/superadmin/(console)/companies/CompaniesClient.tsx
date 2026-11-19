'use client';
import { useEffect, useState } from 'react';
import { Building2, Plus, Search } from 'lucide-react';
import { SECTORS } from '@/src/core/features';
import { call, useResource } from '../../_lib/api';
import { CompaniesTable } from '../../_components/CompaniesTable';
import { Card, EmptyState, ErrorBox, LinkButton, PageHeader, TableSkeleton, cx, toolbarControl } from '../../_components/ui';

type StatusFilter = '' | 'Active' | 'Suspended';

export function CompaniesClient() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [sector, setSector] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useResource(() => call('listCompanies', { q: debounced || undefined, status }), [debounced, status]);
  const plans = useResource(() => call('listPlans', {}), []);
  const filtered = Boolean(debounced || status || sector);
  const rows = list.data ? (sector ? list.data.filter((c) => (c.sector || 'realestate') === sector) : list.data) : list.data;

  return (
    <>
      <PageHeader eyebrow="Customers" icon={<Building2 className="h-6 w-6" />}
        title="Companies"
        description="Every tenant workspace on the platform."
        actions={
          <LinkButton href="/superadmin/companies/new" icon={<Plus className="h-4 w-4" aria-hidden />}>
            New company
          </LinkButton>
        }
      />

      <Card>
        <div role="search" className="flex flex-col gap-3 border-b border-[#E3EDF5] p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <label htmlFor="co-search" className="sr-only">
              Search companies
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7E93A6]" aria-hidden />
            <input
              id="co-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, slug or contact e-mail"
              className={cx(toolbarControl, 'pl-9')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Sector" value={sector} onChange={(e) => setSector(e.target.value)} className={cx(toolbarControl, 'w-44')}>
              <option value="">All sectors</option>
              {SECTORS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={cx(toolbarControl, 'w-36')}>
              <option value="">All statuses</option>
              <option value="Active">Active</option>
              <option value="Suspended">Suspended</option>
            </select>
          </div>
        </div>

        {list.error && <ErrorBox message={list.error} onRetry={list.reload} className="m-4" />}
        <div aria-live="polite" className="sr-only">
          {rows && !list.loading ? `${rows.length} ${rows.length === 1 ? 'company' : 'companies'}` : ''}
        </div>

        {!rows && list.loading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : rows && rows.length > 0 ? (
          <div className={cx('transition-opacity', list.loading && 'opacity-60')}>
            <CompaniesTable companies={rows} plans={plans.data} />
            <p className="border-t border-[#E3EDF5] px-4 py-3 text-[13px] text-[#5E778C]">
              {rows.length} {rows.length === 1 ? 'company' : 'companies'}
            </p>
          </div>
        ) : rows ? (
          filtered ? (
            <EmptyState icon={<Search className="h-5 w-5" aria-hidden />} title="No matching companies" description="Try a different search term or status filter." />
          ) : (
            <EmptyState
              icon={<Building2 className="h-5 w-5" aria-hidden />}
              title="No companies yet"
              description="Create the first company to give its team a CRM workspace."
              action={
                <LinkButton href="/superadmin/companies/new" icon={<Plus className="h-4 w-4" aria-hidden />}>
                  New company
                </LinkButton>
              }
            />
          )
        ) : null}
      </Card>
    </>
  );
}
