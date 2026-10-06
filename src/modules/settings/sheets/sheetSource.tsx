/** Google Sheet import sources — shared bits for Lead sources and the Google Sheets screen. */
import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { LeadSource } from '../../../../server/core/leadSourceTypes';
import type { GoogleConnection, SheetImportConfig } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { formatDateTime, formatDistance } from '../../../core/dates';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { authLabel, intervalLabel, spreadsheetHref, syncResultText } from './sheetUtils';

/** "Sync now" for a Google Sheet import: toast with the counts; returns true when it ran. */
export async function syncSheetSource(source: Pick<LeadSource, 'id' | 'name'>): Promise<boolean> {
  try {
    const r = await api.sheets.syncImport(source.id);
    const bad = Number(r.failed || 0) + Number(r.rejected || 0);
    toast(`Synced “${source.name}”`, syncResultText(r), bad ? 'warning' : 'success');
    return true;
  } catch (e) {
    toast('Could not sync the sheet', toAppError(reportError('sheets.syncImport', e)).userMessage, 'alert');
    return false;
  }
}

/** Sheet link, access, tab, interval and last sync of a Google Sheet import. */
export const SheetSummary: React.FC<{ sheet: SheetImportConfig | null | undefined; connections?: GoogleConnection[] | null }> = ({ sheet, connections }) => {
  const href = sheet ? spreadsheetHref(sheet.spreadsheetUrl, sheet.spreadsheetId) : '';
  return (
    <dl className="text-[11px] text-[#3D3530] grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-[#9E948D]">Sheet</dt>
      <dd className="min-w-0 truncate">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#A9825A] hover:underline font-semibold">
            Open spreadsheet <ExternalLink size={11} aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : <span className="text-[#9E948D]">not set</span>}
      </dd>
      <dt className="text-[#9E948D]">Access</dt>
      <dd className="truncate" title={sheet ? authLabel(sheet.auth, connections) : undefined}>{sheet ? authLabel(sheet.auth, connections) : '—'}</dd>
      <dt className="text-[#9E948D]">Tab</dt>
      <dd className="truncate">{sheet?.tab || 'First tab'}{sheet?.headerRow && sheet.headerRow > 1 ? ` · headers in row ${sheet.headerRow}` : ''}</dd>
      <dt className="text-[#9E948D]">Sync</dt>
      <dd className="truncate">{intervalLabel(sheet?.intervalMinutes)}{sheet?.statusColumn ? ` · status column “${sheet.statusColumn}”` : ''}</dd>
      <dt className="text-[#9E948D]">Last sync</dt>
      <dd className="min-w-0">
        {sheet?.lastSyncAt ? <span title={formatDateTime(sheet.lastSyncAt)}>{formatDistance(sheet.lastSyncAt)}</span> : <span className="text-[#9E948D]">not yet</span>}
        {sheet?.lastSyncResult && <span className="block text-[#6B5F57] break-words">{sheet.lastSyncResult}</span>}
      </dd>
    </dl>
  );
};
