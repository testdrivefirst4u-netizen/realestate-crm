'use client';
import { useRef, type KeyboardEvent } from 'react';
import { cx, focusRing } from '../../../_components/ui';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  danger?: boolean;
}

/** WAI-ARIA tablist with arrow-key / Home / End navigation (automatic activation). */
export function Tabs<T extends string>({ tabs, value, onChange, idPrefix }: { tabs: TabDef<T>[]; value: T; onChange: (v: T) => void; idPrefix: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label="Company sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-[#E4DCD2] px-1">
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              '-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3.5 py-2.5 text-[14px] font-medium transition-colors',
              selected
                ? t.danger
                  ? 'border-[#B42318] text-[#912018]'
                  : 'border-[#A9825A] text-[#14202B]'
                : 'border-transparent text-[#6B6158] hover:border-[#D9D0C5] hover:text-[#1D2F3F]',
              focusRing,
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
