/**
 * The Leads table's bulk bar: appears when leads are ticked, and applies one change to all of them —
 * assign to an RM, change the stage, set the next follow-up, add the same remark, export, or move to the bin.
 */
import React, { useState } from 'react';
import { CalendarClock, Download, MessageSquarePlus, Tag, Trash2, UserCog, X } from 'lucide-react';
import type { BulkOp } from '../../core/api';
import { fromDatetimeLocalInput } from '../../core/dates';
import { Button, Field, Modal, Select, cx, inputCls } from '../../components/ui';

export interface BulkBarProps {
  count: number;
  rms: string[];
  stages: string[];
  canAssign: boolean;
  canTrash: boolean;
  canExport: boolean;
  onApply: (op: BulkOp, value: string) => Promise<boolean>;
  onExport: () => void;
  onClear: () => void;
}

const TITLES: Record<BulkOp, string> = {
  assign: 'Assign to',
  stage: 'Change stage',
  followup: 'Set next follow-up',
  remark: 'Add a remark',
  trash: 'Move to the bin',
};

export const BulkBar: React.FC<BulkBarProps> = ({ count, rms, stages, canAssign, canTrash, canExport, onApply, onExport, onClear }) => {
  const [op, setOp] = useState<BulkOp | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const leads = `${count} lead${count === 1 ? '' : 's'}`;

  const open = (o: BulkOp) => { setOp(o); setValue(''); };
  const ready = op === 'trash' || op === 'assign' || op === 'followup' || !!value.trim();
  const apply = async () => {
    if (!op || !ready) return;
    setBusy(true);
    const v = op === 'followup' ? (value ? fromDatetimeLocalInput(value) : '') : value;
    const ok = await onApply(op, v);
    setBusy(false);
    if (ok) setOp(null);
  };

  const action = (o: BulkOp, label: string, icon: React.ReactNode, show = true, danger = false) =>
    show && (
      <button key={o} type="button" onClick={() => open(o)}
        className={cx('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition', danger ? 'border-[#F3C6C2]/40 text-[#FFD9D5] hover:bg-[#B42318]' : 'border-white/20 text-white hover:bg-white/10')}>
        {icon}{label}
      </button>
    );

  return (
    <>
      <div role="region" aria-label="Bulk actions" className={cx('fixed z-40 left-1/2 -translate-x-1/2 bottom-[max(16px,env(safe-area-inset-bottom,0px))] w-[min(960px,calc(100vw-32px))] transition-all duration-300', count ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6 pointer-events-none')}>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#0A1F33] text-white shadow-2xl px-3 py-2.5">
          <span className="text-sm font-bold px-1 mr-1 tabular-nums">{leads} selected</span>
          {action('assign', 'Assign to', <UserCog size={13} />, canAssign)}
          {action('stage', 'Change stage', <Tag size={13} />)}
          {action('followup', 'Next follow-up', <CalendarClock size={13} />)}
          {action('remark', 'Add remark', <MessageSquarePlus size={13} />)}
          {canExport && (
            <button type="button" onClick={onExport} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/20 text-white hover:bg-white/10">
              <Download size={13} />Export
            </button>
          )}
          {action('trash', 'Move to bin', <Trash2 size={13} />, canTrash, true)}
          <button type="button" onClick={onClear} className="ml-auto inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold text-[#9CC9EE] hover:text-white" title="Clear the selection">
            <X size={13} />Clear
          </button>
        </div>
      </div>

      <Modal
        open={!!op}
        onClose={() => !busy && setOp(null)}
        title={op ? `${TITLES[op]} · ${leads}` : ''}
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOp(null)} disabled={busy}>Cancel</Button>
            <Button variant={op === 'trash' ? 'danger' : 'primary'} onClick={() => void apply()} loading={busy} disabled={!ready}>
              {op === 'trash' ? `Move ${leads} to the bin` : `Apply to ${leads}`}
            </Button>
          </div>
        }
      >
        {op === 'assign' && (
          <Field label="Assign to">
            <Select value={value} onChange={(e) => setValue(e.target.value)} options={[{ value: '', label: 'Nobody (unassigned)' }, ...rms.map((r) => ({ value: r, label: r }))]} />
          </Field>
        )}
        {op === 'stage' && (
          <Field label="New stage" hint="Booked stamps today as the booking date, like changing it on one lead">
            <Select value={value} onChange={(e) => setValue(e.target.value)} options={stages} placeholder="Choose a stage…" />
          </Field>
        )}
        {op === 'followup' && (
          <Field label="Next follow-up" hint="Leave empty to clear the next follow-up on these leads">
            <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} />
          </Field>
        )}
        {op === 'remark' && (
          <Field label="Remark" hint="Added as the next follow-up entry on every selected lead">
            <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} maxLength={2000} className={cx(inputCls, 'resize-y')} placeholder="e.g. Sent the new price sheet on WhatsApp" />
          </Field>
        )}
        {op === 'trash' && (
          <p className="text-sm text-[#2B4A63]">These leads go to the bin. An administrator can restore them from there.</p>
        )}
      </Modal>
    </>
  );
};
