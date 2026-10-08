'use client';
import { useState } from 'react';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { SuperAdmin } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtDate, fmtDateTime, initials } from '../../_lib/format';
import { useAdmin } from '../../_components/ConsoleShell';
import { ConfirmDialog, Modal } from '../../_components/Modal';
import { TempPasswordPanel } from '../../_components/SecretPanel';
import { useToast } from '../../_components/Toast';
import { Button, Card, EmptyState, ErrorBox, PageHeader, StatusBadge, Table, TableSkeleton, cx, td, th } from '../../_components/ui';
import { AdminDialog } from './AdminDialog';

type Pending = { kind: 'status' | 'reset' | 'delete'; admin: SuperAdmin } | null;

export function AdminsClient() {
  const me = useAdmin();
  const toast = useToast();
  const list = useResource(() => call('listSuperAdmins', {}), []);
  const [dialog, setDialog] = useState<{ admin: SuperAdmin | null } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  const upsert = (a: SuperAdmin) => {
    const all = list.data || [];
    list.setData(all.some((x) => x.id === a.id) ? all.map((x) => (x.id === a.id ? a : x)) : [...all, a]);
  };

  const closePending = () => {
    if (busy) return;
    setPending(null);
    setError('');
  };

  const confirm = async () => {
    if (!pending) return;
    const { admin: a, kind } = pending;
    setBusy(true);
    setError('');
    try {
      if (kind === 'status') {
        const status = a.status === 'Active' ? 'Disabled' : 'Active';
        const res = await call('saveSuperAdmin', { id: a.id, name: a.name, email: a.email, status });
        upsert(res.user);
        toast(`${a.name} ${status === 'Active' ? 'enabled' : 'disabled'}.`);
      } else if (kind === 'reset') {
        const res = await call('resetSuperAdminPassword', { id: a.id });
        setTemp({ email: a.email, password: res.temporaryPassword });
      } else {
        await call('deleteSuperAdmin', { id: a.id });
        list.setData((list.data || []).filter((x) => x.id !== a.id));
        toast(`${a.name} deleted.`);
      }
      setPending(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const p = pending;
  const dialogCopy = !p
    ? { title: '', label: '', desc: '', danger: false }
    : p.kind === 'delete'
      ? { title: `Delete ${p.admin.name}?`, label: 'Delete', desc: 'They lose access to the console immediately. This cannot be undone.', danger: true }
      : p.kind === 'reset'
        ? { title: `Reset ${p.admin.name}'s password?`, label: 'Reset password', desc: 'Their current password stops working and a temporary password is generated.', danger: false }
        : p.admin.status === 'Active'
          ? { title: `Disable ${p.admin.name}?`, label: 'Disable', desc: 'They are signed out and cannot sign in until re-enabled.', danger: true }
          : { title: `Enable ${p.admin.name}?`, label: 'Enable', desc: 'They will be able to sign in to the console again.', danger: false };

  const rows = list.data;
  return (
    <>
      <PageHeader
        title="Super admins"
        description="People with full access to this console."
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setDialog({ admin: null })}>
            Add super admin
          </Button>
        }
      />
      <Card>
        <ErrorBox message={list.error} onRetry={list.reload} className="m-4" />
        {!rows && list.loading ? (
          <TableSkeleton rows={3} cols={5} />
        ) : rows && rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title="No super admins" />
        ) : rows ? (
          <Table label="Super admins">
            <thead className="bg-[#FBF9F6]">
              <tr className="border-b border-[#EFE9E2]">
                <th scope="col" className={th}>Name</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}>Last login</th>
                <th scope="col" className={th}>Added</th>
                <th scope="col" className={cx(th, 'text-right')}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1ECE6]">
              {rows.map((a) => {
                const self = a.id === me?.id;
                return (
                  <tr key={a.id} className="hover:bg-[#FBF9F6]">
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#F4EEE7] text-[12.5px] font-semibold text-[#6B4F33]">
                          {initials(a.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium">
                            {a.name}
                            {self && <span className="ml-2 rounded bg-[#E8EDF2] px-1.5 py-0.5 text-[12px] font-medium text-[#1D2F3F]">You</span>}
                          </p>
                          <p className="text-[13px] text-[#7A6F64]">{a.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className={td}>
                      <StatusBadge status={a.status} />
                    </td>
                    <td className={cx(td, 'whitespace-nowrap text-[13.5px] text-[#5E554D]')}>{a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : 'Never'}</td>
                    <td className={cx(td, 'whitespace-nowrap text-[13.5px] text-[#5E554D]')}>{fmtDate(a.createdAt)}</td>
                    <td className={cx(td, 'whitespace-nowrap text-right')}>
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setDialog({ admin: a })} aria-label={`Edit ${a.name}`}>
                          Edit
                        </Button>
                        <Button variant="secondary" size="sm" icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />} onClick={() => setPending({ kind: 'reset', admin: a })} disabled={self} title={self ? 'Another super admin can reset your password' : undefined} aria-label={`Reset password for ${a.name}`}>
                          Reset password
                        </Button>
                        <Button variant={a.status === 'Active' ? 'danger-outline' : 'secondary'} size="sm" onClick={() => setPending({ kind: 'status', admin: a })} disabled={self} aria-label={`${a.status === 'Active' ? 'Disable' : 'Enable'} ${a.name}`}>
                          {a.status === 'Active' ? 'Disable' : 'Enable'}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-[#B42318] hover:bg-[#FEF3F2]" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => setPending({ kind: 'delete', admin: a })} disabled={self} aria-label={`Delete ${a.name}`}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : null}
      </Card>

      <AdminDialog
        open={Boolean(dialog)}
        admin={dialog?.admin ?? null}
        onClose={() => setDialog(null)}
        onSaved={(a) => {
          upsert(a);
          if (dialog?.admin) toast(`${a.name} saved.`);
        }}
      />
      <ConfirmDialog
        open={Boolean(pending)}
        onClose={closePending}
        busy={busy}
        error={error}
        onConfirm={confirm}
        tone={dialogCopy.danger ? 'danger' : 'default'}
        title={dialogCopy.title}
        confirmLabel={dialogCopy.label}
        description={dialogCopy.desc}
      />
      <Modal open={Boolean(temp)} onClose={() => setTemp(null)} title="Temporary password" size="sm" footer={<Button onClick={() => setTemp(null)}>Done</Button>}>
        {temp && <TempPasswordPanel email={temp.email} password={temp.password} />}
      </Modal>
    </>
  );
}
