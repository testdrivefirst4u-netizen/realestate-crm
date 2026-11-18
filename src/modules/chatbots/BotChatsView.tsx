/** Live Chat (server: modules/webchat.ts + chat360): one inbox for website, Instagram/Facebook and WhatsApp conversations — read, reply live, set availability, install the widget. */
import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, ChevronLeft, Copy, Eye, EyeOff, Facebook, Globe, Inbox, Instagram, MessagesSquare, Search, Send } from 'lucide-react';
import { api, type BotChatLine, type BotChatRow, type ChatPresence } from '../../core/api';
import type { Chat360Contact, Chat360Message } from '../../types/crm';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, EmptyState, InlineNotice, LoadingState, Modal, cx, inputCls } from '../../components/ui';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';

type Channel = 'website' | 'instagram' | 'facebook' | 'whatsapp';
const CHANNEL: Record<Channel, { label: string; icon: React.ElementType; tint: string }> = {
  website: { label: 'Website', icon: Globe, tint: '#E86B2A' },
  instagram: { label: 'Instagram', icon: Instagram, tint: '#C1398B' },
  facebook: { label: 'Facebook', icon: Facebook, tint: '#2E6FBA' },
  whatsapp: { label: 'WhatsApp', icon: WhatsAppIcon, tint: '#25D366' },
};
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const maxSeq = (ls: BotChatLine[]) => ls.reduce((m, l) => Math.max(m, l.seq || 0), 0);
const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;
/** One-tap replies an agent can drop into the box, then edit before sending. */
const QUICK_REPLIES = ['Thanks for reaching out! 🙏', 'May I share our brochure?', 'Would you like to book a site visit?', 'Our team will call you shortly.'];

type Msg = { side: 'in' | 'out'; text: string; at: string; label?: string };
type Conv = { id: string; channel: Channel; who: string; last: string; lastAt: string; status: BotChatRow['status']; mode?: 'bot' | 'agent'; phone?: string; leadId?: string; captured?: Record<string, string>; row?: BotChatRow };

const lastLine = (r: BotChatRow) => (r.transcript.length ? r.transcript[r.transcript.length - 1].text : 'New conversation');
const needsPerson = (c: Conv) => !!c.row && (c.row.mode === 'agent' || c.row.status === 'handoff');
const normBot = (t: BotChatLine): Msg => ({ side: t.role === 'user' ? 'in' : 'out', text: t.text, at: t.at, label: t.role === 'agent' ? 'You' : t.role === 'bot' ? 'Bot' : undefined });
const normWa = (m: Chat360Message): Msg => ({ side: m.direction === 'Inbound' ? 'in' : 'out', text: m.text || (m.mediaUrl ? '[media]' : ''), at: m.timestamp, label: m.direction === 'Outbound' ? m.agent || undefined : undefined });

