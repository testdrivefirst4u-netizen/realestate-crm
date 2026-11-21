/**
 * Settings › Integration health (server: modules/connectorHealth.ts). One at-a-glance panel showing the live state of
 * every integration — lead-in connectors (Facebook lead forms, WhatsApp, Chat360, telephony, JustConnect) and the
 * conversion-out connectors (Meta CAPI, Google Ads / GA4) — with what is wrong and the exact next step to fix it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, TriangleAlert, XCircle, CircleSlash, PlugZap } from 'lucide-react';
import { api, type ConnectorHealth, type ConnectorState } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, EmptyState } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

const META: Record<ConnectorState, { label: string; fg: string; bg: string; Icon: typeof CheckCircle2 }> = {
  connected: { label: 'Working', fg: '#067647', bg: '#E7F6EF', Icon: CheckCircle2 },
  needs_reconnect: { label: 'Needs reconnect', fg: '#B42318', bg: '#FEECEB', Icon: XCircle },
  degraded: { label: 'Degraded', fg: '#B54708', bg: '#FEF0C7', Icon: TriangleAlert },
  not_configured: { label: 'Not set up', fg: '#5E778C', bg: '#EEF4F9', Icon: CircleSlash },
  disconnected: { label: 'Turned off', fg: '#5E778C', bg: '#EEF4F9', Icon: CircleSlash },
};

const when = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

export const IntegrationHealthSection: React.FC = () => {
  const [rows, setRows] = useState<ConnectorHealth[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (manual?: boolean) => {
    setBusy(true);
    try {
      setRows(await api.connectedAccounts.health());
      if (manual) toast('Integration health refreshed', undefined, 'success');
    } catch (e) {
      setRows([]);
      toast('Could not load integration health', errText('connectorHealth', e), 'alert');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const attention = (rows || []).filter((r) => r.state === 'needs_reconnect' || r.state === 'degraded').length;
  const working = (rows || []).filter((r) => r.state === 'connected').length;

  return (
    <div className="space-y-5">
      <Card
        title={<span className="inline-flex items-center gap-2"><PlugZap size={16} className="text-[#0B6BB0]" /> Integration health</span>}
        subtitle="Live status of every connected service — what is working, what needs attention, and the exact step to fix it. Read from what each connector last recorded; opening this makes no calls to Facebook, Google or your phone system."
        actions={<Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />} loading={busy && rows !== null} onClick={() => void load(true)}>Refresh</Button>}
      >
        {rows === null ? (
          <p className="text-xs text-[#5E778C]">Loading…</p>
        ) : !rows.length ? (
          <EmptyState title="No integrations switched on" description="When a lead source, WhatsApp, telephony or an ad-conversion feature is enabled for your plan, its health shows here." />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-[11px] font-medium">
              <span className="inline-flex items-center gap-1 rounded-full bg-[#E7F6EF] px-2.5 py-1 text-[#067647]"><CheckCircle2 size={12} /> {working} working</span>
              {attention > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-[#FEF0C7] px-2.5 py-1 text-[#B54708]"><TriangleAlert size={12} /> {attention} need attention</span>}
            </div>
            <ul className="divide-y divide-[#EEF4F9]">
              {rows.map((r, i) => {
                const m = META[r.state];
                return (
                  <li key={`${r.id}-${i}`} className="py-3 flex flex-wrap gap-3">
                    <m.Icon size={18} className="mt-0.5 flex-none" style={{ color: m.fg }} />
                    <div className="min-w-0 flex-1 text-xs text-[#2B4A63] space-y-1">
                      <p className="text-sm text-[#0B2A44] flex flex-wrap items-center gap-2">
                        <b>{r.name}</b>
                        <span className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ color: m.fg, background: m.bg }}>{m.label}</span>
                        {r.identity && <span className="text-[#5E778C] font-normal">· {r.identity}</span>}
                      </p>
                      {r.detail && <p className={r.state === 'connected' ? 'text-[#7E93A6]' : 'text-[#B54708]'}>{r.detail}</p>}
                      {r.action && <p className="text-[#2B4A63]"><span className="font-semibold">Fix:</span> {r.action}</p>}
                      <p className="text-[#7E93A6]">
                        {r.lastEventAt ? `Last event ${when(r.lastEventAt)}` : 'No events recorded yet'}
                        {r.failing > 0 ? ` · ${r.failing} failing` : ''}
                        {r.deadLetters > 0 ? ` · ${r.deadLetters} dead-lettered` : ''}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>
      <p className="text-[11px] text-[#7E93A6] px-1">“Needs reconnect” means credentials expired or were revoked — only a person can fix it (reconnect in that service’s settings). “Degraded” means it is connected but recent deliveries are failing.</p>
    </div>
  );
};
