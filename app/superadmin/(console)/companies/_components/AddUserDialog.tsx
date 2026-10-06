'use client';
import { useState, type FormEvent } from 'react';
import type { CompanyDetail, CompanyUser } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { EMAIL_RE } from '../../../_lib/format';
import { Modal } from '../../../_components/Modal';
import { TempPasswordPanel } from '../../../_components/SecretPanel';
import { Button, SelectField, TextField } from '../../../_components/ui';

const ROLES: CompanyUser['role'][] = ['Admin', 'Manager', 'RM', 'Developer'];

export function AddUserDialog({ open, onClose, company, onAdded }: { open: boolean; onClose: () => void; company: CompanyDetail; onAdded: (u: CompanyUser) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CompanyUser['role']>('RM');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<{ email: string; password: string } | null>(null);

  const close = () => {
    if (busy) return;
    setName('');
    setEmail('');
    setRole('RM');
    setError('');
    setSubmitted(false);
    setResult(null);
    onClose();
  };

  const errs = { name: !name.trim() ? 'Enter a name.' : '', email: !EMAIL_RE.test(email.trim()) ? 'Enter a valid e-mail address.' : '' };
  const atLimit = company.maxUsers > 0 && company.activeUsers >= company.maxUsers;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errs.name || errs.email) return;
    setBusy(true);
    setError('');
    try {
      const res = await call('createCompanyUser', { companyId: company.id, name: name.trim(), email: email.trim(), role });
      onAdded(res.user);
      setResult({ email: res.user.email, password: res.temporaryPassword });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      busy={busy}
      title={result ? 'User added' : `Add user to ${company.name}`}
      description={result ? undefined : 'They will be asked to sign in with a temporary password.'}
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="sa-add-user" loading={busy}>
              Add user
            </Button>
          </>
        )
      }
    >
      {result ? (
        <TempPasswordPanel email={result.email} password={result.password} />
      ) : (
        <form id="sa-add-user" onSubmit={submit} noValidate className="space-y-4">
          {atLimit && (
            <p className="rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-3 py-2 text-[13.5px] text-[#93370D]">
              This company has reached its limit of {company.maxUsers} active users. Raise the limit on the Overview tab first, or the server will refuse the new user.
            </p>
          )}
          <TextField label="Name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} required error={submitted ? errs.name : ''} />
          <TextField label="E-mail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required error={submitted ? errs.email : ''} hint="Must be unique across the platform." />
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as CompanyUser['role'])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </SelectField>
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
