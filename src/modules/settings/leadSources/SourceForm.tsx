import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { AssignmentMode, DuplicateMode, LeadSource, LeadSourceConfig, LeadSourceType } from '../../../../server/core/leadSourceTypes';
import type { GoogleConnection, GoogleStatus } from '../../../../server/core/sheetTypes';
import { Button, Select, cx, inputCls, labelCls } from '../../../components/ui';
import { SheetImportFields } from '../sheets/SheetImportFields';
import { SheetImportFormState, emptySheetImportForm, sheetImportFormFrom, sheetImportToRequest } from '../sheets/sheetUtils';
import {
  ASSIGNMENT_OPTIONS, DUPLICATE_OPTIONS, FieldMapRow, MAPPABLE_FIELDS, TYPE_OPTIONS, defaultConfig, defaultSourceLabel, fieldMapToRows, normalizeOrigin, normalizeOrigins, rowsToFieldMap, usesOrigins, allowedTypeOptions,
} from './leadSourceUtils';

/** Editable form state (origins and the field map are kept as rows while editing). */
export interface SourceFormState {
  name: string;
  type: LeadSourceType;
  sourceLabel: string;
  defaultStage: string;
  assignmentMode: AssignmentMode;
  rm: string;
  rms: string[];
  duplicates: DuplicateMode;
  origins: string[];
  mapRows: FieldMapRow[];
  /** Only used for type 'google_sheet'. */
  sheet: SheetImportFormState;
}

export function emptyFormState(type: LeadSourceType = 'website'): SourceFormState {
  const c = defaultConfig(type);
  return {
    name: '', type, sourceLabel: c.sourceLabel, defaultStage: c.defaultStage, assignmentMode: 'unassigned', rm: '', rms: [], duplicates: c.duplicates, origins: [], mapRows: [], sheet: emptySheetImportForm(),
  };
}

export function formStateFromSource(s: LeadSource): SourceFormState {
  const c = { ...defaultConfig(s.type), ...(s.config || {}) } as LeadSourceConfig;
  const a = c.assignment || { mode: 'unassigned', rm: '', rms: [] };
  return {
    name: s.name, type: s.type, sourceLabel: c.sourceLabel, defaultStage: c.defaultStage, assignmentMode: a.mode || 'unassigned', rm: a.rm || '', rms: a.rms || [],
    duplicates: c.duplicates || 'remark', origins: [...(c.allowedOrigins || [])], mapRows: fieldMapToRows(c.fieldMap),
    sheet: sheetImportFormFrom(c.sheet),
  };
}

/** Validate and build the request parts; `errors` is empty when it can be saved. */
export function formToRequest(f: SourceFormState): { name: string; type: LeadSourceType; config: LeadSourceConfig; errors: string[] } {
  const errors: string[] = [];
  const name = f.name.trim();
  if (!name) errors.push('Give the source a name.');
  const isSheet = f.type === 'google_sheet';
  // A sheet import or a Meta Page has no browser submissions, so allowed websites do not apply.
  const o = !usesOrigins(f.type) ? { origins: [] as string[], errors: [] } : normalizeOrigins(f.origins);
  o.errors.forEach((e) => errors.push(`Allowed website “${e.value}”: ${e.error}`));
  const sheet = isSheet ? sheetImportToRequest(f.sheet || emptySheetImportForm()) : null;
  if (sheet) errors.push(...sheet.errors);
  const m = rowsToFieldMap(f.mapRows);
  errors.push(...m.errors);
  if (f.assignmentMode === 'fixed' && !f.rm) errors.push('Choose the RM who receives the leads.');
  if (f.assignmentMode === 'round_robin' && f.rms.length < 1) errors.push('Choose at least one RM for round-robin.');
  return {
    name,
    type: f.type,
    config: {
      sourceLabel: f.sourceLabel.trim() || defaultSourceLabel(f.type),
      defaultStage: f.defaultStage || 'New',
      assignment: { mode: f.assignmentMode, rm: f.assignmentMode === 'fixed' ? f.rm : '', rms: f.assignmentMode === 'round_robin' ? f.rms : [] },
      duplicates: f.duplicates,
      allowedOrigins: o.origins,
      fieldMap: m.map,
      ...(sheet ? { sheet: sheet.sheet } : {}),
    },
    errors,
  };
}

