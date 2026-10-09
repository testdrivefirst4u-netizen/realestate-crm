/**
 * Shared UI primitives — one implementation for cards, KPI tiles, states, modals, etc.
 * Palette: page #F2F7FB · card border #D3E3F0 · navy #0B2A44 · gold #0B6BB0 · sage #0E8A86 · rust #B06A55
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, X, ChevronDown, Calendar } from 'lucide-react';
import { DateRange, RANGE_PRESETS, RangePreset, customRange, getPresetRange, toDateInput } from '../core/dates';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* ------------------------------- Card ---------------------------------- */

export const Card: React.FC<{ title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string; children: React.ReactNode; padded?: boolean }> = ({
  title, subtitle, actions, className, children, padded = true,
}) => (
  <section className={cx('bg-white rounded-2xl border border-[#D3E3F0] shadow-xs', padded && 'p-5', className)}>
    {(title || actions) && (
      <header className={cx('flex items-start justify-between gap-3', padded ? 'mb-4' : 'p-5 pb-0 mb-4')}>
        <div className="min-w-0">
          {title && <h3 className="text-base sm:text-lg font-bold text-[#0B2A44] tracking-tight truncate">{title}</h3>}
          {subtitle && <p className="text-xs text-[#5E778C] mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

/* ------------------------------ Buttons -------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold' | 'sage';
export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'xs' | 'sm' | 'md'; loading?: boolean; icon?: React.ReactNode }> = ({
  variant = 'secondary', size = 'sm', loading, icon, className, children, disabled, ...rest
}) => {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const sizes = { xs: 'px-2.5 py-1 text-[11px]', sm: 'px-3.5 py-2 text-xs', md: 'px-5 py-2.5 text-sm' }[size];
  const variants: Record<Variant, string> = {
    primary: 'bg-[#0B2A44] text-white hover:brightness-110 shadow-xs',
    secondary: 'bg-white text-[#0B2A44] border border-[#D3E3F0] hover:bg-[#F2F7FB]',
    ghost: 'text-[#5E778C] hover:text-[#0B2A44] hover:bg-[#F2F7FB]',
    danger: 'bg-white text-[#8A3E28] border border-[#B06A55]/40 hover:bg-[#FAF0EC]',
    gold: 'bg-[#0B6BB0] text-white hover:brightness-105 shadow-xs',
    sage: 'bg-[#0E8A86] text-white hover:brightness-105 shadow-xs',
  };
  return (
    <button className={cx(base, sizes, variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
};

/* ------------------------------- Badge --------------------------------- */

export const Badge: React.FC<{ tone?: 'navy' | 'gold' | 'sage' | 'rust' | 'muted' | 'amber'; className?: string; children: React.ReactNode; title?: string }> = ({ tone = 'muted', className, children, title }) => {
  const tones = {
    navy: 'bg-[#0B2A44]/10 text-[#0B2A44]',
    gold: 'bg-[#0B6BB0]/15 text-[#0B5E9C]',
    sage: 'bg-[#0E8A86]/20 text-[#3C573A]',
    rust: 'bg-[#FAF0EC] text-[#8A3E28] border border-[#B06A55]/30',
    amber: 'bg-[#FFF8E1] text-[#92400E]',
    muted: 'bg-[#E6EFF6] text-[#5E778C]',
  }[tone];
  return <span title={title} className={cx('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider', tones, className)}>{children}</span>;
};

/** Stage → badge tone, one place. */
export function stageTone(stage: string): 'navy' | 'gold' | 'sage' | 'rust' | 'muted' | 'amber' {
  switch (stage) {
    case 'Booked': return 'sage';
    case 'Hot': return 'rust';
    case 'Warm': return 'gold';
    case 'Qualified': return 'navy';
    case 'New': return 'navy';
    case 'Open': return 'amber';
    case 'Not Responding': return 'amber';
    default: return 'muted';
  }
}

export const StageBadge: React.FC<{ stage: string }> = ({ stage }) => <Badge tone={stageTone(stage)}>{stage || 'New'}</Badge>;

/* ------------------------------ KPI tile -------------------------------- */

export const KpiTile: React.FC<{
  label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'navy' | 'gold' | 'sage' | 'rust' | 'light' | 'white';
  onClick?: () => void; trend?: { value: number | null; suffix?: string; lowerIsBetter?: boolean }; compact?: boolean;
}> = ({ label, value, hint, icon, tone = 'white', onClick, trend, compact }) => {
  const tones = {
    navy: 'bg-[#0B2A44] text-[#C4D8EA] border-transparent',
    gold: 'bg-[#0B6BB0] text-white border-transparent',
    sage: 'bg-[#0E8A86] text-white border-transparent',
    rust: 'bg-[#F5EDE8] text-[#8A3E28] border-[#B06A55]/40',
    light: 'bg-[#C9DBEA] text-[#0F2233] border-transparent',
    white: 'bg-white text-[#0B2A44] border-[#D3E3F0]',
  }[tone];
  const Tag: any = onClick ? 'button' : 'div';
  const good = trend && trend.value !== null && (trend.lowerIsBetter ? trend.value < 0 : trend.value > 0);
  const bad = trend && trend.value !== null && (trend.lowerIsBetter ? trend.value > 0 : trend.value < 0);
  return (
    <Tag onClick={onClick} className={cx('rounded-xl border text-left transition shadow-2xs min-w-0 w-full', compact ? 'p-3' : 'p-3.5', tones, onClick && 'hover:brightness-105 hover:shadow-xs cursor-pointer')}>
      <div className={cx('font-bold leading-tight truncate', compact ? 'text-lg' : 'text-xl sm:text-2xl')}>{value}</div>
      <div className="text-[10px] uppercase font-bold tracking-wider mt-1.5 flex items-center justify-between gap-2 opacity-90">
        <span className="truncate">{label}</span>
        {icon && <span className="opacity-70 flex-shrink-0">{icon}</span>}
      </div>
      {(hint || trend) && (
        <div className="text-[10px] mt-1 opacity-80 flex items-center justify-between gap-2">
          <span className="truncate">{hint}</span>
          {trend && (
            <span className={cx('font-bold flex-shrink-0', good && 'text-emerald-600', bad && 'text-[#B06A55]')}>
              {trend.value === null ? 'new' : `${trend.value > 0 ? '▲' : trend.value < 0 ? '▼' : '•'} ${Math.abs(trend.value).toFixed(0)}${trend.suffix ?? '%'}`}
            </span>
          )}
        </div>
      )}
    </Tag>
  );
};

/* ------------------------------- States --------------------------------- */

export const LoadingState: React.FC<{ label?: string; className?: string }> = ({ label = 'Loading live data…', className }) => (
  <div className={cx('flex flex-col items-center justify-center py-14 text-[#5E778C]', className)}>
    <Loader2 size={26} className="animate-spin text-[#0B6BB0]" />
    <span className="text-xs mt-3 font-medium">{label}</span>
  </div>
);

export const EmptyState: React.FC<{ title: string; description?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode; className?: string }> = ({ title, description, action, icon, className }) => (
  <div className={cx('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
    <div className="w-12 h-12 rounded-2xl bg-[#F2F7FB] text-[#0B6BB0] flex items-center justify-center mb-3">{icon || <Inbox size={22} />}</div>
    <h4 className="text-sm font-bold text-[#0B2A44]">{title}</h4>
    {description && <p className="text-xs text-[#5E778C] mt-1 max-w-md leading-relaxed">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const ErrorState: React.FC<{ title?: string; message?: string; onRetry?: () => void; className?: string; compact?: boolean }> = ({ title = 'Could not load data', message, onRetry, className, compact }) => (
  <div className={cx('rounded-xl border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] flex items-start gap-3', compact ? 'p-3 text-xs' : 'p-5', className)}>
    <AlertTriangle size={compact ? 16 : 20} className="flex-shrink-0 mt-0.5" />
    <div className="flex-1 min-w-0">
      <div className="font-bold text-sm">{title}</div>
      {message && <div className="text-xs mt-1 leading-relaxed break-words">{message}</div>}
    </div>
    {onRetry && (
      <Button variant="danger" size="xs" onClick={onRetry} icon={<RefreshCw size={12} />}>Retry</Button>
    )}
  </div>
);

export const InlineNotice: React.FC<{ tone?: 'info' | 'warning' | 'success'; children: React.ReactNode; className?: string }> = ({ tone = 'info', children, className }) => {
  const t = { info: 'bg-[#F2F7FB] border-[#D3E3F0] text-[#0F2233]', warning: 'bg-amber-50 border-amber-300 text-amber-900', success: 'bg-emerald-50 border-emerald-300 text-emerald-800' }[tone];
  return <div className={cx('p-3 rounded-lg border text-xs leading-relaxed', t, className)}>{children}</div>;
};

/* -------------------------------- Modal --------------------------------- */

export const Modal: React.FC<{ open: boolean; onClose: () => void; title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: 'sm' | 'md' | 'lg' | 'xl'; side?: boolean }> = ({
  open, onClose, title, subtitle, children, footer, width = 'md', side,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[width];
  return (
    <>
      <div className="fixed inset-0 bg-[#0B2A44]/40 backdrop-blur-xs z-50" onClick={onClose} />
      {side ? (
        <div className={cx('fixed top-0 right-0 bottom-0 w-[640px] max-w-full bg-[#FFFFFF] z-50 shadow-2xl flex flex-col border-l border-[#D3E3F0] animate-in slide-in-from-right duration-200')}>
          <ModalHeader title={title} subtitle={subtitle} onClose={onClose} />
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="p-4 border-t border-[#D3E3F0] bg-white flex items-center justify-end gap-2">{footer}</div>}
        </div>
      ) : (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 pointer-events-none">
          <div className={cx('w-full bg-[#FFFFFF] rounded-2xl shadow-2xl border border-[#D3E3F0] flex flex-col max-h-[92vh] pointer-events-auto animate-in fade-in zoom-in-95 duration-150', w)}>
            <ModalHeader title={title} subtitle={subtitle} onClose={onClose} />
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
            {footer && <div className="p-4 border-t border-[#D3E3F0] bg-white rounded-b-2xl flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
          </div>
        </div>
      )}
    </>
  );
};

const ModalHeader: React.FC<{ title: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void }> = ({ title, subtitle, onClose }) => (
  <div className="p-4 sm:p-5 border-b border-[#D3E3F0] bg-white rounded-t-2xl flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h3 className="text-lg font-bold text-[#0B2A44] truncate">{title}</h3>
      {subtitle && <div className="text-xs text-[#5E778C] mt-0.5">{subtitle}</div>}
    </div>
    <button onClick={onClose} className="p-1.5 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Close"><X size={18} /></button>
  </div>
);

/* ------------------------------ Confirm --------------------------------- */

export const ConfirmDialog: React.FC<{ open: boolean; title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; loading?: boolean }> = ({
  open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel, loading,
}) => (
  <Modal open={open} onClose={onCancel} title={title} width="sm" footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button></>}>
    <div className="text-sm text-[#0F2233] leading-relaxed">{message}</div>
  </Modal>
);

/* ------------------------------- Inputs -------------------------------- */

export const inputCls = 'w-full text-xs p-2.5 rounded-lg border border-[#D3E3F0] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0] disabled:bg-[#F2F7FB] disabled:text-[#7E93A6]';
export const labelCls = 'text-[11px] uppercase font-bold tracking-wider text-[#5E778C] block mb-1';

export const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ label, hint, children, className }) => (
  <div className={className}>
    <label className={labelCls}>{label}</label>
    {children}
    {hint && <div className="text-[10px] text-[#7E93A6] mt-1">{hint}</div>}
  </div>
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement> & { options: Array<string | { value: string; label: string }>; placeholder?: string }> = ({ options, placeholder, className, ...rest }) => (
  <select className={cx(inputCls, className)} {...rest}>
    {placeholder !== undefined && <option value="">{placeholder}</option>}
    {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
  </select>
);

/* -------------------------------- Tabs --------------------------------- */

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: Array<{ id: T; label: React.ReactNode; icon?: React.ReactNode; badge?: React.ReactNode }>; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('inline-flex p-1 rounded-xl bg-[#E3EDF5] border border-[#D3E3F0] shadow-2xs flex-wrap', className)}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cx('flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition', value === t.id ? 'bg-white text-[#0B2A44] shadow-sm' : 'text-[#5E778C] hover:text-[#0B2A44]')}>
          {t.icon && <span className={value === t.id ? 'text-[#0B6BB0]' : ''}>{t.icon}</span>}
          <span>{t.label}</span>
          {t.badge !== undefined && <span className="ml-1 text-[10px] font-mono text-[#0B6BB0]">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------- Date range picker --------------------------- */

export interface DateFilterValue {
  preset: RangePreset | 'custom';
  from?: string; // yyyy-MM-dd
  to?: string;
}

export function resolveDateFilter(v: DateFilterValue): DateRange | null {
  if (v.preset === 'custom') return customRange(v.from || '', v.to || '');
  return getPresetRange(v.preset);
}

export const DateRangeFilter: React.FC<{ value: DateFilterValue; onChange: (v: DateFilterValue) => void; presets?: Array<{ id: RangePreset; label: string }>; className?: string }> = ({ value, onChange, presets = RANGE_PRESETS, className }) => {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => {
    if (value.preset === 'custom') {
      const r = resolveDateFilter(value);
      return r ? r.label : 'Custom range';
    }
    return presets.find((p) => p.id === value.preset)?.label || 'All Time';
  }, [value, presets]);
  return (
    <div className={cx('relative', className)}>
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44] font-medium hover:bg-[#F2F7FB]">
        <Calendar size={13} className="text-[#0B6BB0]" /><span>{label}</span><ChevronDown size={12} className="opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-1.5 right-0 sm:left-0 w-72 bg-white rounded-xl border border-[#D3E3F0] shadow-xl p-2 text-xs">
            <div className="grid grid-cols-2 gap-1">
              {presets.map((p) => (
                <button key={p.id} onClick={() => { onChange({ preset: p.id }); setOpen(false); }} className={cx('text-left px-2.5 py-1.5 rounded-md hover:bg-[#F2F7FB]', value.preset === p.id && 'bg-[#0B2A44] text-white hover:bg-[#0B2A44]')}>{p.label}</button>
              ))}
            </div>
            <div className="border-t border-[#E6EFF6] mt-2 pt-2">
              <div className={labelCls}>Custom range</div>
              <div className="flex items-center gap-2">
                <input type="date" value={value.from || ''} max={value.to || undefined} onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to: value.to })} className={inputCls} />
                <span className="text-[#7E93A6]">→</span>
                <input type="date" value={value.to || ''} min={value.from || undefined} onChange={(e) => onChange({ preset: 'custom', from: value.from, to: e.target.value })} className={inputCls} />
              </div>
              <div className="flex justify-between mt-2">
                <button onClick={() => { onChange({ preset: 'all' }); setOpen(false); }} className="text-[#5E778C] hover:text-[#0B2A44] px-2 py-1">Clear</button>
                <button onClick={() => setOpen(false)} className="px-3 py-1 rounded-md bg-[#0B6BB0] text-white font-semibold">Apply</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/** Today's yyyy-MM-dd in CRM time (for input defaults). */
export const todayInputValue = () => toDateInput(new Date());

/* ----------------------------- Progress bar ----------------------------- */

export const Bar: React.FC<{ value: number; max: number; color?: string; className?: string }> = ({ value, max, color = '#0B6BB0', className }) => (
  <div className={cx('w-full bg-[#E3EDF5] h-2 rounded-full overflow-hidden', className)}>
    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0}%`, backgroundColor: color }} />
  </div>
);

/* ----------------------------- Simple table ----------------------------- */

export function DataTable<T>({ columns, rows, keyFn, onRowClick, empty, dense }: {
  columns: Array<{ key: string; label: React.ReactNode; render?: (row: T) => React.ReactNode; align?: 'left' | 'right' | 'center'; className?: string; onSort?: () => void; sortIndicator?: React.ReactNode }>;
  rows: T[]; keyFn: (row: T, i: number) => string; onRowClick?: (row: T) => void; empty?: React.ReactNode; dense?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="bg-[#E6EFF6] border-b border-[#D3E3F0] text-[#5E778C] uppercase font-bold tracking-wider text-[10px]">
            {columns.map((c) => (
              <th key={c.key} onClick={c.onSort} className={cx(dense ? 'p-2.5' : 'p-3.5', c.onSort && 'cursor-pointer hover:text-[#0B2A44] select-none', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                <span className="inline-flex items-center gap-1">{c.label}{c.sortIndicator}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E6EFF6]">
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="p-6 text-center text-[#7E93A6]">{empty || 'No records'}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={keyFn(r, i)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx('transition', onRowClick && 'hover:bg-[#F2F7FB] cursor-pointer')}>
              {columns.map((c) => (
                <td key={c.key} className={cx(dense ? 'p-2.5' : 'p-3.5', 'text-[#0F2233] align-top', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                  {c.render ? c.render(r) : String((r as any)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
