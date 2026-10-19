'use client';

import { F } from '@/src/core/config';
import { MisView } from '@/src/modules/mis/MisView';
import { useCrm } from '../_components/CrmShell';

export function MisClient() {
  const { engine, showLeads, on } = useCrm();
  const { data, sync } = engine;
  return (
    <MisView
      leads={data.leads}
      sources={data.config.options[F.SOURCE] || []}
      sync={sync}
      canSeeCalls={on('calls') && engine.can('calls.view')}
      onRefresh={() => engine.refresh({ silent: false, force: true })}
      onShowLeads={showLeads}
      canSeeSpend={engine.can('reports.view')}
      canEditSpend={engine.can('settings.edit')}
    />
  );
}
