'use client';

import { useSearchParams } from 'next/navigation';
import { DocumentsView } from '@/src/modules/documents/DocumentsView';
import { useCrm } from '../_components/CrmShell';

export function DocumentsClient() {
  const { engine, openLead, openLibrary, on } = useCrm();
  const q = useSearchParams().get('q') || '';
  const { data } = engine;
  return (
    <DocumentsView
      documents={data.documents}
      leads={data.leads}
      onAddDocument={engine.saveDocument}
      onDeleteDocument={engine.deleteDocument}
      onOpenLibrary={on('projectLibrary') ? openLibrary : undefined}
      onOpenLead={openLead}
      initialQuery={q}
    />
  );
}
