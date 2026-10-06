import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, History, RefreshCw, Search } from 'lucide-react';
import { api } from '../../core/api';
import { formatDateTime } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { Button, Card, EmptyState, ErrorState, LoadingState, Select, inputCls } from '../../components/ui';

/** Row shape returned by `getAuditLog`. */
export interface AuditRow {
  id: string;
  timestamp: string;
  user: string;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
}

const FETCH_LIMIT = 300;
const PAGE = 50;
const KNOWN_TYPES = ['Lead', 'Task', 'Inventory', 'Import', 'Export', 'Auth', 'Settings', 'Developer', 'Document', 'Call', 'Chat', 'Segment', 'System'];

function entityTone(type: string): string {
  switch (type) {
    case 'Lead':
      return 'bg-[#1D2F3F]';
    case 'Settings':
    case 'Developer':
      return 'bg-[#8A3E28]';
    case 'Task':
      return 'bg-[#4A6B53]';
    case 'Auth':
      return 'bg-[#A9825A]';
    case 'Import':
    case 'Export':
      return 'bg-[#6B5F57]';
    default:
      return 'bg-[#9E948D]';
  }
}

export const AuditLogsView: React.FC = () => {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.settings.audit(FETCH_LIMIT);
      setRows(
        (Array.isArray(data) ? data : []).map((r: any, i: number): AuditRow => ({
          id: String(r.id || `${r.timestamp || ''}-${i}`),
          timestamp: String(r.timestamp || ''),
          user: String(r.user || ''),
          role: String(r.role || ''),
          action: String(r.action || ''),
          entityType: String(r.entityType || ''),
          entityId: String(r.entityId || ''),
          details: String(r.details || ''),
        }))
      );
    } catch (e) {
      const err = reportError('audit.load', e);
      setError(toAppError(err).userMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => setLimit(PAGE), [query, type]);

  const types = useMemo(() => {
    const set = new Set<string>(KNOWN_TYPES);
    (rows || []).forEach((r) => r.entityType && set.add(r.entityType));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (type && r.entityType !== type) return false;
      if (!q) return true;
      return r.user.toLowerCase().includes(q) || r.action.toLowerCase().includes(q) || r.details.toLowerCase().includes(q) || r.entityId.toLowerCase().includes(q) || r.role.toLowerCase().includes(q);
    });
  }, [rows, query, type]);

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Audit Trail</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">Who changed what — leads, settings, users, code deployments and sign-ins (latest {FETCH_LIMIT} entries)</p>
        </div>
        <Button variant="secondary" onClick={load} loading={loading} icon={<RefreshCw size={13} />}>Refresh</Button>
      </div>

      <div className="bg-[#EDE8E0] p-3 sm:p-4 rounded-xl border border-[#D2C9BF] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-[260px] max-w-xl">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9E948D]" />
            <input type="text" placeholder="Search user, action, entity ID or details…" value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputCls} !pl-8`} />
          </div>
          <Select value={type} onChange={(e) => setType(e.target.value)} options={types} placeholder="All entity types" className="!w-auto" />
        </div>
        <span className="text-xs text-[#6B5F57] font-medium">{filtered.length} logged action{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {rows === null && loading ? (
        <LoadingState label="Loading the audit log…" />
      ) : error && !rows ? (
        <ErrorState title="Could not load the audit log" message={error} onRetry={load} />
      ) : rows && rows.length === 0 ? (
        <Card>
          <EmptyState icon={<History size={22} />} title="No audit entries yet" description="Actions such as creating enquiries, changing settings or signing in are recorded here automatically." />
        </Card>
      ) : (
        <Card padded={false}>
          {error && <div className="p-3"><ErrorState compact title="Refresh failed" message={error} onRetry={load} /></div>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#EDE8E0] border-b border-[#D2C9BF] text-[10px] uppercase tracking-wider text-[#6B5F57] font-bold">
                  <th className="p-3">Timestamp</th>
                  <th className="p-3">User</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Entity</th>
                  <th className="p-3">Action</th>
                  <th className="p-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ECE8E1]">
                {visible.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-[#9E948D]">No entries match your search.</td></tr>
                ) : visible.map((log) => (
                  <tr key={log.id} className="hover:bg-[#F4F0EB] transition align-top">
                    <td className="p-3 text-[#6B5F57] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1"><Clock size={11} className="text-[#9E948D]" />{formatDateTime(log.timestamp, '—')}</span>
                    </td>
                    <td className="p-3 font-bold text-[#1D2F3F] whitespace-nowrap">{log.user || '—'}</td>
                    <td className="p-3 text-[#6B5F57] whitespace-nowrap">{log.role || '—'}</td>
                    <td className="p-3 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-[#3D3530]">
                        <span className={`w-2 h-2 rounded-full ${entityTone(log.entityType)}`} aria-hidden="true" />
                        {log.entityType || '—'}
                      </span>
                    </td>
                    <td className="p-3 font-semibold text-[#A9825A] whitespace-nowrap">{log.action}</td>
                    <td className="p-3 text-[#3D3530] leading-relaxed break-words max-w-md">
                      {log.details}
                      {log.entityId && <span className="ml-2 font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#F4F0EB] text-[#1D2F3F]">{log.entityId}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > visible.length && (
            <div className="p-3 border-t border-[#ECE8E1] text-center">
              <Button variant="secondary" size="xs" onClick={() => setLimit((n) => n + PAGE)}>Show more ({filtered.length - visible.length} remaining)</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
