/** Live Chat (server: modules/webchat.ts): a two-pane inbox to chat live with website visitors, plus social/WhatsApp bot conversations, set availability, and install the widget. */
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Copy, Eye, EyeOff, Facebook, Globe, Instagram, MessagesSquare, Send } from 'lucide-react';
import { api, type BotChatLine, type BotChatRow, type ChatPresence } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, InlineNotice, LoadingState, Modal, cx, inputCls } from '../../components/ui';

const CHANNEL: Record<BotChatRow['channel'], { label: string; icon: React.ElementType; tint: string }> = {
  website: { label: 'Website', icon: Globe, tint: '#E86B2A' },
  instagram: { label: 'Instagram', icon: Instagram, tint: '#C1398B' },
  facebook: { label: 'Facebook', icon: Facebook, tint: '#2E6FBA' },
};
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const maxSeq = (ls: BotChatLine[]) => ls.reduce((m, l) => Math.max(m, l.seq || 0), 0);
const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;
const lastLine = (c: BotChatRow) => c.transcript.length ? c.transcript[c.transcript.length - 1].text : 'New conversation';
/** A chat that needs a person: handed off, or being handled live. */
const needsPerson = (c: BotChatRow) => c.mode === 'agent' || c.status === 'handoff';

/* ------------------------------- the chat panel ------------------------------ */
const ChatPanel: React.FC<{ row: BotChatRow; onBack: () => void }> = ({ row, onBack }) => {
  const [lines, setLines] = useState<BotChatLine[]>(row.transcript);
  const [mode, setMode] = useState(row.mode);
  const [status, setStatus] = useState(row.status);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const seqRef = useRef(maxSeq(row.transcript));
  const boxRef = useRef<HTMLDivElement>(null);
  const dingRef = useRef<HTMLAudioElement | null>(null);
  const Ch = CHANNEL[row.channel];
  const isWeb = row.channel === 'website';
  const canReply = isWeb && status !== 'done' && status !== 'stopped';
  const ding = () => { try { if (!dingRef.current) { dingRef.current = new Audio('/mixkit-doorbell-single-press-333.wav'); dingRef.current.volume = 0.5; } dingRef.current.currentTime = 0; void dingRef.current.play().catch(() => undefined); } catch { /* ignore */ } };

  // reset when switching conversations
  useEffect(() => { setLines(row.transcript); setMode(row.mode); setStatus(row.status); seqRef.current = maxSeq(row.transcript); }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pull = async () => {
    try {
      const r = await api.botChats.thread(row.id, seqRef.current);
      if (r.messages.length) { setLines((prev) => [...prev, ...r.messages]); seqRef.current = Math.max(seqRef.current, maxSeq(r.messages)); if (r.messages.some((m) => m.role === 'user')) ding(); }
      if (r.seq > seqRef.current) seqRef.current = r.seq;
      setMode(r.mode); setStatus(r.status as BotChatRow['status']);
    } catch { /* keep polling */ }
  };
  useEffect(() => {
    if (!isWeb) return;
    let on = true; let t: ReturnType<typeof setTimeout>;
    const loop = async () => { if (!on) return; await pull(); if (on) t = setTimeout(loop, 4000); };
    t = setTimeout(loop, 3000);
    return () => { on = false; clearTimeout(t); };
  }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [lines]);

  const reply = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try { await api.botChats.reply(row.id, v); setText(''); setMode('agent'); setStatus('active'); await pull(); }
    catch (e) { toast('Not sent', errText('chat.reply', e), 'alert'); }
    finally { setSending(false); }
  };

  const captured = Object.entries(row.captured || {}).filter(([, v]) => v);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#F7FAFD]">
      <div className="flex items-center gap-2 border-b border-[#E3EDF5] bg-white px-3 py-2.5">
        <button type="button" className="rounded p-1 text-[#5E778C] hover:bg-[#F2F7FB] lg:hidden" onClick={onBack} aria-label="Back"><ChevronLeft size={18} /></button>
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-white" style={{ background: Ch.tint }}><Ch.icon size={16} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#0B2A44]">{row.who}</p>
          <p className="truncate text-[11px] text-[#5E778C]">{Ch.label}{row.assignedAgent ? ` · ${row.assignedAgent}` : ''}{mode === 'agent' ? ' · live' : ''}</p>
        </div>
        {needsPerson(row) && <Badge tone="amber">Needs a person</Badge>}
      </div>

      {captured.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-[#E3EDF5] bg-white px-3 py-2">
          {captured.map(([k, v]) => <span key={k} className="rounded-full bg-[#F2F7FB] px-2 py-0.5 text-[11px] text-[#3E5A70]"><span className="font-semibold capitalize">{k}:</span> {v}</span>)}
          {row.leadId && <span className="rounded-full bg-[#E7F6EE] px-2 py-0.5 text-[11px] font-semibold text-[#067647]">Lead</span>}
        </div>
      )}

      <div ref={boxRef} className="flex-1 space-y-2 overflow-y-auto p-4">
        {lines.map((t, i) => (
          <div key={i} className={cx('max-w-[78%] break-words rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed', t.role === 'user' ? 'rounded-bl-sm bg-white text-[#0B2A44] ring-1 ring-[#E3EDF5]' : 'ml-auto rounded-br-sm bg-[#0B6BB0] text-white')}>
            {t.role === 'agent' && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-white/80">You</span>}
            {t.text}
            <span className={cx('mt-0.5 block text-[10px]', t.role === 'user' ? 'text-[#9CB0C0]' : 'text-white/70')}>{when(t.at)}</span>
          </div>
        ))}
        {!lines.length && <p className="text-center text-xs text-[#7E93A6]">No messages yet.</p>}
      </div>

      {canReply ? (
        <div className="flex gap-2 border-t border-[#E3EDF5] bg-white p-3">
          <input className={inputCls} placeholder="Type a reply to the visitor…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void reply(); } }} />
          <Button variant="primary" size="sm" icon={<Send size={14} />} loading={sending} onClick={() => void reply()}>Send</Button>
        </div>
      ) : (
        <div className="border-t border-[#E3EDF5] bg-white p-3 text-[11px] text-[#7E93A6]">
          {isWeb ? 'This chat has ended — the visitor would need to start a new one.' : `Reply to this ${Ch.label} chat from the Social Inbox / WhatsApp screen.`}
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
const TABS: Array<{ key: string; label: string; test: (c: BotChatRow) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'live', label: 'Needs a person', test: needsPerson },
  { key: 'website', label: 'Website', test: (c) => c.channel === 'website' },
  { key: 'social', label: 'Social', test: (c) => c.channel !== 'website' },
];

export const BotChatsView: React.FC = () => {
  const [rows, setRows] = useState<BotChatRow[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [tab, setTab] = useState('all');
  const [pres, setPres] = useState<ChatPresence | null>(null);
  const [presBusy, setPresBusy] = useState(false);
  const [install, setInstall] = useState(false);

  const load = () => api.botChats.list().then(setRows).catch((e) => setErr(errText('botChats.list', e)));
  useEffect(() => { let on = true; const loop = () => { if (!on) return; void load(); }; loop(); const t = setInterval(loop, 12000); api.botChats.presence().then((r) => on && setPres(r)).catch(() => undefined); return () => { on = false; clearInterval(t); }; }, []);
  const toggleAvail = async () => { if (!pres || presBusy) return; setPresBusy(true); try { await api.botChats.setPresence(!pres.available); setPres(await api.botChats.presence()); } catch (e) { toast('Not changed', errText('presence', e), 'alert'); } finally { setPresBusy(false); } };

  const filtered = (rows || []).filter(TABS.find((t) => t.key === tab)!.test);
  const current = (rows || []).find((c) => c.id === sel) || null;

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
        <aside className={cx('flex w-full min-h-0 flex-col border-r border-[#E3EDF5] bg-white lg:w-[340px]', current ? 'hidden lg:flex' : 'flex')}>
          <div className="flex gap-1 overflow-x-auto border-b border-[#E3EDF5] p-2">
            {TABS.map((t) => <button key={t.key} type="button" onClick={() => setTab(t.key)} className={cx('whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold', tab === t.key ? 'bg-[#0B6BB0] text-white' : 'bg-[#F2F7FB] text-[#5E778C]')}>{t.label}</button>)}
          </div>
          {err ? <InlineNotice tone="warning" className="m-3">{err}</InlineNotice>
            : !rows ? <div className="p-6"><LoadingState /></div>
            : !filtered.length ? <EmptyState icon={<MessagesSquare size={24} />} title="No conversations" description="Chats from your website, Instagram and Facebook bots appear here." className="m-3" />
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
                          <span className="mt-0.5 block truncate text-xs text-[#5E778C]">{lastLine(c)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </aside>

        <main className={cx('min-w-0 flex-1', current ? 'flex' : 'hidden lg:flex')}>
          {current ? <ChatPanel key={current.id} row={current} onBack={() => setSel('')} />
            : <div className="flex flex-1 flex-col items-center justify-center bg-[#F7FAFD] p-6 text-center"><MessagesSquare size={34} className="text-[#C9D9E6]" /><p className="mt-2 text-sm font-semibold text-[#5E778C]">Select a conversation</p><p className="text-xs text-[#7E93A6]">Pick a chat on the left to read it and reply.</p></div>}
        </main>
      </div>

      <InstallModal open={install} onClose={() => setInstall(false)} />
    </div>
  );
};
