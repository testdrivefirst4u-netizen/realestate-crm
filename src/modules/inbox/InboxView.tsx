/**
 * Social inbox (/inbox, plan feature socialInbox; server: modules/socialInbox.ts): Facebook / Instagram comments
 * and messages and Google reviews in one list; open a conversation, answer it, or turn it into a lead.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Inbox, MessageSquare, RefreshCw, Send, Star, UserPlus } from 'lucide-react';
import { api, type InboxMessage, type InboxPlatform, type InboxThread } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { phoneProblem } from '../../core/phone';
import { Button, EmptyState, Field, Modal, Tabs, cx, inputCls } from '../../components/ui';

type Filter = 'all' | 'message' | 'comment' | 'review';
const PLATFORM: Record<InboxPlatform, { label: string; dot: string; short: string }> = {
  facebook: { label: 'Facebook', dot: 'bg-[#1877F2]', short: 'f' },
  instagram: { label: 'Instagram', dot: 'bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF]', short: 'ig' },
  google: { label: 'Google', dot: 'bg-[#34A853]', short: 'G' },
};
const KIND: Record<string, string> = { message: 'Message', comment: 'Comment', review: 'Review' };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

const Stars: React.FC<{ n?: number }> = ({ n }) => (n ? (
  <span className="inline-flex items-center gap-0.5" aria-label={`${n} stars`}>
    {Array.from({ length: 5 }, (_, i) => <Star key={i} size={11} className={i < n ? 'fill-[#F5A524] text-[#F5A524]' : 'text-[#C9D6E2]'} />)}
  </span>
) : null);

const Badge: React.FC<{ p: InboxPlatform }> = ({ p }) => (
  <span className={cx('inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white', PLATFORM[p].dot)} title={PLATFORM[p].label}>{PLATFORM[p].short}</span>
);

export const InboxView: React.FC<{ canReply: boolean; canCreateLead: boolean; onOpenLead: (id: string) => void; initialThread?: string | null }> = ({ canReply, canCreateLead, onOpenLead, initialThread }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [platform, setPlatform] = useState<InboxPlatform | ''>('');
  const [threads, setThreads] = useState<InboxThread[] | null>(null);
  const [active, setActive] = useState<string | null>(initialThread || null);
  const [items, setItems] = useState<InboxMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [leadFor, setLeadFor] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await api.inbox.list({ platform, kind: filter === 'all' ? '' : filter });
      setThreads(r.threads);
    } catch (e) {
      setThreads((t) => t || []);
      toast('Could not load the inbox', errText('inbox.list', e), 'alert');
    }
  }, [platform, filter]);
  useEffect(() => {
    void loadList();
    const t = setInterval(() => void loadList(), 30000);
    return () => clearInterval(t);
  }, [loadList]);

  const loadThread = useCallback(async (id: string) => {
    try {
      setItems((await api.inbox.thread(id)).items);
      setThreads((ts) => ts?.map((t) => (t.thread === id ? { ...t, unread: 0 } : t)) || ts);
    } catch (e) {
      toast('Could not open the conversation', errText('inbox.thread', e), 'alert');
    }
  }, []);
  useEffect(() => {
    if (active) void loadThread(active);
    else setItems([]);
  }, [active, loadThread]);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [items]);

  const current = useMemo(() => threads?.find((t) => t.thread === active) || null, [threads, active]);
  const leadId = items.find((i) => i.leadId)?.leadId || current?.leadId || '';
  const first = items.find((i) => i.direction === 'in');

  const send = async () => {
    if (!active || !reply.trim()) return;
    setSending(true);
    try {
      await api.inbox.reply(active, reply.trim());
      setReply('');
      await loadThread(active);
      void loadList();
    } catch (e) {
      toast('Reply not sent', errText('inbox.reply', e), 'alert');
    } finally {
      setSending(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.inbox.refresh();
      if (r.reviews) toast(`${r.reviews} new Google review${r.reviews === 1 ? '' : 's'}`, undefined, 'success');
      await loadList();
    } catch (e) {
      toast('Could not refresh', errText('inbox.refresh', e), 'alert');
    } finally {
      setRefreshing(false);
    }
  };
  const createLead = async () => {
    if (!active || !leadFor) return;
    const bad = leadFor.phone ? phoneProblem(leadFor.phone) : 'Enter the phone number';
    if (bad) return toast('Check the phone number', bad, 'alert');
    setCreating(true);
    try {
      const r = await api.inbox.createLead({ thread: active, ...leadFor });
      setLeadFor(null);
      toast('Lead created', r.leadId, 'success');
      await loadThread(active);
      void loadList();
      onOpenLead(r.leadId);
    } catch (e) {
      toast('Could not create the lead', errText('inbox.lead', e), 'alert');
    } finally {
      setCreating(false);
    }
  };

  const list = (
    <div className={cx('flex flex-col min-h-0 border-r border-[#E3EDF5] bg-white', active ? 'hidden lg:flex' : 'flex', 'lg:w-[360px] w-full')}>
      <div className="p-3 space-y-2 border-b border-[#EEF4F9]">
        <div className="flex items-center gap-2">
          <Tabs<Filter> value={filter} onChange={setFilter} tabs={[{ id: 'all', label: 'All' }, { id: 'message', label: 'Messages' }, { id: 'comment', label: 'Comments' }, { id: 'review', label: 'Reviews' }]} />
          <button type="button" onClick={() => void refresh()} aria-label="Refresh" className="ml-auto h-9 w-9 inline-flex items-center justify-center rounded-lg text-[#5E778C] hover:bg-[#F2F7FB]"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /></button>
        </div>
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value as InboxPlatform | '')} aria-label="Platform">
          <option value="">Every platform</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
          <option value="google">Google reviews</option>
        </select>
      </div>
      <ul className="flex-1 overflow-y-auto divide-y divide-[#EEF4F9]">
        {threads === null ? <li className="p-6 text-center text-xs text-[#7E93A6]">Loading…</li> : !threads.length ? (
          <li className="p-6"><EmptyState icon={<Inbox size={22} />} title="Nothing here yet" description="New Facebook and Instagram comments and messages, and Google reviews, arrive here." /></li>
        ) : threads.map((t) => (
          <li key={t.thread}>
            <button type="button" onClick={() => setActive(t.thread)} className={cx('w-full text-left px-3 py-2.5 flex gap-2.5 hover:bg-[#F7FAFD]', active === t.thread && 'bg-[#EEF5FC]')}>
              <Badge p={t.platform} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <b className={cx('truncate text-[13px]', t.unread ? 'text-[#0B2A44]' : 'text-[#2B4A63] font-semibold')}>{t.authorName || PLATFORM[t.platform].label}</b>
                  <Stars n={t.rating} />
                  <span className="ml-auto text-[11px] text-[#7E93A6] flex-shrink-0">{ago(t.at)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={cx('truncate text-xs', t.unread ? 'text-[#0B2A44] font-medium' : 'text-[#5E778C]')}>{t.text || '—'}</span>
                  {t.unread > 0 && <span className="ml-auto h-2 w-2 rounded-full bg-[#1E6FB0] flex-shrink-0" aria-label="unread" />}
                </span>
                <span className="text-[10.5px] text-[#7E93A6]">{KIND[t.kind]}{t.leadId ? ' · lead ' + t.leadId : ''}{t.answered ? ' · answered' : ''}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const pane = active ? (
    <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-[#F7FAFD]">
      <div className="px-3 sm:px-4 py-2.5 border-b border-[#E3EDF5] bg-white flex flex-wrap items-center gap-2">
        <button type="button" className="lg:hidden h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-[#F2F7FB]" onClick={() => setActive(null)} aria-label="Back"><ArrowLeft size={16} /></button>
        {current && <Badge p={current.platform} />}
        <span className="min-w-0 flex-1">
          <b className="block truncate text-sm text-[#0B2A44]">{first?.authorName || current?.authorName || 'Conversation'}</b>
          <span className="text-[11px] text-[#7E93A6]">{current ? `${PLATFORM[current.platform].label} ${KIND[current.kind].toLowerCase()}` : ''}</span>
        </span>
        {leadId ? (
          <Button variant="secondary" size="sm" icon={<ExternalLink size={13} />} onClick={() => onOpenLead(leadId)}>Open lead {leadId}</Button>
        ) : canCreateLead && first ? (
          <Button variant="secondary" size="sm" icon={<UserPlus size={13} />} onClick={() => setLeadFor({ name: (first.authorName || '').replace(/^@/, ''), phone: '', email: '' })}>Create lead</Button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2">
        {items.map((m) => (
          <div key={m.id} className={cx('max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-2xs', m.direction === 'out' ? 'ml-auto bg-[#1E6FB0] text-white' : 'bg-white text-[#0B2A44] border border-[#E3EDF5]')}>
            {m.direction === 'in' && <span className="flex items-center gap-2 text-[11px] font-semibold text-[#5E778C] mb-0.5">{m.authorName || 'Customer'} <Stars n={m.rating} /></span>}
            <span className="whitespace-pre-wrap break-words">{m.text || <i className="opacity-70">(no text)</i>}</span>
            <span className={cx('block text-[10.5px] mt-1', m.direction === 'out' ? 'text-white/75' : 'text-[#7E93A6]')}>{new Date(m.at).toLocaleString()}{m.by ? ` · ${m.by}` : ''}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {canReply && (
        <div className="p-3 border-t border-[#E3EDF5] bg-white flex gap-2 items-end">
          <textarea className={cx(inputCls, 'min-h-[42px] max-h-40 text-sm')} rows={2} value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)}
            placeholder={current?.kind === 'review' ? 'Reply publicly to the review…' : current?.kind === 'comment' ? 'Reply publicly to the comment…' : 'Write a message…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} aria-label="Reply" />
          <Button variant="primary" icon={<Send size={14} />} loading={sending} disabled={!reply.trim()} onClick={() => void send()}>Send</Button>
        </div>
      )}
    </div>
  ) : (
    <div className="hidden lg:flex flex-1 items-center justify-center text-sm text-[#7E93A6] gap-2"><MessageSquare size={18} /> Choose a conversation</div>
  );

  return (
    <div className="p-0 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="flex h-[calc(100dvh-7.5rem)] min-h-[420px] rounded-none sm:rounded-2xl border border-[#E3EDF5] overflow-hidden bg-white">
        {list}
        {pane}
      </div>
      {leadFor && (
        <Modal open onClose={() => setLeadFor(null)} title="Create a lead from this conversation" width="sm"
          footer={<><Button variant="secondary" onClick={() => setLeadFor(null)}>Cancel</Button><Button variant="primary" loading={creating} onClick={() => void createLead()}>Create lead</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><input className={inputCls} value={leadFor.name} onChange={(e) => setLeadFor((f) => f && { ...f, name: e.target.value })} /></Field>
            <Field label="Phone number" hint="Ask for it in the conversation first."><input className={inputCls} inputMode="tel" value={leadFor.phone} onChange={(e) => setLeadFor((f) => f && { ...f, phone: e.target.value })} /></Field>
            <Field label="E-mail (optional)"><input className={inputCls} type="email" value={leadFor.email} onChange={(e) => setLeadFor((f) => f && { ...f, email: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
};
