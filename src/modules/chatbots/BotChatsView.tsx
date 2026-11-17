/** Bot Chats (server: modules/webchat.ts): install the website widget, set your live-chat availability, and chat with visitors in real time. */
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Facebook, Globe, Instagram, MessagesSquare, Send } from 'lucide-react';
import { api, type BotChatLine, type BotChatRow, type ChatPresence } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, InlineNotice, LoadingState, inputCls } from '../../components/ui';

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
const maxSeq = (ls: BotChatLine[]) => ls.reduce((m, l) => Math.max(m, l.seq || 0), 0);
const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;

/* --------------------------- availability toggle -------------------------- */
const PresenceToggle: React.FC = () => {
  const [p, setP] = useState<ChatPresence | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.botChats.presence().then(setP).catch(() => undefined);
  useEffect(() => { let on = true; api.botChats.presence().then((r) => on && setP(r)).catch(() => undefined); return () => { on = false; }; }, []);
  const toggle = async () => {
    if (!p || busy) return;
    setBusy(true);
    try { await api.botChats.setPresence(!p.available); await refresh(); } catch (e) { toast('Not changed', errText('presence', e), 'alert'); } finally { setBusy(false); }
  };
  if (!p) return null;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#0B2A44]">Live chat availability</p>
          <p className="mt-0.5 text-xs text-[#5E778C]">{p.available ? 'You’re available — handed-off chats can be routed to you.' : 'You’re away — you won’t be assigned new live chats.'} {p.agents.length} agent{p.agents.length === 1 ? '' : 's'} available now.</p>
        </div>
        <Button variant={p.available ? 'primary' : 'secondary'} size="sm" loading={busy} onClick={() => void toggle()}>
          <span className={`mr-2 inline-block h-2 w-2 rounded-full ${p.available ? 'bg-[#49d36a]' : 'bg-[#cbd5dd]'}`} />{p.available ? 'Available' : 'Away'}
        </Button>
      </div>
    </Card>
  );
};

