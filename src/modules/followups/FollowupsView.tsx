/**
 * FollowupsView — the follow-up board.
 *
 * Buckets come from `followupBuckets()` in core/analytics (CRM time zone, active
 * leads only), so "today" here is the same "today" as the Dashboard and Reports.
 * Cards inside every bucket follow the header's sort (default: next follow-up
 * soonest first), remembered per browser.
 * Each card offers the stage menu, Call/WhatsApp links and an inline quick remark.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calendar, CalendarCheck, CalendarClock, CheckCircle2, Clock, MessageSquare, MessageSquarePlus, Phone, Timer, UserX } from 'lucide-react';
import { CRMConfig, CRMSettings, Lead, UserAccount } from '../../types/crm';
import { F, STAGES, STAGE_CLASS } from '../../core/config';
import { FollowupBuckets, countedLeads, enquiryDate, followupBuckets, lastActivityDate, leadsNotContactedForDays, nextFollowupDate, stageOf } from '../../core/analytics';
import { daysSince, formatDistance, formatRelative, fromDatetimeLocalInput } from '../../core/dates';
import { fillTemplate, formatPhone, telLink, whatsappLink } from '../../core/phone';
import { Button, EmptyState, Select, StageBadge, cx, inputCls } from '../../components/ui';
import { SORT_PREF_KEYS, sortLeads } from '../leads/sorting';
import { SortControl, usePersistentSort } from '../leads/SortControl';

export interface FollowupsViewProps {
  leads: Lead[];
  config: CRMConfig;
  settings: CRMSettings;
  currentUser: UserAccount | null;
  onOpenLead: (id: string) => void;
  onUpdateLeadStage: (id: string, stage: string) => Promise<boolean>;
  onAppendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
}

type BucketId = 'none' | 'overdue' | 'today' | 'tomorrow' | 'upcoming';

const COLUMNS: Array<{ id: BucketId; title: string; hint: string; icon: React.ReactNode; tone: 'muted' | 'rust' | 'gold' | 'sage' | 'navy' }> = [
  { id: 'none', title: 'No follow-up set', hint: 'Active leads without a next step', icon: <Clock size={15} />, tone: 'muted' },
  { id: 'overdue', title: 'Overdue', hint: 'Past due — call first', icon: <AlertTriangle size={15} />, tone: 'rust' },
  { id: 'today', title: 'Due Today', hint: 'Planned for today', icon: <CalendarCheck size={15} />, tone: 'gold' },
  { id: 'tomorrow', title: 'Due Tomorrow', hint: 'Prepare for tomorrow', icon: <Calendar size={15} />, tone: 'sage' },
  { id: 'upcoming', title: 'Upcoming', hint: 'Day after tomorrow onwards', icon: <CalendarClock size={15} />, tone: 'navy' },
];

const TONES = {
  muted: { col: 'bg-[#EDE8E0] border-[#D2C9BF]', head: 'bg-[#E7D8C6]/50 text-[#1D2F3F]', count: 'bg-[#9E948D] text-white' },
  rust: { col: 'bg-[#F5EDE8] border-[#B06A55]/40', head: 'bg-[#F0E5DF] text-[#8A3E28]', count: 'bg-[#B06A55] text-white' },
  gold: { col: 'bg-[#EDE8E0] border-[#D2C9BF]', head: 'bg-[#A9825A]/20 text-[#86633E]', count: 'bg-[#A9825A] text-white' },
  sage: { col: 'bg-[#EDE8E0] border-[#D2C9BF]', head: 'bg-[#7C8B78]/25 text-[#3C573A]', count: 'bg-[#7C8B78] text-white' },
  navy: { col: 'bg-[#EDE8E0] border-[#D2C9BF]', head: 'bg-[#1D2F3F]/10 text-[#1D2F3F]', count: 'bg-[#1D2F3F] text-white' },
};

export const FollowupsView: React.FC<FollowupsViewProps> = ({ leads, config, settings, currentUser, onOpenLead, onUpdateLeadStage, onAppendRemark }) => {
  const [rm, setRm] = useState('');
  const [sort, setSort] = usePersistentSort(SORT_PREF_KEYS.followups, { key: 'nextDue', asc: true });
  // Re-bucket every minute so "overdue" moves without a reload.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const base = useMemo(() => countedLeads(leads), [leads]);
  const scoped = useMemo(() => (rm ? base.filter((l) => String(l[F.RM] || '').trim() === rm) : base), [base, rm]);
  const rmOptions = useMemo(() => {
    const set = new Set<string>(config.options[F.RM] || []);
    for (const l of base) if (String(l[F.RM] || '').trim()) set.add(String(l[F.RM]).trim());
    return [...set];
  }, [config.options, base]);

  const buckets = useMemo((): FollowupBuckets => {
    const b = followupBuckets(scoped, now);
    const by = (list: Lead[]) => sortLeads(list, sort.key, sort.asc);
    return { none: by(b.none), overdue: by(b.overdue), today: by(b.today), tomorrow: by(b.tomorrow), upcoming: by(b.upcoming) };
  }, [scoped, now, sort.key, sort.asc]);
  const stale = useMemo(() => leadsNotContactedForDays(scoped, 7, now), [scoped, now]);
  const stageOptions = useMemo(() => (config.options[F.STAGE] || []).filter((s) => !STAGE_CLASS.excluded.includes(s)), [config.options]);
  const activeCount = buckets.none.length + buckets.overdue.length + buckets.today.length + buckets.tomorrow.length + buckets.upcoming.length;

  if (base.length === 0) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="bg-white rounded-2xl border border-[#D2C9BF] shadow-xs">
          <EmptyState icon={<CalendarClock size={22} />} title="Nothing to follow up yet" description="Active enquiries with a next follow-up date appear here, grouped into overdue, today, tomorrow and upcoming." />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 h-[calc(100vh-4rem)] flex flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 flex-shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Follow-up Schedule</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">
            {activeCount} active {activeCount === 1 ? 'enquiry' : 'enquiries'} ·{' '}
            <span className={buckets.overdue.length ? 'text-[#B06A55] font-semibold' : ''}>{buckets.overdue.length} overdue</span> · {buckets.today.length} due today · {buckets.none.length} without a date
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Relationship manager" />
          <SortControl sortKey={sort.key} asc={sort.asc} onChange={setSort} />
        </div>
      </div>

      {/* Not contacted strip */}
      <section className="bg-white rounded-xl border border-[#D2C9BF] shadow-2xs flex-shrink-0">
        <div className="px-4 py-2.5 border-b border-[#ECE8E1] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold text-[#1D2F3F]">
            <UserX size={14} className="text-[#B06A55]" />
            Not contacted for 7+ days
            <span className={cx('text-[10px] font-mono rounded-full px-2 py-0.5', stale.length ? 'bg-[#B06A55] text-white' : 'bg-[#ECE8E1] text-[#6B5F57]')}>{stale.length}</span>
          </div>
          <span className="text-[10px] text-[#9E948D]">Active leads with no follow-up logged in a week · oldest first</span>
        </div>
        {stale.length === 0 ? (
          <div className="px-4 py-3 text-xs text-[#6B5F57] flex items-center gap-2">
            <CheckCircle2 size={14} className="text-[#3C573A]" /> Every active enquiry was contacted within the last 7 days.
          </div>
        ) : (
          <div className="p-3 flex gap-2 overflow-x-auto">
            {stale.map((l) => {
              const last = lastActivityDate(l) || enquiryDate(l);
              const days = daysSince(last, now);
              return (
                <button key={l[F.ID]} type="button" onClick={() => onOpenLead(l[F.ID])} className="flex-shrink-0 w-52 text-left bg-[#FDFCFA] border border-[#D2C9BF] hover:border-[#B06A55] rounded-lg p-2.5 transition">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[#1D2F3F] truncate">{l[F.NAME] || 'Unnamed'}</span>
                    <span className="text-[10px] font-bold text-[#B06A55] whitespace-nowrap">{days === null ? '—' : `${days}d`}</span>
                  </div>
                  <div className="text-[10px] text-[#6B5F57] mt-0.5 truncate">
                    {stageOf(l) || STAGES.NEW} · {l[F.RM] || 'Unassigned'}
                  </div>
                  <div className="text-[10px] text-[#9E948D] mt-0.5 truncate">{last ? `Last contact ${formatRelative(last)}` : 'Never contacted'}</div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Columns */}
      <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto pb-3 items-stretch">
        {COLUMNS.map((col) => {
          const items = buckets[col.id];
          const tone = TONES[col.tone];
          return (
            <section key={col.id} className={cx('w-80 flex-shrink-0 rounded-xl border flex flex-col max-h-full overflow-hidden shadow-2xs', tone.col)} aria-label={col.title}>
              <header className={cx('px-3.5 py-3 border-b border-[#D2C9BF]/70 flex items-center justify-between gap-2 flex-shrink-0', tone.head)}>
                <div className="flex items-center gap-2 min-w-0">
                  {col.icon}
                  <div className="min-w-0">
                    <div className="font-bold text-sm leading-tight truncate">{col.title}</div>
                    <div className="text-[10px] opacity-75 truncate">{col.hint}</div>
                  </div>
                </div>
                <span className={cx('text-[10px] font-bold font-mono rounded-full px-2 py-0.5', tone.count)}>{items.length}</span>
              </header>
              <div className="p-3 overflow-y-auto space-y-3 flex-1">
                {items.length === 0 ? (
                  <div className="text-center py-8 text-xs text-[#9E948D]">{col.id === 'overdue' ? 'Nothing overdue — well done' : 'No enquiries here'}</div>
                ) : (
                  items.map((lead) => (
                    <FollowupCard
                      key={lead[F.ID]}
                      lead={lead}
                      bucket={col.id}
                      now={now}
                      stageOptions={stageOptions}
                      waText={fillTemplate(settings.waTemplate, { name: String(lead[F.NAME] || ''), rm: currentUser?.name || String(lead[F.RM] || ''), id: lead[F.ID] })}
                      onOpen={() => onOpenLead(lead[F.ID])}
                      onStage={(s) => onUpdateLeadStage(lead[F.ID], s)}
                      onRemark={(text, next) => onAppendRemark(lead[F.ID], text, next)}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const FollowupCard: React.FC<{
  lead: Lead;
  bucket: BucketId;
  now: Date;
  stageOptions: string[];
  waText: string;
  onOpen: () => void;
  onStage: (stage: string) => Promise<boolean>;
  onRemark: (text: string, nextFollowup?: string) => Promise<boolean>;
}> = ({ lead, bucket, now, stageOptions, waText, onOpen, onStage, onRemark }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [changingStage, setChangingStage] = useState(false);

  const phone = String(lead[F.PHONE] || '');
  const due = nextFollowupDate(lead);
  const urgent = bucket === 'overdue';
  const stage = stageOf(lead) || STAGES.NEW;
  const options = stageOptions.includes(stage) ? stageOptions : [...stageOptions, stage];

  const save = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    const ok = await onRemark(t, next ? fromDatetimeLocalInput(next) || undefined : undefined);
    setSaving(false);
    if (ok) {
      setText('');
      setNext('');
      setOpen(false);
    }
  };

  return (
    <div className={cx('bg-white rounded-xl p-3.5 border shadow-xs hover:border-[#A9825A] hover:shadow-md transition', urgent ? 'border-[#B06A55]/40' : 'border-[#D2C9BF]')}>
      <div className="cursor-pointer" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0">
            <div className="font-bold text-sm text-[#1D2F3F] leading-snug truncate">{lead[F.NAME] || 'Unnamed'}</div>
            <div className="text-[10px] font-mono text-[#A9825A] font-semibold">{lead[F.ID]}</div>
          </div>
          <StageBadge stage={stage} />
        </div>
        <div className="text-xs text-[#6B5F57] font-medium">{formatPhone(phone) || <span className="text-[#9E948D]">No phone</span>}</div>

        <div className="mt-2 text-[11px] text-[#3D3530] bg-[#F4F0EB] p-2 rounded-lg space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">
              Unit: <strong>{lead[F.UNIT_TYPE] || 'Any'}</strong>
            </span>
            <span className="text-[#6B5F57] truncate">{lead[F.RM] || 'Unassigned'}</span>
          </div>
          <div className={cx('flex items-center gap-1 font-semibold', urgent ? 'text-[#8A3E28]' : due ? 'text-[#A9825A]' : 'text-[#9E948D] font-normal')}>
            {urgent ? <AlertTriangle size={11} /> : <Clock size={11} />}
            <span className="truncate">{due ? `${formatRelative(due)}${urgent ? ` · ${formatDistance(due, now)}` : ''}` : 'No follow-up scheduled'}</span>
          </div>
          {lead[F.LAST_FOLLOWUP] && (
            <div className="text-[10px] text-[#9E948D] flex items-center gap-1">
              <Timer size={10} /> Last contact {formatRelative(lead[F.LAST_FOLLOWUP])}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-2.5 pt-2 border-t border-[#ECE8E1] flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          {phone && (
            <a href={telLink(phone)} className="p-1.5 rounded-full bg-[#F4F0EB] text-[#1976D2] hover:bg-blue-50" title={`Call ${formatPhone(phone)}`}>
              <Phone size={13} />
            </a>
          )}
          {phone && (
            <a href={whatsappLink(phone, waText)} target="_blank" rel="noreferrer" className="p-1.5 rounded-full bg-[#F4F0EB] text-[#25D366] hover:bg-green-50" title="WhatsApp">
              <MessageSquare size={13} />
            </a>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} className={cx('p-1.5 rounded-full hover:bg-[#EBE5DC]', open ? 'bg-[#A9825A] text-white hover:bg-[#A9825A]' : 'bg-[#F4F0EB] text-[#A9825A]')} title="Quick remark">
            <MessageSquarePlus size={13} />
          </button>
        </div>
        <select
          value={stage}
          disabled={changingStage}
          onChange={async (e) => {
            setChangingStage(true);
            await onStage(e.target.value);
            setChangingStage(false);
          }}
          className="text-[10px] py-1 px-1.5 rounded border border-[#D2C9BF] bg-white text-[#1D2F3F] focus:outline-none focus:border-[#A9825A] max-w-[150px] disabled:opacity-60"
          aria-label="Change stage"
        >
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Quick remark */}
      {open && (
        <div className="mt-2.5 space-y-2 bg-[#F4F0EB] rounded-lg p-2.5 border border-[#D2C9BF]">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What happened? Next step?" className={cx(inputCls, 'resize-none')} autoFocus />
          <div className="flex items-center gap-2">
            <input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} className={cx(inputCls, 'flex-1')} aria-label="Next follow-up" title="Next follow-up (optional)" />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="gold" size="xs" onClick={() => void save()} disabled={!text.trim()} loading={saving}>
              Save remark
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
