/**
 * LeadDetailModal — slide-over with Details · Timeline · Follow-ups · Calls · WhatsApp · Files.
 *
 * The panel is mounted only while open and is keyed on the lead id, so every
 * piece of local state (form edits, loaded tabs, microphone) resets when the
 * lead changes and is discarded when the modal closes.
 */
import React, { useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { Building2, Check, Copy, FileText, History, Mail, MessageCircle, MessageSquare, Phone, PhoneCall, Save, Sparkles, Trash2, User } from 'lucide-react';
import { CRMConfig, CRMSettings, InventoryUnit, Lead, TaskItem, UserAccount } from '../../types/crm';
import { F, LEAD_DATE_FIELDS, STAGES, STAGE_CLASS } from '../../core/config';
import { api } from '../../core/api';
import { followupCount } from '../../core/analytics';
import { formatDateTime, fromDatetimeLocalInput, nowIso, parseDate, toDatetimeLocalInput } from '../../core/dates';
import { fillTemplate, formatPhone, isLikelyPhone, mailtoLink, telLink, whatsappLink } from '../../core/phone';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { sound } from '../../services/sound';
import { Badge, Button, ConfirmDialog, Field, InlineNotice, Modal, Select, StageBadge, Tabs, cx, inputCls } from '../../components/ui';
import type { OpenCopilot } from '../ai/copilotContext';
import { LeadStars, optionsWithCurrent } from './shared';
import { TimelineTab } from './detail/TimelineTab';
import { FollowupsTab } from './detail/FollowupsTab';
import { CallsTab } from './detail/CallsTab';
import { WhatsAppTab } from './detail/WhatsAppTab';
import { FilesTab } from './detail/FilesTab';

export interface LeadDetailModalProps {
  lead: Lead | null;
  config: CRMConfig;
  settings: CRMSettings;
  currentUser: UserAccount | null;
  isOpen: boolean;
  onClose: () => void;
  onSaveLead: (id: string, patch: Partial<Lead>) => Promise<Lead | null>;
  onAppendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  onTrashLead: (id: string) => Promise<boolean>;
  onAddTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
  canTrash: boolean;
  canEdit: boolean;
  aiConfigured: boolean;
  chatEnabled: boolean;
  /** The company's plan includes call history (Calls tab). Default true. */
  callsFeature?: boolean;
  /** The company's plan includes WhatsApp (Chat360) (WhatsApp tab). Default true. */
  whatsappFeature?: boolean;
  tasks: TaskItem[];
  inventory: InventoryUnit[];
  /**
   * Opens the AI Copilot with this enquiry as context ("Ask Copilot", WhatsApp "Suggest a reply").
   * Optional — the buttons are hidden until App wires it (and while AI is not configured).
   */
  onOpenCopilot?: OpenCopilot;
}

export const LeadDetailModal: React.FC<LeadDetailModalProps> = (props) => {
  if (!props.isOpen || !props.lead) return null;
  return <LeadDetailPanel key={String(props.lead[F.ID])} {...props} lead={props.lead} />;
};

/* -------------------------------------------------------------------------- */

type TabId = 'details' | 'timeline' | 'followups' | 'calls' | 'whatsapp' | 'files';
type PanelProps = Omit<LeadDetailModalProps, 'lead' | 'isOpen'> & { lead: Lead };

const EDITABLE_TEXT: string[] = [F.NAME, F.PHONE, F.EMAIL, F.NOTES];

const LeadDetailPanel: React.FC<PanelProps> = ({ lead, config, settings, currentUser, onClose, onSaveLead, onAppendRemark, onTrashLead, onAddTask, canTrash, canEdit, aiConfigured, chatEnabled, callsFeature = true, whatsappFeature = true, tasks, inventory, onOpenCopilot }) => {
  const id = String(lead[F.ID]);
  const [tab, setTab] = useState<TabId>('details');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [timelineVersion, setTimelineVersion] = useState(0);

  const value = (k: string): string => (k in edits ? edits[k] : String(lead[k] ?? ''));
  const setField = (k: string, v: string) => {
    setSaveError(null);
    setEdits((prev) => ({ ...prev, [k]: v }));
  };

  /** Only the fields that actually differ from the record. */
  const patch = useMemo(() => {
    const out: Partial<Lead> = {};
    for (const [k, v] of Object.entries(edits)) {
      const before = lead[k];
      if (LEAD_DATE_FIELDS.includes(k)) {
        const a = parseDate(before)?.getTime() ?? null;
        const b = parseDate(v)?.getTime() ?? null;
        if (a !== b) out[k] = v;
      } else if (String(before ?? '').trim() !== String(v ?? '').trim()) {
        out[k] = EDITABLE_TEXT.includes(k) ? v.trim() : v;
      }
    }
    return out;
  }, [edits, lead]);
  const dirty = Object.keys(patch).length > 0;

  const stageNow = value(F.STAGE) || STAGES.NEW;
  const becomesBooked = stageNow === STAGES.BOOKED && String(lead[F.STAGE] || '') !== STAGES.BOOKED;

  const name = String(lead[F.NAME] || '');
  const phone = String(lead[F.PHONE] || '');
  const email = String(lead[F.EMAIL] || '');
  const tplVars = { name, rm: currentUser?.name || String(lead[F.RM] || ''), id };
  const waHref = whatsappLink(phone, fillTemplate(settings.waTemplate, tplVars));
  const mailHref = mailtoLink(email, fillTemplate(settings.emailSubject, tplVars), fillTemplate(settings.emailBody, tplVars));

  const linkedUnits = useMemo(() => inventory.filter((u) => u.leadId === id), [inventory, id]);
  const bumpTimeline = () => setTimelineVersion((v) => v + 1);

  /* ------------------------------- actions ------------------------------- */

  const requestClose = () => {
    if (confirmTrash || confirmDiscard) return; // a confirmation dialog owns Escape/backdrop right now
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!dirty || !canEdit) return;
    if (F.NAME in patch && !String(patch[F.NAME] || '').trim()) return setSaveError('Prospect name cannot be empty.');
    if (F.PHONE in patch && patch[F.PHONE] && !isLikelyPhone(String(patch[F.PHONE]))) return setSaveError('Enter a valid phone number (10 digits, or with country code).');
    setSaveError(null);
    setSaving(true);
    const booked = becomesBooked;
    const res = await onSaveLead(id, patch);
    setSaving(false);
    if (!res) return; // engine already toasted the failure and rolled back
    setEdits({});
    bumpTimeline();
    if (booked) {
      sound.playSuccess();
      try {
        confetti({ particleCount: 140, spread: 85, origin: { y: 0.6 }, colors: ['#A9825A', '#1D2F3F', '#7C8B78', '#E7D8C6'] });
      } catch {
        /* confetti is cosmetic */
      }
      toast('Booking recorded 🎉', `${name} is now Booked`, 'success');
    } else {
      toast('Enquiry updated', `${Object.keys(patch).length} ${Object.keys(patch).length === 1 ? 'field' : 'fields'} saved for ${name || id}`, 'success');
    }
  };

  const trash = async () => {
    setTrashing(true);
    const ok = await onTrashLead(id);
    setTrashing(false);
    if (ok) {
      setConfirmTrash(false);
      toast('Moved to Trash', `${name || id} is hidden from every list and report. An admin can restore it from Settings.`, 'info');
      onClose();
    }
  };

  const copySummary = async () => {
    const lines = [
      `Enquiry ID: ${id}`,
      `Prospect: ${name}`,
      `Phone: ${formatPhone(phone) || '—'}`,
      `Email: ${email || '—'}`,
      `Stage: ${lead[F.STAGE] || STAGES.NEW}`,
      `Source: ${lead[F.SOURCE] || '—'}`,
      `Unit: ${lead[F.UNIT_TYPE] || '—'}${lead[F.PURCHASE_OR_RENT] ? ` (${lead[F.PURCHASE_OR_RENT]})` : ''}`,
      `Enquired on: ${formatDateTime(lead[F.ENQUIRY_DATE] || lead[F.CREATED_AT], '—')}`,
      `Site visit: ${lead[F.SITE_VISIT_STATUS] || '—'}${lead[F.SITE_VISIT_DATE] ? ` · ${formatDateTime(lead[F.SITE_VISIT_DATE])}` : ''}`,
      `Next follow-up: ${formatDateTime(lead[F.NEXT_FOLLOWUP], 'Not scheduled')}`,
      `Assigned RM: ${lead[F.RM] || '—'}`,
      `Notes: ${lead[F.NOTES] || '—'}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      reportError('leads.copySummary', e);
      toast('Could not copy', 'Clipboard access was blocked by the browser.', 'warning');
    }
  };

  const summarise = async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await api.ai.summarizeLead(id);
      setSummary(String(res?.summary || '').trim() || 'The AI returned an empty summary.');
    } catch (e) {
      setSummaryError(reportError('leads.aiSummary', e).userMessage);
    } finally {
      setSummaryLoading(false);
    }
  };

  /* ------------------------------- render -------------------------------- */

  const actionCls = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white text-[11px] font-semibold text-[#1D2F3F] border border-[#D2C9BF] hover:border-[#A9825A] hover:bg-[#F4F0EB] transition';
  const copilotCls = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#FBF7F1] text-[11px] font-semibold text-[#86633E] border border-[#A9825A]/50 hover:border-[#A9825A] hover:bg-[#F4F0EB] transition';
  // The Copilot can only use the enquiry as context when AI is configured (quick-search mode ignores it).
  const openCopilot = aiConfigured ? onOpenCopilot : undefined;
  const opts = (field: string) => optionsWithCurrent(config.options[field], value(field));
  const dateInput = (field: string, extra?: string) => (
    <input type="datetime-local" value={toDatetimeLocalInput(value(field))} onChange={(e) => setField(field, fromDatetimeLocalInput(e.target.value))} disabled={!canEdit} className={cx(inputCls, extra)} />
  );

  const title = (
    <span className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-xs font-semibold text-[#A9825A] flex-shrink-0">{id}</span>
      <span className="truncate">{name || 'Unnamed enquiry'}</span>
      <LeadStars lead={lead} size={13} className="flex-shrink-0" />
      <StageBadge stage={String(lead[F.STAGE] || '')} />
    </span>
  );

  const subtitle = (
    <span className="flex items-center gap-1.5 flex-wrap mt-1.5">
      {phone && (
        <a href={telLink(phone)} className={actionCls} title={formatPhone(phone)}>
          <Phone size={12} className="text-[#1976D2]" /> Call
        </a>
      )}
      {phone && (
        <a href={waHref} target="_blank" rel="noreferrer" className={actionCls}>
          <MessageSquare size={12} className="text-[#25D366]" /> WhatsApp
        </a>
      )}
      {email && (
        <a href={mailHref} className={actionCls}>
          <Mail size={12} className="text-[#EA4335]" /> Email
        </a>
      )}
      <button type="button" onClick={() => void copySummary()} className={actionCls} title="Copy a text summary of this enquiry">
        {copied ? <Check size={12} className="text-[#3C573A]" /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy summary'}
      </button>
      {openCopilot && (
        <button
          type="button"
          onClick={() => openCopilot(undefined, { view: 'lead', leadId: id })}
          className={copilotCls}
          title="Ask the Copilot about this enquiry — a WhatsApp follow-up, a summary, objection handling, project facts"
        >
          <Sparkles size={12} className="text-[#A9825A]" /> Ask Copilot
        </button>
      )}
      {phone && <span className="text-[#6B5F57] ml-1">{formatPhone(phone)}</span>}
    </span>
  );

  const footer = (
    <>
      {canTrash && (
        <div className="mr-auto">
          <Button variant="danger" onClick={() => setConfirmTrash(true)} icon={<Trash2 size={13} />}>
            Move to Trash
          </Button>
        </div>
      )}
      <Button variant="ghost" onClick={requestClose}>
        {dirty ? 'Cancel' : 'Close'}
      </Button>
      <Button variant="primary" onClick={() => void save()} disabled={!dirty || !canEdit} loading={saving} icon={<Save size={13} />} title={!canEdit ? 'Your role cannot edit enquiries' : undefined}>
        Save changes{dirty ? ` (${Object.keys(patch).length})` : ''}
      </Button>
    </>
  );

  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; badge?: React.ReactNode }> = [
    { id: 'details', label: 'Details', icon: <User size={13} /> },
    { id: 'timeline', label: 'Timeline', icon: <History size={13} /> },
    { id: 'followups', label: 'Follow-ups', icon: <MessageSquare size={13} />, badge: followupCount(lead) || undefined },
    ...(callsFeature ? [{ id: 'calls' as TabId, label: 'Calls', icon: <PhoneCall size={13} /> }] : []),
    ...(whatsappFeature ? [{ id: 'whatsapp' as TabId, label: 'WhatsApp', icon: <MessageCircle size={13} /> }] : []),
    { id: 'files', label: 'Files', icon: <FileText size={13} /> },
  ];

  return (
    <>
      <Modal open onClose={requestClose} side title={title} subtitle={subtitle} footer={footer}>
        <div className="space-y-4">
          <Tabs<TabId> tabs={tabs} value={tab} onChange={setTab} />

          {/* Panels stay mounted so loaded data and half-typed forms survive tab switches. */}
          <div className={tab === 'details' ? 'space-y-4' : 'hidden'}>
            {!canEdit && <InlineNotice>Your role can view this enquiry but not edit it. Ask a manager if a detail needs changing.</InlineNotice>}

            {/* Status & timing */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white p-4 rounded-xl border border-[#D2C9BF]">
              <Field label="Lead stage">
                <Select
                  value={stageNow}
                  onChange={(e) => {
                    const s = e.target.value;
                    setField(F.STAGE, s);
                    if (s === STAGES.BOOKED && !value(F.BOOKING_DATE)) setField(F.BOOKING_DATE, nowIso());
                  }}
                  // Trash / Permanently Deleted need `leads.trash` and go through the confirm dialog below, never the dropdown.
                  options={optionsWithCurrent((config.options[F.STAGE] || []).filter((s) => !STAGE_CLASS.excluded.includes(s)), stageNow)}
                  disabled={!canEdit}
                  className="font-semibold !bg-[#F4F0EB]"
                />
              </Field>
              <Field label="Next follow-up">{dateInput(F.NEXT_FOLLOWUP, '!bg-[#F4F0EB] font-medium')}</Field>
              {becomesBooked && (
                <div className="sm:col-span-2">
                  <InlineNotice tone="success">Saving will record a booking for {name || 'this prospect'} 🎉 — set the Booking Date below if it differs from now.</InlineNotice>
                </div>
              )}
            </div>

            {/* Prospect */}
            <section className="space-y-3">
              <h4 className="text-sm font-bold text-[#1D2F3F] pb-1 border-b border-[#ECE8E1]">Prospect</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Prospect name">
                  <input value={value(F.NAME)} onChange={(e) => setField(F.NAME, e.target.value)} disabled={!canEdit} className={inputCls} />
                </Field>
                <Field label="Phone number" hint={value(F.PHONE) ? formatPhone(value(F.PHONE)) : undefined}>
                  <input value={value(F.PHONE)} onChange={(e) => setField(F.PHONE, e.target.value)} disabled={!canEdit} className={inputCls} inputMode="tel" />
                </Field>
                <Field label="Email">
                  <input type="email" value={value(F.EMAIL)} onChange={(e) => setField(F.EMAIL, e.target.value)} disabled={!canEdit} className={inputCls} />
                </Field>
                <Field label="Enquiry source">
                  <Select value={value(F.SOURCE)} onChange={(e) => setField(F.SOURCE, e.target.value)} options={opts(F.SOURCE)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Enquiry date">{dateInput(F.ENQUIRY_DATE)}</Field>
                <Field label="Relationship to prospect">
                  <Select value={value(F.RELATIONSHIP)} onChange={(e) => setField(F.RELATIONSHIP, e.target.value)} options={opts(F.RELATIONSHIP)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Enquired for">
                  <Select value={value(F.ENQUIRED_FOR)} onChange={(e) => setField(F.ENQUIRED_FOR, e.target.value)} options={opts(F.ENQUIRED_FOR)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Assigned RM">
                  <Select value={value(F.RM)} onChange={(e) => setField(F.RM, e.target.value)} options={opts(F.RM)} placeholder="Unassigned" disabled={!canEdit} />
                </Field>
              </div>
            </section>

            {/* Requirement */}
            <section className="space-y-3">
              <h4 className="text-sm font-bold text-[#1D2F3F] pb-1 border-b border-[#ECE8E1]">Requirement & visit</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Unit type interested in">
                  <Select value={value(F.UNIT_TYPE)} onChange={(e) => setField(F.UNIT_TYPE, e.target.value)} options={opts(F.UNIT_TYPE)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Purchase or rent">
                  <Select value={value(F.PURCHASE_OR_RENT)} onChange={(e) => setField(F.PURCHASE_OR_RENT, e.target.value)} options={opts(F.PURCHASE_OR_RENT)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Site visit status">
                  <Select value={value(F.SITE_VISIT_STATUS)} onChange={(e) => setField(F.SITE_VISIT_STATUS, e.target.value)} options={opts(F.SITE_VISIT_STATUS)} placeholder="Select…" disabled={!canEdit} />
                </Field>
                <Field label="Site visit date">{dateInput(F.SITE_VISIT_DATE)}</Field>
                {stageNow === STAGES.BOOKED && <Field label="Booking date">{dateInput(F.BOOKING_DATE)}</Field>}
                <Field label="Brochure shared">
                  <Select value={value(F.BROCHURE)} onChange={(e) => setField(F.BROCHURE, e.target.value)} options={opts(F.BROCHURE)} placeholder="Select…" disabled={!canEdit} />
                </Field>
              </div>
              <Field label="Enquiry notes" hint="Budget, preferred floor/tower, family members, food preferences, decision timeline…">
                <textarea value={value(F.NOTES)} onChange={(e) => setField(F.NOTES, e.target.value)} rows={3} disabled={!canEdit} className={cx(inputCls, 'resize-y leading-relaxed')} />
              </Field>
            </section>

            {linkedUnits.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-bold text-[#1D2F3F] pb-1 border-b border-[#ECE8E1] flex items-center gap-1.5">
                  <Building2 size={14} className="text-[#A9825A]" /> Linked units
                </h4>
                <div className="flex flex-wrap gap-2">
                  {linkedUnits.map((u) => (
                    <span key={u.inventoryId} className="inline-flex items-center gap-2 text-xs bg-white border border-[#D2C9BF] rounded-lg px-2.5 py-1.5">
                      <strong className="text-[#1D2F3F]">{u.unitId}</strong>
                      <span className="text-[#6B5F57]">
                        {u.tower ? `Tower ${u.tower} · ` : ''}
                        {u.unitType}
                      </span>
                      <Badge tone={u.status === 'Booked' || u.status === 'Sold' ? 'sage' : u.status === 'Reserved' ? 'gold' : 'muted'}>{u.status}</Badge>
                    </span>
                  ))}
                </div>
              </section>
            )}

            {saveError && <InlineNotice tone="warning">{saveError}</InlineNotice>}

            {/* AI summary */}
            {aiConfigured && (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-[#1D2F3F] flex items-center gap-1.5">
                    <Sparkles size={14} className="text-[#A9825A]" /> AI summary
                  </h4>
                  <Button variant="secondary" size="xs" onClick={() => void summarise()} loading={summaryLoading} icon={<Sparkles size={11} className="text-[#A9825A]" />}>
                    {summary ? 'Regenerate' : 'Summarise this enquiry'}
                  </Button>
                </div>
                {summaryError && <InlineNotice tone="warning">{summaryError}</InlineNotice>}
                {summary && <div className="rounded-xl border border-[#A9825A]/50 bg-[#FBF7F1] p-4 text-xs text-[#1D2F3F] leading-relaxed whitespace-pre-wrap">{summary}</div>}
                {!summary && !summaryError && !summaryLoading && <p className="text-[11px] text-[#9E948D]">Gemini reads the notes, follow-ups, calls and chats of this enquiry and writes a short brief with suggested next steps.</p>}
              </section>
            )}

            {/* Meta */}
            <div className="text-[10px] text-[#9E948D] flex flex-wrap gap-x-3 gap-y-1 pt-2 border-t border-[#ECE8E1]">
              <span>Created {formatDateTime(lead[F.CREATED_AT] || lead[F.ENQUIRY_DATE], '—')}</span>
              <span>·</span>
              <span>
                Updated {formatDateTime(lead[F.UPDATED_AT], '—')}
                {lead[F.UPDATED_BY] ? ` by ${lead[F.UPDATED_BY]}` : ''}
              </span>
              {lead[F.LAST_FOLLOWUP] && (
                <>
                  <span>·</span>
                  <span>Last follow-up {formatDateTime(lead[F.LAST_FOLLOWUP])}</span>
                </>
              )}
            </div>
          </div>

          <div className={tab === 'timeline' ? '' : 'hidden'}>
            <TimelineTab leadId={id} active={tab === 'timeline'} version={`${lead[F.UPDATED_AT] || ''}|${lead[F.LAST_FOLLOWUP] || ''}|${timelineVersion}`} />
          </div>
          <div className={tab === 'followups' ? '' : 'hidden'}>
            <FollowupsTab lead={lead} canEdit={canEdit} aiConfigured={aiConfigured} currentUser={currentUser} tasks={tasks} onAppendRemark={onAppendRemark} onAddTask={onAddTask} />
          </div>
          {callsFeature && <div className={tab === 'calls' ? '' : 'hidden'}>
            <CallsTab lead={lead} active={tab === 'calls'} aiConfigured={aiConfigured} onChanged={bumpTimeline} />
          </div>}
          {whatsappFeature && <div className={tab === 'whatsapp' ? '' : 'hidden'}>
            <WhatsAppTab lead={lead} active={tab === 'whatsapp'} chatEnabled={chatEnabled} settings={settings} currentUser={currentUser} onChanged={bumpTimeline} onOpenCopilot={openCopilot} />
          </div>}
          <div className={tab === 'files' ? '' : 'hidden'}>
            <FilesTab lead={lead} active={tab === 'files'} onChanged={bumpTimeline} />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmTrash}
        title="Move to Trash?"
        danger
        confirmLabel="Move to Trash"
        loading={trashing}
        onCancel={() => setConfirmTrash(false)}
        onConfirm={() => void trash()}
        message={
          <>
            <strong>{name || id}</strong> ({id}) will disappear from every list, board and report. Nothing is deleted — an administrator can restore it from Settings → Trash.
          </>
        }
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        danger
        confirmLabel="Discard"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        message={
          <>
            You changed {Object.keys(patch).length} {Object.keys(patch).length === 1 ? 'field' : 'fields'} on <strong>{name || id}</strong> that have not been saved.
          </>
        }
      />
    </>
  );
};
