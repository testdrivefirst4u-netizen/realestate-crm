/**
 * Settings › Roles & access (server: modules/roleAccess.ts): an Admin ticks what each role can do. Admins always keep everything,
 * so a company can't lock itself out, and settings, keys and managing users are not offered.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { ACCESS_ITEMS, CONFIGURABLE_ROLES, itemDefault, itemOffered, itemOn, type ConfigurableRole, type RoleAccessConfig } from '../../core/roleAccess';
import { Button, Card, InlineNotice } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const RolesSection: React.FC = () => {
  const [config, setConfig] = useState<RoleAccessConfig | null>(null);
  const [saved, setSaved] = useState('');
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.roles.get().then((r) => { setConfig(r.config); setSaved(JSON.stringify(r.config)); }).catch((e) => setFailed(errText('roles.get', e)));
  }, []);

  const groups = useMemo(() => [...new Set(ACCESS_ITEMS.map((i) => i.group))], []);
  const dirty = !!config && JSON.stringify(config) !== saved;
  const toggle = (role: ConfigurableRole, id: string, on: boolean) => setConfig((c) => ({ ...(c || {}), [role]: { ...(c?.[role] || {}), [id]: on } }));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.roles.save(config || {});
      setConfig(r.config);
      setSaved(JSON.stringify(r.config));
      toast('Roles saved', 'People see the change when they next open or reload a page.', 'success');
    } catch (e) {
      toast('Not saved', errText('roles.save', e), 'alert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} className="text-[#0B6BB0]" /> Roles &amp; access</span>}
      subtitle="Choose what each role can do. Admins always have everything. Settings, connected accounts and managing users can't be given to other roles.">
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {!config && !failed && <p className="p-6 text-center text-xs text-[#5E778C]">Loading…</p>}
      {config && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-xs text-[#0B2A44]">
              <thead>
                <tr className="border-b border-[#D3E3F0] text-[#5E778C]">
                  <th scope="col" className="p-2 text-left font-medium">Access</th>
                  {CONFIGURABLE_ROLES.map((r) => <th key={r.id} scope="col" className="w-24 p-2 text-center font-medium">{r.label}</th>)}
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g} className="divide-y divide-[#EEF4F9]">
                  <tr><th scope="colgroup" colSpan={1 + CONFIGURABLE_ROLES.length} className="bg-[#F7FBFE] p-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[#2B4A63]">{g}</th></tr>
                  {ACCESS_ITEMS.filter((i) => i.group === g).map((item) => (
                    <tr key={item.id}>
                      <th scope="row" className="p-2 text-left font-normal">{item.label}{item.note && <span className="block text-[11px] text-[#5E778C]">{item.note}</span>}</th>
                      {CONFIGURABLE_ROLES.map((r) => {
                        const needOff = !!item.needs && !itemOn(r.id, ACCESS_ITEMS.find((x) => x.id === item.needs)!, config[r.id]);
                        const offered = itemOffered(r.id, item);
                        return (
                          <td key={r.id} className="p-2 text-center">
                            {offered
                              ? <input type="checkbox" className="h-4 w-4 accent-[#0B2A44] disabled:opacity-40" aria-label={`${item.label}: ${r.label}`} disabled={needOff} checked={itemOn(r.id, item, config[r.id])} onChange={(e) => toggle(r.id, item.id, e.target.checked)} title={needOff ? 'Turn on what this depends on first' : itemDefault(r.id, item) ? 'On by default' : 'Off by default'} />
                              : <span className="text-[#9AA9B5]" title="View only users can't change anything">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <p className="mt-3 text-[11px] text-[#5E778C]">Everything except Screens is enforced on the server. Screens only hides that page from the menu and its address, so also turn off "See all leads" if someone mustn't see lead data.</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={() => setConfig({})}>Back to defaults</Button>
            <Button variant="primary" size="sm" icon={<Save size={13} />} loading={busy} disabled={!dirty} onClick={() => void save()}>Save</Button>
          </div>
        </>
      )}
    </Card>
  );
};
