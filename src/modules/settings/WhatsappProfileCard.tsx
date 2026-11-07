/** Settings › WhatsApp direct: the profile customers see, beside a phone preview, and asking Meta for a new name. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Camera, Globe, Mail, MapPin, RefreshCw, Store, X } from 'lucide-react';
import { api, type WaProfileView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, Field, InlineNotice, LoadingState, Select, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const LIMITS = { about: 139, address: 256, description: 512, email: 128, name: 75 };
const PHOTO_SIDE = 640;
const PHOTO_MIN = 192;
const CATEGORIES = [
  { value: '', label: 'Not chosen' }, { value: 'PROF_SERVICES', label: 'Professional Services' }, { value: 'OTHER', label: 'Other' }, { value: 'FINANCE', label: 'Finance and Banking' }, { value: 'HOTEL', label: 'Hotel and Lodging' }, { value: 'RETAIL', label: 'Shopping and Retail' }, { value: 'TRAVEL', label: 'Travel and Transportation' },
  { value: 'APPAREL', label: 'Clothing and Apparel' }, { value: 'AUTO', label: 'Automotive' }, { value: 'BEAUTY', label: 'Beauty, Spa and Salon' }, { value: 'EDU', label: 'Education' }, { value: 'ENTERTAIN', label: 'Entertainment' }, { value: 'EVENT_PLAN', label: 'Event Planning and Service' }, { value: 'GROCERY', label: 'Food and Grocery' }, { value: 'GOVT', label: 'Public Service' }, { value: 'HEALTH', label: 'Medical and Health' }, { value: 'NONPROFIT', label: 'Non-profit' }, { value: 'RESTAURANT', label: 'Restaurant' },
  { value: 'ALCOHOL', label: 'Alcoholic Beverages' }, { value: 'OTC_DRUGS', label: 'Over-the-Counter Drugs' }, { value: 'ONLINE_GAMBLING', label: 'Online Gambling and Gaming' }, { value: 'PHYSICAL_GAMBLING', label: 'Non-online Gambling and Gaming' },
];
const NAME_STATUS: Record<string, { label: string; tone: 'sage' | 'amber' | 'rust' | 'muted' }> = {
  APPROVED: { label: 'Approved', tone: 'sage' }, AVAILABLE_WITHOUT_REVIEW: { label: 'Approved', tone: 'sage' }, PENDING_REVIEW: { label: 'In review', tone: 'amber' }, DEFERRED: { label: 'In review', tone: 'amber' }, DECLINED: { label: 'Rejected', tone: 'rust' }, REJECTED: { label: 'Rejected', tone: 'rust' }, EXPIRED: { label: 'Expired', tone: 'rust' },
};

type Form = { about: string; address: string; description: string; email: string; website1: string; website2: string; vertical: string };
const formOf = (v: WaProfileView): Form => ({ about: v.profile.about, address: v.profile.address, description: v.profile.description, email: v.profile.email, website1: v.profile.websites[0] || '', website2: v.profile.websites[1] || '', vertical: v.profile.vertical });

/** A square picture, cropped from the centre, as WhatsApp shows a circle. */
export const squarePhoto = (file: File): Promise<{ name: string; mime: string; base64: string; url: string }> => new Promise((resolve, reject) => {
  if (!/^image\/(jpeg|png)$/.test(file.type)) { reject(new Error('Use a JPG or PNG picture.')); return; }
  const src = URL.createObjectURL(file);
  const img = new Image();
  img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('That picture could not be opened.')); };
  img.onload = () => {
    URL.revokeObjectURL(src);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (side < PHOTO_MIN) { reject(new Error(`That picture is too small. Use at least ${PHOTO_SIDE} by ${PHOTO_SIDE} pixels.`)); return; }
    const out = Math.min(side, PHOTO_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const g = canvas.getContext('2d');
    if (!g) { reject(new Error('That picture could not be opened.')); return; }
    g.fillStyle = '#fff'; // a see-through logo would otherwise turn black as a JPG
    g.fillRect(0, 0, out, out);
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    resolve({ name: 'profile.jpg', mime: 'image/jpeg', base64: url.split(',')[1] || '', url });
  };
  img.src = src;
});

