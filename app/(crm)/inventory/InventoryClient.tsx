'use client';

import { InventoryView } from '@/src/modules/inventory/InventoryView';
import { useCrm } from '../_components/CrmShell';

export function InventoryClient() {
  const { engine, openLead } = useCrm();
  const { data, sync } = engine;
  return (
    <InventoryView
      inventory={data.inventory}
      leads={data.leads}
      sync={sync}
      canEdit={engine.can('inventory.edit')}
      onUpdateUnit={engine.updateUnit}
      onAddUnit={engine.addUnit}
      onImportInventory={engine.importInventory}
      onRefresh={() => engine.refresh({ silent: true, force: true })}
      onOpenLead={openLead}
    />
  );
}
