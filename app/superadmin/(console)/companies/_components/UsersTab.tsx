'use client';
import { useState } from 'react';
import { KeyRound, UserPlus, Users } from 'lucide-react';
import type { CompanyDetail, CompanyUser } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { fmtDateTime, fmtSeats } from '../../../_lib/format';
import { ConfirmDialog, Modal } from '../../../_components/Modal';
import { TempPasswordPanel } from '../../../_components/SecretPanel';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, EmptyState, Pill, StatusBadge, Table, cx, td, th } from '../../../_components/ui';
import { AddUserDialog } from './AddUserDialog';

type Pending = { kind: 'reset' | 'status'; user: CompanyUser } | null;

export function UsersTab({ company, onChange }: { company: CompanyDetail; onChange: (users: CompanyUser[]) => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const users = company.users || [];

  const closePending = () => {
    if (busy) return;
    setPending(null);
    setError('');
  };

  const confirm = async () => {
    if (!pending) return;
    const { user } = pending;
    setBusy(true);
    setError('');
    try {
      if (pending.kind === 'reset') {
        const res = await call('resetCompanyUserPassword', { companyId: company.id, userId: user.id });
        setPending(null);
        setTemp({ email: user.email, password: res.temporaryPassword });
      } else {
        const status = user.status === 'Active' ? 'Disabled' : 'Active';
        const updated = await call('setCompanyUserStatus', { companyId: company.id, userId: user.id, status });
        onChange(users.map((u) => (u.id === updated.id ? updated : u)));
        setPending(null);
        toast(`${user.name} ${status === 'Active' ? 'enabled' : 'disabled'}.`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enabling = pending?.kind === 'status' && pending.user.status !== 'Active';

  return (
    <Card>
      <CardHeader
        title="Users"
        description={`${fmtSeats(company.activeUsers, company.maxUsers)} active seats used`}
        actions={
          <Button size="sm" icon={<UserPlus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>
            Add user
          </Button>
        }
      />
      {users.length === 0 ? (
        <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No users yet" description="Add the first user to this company." />
      ) : (
        <Table label={`Users of ${company.name}`}>
          <thead className="bg-[#FBF9F6]">
            <tr className="border-b border-[#EFE9E2]">
              <th scope="col" className={th}>Name</th>
              <th scope="col" className={th}>E-mail</th>
              <th scope="col" className={th}>Role</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Last login</th>
              <th scope="col" className={cx(th, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1ECE6]">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-[#FBF9F6]">
                <td className={cx(td, 'font-medium')}>{u.name}</td>
                <td className={cx(td, 'text-[13.5px]')}>{u.email}</td>
                <td className={td}>
                  <Pill>{u.role}</Pill>
                </td>
                <td className={td}>
                  <StatusBadge status={u.status} />
                </td>
                <td className={cx(td, 'whitespace-nowrap text-[13.5px] text-[#5E554D]')}>{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                <td className={cx(td, 'whitespace-nowrap text-right')}>
                  <div className="inline-flex gap-1.5">
                    <Button variant="secondary" size="sm" icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />} onClick={() => setPending({ kind: 'reset', user: u })} aria-label={`Reset password for ${u.name}`}>
                      Reset password
                    </Button>
                    <Button
                      variant={u.status === 'Active' ? 'danger-outline' : 'secondary'}
                      size="sm"
                      onClick={() => setPending({ kind: 'status', user: u })}
                      aria-label={`${u.status === 'Active' ? 'Disable' : 'Enable'} ${u.name}`}
                    >
                      {u.status === 'Active' ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <AddUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        company={company}
        onAdded={(u) => {
          onChange([...users, u]);
          toast(`${u.name} added.`);
        }}
      />

      <ConfirmDialog
        open={Boolean(pending)}
        onClose={closePending}
        busy={busy}
        error={error}
        onConfirm={confirm}
        tone={pending?.kind === 'status' && !enabling ? 'danger' : 'default'}
        title={pending?.kind === 'reset' ? 'Reset password?' : enabling ? 'Enable user?' : 'Disable user?'}
        confirmLabel={pending?.kind === 'reset' ? 'Reset password' : enabling ? 'Enable' : 'Disable'}
        description={
          pending?.kind === 'reset'
            ? `${pending.user.name}'s current password stops working and a new temporary password is generated.`
            : enabling
              ? `${pending?.user.name} will be able to sign in again.`
              : `${pending?.user.name} will be signed out and unable to sign in until re-enabled.`
        }
      />

      <Modal open={Boolean(temp)} onClose={() => setTemp(null)} title="Temporary password" size="sm" footer={<Button onClick={() => setTemp(null)}>Done</Button>}>
        {temp && <TempPasswordPanel email={temp.email} password={temp.password} />}
      </Modal>
    </Card>
  );
}