const Count: React.FC<{ n: number; max: number }> = ({ n, max }) => <span className={cx('tabular-nums', n > max && 'font-semibold text-[#B42318]')}>{n}/{max}</span>;

const PhonePreview: React.FC<{ name: string; phone: string; picture: string; f: Form }> = ({ name, phone, picture, f }) => {
  const category = CATEGORIES.find((c) => c.value === f.vertical && c.value)?.label;
  const row = (icon: React.ReactNode, text: string, link = false) => text ? <li className="flex gap-2 border-t border-[#EEF2F6] px-3 py-2"><span className="mt-0.5 flex-none text-[#5E778C]">{icon}</span><span className={cx('min-w-0 break-words', link && 'text-[#0B6BB0]')}>{text}</span></li> : null;
  return (
    <div className="mx-auto w-full max-w-[280px] rounded-[28px] border-[6px] border-[#0B2A44] bg-[#F4F8FB] p-0 shadow-sm" aria-label="How customers see this profile">
      <div className="max-h-[520px] overflow-y-auto rounded-[22px] bg-white text-[12px] text-[#0B2A44]">
        <div className="px-3 pb-3 pt-5 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-[#DCE8F2] text-[#5E778C]">
            {picture ? <img src={picture} alt="" className="h-full w-full object-cover" /> : <Building2 size={30} aria-hidden="true" />}
          </div>
          <p className="mt-2 break-words text-sm font-semibold">{name || 'Your business'}</p>
          <p className="text-[11px] text-[#5E778C]">{phone}</p>
          <p className="mt-1 text-[11px] text-[#5E778C]">Business account</p>
        </div>
        {f.about && <div className="border-t-4 border-[#F4F8FB] px-3 py-2"><p className="text-[10.5px] text-[#5E778C]">About</p><p className="break-words">{f.about}</p></div>}
        {f.description && <p className="whitespace-pre-wrap break-words border-t-4 border-[#F4F8FB] px-3 py-2">{f.description}</p>}
        <ul className="border-t-4 border-[#F4F8FB]">
          {row(<Store size={13} aria-hidden="true" />, category || '')}
          {row(<MapPin size={13} aria-hidden="true" />, f.address)}
          {row(<Mail size={13} aria-hidden="true" />, f.email, true)}
          {row(<Globe size={13} aria-hidden="true" />, f.website1, true)}
          {row(<Globe size={13} aria-hidden="true" />, f.website2, true)}
        </ul>
      </div>
    </div>
  );
};

