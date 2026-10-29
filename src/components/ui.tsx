/**
 * Shared UI primitives — one implementation for cards, KPI tiles, states, modals, etc.
 * Palette: page #F2F7FB · card border #D3E3F0 · navy #0B2A44 · gold #0B6BB0 · sage #0E8A86 · rust #B06A55
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Maximize2, Minimize2, Minus, PanelLeft, PanelRight, PictureInPicture2, Pin, PinOff, RefreshCw, X, ChevronDown, Calendar } from 'lucide-react';
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

const SIDE_DEFAULT = 640;
const SIDE_MIN = 420;
/** Older builds kept only the width under this key. */
const SIDE_WIDTH_KEY = 'crm.sidePanelWidth';
const SIDE_PREFS_KEY = 'crm.sidePanel';
/** Widest the side panel may get: the window less a strip of the page behind it. */
const sideMax = () => (typeof window === 'undefined' ? 1600 : Math.max(SIDE_MIN, window.innerWidth - 80));
/** Smallest floating window. */
const FLOAT_MIN_W = 360;
const FLOAT_MIN_H = 320;

interface FloatRect { x: number; y: number; w: number; h: number }
interface SidePrefs {
  /** side = docked to an edge, full = the whole window, float = a window you move and size anywhere. */
  mode: 'side' | 'full' | 'float';
  /** Width when docked to a side. */
  width: number;
  /** Which side of the window it is docked to. */
  dock: 'right' | 'left';
  /** "Keep open" (side and full screen): no dark overlay; the page behind stays usable, a click outside does not close it. */
  pinned: boolean;
  /** Where the floating window is, and its size. */
  float: FloatRect | null;
}
const SIDE_PREFS: SidePrefs = { mode: 'side', width: SIDE_DEFAULT, dock: 'right', pinned: false, float: null };

/** A floating window kept inside the browser window (at least its title bar stays reachable). */
function fitFloat(r: FloatRect): FloatRect {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(r.w, FLOAT_MIN_W), vw - 16);
  const h = Math.min(Math.max(r.h, FLOAT_MIN_H), vh - 16);
  return { w, h, x: Math.min(Math.max(r.x, 8), vw - w - 8), y: Math.min(Math.max(r.y, 8), vh - h - 8) };
}
const defaultFloat = (): FloatRect => {
  const w = Math.min(560, window.innerWidth - 48);
  const h = Math.min(720, window.innerHeight - 96);
  return fitFloat({ w, h, x: window.innerWidth - w - 24, y: 72 });
};

function loadSidePrefs(): SidePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(SIDE_PREFS_KEY) || 'null');
    const old = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    const p = { ...SIDE_PREFS, ...(saved && typeof saved === 'object' ? saved : {}), ...(!saved && old >= SIDE_MIN ? { width: old } : {}) };
    const mode: SidePrefs['mode'] = ['side', 'full', 'float'].includes(p.mode) ? p.mode : p.full ? 'full' : 'side';
    const f = p.float && typeof p.float === 'object' ? p.float : null;
    return {
      mode,
      width: Math.min(Math.max(Number(p.width) || SIDE_DEFAULT, SIDE_MIN), sideMax()),
      dock: p.dock === 'left' ? 'left' : 'right',
      pinned: !!p.pinned,
      float: f && [f.x, f.y, f.w, f.h].every((n: unknown) => Number.isFinite(Number(n))) ? fitFloat({ x: +f.x, y: +f.y, w: +f.w, h: +f.h }) : null,
    };
  } catch {
    return SIDE_PREFS;
  }
}

const HeaderButton: React.FC<{ label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }> = ({ label, onClick, pressed, children }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={pressed} className={cx('p-1.5 rounded-md hover:bg-[#F2F7FB]', pressed ? 'text-[#0B6BB0] bg-[#E4F0FA]' : 'text-[#7E93A6] hover:text-[#0B2A44]')}>
    {children}
  </button>
);