/* ------------------------------- the chat panel ------------------------------ */
const ChatPanel: React.FC<{ conv: Conv; onBack: () => void }> = ({ conv, onBack }) => {
  const isWeb = conv.channel === 'website';
  const isWa = conv.channel === 'whatsapp';
  const isSocial = conv.channel === 'instagram' || conv.channel === 'facebook';
  const Ch = CHANNEL[conv.channel];
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState(conv.status);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const seqRef = useRef(0);
  const waInRef = useRef(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const dingRef = useRef<HTMLAudioElement | null>(null);
  const canReply = isWa || isSocial || (isWeb && status !== 'done' && status !== 'stopped');
  const ding = () => { try { if (!dingRef.current) { dingRef.current = new Audio('/mixkit-doorbell-single-press-333.wav'); dingRef.current.volume = 0.5; } dingRef.current.currentTime = 0; void dingRef.current.play().catch(() => undefined); } catch { /* ignore */ } };

  const pullWeb = async () => {
    try {
      const r = await api.botChats.thread(conv.id, seqRef.current);
      if (r.messages.length) { setMsgs((p) => [...p, ...r.messages.map(normBot)]); seqRef.current = Math.max(seqRef.current, maxSeq(r.messages)); if (r.messages.some((m) => m.role === 'user')) ding(); }
      if (r.seq > seqRef.current) seqRef.current = r.seq;
      setStatus(r.status as BotChatRow['status']);
    } catch { /* keep polling */ }
  };
  const loadWa = async () => {
    try {
      const m = await api.chat360.messages(conv.phone || '');
      setMsgs(m.map(normWa));
      const inbound = m.filter((x) => x.direction === 'Inbound').length;
      if (waInRef.current >= 0 && inbound > waInRef.current) ding();
      waInRef.current = inbound;
    } catch { /* keep polling */ }
  };

  useEffect(() => {
    seqRef.current = 0; waInRef.current = -1; setStatus(conv.status);
    if (isWa) { setMsgs([]); void loadWa(); }
    else { setMsgs((conv.row?.transcript || []).map(normBot)); seqRef.current = maxSeq(conv.row?.transcript || []); }
    if (isSocial) return;
    let on = true; let t: ReturnType<typeof setTimeout>;
    const loop = async () => { if (!on) return; if (isWa) await loadWa(); else await pullWeb(); if (on) t = setTimeout(loop, isWa ? 6000 : 4000); };
    t = setTimeout(loop, 3000);
    return () => { on = false; clearTimeout(t); };
  }, [conv.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs]);

  const reply = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      if (isWa) { await api.chat360.send({ phone: conv.phone || '', leadId: conv.leadId, text: v }); setText(''); await loadWa(); }
      else if (isSocial) { await api.botChats.replySocial(conv.id, v); setText(''); setMsgs((p) => [...p, { side: 'out', text: v, at: new Date().toISOString(), label: 'You' }]); setStatus('handoff'); }
      else { await api.botChats.reply(conv.id, v); setText(''); setStatus('active'); await pullWeb(); }
    } catch (e) { toast('Not sent', errText('chat.reply', e), 'alert'); }
    finally { setSending(false); }
  };

  const captured = Object.entries(conv.captured || {}).filter(([, v]) => v);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#F7FAFD]">
      <div className="flex items-center gap-2 border-b border-[#E3EDF5] bg-white px-3 py-2.5">
        <button type="button" className="rounded p-1 text-[#5E778C] hover:bg-[#F2F7FB] lg:hidden" onClick={onBack} aria-label="Back"><ChevronLeft size={18} /></button>
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-white" style={{ background: Ch.tint }}><Ch.icon size={16} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#0B2A44]">{conv.who}</p>
          <p className="truncate text-[11px] text-[#5E778C]">{Ch.label}{conv.phone ? ` · +${conv.phone}` : ''}{isWeb && conv.mode === 'agent' ? ' · live' : ''}</p>
        </div>
        {needsPerson(conv) && <Badge tone="amber">Needs a person</Badge>}
      </div>

      {captured.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-[#E3EDF5] bg-white px-3 py-2">
          {captured.map(([k, v]) => <span key={k} className="rounded-full bg-[#F2F7FB] px-2 py-0.5 text-[11px] text-[#3E5A70]"><span className="font-semibold capitalize">{k}:</span> {v}</span>)}
          {conv.leadId && <span className="rounded-full bg-[#E7F6EE] px-2 py-0.5 text-[11px] font-semibold text-[#067647]">Lead</span>}
        </div>
      )}

      <div ref={boxRef} className="flex-1 space-y-2 overflow-y-auto p-4">
        {msgs.map((m, i) => (
          <div key={i} className={cx('max-w-[78%] break-words rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed', m.side === 'in' ? 'rounded-bl-sm bg-white text-[#0B2A44] ring-1 ring-[#E3EDF5]' : 'ml-auto rounded-br-sm bg-[#0B6BB0] text-white')}>
            {m.side === 'out' && m.label && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-white/80">{m.label}</span>}
            {m.text}
            <span className={cx('mt-0.5 block text-[10px]', m.side === 'in' ? 'text-[#9CB0C0]' : 'text-white/70')}>{when(m.at)}</span>
          </div>
        ))}
        {!msgs.length && <p className="text-center text-xs text-[#7E93A6]">No messages yet.</p>}
      </div>

      {canReply ? (
        <div className="border-t border-[#E3EDF5] bg-white p-3">
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {QUICK_REPLIES.map((q) => (
              <button key={q} type="button" onClick={() => setText((t) => (t.trim() ? `${t.trimEnd()} ${q}` : q))} className="flex-none rounded-full border border-[#D3E3F0] px-3 py-1 text-[11.5px] font-semibold text-[#5E778C] hover:bg-[#F2F7FB]">{q}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <input className={inputCls} placeholder={isWa ? 'Reply on WhatsApp…' : isSocial ? `Reply on ${Ch.label}…` : 'Type a reply to the visitor…'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void reply(); } }} />
            <Button variant="primary" size="sm" icon={<Send size={14} />} loading={sending} onClick={() => void reply()}>Send</Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-[#E3EDF5] bg-white p-3 text-[11px] text-[#7E93A6]">
          {isWeb ? 'This chat has ended — the visitor would need to start a new one.' : `Reply to this ${Ch.label} chat from the Social Inbox screen.`}
        </div>
      )}
    </div>
  );
};

/* -------------------------------- install modal ------------------------------- */
function clearPreview() {
  document.querySelectorAll('script[data-bcwc-preview]').forEach((s) => s.remove());
  document.querySelectorAll('.bcwc-btn, .bcwc-panel, .bcwc-greet').forEach((e) => e.remove());
}
const InstallModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [info, setInfo] = useState<{ base: string; slug: string } | null>(null);
  const [color, setColor] = useState('#2f6fb0');
  const [title, setTitle] = useState('Chat with us');
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => { if (open && !info) api.botChats.embed().then(setInfo).catch(() => setInfo({ base: '', slug: '' })); }, [open, info]);
  useEffect(() => () => clearPreview(), []);
  const base = info?.base || 'https://your-app-url';
  const slug = info?.slug || 'your-company';
  const src = `${base}/api/public/webchat/${slug}/widget`;
  const snippet = `<script src="${src}" data-color="${color}" data-title="${title}" async></script>`;
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ } };
  const preview = () => { clearPreview(); const s = document.createElement('script'); s.src = src; s.async = true; s.setAttribute('data-color', color); s.setAttribute('data-title', title); s.setAttribute('data-bcwc-preview', '1'); document.body.appendChild(s); setPreviewing(true); };
  const stop = () => { clearPreview(); setPreviewing(false); };
  return (
    <Modal open={open} onClose={() => { stop(); onClose(); }} title="Install on your website" subtitle="Add one line of code to your site — the chat bubble runs your live Website bot." width="md">
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs font-semibold text-[#5E778C]">Bubble colour<input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 block h-9 w-16 cursor-pointer rounded border border-[#D3E3F0] bg-white p-0.5" aria-label="Bubble colour" /></label>
        <label className="min-w-[160px] flex-1 text-xs font-semibold text-[#5E778C]">Title<input className={`${inputCls} mt-1`} maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      </div>
      <label className="mt-3 block text-xs font-semibold text-[#5E778C]">Paste before <code className="rounded bg-[#EEF3F7] px-1 text-[#0B5E9C]">&lt;/body&gt;</code>:</label>
      <textarea readOnly value={snippet} rows={2} className="mt-1 w-full resize-none rounded-lg border border-[#D3E3F0] bg-[#F7FAFC] px-3 py-2 font-mono text-[12px] text-[#0B2A44]" onFocus={(e) => e.currentTarget.select()} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy code'}</Button>
        {previewing ? <Button variant="secondary" size="sm" icon={<EyeOff size={14} />} onClick={stop}>Stop preview</Button> : <Button variant="secondary" size="sm" icon={<Eye size={14} />} onClick={preview}>Preview here</Button>}
      </div>
      <p className="mt-3 text-[11px] text-[#5E778C]">The bubble shows only when a chatbot is <strong>Active</strong> with the <strong>Website</strong> channel ticked.</p>
    </Modal>
  );
};

