'use client';

import { SegmentsView } from '@/src/modules/segments/SegmentsView';
import { useCrm } from '../_components/CrmShell';

export function SegmentsClient() {
  const { engine, openLead } = useCrm();
  const { data } = engine;
  return (
    <SegmentsView
      segments={data.segments || []}
      leads={data.leads}
      config={data.config}
      onOpenLead={openLead}
      onCreateSegment={engine.createSegment}
      onUpdateSegment={engine.updateSegment}
      onDeleteSegment={engine.deleteSegment}
    />
  );
}