export const SourceForm: React.FC<{
  value: SourceFormState;
  onChange: (next: SourceFormState) => void;
  stageOptions: string[];
  rmOptions: string[];
  /** Type cannot change after creation. */
  typeLocked?: boolean;
  disabled?: boolean;
  idPrefix: string;
  /** Offer the "Google Sheet (import)" type (plan feature googleSheets). */
  allowSheet?: boolean;
  /** Offer the website / webhook types (plan feature websiteApi; default true). */
  allowApi?: boolean;
  /** Platform Google status (null while loading). */
  google?: GoogleStatus | null;
  /** Connected Google accounts ("Connect with Google"; null while loading / not set up). */
  connections?: GoogleConnection[] | null;
}> = ({ value: f, onChange, stageOptions, rmOptions, typeLocked, disabled, idPrefix, allowSheet, allowApi = true, google = null, connections = null }) => {
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const isSheet = f.type === 'google_sheet';
  const allowed = allowedTypeOptions({ apiEnabled: allowApi, sheetsEnabled: !!allowSheet });
  const typeOptions = TYPE_OPTIONS.filter((t) => t.value === f.type || allowed.includes(t));
  const set = (patch: Partial<SourceFormState>) => onChange({ ...f, ...patch });
  const id = (s: string) => `${idPrefix}-${s}`;

  const setType = (type: LeadSourceType) => {
    // Keep a custom label; swap the default one.
    const label = !f.sourceLabel.trim() || f.sourceLabel === defaultSourceLabel(f.type) ? defaultSourceLabel(type) : f.sourceLabel;
    set({ type, sourceLabel: label });
  };

  return (
    <fieldset disabled={disabled} className="space-y-4 min-w-0">
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={id('name')} className={labelCls}>Name</label>
          <input id={id('name')} className={inputCls} value={f.name} maxLength={80} placeholder={f.type === 'meta' ? 'e.g. Facebook – Main Page' : 'e.g. Main website enquiry form'} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label htmlFor={id('label')} className={labelCls}>Enquiry Source label</label>
          <input id={id('label')} className={inputCls} value={f.sourceLabel} maxLength={60} placeholder={defaultSourceLabel(f.type)} onChange={(e) => set({ sourceLabel: e.target.value })} />
          <div className="text-[10px] text-[#9E948D] mt-1">Written to “Enquiry Source” on each new lead.</div>
        </div>
      </div>

      {typeOptions.length > 0 && (
      <div role="radiogroup" aria-label="Source type">
        <div className={labelCls}>Type</div>
        <div className={cx('grid gap-2', typeOptions.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
          {typeOptions.map((t) => (
            <label key={t.value} className={cx('flex items-start gap-2 p-3 rounded-lg border text-xs cursor-pointer', f.type === t.value ? 'border-[#A9825A] bg-[#FBF6EF]' : 'border-[#D2C9BF] bg-white', typeLocked && f.type !== t.value && 'opacity-50 cursor-not-allowed')}>
              <input type="radio" name={id('type')} value={t.value} checked={f.type === t.value} disabled={typeLocked} onChange={() => setType(t.value)} className="mt-0.5 accent-[#A9825A]" />
              <span>
                <span className="font-bold text-[#1D2F3F] block">{t.label}</span>
                <span className="text-[#6B5F57]">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      )}

      {isSheet && (
        <SheetImportFields value={f.sheet || emptySheetImportForm()} onChange={(sheet) => set({ sheet })} google={google} connections={connections} onHeaders={setSheetHeaders} disabled={disabled} idPrefix={idPrefix} />
      )}

      <RoutingFields value={f} onChange={set} stageOptions={stageOptions} rmOptions={rmOptions} idPrefix={idPrefix} />

      {usesOrigins(f.type) && <OriginsEditor origins={f.origins} onChange={(origins) => set({ origins })} idPrefix={idPrefix} />}
      <FieldMapEditor rows={f.mapRows} onChange={(mapRows) => set({ mapRows })} idPrefix={idPrefix} suggestions={isSheet ? sheetHeaders : undefined} />
    </fieldset>
  );
};

const OriginsEditor: React.FC<{ origins: string[]; onChange: (o: string[]) => void; idPrefix: string }> = ({ origins, onChange, idPrefix }) => (
  <div>
    <div className={labelCls}>Allowed websites</div>
    <p className="text-[10px] text-[#9E948D] mb-2">Browsers may post to this source only from these sites. Leave empty to accept any website (servers such as Zapier are not affected).</p>
    <div className="space-y-1.5">
      {origins.map((o, i) => {
        const check = o.trim() ? normalizeOrigin(o) : null;
        const err = check && !check.ok ? check.error : '';
        const inputId = `${idPrefix}-origin-${i}`;
        return (
          <div key={i}>
            <div className="flex items-center gap-1.5">
              <label htmlFor={inputId} className="sr-only">Allowed website {i + 1}</label>
              <input
                id={inputId}
                className={cx(inputCls, err && 'border-[#B06A55]')}
                value={o}
                placeholder="https://www.example.com"
                aria-invalid={!!err}
                aria-describedby={err ? `${inputId}-err` : undefined}
                onChange={(e) => onChange(origins.map((x, j) => (j === i ? e.target.value : x)))}
                onBlur={() => {
                  if (check && check.ok && check.origin !== o) onChange(origins.map((x, j) => (j === i ? check.origin : x)));
                }}
              />
              <Button variant="ghost" size="xs" aria-label={`Remove allowed website ${i + 1}`} onClick={() => onChange(origins.filter((_, j) => j !== i))} icon={<X size={12} />} />
            </div>
            {err && <div id={`${inputId}-err`} className="text-[10px] text-[#8A3E28] mt-0.5">{err}</div>}
          </div>
        );
      })}
    </div>
    <Button variant="ghost" size="xs" className="mt-1.5" icon={<Plus size={12} />} onClick={() => onChange([...origins, ''])}>Add website</Button>
  </div>
);

/** `suggestions` (a sheet's detected headers) are offered as incoming names; undefined = not a sheet. */
const FieldMapEditor: React.FC<{ rows: FieldMapRow[]; onChange: (r: FieldMapRow[]) => void; idPrefix: string; suggestions?: string[] }> = ({ rows, onChange, idPrefix, suggestions }) => (
  <div>
    <div className={labelCls}>{suggestions ? 'Column mapping' : 'Custom field mapping'}</div>
    <p className="text-[10px] text-[#9E948D] mb-2">
      {suggestions
        ? <>Columns named like Name, Phone, Email or Message are recognised automatically. Add a row for other sheet columns.{suggestions.length ? ' The detected column headers are offered as you type.' : ' Check access above to pick from the sheet’s columns.'}</>
        : 'Common names (name, phone, email, message, utm_source …) are recognised automatically. Add a row only for other field names your form or service sends.'}
    </p>
    {suggestions && suggestions.length > 0 && (
      <datalist id={`${idPrefix}-map-suggestions`}>
        {suggestions.map((h) => <option key={h} value={h} />)}
      </datalist>
    )}
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <label htmlFor={`${idPrefix}-map-from-${i}`} className="sr-only">Incoming field name, row {i + 1}</label>
          <input id={`${idPrefix}-map-from-${i}`} className={inputCls} value={r.from} list={suggestions && suggestions.length ? `${idPrefix}-map-suggestions` : undefined} placeholder={suggestions ? 'Sheet column, e.g. Mobile' : 'Incoming field, e.g. your-phone'} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span className="text-[#9E948D] text-xs" aria-hidden="true">→</span>
          <label htmlFor={`${idPrefix}-map-to-${i}`} className="sr-only">CRM field, row {i + 1}</label>
          <Select id={`${idPrefix}-map-to-${i}`} value={r.to} options={[...MAPPABLE_FIELDS]} placeholder="CRM field…" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <Button variant="ghost" size="xs" aria-label={`Remove mapping row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} icon={<X size={12} />} />
        </div>
      ))}
    </div>
    <Button variant="ghost" size="xs" className="mt-1.5" icon={<Plus size={12} />} onClick={() => onChange([...rows, { from: '', to: '' }])}>Add mapping</Button>
  </div>
);


export type RoutingState = Pick<SourceFormState, 'defaultStage' | 'duplicates' | 'assignmentMode' | 'rm' | 'rms'>;

/** Default stage, duplicate handling and RM assignment — shared by the source form and the Facebook Page connect dialog. */
export const RoutingFields: React.FC<{
  value: RoutingState;
  onChange: (patch: Partial<RoutingState>) => void;
  stageOptions: string[];
  rmOptions: string[];
  idPrefix: string;
}> = ({ value: f, onChange: set, stageOptions, rmOptions, idPrefix }) => {
  const id = (s: string) => `${idPrefix}-${s}`;
  const stages = stageOptions.length ? stageOptions : ['New'];
  const stageList = stages.includes(f.defaultStage) || !f.defaultStage ? stages : [f.defaultStage, ...stages];
  const rmList = f.rm && !rmOptions.includes(f.rm) ? [f.rm, ...rmOptions] : rmOptions;
  return (
    <>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={id('stage')} className={labelCls}>Default stage</label>
          <Select id={id('stage')} value={f.defaultStage} options={stageList} onChange={(e) => set({ defaultStage: e.target.value })} />
        </div>
        <div>
          <label htmlFor={id('dup')} className={labelCls}>If the lead already exists</label>
          <Select id={id('dup')} value={f.duplicates} options={DUPLICATE_OPTIONS} onChange={(e) => set({ duplicates: e.target.value as DuplicateMode })} />
          <div className="text-[10px] text-[#9E948D] mt-1">Matched on phone number (or e-mail).</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={id('assign')} className={labelCls}>Assignment</label>
            <Select id={id('assign')} value={f.assignmentMode} options={ASSIGNMENT_OPTIONS} onChange={(e) => set({ assignmentMode: e.target.value as AssignmentMode })} />
          </div>
          {f.assignmentMode === 'fixed' && (
            <div>
              <label htmlFor={id('rm')} className={labelCls}>RM</label>
              <Select id={id('rm')} value={f.rm} options={rmList} placeholder="Choose an RM…" onChange={(e) => set({ rm: e.target.value })} />
            </div>
          )}
        </div>
        {f.assignmentMode === 'round_robin' && (
          <div role="group" aria-label="Round-robin RMs">
            <div className={labelCls}>RMs in the rotation</div>
            {rmOptions.length === 0 ? (
              <p className="text-[11px] text-[#9E948D]">No RMs are set up yet (Settings › Users & roles).</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {rmList.map((rm) => {
                  const on = f.rms.includes(rm);
                  return (
                    <label key={rm} className={cx('inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer', on ? 'border-[#A9825A] bg-[#FBF6EF] text-[#1D2F3F] font-semibold' : 'border-[#D2C9BF] bg-white text-[#6B5F57]')}>
                      <input type="checkbox" className="accent-[#A9825A]" checked={on} onChange={() => set({ rms: on ? f.rms.filter((x) => x !== rm) : [...f.rms, rm] })} />
                      {rm}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="text-[10px] text-[#9E948D] mt-1">New leads go to these RMs in turn.</div>
          </div>
        )}
      </div>
    </>
  );
};
