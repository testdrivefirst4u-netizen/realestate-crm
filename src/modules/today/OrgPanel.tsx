/**
 * Team › Organisation (admins): the five levels and where each person sits — level, who they report to, and for a
 * manager whether they see every lead or only their team's. Changes apply on the person's next request.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import type { OrgPerson } from '../../core/journeyTypes';
import { Button, InlineNotice, Select, cx, inputCls } from '../../components/ui';

const ROLE: Record<string, string> = { Admin: 'Admin', Manager: 'Manager', RM: 'Agent', Viewer: 'View only' };

export const OrgPanel: React.FC = () => {
  const [levels, setLevels] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [people, setPeople] = useState<OrgPerson[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const apply = (r: { levels: string[]; people: OrgPerson[] }) => {
    setLevels(r.levels);
    setDraft(r.levels);
    setPeople(r.people);
  };
  const load = useCallback(async () => {
    try {
      apply(await api.org.get());
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const place = async (p: OrgPerson, patch: Partial<OrgPerson>) => {
    const next = { ...p, ...patch };
    setBusy(p.id);
    setMsg(null);
    try {
      apply(await api.org.place({ userId: p.id, level: next.level, reportsTo: next.reportsTo, leadScope: next.leadScope }));
      setMsg({ tone: 'success', text: `${p.name} updated.` });
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
    } finally {
      setBusy('');
    }
  };
  if (!people) return <div className="h-24 rounded-xl bg-white/70 animate-pulse" aria-label="Loading organisation" />;
  const active = people.filter((p) => p.status === 'Active');

  return (
    <section aria-labelledby="h-org" className="space-y-3">
      <h2 id="h-org" className="text-sm font-bold text-[#0B2A44]">Organisation</h2>
      {msg && <InlineNotice tone={msg.tone}>{msg.text}</InlineNotice>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        setBusy('levels');
        try {
          apply(await api.org.saveLevels(draft.map((s) => s.trim()).filter(Boolean)));
          setMsg({ tone: 'success', text: 'Levels saved.' });
        } catch (err) {
          setMsg({ tone: 'warning', text: toAppError(err).userMessage });
        } finally {
          setBusy('');
        }
      }}>
        {Array.from({ length: 5 }, (_, i) => (
          <label key={i} className="text-[11px] text-[#5E778C] w-40">Level {i + 1}{i === 0 ? ' (most senior)' : ''}
            <input value={draft[i] || ''} onChange={(e) => setDraft(Object.assign([...draft], { [i]: e.target.value }))} className={cx(inputCls, 'mt-1')} placeholder={i >= draft.length ? 'not used' : ''} />
          </label>
        ))}
        <Button type="submit" size="sm" variant="secondary" loading={busy === 'levels'}>Save levels</Button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[#E3EDF5] bg-white">
        <table className="w-full text-xs">
          <thead className="text-left text-[#5E778C]">
            <tr className="border-b border-[#EEF3F8]"><th scope="col" className="px-3 py-2 font-semibold">Person</th><th scope="col" className="px-3 py-2 font-semibold">Level</th><th scope="col" className="px-3 py-2 font-semibold">Reports to</th><th scope="col" className="px-3 py-2 font-semibold">Sees</th></tr>
          </thead>
          <tbody>
            {active.map((p) => (
              <tr key={p.id} className={cx('border-b last:border-0 border-[#EEF3F8]', busy === p.id && 'opacity-60')}>
                <th scope="row" className="px-3 py-2 text-left"><span className="font-semibold text-[#0B2A44]">{p.name}</span> <span className="text-[10px] text-[#7E93A6]">{ROLE[p.role] || p.role}</span></th>
                <td className="px-3 py-2 w-48"><Select aria-label={`Level of ${p.name}`} value={p.level ? String(p.level) : ''} onChange={(e) => place(p, { level: e.target.value ? Number(e.target.value) : null })} options={[{ value: '', label: 'Not placed' }, ...levels.map((l, i) => ({ value: String(i + 1), label: `${i + 1} · ${l}` }))]} /></td>
                <td className="px-3 py-2 w-52"><Select aria-label={`${p.name} reports to`} value={p.reportsTo} onChange={(e) => place(p, { reportsTo: e.target.value })} options={[{ value: '', label: 'Nobody' }, ...active.filter((x) => x.id !== p.id && x.role !== 'Viewer').map((x) => ({ value: x.id, label: `${x.name}${x.level ? ` · ${levels[x.level - 1]}` : ''}` }))]} /></td>
                <td className="px-3 py-2 w-48">
                  {p.role === 'Manager' ? (
                    <Select aria-label={`What ${p.name} sees`} value={p.leadScope} onChange={(e) => place(p, { leadScope: e.target.value as 'team' | 'all' })} options={[{ value: 'all', label: 'Every lead' }, { value: 'team', label: 'Their team only' }]} />
                  ) : <span className="text-[#7E93A6]">{p.role === 'RM' ? 'Their own leads' : 'Every lead'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[#5E778C]">Someone can only report to a more senior level. A manager limited to their team sees their own leads, their team's and unassigned ones, and only their team on this screen.</p>
    </section>
  );
};
