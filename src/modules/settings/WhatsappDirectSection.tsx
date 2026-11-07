/** Settings › WhatsApp direct (plan feature whatsappDirect; server: modules/whatsappDirect.ts): connect a number through Meta, and its templates. */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Smartphone, Trash2, Zap } from 'lucide-react';
import { api, type WaDirectTemplate, type WaDirectView, type WaSignupConfig } from '../../core/api';
import { formatRelative } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, Field, InlineNotice, LoadingState, Modal, Select, cx, inputCls } from '../../components/ui';
import { loadSignupSdk, startSignup } from './whatsappSignup';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const STATUS: Record<string, { label: string; tone: 'sage' | 'amber' | 'muted' | 'rust' }> = {
  APPROVED: { label: 'Approved', tone: 'sage' }, PENDING: { label: 'In review', tone: 'amber' }, IN_APPEAL: { label: 'In appeal', tone: 'amber' }, REJECTED: { label: 'Rejected', tone: 'rust' },
  PAUSED: { label: 'Paused', tone: 'amber' }, DISABLED: { label: 'Disabled', tone: 'rust' },
};
const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'en_US', label: 'English (US)' }, { value: 'hi', label: 'Hindi' }, { value: 'te', label: 'Telugu' }, { value: 'ta', label: 'Tamil' }, { value: 'kn', label: 'Kannada' }, { value: 'ml', label: 'Malayalam' }, { value: 'mr', label: 'Marathi' }, { value: 'gu', label: 'Gujarati' }, { value: 'bn', label: 'Bengali' }, { value: 'pa', label: 'Punjabi' }];
const valuesIn = (body: string) => [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];

