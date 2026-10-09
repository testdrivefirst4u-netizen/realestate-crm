/**
 * KanbanView — "Enquiry Status" board.
 *
 * Columns come from config (FUNNEL_STAGES, then STAGE_CLASS.lost behind a
 * toggle) — never hard-coded in the view. Cards move between columns with
 * native HTML5 drag-and-drop or the per-card stage select; both call
 * `onUpdateLeadStage` (optimistic, toasts handled by the engine).
 * Cards inside every column follow the toolbar's sort (default: next
 * follow-up soonest first, then newest enquiry), remembered per browser.
 */
import React, { useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { Eye, EyeOff, GripVertical, KanbanSquare, MessageSquare, Phone, Plus, Search, Users } from 'lucide-react';
import { CRMConfig, Lead } from '../../types/crm';
import { F, FUNNEL_STAGES, STAGES, STAGE_CLASS } from '../../core/config';
import { classifyStage, countedLeads, isActive, nextFollowupDate, searchLeads, stageOf } from '../../core/analytics';
import { formatRelative } from '../../core/dates';
import { formatPhone, telLink, whatsappLink } from '../../core/phone';
import { sound } from '../../services/sound';
import { Button, EmptyState, Select, cx } from '../../components/ui';
import { LeadStars, optionsWithCurrent } from './shared';
import { SORT_OPTIONS, SORT_PREF_KEYS, sortLeads } from './sorting';
import { SortControl, usePersistentSort } from './SortControl';

export interface KanbanViewProps {
  leads: Lead[];
  config: CRMConfig;
  onOpenLead: (id: string) => void;
  onUpdateLeadStage: (id: string, stage: string) => Promise<boolean>;
  onOpenAddLead: () => void;
}

const DND_MIME = 'text/plain';

/** Every card in a column shares its stage, so sorting by stage is not offered here. */
const KANBAN_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'stage');
const KANBAN_SORT_KEYS = KANBAN_SORT_OPTIONS.map((o) => o.key);

/** Column accent per stage class — one place. */
function columnAccent(stage: string): { header: string; count: string } {
  if (stage === STAGES.BOOKED) return { header: 'bg-[#0E8A86]/25 text-[#3C573A]', count: 'bg-[#0E8A86] text-white' };
  if (stage === STAGES.HOT) return { header: 'bg-[#F5EDE8] text-[#8A3E28]', count: 'bg-[#B06A55] text-white' };
  if (stage === STAGES.WARM || stage === STAGES.QUALIFIED) return { header: 'bg-[#0B6BB0]/20 text-[#0B5E9C]', count: 'bg-[#0B6BB0] text-white' };
  if (classifyStage(stage) === 'lost') return { header: 'bg-[#E6EFF6] text-[#5E778C]', count: 'bg-[#7E93A6] text-white' };
  return { header: 'bg-[#C4D8EA]/60 text-[#0B2A44]', count: 'bg-[#0B2A44] text-white' };
}

