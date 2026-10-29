/**
 * AddLeadModal — "New Enquiry" form.
 *
 * The form component is mounted only while the modal is open, so every field
 * (and the microphone) starts fresh on each open and is released on close.
 * Phone duplicates are detected live with `samePhone`; the user can still
 * create a second enquiry by ticking "Create anyway" (`_forceCreate: true`).
 * A scheduled site visit needs its date & time; a completed / walk-in visit
 * offers one pre-filled with now. An optional first remark is saved as
 * "Follow-up 1" in the sheet's "yyyy-MM-dd HH:mm — remark" format.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Maximize2, Plus, UserPlus, X } from 'lucide-react';
import { CRMConfig, Lead, UserAccount } from '../../types/crm';
import { F, SITE_VISIT, SITE_VISIT_DONE, STAGES, followupField } from '../../core/config';
import { isCounted } from '../../core/analytics';
import { fromDatetimeLocalInput, nowIso, toDatetimeLocalInput, toSheetDateTime } from '../../core/dates';
import { formatPhone, isLikelyPhone, samePhone } from '../../core/phone';
import { Button, Field, InlineNotice, Modal, Select, StageBadge, cx, inputCls } from '../../components/ui';
import { SmartTextarea, optionsWithCurrent } from './shared';
import { GeoFields } from './GeoFields';

export interface AddLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: CRMConfig;
  leads: Lead[];
  currentUser: UserAccount | null;
  onAddLead: (lead: Partial<Lead>) => Promise<Lead | null>;
  /** Gemini key configured on the server — hides the AI reframe button when false. Defaults to true. */
  aiConfigured?: boolean;
  /** The company's default RM (Settings › Alerts & follow-ups), pre-selected in Assigned RM. */
  defaultRm?: string;
  /** Pre-filled phone number (e.g. "Create lead" from the call window for an unknown caller). */
  initialPhone?: string;
  /** Changes each time "New Enquiry" is pressed: restores a minimised form. */
  openSignal?: number;
}

export const AddLeadModal: React.FC<AddLeadModalProps> = (props) => {
  if (!props.isOpen) return null;
  return <AddLeadForm {...props} />;
};

/* -------------------------------------------------------------------------- */

interface FormState {
  name: string;
  phone: string;
  email: string;
  enquiryDate: string; // datetime-local
  stage: string;
  source: string;
  unitType: string;
  purchaseOrRent: string;
  siteVisitStatus: string;
  siteVisitDate: string; // datetime-local — sent only for Scheduled / Completed / Walk-In
  /** siteVisitDate holds the automatic "now" default rather than a time the user chose. */
  siteVisitDateAuto: boolean;
  salutation: string;
  enquiredFor: string;
  country: string;
  state: string;
  city: string;
  area: string;
  referredBy: string;
  otherProject: string;
  brochure: string;
  rm: string;
  notes: string;
  firstRemark: string;
  nextFollowup: string; // datetime-local
  forceCreate: boolean;
}

const GEO_KEY: Record<string, 'country' | 'state' | 'city' | 'area'> = { [F.COUNTRY]: 'country', [F.STATE]: 'state', [F.CITY]: 'city', [F.AREA]: 'area' };

const isVisitScheduled =(status: string) => status === SITE_VISIT.SCHEDULED;
const isVisitDone = (status: string) => SITE_VISIT_DONE.includes(status);

