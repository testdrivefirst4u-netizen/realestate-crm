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
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Plus, UserPlus } from 'lucide-react';
import { CRMConfig, Lead, UserAccount } from '../../types/crm';
import { F, SITE_VISIT, SITE_VISIT_DONE, STAGES, followupField } from '../../core/config';
import { isCounted } from '../../core/analytics';
import { fromDatetimeLocalInput, nowIso, toDatetimeLocalInput, toSheetDateTime } from '../../core/dates';
import { formatPhone, isLikelyPhone, samePhone } from '../../core/phone';
import { Button, Field, InlineNotice, Modal, Select, StageBadge, cx, inputCls } from '../../components/ui';
import { SmartTextarea, optionsWithCurrent } from './shared';

export interface AddLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: CRMConfig;
  leads: Lead[];
  currentUser: UserAccount | null;
  onAddLead: (lead: Partial<Lead>) => Promise<Lead | null>;
  /** Gemini key configured on the server — hides the AI reframe button when false. Defaults to true. */
  aiConfigured?: boolean;
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
  relationship: string;
  enquiredFor: string;
  brochure: string;
  rm: string;
  notes: string;
  firstRemark: string;
  nextFollowup: string; // datetime-local
  forceCreate: boolean;
}

const isVisitScheduled = (status: string) => status === SITE_VISIT.SCHEDULED;
const isVisitDone = (status: string) => SITE_VISIT_DONE.includes(status);

const AddLeadForm: React.FC<AddLeadModalProps> = ({ onClose, config, leads, currentUser, onAddLead, aiConfigured = true }) => {
  const rmOptions = config.options[F.RM] || [];
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    phone: '',
    email: '',
    enquiryDate: toDatetimeLocalInput(new Date()),
    stage: STAGES.NEW,
    source: '',
    unitType: '',
    purchaseOrRent: '',
    siteVisitStatus: (config.options[F.SITE_VISIT_STATUS] || []).includes(SITE_VISIT.PROSPECT) ? SITE_VISIT.PROSPECT : '',
    relationship: '',
    enquiredFor: '',
    brochure: (config.options[F.BROCHURE] || []).includes('No') ? 'No' : '',
    rm: currentUser?.name && rmOptions.includes(currentUser.name) ? currentUser.name : '',
    notes: '',
    nextFollowup: '',
    siteVisitDate: '',
    siteVisitDateAuto: true,
    firstRemark: '',
    forceCreate: false,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      [F.RELATIONSHIP]: form.relationship,
      [F.ENQUIRED_FOR]: form.enquiredFor,
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
    <Modal
      open
      onClose={onClose}
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
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ramesh Verma" className={inputCls} autoFocus required />
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
            <Field label="Relationship to prospect" hint="Who is enquiring">
              <Select value={form.relationship} onChange={(e) => set('relationship', e.target.value)} options={opts(F.RELATIONSHIP, form.relationship)} placeholder="Select…" />
            </Field>
            <Field label="Enquired for" hint="Who will live in the home">
              <Select value={form.enquiredFor} onChange={(e) => set('enquiredFor', e.target.value)} options={opts(F.ENQUIRED_FOR, form.enquiredFor)} placeholder="Select…" />
            </Field>
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
            <Field label="Purchase or rent">
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
  );
};
