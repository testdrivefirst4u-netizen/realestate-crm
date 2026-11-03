/**
 * The events sent to ad platforms and the steps that send them (shared by Meta and Google; server:
 * saveConversionRules in modules/adConversions.ts).
 */
import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api, type AdConversionRule } from '../../core/api';
import { SITE_VISIT } from '../../core/config';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, inputCls } from '../../components/ui';

export const ConversionRulesCard: React.FC<{ editable: boolean; stageOptions: string[]; onSaved?: (rules: AdConversionRule[]) => void; subtitle?: string }> = ({ editable, stageOptions, onSaved, subtitle }) => {
  const [rules, setRules] = useState<AdConversionRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    api.conversionRules.get().then((r) => live && setRules(r.rules), (e) => toast('Could not load the events', toAppError(reportError('conversionRules.get', e)).userMessage, 'alert'));
    return () => { live = false; };
  }, []);
  const setRule = (i: number, patch: Partial<AdConversionRule>) => setRules((rs) => (rs || []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const choices = (when: AdConversionRule['when']): Array<[string, string]> =>
    when === 'stage'
      ? stageOptions.filter((s) => s !== 'Trash' && s !== 'Permanently Deleted').map((s) => [s, s])
      : [['done', 'Done (Completed or Walk-In)'], ...Object.values(SITE_VISIT).map((s): [string, string] => [s, s])];
  const save = async () => {
    if (!rules) return;
    setSaving(true);
    try {
      const r = await api.conversionRules.save(rules);
      setRules(r.rules);
      onSaved?.(r.rules);
      toast('Events saved', undefined, 'success');
    } catch (e) {
      toast('Could not save the events', toAppError(reportError('conversionRules.save', e)).userMessage, 'alert');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="What is sent, and when" subtitle={subtitle || 'The same events go to every ad platform that is switched on.'}>
      {!rules ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.3fr)_36px] items-center">
              <input className={inputCls} aria-label="Event name" value={r.event} maxLength={40} disabled={!editable} onChange={(e) => setRule(i, { event: e.target.value })} />
              <select className={inputCls} aria-label="When" value={r.when} disabled={!editable} onChange={(e) => setRule(i, { when: e.target.value as AdConversionRule['when'], value: '' })}>
                <option value="stage">Lead stage is</option>
                <option value="siteVisit">Site visit is</option>
              </select>
              <select className={inputCls} aria-label="Value" value={r.value} disabled={!editable} onChange={(e) => setRule(i, { value: e.target.value })}>
                <option value="">Choose…</option>
                {choices(r.when).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              {editable && <button type="button" aria-label={`Remove ${r.event}`} onClick={() => setRules((rs) => (rs || []).filter((_, j) => j !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-[#9A3412] hover:bg-[#FDF2EC]"><Trash2 size={14} /></button>}
            </div>
          ))}
          {editable && (
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              {rules.length < 10 ? <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setRules((rs) => [...(rs || []), { event: '', when: 'stage', value: '' }])}>Add an event</Button> : <span />}
              <Button variant="primary" size="sm" icon={<Save size={13} />} loading={saving} onClick={() => void save()}>Save events</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
