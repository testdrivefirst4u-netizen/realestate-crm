/**
 * Duplicates — leads that share a phone number (last 10 digits), or an e-mail when there is no phone.
 * Per group the admin picks the lead to keep (default: the one furthest in the pipeline, then the oldest) and merges
 * the rest into it on the server (see server/modules/leadMerge.ts). Merged leads go to Archived Leads.
 */
import React, { useMemo, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { Lead } from '../../types/crm';
import { F, FUNNEL_STAGES, STAGES } from '../../core/config';
import { countedLeads, enquiryDate, followupCount } from '../../core/analytics';
import { formatDateTime } from '../../core/dates';
import { formatPhone, last10 } from '../../core/phone';
import { Button, EmptyState, Modal, StageBadge } from '../../components/ui';

export interface DuplicateGroup {
  key: string;
  /** 'phone' or 'email' */
  by: 'phone' | 'email';
  leads: Lead[];
}

/** Rank for the default "keep" choice: further in the pipeline first, then more follow-ups, then oldest. */
function keepRank(l: Lead): number {
  const stage = String(l[F.STAGE] || '');
  const i = FUNNEL_STAGES.indexOf(stage);
  return (i < 0 ? 0 : i + 1) * 1000 + Math.min(followupCount(l), 999);
}

/** Groups of 2+ leads that are the same person (Trash and deleted leads are left out). */
export function findDuplicateGroups(leads: Lead[]): DuplicateGroup[] {
  const live = countedLeads(leads).filter((l) => String(l[F.STAGE] || '') !== STAGES.TRASH);
  const byPhone = new Map<string, Lead[]>();
  const byEmail = new Map<string, Lead[]>();
  for (const l of live) {
    const p = last10(String(l[F.PHONE] || ''));
    if (p.length === 10) (byPhone.get(p) || byPhone.set(p, []).get(p)!).push(l);
    else {
      const e = String(l[F.EMAIL] || '').trim().toLowerCase();
      if (e && e.includes('@')) (byEmail.get(e) || byEmail.set(e, []).get(e)!).push(l);
    }
  }
  const time = (l: Lead) => enquiryDate(l)?.getTime() ?? Infinity;
  const sortGroup = (ls: Lead[]) => [...ls].sort((a, b) => keepRank(b) - keepRank(a) || time(a) - time(b));
  const out: DuplicateGroup[] = [];
  for (const [key, ls] of byPhone) if (ls.length > 1) out.push({ key, by: 'phone', leads: sortGroup(ls) });
  for (const [key, ls] of byEmail) if (ls.length > 1) out.push({ key, by: 'email', leads: sortGroup(ls) });
  return out.sort((a, b) => b.leads.length - a.leads.length || a.key.localeCompare(b.key));
}

export const DuplicatesModal: React.FC<{
  open: boolean;
  onClose: () => void;
  leads: Lead[];
  onMerge: (keepId: string, mergeIds: string[]) => Promise<boolean>;
  onOpenLead: (id: string) => void;
}> = ({ open, onClose, leads, onMerge, onOpenLead }) => {
  const groups = useMemo(() => findDuplicateGroups(leads), [leads]);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const merge = async (g: DuplicateGroup) => {
    const keepId = keep[g.key] || String(g.leads[0][F.ID]);
    const others = g.leads.map((l) => String(l[F.ID])).filter((id) => id !== keepId);
    setBusy(g.key);
    await onMerge(keepId, others);
    setBusy(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="Duplicate leads"
      subtitle={groups.length ? `${groups.length} ${groups.length === 1 ? 'person appears' : 'people appear'} more than once (same phone number, or same e-mail when there is no phone).` : undefined}
    >
      {!groups.length ? (
        <EmptyState icon={<GitMerge size={22} />} title="No duplicates" description="Every phone number and e-mail appears on one lead only." />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-[#5E778C] leading-relaxed">
            Choose the lead to keep and press Merge. The kept lead keeps its ID and values; empty fields are filled from the others, all remarks are combined in date order, and calls, chats and documents move over. The other leads go to Archived Leads.
          </p>
          {groups.map((g) => {
            const keepId = keep[g.key] || String(g.leads[0][F.ID]);
            return (
              <section key={g.key} className="rounded-xl border border-[#D3E3F0] bg-white">
                <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#E3EDF5]">
                  <span className="text-sm font-bold text-[#0B2A44]">
                    {g.by === 'phone' ? formatPhone(g.key) : g.key}
                    <span className="ml-2 text-xs font-normal text-[#7E93A6]">{g.leads.length} leads</span>
                  </span>
                  <Button variant="primary" size="sm" icon={<GitMerge size={13} />} loading={busy === g.key} disabled={!!busy && busy !== g.key} onClick={() => void merge(g)}>
                    Merge into {keepId}
                  </Button>
                </header>
                <fieldset className="divide-y divide-[#E3EDF5]">
                  <legend className="sr-only">Lead to keep</legend>
                  {g.leads.map((l) => {
                    const id = String(l[F.ID]);
                    return (
                      <label key={id} className="flex flex-wrap items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[#F7FAFD]">
                        <input type="radio" name={`keep-${g.key}`} className="accent-[#0B6BB0] w-4 h-4" checked={keepId === id} onChange={() => setKeep((k) => ({ ...k, [g.key]: id }))} />
                        <span className="min-w-[90px] font-semibold text-[#0B6BB0]">{id}</span>
                        <span className="flex-1 min-w-[140px]">
                          <span className="block text-sm font-semibold text-[#0B2A44]">{l[F.NAME] || 'Unnamed'}</span>
                          <span className="block text-[11px] text-[#7E93A6]">{formatDateTime(enquiryDate(l), '—')} · {l[F.SOURCE] || 'No source'} · {followupCount(l)} remark{followupCount(l) === 1 ? '' : 's'}{l[F.RM] ? ` · ${l[F.RM]}` : ''}</span>
                        </span>
                        <StageBadge stage={String(l[F.STAGE] || '')} />
                        <button type="button" onClick={(e) => { e.preventDefault(); onOpenLead(id); }} className="text-xs font-semibold text-[#0B6BB0] hover:underline min-h-[32px]">Open</button>
                      </label>
                    );
                  })}
                </fieldset>
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
};
