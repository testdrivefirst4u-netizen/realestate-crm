import React, { useState } from 'react';
import { Camera, Check, MessageCircle, Trash2, UserCircle2 } from 'lucide-react';
import { UserAccount } from '../../types/crm';
import { api } from '../../core/api';
import { formatDateTime } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { roleLabel } from '../../core/rbac';
import { Avatar, isAvatarDataUrl, useAvatarPicker } from '../../components/Avatar';
import { Badge, Button, Card, InlineNotice, inputCls } from '../../components/ui';
import { TwoStepCard } from './TwoStepCard';

export type ProfileUpdate = { name?: string; avatar?: string | null; phone?: string };

export interface ProfileSectionProps {
  currentUser: UserAccount | null;
  onRefreshAll: () => void;
  /**
   * Saves your own name / photo and refreshes the signed-in session — pass `engine.updateProfile`.
   * Without it the photo is saved straight through the API and the sidebar only catches up after a reload.
   */
  onUpdateProfile?: (data: ProfileUpdate) => Promise<UserAccount | null>;
}

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
  const [phone, setPhone] = useState<string | null>(null); // null = not edited
  const [savingPhone, setSavingPhone] = useState(false);
  const savePhone = async () => {
    if (phone === null) return;
    setSavingPhone(true);
    try {
      if (onUpdateProfile) await onUpdateProfile({ phone: phone.trim() });
      else { await api.auth.updateProfile({ phone: phone.trim() }); onRefreshAll(); }
      setPhone(null);
      toast(phone.trim() ? 'WhatsApp number saved' : 'WhatsApp number removed', undefined, 'success');
    } catch (err) {
      toast('Could not save your number', toAppError(reportError('profile.updatePhone', err)).userMessage, 'alert');
    } finally {
      setSavingPhone(false);
    }
  };

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

  return (
    <div className="space-y-5">
      <Card title="Your account" subtitle="Signed in to this device">
        {currentUser ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex flex-col items-center gap-2 flex-shrink-0 sm:w-60">
              <Avatar user={{ name: currentUser.name, avatar: shownPhoto }} size="xl" className="ring-4 ring-[#E6EFF6]" />
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
              <div className="text-[10px] text-[#7E93A6] text-center leading-snug">
                {photoDirty ? (shownPhoto ? 'Preview — not saved yet' : 'Your initials will be shown instead') : 'JPEG, PNG or WebP, up to 8 MB'}
              </div>
            </div>
            <div className="min-w-0 flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Name</div><div className="font-bold text-[#0B2A44] text-sm truncate">{currentUser.name}</div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Email</div><div className="text-[#0F2233] truncate">{currentUser.email}</div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Role</div><div><Badge tone="navy">{roleLabel(currentUser.role)}</Badge></div></div>
              <div><div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Last sign-in</div><div className="text-[#0F2233]">{formatDateTime(currentUser.lastLoginAt, '—')}</div></div>
            </div>
          </div>
        ) : (
          <InlineNotice tone="warning">No active session. Please sign in again.</InlineNotice>
        )}
      </Card>

      {currentUser && (
        <Card title={<span className="inline-flex items-center gap-2"><MessageCircle size={15} className="text-[#0E8A86]" /> WhatsApp number</span>} subtitle="Get new-lead alerts on WhatsApp when your company turns them on (Settings › Alerts & follow-ups).">
          <div className="flex flex-wrap items-end gap-2">
            <input type="tel" inputMode="tel" className={inputCls + ' w-56'} value={phone ?? currentUser.phone ?? ''} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" maxLength={20} aria-label="WhatsApp number" />
            <Button variant="primary" onClick={() => void savePhone()} loading={savingPhone} disabled={phone === null} icon={<Check size={13} />}>Save</Button>
          </div>
          <p className="mt-2 text-xs text-[#5E778C]">10 digits for India, or + country code for other countries.</p>
        </Card>
      )}

      {currentUser && <TwoStepCard enabled={!!currentUser.twoFactor} onChanged={onRefreshAll} />}

      <div className="text-[11px] text-[#7E93A6] inline-flex items-center gap-1.5"><UserCircle2 size={12} />Need a different role or email? Ask an administrator — they can change it under Settings → Users.</div>
    </div>
  );
};