const NameSection: React.FC<{ view: WaProfileView; onChanged: (v: WaProfileView) => void }> = ({ view, onChanged }) => {
  const { name } = view;
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const clean = typed.trim();
  const risky = /\b(official|verified)\b/i.test(clean);
  const pendingStatus = NAME_STATUS[name.pendingStatus];
  const rejected = !!name.pending && (name.pendingStatus === 'DECLINED' || name.pendingStatus === 'REJECTED');
  const inReview = !!name.pending && !name.finish && !rejected;
  const run = async (scope: string, fn: () => Promise<WaProfileView>, done: string) => {
    setBusy(true);
    setProblem('');
    try {
      onChanged(await fn());
      toast(done, '', 'success');
      setOpen(false);
      setConfirm(false);
      setTyped('');
      setPin('');
    } catch (e) {
      setConfirm(false);
      setProblem(errText(scope, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-[#D3E3F0] bg-[#F7FBFE] p-3 text-xs text-[#3E5A70]">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-[#0B2A44]">Name on WhatsApp</p>
        <span className="break-words font-semibold text-[#0B2A44]">{name.current || '—'}</span>
        {NAME_STATUS[name.status] && <Badge tone={NAME_STATUS[name.status].tone}>{NAME_STATUS[name.status].label}</Badge>}
      </div>
      {name.pending && <p className="mt-1.5 flex flex-wrap items-center gap-2">Asked for: <b className="break-words text-[#0B2A44]">{name.pending}</b>{pendingStatus && <Badge tone={pendingStatus.tone}>{pendingStatus.label}</Badge>}</p>}
      {!name.canChange ? (
        <p className="mt-1.5">This number is also on the WhatsApp Business app, so its name is changed in the app on the phone.</p>
      ) : name.finish ? (
        <div className="mt-2 rounded-lg border border-[#F2D58A] bg-[#FFF8E6] p-2.5">
          <p className="font-semibold text-[#6B4700]">One step left, within 14 days of approval</p>
          <p className="mt-0.5 text-[#6B4700]">Meta approved this name. It only takes effect once the number is registered again. If the 14 days pass, the name has to go through review again.</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            {!name.pinSaved && <Field label="Two-step PIN"><input className={cx(inputCls, '!w-32')} type="password" inputMode="numeric" maxLength={6} autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>}
            <Button variant="primary" size="sm" loading={busy} disabled={!name.pinSaved && pin.length !== 6} onClick={() => void run('whatsappDirect.nameFinish', () => api.whatsappDirect.finishName(pin), 'New name is being applied')}>Finish name change</Button>
          </div>
        </div>
      ) : inReview ? (
        <p className="mt-1.5">Meta is reviewing it, usually within a few days. Customers keep seeing the current name until it is done.</p>
      ) : !open ? (
        <>
          {rejected && <p className="mt-1.5 text-[#B42318]">Meta rejected this name. The usual reason is that it does not clearly match the company's legal name or brand.</p>}
          <Button variant="secondary" size="xs" className="mt-2" onClick={() => setOpen(true)}>Ask for a new name</Button>
        </>
      ) : (
        <div className="mt-2 space-y-2">
          <Field label="New name" hint={<>Use the company's real name or brand, as on its website and documents. Meta reviews every change and allows 10 changes in 30 days. <Count n={clean.length} max={LIMITS.name} /></>}><input className={inputCls} maxLength={LIMITS.name} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></Field>
          {risky && <InlineNotice tone="warning">Words like “Official” or “Verified” are a common reason for rejection.</InlineNotice>}
          <div className="flex gap-2">
            <Button variant="primary" size="xs" disabled={clean.length < 3} onClick={() => setConfirm(true)}>Send to Meta for review</Button>
            <Button variant="secondary" size="xs" onClick={() => { setOpen(false); setTyped(''); }}>Cancel</Button>
          </div>
        </div>
      )}
      {problem && <InlineNotice tone="warning" className="mt-2">{problem}</InlineNotice>}
      <ConfirmDialog open={confirm} title="Send this name to Meta?" message={`Meta will review “${clean}”. If approved, you then have 14 days to finish the change here.`} confirmLabel="Send for review" loading={busy} onConfirm={() => void run('whatsappDirect.nameRequest', () => api.whatsappDirect.requestName(clean), 'Sent to Meta for review')} onCancel={() => setConfirm(false)} />
    </div>
  );
};

export const WhatsappProfileCard: React.FC<{ onNameChanged?: () => void }> = ({ onNameChanged }) => {
  const [view, setView] = useState<WaProfileView | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [photo, setPhoto] = useState<{ name: string; mime: string; base64: string; url: string } | null>(null);
  const [failed, setFailed] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const show = useCallback((v: WaProfileView) => {
    setView(v);
    setF(formOf(v));
    setPhoto(null);
    setProblem('');
  }, []);
  const load = useCallback(async () => {
    setFailed('');
    try {
      show(await api.whatsappDirect.profile());
    } catch (e) {
      setFailed(errText('whatsappDirect.profile', e));
    }
  }, [show]);
  useEffect(() => void load(), [load]);

  const dirty = useMemo(() => !!view && !!f && (!!photo || JSON.stringify(f) !== JSON.stringify(formOf(view))), [view, f, photo]);
  if (!view || !f) return <Card title="WhatsApp profile">{failed ? <div className="space-y-2"><InlineNotice tone="warning">{failed}</InlineNotice><Button variant="secondary" size="xs" onClick={() => void load()}>Try again</Button></div> : <LoadingState label="Asking Meta for the profile…" />}</Card>;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((x) => ({ ...x!, [k]: e.target.value }));
  const pickPhoto = async (file?: File) => {
    if (!file) return;
    setProblem('');
    try {
      setPhoto(await squarePhoto(file));
    } catch (e: any) {
      setProblem(e?.message || 'That picture could not be opened.');
    }
  };
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const v = await api.whatsappDirect.saveProfile({ about: f.about, address: f.address, description: f.description, email: f.email, websites: [f.website1, f.website2], vertical: f.vertical, base: view.profile, ...(photo ? { photo: { name: photo.name, mime: photo.mime, base64: photo.base64 } } : {}) });
      show(v);
      toast('WhatsApp profile saved', 'It can take a little while to show on customers’ phones.', 'success');
    } catch (e) {
      setProblem(errText('whatsappDirect.saveProfile', e));
    } finally {
      setBusy(false);
    }
  };
  const picture = photo?.url || view.profile.picture;

  return (
    <Card title="WhatsApp profile" subtitle="What customers see when they open this company's profile on WhatsApp."
      actions={<Button variant="secondary" size="xs" icon={<RefreshCw size={12} />} disabled={busy} onClick={() => void load()}>Reload</Button>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          <NameSection view={view} onChanged={(v) => { setView(v); onNameChanged?.(); }} />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-full bg-[#DCE8F2] text-[#5E778C]">{picture ? <img src={picture} alt="Profile photo" className="h-full w-full object-cover" /> : <Building2 size={24} aria-hidden="true" />}</div>
            <div className="min-w-0">
              <span className="flex flex-wrap gap-1.5">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#D3E3F0] bg-white px-2.5 py-1 text-xs font-semibold text-[#0B2A44] hover:bg-[#F2F7FB] focus-within:outline-2 focus-within:outline-[#0B6BB0]">
                  <Camera size={13} aria-hidden="true" />{view.profile.picture || photo ? 'Change photo' : 'Add photo'}
                  <input type="file" className="sr-only" accept="image/jpeg,image/png" onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {photo && <Button variant="secondary" size="xs" icon={<X size={12} />} onClick={() => setPhoto(null)}>Keep the old one</Button>}
              </span>
              <p className="mt-1 text-[11px] text-[#5E778C]">JPG or PNG, square works best. We crop it from the centre, and WhatsApp shows a circle, so keep your logo in the middle.</p>
            </div>
          </div>
          <Field label="About" hint={<>A short line under the name. <Count n={f.about.length} max={LIMITS.about} /></>}><input className={inputCls} value={f.about} onChange={set('about')} placeholder="Homes in Hyderabad. We reply within the hour." /></Field>
          <Field label="Description" hint={<>What the business does. <Count n={f.description.length} max={LIMITS.description} /></>}><textarea className={inputCls} rows={4} value={f.description} onChange={set('description')} /></Field>
          <Field label="Address" hint={<Count n={f.address.length} max={LIMITS.address} />}><input className={inputCls} value={f.address} onChange={set('address')} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="E-mail"><input className={inputCls} type="email" value={f.email} onChange={set('email')} /></Field>
            <Field label="Business category" hint="Meta has no real estate category. Professional Services is the closest."><Select value={f.vertical} onChange={set('vertical')} options={CATEGORIES} /></Field>
            <Field label="Website"><input className={inputCls} inputMode="url" value={f.website1} onChange={set('website1')} placeholder="https://" /></Field>
            <Field label="Second website (optional)"><input className={inputCls} inputMode="url" value={f.website2} onChange={set('website2')} placeholder="https://" /></Field>
          </div>
          {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
          <div className="flex items-center gap-2">
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>Save profile</Button>
            {dirty && <Button variant="secondary" disabled={busy} onClick={() => show(view)}>Discard changes</Button>}
          </div>
        </div>
        <div><p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-[#5E778C]">How customers see it</p><PhonePreview name={view.name.current} phone={view.displayPhone} picture={picture} f={f} /></div>
      </div>
    </Card>
  );
};