const AddLeadForm: React.FC<AddLeadModalProps> = ({ onClose, config, leads, currentUser, onAddLead, aiConfigured = true, defaultRm, initialPhone, openSignal }) => {
  const rmOptions = config.options[F.RM] || [];
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    phone: initialPhone || '',
    email: '',
    enquiryDate: toDatetimeLocalInput(new Date()),
    stage: STAGES.NEW,
    source: '',
    unitType: '',
    purchaseOrRent: '',
    siteVisitStatus: (config.options[F.SITE_VISIT_STATUS] || []).includes(SITE_VISIT.PROSPECT) ? SITE_VISIT.PROSPECT : '',
    salutation: '',
    enquiredFor: '',
    country: 'India',
    state: '',
    city: '',
    area: '',
    referredBy: '',
    otherProject: '',
    brochure: (config.options[F.BROCHURE] || []).includes('No') ? 'No' : '',
    rm: defaultRm && rmOptions.includes(defaultRm) ? defaultRm : currentUser?.name && rmOptions.includes(currentUser.name) ? currentUser.name : '',
    notes: '',
    nextFollowup: '',
    siteVisitDate: '',
    siteVisitDateAuto: true,
    firstRemark: '',
    forceCreate: false,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Minimised to a small bar: the form stays filled in while the user looks something up. */
  const [minimized, setMinimized] = useState(false);
  // "New Enquiry" pressed again while minimised: bring this form back
  useEffect(() => setMinimized(false), [openSignal]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  /** Site-visit status drives the date field: Scheduled → pick a date (default tomorrow 11:00), Completed / Walk-In → default now. */
  const setVisitStatus = (status: string) => {
    setError(null);
    setForm((f) => {
      const next: FormState = { ...f, siteVisitStatus: status };
      if (isVisitScheduled(status) || isVisitDone(status)) {
        if (!f.siteVisitDate || f.siteVisitDateAuto) {
          const d = new Date();
          if (isVisitScheduled(status)) { d.setDate(d.getDate() + 1); d.setHours(11, 0, 0, 0); }
          next.siteVisitDate = toDatetimeLocalInput(d);
          next.siteVisitDateAuto = true;
        }
      }
      return next;
    });
  };
  const showVisitDate = isVisitScheduled(form.siteVisitStatus) || isVisitDone(form.siteVisitStatus);

  // Live duplicate check — mirrors the backend rule (trashed leads do not block).
  const duplicate = useMemo(() => {
    if (!isLikelyPhone(form.phone)) return null;
    return leads.find((l) => isCounted(l) && samePhone(l[F.PHONE], form.phone)) || null;
  }, [leads, form.phone]);

  const nameOk = form.name.trim().length > 0;
  const phoneOk = isLikelyPhone(form.phone);
  const canSubmit = nameOk && phoneOk && (!duplicate || form.forceCreate) && !submitting;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!nameOk) return setError('Prospect name is required.');
    if (!phoneOk) return setError('Enter a valid phone number (10 digits, or with country code).');
    if (duplicate && !form.forceCreate) return setError(`This number already belongs to ${duplicate[F.ID]}. Tick “Create anyway” to add a second enquiry.`);
    setError(null);
    setSubmitting(true);
    const lead: Partial<Lead> = {
      [F.NAME]: form.name.trim(),
      [F.PHONE]: form.phone.trim(),
      [F.EMAIL]: form.email.trim(),
      [F.ENQUIRY_DATE]: fromDatetimeLocalInput(form.enquiryDate) || nowIso(),
      [F.STAGE]: form.stage || STAGES.NEW,
      [F.SOURCE]: form.source,
      [F.UNIT_TYPE]: form.unitType,
      [F.PURCHASE_OR_RENT]: form.purchaseOrRent,
      [F.SITE_VISIT_STATUS]: form.siteVisitStatus,
      [F.SALUTATION]: form.salutation,
      [F.ENQUIRED_FOR]: form.enquiredFor,
      [F.COUNTRY]: form.country.trim(),
      [F.STATE]: form.state.trim(),
      [F.CITY]: form.city.trim(),
      [F.AREA]: form.area.trim(),
      [F.REFERRED_BY]: form.referredBy.trim(),
      [F.OTHER_PROJECT]: form.otherProject.trim(),
      [F.BROCHURE]: form.brochure,
      [F.RM]: form.rm,
      [F.NOTES]: form.notes.trim(),
      [F.NEXT_FOLLOWUP]: fromDatetimeLocalInput(form.nextFollowup),
    };
    if (showVisitDate && form.siteVisitDate) lead[F.SITE_VISIT_DATE] = fromDatetimeLocalInput(form.siteVisitDate);
    const remark = form.firstRemark.trim();
    if (remark) {
      // Same format the backend uses for appendRemark, so the timeline, follow-up counts and reports see it.
      const stamp = new Date();
      lead[followupField(1)] = `${toSheetDateTime(stamp)} — ${remark}`;
      lead[F.LAST_FOLLOWUP] = stamp.toISOString();
    }
    if (form.forceCreate) lead._forceCreate = true;
    const created = await onAddLead(lead);
    setSubmitting(false);
    if (created) onClose(); // the engine already toasted "Enquiry created"
  };

  const opts = (field: string, current: string) => optionsWithCurrent(config.options[field], current);

  return (
    <>
    <Modal
      open
      onClose={onClose}
      onMinimize={() => setMinimized(true)}
      minimized={minimized}
      width="lg"
      title={
        <span className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-[#0B2A44] text-white flex items-center justify-center">
            <UserPlus size={15} />
          </span>
          New Enquiry
        </span>
      }
      subtitle="Record a new prospect — it is saved to the Enquiry Log immediately."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="add-lead-form" variant="primary" disabled={!canSubmit} loading={submitting} icon={<Plus size={14} />}>
            Save Enquiry
          </Button>
        </>
      }
    >
      <form id="add-lead-form" onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
        {/* Prospect */}
        <section className="space-y-3">
          <h4 className="text-sm font-bold text-[#0B2A44] pb-1 border-b border-[#E6EFF6]">Prospect</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Prospect name *">
              <div className="flex gap-2">
                <Select value={form.salutation} onChange={(e) => set('salutation', e.target.value)} options={opts(F.SALUTATION, form.salutation)} placeholder="Title" aria-label="Salutation" className="w-24 shrink-0" />
                <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ramesh Verma" className={inputCls} autoFocus required />
              </div>
            </Field>
            <Field label="Phone number *" hint={form.phone && phoneOk ? formatPhone(form.phone) : 'Indian mobile (10 digits) or with +91'}>
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98490 12345" inputMode="tel" className={cx(inputCls, duplicate && !form.forceCreate && 'border-amber-400')} required />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="ramesh@example.com" className={inputCls} />
            </Field>
            <Field label="Enquiry source">
              <Select value={form.source} onChange={(e) => set('source', e.target.value)} options={opts(F.SOURCE, form.source)} placeholder="Select source…" />
            </Field>
            <Field label="Referred by" hint="Who referred them, if anyone">
              <input value={form.referredBy} onChange={(e) => set('referredBy', e.target.value)} placeholder="e.g. Mr Rao (resident, A-704)" className={inputCls} />
            </Field>
            <Field label="Considering other project" hint="Name of a project they are also looking at">
              <input value={form.otherProject} onChange={(e) => set('otherProject', e.target.value)} placeholder="e.g. Project name" className={inputCls} />
            </Field>
            <Field label="Enquired for" hint="Who will live in the home">
              <Select value={form.enquiredFor} onChange={(e) => set('enquiredFor', e.target.value)} options={opts(F.ENQUIRED_FOR, form.enquiredFor)} placeholder="Select…" />
            </Field>
            <GeoFields leads={leads} value={(f) => form[GEO_KEY[f]]} onChange={(f, v) => set(GEO_KEY[f], v)} />
          </div>

          {duplicate && (
            <InlineNotice tone="warning">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <div>
                    This phone number already belongs to <strong className="font-mono">{duplicate[F.ID]}</strong> · <strong>{duplicate[F.NAME] || 'Unnamed'}</strong> <StageBadge stage={String(duplicate[F.STAGE] || '')} />
                    {duplicate[F.RM] && <span className="text-[#5E778C]"> · RM {duplicate[F.RM]}</span>}
                  </div>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.forceCreate} onChange={(e) => set('forceCreate', e.target.checked)} className="accent-[#0B6BB0]" />
                    <span className="font-semibold">Create anyway — this is a separate enquiry from the same number</span>
                  </label>
                </div>
              </div>
            </InlineNotice>
          )}
        </section>

        {/* Enquiry */}
        <section className="space-y-3">
          <h4 className="text-sm font-bold text-[#0B2A44] pb-1 border-b border-[#E6EFF6]">Enquiry</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Enquiry date & time">
              <input type="datetime-local" value={form.enquiryDate} onChange={(e) => set('enquiryDate', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Lead stage">
              <Select value={form.stage} onChange={(e) => set('stage', e.target.value)} options={opts(F.STAGE, form.stage).filter((s) => s !== STAGES.TRASH && s !== STAGES.DELETED)} />
            </Field>
            <Field label="Unit type interested in">
              <Select value={form.unitType} onChange={(e) => set('unitType', e.target.value)} options={opts(F.UNIT_TYPE, form.unitType)} placeholder="Select…" />
            </Field>
            <Field label="Purpose">
              <Select value={form.purchaseOrRent} onChange={(e) => set('purchaseOrRent', e.target.value)} options={opts(F.PURCHASE_OR_RENT, form.purchaseOrRent)} placeholder="Select…" />
            </Field>
            <Field label="Site visit status">
              <Select value={form.siteVisitStatus} onChange={(e) => setVisitStatus(e.target.value)} options={opts(F.SITE_VISIT_STATUS, form.siteVisitStatus)} placeholder="Select…" />
            </Field>
            {showVisitDate && (
              <Field label={isVisitScheduled(form.siteVisitStatus) ? 'Scheduled site visit — date & time' : 'Site visit date & time'} hint={isVisitScheduled(form.siteVisitStatus) ? 'Shows on the Follow-ups board and the dashboard' : 'When the visit took place'}>
                <input
                  type="datetime-local"
                  value={form.siteVisitDate}
                  onChange={(e) => setForm((f) => ({ ...f, siteVisitDate: e.target.value, siteVisitDateAuto: false }))}
                  className={inputCls}
                />
              </Field>
            )}
            <Field label="Brochure shared">
              <Select value={form.brochure} onChange={(e) => set('brochure', e.target.value)} options={opts(F.BROCHURE, form.brochure)} placeholder="Select…" />
            </Field>
            <Field label="Assigned RM">
              <Select value={form.rm} onChange={(e) => set('rm', e.target.value)} options={opts(F.RM, form.rm)} placeholder="Unassigned" />
            </Field>
            <Field label="Next follow-up" hint="Optional — shows on the Follow-ups board">
              <input type="datetime-local" value={form.nextFollowup} onChange={(e) => set('nextFollowup', e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Initial notes & requirements" hint="Budget, preferred floor or tower, family members, food preferences, decision timeline…">
            <SmartTextarea value={form.notes} onChange={(v) => set('notes', v)} rows={3} placeholder="Type, dictate, or paste the enquiry message…" scope="leads.reframe" aiEnabled={aiConfigured} />
          </Field>
          <Field label="First follow-up remark" hint="Optional — what was discussed on the first call or message. Saved as Follow-up 1 with today's date and time.">
            <SmartTextarea value={form.firstRemark} onChange={(v) => set('firstRemark', v)} rows={2} placeholder="e.g. Spoke to Mr Verma — looking for a 2 BHK for his parents, wants to visit this Saturday" scope="leads.reframe" aiEnabled={aiConfigured} />
          </Field>
        </section>

        {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      </form>
    </Modal>
    {minimized && (
      <div className="fixed z-40 right-3 bottom-24 lg:bottom-5 flex items-center gap-1 rounded-xl bg-[#0B2A44] text-white shadow-[0_8px_24px_rgba(10,31,51,0.3)] pl-3 pr-1 py-1 max-w-[calc(100vw-24px)]" role="region" aria-label="New Enquiry (minimised)">
        <button type="button" onClick={() => setMinimized(false)} className="flex items-center gap-2 min-w-0 py-1.5 text-[13px] font-semibold" title="Open the enquiry form again">
          <UserPlus size={15} className="flex-none text-[#36B3F2]" />
          <span className="truncate">New Enquiry{form.name.trim() ? ` · ${form.name.trim()}` : ''}</span>
          <Maximize2 size={13} className="flex-none opacity-70" />
        </button>
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/15" aria-label="Discard the enquiry" title="Discard"><X size={14} /></button>
      </div>
    )}
    </>
  );
};
