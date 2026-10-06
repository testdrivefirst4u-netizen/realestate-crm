'use client';
import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, ExternalLink, FileKey2, FileSpreadsheet, RefreshCw, Settings2, UserRound } from 'lucide-react';
import type { CompanyDetail, PlatformActions, SheetExport, SyncInterval } from '@/server/platform/contract';
import type { GoogleConnection, SheetAuth } from '@/server/core/sheetTypes';
import { call, errorMessage, useResource } from '../../../_lib/api';
import { FEATURE_LABELS, fmtDateTime, fmtNum } from '../../../_lib/format';
import { normaliseFeatures } from '../../../_components/FeatureToggles';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, EmptyState, ErrorBox, Skeleton, StatusBadge, Table, TableSkeleton, cx, focusRing, td, th } from '../../../_components/ui';

/** `auth` is optional: rows without it (older links) use the service account. */
type SheetImportRow = PlatformActions['companySheets']['res']['imports'][number] & { auth?: SheetAuth };
type ConnectionMap = Map<string, GoogleConnection>;

export function intervalLabel(m: SyncInterval | number): string {
  if (!m) return 'Manual only';
  if (m === 60) return 'Every hour';
  return `Every ${m} min`;
}

/** Only https links are rendered (never javascript: or other schemes from stored data). */
function safeSheetUrl(url: string, spreadsheetId?: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.toString();
  } catch {
    /* fall through */
  }
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}` : '';
}

function SheetLink({ url, spreadsheetId, name }: { url: string; spreadsheetId?: string; name: string }) {
  const href = safeSheetUrl(url, spreadsheetId);
  if (!href) return <span className="text-[#7A6F64]">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cx('inline-flex items-center gap-1 rounded font-medium text-[#1D2F3F] underline-offset-2 hover:underline', focusRing)}
      aria-label={`Open the sheet of ${name} (opens in a new tab)`}
    >
      Open sheet <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function ResultText({ text, error }: { text: string; error?: boolean }) {
  if (!text) return <span className="text-[#7A6F64]">—</span>;
  return (
    <span className={cx('block max-w-[22rem] break-words text-[13px]', error ? 'text-[#912018]' : 'text-[#3B342E]')}>
      {error && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 -translate-y-px" aria-hidden />}
      {text}
    </span>
  );
}

function looksLikeError(result: string): boolean {
  return /error|fail|denied|not shared|permission|cannot|could not|invalid/i.test(result);
}

/** How an import/export reaches its sheet: a connected Google account (by e-mail) or the platform service account. */
function AccessMode({ auth, connections }: { auth?: SheetAuth; connections: ConnectionMap }) {
  if (auth?.mode === 'oauth') {
    const conn = connections.get(auth.connectionId);
    return (
      <span className="inline-flex min-w-0 items-start gap-1.5 text-[13px]">
        <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#A9825A]" aria-hidden />
        <span className="min-w-0">
          <span className="sr-only">Google account: </span>
          {conn ? (
            <span className="break-all text-[#14202B]">{conn.email}</span>
          ) : (
            <span className="text-[#912018]">Disconnected account</span>
          )}
          {conn?.status === 'Error' && <span className="block text-[12px] text-[#912018]">Connection error</span>}
          <span className="block font-mono text-[12px] text-[#7A6F64]">{auth.connectionId}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-[#3B342E]">
      <FileKey2 className="h-3.5 w-3.5 shrink-0 text-[#7A6F64]" aria-hidden />
      Service account
    </span>
  );
}

function ConnectionsTable({ rows }: { rows: GoogleConnection[] }) {
  return (
    <Table label="Connected Google accounts">
      <thead className="bg-[#FBF9F6]">
        <tr>
          <th scope="col" className={th}>Google account</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={th}>Last error</th>
          <th scope="col" className={th}>Connected by</th>
          <th scope="col" className={th}>Connected</th>
          <th scope="col" className={cx(th, 'text-right')}>Used by</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {rows.map((c) => (
          <tr key={c.id}>
            <td className={td}>
              <span className="font-medium break-all text-[#14202B]">{c.email || '—'}</span>
              <span className="block font-mono text-[12px] text-[#7A6F64]">{c.id}</span>
            </td>
            <td className={td}>
              <StatusBadge status={c.status} />
            </td>
            <td className={td}>
              <ResultText text={c.lastError} error />
            </td>
            <td className={td}>{c.connectedBy || '—'}</td>
            <td className={cx(td, 'whitespace-nowrap')}>{c.connectedAt ? fmtDateTime(c.connectedAt) : '—'}</td>
            <td className={cx(td, 'text-right tabular-nums whitespace-nowrap')}>
              {fmtNum(c.usedBy)} <span className="text-[#7A6F64]">{c.usedBy === 1 ? 'link' : 'links'}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ImportsTable({ rows, connections }: { rows: SheetImportRow[]; connections: ConnectionMap }) {
  return (
    <Table label="Google Sheet imports">
      <thead className="bg-[#FBF9F6]">
        <tr>
          <th scope="col" className={th}>Name</th>
          <th scope="col" className={th}>Access</th>
          <th scope="col" className={th}>Sheet</th>
          <th scope="col" className={th}>Tab</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={th}>Last sync</th>
          <th scope="col" className={th}>Last result</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {rows.map((r) => (
          <tr key={r.sourceId}>
            <td className={td}>
              <span className="font-medium text-[#14202B]">{r.name}</span>
              <span className="block font-mono text-[12px] text-[#7A6F64]">{r.sourceId}</span>
            </td>
            <td className={td}>
              <AccessMode auth={r.auth} connections={connections} />
            </td>
            <td className={td}>
              <SheetLink url={r.spreadsheetUrl} name={r.name} />
            </td>
            <td className={td}>{r.tab || <span className="text-[#7A6F64]">First tab</span>}</td>
            <td className={td}>
              <StatusBadge status={r.status} />
            </td>
            <td className={cx(td, 'whitespace-nowrap')}>{r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : 'Never'}</td>
            <td className={td}>
              <ResultText text={r.lastSyncResult} error={looksLikeError(r.lastSyncResult)} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ExportsTable({ rows, connections }: { rows: SheetExport[]; connections: ConnectionMap }) {
  return (
    <Table label="Google Sheet exports">
      <thead className="bg-[#FBF9F6]">
        <tr>
          <th scope="col" className={th}>Name</th>
          <th scope="col" className={th}>Access</th>
          <th scope="col" className={th}>Sheet</th>
          <th scope="col" className={th}>Tab</th>
          <th scope="col" className={th}>Interval</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={th}>Last sync</th>
          <th scope="col" className={cx(th, 'text-right')}>Rows</th>
          <th scope="col" className={th}>Last error</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {rows.map((x) => (
          <tr key={x.id}>
            <td className={td}>
              <span className="font-medium text-[#14202B]">{x.name}</span>
              <span className="block font-mono text-[12px] text-[#7A6F64]">{x.id}</span>
            </td>
            <td className={td}>
              <AccessMode auth={x.auth} connections={connections} />
            </td>
            <td className={td}>
              <SheetLink url={x.spreadsheetUrl} spreadsheetId={x.spreadsheetId} name={x.name} />
            </td>
            <td className={td}>{x.tab || '—'}</td>
            <td className={cx(td, 'whitespace-nowrap')}>{intervalLabel(x.intervalMinutes)}</td>
            <td className={td}>
              <StatusBadge status={x.status} />
            </td>
            <td className={cx(td, 'whitespace-nowrap')}>{x.lastSyncAt ? fmtDateTime(x.lastSyncAt) : 'Never'}</td>
            <td className={cx(td, 'text-right tabular-nums')}>{x.lastSyncAt ? fmtNum(x.lastRows) : '—'}</td>
            <td className={td}>
              <ResultText text={x.lastError} error />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SubHeading({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <h3 id={id} className="flex items-center gap-2 px-5 pb-2 pt-4 text-[13px] font-semibold uppercase tracking-wide text-[#6B6158]">
      {title}
      {typeof count === 'number' && <span className="rounded-full bg-[#F4EEE7] px-2 py-0.5 text-[12px] font-medium normal-case tracking-normal text-[#6B4F33]">{count}</span>}
    </h3>
  );
}

/** Company detail → Integrations: the company's Google Sheet imports and exports (read-only overview). */
export function SheetsSection({ company, onSaved }: { company: CompanyDetail; onSaved: (c: CompanyDetail) => void }) {
  const toast = useToast();
  const uid = useId();
  const sheets = useResource(() => call('companySheets', { companyId: company.id }), [company.id]);
  const google = useResource(() => call('getGoogleSettings', {}), []);
  const [enabling, setEnabling] = useState(false);
  const [featureError, setFeatureError] = useState('');

  const featureOn = company.features?.googleSheets === true;
  const imports: SheetImportRow[] = sheets.data?.imports || [];
  const exports = sheets.data?.exports || [];
  const connections = useMemo(() => sheets.data?.connections || [], [sheets.data]);
  const connectionMap = useMemo<ConnectionMap>(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const g = google.data;
  const noCredentials = g ? !g.configured && !g.oauthConfigured : false;

  const enable = async () => {
    setEnabling(true);
    setFeatureError('');
    try {
      const updated = await call('updateCompany', { id: company.id, patch: { features: { ...normaliseFeatures(company.features), googleSheets: true } } });
      onSaved(updated);
      toast(`${FEATURE_LABELS.googleSheets} switched on.`);
    } catch (e) {
      setFeatureError(errorMessage(e));
    } finally {
      setEnabling(false);
    }
  };

  const reload = () => {
    sheets.reload();
    google.reload();
  };

  return (
    <Card aria-labelledby={`${uid}-gs`}>
      <CardHeader
        id={`${uid}-gs`}
        title="Google Sheets"
        description="Leads imported from and exported to Google Sheets. The company links its sheets in CRM settings; syncs run every few minutes."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={reload}
            loading={(sheets.loading && Boolean(sheets.data)) || (google.loading && Boolean(google.data))}
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            aria-label="Refresh Google Sheets"
          >
            Refresh
          </Button>
        }
      />

      <div className="space-y-3 px-5 pt-4">
        {/* Plan feature state */}
        {featureOn ? (
          <p className="flex items-center gap-2 text-[13.5px] text-[#3B342E]">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#067647]" aria-hidden />
            Plan feature “{FEATURE_LABELS.googleSheets}”: <span className="font-medium text-[#067647]">on for this company</span>
          </p>
        ) : (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[14px] text-[#93370D]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p>{FEATURE_LABELS.googleSheets} is switched off for this company — its sheet imports and exports do not run.</p>
              <ErrorBox message={featureError} className="mt-2" />
            </div>
            <Button size="sm" variant="secondary" loading={enabling} onClick={enable}>
              Switch it on
            </Button>
          </div>
        )}

        {/* Platform credentials */}
        {google.loading && !google.data ? (
          <Skeleton className="h-5 w-72" />
        ) : google.error ? (
          <ErrorBox message={`Could not check the platform Google account: ${google.error}`} onRetry={google.reload} />
        ) : noCredentials ? (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-4 py-3 text-[14px] text-[#912018]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              The platform has neither a Google OAuth client (“Connect with Google”) nor a service account yet, so no company can import from or export to Google Sheets.
            </p>
            <Link
              href="/superadmin/settings"
              className={cx('inline-flex items-center gap-1.5 rounded font-medium text-[#912018] underline underline-offset-2', focusRing)}
            >
              <Settings2 className="h-4 w-4" aria-hidden /> Set it up in Platform settings
            </Link>
          </div>
        ) : g ? (
          <ul className="space-y-1 text-[13px] text-[#6B6158]">
            <li>
              Connect with Google:{' '}
              {g.oauthConfigured ? (
                <span className="text-[#3B342E]">available — company admins sign in with their own Google account.</span>
              ) : (
                <span>not set up on the platform.</span>
              )}
            </li>
            <li>
              Service account:{' '}
              {g.configured && g.serviceAccountEmail ? (
                <>
                  sheets are shared with <span className="font-mono text-[#26211E] break-all">{g.serviceAccountEmail}</span> (Viewer to import, Editor to export).
                </>
              ) : (
                <span>not set up on the platform.</span>
              )}
            </li>
          </ul>
        ) : null}
      </div>

      <ErrorBox message={sheets.error} onRetry={sheets.reload} className="mx-5 mt-4" />

      {sheets.loading && !sheets.data ? (
        <div className="pb-2 pt-2">
          <TableSkeleton rows={2} cols={5} />
        </div>
      ) : sheets.data && imports.length === 0 && exports.length === 0 && connections.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet className="h-5 w-5" aria-hidden />}
          title="No Google Sheets linked"
          description="The company's administrators connect sheets for importing or exporting leads in CRM settings → Integrations."
        />
      ) : sheets.data ? (
        <div className={cx('pb-2 transition-opacity', sheets.loading && 'opacity-60')}>
          <section aria-labelledby={`${uid}-con`}>
            <SubHeading id={`${uid}-con`} title="Connected Google accounts" count={connections.length} />
            {connections.length ? (
              <ConnectionsTable rows={connections} />
            ) : (
              <p className="px-5 pb-3 text-[13.5px] text-[#7A6F64]">No Google account connected. Sheets are reached through the platform service account only.</p>
            )}
          </section>
          <section aria-labelledby={`${uid}-imp`} className="border-t border-[#EFE9E2]">
            <SubHeading id={`${uid}-imp`} title="Imports" count={imports.length} />
            {imports.length ? (
              <ImportsTable rows={imports} connections={connectionMap} />
            ) : (
              <p className="px-5 pb-3 text-[13.5px] text-[#7A6F64]">No sheet imports. Leads are not pulled from any sheet.</p>
            )}
          </section>
          <section aria-labelledby={`${uid}-exp`} className="border-t border-[#EFE9E2]">
            <SubHeading id={`${uid}-exp`} title="Exports" count={exports.length} />
            {exports.length ? (
              <ExportsTable rows={exports} connections={connectionMap} />
            ) : (
              <p className="px-5 pb-3 text-[13.5px] text-[#7A6F64]">No sheet exports. Leads are not copied to any sheet.</p>
            )}
          </section>
        </div>
      ) : (
        <div className="pb-4" />
      )}
    </Card>
  );
}
