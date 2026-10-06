'use client';

import { useMemo } from 'react';
import { LeadsView } from '@/src/modules/leads/LeadsView';
import { F } from '@/src/core/config';
import { useCrm } from '../_components/CrmShell';

export function LeadsClient() {
  const { engine, openLead, openAddLead, leadFilter, clearLeadFilter } = useCrm();
  const { data, sync } = engine;
  const leads = useMemo(() => (leadFilter ? data.leads.filter((l) => leadFilter.ids.has(l[F.ID])) : data.leads), [data.leads, leadFilter]);
  return (
    <LeadsView
      leads={leads}
      config={data.config}
      onOpenLead={openLead}
      activeFilterLabel={leadFilter?.label || null}
      onClearActiveFilter={clearLeadFilter}
      canExport={engine.can('leads.export')}
      onOpenAddLead={openAddLead}
      sync={sync}
    />
  );
}
