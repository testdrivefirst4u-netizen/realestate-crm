import React, { useState } from 'react';
import { Camera, Check, Eye, EyeOff, KeyRound, ShieldCheck, Trash2, UserCircle2 } from 'lucide-react';
import { UserAccount } from '../../types/crm';
import { api } from '../../core/api';
import { formatDateTime } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { roleLabel } from '../../core/rbac';
import { Avatar, isAvatarDataUrl, useAvatarPicker } from '../../components/Avatar';
import { Badge, Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';

export type ProfileUpdate = { name?: string; avatar?: string | null };

export interface ProfileSectionProps {
  currentUser: UserAccount | null;
  onRefreshAll: () => void;
  /**
   * Saves your own name / photo and refreshes the signed-in session — pass `engine.updateProfile`.
   * Without it the photo is saved straight through the API and the sidebar only catches up after a reload.
   */
  onUpdateProfile?: (data: ProfileUpdate) => Promise<UserAccount | null>;
}

const MIN_PW = 6;

export const ProfileSection: React.FC<ProfileSectionProps> = ({ currentUser, onRefreshAll, onUpdateProfile }) => {
  // What the photo slot shows instead of the session's photo: a preview waiting to be saved (`dirty`) or —
  // when `onUpdateProfile` is not wired — the photo just saved, until the session catches up on reload.
  const [photo, setPhoto] = useState<{ value: string | null; dirty: boolean } | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const picker = useAvatarPicker(
    (dataUrl) => setPhoto({ value: dataUrl, dirty: true }),
    (message) => toast('Photo not accepted', message, 'warning'),
  );
  const shownPhoto = photo ? photo.value : currentUser?.avatar || null;
  const photoDirty = !!photo?.dirty;
  const hasPhoto = isAvatarDataUrl(shownPhoto);

  const savePhoto = async () => {
    if (!currentUser || !photo?.dirty) return;
    const value = photo.value;
    setSavingPhoto(true);
    try {
      if (onUpdateProfile) {
        const saved = await onUpdateProfile({ avatar: value });
        if (!saved) {
          toast('Signed out', 'Please sign in again to change your photo.', 'warning');
          return;
        }
        setPhoto(null);
      } else {
        await api.auth.updateProfile({ avatar: value });
        setPhoto({ value, dirty: false });
        onRefreshAll();
      }
      toast(value ? 'Photo updated' : 'Photo removed', value ? 'Your photo now appears across the CRM.' : 'Your initials are shown instead.', 'success');
    } catch (err) {
      const e2 = reportError('profile.updatePhoto', err);
      toast('Could not save your photo', toAppError(e2).userMessage, 'alert');
    } finally {
      setSavingPhoto(false);
    }
  };

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) return setError('Enter your current password.');
    if (next.length < MIN_PW) return setError(`The new password must be at least ${MIN_PW} characters.`);
    if (next === current) return setError('Choose a password different from the current one.');
    if (next !== confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      toast('Password changed', 'Use the new password the next time you sign in.', 'success');
      setCurrent('');
      setNext('');
      setConfirm('');
      onRefreshAll();
    } catch (err) {
      const e2 = reportError('profile.changePassword', err);
      setError(toAppError(e2).userMessage);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Your account" subtitle="Signed in to this device">
        {currentUser ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex flex-col items-center gap-2 flex-shrink-0 sm:w-60">
              <Avatar user={{ name: currentUser.name, avatar: shownPhoto }} size="xl" className="ring-4 ring-[#ECE8E1]" />
              {picker.input}
              {photoDirty ? (
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="primary" size="xs" onClick={savePhoto} loading={savingPhoto} icon={<Check size={12} />}>{shownPhoto ? 'Save photo' : 'Remove photo'}</Button>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setPhoto(null)} disabled={savingPhoto}>Cancel</Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <Button type="button" variant="secondary" size="xs" onClick={picker.open} loading={picker.busy} icon={<Camera size={12} />}>{hasPhoto ? 'Change photo' : 'Upload photo'}</Button>
                  {hasPhoto && <Button type="button" variant="ghost" size="xs" onClick={() => setPhoto({ value: null, dirty: true })} disabled={picker.busy} icon={<Trash2 size={12} />}>Remove photo</Button>}
                </div>
              )}
              <div className="text-[10px] text-[#9E948D] text-center leading-snug">
                {photoDirty ? (shownPhoto ? 'Preview — not saved yet' : 'Your initials will be shown instead') : 'JPEG, PNG or WebP, up to 8 MB'}
              </div>
            </div>
            <div className="min-w-0 flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Name</div><div className="font-bold text-[#1D2F3F] text-sm truncate">{currentUser.name}</div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Email</div><div className="text-[#3D3530] truncate">{currentUser.email}</div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Role</div><div><Badge tone="navy">{roleLabel(currentUser.role)}</Badge></div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Last sign-in</div><div className="text-[#3D3530]">{formatDateTime(currentUser.lastLoginAt, '—')}</div></div>
            </div>
          </div>
        ) : (
          <InlineNotice tone="warning">No active session. Please sign in again.</InlineNotice>
        )}
        {currentUser?.mustChangePassword && <InlineNotice tone="warning" className="mt-4">Your administrator set a temporary password. Please choose your own password below.</InlineNotice>}
      </Card>

      <Card title="Change password" subtitle={`At least ${MIN_PW} characters. Other devices signed in with the old password will need to sign in again.`}>
        <form onSubmit={submit} className="space-y-3 max-w-md">
          <Field label="Current password">
            <input type={show ? 'text' : 'password'} className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="New password">
            <input type={show ? 'text' : 'password'} className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={MIN_PW} required />
          </Field>
          <Field label="Confirm new password">
            <div className="relative">
              <input type={show ? 'text' : 'password'} className={`${inputCls} !pr-9`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={MIN_PW} required />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9E948D] hover:text-[#1D2F3F]" aria-label={show ? 'Hide passwords' : 'Show passwords'}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </Field>
          {error && <InlineNotice tone="warning">{error}</InlineNotice>}
          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy} icon={<KeyRound size={13} />} disabled={!currentUser}>Update password</Button>
            <span className="text-[11px] text-[#9E948D] inline-flex items-center gap-1"><ShieldCheck size={12} />Passwords are stored as salted hashes.</span>
          </div>
        </form>
      </Card>

      <div className="text-[11px] text-[#9E948D] inline-flex items-center gap-1.5"><UserCircle2 size={12} />Need a different role or email? Ask an administrator — they can change it under Settings → Users.</div>
    </div>
  );
};
