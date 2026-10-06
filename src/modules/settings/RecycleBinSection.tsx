import React, { useMemo, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { formatRelative } from '../../core/dates';
import { formatPhone } from '../../core/phone';
import { Badge, Button, Card, ConfirmDialog, EmptyState } from '../../components/ui';
import { CanFn } from './types';

export interface RecycleBinSectionProps {
  trashedLeads: Lead[];
  can: CanFn;
  onRestoreLead: (id: string) => Promise<boolean>;
  onPermanentlyDeleteLead: (id: string) => Promise<boolean>;
}

const PAGE = 50;

export const RecycleBinSection: React.FC<RecycleBinSectionProps> = ({ trashedLeads, can, onRestoreLead, onPermanentlyDeleteLead }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const canRestore = can('leads.trash') || can('leads.edit');
  const canDelete = can('leads.delete');

  const sorted = useMemo(
    () => [...trashedLeads].sort((a, b) => String(b[F.UPDATED_AT] || '').localeCompare(String(a[F.UPDATED_AT] || ''))),
    [trashedLeads]
  );
  const visible = sorted.slice(0, limit);

  const restore = async (lead: Lead) => {
    setBusyId(lead[F.ID]);
    await onRestoreLead(lead[F.ID]);
    setBusyId(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget[F.ID]);
    await onPermanentlyDeleteLead(deleteTarget[F.ID]);
    setBusyId(null);
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-5">
      <Card title={`Recycle bin (${trashedLeads.length})`} subtitle="Trashed enquiries are hidden from every list and report. Restore puts them back as New; permanent deletion moves the record to the archive.">
        {sorted.length === 0 ? (
          <EmptyState icon={<Trash2 size={22} />} title="The recycle bin is empty" description="Enquiries you move to Trash from the lead drawer will appear here." />
        ) : (
          <div className="space-y-2">
            {visible.map((lead) => {
              const id = lead[F.ID];
              return (
                <div key={id} className="p-3 bg-[#F4F0EB] rounded-xl border border-[#D2C9BF] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#1D2F3F]">{lead[F.NAME] || 'Unnamed enquiry'}</span>
                      <span className="font-mono text-[#9E948D]">{id}</span>
                      {lead[F.UNIT_TYPE] && <Badge tone="muted">{lead[F.UNIT_TYPE]}</Badge>}
                    </div>
                    <div className="text-[11px] text-[#6B5F57] mt-0.5">
                      {formatPhone(lead[F.PHONE]) || 'No phone'}{lead[F.RM] ? ` · RM ${lead[F.RM]}` : ''}{lead[F.UPDATED_AT] ? ` · Trashed ${formatRelative(lead[F.UPDATED_AT])}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {canRestore && <Button variant="gold" size="xs" onClick={() => restore(lead)} loading={busyId === id} icon={<RotateCcw size={12} />}>Restore</Button>}
                    {canDelete && <Button variant="danger" size="xs" onClick={() => setDeleteTarget(lead)} disabled={busyId === id} icon={<Trash2 size={12} />}>Delete permanently</Button>}
                  </div>
                </div>
              );
            })}
            {sorted.length > visible.length && (
              <div className="text-center pt-1">
                <Button variant="secondary" size="xs" onClick={() => setLimit((n) => n + PAGE)}>Show more ({sorted.length - visible.length} remaining)</Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete permanently?"
        danger
        confirmLabel="Delete permanently"
        loading={!!deleteTarget && busyId === deleteTarget[F.ID]}
        message={<>“{deleteTarget?.[F.NAME]}” ({deleteTarget?.[F.ID]}) will be removed from the Enquiry Log and moved to the archive. It will no longer appear anywhere in the CRM.</>}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
