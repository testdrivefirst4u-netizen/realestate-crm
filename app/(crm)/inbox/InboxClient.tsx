'use client';

import { useSearchParams } from 'next/navigation';
import { InboxView } from '@/src/modules/inbox/InboxView';
import { useCrm } from '../_components/CrmShell';

export function InboxClient() {
  const { engine, openLead } = useCrm();
  const thread = useSearchParams().get('thread');
  return <InboxView canReply={engine.can('chat.send')} canCreateLead={engine.can('leads.create')} onOpenLead={openLead} initialThread={thread} />;
}