type Drag =
  | { kind: 'side' }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'size'; edges: 'right' | 'bottom' | 'corner'; x0: number; y0: number; r0: FloatRect };

/**
 * The side panel (a lead's details), arranged as each person likes — remembered on this device:
 *  - docked to the right or left side, its inner edge dragged wider or narrower (double-click: the normal width);
 *  - full screen;
 *  - a floating window: moved by its title bar, sized from its right edge, bottom edge or corner, with the page
 *    behind it still usable;
 *  - "Keep open" (side / full screen): no overlay, the page behind stays usable;
 *  - minimised to a small bar at the bottom (what is open stays as it is), and opened again from there.
 * Full screen on phones.
 */
const SidePanel: React.FC<{ title: React.ReactNode; subtitle?: React.ReactNode; footer?: React.ReactNode; onClose: () => void; panelKey?: string; children: React.ReactNode }> = ({ title, subtitle, footer, onClose, panelKey, children }) => {
  const [prefs, setPrefs] = useState<SidePrefs>(SIDE_PREFS);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [minimized, setMinimized] = useState(false);
  // the arrangement chosen on this device (read after mount: the server render has no storage)
  useEffect(() => setPrefs(loadSidePrefs()), []);
  const persist = (next: SidePrefs) => {
    try {
      localStorage.setItem(SIDE_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: applies now only */
    }
  };
  const update = (patch: Partial<SidePrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      persist(next);
      return next;
    });
  // a smaller window: keep the panel inside it
  useEffect(() => {
    const fit = () => setPrefs((p) => ({ ...p, width: Math.min(p.width, sideMax()), float: p.float ? fitFloat(p.float) : p.float }));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  // another lead opened while minimised: show it
  useEffect(() => setMinimized(false), [panelKey]);
  // Escape closes (not while minimised)
  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [minimized, onClose]);

  const left = prefs.dock === 'left';
  const floating = prefs.mode === 'float';
  const rect = prefs.float || (typeof window === 'undefined' ? { x: 0, y: 0, w: 560, h: 640 } : defaultFloat());
  const widthAt = (clientX: number) => Math.min(sideMax(), Math.max(SIDE_MIN, left ? clientX : window.innerWidth - clientX));

  /** Pointer handlers for one drag (resize the docked panel, move or size the window). */
  const dragHandlers = (start: (e: React.PointerEvent) => Drag | null) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const d = start(e);
      if (!d) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag(d);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag) return;
      if (drag.kind === 'side') setPrefs((p) => ({ ...p, width: widthAt(e.clientX) }));
      else if (drag.kind === 'move') setPrefs((p) => ({ ...p, float: fitFloat({ ...rect, x: e.clientX - drag.dx, y: e.clientY - drag.dy }) }));
      else {
        const { r0, x0, y0, edges } = drag;
        setPrefs((p) => ({ ...p, float: fitFloat({ ...r0, w: edges === 'bottom' ? r0.w : r0.w + e.clientX - x0, h: edges === 'right' ? r0.h : r0.h + e.clientY - y0 }) }));
      }
    },
    onPointerUp: () => {
      if (!drag) return;
      setDrag(null);
      setPrefs((p) => {
        persist(p);
        return p;
      });
    },
  });

  const sizeHandle = (edges: 'right' | 'bottom' | 'corner', cls: string, label: string) => (
    <div
      aria-hidden="true"
      title={label}
      {...dragHandlers((e) => ({ kind: 'size', edges, x0: e.clientX, y0: e.clientY, r0: rect }))}
      className={cx('hidden sm:block absolute z-10', cls)}
    />
  );

  return (
    <>
      {!minimized && !prefs.pinned && !floating && <div className="fixed inset-0 bg-[#0B2A44]/40 backdrop-blur-xs z-50" onClick={onClose} />}
      <div
        hidden={minimized}
        role={floating ? 'dialog' : undefined}
        aria-modal={floating ? false : undefined}
        className={cx(
          'fixed top-0 bottom-0 left-0 right-0 w-full max-w-full bg-[#FFFFFF] z-50 shadow-2xl flex flex-col',
          prefs.mode === 'side' && cx('sm:w-(--side-w)', left ? 'sm:right-auto border-r border-[#D3E3F0]' : 'sm:left-auto border-l border-[#D3E3F0]'),
          floating && 'sm:left-(--fx) sm:top-(--fy) sm:w-(--fw) sm:h-(--fh) sm:right-auto sm:bottom-auto sm:rounded-2xl sm:border sm:border-[#B9CCDB] sm:overflow-hidden sm:shadow-[0_24px_60px_rgba(10,31,51,0.35)]',
          !drag && !floating && (left ? 'animate-in slide-in-from-left duration-200' : 'animate-in slide-in-from-right duration-200'),
          !drag && floating && 'animate-in fade-in zoom-in-95 duration-150',
        )}
        style={{ '--side-w': `${prefs.width}px`, '--fx': `${rect.x}px`, '--fy': `${rect.y}px`, '--fw': `${rect.w}px`, '--fh': `${rect.h}px` } as React.CSSProperties}
      >
        {/* docked: resize handle on the inner edge — drag, double-click for the normal width */}
        {prefs.mode === 'side' && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize the panel"
            aria-valuemin={SIDE_MIN}
            aria-valuemax={sideMax()}
            aria-valuenow={prefs.width}
            tabIndex={0}
            title="Drag to resize · double-click for the normal width"
            {...dragHandlers(() => ({ kind: 'side' }))}
            onDoubleClick={() => update({ width: SIDE_DEFAULT })}
            onKeyDown={(e) => {
              // keyboard: the arrow away from the docked edge widens it
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const wider = left ? e.key === 'ArrowRight' : e.key === 'ArrowLeft';
              update({ width: Math.min(sideMax(), Math.max(SIDE_MIN, prefs.width + (wider ? 40 : -40))) });
            }}
            className={cx('hidden sm:flex absolute top-0 bottom-0 w-3 z-10 cursor-col-resize items-center justify-center group focus-visible:outline-none', left ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2')}
          >
            <span className={cx('h-12 w-1.5 rounded-full transition-colors', drag?.kind === 'side' ? 'bg-[#0B6BB0]' : 'bg-[#B9CCDB] group-hover:bg-[#0B6BB0] group-focus-visible:bg-[#0B6BB0]')} />
          </div>
        )}

        {/* floating: the title bar moves it (not its buttons) */}
        <div
          className={cx(floating && 'sm:cursor-move sm:select-none')}
          {...(floating ? dragHandlers((e) => ((e.target as HTMLElement).closest('button, a, input, select, textarea') ? null : { kind: 'move', dx: e.clientX - rect.x, dy: e.clientY - rect.y })) : {})}
          onDoubleClick={floating ? (e) => { if (!(e.target as HTMLElement).closest('button')) update({ mode: 'full' }); } : undefined}
        >
          <ModalHeader
            title={title}
            subtitle={subtitle}
            onClose={onClose}
            onMinimize={() => setMinimized(true)}
            controls={
              <span className="hidden sm:flex items-center gap-1">
                {prefs.mode === 'side' && (
                  <HeaderButton label={left ? 'Move to the right side' : 'Move to the left side'} onClick={() => update({ dock: left ? 'right' : 'left' })}>
                    {left ? <PanelRight size={18} /> : <PanelLeft size={18} />}
                  </HeaderButton>
                )}
                {!floating && (
                  <HeaderButton label={prefs.pinned ? 'Keep open is on: a click outside does not close it' : 'Keep open while I work on the page'} pressed={prefs.pinned} onClick={() => update({ pinned: !prefs.pinned })}>
                    {prefs.pinned ? <Pin size={17} /> : <PinOff size={17} />}
                  </HeaderButton>
                )}
                <HeaderButton
                  label={floating ? 'Dock to the side' : 'Pop out as a window you can move and size'}
                  pressed={floating}
                  onClick={() => update(floating ? { mode: 'side' } : { mode: 'float', float: prefs.float || defaultFloat() })}
                >
                  <PictureInPicture2 size={17} />
                </HeaderButton>
                <HeaderButton label={prefs.mode === 'full' ? 'Back to a side panel' : 'Full screen'} onClick={() => update({ mode: prefs.mode === 'full' ? 'side' : 'full' })}>
                  {prefs.mode === 'full' ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </HeaderButton>
              </span>
            }
          />
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="p-4 border-t border-[#D3E3F0] bg-white flex items-center justify-end gap-2">{footer}</div>}

        {/* floating: size it from the right edge, the bottom edge or the corner */}
        {floating && (
          <>
            {sizeHandle('right', 'top-12 bottom-4 right-0 w-2 cursor-ew-resize', 'Drag to change the width')}
            {sizeHandle('bottom', 'left-4 right-4 bottom-0 h-2 cursor-ns-resize', 'Drag to change the height')}
            {sizeHandle('corner', 'right-0 bottom-0 w-5 h-5 cursor-nwse-resize', 'Drag to resize')}
            <span aria-hidden="true" className="hidden sm:block absolute right-1 bottom-1 w-3 h-3 border-r-2 border-b-2 border-[#9DB0C1] rounded-br pointer-events-none" />
          </>
        )}
      </div>

      {/* while dragging: keep the text underneath from being selected and the cursor steady */}
      {drag && <div className={cx('fixed inset-0 z-60 select-none', drag.kind === 'move' ? 'cursor-move' : drag.kind === 'side' ? 'cursor-col-resize' : drag.kind === 'size' && drag.edges === 'right' ? 'cursor-ew-resize' : drag.kind === 'size' && drag.edges === 'bottom' ? 'cursor-ns-resize' : 'cursor-nwse-resize')} />}

      {/* minimised: a bar to open it again */}
      {minimized && (
        <div className={cx('fixed z-40 bottom-24 lg:bottom-5 flex items-center gap-1 rounded-xl bg-[#0B2A44] text-white shadow-[0_8px_24px_rgba(10,31,51,0.3)] pl-3 pr-1 py-1 max-w-[calc(100vw-24px)]', left && prefs.mode === 'side' ? 'left-3' : 'right-3')} role="region" aria-label="Minimised panel">
          <button type="button" onClick={() => setMinimized(false)} className="flex items-center gap-2 min-w-0 py-1.5 text-[13px] font-semibold" title="Open it again">
            <span className="truncate max-w-64">{title}</span>
            <Maximize2 size={13} className="flex-none opacity-70" />
          </button>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/15" aria-label="Close" title="Close"><X size={14} /></button>
        </div>
      )}
    </>
  );
};

