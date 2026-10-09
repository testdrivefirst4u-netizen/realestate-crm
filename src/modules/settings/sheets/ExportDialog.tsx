/** New / edit Google Sheets export (one-way copy of the company's leads into a tab). */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Plus, Save } from 'lucide-react';
import type { GoogleConnection, GoogleStatus, SheetCheckResult, SheetExport } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { Button, InlineNotice, Modal, Select, cx, inputCls, labelCls } from '../../../components/ui';
import { AccessPicker, CheckResult, NOT_CONFIGURED_TEXT } from './SheetImportFields';
import {
  DEFAULT_EXPORT_HEADERS, DEFAULT_EXPORT_TAB, ExportFormState, INTERVAL_SELECT_OPTIONS, accessOptions, checkSpreadsheetUrl, columnRows, defaultAuth, emptyExportForm, exportFormFrom,
  exportFormToRequest, exportableHeaders, moveHeader, normalizeAuth, sameAuth, sheetsAccessConfigured, spreadsheetHref, toSyncInterval, toggleHeader,
} from './sheetUtils';

const errMsg = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const ExportDialog: React.FC<{
  /** Existing export to edit; undefined = new. */
  existing?: SheetExport;
  google: GoogleStatus | null;
  /** Connected Google accounts (null while loading or when "Connect with Google" is not set up). */
  connections?: GoogleConnection[] | null;
  onClose: () => void;
  onSaved: (x: SheetExport) => void;
}> = ({ existing, google, connections = null, onClose, onSaved }) => {
  const [form, setForm] = useState<ExportFormState>(() => (existing ? exportFormFrom(existing) : emptyExportForm()));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<SheetCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const set = (patch: Partial<ExportFormState>) => setForm((f) => ({ ...f, ...patch }));
  const available = useMemo(() => exportableHeaders(existing?.columns?.headers || []), [existing]);
  const rows = columnRows(form.headers, available);
  const url = form.spreadsheetUrl.trim() ? checkSpreadsheetUrl(form.spreadsheetUrl) : null;
  const href = url?.ok ? spreadsheetHref(form.spreadsheetUrl) : '';
  const notConfigured = !!google && !sheetsAccessConfigured(google);
  const options = accessOptions(google, connections, form.auth);
  const connectionsLoading = !!google?.oauthConfigured && connections === null;

  // A new export gets the default access (first Active Google account, else the service account) once known.
  useEffect(() => {
    if (form.auth || !google || connectionsLoading) return;
    const d = defaultAuth(options);
    if (d) set({ auth: d });
  }, [form.auth, google, connectionsLoading, connections]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCheck = async () => {
    const u = checkSpreadsheetUrl(form.spreadsheetUrl);
    if (!u.ok) {
      setCheckError(u.error);
      return;
    }
    setCheckError('');
    setChecking(true);
    try {
      setCheck(await api.sheets.checkSheet({ spreadsheetUrl: form.spreadsheetUrl.trim(), ...(form.auth ? { auth: normalizeAuth(form.auth) } : {}) }));
    } catch (e) {
      setCheck(null);
      setCheckError(errMsg('sheets.checkSheet', e));
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    const { req, errors: errs } = exportFormToRequest(form);
    setErrors(errs);
    if (errs.length) return;
    setBusy(true);
    try {
      const saved = existing
        ? await api.sheets.updateExport(existing.id, {
            name: req.name, tab: req.tab, intervalMinutes: req.intervalMinutes, columns: req.columns,
            ...(req.auth && !sameAuth(existing.auth, req.auth) ? { auth: req.auth } : {}),
          })
        : await api.sheets.createExport(req);
      toast(existing ? 'Export saved' : 'Export created', saved.name, 'success');
      onSaved(saved);
    } catch (e) {
      setErrors([errMsg(existing ? 'sheets.updateExport' : 'sheets.createExport', e)]);
      setBusy(false);
    }
  };

  const idp = existing ? `shx-${existing.id}` : 'shx-new';

  return (
    <Modal
      open
      width="lg"
      onClose={onClose}
      title={existing ? `Edit export · ${existing.name}` : 'New export'}
      subtitle="A one-way copy of your leads into a Google Sheet tab, refreshed when the data changes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={existing ? <Save size={13} /> : <Plus size={13} />} loading={busy} disabled={notConfigured && !existing} onClick={submit}>
            {existing ? 'Save changes' : 'Create export'}
          </Button>
        </>
      }
    >
      <fieldset disabled={busy} className="space-y-4 min-w-0">
        {errors.length > 0 && (
          <div role="alert" className="p-3 rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] text-xs space-y-0.5">
            {errors.map((e) => <div key={e}>{e}</div>)}
          </div>
        )}
        {notConfigured && <InlineNotice tone="warning">{NOT_CONFIGURED_TEXT}</InlineNotice>}
        <InlineNotice>
          <b>The CRM is the master copy.</b> The tab is rewritten on every export, so edits made in the sheet are overwritten on the next export. Use another tab for your own notes or formulas.
        </InlineNotice>

        <div>
          <label htmlFor={`${idp}-name`} className={labelCls}>Name</label>
          <input id={`${idp}-name`} className={inputCls} value={form.name} maxLength={80} placeholder="e.g. Management leads report" onChange={(e) => set({ name: e.target.value })} />
        </div>

        {google && !notConfigured && (
          <AccessPicker
            id={`${idp}-access`}
            options={options}
            value={form.auth}
            forExport
            loading={connectionsLoading}
            onChange={(auth) => {
              set({ auth });
              setCheck(null);
            }}
          />
        )}

        <div>
          <label htmlFor={`${idp}-url`} className={labelCls}>Spreadsheet link</label>
          {existing ? (
            <div className="flex items-center gap-2 text-xs">
              <code id={`${idp}-url`} className="flex-1 min-w-0 break-all font-mono bg-[#F2F7FB] border border-[#D3E3F0] rounded-lg px-3 py-2 text-[#0B2A44]">{form.spreadsheetUrl}</code>
              {href && <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#0B6BB0] hover:underline whitespace-nowrap">Open <ExternalLink size={11} /></a>}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  id={`${idp}-url`}
                  className={cx(inputCls, url && !url.ok && 'border-[#B06A55]')}
                  value={form.spreadsheetUrl}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  aria-invalid={!!(url && !url.ok)}
                  aria-describedby={url && !url.ok ? `${idp}-url-err` : undefined}
                  onChange={(e) => {
                    set({ spreadsheetUrl: e.target.value });
                    setCheck(null);
                  }}
                />
                <Button size="sm" variant="primary" loading={checking} disabled={!url?.ok || notConfigured} onClick={runCheck}>Check access</Button>
              </div>
              {url && !url.ok && <div id={`${idp}-url-err`} className="text-[10px] text-[#8A3E28] mt-0.5">{url.error}</div>}
              {href && <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-[#0B6BB0] hover:underline mt-1">Open the sheet <ExternalLink size={11} /></a>}
            </>
          )}
          {existing && <div className="text-[10px] text-[#7E93A6] mt-1">To write to another spreadsheet, create a new export.</div>}
        </div>
        {checkError && <div role="alert" className="text-xs text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/40 rounded-lg p-2.5">{checkError}</div>}
        {check && <CheckResult result={check} needWrite />}

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${idp}-tab`} className={labelCls}>Tab</label>
            <input id={`${idp}-tab`} className={inputCls} value={form.tab} maxLength={100} placeholder={DEFAULT_EXPORT_TAB} list={check?.ok && check.tabs.length ? `${idp}-tabs` : undefined} onChange={(e) => set({ tab: e.target.value })} />
            {check?.ok && check.tabs.length > 0 && <datalist id={`${idp}-tabs`}>{check.tabs.map((t) => <option key={t} value={t} />)}</datalist>}
            <div className="text-[10px] text-[#7E93A6] mt-1">
              Created if it doesn’t exist.{check?.ok && check.tabs.includes(form.tab.trim() || DEFAULT_EXPORT_TAB) ? ' This tab exists — its contents will be replaced.' : ''}
            </div>
          </div>
          <div>
            <label htmlFor={`${idp}-interval`} className={labelCls}>Export</label>
            <Select id={`${idp}-interval`} value={String(form.intervalMinutes)} options={INTERVAL_SELECT_OPTIONS} onChange={(e) => set({ intervalMinutes: toSyncInterval(e.target.value) })} />
            <div className="text-[10px] text-[#7E93A6] mt-1">Only rewritten when leads changed. “Run now” works at any time.</div>
          </div>
        </div>

        <div role="group" aria-labelledby={`${idp}-cols-label`}>
          <div className="flex items-end justify-between gap-2 mb-1">
            <div id={`${idp}-cols-label`} className={cx(labelCls, 'mb-0')}>Columns <span className="normal-case font-semibold text-[#7E93A6]">({form.headers.length} chosen)</span></div>
            <Button size="xs" variant="ghost" onClick={() => set({ headers: [...DEFAULT_EXPORT_HEADERS] })}>Reset to defaults</Button>
          </div>
          <ul className="rounded-lg border border-[#D3E3F0] bg-white divide-y divide-[#E6EFF6] max-h-72 overflow-y-auto">
            {rows.map((r) => {
              const cbId = `${idp}-col-${r.header.replace(/[^A-Za-z0-9]+/g, '-')}`;
              return (
                <li key={r.header} className={cx('flex items-center gap-2 px-2.5 py-1.5 text-xs', r.checked ? 'text-[#0B2A44]' : 'text-[#5E778C]')}>
                  <input id={cbId} type="checkbox" className="accent-[#0B6BB0]" checked={r.checked} onChange={() => set({ headers: toggleHeader(form.headers, r.header) })} />
                  <label htmlFor={cbId} className={cx('flex-1 min-w-0 truncate cursor-pointer', r.checked && 'font-semibold')}>{r.header}</label>
                  {r.checked && (
                    <span className="flex items-center gap-0.5">
                      <Button size="xs" variant="ghost" aria-label={`Move ${r.header} up`} disabled={r.index === 0} icon={<ArrowUp size={11} />} onClick={() => set({ headers: moveHeader(form.headers, r.index, -1) })} />
                      <Button size="xs" variant="ghost" aria-label={`Move ${r.header} down`} disabled={r.index === form.headers.length - 1} icon={<ArrowDown size={11} />} onClick={() => set({ headers: moveHeader(form.headers, r.index, 1) })} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="text-[10px] text-[#7E93A6] mt-1">Ticked columns are written in this order, left to right.</div>
        </div>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs text-[#0F2233] cursor-pointer">
            <input type="checkbox" className="accent-[#0B6BB0] mt-0.5" checked={form.includeFollowups} onChange={(e) => set({ includeFollowups: e.target.checked })} />
            <span><b>Include follow-ups</b> — adds a “Follow-ups” column with all remarks of each lead.</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-[#0F2233] cursor-pointer">
            <input type="checkbox" className="accent-[#0B6BB0] mt-0.5" checked={form.includeTrash} onChange={(e) => set({ includeTrash: e.target.checked })} />
            <span><b>Include leads in Trash</b></span>
          </label>
        </div>
      </fieldset>
    </Modal>
  );
};
