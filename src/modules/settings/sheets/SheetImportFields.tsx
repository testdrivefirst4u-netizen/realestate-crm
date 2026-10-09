/**
 * Google Sheet import settings inside the lead-source form: share step, link, "Check access",
 * tab / header row / status column / sync interval.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, FileSpreadsheet, ShieldCheck, UserCheck } from 'lucide-react';
import type { GoogleConnection, GoogleStatus, SheetAuth, SheetCheckResult } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { reportError, toAppError } from '../../../core/errors';
import { Button, InlineNotice, Select, cx, inputCls, labelCls } from '../../../components/ui';
import { CopyButton } from '../leadSources/IntegrationGuide';
import {
  AccessOption, INTERVAL_SELECT_OPTIONS, SheetImportFormState, accessOptions, authValue, checkSpreadsheetUrl, defaultAuth, normalizeAuth, optionForAuth, sheetsAccessConfigured,
  spreadsheetHref, toSyncInterval,
} from './sheetUtils';

export const NOT_CONFIGURED_TEXT = 'Google Sheets isn’t set up on this platform yet; ask your platform administrator.';

/** "Share your sheet with …" with a copy button. */
export const ShareStep: React.FC<{ email: string; forExport?: boolean }> = ({ email, forExport }) => (
  <div className="rounded-xl border border-[#0B6BB0]/50 bg-[#F5F9FC] p-3.5 space-y-2">
    <div className="flex items-center gap-2 text-xs font-bold text-[#0B2A44]"><ShieldCheck size={14} className="text-[#0B6BB0]" /> Share your sheet with the CRM</div>
    <p className="text-[11px] text-[#5E778C] leading-relaxed">
      In Google Sheets click <b>Share</b> and add this address.{' '}
      {forExport
        ? <>Give it <b>Editor</b> access — the CRM writes the leads into the sheet.</>
        : <><b>Viewer</b> is enough; choose <b>Editor</b> if you want the CRM to write an import status column.</>}
    </p>
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 break-all text-xs font-mono bg-white border border-[#D3E3F0] rounded-lg px-3 py-2 text-[#0B2A44]" aria-label="Service account e-mail">{email}</code>
      <CopyButton value={email} label="Copy" ariaLabel="Copy the service account e-mail" />
    </div>
  </div>
);

/**
 * "Access via": a connected Google account or the platform service account. The share-with instructions are
 * shown only for the service account; for a Google account the user only has to make sure that account can open the sheet.
 */
export const AccessPicker: React.FC<{
  options: AccessOption[];
  value: SheetAuth | null | undefined;
  onChange: (auth: SheetAuth) => void;
  id: string;
  forExport?: boolean;
  disabled?: boolean;
  /** Still loading the connected accounts. */
  loading?: boolean;
}> = ({ options, value, onChange, id, forExport, disabled, loading }) => {
  const selected = optionForAuth(options, value);
  if (!options.length) {
    return loading ? <p className="text-[11px] text-[#7E93A6]">Loading the Google accounts…</p> : <InlineNotice tone="warning">{NOT_CONFIGURED_TEXT}</InlineNotice>;
  }
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={id} className={labelCls}>Access via</label>
        <Select
          id={id}
          value={value ? authValue(value) : ''}
          disabled={disabled}
          placeholder={value ? undefined : 'Choose how the CRM opens the sheet'}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(e) => {
            const o = options.find((x) => x.value === e.target.value);
            if (o) onChange(o.auth);
          }}
        />
        {loading && <div className="text-[10px] text-[#7E93A6] mt-1">Loading the connected Google accounts…</div>}
      </div>
      {selected?.unavailable && (
        <div role="alert" className="flex items-start gap-1.5 text-[11px] text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/40 rounded-lg p-2.5">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{selected.auth.mode === 'oauth' ? 'This Google account needs reconnecting (Settings › Google Sheets), or choose another access.' : 'The platform service account is no longer set up — choose a Google account.'}</span>
        </div>
      )}
      {selected && selected.auth.mode === 'service_account' && selected.email && <ShareStep email={selected.email} forExport={forExport} />}
      {selected && selected.auth.mode === 'oauth' && selected.email && (
        <div className="flex items-start gap-2 rounded-xl border border-[#D3E3F0] bg-[#F5F9FC] p-3 text-[11px] text-[#0F2233] leading-relaxed">
          <UserCheck size={14} className="text-[#0B6BB0] flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Make sure <b className="break-all">{selected.email}</b> can open this sheet
            {forExport ? <> with <b>Editor</b> access — the CRM writes the leads into it.</> : <>. <b>Editor</b> access is needed only for an import status column.</>}
          </span>
        </div>
      )}
    </div>
  );
};