export const Modal: React.FC<{
  open: boolean; onClose: () => void; title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: 'sm' | 'md' | 'lg' | 'xl'; side?: boolean;
  /** Shows a Minimise button in the header. */
  onMinimize?: () => void;
  /** Minimised: hidden, but its contents stay mounted (what was typed is kept). */
  minimized?: boolean;
  /** Side panel: what it shows (e.g. the lead id) — a different one opened while minimised is shown again. */
  panelKey?: string;
}> = ({
  open, onClose, title, subtitle, children, footer, width = 'md', side, onMinimize, minimized, panelKey,
}) => {
  useEffect(() => {
    if (!open || minimized || side) return; // the side panel handles its own Escape (not while minimised)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, minimized, side, onClose]);
  if (!open) return null;
  if (side) return <SidePanel title={title} subtitle={subtitle} footer={footer} onClose={onClose} panelKey={panelKey}>{children}</SidePanel>;
  if (minimized) return <div hidden>{children}{footer}</div>;
  const w = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[width];
  return (
    <>
      <div className="fixed inset-0 bg-[#0B2A44]/40 backdrop-blur-xs z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 pointer-events-none">
        <div className={cx('w-full bg-[#FFFFFF] rounded-2xl shadow-2xl border border-[#D3E3F0] flex flex-col max-h-[92vh] pointer-events-auto animate-in fade-in zoom-in-95 duration-150', w)}>
          <ModalHeader title={title} subtitle={subtitle} onClose={onClose} onMinimize={onMinimize} />
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="p-4 border-t border-[#D3E3F0] bg-white rounded-b-2xl flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
        </div>
      </div>
    </>
  );
};

const ModalHeader: React.FC<{ title: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void; onMinimize?: () => void; controls?: React.ReactNode }> = ({ title, subtitle, onClose, onMinimize, controls }) => (
  <div className="p-4 sm:p-5 border-b border-[#D3E3F0] bg-white rounded-t-2xl flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h3 className="text-lg font-bold text-[#0B2A44] truncate">{title}</h3>
      {subtitle && <div className="text-xs text-[#5E778C] mt-0.5">{subtitle}</div>}
    </div>
    <div className="flex items-center gap-1 flex-none">
      {controls}
      {onMinimize && <button onClick={onMinimize} className="p-1.5 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Minimise" title="Minimise — keep what you typed and carry on working"><Minus size={18} /></button>}
      <button onClick={onClose} className="p-1.5 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Close"><X size={18} /></button>
    </div>
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
          <div className="fixed inset-0 z-50 bg-[#0A1F33]/30 sm:bg-transparent sm:z-30" onClick={() => setOpen(false)} />
          {/* phone: a sheet from the bottom, full width; larger screens: a dropdown under the button */}
          <div role="dialog" aria-label="Choose a period" className="fixed inset-x-0 bottom-0 z-60 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl text-sm sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:z-40 sm:mt-1.5 sm:w-80 sm:max-h-none sm:rounded-xl sm:border sm:border-[#D3E3F0] sm:p-2 sm:pb-2 sm:shadow-xl sm:text-xs">
            <div className="flex items-center justify-between mb-3 sm:hidden">
              <span className="text-base font-bold text-[#0B2A44]">Choose a period</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="h-10 w-10 -mr-2 grid place-items-center rounded-full text-[#5E778C] hover:bg-[#F2F7FB]"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:gap-1">
              {presets.map((p) => (
                <button key={p.id} onClick={() => { onChange({ preset: p.id }); setOpen(false); }} className={cx('text-left px-3 py-3 sm:px-2.5 sm:py-1.5 rounded-lg sm:rounded-md border border-[#E1ECF5] sm:border-transparent hover:bg-[#F2F7FB]', value.preset === p.id && 'bg-[#0B2A44] border-[#0B2A44] text-white hover:bg-[#0B2A44]')}>{p.label}</button>
              ))}
            </div>
            <div className="border-t border-[#E6EFF6] mt-3 pt-3 sm:mt-2 sm:pt-2">
              <div className={labelCls}>Custom range</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#5E778C] min-w-0">From
                  <input type="date" value={value.from || ''} max={value.to || undefined} onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to: value.to })} className={cx(inputCls, 'w-full min-w-0 h-11 sm:h-auto')} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#5E778C] min-w-0">To
                  <input type="date" value={value.to || ''} min={value.from || undefined} onChange={(e) => onChange({ preset: 'custom', from: value.from, to: e.target.value })} className={cx(inputCls, 'w-full min-w-0 h-11 sm:h-auto')} />
                </label>
              </div>
              <div className="flex justify-between gap-2 mt-3 sm:mt-2">
                <button onClick={() => { onChange({ preset: 'all' }); setOpen(false); }} className="text-[#5E778C] hover:text-[#0B2A44] px-3 py-2.5 sm:px-2 sm:py-1">Clear</button>
                <button onClick={() => setOpen(false)} className="flex-1 sm:flex-none px-4 py-2.5 sm:px-3 sm:py-1 rounded-lg sm:rounded-md bg-[#0B6BB0] text-white font-semibold">Apply</button>
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
