'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { SuperAdmin } from '@/server/platform/contract';
import { call, errorMessage } from '../../_lib/api';
import { EMAIL_RE } from '../../_lib/format';
import { Modal } from '../../_components/Modal';
import { TempPasswordPanel } from '../../_components/SecretPanel';
import { Button, TextField } from '../../_components/ui';

/** Add a super admin (shows the temporary password once) or edit an existing one's name / e-mail. */
export function AdminDialog({ open, admin, onClose, onSaved }: { open: boolean; admin: SuperAdmin | null; onClose: () => void; onSaved: (a: SuperAdmin) => void }) {
  const isNew = !admin;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(admin?.name || '');
    setEmail(admin?.email || '');
    setSubmitted(false);
    setError('');
    setTemp(null);
  }, [open, admin]);

  const errs = { name: !name.trim() ? 'Enter a name.' : '', email: !EMAIL_RE.test(email.trim()) ? 'Enter a valid e-mail address.' : '' };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errs.name || errs.email) return;
    setBusy(true);
    setError('');
    try {
      const res = await call('saveSuperAdmin', { ...(admin ? { id: admin.id, status: admin.status } : {}), name: name.trim(), email: email.trim() });
      onSaved(res.user);
      if (res.temporaryPassword) setTemp({ email: res.user.email, password: res.temporaryPassword });
      else onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="sm"
      title={temp ? 'Super admin added' : isNew ? 'Add super admin' : `Edit ${admin!.name}`}
      description={temp ? undefined : isNew ? 'Super admins have full control over every company on the platform.' : undefined}
      footer={
        temp ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="sa-admin-form" loading={busy}>
              {isNew ? 'Add super admin' : 'Save'}
            </Button>
          </>
        )
      }
    >
      {temp ? (
        <TempPasswordPanel email={temp.email} password={temp.password} />
      ) : (
        <form id="sa-admin-form" onSubmit={submit} noValidate className="space-y-4">
          <TextField label="Name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} required error={submitted ? errs.name : ''} />
          <TextField label="E-mail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required error={submitted ? errs.email : ''} />
          {error && (
            <p role="alert" className="rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-3 py-2 text-[13.5px] text-[#912018]">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
