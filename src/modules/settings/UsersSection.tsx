import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, Copy, Eye, EyeOff, KeyRound, Laptop, LogOut, Pencil, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { UserAccount, UserRole } from '../../types/crm';
import { api, type DeviceSession } from '../../core/api';
import { DeviceRows } from './DevicesCard';
import { formatDateTime, formatRelative } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { ROLE_OPTIONS, assignableRoles, can, normalizeRole, roleLabel } from '../../core/rbac';
import { Avatar, useAvatarPicker } from '../../components/Avatar';
import { isPlanLimitMessage, planUsage, useCompany } from '../../core/tenant';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, InlineNotice, LoadingState, Modal, Select, inputCls } from '../../components/ui';

type Visibility = 'own' | 'own_unassigned' | 'all';
const VISIBILITY_OPTIONS: Array<{ value: Visibility; label: string }> = [
  { value: 'own_unassigned', label: 'Own leads + unassigned leads (recommended)' },
  { value: 'own', label: 'Only their own leads' },
  { value: 'all', label: 'All leads (no restriction)' },
];

/** Which leads RMs can see. Admins and Managers always see every lead; the server enforces this everywhere. */
function LeadVisibilityCard() {
  const [value, setValue] = useState<Visibility | ''>('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.settings
      .get()
      .then((s: any) => setValue((s.rmLeadVisibility as Visibility) || 'own_unassigned'))
      .catch(() => setValue('own_unassigned'));
  }, []);
  const save = async (v: Visibility) => {
    const prev = value;
    setValue(v);
    setSaving(true);
    try {
      await api.settings.update({ rmLeadVisibility: v } as any);
      toast('Lead visibility updated — RMs see the change on their next sync', 'success');
    } catch (e) {
      setValue(prev);
      toast(toAppError(e).userMessage, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Lead visibility for RMs" subtitle="Admins and Sales Managers always see every lead. RMs see only what you choose here — including their tasks, calls, WhatsApp threads, files and notifications.">
      <Field label="RMs can see">
        <Select value={value} disabled={!value || saving} onChange={(e) => save(e.target.value as Visibility)} options={VISIBILITY_OPTIONS} />
      </Field>
      <p className="mt-2 text-xs text-[#5E778C]">Earlier follow-up remarks are append-only for RMs: they can add new remarks, and only managers can correct or remove old ones.</p>
    </Card>
  );
}

export interface UsersSectionProps {
  users: UserAccount[];
  currentUser: UserAccount | null;
  onRefreshAll: () => void;
  /**
   * Pass `engine.updateProfile`: when an admin changes their OWN photo here it is saved through it, so the
   * sidebar updates at once. Without it the photo still saves (via saveUser) and shows after a reload.
   */
  onUpdateProfile?: (data: { name?: string; avatar?: string | null }) => Promise<UserAccount | null>;
}

const MIN_PW = 10; // server minimum for new passwords
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface UserForm {
  id?: string;
  name: string;
  email: string;
  /** Mobile number: JustConnect calls ring it first when the user is not signed in to the app. */
  phone: string;
  /** The number when the form was opened — sent only when changed (the fallback user list has no numbers). */
  initialPhone: string;
  /** How Call works for them. */
  callVia: 'justconnect' | 'direct';
  role: UserRole;
  status: 'Active' | 'Disabled';
  password: string;
  /** Photo data URL, '' for none. */
  avatar: string;
  /** The photo when the form was opened — a change is sent only when `avatar` differs. */
  initialAvatar: string;
}

const emptyUser = (): UserForm => ({ name: '', email: '', phone: '', initialPhone: '', callVia: 'justconnect', role: 'RM', status: 'Active', password: '', avatar: '', initialAvatar: '' });

export const UsersSection: React.FC<UsersSectionProps> = ({ users: initialUsers, currentUser, onRefreshAll, onUpdateProfile }) => {
  const [rows, setRows] = useState<UserAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<UserForm>(emptyUser);
  const [formError, setFormError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const photoPicker = useAvatarPicker(
    (dataUrl) => setForm((f) => ({ ...f, avatar: dataUrl })),
    (message) => toast('Photo not accepted', message, 'warning'),
  );

  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<UserAccount | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Auto-generated password returned once by saveUser — never stored, shown until dismissed.
  const [tempPassword, setTempPassword] = useState<{ name: string; email: string; password: string } | null>(null);
  const [tempCopied, setTempCopied] = useState(false);
  const copyTempPassword = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword.password);
      setTempCopied(true);
      setTimeout(() => setTempCopied(false), 1800);
    } catch {
      toast('Copy failed', 'Your browser blocked clipboard access.', 'warning');
    }
  };

  // Bootstrap list (active users only) is the fallback when the full list cannot be fetched.
  const fallbackRef = useRef(initialUsers);
  fallbackRef.current = initialUsers;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.settings.users.list();
      setRows(Array.isArray(list) ? list : []);
    } catch (e) {
      const err = reportError('users.list', e);
      setError(toAppError(err).userMessage);
      setRows((r) => (r === null ? fallbackRef.current : r));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* devices: how many each person is signed in on; open one person's devices to sign them out */
  const [deviceCounts, setDeviceCounts] = useState<Record<string, number>>({});
  const loadCounts = useCallback(() => api.settings.users.sessionCounts().then(setDeviceCounts).catch(() => undefined), []);
  useEffect(() => {
    void loadCounts();
  }, [loadCounts, rows]);
  const [devicesOf, setDevicesOf] = useState<UserAccount | null>(null);
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [deviceBusy, setDeviceBusy] = useState('');
  useEffect(() => {
    if (!devicesOf) return;
    setDevices(null);
    api.settings.users.sessions(devicesOf.id).then(setDevices).catch((e) => { setDevices([]); toast('Could not load the devices', toAppError(e).userMessage, 'alert'); });
  }, [devicesOf]);
  const endDevices = async (id?: string) => {
    if (!devicesOf) return;
    setDeviceBusy(id || 'all');
    try {
      setDevices(await api.settings.users.endSessions(devicesOf.id, id));
      toast(id ? 'Device signed out' : `${devicesOf.name} is signed out everywhere`, '', 'success');
      void loadCounts();
    } catch (e) {
      toast('Not signed out', toAppError(e).userMessage, 'alert');
    }
    setDeviceBusy('');
  };

  const sorted = useMemo(() => [...(rows || [])].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
  const company = useCompany();
  const usage = useMemo(() => planUsage(rows || initialUsers, company?.maxUsers), [rows, initialUsers, company?.maxUsers]);
  const activeAdmins = useMemo(() => sorted.filter((u) => (normalizeRole(u.role) === 'Admin' || normalizeRole(u.role) === 'Developer') && u.status !== 'Disabled').length, [sorted]);

  const openCreate = () => {
    setForm(emptyUser());
    setFormError(null);
    setShowPw(false);
    setEditOpen(true);
  };

  const openEdit = (u: UserAccount) => {
    setForm({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', initialPhone: u.phone || '', callVia: u.callVia === 'direct' ? 'direct' : 'justconnect', role: normalizeRole(u.role), status: u.status === 'Disabled' ? 'Disabled' : 'Active', password: '', avatar: u.avatar || '', initialAvatar: u.avatar || '' });
    setFormError(null);
    setShowPw(false);
    setEditOpen(true);
  };

  const afterChange = async () => {
    await load();
    onRefreshAll();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) return setFormError('Name is required.');
    if (!EMAIL_RE.test(email)) return setFormError('Enter a valid email address.');
    if (form.password && form.password.length < MIN_PW) return setFormError(`The password must be at least ${MIN_PW} characters${form.id ? '' : ' — or leave it blank to generate one'}.`);
    if (photoPicker.busy) return setFormError('The photo is still being prepared — try again in a moment.');
    setSaving(true);
    setFormError(null);
    const photoChanged = form.avatar !== form.initialAvatar;
    const ownViaProfile = photoChanged && !!form.id && form.id === currentUser?.id && !!onUpdateProfile;
    // saveUser stores a photo only on an existing account, so a new user's photo follows in a second call;
    // your own photo goes through the profile call so the signed-in session (sidebar) updates at once.
    const photoSeparately = photoChanged && (!form.id || ownViaProfile);
    try {
      const payload: Partial<UserAccount> & { password?: string } = { id: form.id, name, email, role: form.role, status: form.status };
      if (form.phone.trim() !== form.initialPhone) payload.phone = form.phone.trim();
      payload.callVia = form.callVia;
      if (form.password) payload.password = form.password;
      if (photoChanged && !photoSeparately) payload.avatar = form.avatar; // '' removes the photo
      const saved = await api.settings.users.save(payload);
      toast(form.id ? 'User updated' : 'User created', `${saved.name} · ${roleLabel(saved.role)}`, 'success');
      if (saved.temporaryPassword) {
        setTempPassword({ name: saved.name, email: saved.email, password: saved.temporaryPassword });
        setTempCopied(false);
      }
      setEditOpen(false);
      if (photoSeparately) {
        try {
          if (ownViaProfile && onUpdateProfile) await onUpdateProfile({ avatar: form.avatar || null });
          else await api.settings.users.save({ id: saved.id, avatar: form.avatar });
        } catch (photoErr) {
          const e3 = reportError('users.savePhoto', photoErr);
          toast('Photo not saved', `${saved.name} was saved, but the photo was not: ${toAppError(e3).userMessage}`, 'warning');
        }
      }
      await afterChange();
    } catch (err) {
      const e2 = reportError('users.save', err);
      const message = toAppError(e2).userMessage;
      setFormError(message);
      if (isPlanLimitMessage(message)) toast('User limit reached', message, 'warning');
    } finally {
      setSaving(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetPw.length < MIN_PW) return setResetError(`The new password must be at least ${MIN_PW} characters.`);
    setBusyId(resetTarget.id);
    setResetError(null);
    try {
      await api.settings.users.resetPassword(resetTarget.id, resetPw);
      toast('Password reset', `${resetTarget.name} must change it at the next sign-in.`, 'success');
      setResetTarget(null);
      setResetPw('');
      await afterChange();
    } catch (err) {
      const e2 = reportError('users.resetPassword', err);
      setResetError(toAppError(e2).userMessage);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await api.settings.users.remove(deleteTarget.id);
      toast('User deleted', deleteTarget.email, 'info');
      setDeleteTarget(null);
      await afterChange();
    } catch (err) {
      const e2 = reportError('users.delete', err);
      toast('Could not delete user', toAppError(e2).userMessage, 'alert');
    } finally {
      setBusyId(null);
    }
  };

  // Admins give any company role; Managers only Agent (the server enforces the same rule).
  const allowedRoles = assignableRoles(currentUser);
  const roleOptions = allowedRoles.map((r) => ({ value: r.id, label: r.label }));
  const manages = (u: UserAccount) => allowedRoles.some((r) => r.id === normalizeRole(u.role));
  const roleDescription = ROLE_OPTIONS.find((r) => r.id === form.role)?.description;

  return (
    <div className="space-y-5">
      {can(currentUser, 'settings.edit') && <LeadVisibilityCard />}
      <Card
        title="Team"
        subtitle={can(currentUser, 'users.manage') ? 'Everyone who can sign in. Add Managers (full access to all leads) and Agents (only their own leads).' : 'Add and manage Agents — they work only the leads assigned to them.'}
        actions={
          <>
            <Badge tone={usage.atLimit ? 'amber' : 'muted'}><Users size={10} className="mr-1" />{usage.label}</Badge>
            <Button variant="secondary" size="xs" onClick={load} loading={loading} icon={<RefreshCw size={12} />}>Refresh</Button>
            <Button variant="primary" size="xs" onClick={openCreate} icon={<Plus size={12} />}>Add user</Button>
          </>
        }
      >
        {usage.atLimit && (
          <InlineNotice tone="warning" className="mb-3">
            Your plan allows {usage.max} active {usage.max === 1 ? 'user' : 'users'} and all are in use. Disable a user before adding or enabling another, or ask the platform administrator to raise the limit.
          </InlineNotice>
        )}
        {tempPassword && (
          <InlineNotice tone="success" className="mb-3">
            <div className="flex items-start gap-2 flex-wrap">
              <div className="flex-1 min-w-0">
                <div><strong>{tempPassword.name}</strong> ({tempPassword.email}) was created with a temporary password: <code className="font-mono font-bold select-all">{tempPassword.password}</code></div>
                <div className="text-[11px] mt-0.5">Share this with the user; it is not shown again.</div>
              </div>
              <Button variant="secondary" size="xs" onClick={copyTempPassword} icon={tempCopied ? <Check size={11} /> : <Copy size={11} />}>{tempCopied ? 'Copied' : 'Copy'}</Button>
              <button type="button" onClick={() => setTempPassword(null)} className="p-1 rounded-md text-emerald-800 hover:bg-emerald-100" aria-label="Dismiss"><X size={12} /></button>
            </div>
          </InlineNotice>
        )}
        {rows === null && loading ? (
          <LoadingState label="Loading users…" />
        ) : error && !rows?.length ? (
          <ErrorState title="Could not load users" message={error} onRetry={load} />
        ) : sorted.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="No users" description="Add the people who should sign in." action={<Button variant="primary" onClick={openCreate} icon={<Plus size={13} />}>Add user</Button>} />
        ) : (
          <>
            {error && <ErrorState compact title="Refresh failed — showing the last known list" message={error} onRetry={load} className="mb-3" />}
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#E6EFF6] border-b border-[#D3E3F0] text-[10px] uppercase tracking-wider text-[#5E778C] font-bold">
                    <th className="p-3">Name</th>
                    <th className="p-3">Email</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Last sign-in</th>
                    <th className="p-3">Devices</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6EFF6]">
                  {sorted.map((u) => {
                    const me = currentUser?.id === u.id;
                    const lastAdmin = (normalizeRole(u.role) === 'Admin' || normalizeRole(u.role) === 'Developer') && u.status !== 'Disabled' && activeAdmins <= 1;
                    return (
                      <tr key={u.id} className="hover:bg-[#F2F7FB] transition">
                        <td className="p-3 font-bold text-[#0B2A44] whitespace-nowrap">
                          <div className="flex items-center gap-2.5">
                            <Avatar user={u} size="sm" />
                            <span>{u.name}</span>
                            {me && <Badge tone="gold">You</Badge>}
                            {u.mustChangePassword && <span className="text-[10px] text-[#0B6BB0] font-medium" title="Temporary password">temp pw</span>}
                          </div>
                        </td>
                        <td className="p-3 text-[#0F2233]">{u.email}</td>
                        <td className="p-3 whitespace-nowrap"><Badge tone={normalizeRole(u.role) === 'Admin' || normalizeRole(u.role) === 'Developer' ? 'navy' : normalizeRole(u.role) === 'Manager' ? 'gold' : 'muted'}>{roleLabel(u.role)}</Badge></td>
                        <td className="p-3 whitespace-nowrap"><Badge tone={u.status === 'Disabled' ? 'rust' : 'sage'}>{u.status || 'Active'}</Badge></td>
                        <td className="p-3 text-[#5E778C] whitespace-nowrap" title={formatDateTime(u.lastLoginAt, '')}>{u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}</td>
                        <td className="p-3 whitespace-nowrap">
                          {manages(u) ? (
                            <button onClick={() => setDevicesOf(u)} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold text-[#0B6BB0] hover:bg-[#E3EDF5]" title="See and sign out this person's devices">
                              <Laptop size={13} /> {deviceCounts[u.id] || 0} of 2
                            </button>
                          ) : (
                            <span className="text-xs text-[#7E93A6]">{deviceCounts[u.id] || 0} of 2</span>
                          )}
                        </td>
                        <td className="p-3 text-right whitespace-nowrap">
                          {manages(u) && <>
                          <button onClick={() => openEdit(u)} className="p-1.5 rounded-md text-[#5E778C] hover:text-[#0B2A44] hover:bg-[#E3EDF5]" title="Edit user"><Pencil size={13} /></button>
                          <button onClick={() => { setResetTarget(u); setResetPw(''); setResetError(null); }} className="p-1.5 rounded-md text-[#5E778C] hover:text-[#0B2A44] hover:bg-[#E3EDF5]" title="Reset password"><KeyRound size={13} /></button>
                          <button onClick={() => setDeleteTarget(u)} disabled={me || lastAdmin} className="p-1.5 rounded-md text-[#5E778C] hover:text-[#8A3E28] hover:bg-[#FAF0EC] disabled:opacity-30 disabled:cursor-not-allowed" title={me ? 'You cannot delete your own account' : lastAdmin ? 'The last administrator cannot be deleted' : 'Delete user'}><Trash2 size={13} /></button>
                          </>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="Roles explained">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {ROLE_OPTIONS.map((r) => (
            <div key={r.id} className="p-3 rounded-xl bg-[#F2F7FB] border border-[#D3E3F0]">
              <div className="font-bold text-[#0B2A44]">{r.label}</div>
              <div className="text-[11px] text-[#5E778C] mt-0.5 leading-relaxed">{r.description}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Add / edit */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={form.id ? 'Edit user' : 'Add user'}
        subtitle={form.id ? form.email : 'The user signs in with this email and password'}
        width="sm"
        footer={<><Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={saving} disabled={photoPicker.busy}>{form.id ? 'Save changes' : 'Create user'}</Button></>}
      >
        <form onSubmit={submit} className="space-y-3">
          <Field label="Photo" hint={form.avatar !== form.initialAvatar ? (form.id ? 'Not saved yet — click Save changes.' : 'Added when you create the user.') : 'Optional. JPEG, PNG or WebP up to 8 MB — cropped to a square.'}>
            <div className="flex items-center gap-3">
              <Avatar user={{ name: form.name || form.email, avatar: form.avatar }} size="lg" className="ring-2 ring-[#E6EFF6]" />
              {photoPicker.input}
              <div className="flex items-center gap-1.5 flex-wrap">
                <Button type="button" variant="secondary" size="xs" onClick={photoPicker.open} loading={photoPicker.busy} disabled={saving} icon={<Camera size={12} />}>{form.avatar ? 'Change photo' : 'Upload photo'}</Button>
                {form.avatar && <Button type="button" variant="ghost" size="xs" onClick={() => setForm((f) => ({ ...f, avatar: '' }))} disabled={saving || photoPicker.busy} icon={<Trash2 size={12} />}>Remove photo</Button>}
                {form.avatar !== form.initialAvatar && form.initialAvatar && <Button type="button" variant="ghost" size="xs" onClick={() => setForm((f) => ({ ...f, avatar: f.initialAvatar }))} disabled={saving || photoPicker.busy}>Undo</Button>}
              </div>
            </div>
          </Field>
          <Field label="Full name">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoComplete="off" />
          </Field>
          <Field label="Email">
            <input type="email" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="off" />
          </Field>
          <Field label="Mobile number for calls (optional)" hint="Calls started from the CRM ring this phone first, then the customer — who sees the business number. 10 digits for India.">
            <input type="tel" inputMode="tel" className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="98765 43210" autoComplete="off" maxLength={20} />
          </Field>
          <Field label="Call through" hint={form.callVia === 'direct' ? 'Call opens their phone’s dialer — the customer sees their own number and the call is not recorded.' : 'JustConnect (when connected): their JustConnect app or mobile rings first; the customer sees the business number and the call is recorded.'}>
            <Select value={form.callVia} onChange={(e) => setForm({ ...form, callVia: e.target.value as 'justconnect' | 'direct' })} options={[{ value: 'justconnect', label: 'JustConnect (business number)' }, { value: 'direct', label: 'Phone dialer (direct)' }]} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role" hint={roleDescription}>
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })} options={roleOptions} />
            </Field>
            <Field label="Status" hint={form.status === 'Disabled' ? 'Disabled users are signed out and cannot sign in.' : undefined}>
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'Active' | 'Disabled' })} options={['Active', 'Disabled']} disabled={form.id === currentUser?.id} />
            </Field>
          </div>
          <Field label={form.id ? 'New password (optional)' : 'Initial password (optional)'} hint={form.id ? 'Leave blank to keep the current password. Setting one signs the user out everywhere.' : `Leave blank to generate a temporary password — it is shown once after the user is created. If you set one, use at least ${MIN_PW} characters. Share it with the user — they sign in with it.`}>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} className={`${inputCls} !pr-9`} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" minLength={MIN_PW} />
              <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#7E93A6] hover:text-[#0B2A44]" aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </Field>
          {formError && <InlineNotice tone="warning">{formError}</InlineNotice>}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      {/* Devices of one person */}
      <Modal
        open={!!devicesOf}
        onClose={() => setDevicesOf(null)}
        title="Signed in on"
        subtitle={devicesOf ? `${devicesOf.name} · ${devicesOf.email}` : undefined}
        width="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setDevicesOf(null)}>Close</Button>
          {!!devices?.length && <Button variant="primary" loading={deviceBusy === 'all'} onClick={() => void endDevices()} icon={<LogOut size={13} />}>Sign out everywhere</Button>}
        </>}
      >
        <div className="space-y-3">
          <InlineNotice>At most 2 devices per person — signing in on a third signs the oldest out. Lost a phone or someone left? Sign them out here; they can sign in again with their password (reset it too if needed).</InlineNotice>
          <DeviceRows rows={devices} busyId={deviceBusy} onEnd={(s) => void endDevices(s.id)} />
        </div>
      </Modal>

      {/* Reset password */}
      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title="Reset password"
        subtitle={resetTarget ? `${resetTarget.name} · ${resetTarget.email}` : undefined}
        width="sm"
        footer={<><Button variant="ghost" onClick={() => setResetTarget(null)}>Cancel</Button><Button variant="primary" onClick={submitReset} loading={busyId === resetTarget?.id} icon={<KeyRound size={13} />}>Reset password</Button></>}
      >
        <form onSubmit={submitReset} className="space-y-3">
          <InlineNotice>The user is signed out of every device and must change this temporary password at the next sign-in.</InlineNotice>
          <Field label="Temporary password" hint={`At least ${MIN_PW} characters.`}>
            <input type="text" className={inputCls} value={resetPw} onChange={(e) => setResetPw(e.target.value)} autoComplete="off" minLength={MIN_PW} required />
          </Field>
          {resetError && <InlineNotice tone="warning">{resetError}</InlineNotice>}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete user?"
        danger
        confirmLabel="Delete user"
        loading={!!deleteTarget && busyId === deleteTarget.id}
        message={<>Remove <strong>{deleteTarget?.name}</strong> ({deleteTarget?.email})? Their sessions end immediately. Leads and tasks they worked on are kept.</>}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
