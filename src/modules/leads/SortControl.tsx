/**
 * SortControl — compact "sort by + direction" control for the Enquiry Status
 * board and the Follow-up Schedule (All Leads sorts from its table headers).
 *
 * Picking a new key starts it in its natural direction (`defaultSortAsc`);
 * the arrow button reverses the current one. `usePersistentSort` remembers the
 * choice per view in this browser.
 */
import React, { useCallback, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Button, Select, cx } from '../../components/ui';
import { LeadSortKey, SORT_OPTIONS, SortOption, SortPref, defaultSortAsc, loadSortPref, saveSortPref, sortDirectionLabel } from './sorting';

export interface SortControlProps {
  sortKey: LeadSortKey;
  asc: boolean;
  onChange: (key: LeadSortKey, asc: boolean) => void;
  /** Keys offered in the menu (default: every key). */
  options?: ReadonlyArray<SortOption>;
  className?: string;
}

export const SortControl: React.FC<SortControlProps> = ({ sortKey, asc, onChange, options = SORT_OPTIONS, className }) => {
  const direction = sortDirectionLabel(sortKey, asc);
  return (
    <div className={cx('inline-flex items-stretch', className)} role="group" aria-label="Sort order">
      <div className="relative flex">
        <ArrowUpDown size={13} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A9825A] pointer-events-none z-20" />
        <Select
          value={sortKey}
          onChange={(e) => {
            const key = e.target.value as LeadSortKey;
            onChange(key, defaultSortAsc(key));
          }}
          options={options.map((o) => ({ value: o.key, label: o.label }))}
          className="!w-auto pl-8 rounded-r-none relative focus:z-10"
          aria-label="Sort by"
          title="Sort by"
        />
      </div>
      <Button
        type="button"
        variant="secondary"
        onClick={() => onChange(sortKey, !asc)}
        icon={asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
        className="!px-2.5 rounded-l-none -ml-px"
        title={`${direction} — click to reverse`}
        aria-label={`${direction}. Reverse the sort order`}
      />
    </div>
  );
};

/** Sort state remembered in localStorage under `storageKey` (falls back silently when storage is unavailable). */
export function usePersistentSort(storageKey: string, fallback: SortPref, allowed?: readonly LeadSortKey[]): [SortPref, (key: LeadSortKey, asc: boolean) => void] {
  const [pref, setPref] = useState<SortPref>(() => loadSortPref(storageKey, fallback, allowed));
  const update = useCallback(
    (key: LeadSortKey, asc: boolean) => {
      const next: SortPref = { key, asc };
      setPref(next);
      saveSortPref(storageKey, next);
    },
    [storageKey]
  );
  return [pref, update];
}
