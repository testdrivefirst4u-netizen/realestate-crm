/**
 * Country / State / City inputs shared by AddLeadModal and LeadDetailModal.
 * Free text with suggestions: common NRI countries, Indian states, and the cities
 * already used on other leads (so spellings stay consistent for the Sales MIS).
 */
import React, { useId, useMemo } from 'react';
import { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { Field, inputCls } from '../../components/ui';

const COUNTRIES = ['India', 'USA', 'UK', 'UAE', 'Singapore', 'Canada', 'Australia', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Oman', 'Germany', 'New Zealand'];
const IN_STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const distinct = (leads: Lead[], key: string, base: string[] = []) => {
  const set = new Set(base);
  for (const l of leads) {
    const v = String(l[key] || '').trim();
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
};

export const GeoFields: React.FC<{
  leads: Lead[];
  value: (field: string) => string;
  onChange: (field: string, v: string) => void;
  disabled?: boolean;
}> = ({ leads, value, onChange, disabled }) => {
  const id = useId();
  const country = value(F.COUNTRY).trim().toLowerCase();
  const lists = useMemo(() => {
    const inCountry = country ? leads.filter((l) => String(l[F.COUNTRY] || '').trim().toLowerCase() === country) : leads;
    return {
      countries: distinct(leads, F.COUNTRY, COUNTRIES),
      states: distinct(inCountry, F.STATE, !country || country === 'india' ? IN_STATES : []),
      cities: distinct(inCountry, F.CITY),
    };
  }, [leads, country]);
  const input = (field: string, list: string, placeholder: string) => (
    <input value={value(field)} onChange={(e) => onChange(field, e.target.value)} list={`${id}-${list}`} placeholder={placeholder} disabled={disabled} autoComplete="off" className={inputCls} />
  );
  return (
    <>
      <Field label="City">{input(F.CITY, 'city', 'e.g. Hyderabad')}</Field>
      <Field label="State">{input(F.STATE, 'state', 'e.g. Telangana')}</Field>
      <Field label="Country">{input(F.COUNTRY, 'country', 'e.g. India')}</Field>
      <datalist id={`${id}-country`}>{lists.countries.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id={`${id}-state`}>{lists.states.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id={`${id}-city`}>{lists.cities.map((v) => <option key={v} value={v} />)}</datalist>
    </>
  );
};