const ConnectForm: React.FC<{ current?: { phoneNumberId: string; wabaId: string }; onDone: () => void; onCancel?: () => void }> = ({ current, onDone, onCancel }) => {
  const [f, setF] = useState({ phoneNumberId: current?.phoneNumberId || '', wabaId: current?.wabaId || '', token: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const r = await api.whatsappDirect.connect(f);
      toast('WhatsApp connected', `${r.displayPhone}${r.verifiedName ? ` · ${r.verifiedName}` : ''}`, 'success');
      if (!r.webhookSubscribed) toast('Incoming messages are not on yet', 'Meta did not subscribe this account to the app. Check the webhook setup, then save again.', 'alert');
      onDone();
    } catch (e) {
      setProblem(errText('whatsappDirect.connect', e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <InlineNotice tone="warning">Use a spare number, never one already on Chat360 or another provider. Connecting a number that is in use could stop it working there.</InlineNotice>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone number ID" hint="Meta app › WhatsApp › API Setup. Not the phone number itself."><input className={inputCls} inputMode="numeric" value={f.phoneNumberId} onChange={set('phoneNumberId')} autoComplete="off" /></Field>
        <Field label="WhatsApp Business Account ID" hint="On the same page."><input className={inputCls} inputMode="numeric" value={f.wabaId} onChange={set('wabaId')} autoComplete="off" /></Field>
      </div>
      <Field label="Access token" hint={current ? 'Leave empty to keep the saved one. It is stored encrypted and never shown again.' : 'A permanent system user token with the two WhatsApp permissions. It is stored encrypted and never shown again.'}><input className={inputCls} type="password" value={f.token} onChange={set('token')} autoComplete="new-password" /></Field>
      <Field label="Two-step PIN (only for a real number being registered)" hint="6 digits you choose. Leave empty for Meta's test number, or a number already registered. It is not saved."><input className={cx(inputCls, '!w-40')} type="password" inputMode="numeric" maxLength={6} value={f.pin} onChange={set('pin')} autoComplete="new-password" /></Field>
      {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
      <div className="flex gap-2">
        <Button variant="primary" loading={busy} disabled={!f.phoneNumberId.trim() || !f.wabaId.trim() || (!current && !f.token.trim())} onClick={() => void save()}>Connect</Button>
        {onCancel && <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
};

/** Meta's own popup: the company picks its number there, and nobody handles a token. */
const SignupChoice: React.FC<{ signup: WaSignupConfig; onDone: () => void }> = ({ signup, onDone }) => {
  const [sdkReady, setSdkReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    loadSignupSdk(signup).then(() => { if (live) setSdkReady(true); }, (e) => { if (live) setProblem(e.message); });
    return () => { live = false; };
  }, [signup]);
  const connect = (keepApp: boolean) => {
    setProblem('');
    setBusy(keepApp ? 'app' : 'new');
    // straight from the click, or the browser blocks the popup
    startSignup(signup, keepApp).then(async (r) => {
      if (!r) return; // closed without finishing
      const done = await api.whatsappDirect.finishSignup({ code: r.code, wabaId: r.wabaId, phoneNumberId: r.phoneNumberId, keepApp });
      toast('WhatsApp connected', `${done.displayPhone}${done.verifiedName ? ` · ${done.verifiedName}` : ''}`, 'success');
      if (!done.webhookSubscribed) toast('Incoming messages are not on yet', 'Meta did not subscribe this account to the app. Ask Platform support to check it.', 'alert');
      onDone();
    }).catch((e) => setProblem(errText('whatsappDirect.signup', e))).finally(() => setBusy(''));
  };
  const box = 'flex flex-col rounded-xl border border-[#D3E3F0] bg-white p-4';
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className={box}>
          <p className="flex items-center gap-2 text-sm font-bold text-[#0B2A44]"><Smartphone size={16} className="text-[#0B6BB0]" aria-hidden="true" />Keep using the WhatsApp Business app</p>
          <p className="mt-1 text-xs text-[#3E5A70]">The number stays on the phone and also works in the CRM. Chats stay in step both ways, and up to 6 months of old chats can come in.</p>
          <ul className="mt-2 flex-1 list-disc space-y-0.5 pl-4 text-[11.5px] text-[#5E778C]">
            <li>WhatsApp on Windows stops working on this number</li>
            <li>Broadcast lists become read-only</li>
            <li>Open the app on the phone at least every 2 weeks, or it disconnects</li>
            <li>Quick replies and labels stay on the phone</li>
          </ul>
          <Button variant="primary" className="mt-3" disabled={!sdkReady || !!busy} loading={busy === 'app'} onClick={() => connect(true)}>Connect my Business app number</Button>
        </div>
        <div className={box}>
          <p className="flex items-center gap-2 text-sm font-bold text-[#0B2A44]"><Zap size={16} className="text-[#0B6BB0]" aria-hidden="true" />Use a new number, CRM only</p>
          <p className="mt-1 text-xs text-[#3E5A70]">For a number not on WhatsApp yet, or one you can clear from WhatsApp first. Your team uses it only in the CRM, with no phone to keep open.</p>
          <ul className="mt-2 flex-1 list-disc space-y-0.5 pl-4 text-[11.5px] text-[#5E778C]">
            <li>No old chats to bring in</li>
            <li>The number cannot also be used in the WhatsApp app</li>
          </ul>
          <Button variant="secondary" className="mt-3" disabled={!sdkReady || !!busy} loading={busy === 'new'} onClick={() => connect(false)}>Connect a new number</Button>
        </div>
      </div>
      <InlineNotice tone="warning">Do not use a number that is on Chat360 or another provider. It would have to be released there first.</InlineNotice>
      {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
    </div>
  );
};

const PastChats: React.FC<{ view: Extract<WaDirectView, { connected: true }>; busy: boolean; onAsk: () => void }> = ({ view, busy, onAsk }) => {
  const { sync, syncOpen } = view;
  const done = sync.progress >= 100;
  let words = 'Waiting for the phone. Keep the WhatsApp Business app open while this runs.';
  if (sync.declined) words = 'Sharing old chats was declined on the phone. New messages still work. To bring them in, disconnect and connect again, and accept sharing.';
  else if (done) words = 'Old chats have been brought in. Photos and files from before connecting stay on the phone.';
  else if (sync.progress > 0) words = `Bringing in old chats: ${sync.progress}%. Keep the WhatsApp Business app open.`;
  const canAsk = !sync.declined && syncOpen && (!sync.historyAsked || !sync.contactsAsked);
  return (
    <div className="mt-3 rounded-lg border border-[#D3E3F0] bg-[#F7FBFE] p-3 text-xs text-[#3E5A70]">
      <p className="font-semibold text-[#0B2A44]">Old chats from the phone</p>
      <p className="mt-0.5">{canAsk && !sync.error ? 'Not started yet. Meta allows this once, within 24 hours of connecting.' : !syncOpen && !sync.historyAsked ? 'The 24 hours Meta allows have passed. To bring them in, disconnect and connect again.' : words}</p>
      {!sync.declined && sync.progress > 0 && !done && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#DCE8F2]" role="progressbar" aria-valuenow={sync.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Old chats brought in"><div className="h-full rounded-full bg-[#0B6BB0]" style={{ width: `${sync.progress}%` }} /></div>}
      {sync.error && <p className="mt-1 text-[#B42318]">Meta said: {sync.error}</p>}
      {canAsk && <Button variant="secondary" size="xs" className="mt-2" loading={busy} onClick={onAsk}>{sync.error ? 'Try again' : 'Bring in old chats'}</Button>}
      <p className="mt-2 text-[11px] text-[#5E778C]">Old chats join the chat list, and link to a lead where the number matches. They never create new leads, so family and vendors on the phone do not become enquiries.</p>
    </div>
  );
};

const TemplateModal: React.FC<{ onClose: () => void; onSaved: () => void }> = ({ onClose, onSaved }) => {
  const [f, setF] = useState({ name: '', category: 'UTILITY', language: 'en', body: '', footer: '' });
  const [examples, setExamples] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const names = valuesIn(f.body);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      await api.whatsappDirect.createTemplate({ ...f, examples: names.map((n) => examples[n] || '') });
      toast('Template sent to Meta for review', f.name, 'success');
      onSaved();
    } catch (e) {
      setProblem(errText('whatsappDirect.createTemplate', e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="New WhatsApp template"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Send for review</Button></>}>
      <div className="space-y-3">
        <Field label="Name" hint="Small letters, numbers and underscores."><input className={inputCls} value={f.name} onChange={set('name')} placeholder="site_visit_reminder" autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" hint="Marketing costs more than Utility. Meta can change the type when it reviews."><Select value={f.category} onChange={set('category')} options={[{ value: 'UTILITY', label: 'Utility' }, { value: 'MARKETING', label: 'Marketing' }]} /></Field>
          <Field label="Language"><Select value={f.language} onChange={set('language')} options={LANGUAGES} /></Field>
        </div>
        <Field label="Message" hint="Use {{1}}, {{2}} for what changes, with words before and after."><textarea className={inputCls} rows={4} maxLength={1024} value={f.body} onChange={set('body')} placeholder="Hello {{1}}, your site visit is on {{2}}. Reply here if you need to change it." /></Field>
        {names.map((n) => <Field key={n} label={`Example for {{${n}}}`}><input className={inputCls} value={examples[n] || ''} onChange={(e) => setExamples((x) => ({ ...x, [n]: e.target.value }))} /></Field>)}
        <Field label="Footer (optional)"><input className={inputCls} maxLength={60} value={f.footer} onChange={set('footer')} /></Field>
        {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
      </div>
    </Modal>
  );
};

export const WhatsappDirectSection: React.FC = () => {
  const [data, setData] = useState<WaDirectView | null>(null);
  const [failed, setFailed] = useState('');
  const [changing, setChanging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [removing, setRemoving] = useState<WaDirectTemplate | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.whatsappDirect.get());
      setFailed('');
    } catch (e) {
      setFailed(errText('whatsappDirect.get', e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (key: string, scope: string, fn: () => Promise<unknown>, title: string) => {
    setBusy(key);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      toast(title, errText(scope, e), 'alert');
      return false;
    } finally {
      setBusy('');
    }
  };

  if (!data) return failed ? <InlineNotice tone="warning">{failed}</InlineNotice> : <LoadingState label="Loading WhatsApp…" />;

  const webhook = (
    <details className="rounded-lg border border-[#D3E3F0] bg-[#F7FBFE] p-3 text-xs text-[#3E5A70]">
      <summary className="cursor-pointer font-semibold text-[#0B2A44]">Set up incoming messages in the Meta app</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-4">
        <li>Open the Meta app, then WhatsApp › Configuration.</li>
        <li>Callback URL: <code className="break-all rounded bg-white px-1">{data.webhookUrl || 'Your CRM address + /api/webhooks/meta'}</code>. Verify token: the same one as your Meta Leads webhook.</li>
        <li>Under Webhook fields, subscribe to <b>messages</b>, <b>message_template_status_update</b>, <b>account_update</b>, <b>history</b>, <b>smb_app_state_sync</b> and <b>smb_message_echoes</b>.</li>
      </ol>
    </details>
  );

  if (!data.connected) {
    return (
      <Card title="Connect WhatsApp" subtitle="Send and receive WhatsApp in the CRM through Meta, instead of Chat360. Until a number is connected here, nothing changes.">
        <div className="space-y-3">
          {data.signup.ready ? (
            <>
              <SignupChoice signup={data.signup} onDone={() => void load()} />
              {data.signup.solutionId ? null : <p className="text-[11px] text-[#5E778C]">Meta will ask this company to add its own payment method, because no billing partner is set up yet.</p>}
              <details className="rounded-lg border border-[#D3E3F0] p-3"><summary className="cursor-pointer text-xs font-semibold text-[#0B2A44]">Enter the details by hand instead</summary><div className="mt-3"><ConnectForm onDone={() => void load()} /></div></details>
            </>
          ) : (
            <>
              <InlineNotice tone="info">The one-click connection is not set up on this platform yet, so a number can only be entered by hand for now.</InlineNotice>
              <ConnectForm onDone={() => void load()} />
            </>
          )}
          {webhook}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="WhatsApp direct" subtitle="This company's WhatsApp is going through Meta. Chat360 is not used for sending."
        actions={<span className="flex gap-1.5"><Button variant="secondary" size="xs" onClick={() => setChanging((v) => !v)}>Change</Button><Button variant="secondary" size="xs" onClick={() => setDisconnecting(true)}>Disconnect</Button></span>}>
        <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-[#5E778C]">Number</dt><dd className="font-semibold text-[#0B2A44]">{data.displayPhone}</dd></div>
          <div><dt className="text-[#5E778C]">Name on WhatsApp</dt><dd className="font-semibold text-[#0B2A44]">{data.verifiedName || '—'}</dd></div>
          <div><dt className="text-[#5E778C]">Quality from Meta</dt><dd className="font-semibold text-[#0B2A44]">{data.quality ? data.quality.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—'}</dd></div>
          <div><dt className="text-[#5E778C]">Last message received</dt><dd className="font-semibold text-[#0B2A44]">{data.lastInboundAt ? formatRelative(data.lastInboundAt) : 'None yet'}</dd></div>
        </dl>
        {data.mode === 'coexistence' && <p className="mt-3 text-xs text-[#3E5A70]"><Smartphone size={12} className="mr-1 inline" aria-hidden="true" />Also on the WhatsApp Business app. Open the app on the phone at least every 2 weeks, or Meta disconnects it.</p>}
        {data.problem && <InlineNotice tone="warning" className="mt-3">{data.problem}</InlineNotice>}
        {data.mode === 'coexistence' && <PastChats view={data} busy={busy === 'past'} onAsk={() => void act('past', 'whatsappDirect.pastChats', () => api.whatsappDirect.pastChats(), 'Not started')} />}
        {!data.lastInboundAt && <div className="mt-3">{webhook}</div>}
        {changing && <div className="mt-3 border-t border-[#E3EDF5] pt-3"><ConnectForm current={{ phoneNumberId: data.phoneNumberId, wabaId: data.wabaId }} onDone={() => { setChanging(false); void load(); }} onCancel={() => setChanging(false)} /></div>}
      </Card>

      <Card title="Templates" subtitle="Meta must approve a template before it can be sent. A customer who has not written in 24 hours can only get one of these."
        actions={<span className="flex gap-1.5"><Button variant="secondary" size="xs" icon={<RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} />} disabled={!!busy} onClick={() => void act('sync', 'whatsappDirect.sync', () => api.whatsappDirect.syncTemplates(), 'Not refreshed')}>Refresh</Button><Button variant="primary" size="xs" icon={<Plus size={12} />} onClick={() => setAdding(true)}>New template</Button></span>}>
        {!data.templates.length ? <p className="py-4 text-center text-xs text-[#5E778C]">No templates yet.</p> : (
          <ul className="divide-y divide-[#E3EDF5]">
            {data.templates.map((t) => {
              const s = STATUS[t.status] || { label: t.status.toLowerCase(), tone: 'muted' as const };
              return (
                <li key={`${t.name}:${t.language}`} className="flex flex-wrap items-start gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-[#0B2A44]"><span className="break-all">{t.name}</span><Badge tone={s.tone}>{s.label}</Badge><span className="text-[11px] font-normal text-[#5E778C]">{t.language} · {t.category.toLowerCase()}</span></p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-[#3E5A70]">{t.body}</p>
                    {t.reason && <p className="mt-0.5 text-[11px] text-[#B42318]">Meta's reason: {t.reason.toLowerCase().replace(/_/g, ' ')}</p>}
                    {!t.sendable && <p className="mt-0.5 text-[11px] text-[#8A5A00]">{t.notSendable}</p>}
                  </div>
                  <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} aria-label={`Delete ${t.name}`} onClick={() => setRemoving(t)} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {adding && <TemplateModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
      <ConfirmDialog open={!!removing} danger title="Delete this template?" message={`Meta deletes “${removing?.name}” in every language. Anything still using it, like a drip campaign, will stop being able to send it.`} confirmLabel="Delete" loading={busy === 'delete'}
        onConfirm={() => void act('delete', 'whatsappDirect.deleteTemplate', () => api.whatsappDirect.deleteTemplate(removing!.name), 'Not deleted').then(() => setRemoving(null))} onCancel={() => setRemoving(null)} />
      <ConfirmDialog open={disconnecting} danger title="Disconnect this number?" message="Messages stop going through Meta and return to Chat360, if this company has it. Chats already here stay. The number stays yours on Meta." confirmLabel="Disconnect" loading={busy === 'disconnect'}
        onConfirm={() => void act('disconnect', 'whatsappDirect.disconnect', () => api.whatsappDirect.disconnect(), 'Not disconnected').then(() => setDisconnecting(false))} onCancel={() => setDisconnecting(false)} />
    </div>
  );
};
