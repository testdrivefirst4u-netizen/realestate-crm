/** Bot Chats (server: modules/webchat.ts): install the website widget, and see website + Instagram/Facebook chatbot conversations. */
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Facebook, Globe, Instagram, MessagesSquare } from 'lucide-react';
import { api, type BotChatRow } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
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

/** Clear any widget this page injected for a preview. */
function clearPreview() {
  document.querySelectorAll('script[data-bcwc-preview]').forEach((s) => s.remove());
  document.querySelectorAll('.bcwc-btn, .bcwc-panel').forEach((e) => e.remove());
}

const InstallCard: React.FC = () => {
  const [info, setInfo] = useState<{ base: string; slug: string } | null>(null);
  const [color, setColor] = useState('#1f7a4d');
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      const el = document.getElementById('bcwc-snippet') as HTMLTextAreaElement | null;
      el?.select();
    }
  };
  const preview = () => {
    clearPreview();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.setAttribute('data-color', color);
    s.setAttribute('data-title', title);
    s.setAttribute('data-bcwc-preview', '1');
    document.body.appendChild(s);
    setPreviewing(true);
  };
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
        {previewing
          ? <Button variant="secondary" size="sm" icon={<EyeOff size={14} />} onClick={stop}>Stop preview</Button>
          : <Button variant="secondary" size="sm" icon={<Eye size={14} />} onClick={preview}>Preview here</Button>}
      </div>

      {!ready && <InlineNotice tone="info" className="mt-3">Your company address isn’t set yet, so the code shows placeholders. Ask your admin to set the app URL, or copy it and replace <code>your-company</code> with your company slug.</InlineNotice>}
      <p className="mt-3 text-[11px] text-[#5E778C]">The bubble only appears when a chatbot is <strong>Active</strong> with the <strong>Website</strong> channel ticked (Chatbots → Runs on). Works on WordPress, Wix, Shopify, Squarespace or any site — paste it in the site’s footer / custom-code area.</p>
    </Card>
  );
};

export const BotChatsView: React.FC = () => {
  const [rows, setRows] = useState<BotChatRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => {
    let on = true;
    api.botChats.list().then((r) => on && setRows(r)).catch((e) => on && setErr(toAppError(reportError('botChats.list', e)).userMessage));
    return () => { on = false; };
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">Bot Chats</h2>
        <p className="mt-0.5 text-xs text-[#5E778C]">Install the website widget, and read the conversations your chatbot has had on the website, Instagram and Facebook.</p>
      </div>

      <InstallCard />

      <div>
        <h3 className="mb-2 text-sm font-bold text-[#0B2A44]">Recent conversations</h3>
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
          )}
      </div>
    </div>
  );
};