/* ---------------------------------- the screen -------------------------------- */
/** The channel rail down the left of the Unified Inbox — each a one-tap folder. */
const RAIL: Array<{ key: string; label: string; icon: React.ElementType; tint?: string; test: (c: Conv) => boolean }> = [
  { key: 'all', label: 'All', icon: Inbox, test: () => true },
  { key: 'live', label: 'Needs a person', icon: Bell, test: needsPerson },
  { key: 'whatsapp', label: 'WhatsApp', icon: WhatsAppIcon, tint: '#25D366', test: (c) => c.channel === 'whatsapp' },
  { key: 'website', label: 'Website', icon: Globe, tint: '#E86B2A', test: (c) => c.channel === 'website' },
  { key: 'instagram', label: 'Instagram', icon: Instagram, tint: '#C1398B', test: (c) => c.channel === 'instagram' },
  { key: 'facebook', label: 'Facebook', icon: Facebook, tint: '#2E6FBA', test: (c) => c.channel === 'facebook' },
];

export const BotChatsView: React.FC = () => {
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [tab, setTab] = useState('all');
  const [pres, setPres] = useState<ChatPresence | null>(null);
  const [presBusy, setPresBusy] = useState(false);
  const [install, setInstall] = useState(false);
  const [query, setQuery] = useState('');

  const load = async () => {
    try {
      const [bots, contacts] = await Promise.all([api.botChats.list(), api.chat360.contacts().catch(() => [] as Chat360Contact[])]);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const wa: Conv[] = contacts
        .filter((c) => c.lastMessageAt && new Date(c.lastMessageAt) >= today)
        .map((c) => ({ id: 'wa:' + c.phone, channel: 'whatsapp' as Channel, who: c.contactName || '+' + c.phone, last: c.lastMessage || '', lastAt: c.lastMessageAt || '', status: 'active' as BotChatRow['status'], phone: c.phone, leadId: c.leadId }));
      const bot: Conv[] = bots.map((r) => ({ id: r.id, channel: r.channel as Channel, who: r.who, last: lastLine(r), lastAt: r.lastAt, status: r.status, mode: r.mode, leadId: r.leadId, captured: r.captured, row: r }));
      setConvs([...wa, ...bot].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')));
      setErr('');
    } catch (e) { setErr(errText('livechat.list', e)); }
  };
  useEffect(() => { let on = true; const loop = () => { if (on) void load(); }; loop(); const t = setInterval(loop, 12000); api.botChats.presence().then((r) => on && setPres(r)).catch(() => undefined); return () => { on = false; clearInterval(t); }; }, []);
  const toggleAvail = async () => { if (!pres || presBusy) return; setPresBusy(true); try { await api.botChats.setPresence(!pres.available); setPres(await api.botChats.presence()); } catch (e) { toast('Not changed', errText('presence', e), 'alert'); } finally { setPresBusy(false); } };

  const railItem = RAIL.find((t) => t.key === tab) || RAIL[0];
  const q = query.trim().toLowerCase();
  const filtered = (convs || []).filter(railItem.test).filter((c) => !q || c.who.toLowerCase().includes(q) || (c.last || '').toLowerCase().includes(q));
  const needsCount = (convs || []).filter(needsPerson).length;
  const current = (convs || []).find((c) => c.id === sel) || null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#D3E3F0] bg-white px-4 py-2.5">
        <h2 className="text-lg font-bold text-[#0B2A44]">Live Chat</h2>
        <div className="flex items-center gap-2">
          {pres && <Button variant={pres.available ? 'primary' : 'secondary'} size="sm" loading={presBusy} onClick={() => void toggleAvail()}><span className={cx('mr-1.5 inline-block h-2 w-2 rounded-full', pres.available ? 'bg-[#49d36a]' : 'bg-[#cbd5dd]')} />{pres.available ? 'Available' : 'Away'}</Button>}
          <Button variant="secondary" size="sm" icon={<Globe size={14} />} onClick={() => setInstall(true)}>Install widget</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* channel rail — one-tap folders (hidden on phones, where the chips below stand in) */}
        <nav className={cx('w-[76px] flex-none flex-col items-center gap-1 border-r border-[#E3EDF5] bg-[#F7FAFC] py-3', current ? 'hidden lg:flex' : 'hidden sm:flex')} aria-label="Channels">
          {RAIL.map((r) => {
            const on = tab === r.key;
            return (
              <button key={r.key} type="button" onClick={() => setTab(r.key)} title={r.label} aria-label={r.label} aria-pressed={on}
                className={cx('relative flex w-[60px] flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold', on ? 'bg-[#0B6BB0] text-white' : 'text-[#5E778C] hover:bg-[#EEF4F9]')}>
                <r.icon size={19} aria-hidden="true" />
                <span className="leading-none">{r.label === 'Needs a person' ? 'Needs' : r.label}</span>
                {r.key === 'live' && needsCount > 0 && <span className="absolute right-1.5 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#F0A202] px-1 text-[9px] font-bold text-white">{needsCount}</span>}
              </button>
            );
          })}
        </nav>

        {/* conversation list */}
        <aside className={cx('w-full min-h-0 flex-col border-r border-[#E3EDF5] bg-white lg:w-[330px]', current ? 'hidden lg:flex' : 'flex')}>
          <div className="flex items-center gap-2 border-b border-[#E3EDF5] px-3 py-2.5">
            <h3 className="text-sm font-bold text-[#0B2A44]">{railItem.label}</h3>
            <span className="text-xs font-semibold text-[#9CB0C0]">{filtered.length}</span>
          </div>
          <div className="flex gap-1 overflow-x-auto border-b border-[#E3EDF5] p-2 sm:hidden">
            {RAIL.map((r) => <button key={r.key} type="button" onClick={() => setTab(r.key)} className={cx('whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold', tab === r.key ? 'bg-[#0B6BB0] text-white' : 'bg-[#F2F7FB] text-[#5E778C]')}>{r.label}{r.key === 'live' && needsCount > 0 ? ` ${needsCount}` : ''}</button>)}
          </div>
          <div className="border-b border-[#E3EDF5] p-2">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9CB0C0]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="w-full rounded-lg border border-[#E3EDF5] bg-[#F7FAFC] py-1.5 pl-8 pr-3 text-sm text-[#0B2A44] placeholder:text-[#9CB0C0] focus:border-[#0B6BB0] focus:outline-none" />
            </label>
          </div>
          {err ? <InlineNotice tone="warning" className="m-3">{err}</InlineNotice>
            : !convs ? <div className="p-6"><LoadingState /></div>
            : !filtered.length ? <EmptyState icon={<MessagesSquare size={24} />} title={q ? 'No matches' : 'No conversations'} description={q ? 'Try a different name or word.' : 'Chats from your website, Instagram, Facebook and WhatsApp appear here.'} className="m-3" />
            : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {filtered.map((c) => {
                  const Ch = CHANNEL[c.channel];
                  return (
                    <li key={c.id}>
                      <button type="button" onClick={() => setSel(c.id)} className={cx('flex w-full items-start gap-2.5 border-b border-[#EEF3F7] px-3 py-2.5 text-left hover:bg-[#F7FAFB]', sel === c.id && 'bg-[#EAF4FB]')}>
                        <span className="relative flex h-9 w-9 flex-none items-center justify-center rounded-full text-white" style={{ background: Ch.tint }}><Ch.icon size={17} aria-hidden="true" />{needsPerson(c) && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-[#F0A202] ring-2 ring-white" />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-[#0B2A44]">{c.who}</span><span className="flex-none text-[10px] text-[#9CB0C0]">{when(c.lastAt)}</span></span>
                          <span className="mt-0.5 block truncate text-xs text-[#5E778C]">{c.last || Ch.label}</span>
                          {needsPerson(c) && <span className="mt-1 inline-flex items-center rounded-full bg-[#FEF3E2] px-2 py-0.5 text-[10px] font-bold text-[#B7791F]">Needs a person</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </aside>

        <main className={cx('min-w-0 flex-1', current ? 'flex' : 'hidden lg:flex')}>
          {current ? <ChatPanel key={current.id} conv={current} onBack={() => setSel('')} />
            : <div className="flex flex-1 flex-col items-center justify-center bg-[#F7FAFD] p-6 text-center"><MessagesSquare size={34} className="text-[#C9D9E6]" /><p className="mt-2 text-sm font-semibold text-[#5E778C]">Select a conversation</p><p className="text-xs text-[#7E93A6]">Pick a chat on the left to read it and reply.</p></div>}
        </main>
      </div>

      <InstallModal open={install} onClose={() => setInstall(false)} />
    </div>
  );
};
