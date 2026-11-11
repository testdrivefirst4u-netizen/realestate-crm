/**
 * Lead › Journey — the one place an agent works an enquiry from first call to booking (Release B).
 *
 *   1. Progress   recorded steps only (contacted → qualified → visit → reserved → booked), never guessed
 *   2. Next step  what happened on the last contact + the next action (required unless the enquiry closes)
 *   3. People     enquirer, residents, decision-maker, payer: number with country, channel, time zone, consent
 *   4. Unit       quotation (discount approval), what is still missing, and the booking request
 *
 * Every write goes to the server, which enforces access and the gates; this screen only explains them.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Plus, Trash2, Users, Clock, ShieldCheck, Globe2 } from 'lucide-react';
import { api } from '../../../core/api';
import { F } from '../../../core/config';
import { toAppError } from '../../../core/errors';
import { formatDateTime, formatRelative } from '../../../core/dates';
import { formatINR } from '../../../core/format';
import { formatPhone } from '../../../core/phone';
import { NEXT_TYPES, OUTCOMES, PERSON_ROLE_LABEL, type Person, type PersonRole, type Quote } from '../../../core/journeyTypes';
import type { InventoryUnit, Lead } from '../../../types/crm';
import { Button, ErrorState, Field, InlineNotice, Select, cx, inputCls } from '../../../components/ui';
import { EngagementSection, PaymentSection } from './CustomerSection';

const STEPS: Array<{ id: string; label: string }> = [
  { id: 'contacted', label: 'Contacted' }, { id: 'qualified', label: 'Qualified' }, { id: 'visitScheduled', label: 'Visit set' },
  { id: 'visitDone', label: 'Visited' }, { id: 'reserved', label: 'Reserved' }, { id: 'booked', label: 'Booked' },
];

const sectionTitle = 'text-[11px] font-bold uppercase tracking-[0.08em] text-[#5E778C]';
const localTime = (tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', weekday: 'short', timeZone: tz }).format(new Date());
  } catch {
    return '';
  }
};
const inHours = (h: number) => {
  const d = new Date(Date.now() + h * 3600e3);
  d.setMinutes(0, 0, 0);
  return d;
};
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export const JourneyTab: React.FC<{
  lead: Lead;
  inventory: InventoryUnit[];
  canEdit: boolean;
  canApprove: boolean;
  active: boolean;
  onChanged: () => void;
  users?: Array<{ id: string; name: string; role: string }>;
  canAssign?: boolean;
}> = ({ lead, inventory, canEdit, canApprove, active, onChanged, users = [], canAssign = false }) => {
  const leadId = String(lead[F.ID]);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loadError, setLoadError] = useState('');
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [p, q] = await Promise.all([api.journey.people(leadId), api.journey.quotes(leadId)]);
      setPeople(p);
      setQuotes(q);
    } catch (e) {
      setLoadError(toAppError(e).userMessage);
    }
  }, [leadId]);
  useEffect(() => {
    if (active && people === null) void load();
  }, [active, people, load]);

  const milestones = useMemo<Record<string, string>>(() => {
    try {
      return JSON.parse(String(lead._milestones || '{}')) || {};
    } catch {
      return {};
    }
  }, [lead]);

  if (loadError) return <ErrorState title="Could not load the journey" message={loadError} onRetry={load} />;

  return (
    <div className="space-y-6">
      <Progress milestones={milestones} />
      <NextStep leadId={leadId} people={people || []} canEdit={canEdit} nextAt={String(lead[F.NEXT_FOLLOWUP] || '')} onDone={onChanged} />
      <EngagementSection leadId={leadId} people={people || []} canEdit={canEdit} active={active} users={users.filter((u) => u.role !== 'Viewer')} canAssign={canAssign} />
      <PeopleSection leadId={leadId} people={people} canEdit={canEdit} onSaved={(p) => { setPeople(p); onChanged(); }} />
      <UnitSection leadId={leadId} lead={lead} inventory={inventory} quotes={quotes} people={people || []} canEdit={canEdit} canApprove={canApprove} onSaved={async () => { await load(); onChanged(); }} />
      {inventory.filter((u) => u.leadId === leadId && (u.status === 'Booked' || u.status === 'Sold') && !u.restricted).map((u) => (
        <PaymentSection key={u.inventoryId} unit={u} canApprove={canApprove} canEdit={canEdit} active={active} />
      ))}
    </div>
  );
};

/* --------------------------------- progress --------------------------------- */

