'use client';
import { useState, type FormEvent } from 'react';
import { call, errorMessage } from '../_lib/api';
import { Modal } from './Modal';
import { Button, TextField } from './ui';
import { useToast } from './Toast';

const MIN = 12;

export function ChangePasswordDialog({
  open,
  onClose,
  forced = false,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** The account still uses a temporary password: explain why the dialog opened by itself. */
  forced?: boolean;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError('');
    setTouched(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const nextErr = touched && next.length < MIN ? `Use at least ${MIN} characters.` : touched && next === current && next ? 'Choose a password different from the current one.' : '';
  const confirmErr = touched && confirm !== next ? 'Passwords do not match.' : '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!current || next.length < MIN || confirm !== next || next === current) return;
    setBusy(true);
    setError('');
    try {
      await call('saChangePassword', { currentPassword: current, newPassword: next });
      toast('Password changed.');
      onChanged?.();
      reset();
      onClose();
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
      size="sm"
      title="Change password"
      description={
        forced
          ? `You signed in with a temporary password. Choose your own password (at least ${MIN} characters) to continue.`
          : `Use at least ${MIN} characters. Other sessions may be signed out.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="sa-change-pw" loading={busy}>
            Update password
          </Button>
        </>
      }
    >
      <form id="sa-change-pw" onSubmit={submit} noValidate className="space-y-4">
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          error={touched && !current ? 'Enter your current password.' : ''}
        />
        <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required error={nextErr} hint={`At least ${MIN} characters.`} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required error={confirmErr} />
        {error && (
          <p role="alert" className="rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-3 py-2 text-[13.5px] text-[#912018]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