/** Summary of a "Check access" result. */
export const CheckResult: React.FC<{ result: SheetCheckResult; needWrite?: boolean }> = ({ result, needWrite }) =>
  result.ok ? (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 space-y-1" role="status">
      <div className="flex items-center gap-1.5 font-bold"><CheckCircle2 size={14} /> Connected to “{result.title || 'Untitled spreadsheet'}”</div>
      <div>{result.canWrite ? 'The CRM can read and write this sheet (Editor).' : 'The CRM can read this sheet (Viewer).'}</div>
      {needWrite && !result.canWrite && <div className="font-semibold text-amber-900">Editor access is needed — change the share to Editor and check again.</div>}
      {result.message && <div className="text-emerald-800">{result.message}</div>}
    </div>
  ) : (
    <div role="alert" className="rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] p-3 text-xs text-[#8A3E28]">
      <div className="font-bold">Could not open the sheet</div>
      <div className="mt-0.5 break-words">{result.message || 'Check the link and that the account chosen above can open the sheet.'}</div>
    </div>
  );

export const SheetImportFields: React.FC<{
  value: SheetImportFormState;
  onChange: (next: SheetImportFormState) => void;
  google: GoogleStatus | null;
  /** Connected Google accounts (null while loading or when "Connect with Google" is not set up). */
  connections?: GoogleConnection[] | null;
  /** Called with the detected header row (for the field mapping). */
  onHeaders: (headers: string[]) => void;
  disabled?: boolean;
  idPrefix: string;
}> = ({ value: f, onChange, google, connections = null, onHeaders, disabled, idPrefix }) => {
  const [check, setCheck] = useState<SheetCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<SheetImportFormState>) => onChange({ ...f, ...patch });
  const id = (s: string) => `${idPrefix}-sheet-${s}`;
  const url = f.spreadsheetUrl.trim() ? checkSpreadsheetUrl(f.spreadsheetUrl) : null;
  const href = url?.ok ? spreadsheetHref(f.spreadsheetUrl) : '';
  const options = accessOptions(google, connections, f.auth);
  const connectionsLoading = !!google?.oauthConfigured && connections === null;

  // A new import gets the default access (first Active Google account, else the service account) once known.
  useEffect(() => {
    if (f.auth || !google || connectionsLoading) return;
    const d = defaultAuth(options);
    if (d) onChange({ ...f, auth: d });
  }, [f.auth, google, connectionsLoading, connections]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCheck = async (over: Partial<SheetImportFormState> = {}) => {
    const next = { ...f, ...over };
    const u = checkSpreadsheetUrl(next.spreadsheetUrl);
    if (!u.ok) {
      setError(u.error);
      return;
    }
    setError('');
    setChecking(true);
    try {
      const r = await api.sheets.checkSheet({ spreadsheetUrl: next.spreadsheetUrl.trim(), tab: next.tab || undefined, headerRow: next.headerRow || 1, ...(next.auth ? { auth: normalizeAuth(next.auth) } : {}) });
      setCheck(r);
      if (r.ok) {
        onHeaders(r.headers || []);
        // Pick the first tab when none is chosen yet, so later checks read the same tab.
        if (!next.tab && r.tabs?.length) onChange({ ...next, tab: r.tabs[0] });
      }
    } catch (e) {
      setCheck(null);
      setError(toAppError(reportError('sheets.checkSheet', e)).userMessage);
    } finally {
      setChecking(false);
    }
  };

  if (google && !sheetsAccessConfigured(google)) return <InlineNotice tone="warning">{NOT_CONFIGURED_TEXT}</InlineNotice>;

  const headers = check?.ok ? check.headers || [] : [];
  const tabs = check?.ok ? check.tabs || [] : [];
  const tabList = f.tab && !tabs.includes(f.tab) ? [f.tab, ...tabs] : tabs;
  const statusOptions = [{ value: '', label: 'None — remember the last imported row' }, ...(f.statusColumn && !headers.includes(f.statusColumn) ? [f.statusColumn] : []), ...headers].map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o
  );

  return (
    <div className="space-y-3 rounded-xl border border-[#D3E3F0] bg-white p-3.5">
      <div className="flex items-center gap-2 text-xs font-bold text-[#0B2A44]"><FileSpreadsheet size={14} className="text-[#0B6BB0]" /> Google Sheet</div>
      {google ? (
        <AccessPicker
          id={id('access')}
          options={options}
          value={f.auth}
          disabled={disabled}
          loading={connectionsLoading}
          onChange={(auth) => {
            set({ auth });
            setCheck(null);
          }}
        />
      ) : <p className="text-[11px] text-[#7E93A6]">Loading the Google Sheets status…</p>}

      <div>
        <label htmlFor={id('url')} className={labelCls}>Spreadsheet link</label>
        <div className="flex items-center gap-1.5">
          <input
            id={id('url')}
            className={cx(inputCls, url && !url.ok && 'border-[#B06A55]')}
            value={f.spreadsheetUrl}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            aria-invalid={!!(url && !url.ok)}
            aria-describedby={url && !url.ok ? id('url-err') : undefined}
            onChange={(e) => {
              set({ spreadsheetUrl: e.target.value });
              setCheck(null);
            }}
          />
          <Button size="sm" variant="primary" loading={checking} disabled={disabled || !url?.ok} onClick={() => runCheck()}>Check access</Button>
        </div>
        {url && !url.ok && <div id={id('url-err')} className="text-[10px] text-[#8A3E28] mt-0.5">{url.error}</div>}
        {href && <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-[#0B6BB0] hover:underline mt-1">Open the sheet <ExternalLink size={11} /></a>}
      </div>

      {error && <div role="alert" className="text-xs text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/40 rounded-lg p-2.5">{error}</div>}
      {check && <CheckResult result={check} needWrite={!!f.statusColumn} />}

      <div className="grid sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label htmlFor={id('tab')} className={labelCls}>Tab</label>
          {tabList.length ? (
            <Select
              id={id('tab')}
              value={f.tab}
              options={tabList}
              onChange={(e) => {
                set({ tab: e.target.value });
                runCheck({ tab: e.target.value });
              }}
            />
          ) : (
            <input id={id('tab')} className={inputCls} value={f.tab} placeholder="First tab" onChange={(e) => set({ tab: e.target.value })} />
          )}
        </div>
        <div>
          <label htmlFor={id('header')} className={labelCls}>Header row</label>
          <input
            id={id('header')}
            type="number"
            min={1}
            max={1000}
            className={inputCls}
            value={f.headerRow || ''}
            onChange={(e) => set({ headerRow: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            onBlur={() => { if (check?.ok && f.headerRow >= 1) runCheck(); }}
          />
        </div>
      </div>

      {check?.ok && (
        <div>
          <div className={labelCls}>Detected columns</div>
          {headers.length ? (
            <ul className="flex flex-wrap gap-1" aria-label="Detected column headers">
              {headers.map((h) => <li key={h} className="text-[11px] px-2 py-0.5 rounded-md bg-[#F2F7FB] border border-[#D3E3F0] text-[#0B2A44]">{h}</li>)}
            </ul>
          ) : (
            <p className="text-[11px] text-[#92400E]">Row {f.headerRow || 1} of this tab is empty — check the header row number.</p>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={id('status')} className={labelCls}>Status column</label>
          <Select id={id('status')} value={f.statusColumn} options={statusOptions} onChange={(e) => set({ statusColumn: e.target.value })} />
          <div className="text-[10px] text-[#7E93A6] mt-1 leading-relaxed">
            Optional. The CRM writes “Imported ENQ-…” (or the error) into this column and skips rows that already have a value — safe even if rows are sorted or inserted. Needs Editor access.
            {!check?.ok && ' Check access to choose from the sheet’s columns.'}
          </div>
        </div>
        <div>
          <label htmlFor={id('interval')} className={labelCls}>Sync</label>
          <Select id={id('interval')} value={String(f.intervalMinutes)} options={INTERVAL_SELECT_OPTIONS} onChange={(e) => set({ intervalMinutes: toSyncInterval(e.target.value) })} />
          <div className="text-[10px] text-[#7E93A6] mt-1">How often new rows are read. “Sync now” works at any time.</div>
        </div>
      </div>
    </div>
  );
};
