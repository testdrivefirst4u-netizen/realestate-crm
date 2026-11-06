/** New leads still waiting for a first call, past the company's time. Asks the server itself, so it does not depend on the background check. */
import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../core/api';

const CHECK_EVERY_MS = 120000;
const SHOW = 5;

type Row = { id: string; name: string; rm: string; minutes: number };

export const SlowLeadsBanner: React.FC<{ onOpenLead: (id: string) => void }> = ({ onOpenLead }) => {
  const [data, setData] = useState<{ minutes: number; rows: Row[] }>({ minutes: 0, rows: [] });
  useEffect(() => {
    let live = true;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      api.leads.slow().then((r) => { if (live) setData(r); }, () => { /* a warning that could not be read: the screen carries on without it */ });
    };
    check();
    const t = setInterval(check, CHECK_EVERY_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  const { minutes, rows } = data;
  if (!rows.length) return null;
  return (
    <div role="status" className="rounded-xl border border-[#F2D58A] bg-[#FFF8E6] px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-[#6B4700]">
        <AlertTriangle size={15} aria-hidden="true" />
        {rows.length} new lead{rows.length === 1 ? ' has' : 's have'} had no call or message for over {minutes} working minutes
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {rows.slice(0, SHOW).map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpenLead(r.id)} className="rounded-lg border border-[#F2D58A] bg-white px-2.5 py-1 text-xs text-[#0B2A44] hover:bg-[#FFFDF5]">
              <span className="font-semibold">{r.name || r.id}</span> · {r.rm} · {r.minutes} min
            </button>
          </li>
        ))}
        {rows.length > SHOW && <li className="self-center text-xs text-[#6B4700]">and {rows.length - SHOW} more</li>}
      </ul>
    </div>
  );
};
