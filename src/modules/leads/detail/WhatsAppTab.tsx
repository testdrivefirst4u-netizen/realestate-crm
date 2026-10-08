/**
 * Lead detail → WhatsApp tab: Chat360 conversation for the lead's phone number
 * (api.chat360.messages / api.chat360.send). Falls back to a wa.me link when
 * Chat360 is not configured. "Suggest a reply" opens the AI Copilot with the
 * latest messages as context.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCheck, Clock, MessageCircle, MessageSquare, RefreshCw, Send, Sparkles } from 'lucide-react';
import { CRMSettings, Chat360Message, Lead, UserAccount } from '../../../types/crm';
import { F } from '../../../core/config';
import { api } from '../../../core/api';
import { compareDates, dateKey, formatDate, formatDateTime, formatTime } from '../../../core/dates';
import { fillTemplate, formatPhone, toE164Digits, whatsappLink } from '../../../core/phone';
import { reportError } from '../../../core/errors';
import { truncate } from '../../../core/format';
import { Button, EmptyState, ErrorState, InlineNotice, cx, inputCls } from '../../../components/ui';
import type { OpenCopilot } from '../../ai/copilotContext';
import { useLazyResource } from '../shared';
import { useCompany, useFeature } from '../../../core/tenant';
import { ChatSkeleton } from '../../../components/Skeletons';

interface Props {
  lead: Lead;
  active: boolean;
  chatEnabled: boolean;
  settings: CRMSettings;
  currentUser: UserAccount | null;
  onChanged?: () => void;
  /** Opens the AI Copilot with this conversation as context (hidden when absent). */
  onOpenCopilot?: OpenCopilot;
}

/** Messages handed to the Copilot as the conversation so far. */
const COPILOT_MESSAGES = 5;

/** The latest messages as plain text for the Copilot's context note. */
function conversationNote(messages: Chat360Message[], prospect: string, business = 'Amaya'): string {
  const recent = messages.slice(-COPILOT_MESSAGES);
  if (!recent.length) return 'No WhatsApp messages have been exchanged with this prospect yet.';
  const lines = recent.map((m) => {
    const who = m.direction === 'Outbound' ? `${business}${m.agent ? ` (${m.agent})` : ''}` : prospect || 'Prospect';
    const body = String(m.text || '').trim() || `[${m.messageType || 'attachment'}]`;
    return `[${formatDateTime(m.timestamp, 'undated')}] ${who}: ${truncate(body, 500)}`;
  });
  return `Last ${recent.length} WhatsApp ${recent.length === 1 ? 'message' : 'messages'}, oldest first:\n${lines.join('\n')}`;
}

