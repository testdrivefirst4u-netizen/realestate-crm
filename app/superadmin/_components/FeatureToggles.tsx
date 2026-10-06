'use client';
import type { FeatureKey } from '@/server/platform/contract';
import { FEATURE_KEYS, FEATURE_LABELS } from '../_lib/format';
import { Switch } from './ui';

export type Features = Record<FeatureKey, boolean>;

export function allFeatures(value: boolean): Features {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, value])) as Features;
}

/** Normalises a (possibly partial) feature map from the server to every known key. */
export function normaliseFeatures(f: Partial<Features> | null | undefined): Features {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, Boolean(f?.[k])])) as Features;
}

export function FeatureToggles({
  value,
  onChange,
  disabled,
  legend = 'Features',
  columns = 2,
}: {
  value: Features;
  onChange: (next: Features) => void;
  disabled?: boolean;
  legend?: string;
  columns?: 1 | 2;
}) {
  const on = FEATURE_KEYS.filter((k) => value[k]).length;
  return (
    <fieldset disabled={disabled}>
      <legend className="flex w-full items-center justify-between text-[13px] font-medium text-[#3B342E]">
        <span>{legend}</span>
        <span className="text-[12.5px] font-normal text-[#7A6F64]">
          {on} of {FEATURE_KEYS.length} enabled
        </span>
      </legend>
      <div className={columns === 2 ? 'mt-1 grid gap-x-8 sm:grid-cols-2' : 'mt-1'}>
        {FEATURE_KEYS.map((k) => (
          <div key={k} className="border-b border-[#F1ECE6]">
            <Switch label={FEATURE_LABELS[k]} checked={value[k]} disabled={disabled} onChange={(v) => onChange({ ...value, [k]: v })} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