/* ------------------------------ one live chat ----------------------------- */
const ChatThread: React.FC<{ row: BotChatRow }> = ({ row }) => {
  const [lines, setLines] = useState<BotChatLine[]>(row.transcript);
  const [mode, setMode] = useState(row.mode);
  const [status, setStatus] = useState(row.status);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const seqRef = useRef(maxSeq(row.transcript));
  const boxRef = useRef<HTMLDivElement>(null);
  const dingRef = useRef<HTMLAudioElement | null>(null);
  const isWeb = row.channel === 'website';
  const ding = () => { try { if (!dingRef.current) { dingRef.current = new Audio('/mixkit-doorbell-single-press-333.wav'); dingRef.current.volume = 0.5; } dingRef.current.currentTime = 0; void dingRef.current.play().catch(() => undefined); } catch { /* ignore */ } };

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
    const loop = async () => { if (!on) return; await pull(); if (on) t = setTimeout(loop, 5000); };
    t = setTimeout(loop, 4000);
    return () => { on = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [lines]);

  const reply = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try { await api.botChats.reply(row.id, v); setText(''); setMode('agent'); setStatus('active'); await pull(); }
    catch (e) { toast('Not sent', errText('chat.reply', e), 'alert'); }
    finally { setSending(false); }
  };

  return (
    <div className="border-t border-[#E3EDF5] bg-[#F7FAFC] px-4 py-3">
      {!isWeb && <InlineNotice tone="info" className="mb-2">Reply to this {CHANNEL[row.channel].label} chat from the Social Inbox screen.</InlineNotice>}
      {isWeb && mode === 'agent' && <p className="mb-2 text-[11px] font-semibold text-[#067647]">● Live — you’re chatting with the visitor</p>}
      <div ref={boxRef} className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {lines.map((t, i) => (
          <div key={i} className={`max-w-[80%] break-words rounded-lg px-3 py-1.5 text-[13px] ${t.role === 'user' ? 'bg-white text-[#0B2A44] ring-1 ring-[#E3EDF5]' : 'ml-auto bg-[#DCF0FB] text-[#06364a]'}`}>
            {t.role === 'agent' && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-[#0B6BB0]">Agent</span>}
            {t.text}
          </div>
        ))}
        {!lines.length && <p className="text-xs text-[#7E93A6]">No messages recorded.</p>}
      </div>
      {isWeb && status === 'active' && (
        <div className="mt-2 flex gap-2">
          <input className={inputCls} placeholder="Type a reply to the visitor…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void reply(); } }} />
          <Button variant="primary" size="sm" icon={<Send size={13} />} loading={sending} onClick={() => void reply()}>Send</Button>
        </div>
      )}
      {isWeb && status !== 'active' && <p className="mt-2 text-[11px] text-[#7E93A6]">This chat has ended — the visitor would need to start a new one.</p>}
    </div>
  );
};

export const InstallCard: React.FC = () => {
  const [info, setInfo] = useState<{ base: string; slug: string } | null>(null);
  const [color, setColor] = useState('#2f6fb0');
  const [title, setTitle] = useState('Chat with us');
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api.botChats.embed().then((r) => mounted.current && setInfo(r)).catch(() => mounted.current && setInfo({ base: '', slug: '' }));
    return () => { mounted.current = false; clearPreview(); };
  }, []);
  const base = info?.base || 'https://your-app-url';
  const slug = info?.slug || 'your-company';
  const src = `${base}/api/public/webchat/${slug}/widget`;
  const snippet = `<script src="${src}" data-color="${color}" data-title="${title}" async></script>`;
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { (document.getElementById('bcwc-snippet') as HTMLTextAreaElement | null)?.select(); } };
  const preview = () => { clearPreview(); const s = document.createElement('script'); s.src = src; s.async = true; s.setAttribute('data-color', color); s.setAttribute('data-title', title); s.setAttribute('data-bcwc-preview', '1'); document.body.appendChild(s); setPreviewing(true); };
  const stop = () => { clearPreview(); setPreviewing(false); };
  const ready = !!info?.slug;
  return (
    <Card title="Install on your website" subtitle="Add one line of code to your site. The chat bubble appears bottom-right and runs your live Website bot.">
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs font-semibold text-[#5E778C]">Bubble colour
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 block h-9 w-16 cursor-pointer rounded border border-[#D3E3F0] bg-white p-0.5" aria-label="Bubble colour" />
        </label>
        <label className="min-w-[160px] flex-1 text-xs font-semibold text-[#5E778C]">Title shown on the bubble
          <input className={`${inputCls} mt-1`} maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold text-[#5E778C]">Paste this just before <code className="rounded bg-[#EEF3F7] px-1 text-[#0B5E9C]">&lt;/body&gt;</code> on every page:</label>
      <textarea id="bcwc-snippet" readOnly value={snippet} rows={2} className="mt-1 w-full resize-none rounded-lg border border-[#D3E3F0] bg-[#F7FAFC] px-3 py-2 font-mono text-[12px] text-[#0B2A44]" onFocus={(e) => e.currentTarget.select()} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy code'}</Button>
        {previewing ? <Button variant="secondary" size="sm" icon={<EyeOff size={14} />} onClick={stop}>Stop preview</Button> : <Button variant="secondary" size="sm" icon={<Eye size={14} />} onClick={preview}>Preview here</Button>}
      </div>
      {!ready && <InlineNotice tone="info" className="mt-3">Your company address isn’t set yet, so the code shows placeholders. Ask your admin to set the app URL, or replace <code>your-company</code> with your company slug.</InlineNotice>}
      <p className="mt-3 text-[11px] text-[#5E778C]">The bubble only appears when a chatbot is <strong>Active</strong> with the <strong>Website</strong> channel ticked. Works on WordPress, Wix, Shopify, Squarespace or any site.</p>
    </Card>
  );
};

function clearPreview() {
  document.querySelectorAll('script[data-bcwc-preview]').forEach((s) => s.remove());
  document.querySelectorAll('.bcwc-btn, .bcwc-panel').forEach((e) => e.remove());
}

export const BotChatsView: React.FC = () => {
  const [rows, setRows] = useState<BotChatRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => {
    let on = true;
    api.botChats.list().then((r) => on && setRows(r)).catch((e) => on && setErr(errText('botChats.list', e)));
    return () => { on = false; };
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">Bot Chats</h2>
        <p className="mt-0.5 text-xs text-[#5E778C]">Install the website widget, set your availability, and chat live with visitors on the website, Instagram and Facebook.</p>
      </div>

      <PresenceToggle />
      <InstallCard />

      <div>
        <h3 className="mb-2 text-sm font-bold text-[#0B2A44]">Conversations</h3>
        {err ? <InlineNotice tone="warning">{err}</InlineNotice>
          : !rows ? <LoadingState />
          : !rows.length ? <EmptyState icon={<MessagesSquare size={28} />} title="No bot chats yet" description="When your chatbot talks to visitors on your website, Instagram or Facebook, the conversations show up here." />
          : (
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
                        <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-[#0B2A44]">{c.who}</span><Badge tone={st.tone}>{st.label}</Badge>{c.mode === 'agent' && <Badge tone="sage">Live</Badge>}</span>
                        <span className="mt-0.5 block truncate text-xs text-[#5E778C]">{Ch.label} · {c.messages} messages · {when(c.lastAt)}{c.assignedAgent ? ` · ${c.assignedAgent}` : ''}{c.leadId ? ' · lead' : ''}</span>
                      </span>
                      {isOpen ? <ChevronDown size={16} className="flex-none text-[#7E93A6]" /> : <ChevronRight size={16} className="flex-none text-[#7E93A6]" />}
                    </button>
                    {isOpen && (
                      <>
                        {captured.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 border-t border-[#E3EDF5] bg-[#F7FAFC] px-4 pt-3">
                            {captured.map(([k, v]) => <span key={k} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-[#3E5A70] ring-1 ring-[#E3EDF5]"><span className="font-semibold capitalize">{k}:</span> {v}</span>)}
                            {c.leadId && <span className="rounded-full bg-[#E7F6EE] px-2 py-0.5 text-[11px] font-semibold text-[#067647]">Lead created</span>}
                          </div>
                        )}
                        <ChatThread row={c} />
                      </>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
};