const Progress: React.FC<{ milestones: Record<string, string> }> = ({ milestones }) => (
  <section aria-labelledby="journey-progress">
    <h4 id="journey-progress" className={sectionTitle}>Progress <span className="normal-case tracking-normal font-normal">· steps recorded when they happened</span></h4>
    <ol className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-1.5">
      {STEPS.map((s) => {
        const at = milestones[s.id];
        const reconstructed = at?.endsWith('~');
        return (
          <li key={s.id} className={cx('rounded-lg px-2 py-2 border text-center', at ? 'bg-[#EAF4F3] border-[#0E8A86]/30 text-[#0B4F4C]' : 'bg-white border-[#E3EDF5] text-[#7E93A6]')}>
            <div className="text-[11px] font-semibold flex items-center justify-center gap-1">{at && <Check size={11} aria-hidden />}{s.label}</div>
            <div className="text-[10px] mt-0.5 tabular-nums">{at ? `${formatRelative(at.replace('~', ''))}${reconstructed ? ' · from history' : ''}` : 'not yet'}</div>
          </li>
        );
      })}
    </ol>
  </section>
);

/* --------------------------------- next step -------------------------------- */

const NextStep: React.FC<{ leadId: string; people: Person[]; canEdit: boolean; nextAt: string; onDone: () => void }> = ({ leadId, people, canEdit, nextAt, onDone }) => {
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [personId, setPersonId] = useState('');
  const [nextType, setNextType] = useState('call');
  const [when, setWhen] = useState(toLocalInput(inHours(24)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const closes = OUTCOMES.find((o) => o.id === outcome)?.closes;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved('');
    if (!outcome) return setError('Choose what happened.');
    setBusy(true);
    try {
      const r = await api.journey.disposition({ leadId, outcome, note, personId: personId || undefined, next: closes ? undefined : { type: nextType, at: new Date(when).toISOString() } });
      setSaved(r.nextAt ? `Saved. Next: ${NEXT_TYPES.find((t) => t.id === nextType)?.label} ${formatDateTime(r.nextAt, '')}` : 'Saved. The enquiry is closed.');
      setOutcome('');
      setNote('');
      onDone();
    } catch (err) {
      setError(toAppError(err).userMessage);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="journey-next">
      <div className="flex items-baseline justify-between gap-3">
        <h4 id="journey-next" className={sectionTitle}>Last contact &amp; next step</h4>
        <span className="text-xs text-[#5E778C] flex items-center gap-1"><Clock size={12} aria-hidden />{nextAt ? <>Next: <strong className="text-[#0B2A44] font-semibold">{formatDateTime(nextAt, '')}</strong></> : <strong className="text-[#B06A55]">No next action</strong>}</span>
      </div>
      {canEdit ? (
        <form onSubmit={submit} className="mt-2 space-y-3">
          <fieldset>
            <legend className="sr-only">What happened</legend>
            <div className="flex flex-wrap gap-1.5">
              {OUTCOMES.map((o) => (
                <button type="button" key={o.id} aria-pressed={outcome === o.id} onClick={() => setOutcome(o.id)}
                  className={cx('min-h-9 px-3 rounded-full border text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B6BB0]',
                    outcome === o.id ? 'bg-[#0B2A44] text-white border-[#0B2A44]' : 'bg-white text-[#0B2A44] border-[#D3E3F0] hover:border-[#0B6BB0]')}>
                  {o.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <Field label="Note">
              <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="What was said, in a line" maxLength={500} />
            </Field>
            {people.length > 1 && (
              <Field label="With">
                <Select value={personId} onChange={(e) => setPersonId(e.target.value)} options={[{ value: '', label: 'Enquirer' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
              </Field>
            )}
          </div>
          {!closes && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Next action">
                <Select value={nextType} onChange={(e) => setNextType(e.target.value)} options={NEXT_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
              </Field>
              <Field label="When">
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} required />
              </Field>
            </div>
          )}
          {error && <InlineNotice tone="warning">{error}</InlineNotice>}
          {saved && <InlineNotice tone="success">{saved}</InlineNotice>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!outcome}>{closes ? 'Save and close enquiry' : 'Save and set next step'}</Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-[#5E778C] mt-2">View only.</p>
      )}
    </section>
  );
};

/* ---------------------------------- people ---------------------------------- */

const EMPTY: Partial<Person> = { name: '', roles: ['resident'], relationship: '', phone: '', email: '', preferredChannel: '', language: '', timeZone: '', bestTime: '', consent: { whatsappMarketing: 'unknown', at: '', source: '', evidence: '' } };

const PeopleSection: React.FC<{ leadId: string; people: Person[] | null; canEdit: boolean; onSaved: (p: Person[]) => void }> = ({ leadId, people, canEdit, onSaved }) => {
  const [editing, setEditing] = useState<Partial<Person> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await api.journey.savePerson(leadId, editing));
      setEditing(null);
    } catch (err) {
      setError(toAppError(err).userMessage);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: Person) => {
    if (!window.confirm(`Remove ${p.name} from this enquiry?`)) return;
    try {
      onSaved(await api.journey.removePerson(leadId, p.id));
    } catch (err) {
      setError(toAppError(err).userMessage);
    }
  };
  const set = <K extends keyof Person>(k: K, v: Person[K]) => setEditing((p) => ({ ...(p || {}), [k]: v }));
  const toggleRole = (r: PersonRole) => setEditing((p) => {
    const roles = new Set(p?.roles || []);
    if (roles.has(r)) roles.delete(r);
    else roles.add(r);
    return { ...(p || {}), roles: [...roles] };
  });
  const consentState = editing?.consent?.whatsappMarketing || 'unknown';

  return (
    <section aria-labelledby="journey-people">
      <div className="flex items-center justify-between gap-3">
        <h4 id="journey-people" className={sectionTitle}><Users size={12} className="inline -mt-0.5 mr-1" aria-hidden />People</h4>
        {canEdit && !editing && <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => setEditing({ ...EMPTY })}>Add person</Button>}
      </div>
      {people === null ? (
        <div className="mt-2 h-14 rounded-lg bg-[#F2F7FB] animate-pulse" aria-label="Loading people" />
      ) : (
        <ul className="mt-2 divide-y divide-[#E6EFF6] border border-[#E3EDF5] rounded-xl bg-white">
          {people.map((p) => (
            <li key={p.id} className="px-3 py-2.5 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#0B2A44] flex flex-wrap items-center gap-x-2">
                  {p.name}
                  <span className="text-[11px] font-normal text-[#5E778C]">{p.roles.map((r) => PERSON_ROLE_LABEL[r]).join(' · ')}{p.relationship ? ` · ${p.relationship}` : ''}</span>
                </div>
                <div className="text-xs text-[#5E778C] mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {p.phone && <span className="tabular-nums">{formatPhone(p.phone)}</span>}
                  {p.preferredChannel && <span>Prefers {p.preferredChannel === 'call' ? 'a call' : p.preferredChannel}</span>}
                  {p.language && <span>{p.language}</span>}
                  {p.timeZone && <span className="inline-flex items-center gap-1"><Globe2 size={11} aria-hidden />{localTime(p.timeZone)} their time</span>}
                  {p.bestTime && <span>Best: {p.bestTime}</span>}
                  <span className={cx('inline-flex items-center gap-1', p.consent.whatsappMarketing === 'granted' ? 'text-[#0E8A86]' : p.consent.whatsappMarketing === 'denied' ? 'text-[#B06A55]' : '')}>
                    <ShieldCheck size={11} aria-hidden />WhatsApp offers: {p.consent.whatsappMarketing === 'granted' ? 'agreed' : p.consent.whatsappMarketing === 'denied' ? 'opted out' : 'not asked'}
                  </span>
                </div>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                  {p.id !== 'PER-ENQUIRER' && <Button size="xs" variant="ghost" aria-label={`Remove ${p.name}`} icon={<Trash2 size={12} />} onClick={() => remove(p)} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form onSubmit={save} className="mt-3 rounded-xl border border-[#0B6BB0]/30 bg-[#F7FAFD] p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name"><input value={editing.name || ''} onChange={(e) => set('name', e.target.value)} className={inputCls} required /></Field>
            <Field label="Relationship to the resident"><input value={editing.relationship || ''} onChange={(e) => set('relationship', e.target.value)} className={inputCls} placeholder="Daughter, Self, Friend…" /></Field>
          </div>
          <fieldset>
            <legend className="text-xs font-semibold text-[#0B2A44] mb-1.5">Role in this decision</legend>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(PERSON_ROLE_LABEL) as PersonRole[]).map((r) => (
                <label key={r} className={cx('min-h-9 px-3 inline-flex items-center gap-1.5 rounded-full border text-xs cursor-pointer', editing.roles?.includes(r) ? 'bg-[#0B2A44] text-white border-[#0B2A44]' : 'bg-white border-[#D3E3F0] text-[#0B2A44]')}>
                  <input type="checkbox" className="sr-only" checked={!!editing.roles?.includes(r)} onChange={() => toggleRole(r)} />{PERSON_ROLE_LABEL[r]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Phone" hint="With country code if outside India"><input value={editing.phone || ''} onChange={(e) => set('phone', e.target.value)} className={inputCls} inputMode="tel" placeholder="+971 50 123 4567" /></Field>
            <Field label="Time zone" hint="e.g. Asia/Dubai"><input value={editing.timeZone || ''} onChange={(e) => set('timeZone', e.target.value)} className={inputCls} list="journey-zones" /></Field>
            <Field label="Prefers">
              <Select value={editing.preferredChannel || ''} onChange={(e) => set('preferredChannel', e.target.value as Person['preferredChannel'])} options={[{ value: '', label: '—' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'call', label: 'Call' }, { value: 'email', label: 'E-mail' }, { value: 'sms', label: 'SMS' }]} />
            </Field>
            <Field label="Language"><input value={editing.language || ''} onChange={(e) => set('language', e.target.value)} className={inputCls} placeholder="Malayalam" /></Field>
            <Field label="Best time"><input value={editing.bestTime || ''} onChange={(e) => set('bestTime', e.target.value)} className={inputCls} placeholder="Evenings after 7" /></Field>
            <Field label="E-mail"><input type="email" value={editing.email || ''} onChange={(e) => set('email', e.target.value)} className={inputCls} /></Field>
          </div>
          <datalist id="journey-zones">{['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'].map((z) => <option key={z} value={z} />)}</datalist>
          <fieldset className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-3 items-end">
            <Field label="WhatsApp offers">
              <Select value={consentState} onChange={(e) => set('consent', { ...(editing.consent || EMPTY.consent!), whatsappMarketing: e.target.value as Person['consent']['whatsappMarketing'] })} options={[{ value: 'unknown', label: 'Not asked' }, { value: 'granted', label: 'Agreed' }, { value: 'denied', label: 'Opted out' }]} />
            </Field>
            {consentState === 'granted' && (
              <Field label="How they agreed" hint="Kept as evidence">
                <input value={editing.consent?.evidence || ''} onChange={(e) => set('consent', { ...(editing.consent || EMPTY.consent!), evidence: e.target.value })} className={inputCls} placeholder="Asked on the call today" required />
              </Field>
            )}
          </fieldset>
          {error && <InlineNotice tone="warning">{error}</InlineNotice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setEditing(null); setError(''); }}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>Save person</Button>
          </div>
        </form>
      )}
    </section>
  );
};

/* ------------------------------ unit & booking ------------------------------ */

const QUOTE_STATUS: Record<Quote['status'], string> = { draft: 'Draft', pendingApproval: 'Waiting for discount approval', approved: 'Approved', rejected: 'Rejected', sent: 'Sent', superseded: 'Replaced' };

const UnitSection: React.FC<{ leadId: string; lead: Lead; inventory: InventoryUnit[]; quotes: Quote[]; people: Person[]; canEdit: boolean; canApprove: boolean; onSaved: () => void }> = ({ leadId, inventory, quotes, people, canEdit, canApprove, onSaved }) => {
  const linked = inventory.filter((u) => u.leadId === leadId);
  const offered = inventory.filter((u) => u.status === 'Available' || u.leadId === leadId);
  const [unitId, setUnitId] = useState(linked[0]?.inventoryId || quotes[0]?.unitId || '');
  const [discount, setDiscount] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [gate, setGate] = useState<string[] | null>(null);
  const [pending, setPending] = useState<{ requestedBy: string; at: string } | null>(null);
  const unit = inventory.find((u) => u.inventoryId === unitId);
  const current = quotes.find((q) => q.unitId === unitId && q.status !== 'superseded');
  const hasPayer = people.some((p) => p.roles.includes('payer'));

  useEffect(() => {
    if (!unitId) return setGate(null);
    api.journey.gate(leadId, unitId).then((g) => { setGate(g.missing); setPending(g.pending); }, () => { setGate(null); setPending(null); });
  }, [leadId, unitId, quotes, hasPayer]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(toAppError(e).userMessage);
    } finally {
      setBusy('');
    }
  };

  return (
    <section aria-labelledby="journey-unit">
      <h4 id="journey-unit" className={sectionTitle}>Unit, quotation &amp; booking</h4>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
        <Field label="Unit">
          <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} options={[{ value: '', label: offered.length ? 'Choose a unit' : 'No available units' }, ...offered.map((u) => ({ value: u.inventoryId, label: `${u.unitId} · ${u.unitType || 'unit'} · ${u.status}${Number(u.price) ? ' · ' + formatINR(Number(u.price)) : ''}` }))]} />
        </Field>
        {unit?.status === 'Reserved' && unit.holdUntil && <span className="text-xs text-[#5E778C] pb-2">Held until {formatDateTime(unit.holdUntil, '')}</span>}
      </div>

      {unitId && (unit?.status === 'Booked' || unit?.status === 'Sold') && unit.leadId === leadId && !current ? (
        <p className="mt-2 text-xs text-[#0E8A86] inline-flex items-center gap-1"><Check size={12} aria-hidden />{unit.status} for this customer. Payments are below.</p>
      ) : unitId && (
        <div className="mt-3 rounded-xl border border-[#E3EDF5] bg-white p-3 space-y-3">
          {current ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-[#0B2A44] tabular-nums">{formatINR(current.total)} <span className="text-xs font-normal text-[#5E778C]">quotation v{current.version}{current.discount ? ` · ${formatINR(current.discount)} discount` : ''}</span></div>
                <div className={cx('text-xs mt-0.5', current.status === 'approved' ? 'text-[#0E8A86]' : current.status === 'rejected' ? 'text-[#B06A55]' : 'text-[#92400E]')}>{QUOTE_STATUS[current.status]}{current.decidedBy ? ` by ${current.decidedBy}` : ''}</div>
              </div>
              {current.status === 'pendingApproval' && canApprove && (
                <div className="flex gap-2">
                  <Button size="xs" variant="ghost" loading={busy === 'reject'} onClick={() => run('reject', () => api.journey.decideQuote(current._id, false))}>Reject</Button>
                  <Button size="xs" variant="primary" loading={busy === 'approve'} onClick={() => run('approve', () => api.journey.decideQuote(current._id, true))}>Approve discount</Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-[#5E778C]">No quotation for this unit yet.</p>
          )}
          {canEdit && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('quote', () => api.journey.saveQuote({ leadId, unitId, discount: Number(discount) || 0 })); }}>
              <Field label="Discount (₹)" hint="Above the company limit it needs a manager" className="w-48">
                <input type="number" min={0} step={1000} value={discount} onChange={(e) => setDiscount(e.target.value)} className={inputCls} placeholder="0" />
              </Field>
              <Button type="submit" variant="secondary" loading={busy === 'quote'}>{current ? 'New version' : 'Create quotation'}</Button>
            </form>
          )}
          {(unit?.status === 'Booked' || unit?.status === 'Sold') && unit.leadId === leadId ? (
            <p className="text-xs text-[#0E8A86] inline-flex items-center gap-1"><Check size={12} aria-hidden />{unit.status} for this customer. Payments are below.</p>
          ) : gate && (
            gate.length ? (
              <div className="text-xs text-[#0F2233]">
                <div className="font-semibold mb-1">Before this unit can be booked:</div>
                <ul className="list-disc pl-5 space-y-0.5">{gate.map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[#0E8A86] inline-flex items-center gap-1"><Check size={12} aria-hidden />Ready to book: approved quotation and payer recorded.</span>
                {unit?.status === 'Booked' ? null : pending ? (
                  <span className="text-xs text-[#92400E]">Booking requested by {pending.requestedBy} {formatRelative(pending.at)} · waiting for a manager</span>
                ) : canEdit ? (
                  <Button variant="primary" loading={busy === 'book'} onClick={() => run('book', () => api.journey.requestBooking(leadId, unitId))}>Ask a manager to book</Button>
                ) : null}
              </div>
            )
          )}
          {error && <InlineNotice tone="warning">{error}</InlineNotice>}
        </div>
      )}
    </section>
  );
};
