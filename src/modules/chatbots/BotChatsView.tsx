/** Bot Chats (server: modules/webchat.ts botChatsList): website + Instagram/Facebook chatbot conversations — who they were with, what was captured, and the transcript. */
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Facebook, Globe, Instagram, MessagesSquare } from 'lucide-react';
import { api, type BotChatRow } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Badge, Card, EmptyState, InlineNotice, LoadingState } from '../../components/ui';

const CHANNEL: Record<BotChatRow['channel'], { label: string; icon: React.ElementType }> = {
  website: { label: 'Website', icon: Globe },
  instagram: { label: 'Instagram', icon: Instagram },
  facebook: { label: 'Facebook', icon: Facebook },
};
const STATUS: Record<BotChatRow['status'], { label: string; tone: 'sage' | 'amber' | 'muted' }> = {
  active: { label: 'Active', tone: 'sage' },
  done: { label: 'Completed', tone: 'muted' },
  handoff: { label: 'Needs a person', tone: 'amber' },
  stopped: { label: 'Stopped', tone: 'muted' },
};
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export const BotChatsView: React.FC = () => {
  const [rows, setRows] = useState<BotChatRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => {
    let on = true;
    api.botChats.list().then((r) => on && setRows(r)).catch((e) => on && setErr(toAppError(reportError('botChats.list', e)).userMessage));
    return () => { on = false; };
  }, []);

  if (err) return <InlineNotice tone="warning">{err}</InlineNotice>;
  if (!rows) return <LoadingState />;
  if (!rows.length) return <EmptyState icon={<MessagesSquare size={28} />} title="No bot chats yet" description="When your chatbot talks to visitors on your website, Instagram or Facebook, the conversations show up here." />;

  return (
    <div className="space-y-2">
      {rows.map((c) => {
        const Ch = CHANNEL[c.channel];
        const st = STATUS[c.status];
        const isOpen = open === c.id;
        const captured = Object.entries(c.captured || {}).filter(([, v]) => v);
        return (
          <Card key={c.id} padded={false} className="overflow-hidden">
            <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#F7FAFC]" onClick={() => setOpen(isOpen ? '' : c.id)}>
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#EEF3F7] text-[#3E5A70]"><Ch.icon size={16} aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-[#0B2A44]">{c.who}</span><Badge tone={st.tone}>{st.label}</Badge></span>
                <span className="mt-0.5 block truncate text-xs text-[#5E778C]">{Ch.label} · {c.messages} messages · {when(c.lastAt)}{c.leadId ? ' · lead created' : ''}</span>
              </span>
              {isOpen ? <ChevronDown size={16} className="flex-none text-[#7E93A6]" /> : <ChevronRight size={16} className="flex-none text-[#7E93A6]" />}
            </button>
            {isOpen && (
              <div className="border-t border-[#E3EDF5] bg-[#F7FAFC] px-4 py-3">
                {captured.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {captured.map(([k, v]) => (
                      <span key={k} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-[#3E5A70] ring-1 ring-[#E3EDF5]"><span className="font-semibold capitalize">{k}:</span> {v}</span>
                    ))}
                    {c.leadId && <span className="rounded-full bg-[#E7F6EE] px-2 py-0.5 text-[11px] font-semibold text-[#067647]">Lead created</span>}
                  </div>
                )}
                <div className="space-y-1.5">
                  {c.transcript.map((t, i) => (
                    <div key={i} className={`max-w-[80%] break-words rounded-lg px-3 py-1.5 text-[13px] ${t.role === 'user' ? 'ml-auto bg-[#DCF5E6] text-[#06361f]' : 'bg-white text-[#0B2A44] ring-1 ring-[#E3EDF5]'}`}>{t.text}</div>
                  ))}
                  {!c.transcript.length && <p className="text-xs text-[#7E93A6]">No messages recorded.</p>}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
};