export const KanbanView: React.FC<KanbanViewProps> = ({ leads, config, onOpenLead, onUpdateLeadStage, onOpenAddLead }) => {
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [rm, setRm] = useState('');
  const [sort, setSort] = usePersistentSort(SORT_PREF_KEYS.kanban, { key: 'nextDue', asc: true }, KANBAN_SORT_KEYS);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(() => new Set());

  const base = useMemo(() => countedLeads(leads), [leads]);
  const rmOptions = useMemo(() => {
    const set = new Set<string>(config.options[F.RM] || []);
    for (const l of base) if (String(l[F.RM] || '').trim()) set.add(String(l[F.RM]).trim());
    return [...set];
  }, [config.options, base]);

  const stageOptions = useMemo(() => (config.options[F.STAGE] || []).filter((s) => !STAGE_CLASS.excluded.includes(s)), [config.options]);

  const columns = useMemo(() => {
    const cols = showClosed ? [...FUNNEL_STAGES, ...STAGE_CLASS.lost] : [...FUNNEL_STAGES];
    // Config may define stages the pipeline does not know yet — give them a column rather than hiding leads.
    for (const s of stageOptions) if (!cols.includes(s) && (showClosed || classifyStage(s) !== 'lost')) cols.push(s);
    return cols;
  }, [showClosed, stageOptions]);

  const grouped = useMemo(() => {
    const q = query.trim();
    let list = q ? searchLeads(base, q, base.length) : base;
    if (rm) list = list.filter((l) => String(l[F.RM] || '').trim() === rm);
    const map = new Map<string, Lead[]>();
    for (const c of columns) map.set(c, []);
    const extra = new Map<string, Lead[]>();
    for (const l of list) {
      const s = stageOf(l) || STAGES.NEW;
      if (map.has(s)) map.get(s)!.push(l);
      else if (!showClosed && classifyStage(s) === 'lost') continue; // hidden behind the toggle
      else {
        if (!extra.has(s)) extra.set(s, []);
        extra.get(s)!.push(l);
      }
    }
    for (const [stage, arr] of map) map.set(stage, sortLeads(arr, sort.key, sort.asc));
    for (const [stage, arr] of extra) extra.set(stage, sortLeads(arr, sort.key, sort.asc));
    return { map, extra, total: list.length };
  }, [base, query, rm, columns, showClosed, sort.key, sort.asc]);

  const allColumns = useMemo(() => [...columns, ...grouped.extra.keys()], [columns, grouped.extra]);
  const hiddenLost = useMemo(() => (showClosed ? 0 : base.filter((l) => classifyStage(stageOf(l)) === 'lost').length), [base, showClosed]);

  const moveLead = async (id: string, stage: string) => {
    const lead = base.find((l) => l[F.ID] === id);
    if (!lead || (stageOf(lead) || STAGES.NEW) === stage) return;
    setUpdating((s) => new Set(s).add(id));
    const ok = await onUpdateLeadStage(id, stage);
    setUpdating((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (ok && stage === STAGES.BOOKED) {
      sound.playSuccess();
      try {
        confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 }, colors: ['#0B6BB0', '#0B2A44', '#0E8A86', '#C4D8EA'] });
      } catch {
        /* cosmetic */
      }
    }
  };

  if (base.length === 0) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="bg-white rounded-2xl border border-[#D3E3F0] shadow-xs">
          <EmptyState
            icon={<KanbanSquare size={22} />}
            title="The pipeline is empty"
            description="Enquiries appear here as cards grouped by stage. Drag a card to move it along the funnel."
            action={
              <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
                New Enquiry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 h-[calc(100vh-4rem)] flex flex-col gap-4 overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 flex-shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">Enquiry Status</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">
            {grouped.total} {grouped.total === 1 ? 'enquiry' : 'enquiries'} on the board · drag a card or use its stage menu to move it
            {hiddenLost > 0 && <span className="text-[#7E93A6]"> · {hiddenLost} closed/lost hidden</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-56">
            <Search size={14} className="absolute left-3 top-2.5 text-[#7E93A6]" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter cards…" className="w-full text-xs pl-8 pr-3 py-2 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0]" aria-label="Filter cards" />
          </div>
          <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Relationship manager" />
          <SortControl sortKey={sort.key} asc={sort.asc} onChange={setSort} options={KANBAN_SORT_OPTIONS} />
          <Button variant={showClosed ? 'primary' : 'secondary'} onClick={() => setShowClosed((v) => !v)} icon={showClosed ? <EyeOff size={13} /> : <Eye size={13} />} title="Toggle Not Responding / DND / Junk / Disqualified columns">
            {showClosed ? 'Hide closed/lost' : 'Show closed/lost columns'}
          </Button>
          <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
            New Enquiry
          </Button>
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto pb-3 items-stretch">
        {allColumns.map((stage) => {
          const items = grouped.map.get(stage) || grouped.extra.get(stage) || [];
          const accent = columnAccent(stage);
          const isOver = dragOver === stage;
          return (
            <section
              key={stage}
              className={cx('w-72 flex-shrink-0 bg-[#E6EFF6] rounded-xl border flex flex-col max-h-full overflow-hidden shadow-2xs transition', isOver ? 'border-[#0B6BB0] ring-2 ring-[#0B6BB0]/40' : 'border-[#D3E3F0]')}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOver !== stage) setDragOver(stage);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                if (dragOver === stage) setDragOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData(DND_MIME) || dragId;
                setDragOver(null);
                setDragId(null);
                if (id) void moveLead(id, stage);
              }}
              aria-label={`${stage} column`}
            >
              <header className={cx('px-3.5 py-3 border-b border-[#D3E3F0] flex items-center justify-between gap-2 flex-shrink-0', accent.header)}>
                <span className="font-bold text-sm truncate">{stage}</span>
                <span className={cx('text-[10px] font-bold font-mono rounded-full px-2 py-0.5', accent.count)}>{items.length}</span>
              </header>
              <div className="p-3 overflow-y-auto space-y-3 flex-1 min-h-[120px]">
                {items.length === 0 ? (
                  <div className={cx('text-center py-8 text-xs rounded-lg border border-dashed', isOver ? 'border-[#0B6BB0] text-[#0B5E9C] bg-white/60' : 'border-[#D3E3F0] text-[#7E93A6]')}>{isOver ? `Drop to move to ${stage}` : 'No enquiries'}</div>
                ) : (
                  items.map((lead) => (
                    <KanbanCard
                      key={lead[F.ID]}
                      lead={lead}
                      stageOptions={optionsWithCurrent(stageOptions, stageOf(lead))}
                      dragging={dragId === lead[F.ID]}
                      busy={updating.has(lead[F.ID])}
                      onOpen={() => onOpenLead(lead[F.ID])}
                      onStage={(s) => void moveLead(lead[F.ID], s)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DND_MIME, lead[F.ID]);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(lead[F.ID]);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragOver(null);
                      }}
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

const KanbanCard: React.FC<{
  lead: Lead;
  stageOptions: string[];
  dragging: boolean;
  busy: boolean;
  onOpen: () => void;
  onStage: (stage: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}> = ({ lead, stageOptions, dragging, busy, onOpen, onStage, onDragStart, onDragEnd }) => {
  const phone = String(lead[F.PHONE] || '');
  const due = nextFollowupDate(lead);
  const overdue = !!due && due.getTime() < Date.now() && isActive(lead);
  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cx(
        'bg-white rounded-xl p-3.5 border shadow-xs hover:border-[#0B6BB0] hover:shadow-md transition cursor-pointer group select-none',
        dragging ? 'opacity-40 border-[#0B6BB0]' : 'border-[#D3E3F0]',
        busy && 'opacity-60 pointer-events-none'
      )}
      title="Drag to another column or click to open"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <div className="font-bold text-xs text-[#0B2A44] group-hover:text-[#0B6BB0] transition truncate">{lead[F.NAME] || 'Unnamed'}</div>
          <div className="text-[10px] text-[#7E93A6] mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[#0B6BB0] font-semibold">{lead[F.ID]}</span>
            {lead[F.SOURCE] && (
              <>
                <span>·</span>
                <span className="uppercase tracking-wider">{lead[F.SOURCE]}</span>
              </>
            )}
          </div>
        </div>
        <GripVertical size={14} className="text-[#D3E3F0] group-hover:text-[#7E93A6] flex-shrink-0 mt-0.5" />
      </div>

      <div className="text-[11px] text-[#5E778C] font-medium">{formatPhone(phone) || <span className="text-[#7E93A6]">No phone</span>}</div>

      <div className="mt-2 p-2 rounded-lg bg-[#F2F7FB] text-[11px] text-[#0F2233] flex items-center justify-between gap-2">
        <span className="truncate">
          Unit: <strong>{lead[F.UNIT_TYPE] || 'Any'}</strong>
        </span>
        <LeadStars lead={lead} size={10} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
        <span className={cx('font-semibold truncate', overdue ? 'text-[#B06A55]' : due ? 'text-[#0B6BB0]' : 'text-[#7E93A6] font-normal')}>{due ? `${overdue ? 'Overdue' : 'Next'}: ${formatRelative(due)}` : 'No follow-up set'}</span>
        <span className="text-[#5E778C] truncate flex items-center gap-1 flex-shrink-0">
          <Users size={10} /> {lead[F.RM] || 'Unassigned'}
        </span>
      </div>

      <div className="mt-2.5 pt-2 border-t border-[#E6EFF6] flex items-center justify-between gap-1.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          {phone && (
            <a href={telLink(phone)} className="p-1.5 rounded bg-[#F2F7FB] text-[#1976D2] hover:bg-blue-50" title="Call" draggable={false}>
              <Phone size={12} />
            </a>
          )}
          {phone && (
            <a href={whatsappLink(phone)} target="_blank" rel="noreferrer" className="p-1.5 rounded bg-[#F2F7FB] text-[#25D366] hover:bg-green-50" title="WhatsApp" draggable={false}>
              <MessageSquare size={12} />
            </a>
          )}
        </div>
        <select
          value={stageOf(lead) || STAGES.NEW}
          onChange={(e) => onStage(e.target.value)}
          disabled={busy}
          className="text-[10px] py-1 px-1.5 rounded border border-[#D3E3F0] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0] max-w-[150px]"
          aria-label="Change stage"
        >
          {stageOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
