/**
 * Settings › Integrations › Read-only API (server: modules/dataApi.ts). An admin issues a revocable, read-only API key
 * for an external dashboard to pull CRM data (no login, no write, no customer phone/e-mail), and sees the endpoints.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plug, Trash2, TriangleAlert } from 'lucide-react';
import { api, type ReadKeyRow } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, EmptyState, InlineNotice } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const when = (s: string) => (s ? new Date(s).toLocaleString() : '—');

const ENDPOINTS = [
  ['GET /api/v1/leads', 'source, stage, owner, created/updated dates, site-visit + booking dates'],
  ['GET /api/v1/site-visits', 'lead, date, status, owner'],
  ['GET /api/v1/bookings', 'unit, value, date, status, lead'],
  ['GET /api/v1/tasks', 'lead, due date, owner, status'],
  ['GET /api/v1/users', 'id, name, role, active (no phone / e-mail)'],
];

export const DataApiSection: React.FC = () => {
  const [rows, setRows] = useState<ReadKeyRow[] | null>(null);
  const [label, setLabel] = useState('Dashboard');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string>(''); // the plaintext key, shown once after creation

  const load = useCallback(async () => {
    try { setRows(await api.dataApi.keys()); } catch (e) { setRows([]); toast('Could not load keys', errText('dataApi.keys', e), 'alert'); }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    setBusy(true);
    try {
      const { key } = await api.dataApi.createKey(label.trim() || 'Dashboard');
      setFresh(key);
      await load();
    } catch (e) {
      toast('Could not create key', errText('dataApi.create', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (r: ReadKeyRow) => {
    if (!window.confirm(`Revoke "${r.label || r.prefix}"? Any dashboard using it stops working at once. This cannot be undone.`)) return;
    try { setRows(await api.dataApi.revokeKey(r.id)); toast('Key revoked', undefined, 'success'); } catch (e) { toast('Could not revoke', errText('dataApi.revoke', e), 'alert'); }
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => toast('Copied', undefined, 'success')).catch(() => {}); };

  const base = typeof window !== 'undefined' ? window.location.origin : 'https://realestate-crm.broaddcast.com';

  return (
    <div className="space-y-5">
      <Card
        title={<span className="inline-flex items-center gap-2"><Plug size={16} className="text-[#0B6BB0]" /> Read-only API</span>}
        subtitle="Give an external dashboard read-only access to your CRM data without a login. These keys can only read — never create, edit or delete — and never include customer phone numbers or e-mails. Revoke a key any time to switch its access off on its own."
        actions={<div className="flex items-center gap-2"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Weekly dashboard" aria-label="Key name" className="h-8 w-40 rounded-lg border border-[#C7D8E8] px-2.5 text-xs" /><Button variant="primary" size="sm" icon={<KeyRound size={13} />} loading={busy} onClick={() => void create()}>Create key</Button></div>}
      >
        {fresh && (
          <InlineNotice tone="warning">
            <div className="space-y-1.5">
              <p className="font-semibold">Copy this key now — it is shown only once.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-[12px] text-[#0B2A44] border border-[#E3EDF5]">{fresh}</code>
                <Button size="xs" variant="secondary" icon={<Copy size={12} />} onClick={() => copy(fresh)}>Copy</Button>
                <Button size="xs" variant="secondary" onClick={() => setFresh('')}>Done</Button>
              </div>
            </div>
          </InlineNotice>
        )}
        {rows === null ? <p className="text-xs text-[#5E778C]">Loading…</p> : !rows.length ? (
          <EmptyState title="No keys yet" description="Create a key above, then give it to your dashboard team with the base URL and endpoints below." icon={<KeyRound size={18} />} />
        ) : (
          <ul className="divide-y divide-[#EEF4F9]">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <KeyRound size={15} className="text-[#5E778C]" />
                <div className="min-w-0 flex-1 text-xs text-[#2B4A63]">
                  <p className="text-sm text-[#0B2A44]"><b>{r.label || 'Key'}</b> <span className="font-mono text-[#5E778C]">{r.prefix}…</span></p>
                  <p className="text-[#7E93A6]">Created {when(r.createdAt)} · Last used {when(r.lastUsedAt)}</p>
                </div>
                <Button size="sm" variant="secondary" icon={<Trash2 size={13} />} onClick={() => void revoke(r)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="How to use it" subtitle="Base URL, headers, endpoints, and an example — share this one card with the dashboard team.">
        <div className="space-y-3 text-[12.5px] text-[#2B4A63]">
          <p><span className="font-semibold text-[#0B2A44]">Base URL:</span> <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">{base}</code></p>
          <p><span className="font-semibold text-[#0B2A44]">Auth:</span> send the key as <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">Authorization: Bearer &lt;key&gt;</code> (or <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">X-Api-Key</code>).</p>
          <p><span className="font-semibold text-[#0B2A44]">Query params:</span> <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">updatedSince=&lt;ISO&gt;</code> (only what changed), <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">limit</code> (≤500) and <code className="rounded bg-[#F2F7FB] px-1.5 py-0.5">cursor</code> (from the previous page's <code>nextCursor</code>).</p>
          <p><span className="font-semibold text-[#0B2A44]">Rate limit:</span> 60 requests / minute.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-[12px]">
              <tbody className="divide-y divide-[#EEF4F9]">
                {ENDPOINTS.map(([ep, what]) => (
                  <tr key={ep}><td className="py-1.5 pr-3 font-mono text-[#0B5E9C] whitespace-nowrap">{ep}</td><td className="py-1.5 text-[#5E778C]">{what}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-[#0B1A2B] p-3 text-[11.5px] leading-relaxed text-[#CFE3F5]">{`curl "${base}/api/v1/leads?updatedSince=2026-11-01T00:00:00Z&limit=200" \\
  -H "Authorization: Bearer <your-key>"

{ "data": [ { "id": "LEAD-00421", "source": "Website", "stage": "Qualified",
    "owner": "Priya Sharma", "createdAt": "2026-10-28T09:12:00Z",
    "updatedAt": "2026-11-03T14:40:00Z", "siteVisitStatus": "done" } ],
  "nextCursor": "eyJ1Ijoi…", "hasMore": true }`}</pre>
          <p className="inline-flex items-start gap-1.5 text-[11px] text-[#7E93A6]"><TriangleAlert size={13} className="mt-0.5 flex-none text-[#B54708]" /> Tasks are filtered by created date (they have no updated date). Users return the full list (small, no paging). No customer phone or e-mail is ever returned.</p>
        </div>
      </Card>
    </div>
  );
};
