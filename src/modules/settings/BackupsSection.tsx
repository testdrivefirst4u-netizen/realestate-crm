/**
 * Settings › Backups — the daily lead backups the server keeps (last 14 days), each downloadable as Excel,
 * plus "Back up now". Admins only (settings.edit).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, DatabaseBackup, Download, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, type BackupInfo } from '../../core/api';
import { reportError } from '../../core/errors';
import { formatDateTime } from '../../core/dates';
import { exportLeadsToXlsx } from '../../services/csvService';
import { Button, Card, EmptyState, InlineNotice } from '../../components/ui';

export const BackupsSection: React.FC = () => {
  const [rows, setRows] = useState<BackupInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.backups.list());
    } catch (e) {
      setError(reportError('backups.list', e).userMessage);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const download = async (b: BackupInfo) => {
    setBusy(b.id);
    try {
      const r = await api.backups.get(b.id);
      exportLeadsToXlsx(r.leads as any, `Leads_backup_${b.id}.xlsx`);
    } catch (e) {
      setError(reportError('backups.get', e).userMessage);
    }
    setBusy(null);
  };

  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const verify = async () => {
    setBusy('verify');
    setVerifyMsg(null);
    try {
      const r = await api.backups.verify();
      setVerifyMsg(r ? (r.ok ? `Restore test passed for ${r.id}: ${r.note}.` : `Restore test FAILED for ${r.id}: ${r.note}`) : 'No backup to test yet.');
      await load();
    } catch (e) {
      setError(reportError('backups.verify', e).userMessage);
    }
    setBusy(null);
  };

  const backupNow = async () => {
    setBusy('now');
    try {
      await api.backups.create();
      await load();
    } catch (e) {
      setError(reportError('backups.create', e).userMessage);
    }
    setBusy(null);
  };

  return (
    <Card
      title="Lead backups"
      subtitle="A copy of every lead is saved automatically each night (around 06:00 IST) and then restore-tested: the backup is unpacked and every lead read back. The last 14 days are kept. Download any day as an Excel file."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void verify()} loading={busy === 'verify'} disabled={!!busy && busy !== 'verify'} icon={<ShieldCheck size={13} />}>Test restore</Button>
          <Button variant="primary" onClick={() => void backupNow()} loading={busy === 'now'} disabled={!!busy && busy !== 'now'} icon={<DatabaseBackup size={13} />}>Back up now</Button>
        </div>
      }
    >
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {verifyMsg && <InlineNotice tone={verifyMsg.includes('FAILED') ? 'warning' : 'success'}>{verifyMsg}</InlineNotice>}
      {rows === null && !error && <p className="text-sm text-[#5E778C] py-4">Loading backups…</p>}
      {rows && !rows.length && (
        <EmptyState icon={<DatabaseBackup size={22} />} title="No backups yet" description="The first one is made tonight — or press Back up now." />
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm border-collapse min-w-[520px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#5E778C]">
                <th scope="col" className="py-2 px-2 font-semibold">Day</th>
                <th scope="col" className="py-2 px-2 font-semibold">Saved</th>
                <th scope="col" className="py-2 px-2 font-semibold">Leads</th>
                <th scope="col" className="py-2 px-2 font-semibold">Size</th>
                <th scope="col" className="py-2 px-2 font-semibold">Restore test</th>
                <th scope="col" className="py-2 px-2"><span className="sr-only">Download</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-t border-[#E3EDF5]">
                  <td className="py-2.5 px-2 font-semibold text-[#0B2A44]">{b.id}</td>
                  <td className="py-2.5 px-2 text-[#5E778C]">{formatDateTime(b.createdAt)} · {b.createdBy}</td>
                  <td className="py-2.5 px-2">{b.count}</td>
                  <td className="py-2.5 px-2 text-[#5E778C]">{b.sizeKB} KB</td>
                  <td className="py-2.5 px-2" title={b.verifyNote || ''}>
                    {b.verified === 'ok' ? <span className="inline-flex items-center gap-1 text-[#067647] font-semibold"><CheckCircle2 size={13} />Passed</span>
                      : b.verified === 'failed' ? <span className="inline-flex items-center gap-1 text-[#B42318] font-semibold"><ShieldAlert size={13} />Failed</span>
                      : <span className="text-[#7E93A6]">—</span>}
                  </td>
                  <td className="py-2.5 px-2 text-right">
                    <Button variant="secondary" size="xs" onClick={() => void download(b)} loading={busy === b.id} disabled={!!busy && busy !== b.id} icon={<Download size={12} />}>Excel</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3">
        <Button variant="ghost" size="xs" onClick={() => void load()} icon={<RefreshCw size={12} />}>Refresh</Button>
      </div>
    </Card>
  );
};
