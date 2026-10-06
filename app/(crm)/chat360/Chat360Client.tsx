'use client';

import { useRouter } from 'next/navigation';
import { Chat360View } from '@/src/modules/chat360/Chat360View';
import { viewHref } from '@/src/core/views';
import { useCrm } from '../_components/CrmShell';

export function Chat360Client() {
  const { engine, openLead, openCopilot, aiConfigured } = useCrm();
  const { data, currentUser } = engine;
  const router = useRouter();
  return (
    <Chat360View
      leads={data.leads}
      currentUser={currentUser}
      configured={!!data.serverSettings?.chat360Configured}
      canSend={engine.can('chat.send')}
      onOpenLead={openLead}
      onAddTask={engine.addTask}
      onAppendRemark={engine.appendRemark}
      onUpdateLead={engine.updateLead}
      onGoToSettings={() => router.push(viewHref('settings'))}
      onAddLead={engine.addLead}
      templates={data.templates}
      aiEnabled={aiConfigured && engine.can('ai.use')}
      onOpenCopilot={openCopilot}
    />
  );
}
