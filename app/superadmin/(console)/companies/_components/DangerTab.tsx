'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import type { CompanyDetail } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { ConfirmDialog } from '../../../_components/Modal';
import { useToast } from '../../../_components/Toast';
import { Button, Card, TextAreaField, TextField } from '../../../_components/ui';

export function DangerTab({ company, onSaved }: { company: CompanyDetail; onSaved: (c: CompanyDetail) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [statusOpen, setStatusOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const suspended = company.status === 'Suspended';

  const close = () => {
    if (busy) return;
    setStatusOpen(false);
    setDeleteOpen(false);
    setReason('');
    setConfirmSlug('');
    setError('');
  };

  const changeStatus = async () => {
    setBusy(true);
    setError('');
    try {
      const next = suspended ? 'Active' : 'Suspended';
      const updated = await call('setCompanyStatus', { id: company.id, status: next, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onSaved(updated);
      setBusy(false);
      close();
      toast(next === 'Active' ? `${company.name} reactivated.` : `${company.name} suspended.`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await call('deleteCompany', { id: company.id, confirmSlug });
      toast(`${company.name} deleted.`);
      router.push('/superadmin/companies');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">{suspended ? 'Reactivate company' : 'Suspend company'}</h2>
          <p className="mt-1 text-[13.5px] text-[#6B6158]">
            {suspended
              ? 'Users will be able to sign in to the CRM again. No data was removed while suspended.'
              : 'All users are signed out and cannot sign in until the company is reactivated. Data is kept.'}
          </p>
        </div>
        <Button
          variant={suspended ? 'primary' : 'danger-outline'}
          icon={suspended ? <PlayCircle className="h-4 w-4" aria-hidden /> : <PauseCircle className="h-4 w-4" aria-hidden />}
          onClick={() => setStatusOpen(true)}
        >
          {suspended ? 'Reactivate' : 'Suspend'}
        </Button>
      </Card>

      <Card className="flex flex-col gap-4 border-[#F7C5BF] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-[#912018]">Delete company</h2>
          <p className="mt-1 text-[13.5px] text-[#6B6158]">Permanently removes the company, its users and its CRM data. This cannot be undone.</p>
        </div>
        <Button variant="danger" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDeleteOpen(true)}>
          Delete company
        </Button>
      </Card>

      <ConfirmDialog
        open={statusOpen}
        onClose={close}
        busy={busy}
        error={error}
        onConfirm={changeStatus}
        tone={suspended ? 'default' : 'danger'}
        title={suspended ? `Reactivate ${company.name}?` : `Suspend ${company.name}?`}
        confirmLabel={suspended ? 'Reactivate' : 'Suspend company'}
        description={suspended ? 'Users regain access immediately.' : 'Every user of this company loses access immediately.'}
      >
        <TextAreaField
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Recorded in the audit log."
          maxLength={500}
          data-autofocus
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        onClose={close}
        busy={busy}
        error={error}
        onConfirm={remove}
        tone="danger"
        title={`Delete ${company.name}?`}
        confirmLabel="Delete permanently"
        confirmDisabled={confirmSlug !== company.slug}
        description="This permanently deletes the company workspace, all of its users and data."
      >
        <TextField
          label={
            <>
              Type <span className="font-mono font-semibold text-[#912018]">{company.slug}</span> to confirm
            </>
          }
          value={confirmSlug}
          onChange={(e) => setConfirmSlug(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          className="[&_input]:font-mono"
          data-autofocus
        />
      </ConfirmDialog>
    </div>
  );
}
