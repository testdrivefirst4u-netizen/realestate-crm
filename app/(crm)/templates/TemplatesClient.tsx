'use client';

import { useSearchParams } from 'next/navigation';
import { TemplatesView } from '@/src/modules/templates/TemplatesView';
import { useCrm } from '../_components/CrmShell';

export function TemplatesClient() {
  const { engine } = useCrm();
  const { data, currentUser } = engine;
  const q = useSearchParams().get('q') || '';
  return (
    <TemplatesView
      templates={data.templates}
      onAddTemplate={engine.saveTemplate}
      onUpdateTemplate={(id, patch) => engine.saveTemplate({ id, ...patch })}
      onDeleteTemplate={engine.deleteTemplate}
      currentUser={currentUser}
      initialQuery={q}
    />
  );
}
