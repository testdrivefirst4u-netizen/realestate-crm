/**
 * Create Ad wizard (Phase 1): a 5-step guided flow opened from the Meta Ads Manager "Create Ad" button.
 *
 * Step 1 connects Facebook inline — "Continue with Facebook" runs the existing OAuth and returns to /ads, where the
 * Page selection is finished right here (reusing the Settings connect helpers), so an admin never visits Settings to
 * connect. Steps 2-5 collect the campaign, audience, budget and creative. Publishing is a guided hand-off: the brief
 * is prepared and Meta Ads Manager opens to launch it (no live spend from the CRM — see the Ads plan).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Facebook, Instagram, Loader2, X } from 'lucide-react';
import { api } from '../../core/api';
import type { MetaPendingPage } from '../../../server/core/metaTypes';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';
import { Button, InlineNotice, Select, cx, inputCls, labelCls } from '../../components/ui';
import { buildConnectRequest, initialChoices, isPendingGone, pageSelectability, type ConnectDefaults, type PageChoice } from '../settings/meta/metaUtils';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const STEPS = [
  { n: 1, title: 'Connect Accounts', sub: 'Link Facebook & WhatsApp' },
  { n: 2, title: 'Campaign Setup', sub: 'Name, objective & schedule' },
  { n: 3, title: 'Audience & Budget', sub: 'Targeting & bid strategy' },
  { n: 4, title: 'Ad Creative', sub: 'Media, copy & message' },
  { n: 5, title: 'Review & Publish', sub: 'Final review & launch' },
];
const PLATFORMS: Array<{ id: string; label: string; icon: React.ElementType }> = [
  { id: 'facebook', label: 'Facebook', icon: Facebook }, { id: 'instagram', label: 'Instagram', icon: Instagram }, { id: 'whatsapp', label: 'WhatsApp', icon: WhatsAppIcon },
];
const OBJECTIVES = ['Leads', 'Traffic', 'Engagement', 'Awareness', 'Sales', 'App installs'];
const CTAS = ['Learn More', 'Sign Up', 'Book Now', 'Contact Us', 'Get Quote', 'Send WhatsApp Message', 'Call Now'];
const BID = ['Highest volume', 'Cost per result goal', 'Bid cap'];
const CONNECT_DEFAULTS: ConnectDefaults = { sourceLabel: 'Facebook', defaultStage: 'New', assignmentMode: 'unassigned', rm: '', rms: [], duplicates: 'remark' };

interface Brief {
  name: string; objective: string; start: string; end: string;
  dailyBudget: string; locations: string; ageMin: string; ageMax: string; gender: string; bid: string;
  primaryText: string; headline: string; description: string; cta: string; mediaUrl: string; destType: 'website' | 'whatsapp'; destination: string;
}
const emptyBrief: Brief = { name: '', objective: 'Leads', start: '', end: '', dailyBudget: '', locations: '', ageMin: '25', ageMax: '55', gender: 'All', bid: 'Highest volume', primaryText: '', headline: '', description: '', cta: 'Learn More', mediaUrl: '', destType: 'website', destination: '' };

export const CreateAdWizard: React.FC<{
  connected: boolean;
  accounts: Array<{ id: string; name: string; currency: string }>;
  pendingId?: string;
  onClose: () => void;
  onConnected: () => void;
}> = ({ connected, accounts, pendingId, onClose, onConnected }) => {
  const [step, setStep] = useState(1);
  const [connectedLocal, setConnectedLocal] = useState(connected);
  useEffect(() => { if (connected) setConnectedLocal(true); }, [connected]);
  const isConnected = connectedLocal || connected;

  const [adAccount, setAdAccount] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['facebook']);
  const [brief, setBrief] = useState<Brief>(emptyBrief);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));

  // inline Page selection after OAuth returns with ?metaConnect=<pendingId>
  const [pending, setPending] = useState<{ pages: MetaPendingPage[]; choices: Record<string, PageChoice> } | null>(null);
  const [pendingErr, setPendingErr] = useState('');
  const [loadingPending, setLoadingPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadPending = useCallback(async (id: string) => {
    setLoadingPending(true); setPendingErr('');
    try { const r = await api.meta.pending(id); setPending({ pages: r.pages || [], choices: initialChoices(r.pages || []) }); }
    catch (e) { setPendingErr(isPendingGone(toAppError(e)) ? 'That Facebook login expired — connect again.' : errText('meta.pending', e)); }
    finally { setLoadingPending(false); }
  }, []);
  useEffect(() => { if (pendingId && !isConnected) void loadPending(pendingId); }, [pendingId, isConnected, loadPending]);

  const startConnect = () => { window.location.href = '/api/integrations/meta/connect?return=ads'; };
  const togglePage = (id: string, on: boolean) => setPending((p) => (p ? { ...p, choices: { ...p.choices, [id]: { ...(p.choices[id] || { checked: false, allForms: true, formIds: [] }), checked: on } } } : p));
  const connectPages = async () => {
    if (!pending || !pendingId) return;
    const { req, errors } = buildConnectRequest(pendingId, pending.pages, pending.choices, CONNECT_DEFAULTS);
    if (errors.length) { setPendingErr(errors[0]); return; }
    setBusy(true);
    try { await api.meta.connect(req); toast('Facebook connected', 'Your Page is linked. You can create your ad now.', 'success'); setConnectedLocal(true); setPending(null); onConnected(); }
    catch (e) { setPendingErr(isPendingGone(toAppError(e)) ? 'That Facebook login expired — connect again.' : errText('meta.connect', e)); }
    finally { setBusy(false); }
  };

  const togglePlatform = (id: string, on: boolean) => setPlatforms((v) => (on ? [...new Set([...v, id])] : v.filter((x) => x !== id)));
  const account = accounts.find((a) => a.id === (adAccount || accounts[0]?.id)) || null;

  const canNext = () => {
    if (step === 1) return isConnected && platforms.length > 0 && (accounts.length === 0 || !!(adAccount || accounts[0]?.id));
    if (step === 2) return !!brief.name.trim();
    if (step === 3) return Number(brief.dailyBudget) >= 100;
    return true;
  };
  const metaAccountId = (adAccount || accounts[0]?.id || '').replace(/^act_/, '');
  const publish = () => {
    const url = `https://adsmanager.facebook.com/adsmanager/manage/campaigns${metaAccountId ? `?act=${metaAccountId}&nav_source=manage_account` : ''}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    toast('Opening Meta Ads Manager', 'Your brief is ready below — paste it into Meta to launch.', 'success');
  };
  const briefText = `Campaign: ${brief.name}
Objective: ${brief.objective}
Schedule: ${brief.start || '—'} → ${brief.end || 'Ongoing'}
Platforms: ${platforms.join(', ')}
Ad account: ${account?.name || '—'}
Daily budget: ${brief.dailyBudget || '—'}  ·  Bid: ${brief.bid}
Audience: ${brief.locations || 'Any location'} · Age ${brief.ageMin}-${brief.ageMax} · ${brief.gender}
Headline: ${brief.headline}
Primary text: ${brief.primaryText}
Description: ${brief.description}
Call to action: ${brief.cta}
Media: ${brief.mediaUrl || '—'}
Destination: ${brief.destType === 'whatsapp' ? 'WhatsApp ' : ''}${brief.destination || '—'}`;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#F7F9FB]">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#E2ECF3] bg-white px-4 py-3 sm:px-6">
        <h2 className="text-lg font-bold text-[#0B2A44]">Create New Ad</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#5E778C] hover:bg-[#EEF3F7] hover:text-[#0B2A44]"><X size={20} /></button>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* stepper */}
        <ol className="mb-8 grid grid-cols-5 gap-2">
          {STEPS.map((s) => {
            const done = step > s.n; const active = step === s.n;
            return (
              <li key={s.n} className="flex flex-col items-center text-center">
                <span className={cx('flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold', active ? 'bg-white text-[#2E6AD1] ring-2 ring-[#2E6AD1]' : done ? 'bg-[#1AA865] text-white' : 'bg-[#E7EDF2] text-[#8296A6]')}>
                  {done ? <Check size={16} /> : s.n}
                </span>
                <span className={cx('mt-1.5 text-[12px] font-semibold', active || done ? 'text-[#0B2A44]' : 'text-[#8296A6]')}>{s.title}</span>
                <span className="hidden text-[10.5px] text-[#8296A6] sm:block">{s.sub}</span>
              </li>
            );
          })}
        </ol>

        <div className="rounded-xl border border-[#E2ECF3] bg-white p-5 sm:p-6">
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-lg font-bold text-[#0B2A44]">Connect Your Accounts</h3>
                <p className="mt-0.5 text-sm text-[#5E778C]">Link your Facebook Business Manager and choose where the ad runs.</p>
              </div>
              <div className="rounded-xl border border-[#E2ECF3] p-4">
                <div className="flex items-center gap-2"><Facebook size={18} className="text-[#2E6AD1]" /><b className="text-[15px] text-[#0B2A44]">Facebook Business Manager</b>{isConnected && <span className="inline-flex items-center gap-1 rounded-full bg-[#E7F6EE] px-2 py-0.5 text-[11px] font-semibold text-[#067647]"><Check size={11} /> Connected</span>}</div>

                {isConnected ? (
                  <div className="mt-3 space-y-3">
                    {accounts.length > 0 ? (
                      <div>
                        <label className={labelCls}>Select FB Ad Account</label>
                        <Select value={adAccount || accounts[0]?.id} onChange={(e) => setAdAccount(e.target.value)} options={accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))} />
                      </div>
                    ) : <p className="text-xs text-[#8A5A00]">Connected, but no ad account was found on this login yet. You can still prepare the ad and pick the account in Meta.</p>}
                  </div>
                ) : pending || loadingPending || pendingErr ? (
                  <div className="mt-3 space-y-2">
                    <p className="text-sm text-[#5E778C]">Choose the Facebook Page to connect:</p>
                    {loadingPending && <p className="flex items-center gap-2 text-sm text-[#5E778C]"><Loader2 size={14} className="animate-spin" /> Loading your Pages…</p>}
                    {pending?.pages.map((pg) => { const sel = pageSelectability(pg); return (
                      <label key={pg.id} className={cx('flex items-center gap-2 rounded-lg border p-2.5 text-sm', sel.selectable ? 'border-[#D3E3F0]' : 'border-[#EEF2F6] opacity-60')}>
                        <input type="checkbox" className="h-4 w-4 accent-[#2E6AD1]" disabled={!sel.selectable} checked={!!pending.choices[pg.id]?.checked} onChange={(e) => togglePage(pg.id, e.target.checked)} />
                        <span className="min-w-0"><b className="text-[#0B2A44]">{pg.name}</b>{!sel.selectable && <span className="block text-[11px] text-[#8A5A00]">{sel.reason}</span>}</span>
                      </label>
                    ); })}
                    {pendingErr && <InlineNotice tone="warning">{pendingErr}</InlineNotice>}
                    <div className="flex gap-2 pt-1">
                      <Button variant="primary" size="sm" loading={busy} disabled={loadingPending || !pending?.pages.some((p) => pending.choices[p.id]?.checked && pageSelectability(p).selectable)} onClick={() => void connectPages()}>Connect Page</Button>
                      <Button variant="secondary" size="sm" onClick={startConnect}>Use a different Facebook account</Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <p className="mb-2 text-sm text-[#5E778C]">Connect your Facebook Business Manager to access your ad accounts and pages — you stay here, no need to open Settings.</p>
                    <button type="button" onClick={startConnect} className="inline-flex items-center gap-2 rounded-lg bg-[#2E6AD1] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"><Facebook size={15} /> Continue With Facebook</button>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-[#E2ECF3] p-4">
                <b className="text-[15px] text-[#0B2A44]">Select Advertising Platforms</b>
                <p className="mt-0.5 mb-3 text-sm text-[#5E778C]">Choose where your ads appear. You can select multiple.</p>
                <div className="space-y-2">
                  {PLATFORMS.map((p) => (
                    <label key={p.id} className={cx('flex items-center gap-3 rounded-lg border p-3 text-sm', platforms.includes(p.id) ? 'border-[#2E6AD1] bg-[#F5F9FF]' : 'border-[#E2ECF3]')}>
                      <p.icon size={16} className="text-[#0B2A44]" />
                      <span className="flex-1 font-medium capitalize text-[#0B2A44]">{p.label}</span>
                      <input type="checkbox" className="h-4 w-4 accent-[#2E6AD1]" checked={platforms.includes(p.id)} onChange={(e) => togglePlatform(p.id, e.target.checked)} />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-[#0B2A44]">Campaign Setup</h3>
              <div><label className={labelCls}>Campaign name</label><input className={inputCls} value={brief.name} maxLength={120} placeholder="e.g. Amaya — 3 BHK launch" onChange={(e) => set('name', e.target.value)} autoFocus /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>Objective</label><Select value={brief.objective} onChange={(e) => set('objective', e.target.value)} options={OBJECTIVES} /></div>
                <div><label className={labelCls}>Call to action</label><Select value={brief.cta} onChange={(e) => set('cta', e.target.value)} options={CTAS} /></div>
                <div><label className={labelCls}>Schedule start</label><input type="date" className={inputCls} value={brief.start} max={brief.end || undefined} onChange={(e) => set('start', e.target.value)} /></div>
                <div><label className={labelCls}>Schedule end <span className="font-normal text-[#8296A6]">(optional)</span></label><input type="date" className={inputCls} value={brief.end} min={brief.start || undefined} onChange={(e) => set('end', e.target.value)} /></div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-[#0B2A44]">Audience &amp; Budget</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>Daily budget{account ? ` (${account.currency})` : ''}</label><input type="number" min={100} step={100} className={inputCls} value={brief.dailyBudget} placeholder="e.g. 1000" onChange={(e) => set('dailyBudget', e.target.value)} /></div>
                <div><label className={labelCls}>Bid strategy</label><Select value={brief.bid} onChange={(e) => set('bid', e.target.value)} options={BID} /></div>
              </div>
              <div><label className={labelCls}>Locations</label><input className={inputCls} value={brief.locations} placeholder="e.g. Hyderabad, Gachibowli, Kondapur" onChange={(e) => set('locations', e.target.value)} /></div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div><label className={labelCls}>Age from</label><input type="number" min={18} max={65} className={inputCls} value={brief.ageMin} onChange={(e) => set('ageMin', e.target.value)} /></div>
                <div><label className={labelCls}>Age to</label><input type="number" min={18} max={65} className={inputCls} value={brief.ageMax} onChange={(e) => set('ageMax', e.target.value)} /></div>
                <div><label className={labelCls}>Gender</label><Select value={brief.gender} onChange={(e) => set('gender', e.target.value)} options={['All', 'Men', 'Women']} /></div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-[#0B2A44]">Ad Creative</h3>
              <div><label className={labelCls}>Primary text</label><textarea className={cx(inputCls, 'min-h-[90px]')} value={brief.primaryText} maxLength={2000} placeholder="What the ad says above the image…" onChange={(e) => set('primaryText', e.target.value)} /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>Headline</label><input className={inputCls} value={brief.headline} maxLength={255} placeholder="e.g. Luxury 3 BHK from ₹1.2 Cr" onChange={(e) => set('headline', e.target.value)} /></div>
                <div><label className={labelCls}>Description <span className="font-normal text-[#8296A6]">(optional)</span></label><input className={inputCls} value={brief.description} maxLength={255} onChange={(e) => set('description', e.target.value)} /></div>
              </div>
              <div><label className={labelCls}>Media (image or video URL)</label><input className={inputCls} value={brief.mediaUrl} placeholder="Paste a link, or upload it in Meta" onChange={(e) => set('mediaUrl', e.target.value)} /></div>
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div><label className={labelCls}>Destination</label><Select value={brief.destType} onChange={(e) => set('destType', e.target.value as Brief['destType'])} options={[{ value: 'website', label: 'Website' }, { value: 'whatsapp', label: 'WhatsApp' }]} /></div>
                <div><label className={labelCls}>{brief.destType === 'whatsapp' ? 'WhatsApp number' : 'Website URL'}</label><input className={inputCls} value={brief.destination} placeholder={brief.destType === 'whatsapp' ? '+91 98765 43210' : 'https://…'} onChange={(e) => set('destination', e.target.value)} /></div>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-[#0B2A44]">Review &amp; Publish</h3>
              <p className="text-sm text-[#5E778C]">Everything is ready. Open Meta Ads Manager to launch it — your brief is below to paste in. (The CRM never spends your budget on its own.)</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-[#E2ECF3] bg-[#F7F9FB] p-4 text-[12.5px] text-[#1C2B33]">{briefText}</pre>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={publish} className="inline-flex items-center gap-2 rounded-lg bg-[#2E6AD1] px-4 py-2 text-sm font-semibold text-white hover:brightness-110">Open Meta Ads Manager <ExternalLink size={14} /></button>
                <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(briefText).then(() => toast('Copied', 'Brief copied to clipboard', 'success')).catch(() => undefined); }}>Copy brief</Button>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between border-t border-[#EEF3F7] pt-4">
            <Button variant="secondary" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>Back</Button>
            {step < 5
              ? <Button variant="primary" disabled={!canNext()} onClick={() => setStep((s) => Math.min(5, s + 1))}>Next</Button>
              : <Button variant="secondary" onClick={onClose}>Done</Button>}
          </div>
        </div>
      </div>
    </div>
  );
};