export const WhatsAppTab: React.FC<Props> = ({ lead, active, chatEnabled, settings, currentUser, onChanged, onOpenCopilot }) => {
  const projectLibrary = useFeature('projectLibrary');
  const company = useCompany();
  const business = projectLibrary ? 'Amaya' : company?.name || 'Us';
  const id = String(lead[F.ID]);
  const phone = String(lead[F.PHONE] || '');
  const name = String(lead[F.NAME] || '');
  const waText = fillTemplate(settings.waTemplate, { name, rm: currentUser?.name || String(lead[F.RM] || '') });

  const chat = useLazyResource<Chat360Message[]>(active && chatEnabled && !!phone, () => api.chat360.messages(phone), 'leads.chatMessages');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const messages = useMemo(() => [...(chat.data || [])].sort((a, b) => compareDates(a.timestamp, b.timestamp, true)), [chat.data]);

  // Keep the newest message in view (scroll the list only, not the whole drawer).
  useEffect(() => {
    const el = listRef.current;
    if (active && messages.length && el) el.scrollTop = el.scrollHeight;
  }, [active, messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await api.chat360.send({ leadId: id, phone, text });
      chat.setData((prev) => [...(prev || []), res.message]);
      setDraft('');
      onChanged?.();
    } catch (e) {
      setSendError(reportError('leads.chatSend', e).userMessage);
    } finally {
      setSending(false);
    }
  };

  if (!chatEnabled) {
    return (
      <div className="space-y-3">
        <InlineNotice tone="warning">Chat360 is not configured — ask an admin (Settings → Integrations).</InlineNotice>
        {phone && (
          <div className="bg-white rounded-xl border border-[#D2C9BF] p-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-[#6B5F57]">
              You can still message <strong className="text-[#1D2F3F]">{name || formatPhone(phone)}</strong> from your own WhatsApp.
            </div>
            <a href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#25D366] text-white hover:brightness-105">
              <MessageSquare size={13} /> Open WhatsApp
            </a>
          </div>
        )}
      </div>
    );
  }

  if (!phone) return <InlineNotice tone="warning">This enquiry has no phone number, so there is no WhatsApp conversation to show. Add the number under Details.</InlineNotice>;

  const askCopilot = () =>
    onOpenCopilot?.(messages.length ? 'Suggest a reply' : 'Suggest an opening WhatsApp message', {
      view: 'chat',
      leadId: id,
      chatPhone: toE164Digits(phone),
      note: conversationNote(messages, name, business),
    });

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 420 }}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-[#6B5F57]">
          Conversation with <strong className="text-[#1D2F3F]">{formatPhone(phone)}</strong>
          {chat.data && ` · ${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenCopilot && (
            <Button
              variant="secondary"
              size="xs"
              onClick={askCopilot}
              disabled={!chat.data}
              icon={<Sparkles size={11} className="text-[#A9825A]" />}
              title="Ask the Copilot to draft a reply from the latest messages — you review it before sending"
            >
              {messages.length ? 'Suggest a reply' : 'Draft an opener'}
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => void chat.reload()} loading={chat.loading} icon={<RefreshCw size={11} />}>
            Refresh
          </Button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 bg-[#EFE9E1] rounded-xl border border-[#D2C9BF] p-3 overflow-y-auto max-h-[52vh] space-y-2">
        {chat.loading && !chat.data && <ChatSkeleton className="py-4" />}
        {chat.error && !chat.data && <ErrorState compact title="Messages could not load" message={chat.error} onRetry={() => void chat.reload()} />}
        {chat.data && messages.length === 0 && <EmptyState icon={<MessageCircle size={20} />} title="No messages yet" description="Send the first message below. Replies arrive here automatically through the Chat360 webhook." className="py-8" />}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || dateKey(prev.timestamp) !== dateKey(m.timestamp);
          const out = m.direction === 'Outbound';
          return (
            <React.Fragment key={m.id || `${m.timestamp}_${i}`}>
              {newDay && (
                <div className="flex justify-center py-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#6B5F57] bg-white/70 rounded-full px-2.5 py-0.5">{formatDate(m.timestamp, '—')}</span>
                </div>
              )}
              <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[80%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-2xs', out ? 'bg-[#DCF3D3] text-[#1D2F3F] rounded-br-sm' : 'bg-white text-[#1D2F3F] rounded-bl-sm')}>
                  {m.mediaUrl && (
                    <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="block text-[11px] font-semibold text-[#1976D2] hover:underline mb-1">
                      Attachment{m.messageType ? ` (${m.messageType})` : ''}
                    </a>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className={cx('mt-1 flex items-center gap-1 text-[10px]', out ? 'justify-end text-[#5B7A52]' : 'text-[#9E948D]')}>
                    {out && m.agent && <span className="mr-1">{m.agent}</span>}
                    <span>{formatTime(m.timestamp)}</span>
                    {out && <StatusTick status={m.status} />}
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {sendError && <InlineNotice tone="warning">{sendError}</InlineNotice>}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={`Message ${name || formatPhone(phone)}… (Enter to send, Shift+Enter for a new line)`}
          className={cx(inputCls, 'resize-none')}
        />
        <Button variant="sage" onClick={() => void send()} loading={sending} disabled={!draft.trim()} icon={<Send size={13} />} className="h-[38px]">
          Send
        </Button>
      </div>
      <div className="flex items-center justify-between text-[10px] text-[#9E948D]">
        <span>Sent via Chat360 · logged on the lead timeline</span>
        <button type="button" onClick={() => setDraft((d) => (d.trim() ? d : waText))} className="hover:text-[#1D2F3F]">
          Insert greeting template
        </button>
      </div>
    </div>
  );
};

const StatusTick: React.FC<{ status?: string }> = ({ status }) => {
  const s = String(status || '').toLowerCase();
  if (s === 'read') return <CheckCheck size={11} className="text-[#1976D2]" />;
  if (s === 'delivered') return <CheckCheck size={11} />;
  if (s === 'sent' || s === 'accepted') return <Check size={11} />;
  if (s === 'failed') return <span className="text-[#8A3E28] font-semibold">failed</span>;
  return <Clock size={10} />;
};
