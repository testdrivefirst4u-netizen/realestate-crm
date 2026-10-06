/**
 * Lead detail → Timeline tab. Reads `api.leads.timeline(id)` lazily (module-specific
 * read, allowed by the authoring guide) and re-fetches when the lead record changes.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  FileAudio,
  FileText,
  History,
  ListChecks,
  MessageCircle,
  MessageSquare,
  Paperclip,
  Pencil,
  Phone,
  RefreshCw,
  Send,
  Sparkles,
  Tag,
  Trophy,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { TimelineEntry } from '../../../types/crm';
import { api } from '../../../core/api';
import { compareDates, formatDateTime } from '../../../core/dates';
import { Button, EmptyState, ErrorState, LoadingState, cx } from '../../../components/ui';
import { useLazyResource } from '../shared';

const ICONS: Record<string, { icon: React.ReactNode; cls: string }> = {
  lead_created: { icon: <UserPlus size={13} />, cls: 'bg-[#A9825A]/15 text-[#86633E]' },
  stage_changed: { icon: <Tag size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  remark_added: { icon: <MessageSquare size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  followup_scheduled: { icon: <CalendarClock size={13} />, cls: 'bg-[#A9825A]/15 text-[#86633E]' },
  call: { icon: <Phone size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  call_recording: { icon: <FileAudio size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  call_transcript: { icon: <FileText size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  call_summary: { icon: <Sparkles size={13} />, cls: 'bg-[#A9825A]/15 text-[#86633E]' },
  chat_received: { icon: <MessageCircle size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  chat_sent: { icon: <Send size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  chat_linked: { icon: <MessageCircle size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  site_visit_scheduled: { icon: <CalendarCheck size={13} />, cls: 'bg-[#A9825A]/15 text-[#86633E]' },
  site_visit_completed: { icon: <CheckCircle2 size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  task_created: { icon: <ListChecks size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  task_completed: { icon: <CheckCircle2 size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  task_snoozed: { icon: <CalendarClock size={13} />, cls: 'bg-[#ECE8E1] text-[#6B5F57]' },
  document_added: { icon: <Paperclip size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  inventory: { icon: <Building2 size={13} />, cls: 'bg-[#1D2F3F]/10 text-[#1D2F3F]' },
  booking: { icon: <Trophy size={13} />, cls: 'bg-[#7C8B78]/20 text-[#3C573A]' },
  rm_assigned: { icon: <UserCheck size={13} />, cls: 'bg-[#A9825A]/15 text-[#86633E]' },
  lead_updated: { icon: <Pencil size={13} />, cls: 'bg-[#ECE8E1] text-[#6B5F57]' },
};
const DEFAULT_ICON = { icon: <CircleDot size={13} />, cls: 'bg-[#ECE8E1] text-[#6B5F57]' };

export const TimelineTab: React.FC<{ leadId: string; active: boolean; version?: string }> = ({ leadId, active, version }) => {
  const timeline = useLazyResource<TimelineEntry[]>(active, () => api.leads.timeline(leadId), 'leads.timeline');
  const [newestFirst, setNewestFirst] = useState(true);

  // The lead record changed (remark, stage, call…) → refresh an already-loaded timeline, debounced.
  const loaded = timeline.data !== null;
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => void timeline.reload(), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const entries = useMemo(() => {
    const list = [...(timeline.data || [])];
    list.sort((a, b) => compareDates(a.timestamp, b.timestamp, !newestFirst));
    return list;
  }, [timeline.data, newestFirst]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-[#6B5F57]">
          {timeline.data ? (
            <>
              <strong className="text-[#1D2F3F]">{entries.length}</strong> {entries.length === 1 ? 'event' : 'events'} across stages, remarks, calls, chats, tasks and files
            </>
          ) : (
            'Every change to this enquiry, in order'
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="xs" onClick={() => setNewestFirst((v) => !v)} icon={<ArrowUpDown size={11} />}>
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => void timeline.reload()} loading={timeline.loading} icon={<RefreshCw size={11} />} title="Refresh timeline">
            Refresh
          </Button>
        </div>
      </div>

      {timeline.loading && !timeline.data && <LoadingState label="Loading timeline…" className="py-8" />}
      {timeline.error && !timeline.data && <ErrorState compact title="Timeline could not load" message={timeline.error} onRetry={() => void timeline.reload()} />}
      {timeline.data && entries.length === 0 && (
        <EmptyState icon={<History size={20} />} title="No history yet" description="Stage changes, follow-ups, calls, WhatsApp messages, tasks and uploads will appear here as they happen." className="py-8" />
      )}

      {entries.length > 0 && (
        <ol className="relative border-l border-[#D2C9BF] ml-3 space-y-4 pl-5 py-1">
          {entries.map((e) => {
            const meta = ICONS[e.type] || DEFAULT_ICON;
            return (
              <li key={e.id} className="relative">
                <span className={cx('absolute -left-8 top-0.5 w-6 h-6 rounded-full flex items-center justify-center ring-4 ring-[#FDFCFA]', meta.cls)}>{meta.icon}</span>
                <div className="bg-white rounded-xl border border-[#D2C9BF] p-3 shadow-2xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-xs font-semibold text-[#1D2F3F] leading-snug">{e.title || e.type}</div>
                    <div className="text-[10px] text-[#9E948D] whitespace-nowrap">{formatDateTime(e.timestamp, '—')}</div>
                  </div>
                  {e.details && <div className="text-xs text-[#3D3530] mt-1 leading-relaxed whitespace-pre-wrap break-words">{e.details}</div>}
                  <div className="text-[10px] text-[#9E948D] mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <span className="uppercase tracking-wider font-bold">{e.type.replace(/_/g, ' ')}</span>
                    {e.actor && (
                      <>
                        <span>·</span>
                        <span>{e.actor}</span>
                      </>
                    )}
                    {e.refType && e.refId && e.refType !== 'Lead' && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{e.refId}</span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
