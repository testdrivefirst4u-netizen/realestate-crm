/** Chosen campaigns, ad sets or ads in columns, figure by figure, with the best of each marked. */
import React from 'react';
import { Check } from 'lucide-react';
import type { MetaAdsRow } from '../../core/api';
import { Modal, cx } from '../../components/ui';
import { DELIVERY, ChangeText, metricText, words } from './adsCells';
import { SIDE_BY_SIDE, bestIndexes, metricsComparable } from './adsCompare';

export const AdsSideBySide: React.FC<{ rows: MetaAdsRow[]; before: Map<string, MetaAdsRow> | null; levelLabel: string; period: string; earlier: string; onClose: () => void }> = ({ rows, before, levelLabel, period, earlier, onClose }) => {
  const lines = SIDE_BY_SIDE.filter((m) => rows.some((r) => m.get(r) !== null));
  return (
    <Modal open onClose={onClose} width="lg" title={`Compare ${rows.length} ${levelLabel.toLowerCase()}`} subtitle={before && earlier ? `${period}, with ${earlier} underneath` : period}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs text-[#1C2B33]">
          <thead>
            <tr className="border-b border-[#DADDE1] align-top">
              <th className="sticky left-0 z-10 min-w-[120px] bg-white px-2 py-2 text-left text-[11px] font-semibold text-[#44505C]">Figure</th>
              {rows.map((r) => {
                const d = DELIVERY[r.delivery] || { label: words(r.delivery), dot: 'bg-[#A7B4C0]' };
                return (
                  <th key={r.id} className="min-w-[150px] px-2 py-2 text-right font-normal">
                    {r.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.thumbnail} alt="" loading="lazy" className="mb-1.5 ml-auto h-16 w-16 rounded bg-[#F5F6F7] object-cover" />
                    )}
                    <span className="block break-words text-[13px] font-semibold">{r.name}</span>
                    <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-[#5E6C7B]"><span className={cx('h-2 w-2 rounded-full', d.dot)} aria-hidden="true" />{d.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EBEDF0]">
            {lines.map((m) => {
              const best = metricsComparable(m.id, rows) ? bestIndexes(rows.map((r) => m.get(r)), m.better) : [];
              return (
                <tr key={m.id}>
                  <th scope="row" className="sticky left-0 z-10 bg-white px-2 py-2 text-left text-[11px] font-semibold text-[#44505C]">{m.label}</th>
                  {rows.map((r, i) => {
                    const top = best.includes(i);
                    const was = before?.get(r.id);
                    const earlierValue = was ? m.get(was) : null;
                    return (
                      <td key={r.id} className={cx('px-2 py-2 text-right tabular-nums', top && 'bg-[#EDF8F1]')}>
                        <span className={cx('inline-flex items-center justify-end gap-1', top && 'font-bold text-[#067647]')}>
                          {top && <Check size={12} aria-label="Best" />}{metricText(m, m.get(r), r.currency)}
                        </span>
                        {before && <span className="mt-0.5 flex items-center justify-end gap-1.5 text-[10.5px] text-[#5E6C7B]"><span>{metricText(m, earlierValue, r.currency)}</span><ChangeText now={m.get(r)} before={earlierValue} better={m.better} /></span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-[#5E6C7B]">A tick marks the best figure in a row. Spend and frequency get none, because more is not better or worse by itself. Results and cost per result are only marked when these share the same kind of result. Small numbers can be down to chance.</p>
    </Modal>
  );
};
