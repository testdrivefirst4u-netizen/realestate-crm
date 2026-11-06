/** Colours, number formats, names and the chart of the Search Console screen. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchPerformance } from '../../core/api';

export type MetricId = 'clicks' | 'impressions' | 'ctr' | 'position';
export const METRICS: Array<{ id: MetricId; label: string; short: string; color: string }> = [
  { id: 'clicks', label: 'Total clicks', short: 'Clicks', color: '#1A73E8' },
  { id: 'impressions', label: 'Total impressions', short: 'Impressions', color: '#5E35B1' },
  { id: 'ctr', label: 'Average CTR', short: 'CTR', color: '#00796B' },
  { id: 'position', label: 'Average position', short: 'Position', color: '#C75B0A' },
];
export const metricOf = (id: string) => METRICS.find((m) => m.id === id) || METRICS[0];

export const full = (v: number) => Math.round(v).toLocaleString('en-IN');
const compactFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
export const compact = (v: number) => (Math.abs(v) < 1000 ? String(Math.round(v)) : compactFormat.format(v));
export const fmt = (id: string, v: number) => (id === 'ctr' ? `${(v * 100).toFixed(1)}%` : id === 'position' ? v.toFixed(1) : full(v));
export const fmtCard = (id: string, v: number) => (id === 'ctr' || id === 'position' ? fmt(id, v) : compact(v));
export const dayLabel = (d: string, withYear = false) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' as const } : {}) });

/** Google names countries by three letters; the browser knows them by two. */
const ALPHA: Record<string, string> = Object.fromEntries(('afg AF,alb AL,dza DZ,asm AS,and AD,ago AO,aia AI,ata AQ,atg AG,arg AR,arm AM,abw AW,aus AU,aut AT,aze AZ,bhs BS,bhr BH,bgd BD,brb BB,blr BY,bel BE,blz BZ,ben BJ,bmu BM,btn BT,bol BO,bih BA,bwa BW,bra BR,brn BN,bgr BG,bfa BF,bdi BI,khm KH,cmr CM,can CA,cpv CV,cym KY,caf CF,tcd TD,chl CL,chn CN,col CO,com KM,cog CG,cod CD,cri CR,civ CI,hrv HR,cub CU,cuw CW,cyp CY,cze CZ,dnk DK,dji DJ,dma DM,dom DO,ecu EC,egy EG,slv SV,gnq GQ,eri ER,est EE,swz SZ,eth ET,fji FJ,fin FI,fra FR,guf GF,pyf PF,gab GA,gmb GM,geo GE,deu DE,gha GH,gib GI,grc GR,grl GL,grd GD,glp GP,gum GU,gtm GT,gin GN,gnb GW,guy GY,hti HT,hnd HN,hkg HK,hun HU,isl IS,ind IN,idn ID,irn IR,irq IQ,irl IE,isr IL,ita IT,jam JM,jpn JP,jor JO,kaz KZ,ken KE,kir KI,xkk XK,kwt KW,kgz KG,lao LA,lva LV,lbn LB,lso LS,lbr LR,lby LY,lie LI,ltu LT,lux LU,mac MO,mdg MG,mwi MW,mys MY,mdv MV,mli ML,mlt MT,mhl MH,mtq MQ,mrt MR,mus MU,myt YT,mex MX,fsm FM,mda MD,mco MC,mng MN,mne ME,msr MS,mar MA,moz MZ,mmr MM,nam NA,nru NR,npl NP,nld NL,ncl NC,nzl NZ,nic NI,ner NE,nga NG,prk KP,mkd MK,nor NO,omn OM,pak PK,plw PW,pse PS,pan PA,png PG,pry PY,per PE,phl PH,pol PL,prt PT,pri PR,qat QA,reu RE,rou RO,rus RU,rwa RW,kna KN,lca LC,vct VC,wsm WS,smr SM,stp ST,sau SA,sen SN,srb RS,syc SC,sle SL,sgp SG,sxm SX,svk SK,svn SI,slb SB,som SO,zaf ZA,kor KR,ssd SS,esp ES,lka LK,sdn SD,sur SR,swe SE,che CH,syr SY,twn TW,tjk TJ,tza TZ,tha TH,tls TL,tgo TG,ton TO,tto TT,tun TN,tur TR,tkm TM,tca TC,tuv TV,uga UG,ukr UA,are AE,gbr GB,usa US,ury UY,uzb UZ,vut VU,ven VE,vnm VN,vgb VG,vir VI,yem YE,zmb ZM,zwe ZW').split(',').map((p) => p.split(' ') as [string, string]));
let regions: Intl.DisplayNames | null = null;
export function countryName(code: string): string {
  const two = ALPHA[code.toLowerCase()];
  if (!two) return code.toUpperCase();
  try {
    regions = regions || new Intl.DisplayNames(['en'], { type: 'region' });
    return regions.of(two) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const deviceName = words;
export const appearanceName = words;

type Day = SearchPerformance['daily'][number];
const hasValue = (values: Record<string, number> | null | undefined, id: string) => {
  if (!values) return false;
  // no searches that day: there is no CTR or position to show, which is not the same as zero
  return id === 'ctr' || id === 'position' ? values.impressions > 0 : true;
};
function niceTop(max: number): number {
  if (!(max > 0)) return 1;
  const size = 10 ** Math.floor(Math.log10(max));
  const step = max / size <= 2 ? size / 4 : max / size <= 5 ? size / 2 : size;
  return Math.ceil(max / step) * step;
}
const tick = (id: string, v: number) => (id === 'ctr' ? `${+(v * 100).toFixed(2)}%` : id === 'position' ? String(+v.toFixed(1)) : compact(v));

/** Every chosen metric on its own scale, as Google draws it; position runs downwards, because a lower number is better. */
export const GscChart: React.FC<{ days: Day[]; selected: MetricId[]; compare?: boolean; height?: number }> = ({ days, selected, compare = false, height = 250 }) => {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const left = selected[0];
  const right = selected[1];
  const padL = left ? 46 : 12, padR = right ? 46 : 12, padT = 24, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const x = (i: number) => padL + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const lines = useMemo(() => selected.map((id) => {
    const now = days.map((d) => (hasValue(d.values, id) ? d.values[id] : null));
    const before = compare ? days.map((d) => (hasValue(d.prev, id) ? d.prev![id] : null)) : [];
    const top = niceTop(Math.max(0, ...[...now, ...before].map((v) => v ?? 0)));
    return { id, now, before, top };
  }), [days, selected, compare]);
  const y = (id: string, v: number, top: number) => (id === 'position' ? padT + (v / top) * plotH : padT + plotH - (v / top) * plotH);
  const path = (id: string, vals: Array<number | null>, top: number) => {
    let out = '', pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      out += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(id, v, top).toFixed(1)}`;
      pen = true;
    });
    return out;
  };
  const alone = (vals: Array<number | null>) => vals.map((v, i) => (v !== null && vals[i - 1] == null && vals[i + 1] == null ? i : -1)).filter((i) => i >= 0);
  const labels = Math.max(2, Math.min(days.length, Math.floor(plotW / 90)));
  const shownDays = days.length <= 1 ? [0] : Array.from({ length: labels }, (_, i) => Math.round((i * (days.length - 1)) / (labels - 1)));
  const move = (e: React.PointerEvent) => {
    if (!days.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = days.length <= 1 ? 0 : Math.round(((e.clientX - rect.left - padL) / plotW) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, at)));
  };
  const h = hover !== null ? days[hover] : null;
  const summary = selected.map((id) => metricOf(id).short).join(', ');

  return (
    <div ref={box} className="relative w-full select-none touch-pan-y">
      <svg width={width} height={height} role="img" aria-label={`${summary} per day. The same figures are in the Dates table below.`} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}>
        {[0, 1, 2, 3, 4].map((f) => <line key={f} x1={padL} x2={width - padR} y1={padT + (f / 4) * plotH} y2={padT + (f / 4) * plotH} stroke="#E8EAED" strokeWidth={1} />)}
        {[{ line: lines[0], at: padL - 8, anchor: 'end' as const }, { line: lines[1], at: width - padR + 8, anchor: 'start' as const }].map(({ line, at, anchor }) => line && (
          <g key={line.id} fontSize={11} fill="#5F6368">
            <text x={anchor === 'end' ? 8 : width - 8} y={12} textAnchor={anchor === 'end' ? 'start' : 'end'} fill={metricOf(line.id).color} fontWeight={500}>{metricOf(line.id).short}</text>
            {[0, 1, 2, 3, 4].map((f) => <text key={f} x={at} y={padT + (f / 4) * plotH + 4} textAnchor={anchor}>{tick(line.id, line.id === 'position' ? (line.top * f) / 4 : (line.top * (4 - f)) / 4)}</text>)}
          </g>
        ))}
        {shownDays.map((i) => <text key={i} x={x(i)} y={height - 8} fontSize={11} fill="#5F6368" textAnchor={i === 0 && days.length > 1 ? 'start' : i === days.length - 1 && days.length > 1 ? 'end' : 'middle'}>{dayLabel(days[i].day)}</text>)}
        {lines.map((l) => (
          <g key={l.id} stroke={metricOf(l.id).color} fill="none">
            {compare && <path d={path(l.id, l.before, l.top)} strokeWidth={1.5} strokeDasharray="4 4" />}
            <path d={path(l.id, l.now, l.top)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {alone(l.now).map((i) => <circle key={i} cx={x(i)} cy={y(l.id, l.now[i]!, l.top)} r={3} fill={metricOf(l.id).color} stroke="none" />)}
          </g>
        ))}
        {hover !== null && h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="#9AA0A6" strokeWidth={1} />
            {lines.map((l) => l.now[hover] !== null && <circle key={l.id} cx={x(hover)} cy={y(l.id, l.now[hover]!, l.top)} r={4} fill={metricOf(l.id).color} stroke="#fff" strokeWidth={2} />)}
          </g>
        )}
      </svg>
      {hover !== null && h && (
        <div className="pointer-events-none absolute top-1 z-10 w-44 rounded border border-[#DADCE0] bg-white p-2 text-[11px] text-[#202124] shadow-md" style={{ left: Math.max(0, Math.min(width - 176, x(hover) + 10 + (x(hover) + 186 > width ? -196 : 0))) }}>
          <b className="block font-medium">{dayLabel(h.day, true)}</b>
          {lines.map((l) => <div key={l.id} className="mt-0.5 flex items-center gap-1.5"><i className="h-2 w-2 flex-none rounded-full" style={{ background: metricOf(l.id).color }} /><span className="flex-1">{metricOf(l.id).short}</span><b className="font-medium tabular-nums">{l.now[hover] === null ? '—' : fmt(l.id, l.now[hover]!)}</b></div>)}
          {compare && h.prev && (
            <>
              <b className="mt-1.5 block border-t border-[#E8EAED] pt-1 font-medium">{dayLabel(h.prevDay, true)}</b>
              {lines.map((l) => <div key={l.id} className="mt-0.5 flex items-center gap-1.5"><i className="h-0 w-2 flex-none border-t-2 border-dashed" style={{ borderColor: metricOf(l.id).color }} /><span className="flex-1">{metricOf(l.id).short}</span><b className="font-medium tabular-nums">{l.before[hover] === null ? '—' : fmt(l.id, l.before[hover]!)}</b></div>)}
            </>
          )}
        </div>
      )}
    </div>
  );
};
