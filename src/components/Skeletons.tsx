/**
 * Loading skeletons: grey placeholders shaped like the screen that is on its way, so the layout does not
 * jump when the data arrives. The pulse is skipped for people who ask for reduced motion, and screen
 * readers hear one "Loading …" message instead of the shapes.
 */
import React from 'react';
import type { ViewId } from '../core/views';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/** One grey block. Size it with classes (h-4 w-32, rounded-full…). */
export const Skeleton: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <div aria-hidden style={style} className={cx('motion-safe:animate-pulse rounded-md bg-[#E9E2D8]', className)} />
);

/** Announces the loading state once; the shapes inside are hidden from screen readers. */
const Busy: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({ label, className, children }) => (
  <div role="status" aria-live="polite" aria-busy="true" className={className}>
    <span className="sr-only">{label}</span>
    {children}
  </div>
);

const Panel: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <div aria-hidden className={cx('bg-white rounded-2xl border border-[#D2C9BF] shadow-xs p-5', className)}>{children}</div>
);

/** Page title + subtitle, with an action button on the right. */
const Heading: React.FC<{ action?: boolean }> = ({ action = true }) => (
  <div className="flex items-end justify-between gap-3">
    <div className="space-y-2">
      <Skeleton className="h-6 w-52" />
      <Skeleton className="h-3 w-72 max-w-[60vw]" />
    </div>
    {action && <Skeleton className="h-9 w-28 rounded-lg hidden sm:block" />}
  </div>
);

const Kpis: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
    {Array.from({ length: count }, (_, i) => (
      <Panel key={i} className="p-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-16 mt-3" />
        <Skeleton className="h-2.5 w-24 mt-3" />
      </Panel>
    ))}
  </div>
);

/** Rows of a list or table: avatar, two lines, and a badge. */
export const ListSkeleton: React.FC<{ rows?: number; label?: string; className?: string }> = ({ rows = 5, label = 'Loading…', className }) => (
  <Busy label={label} className={cx('divide-y divide-[#ECE8E1]', className)}>
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-3 py-3">
        <Skeleton className="h-9 w-9 rounded-full flex-none" />
        <div className="flex-1 min-w-0 space-y-2">
          <Skeleton className={cx('h-3.5', i % 3 === 0 ? 'w-2/5' : i % 3 === 1 ? 'w-1/3' : 'w-1/2')} />
          <Skeleton className={cx('h-2.5', i % 2 ? 'w-3/5' : 'w-2/3')} />
        </div>
        <Skeleton className="h-5 w-16 rounded-full flex-none hidden sm:block" />
      </div>
    ))}
  </Busy>
);

/** A table: toolbar, header row and body rows. */
export const TableSkeleton: React.FC<{ rows?: number; cols?: number; label?: string; toolbar?: boolean }> = ({ rows = 8, cols = 5, label = 'Loading…', toolbar = true }) => (
  <Busy label={label}>
    <Panel className="p-0 overflow-hidden">
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2 p-4 border-b border-[#ECE8E1]">
          <Skeleton className="h-9 w-full sm:w-64 rounded-lg" />
          <Skeleton className="h-9 w-28 rounded-lg hidden sm:block" />
          <Skeleton className="h-9 w-28 rounded-lg hidden md:block" />
        </div>
      )}
      <div className="px-4 py-3 grid gap-4 bg-[#FAF7F2]" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
        {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className="h-2.5 w-16" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="px-4 py-3.5 grid gap-4 items-center border-t border-[#ECE8E1]" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <Skeleton className="h-8 w-8 rounded-full flex-none" />
            <div className="space-y-1.5 flex-1 min-w-0">
              <Skeleton className={cx('h-3', r % 2 ? 'w-3/4' : 'w-2/3')} />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          </div>
          {Array.from({ length: cols - 1 }, (_, c) => <Skeleton key={c} className={cx('h-3', c === 0 ? 'w-20 rounded-full' : c % 2 ? 'w-14' : 'w-3/4')} />)}
        </div>
      ))}
    </Panel>
  </Busy>
);

/** Bars of a chart. Heights are fixed so the server and browser draw the same thing. */
const CHART_BARS = [45, 70, 55, 85, 60, 92, 50, 75, 40, 66, 80, 58];
const ChartPanel: React.FC<{ className?: string }> = ({ className }) => (
  <Panel className={className}>
    <Skeleton className="h-4 w-40" />
    <Skeleton className="h-2.5 w-56 mt-2" />
    <div className="mt-6 h-44 flex items-end gap-2">
      {CHART_BARS.map((h, i) => <Skeleton key={i} className="flex-1 rounded-t-md rounded-b-none" style={{ height: `${h}%` }} />)}
    </div>
  </Panel>
);

