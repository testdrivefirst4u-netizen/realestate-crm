import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound } from 'lucide-react';
import { toast } from '../../../core/notifications';
import { Button, Tabs } from '../../../components/ui';
import { GUIDE_TABS, GuideTab, KEY_PLACEHOLDER, buildSnippets, endpointFor } from './leadSourceUtils';

export const CopyButton: React.FC<{ value: string; label?: string; ariaLabel?: string }> = ({ value, label = 'Copy', ariaLabel }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Copy failed', 'Your browser blocked clipboard access — select the text and copy it manually.', 'warning');
    }
  };
  return (
    <Button variant="secondary" size="xs" onClick={copy} aria-label={ariaLabel || label} icon={copied ? <Check size={11} /> : <Copy size={11} />} disabled={!value}>
      {copied ? 'Copied' : label}
    </Button>
  );
};

export const CodeBlock: React.FC<{ code: string; label: string }> = ({ code, label }) => (
  <div className="relative rounded-lg border border-[#D3E3F0] bg-[#0B2A44] text-[#F2F7FB]">
    <div className="absolute top-2 right-2"><CopyButton value={code} ariaLabel={`Copy ${label}`} /></div>
    <pre className="text-[11px] leading-relaxed p-3 pr-20 overflow-x-auto whitespace-pre font-mono" aria-label={label}>{code}</pre>
  </div>
);

/** One-time display of a freshly created / rotated key. */
export const ApiKeyPanel: React.FC<{ apiKey: string }> = ({ apiKey }) => (
  <div className="rounded-xl border border-[#0B6BB0]/50 bg-[#F5F9FC] p-4 space-y-2.5">
    <div className="flex items-center gap-2 text-sm font-bold text-[#0B2A44]"><KeyRound size={15} className="text-[#0B6BB0]" /> API key</div>
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 break-all text-xs font-mono bg-white border border-[#D3E3F0] rounded-lg px-3 py-2 text-[#0B2A44]" aria-label="API key">{apiKey}</code>
      <CopyButton value={apiKey} label="Copy key" />
    </div>
    <p className="flex items-start gap-1.5 text-[11px] text-[#92400E]">
      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
      Copy it now — this is the only time the full key is shown. If you lose it, rotate the key to get a new one.
    </p>
  </div>
);

/** Tabbed setup instructions filled with the real endpoint and (when known) the key. */
export const IntegrationGuide: React.FC<{ apiKey?: string; initialTab?: GuideTab; redirectUrl?: string }> = ({ apiKey, initialTab = 'html', redirectUrl }) => {
  const [tab, setTab] = useState<GuideTab>(initialTab);
  const endpoint = useMemo(() => endpointFor(typeof window !== 'undefined' ? window.location.origin : ''), []);
  const blocks = useMemo(() => buildSnippets(tab, { endpoint, apiKey, redirectUrl }), [tab, endpoint, apiKey, redirectUrl]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase font-bold tracking-wider text-[#5E778C]">Endpoint</span>
        <code className="text-[11px] font-mono bg-[#F2F7FB] rounded px-2 py-1 text-[#0B2A44] break-all">{endpoint}</code>
        <CopyButton value={endpoint} ariaLabel="Copy endpoint URL" />
      </div>
      {!apiKey && (
        <p className="text-[11px] text-[#5E778C]">
          Replace <code className="font-mono text-[#0B2A44]">{KEY_PLACEHOLDER}</code> with the source’s API key. The full key is shown only when it is created or rotated.
        </p>
      )}
      <Tabs<GuideTab> tabs={GUIDE_TABS} value={tab} onChange={setTab} />
      <div className="space-y-3" role="tabpanel" aria-label={GUIDE_TABS.find((t) => t.id === tab)?.label}>
        {blocks.map((b) => (
          <div key={b.title} className="space-y-1.5">
            <div className="text-xs font-bold text-[#0B2A44]">{b.title}</div>
            {b.note && <p className="text-[11px] text-[#5E778C] leading-relaxed">{b.note}</p>}
            <CodeBlock code={b.code} label={b.title} />
          </div>
        ))}
      </div>
    </div>
  );
};
