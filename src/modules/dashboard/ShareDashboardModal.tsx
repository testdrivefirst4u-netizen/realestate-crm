'use client';

/**
 * Manage the public, no-login share link for the dashboard (Dashboard · Sales MIS · YTD/MTD).
 * Turn it on/off, copy it, or rotate the token to kill the old link. Read-only, no customer
 * contact details leave the CRM. Server: modules/pipelineShare.ts; public page: app/p/[slug]/[token].
 */
import React, { useEffect, useState } from 'react';
import { Copy, RotateCcw } from 'lucide-react';
import { api, type PipelineShare } from '@/src/core/api';
import { reportError, toAppError } from '@/src/core/errors';
import { toast } from '@/src/core/notifications';
import { Button, Modal } from '@/src/components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const ShareDashboardModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [s, setS] = useState<PipelineShare | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.pipeline.share().then(setS).catch((e) => { toast('Could not load', errText('pipeline.share', e), 'alert'); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = async (enabled: boolean) => { setBusy(true); try { setS(await api.pipeline.setShare(enabled)); } catch (e) { toast('Not saved', errText('pipeline.setShare', e), 'alert'); } finally { setBusy(false); } };
  const rotate = async () => { if (!window.confirm('Make a new link? The current one stops working immediately.')) return; setBusy(true); try { setS(await api.pipeline.rotate()); toast('New link created', undefined, 'success'); } catch (e) { toast('Could not rotate', errText('pipeline.rotate', e), 'alert'); } finally { setBusy(false); } };
  const copy = () => { if (s?.url) navigator.clipboard?.writeText(s.url).then(() => toast('Link copied', undefined, 'success')).catch(() => {}); };
  return (
    <Modal open onClose={onClose} width="md" title="Share the dashboard (no login)"
      subtitle="Anyone with the link sees the Dashboard, Sales MIS and YTD/MTD — read-only, always up to date, no customer contact details. Switch it off or make a new link any time."
      footer={<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>}>
      {!s ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <div className="space-y-3 text-sm text-[#2B4A63]">
          <label className="inline-flex items-center gap-2 font-medium text-[#0B2A44]"><input type="checkbox" className="h-4 w-4 accent-[#1A73E8]" disabled={busy} checked={s.enabled} onChange={(e) => void set(e.target.checked)} /> Public link is {s.enabled ? 'on' : 'off'}</label>
          {s.enabled && s.url && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-[#F2F7FB] px-2 py-1.5 text-[12px] text-[#0B2A44] border border-[#E3EDF5]">{s.url}</code>
              <Button size="xs" variant="secondary" icon={<Copy size={12} />} onClick={copy}>Copy</Button>
              <Button size="xs" variant="secondary" icon={<RotateCcw size={12} />} loading={busy} onClick={() => void rotate()}>New link</Button>
            </div>
          )}
          <p className="text-[11px] text-[#7E93A6]">The page refreshes its data on its own (about every 30 minutes, and on every open), so a dashboard left open stays current day to day. It is never indexed by search engines.</p>
        </div>
      )}
    </Modal>
  );
};