/** Kanban board: columns of cards. */
const Board: React.FC = () => (
  <div className="flex gap-4 overflow-hidden">
    {[4, 3, 5, 2, 3].map((cards, c) => (
      <div key={c} className="w-72 flex-none rounded-2xl bg-[#ECE6DE]/60 p-3 space-y-3">
        <div className="flex items-center justify-between"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-5 w-7 rounded-full" /></div>
        {Array.from({ length: cards }, (_, i) => (
          <Panel key={i} className="p-3.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2 mt-2" />
            <div className="flex items-center justify-between mt-4"><Skeleton className="h-5 w-16 rounded-full" /><Skeleton className="h-6 w-6 rounded-full" /></div>
          </Panel>
        ))}
      </div>
    ))}
  </div>
);

const CardGrid: React.FC<{ count?: number }> = ({ count = 6 }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
    {Array.from({ length: count }, (_, i) => (
      <Panel key={i}>
        <div className="flex items-center justify-between"><Skeleton className="h-5 w-20 rounded-full" /><Skeleton className="h-5 w-14" /></div>
        <Skeleton className="h-4 w-1/2 mt-4" />
        <div className="mt-3 space-y-2 rounded-lg bg-[#FAF7F2] p-3">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-11/12" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
        <div className="flex items-center justify-between mt-4"><Skeleton className="h-2.5 w-24" /><Skeleton className="h-7 w-24 rounded-lg" /></div>
      </Panel>
    ))}
  </div>
);

/** WhatsApp: conversation list on the left, messages on the right. */
const Split: React.FC = () => (
  <div className="grid grid-cols-1 md:grid-cols-[20rem_1fr] gap-4 h-[calc(100vh-12rem)] min-h-[420px]">
    <Panel className="p-3 overflow-hidden">
      <Skeleton className="h-9 w-full rounded-lg" />
      <ListSkeleton rows={7} className="mt-1" />
    </Panel>
    <Panel className="hidden md:flex flex-col">
      <div className="flex items-center gap-3 pb-4 border-b border-[#ECE8E1]"><Skeleton className="h-10 w-10 rounded-full" /><div className="space-y-2"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-2.5 w-24" /></div></div>
      <ChatSkeleton className="flex-1 py-4" />
      <Skeleton className="h-11 w-full rounded-xl" />
    </Panel>
  </div>
);

/** Message bubbles, alternating sides. */
export const ChatSkeleton: React.FC<{ className?: string; label?: string }> = ({ className, label = 'Loading conversation…' }) => (
  <Busy label={label} className={cx('space-y-3', className)}>
    {['w-3/5', 'w-2/5', 'w-1/2', 'w-1/3', 'w-3/5'].map((w, i) => (
      <div key={i} className={cx('flex', i % 2 ? 'justify-end' : 'justify-start')}>
        <Skeleton className={cx('h-10 rounded-2xl', w, i % 2 ? 'rounded-br-sm bg-[#E3D6C4]' : 'rounded-bl-sm')} />
      </div>
    ))}
  </Busy>
);

/** Settings: section menu on the left, form on the right. */
const SettingsShape: React.FC = () => (
  <div className="grid grid-cols-1 lg:grid-cols-[15rem_1fr] gap-5">
    <Panel className="p-3 space-y-2 hidden lg:block">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}
    </Panel>
    <Panel className="space-y-5">
      <Skeleton className="h-5 w-44" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="space-y-2 max-w-md"><Skeleton className="h-3 w-28" /><Skeleton className="h-10 w-full rounded-lg" /></div>
      ))}
      <Skeleton className="h-9 w-32 rounded-lg" />
    </Panel>
  </div>
);

export type PageSkeletonVariant = 'dashboard' | 'table' | 'board' | 'cards' | 'split' | 'settings' | 'list';

/** Which skeleton each CRM screen gets. */
export const VIEW_SKELETON: Record<ViewId, PageSkeletonVariant> = {
  dashboard: 'dashboard', reports: 'dashboard',
  leads: 'table', inventory: 'table', calls: 'table', audit: 'table', followups: 'table', segments: 'table',
  kanban: 'board', templates: 'cards', documents: 'cards', chat360: 'split', settings: 'settings', tasks: 'list',
};

/** A whole screen while it loads. */
export const PageSkeleton: React.FC<{ variant?: PageSkeletonVariant; label?: string }> = ({ variant = 'table', label = 'Loading…' }) => (
  <Busy label={label} className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
    <Heading action={variant !== 'dashboard'} />
    {variant === 'dashboard' && (
      <>
        <Kpis />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartPanel className="lg:col-span-2" />
          <Panel><Skeleton className="h-4 w-32" /><ListSkeleton rows={5} className="mt-2" /></Panel>
        </div>
      </>
    )}
    {variant === 'table' && (<><Kpis /><TableSkeleton toolbar /></>)}
    {variant === 'board' && <Board />}
    {variant === 'cards' && (<><div className="flex gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8 w-20 rounded-lg" />)}</div><CardGrid /></>)}
    {variant === 'split' && <Split />}
    {variant === 'settings' && <SettingsShape />}
    {variant === 'list' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel className="lg:col-span-2"><Skeleton className="h-4 w-28" /><ListSkeleton rows={6} className="mt-2" /></Panel>
        <Panel><Skeleton className="h-4 w-24" /><ListSkeleton rows={4} className="mt-2" /></Panel>
      </div>
    )}
  </Busy>
);
