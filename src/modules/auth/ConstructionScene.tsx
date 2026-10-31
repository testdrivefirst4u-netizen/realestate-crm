/**
 * Sign-in page illustration, drawn to look like a real site at golden hour: a glass tower in perspective (lit front,
 * shaded side) rises — concrete core, slabs, then the curtain wall reflecting the sky — while a tower crane swings
 * glazing panels in. Haze on the far city, cast shadows, sun rays, film grain and a vignette keep it from looking flat.
 * 14 s cycle; when it is done the lights come on and it starts again.
 *
 * `mode`: 'signing' finishes the tower at once and switches its lights on floor by floor as dusk falls (street lights
 * and neighbours too); 'success' adds a warm glow. CSS only; reduced motion shows the finished tower.
 */
import React from 'react';

export type SceneMode = 'idle' | 'signing' | 'success';

const T = 14;
const FLOORS = 11;
const BASE = 650; // street level
const FH = 30; // floor height
const TX = 392; // tower front face, left edge
const TW = 150; // front face width
const SD = 46; // side face depth (to the right)
const SK = 16; // how much the side face rises (perspective)
const TOP = BASE - FLOORS * FH;
const BAYS = 5;
const BW = TW / BAYS;
const pct = (t: number) => `${((t / T) * 100).toFixed(2)}%`;
const side = (y: number, h: number, inset = 0) =>
  `${TX + TW + inset},${y} ${TX + TW + SD - inset},${y - SK} ${TX + TW + SD - inset},${y - SK + h} ${TX + TW + inset},${y + h}`;

function keyframes(): string {
  let k = '';
  const end = `${pct(13.1)}{opacity:1}${pct(13.8)},100%{opacity:0}`;
  for (let i = 0; i < FLOORS; i++) {
    const s = 0.3 + i * 0.5;
    k += `@keyframes cs-s${i}{0%,${pct(s)}{opacity:0;transform:translateY(-10px)}${pct(s + 0.4)}{opacity:1;transform:none}${end}}.cs-s${i}{animation-name:cs-s${i}}`;
    const g = 3 + i * 0.45;
    k += `@keyframes cs-g${i}{0%,${pct(g)}{opacity:0;clip-path:inset(0 100% 0 0)}${pct(g + 0.55)}{opacity:1;clip-path:inset(0 0 0 0)}${end}}.cs-g${i}{animation-name:cs-g${i}}`;
    const l = 9.4 + i * 0.14;
    k += `@keyframes cs-l${i}{0%,${pct(l)}{opacity:0}${pct(l + 0.3)},${pct(13.1)}{opacity:1}${pct(13.6)},100%{opacity:0}}.cs-l${i}{animation-name:cs-l${i}}`;
  }
  k += `@keyframes cs-core{0%{transform:scaleY(.05)}${pct(5.6)}{transform:scaleY(1)}${end}}`;
  k += `@keyframes cs-crown{0%,${pct(8.2)}{opacity:0;transform:translateY(-12px)}${pct(8.9)}{opacity:1;transform:none}${end}}`;
  return k;
}

const css = `
.cs-s,.cs-g,.cs-l{animation-duration:${T}s;animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.25,1,.4,1)}
.cs-core{transform-box:fill-box;transform-origin:50% 100%;animation:cs-core ${T}s cubic-bezier(.4,0,.2,1) infinite}
.cs-crown{animation:cs-crown ${T}s ease infinite}
.cs-trolley{animation:cs-trolley 10s ease-in-out infinite}
@keyframes cs-trolley{0%,8%{transform:translateX(0)}42%,58%{transform:translateX(84px)}92%,100%{transform:translateX(0)}}
.cs-hook{animation:cs-hook 5s ease-in-out infinite}
@keyframes cs-hook{0%,6%{transform:translateY(0)}45%,55%{transform:translateY(120px)}94%,100%{transform:translateY(0)}}
.cs-load{animation:cs-load 5s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 0}
@keyframes cs-load{0%{opacity:1;transform:rotate(-2.5deg)}25%{transform:rotate(2deg)}48%{opacity:1;transform:rotate(-.6deg)}52%,96%{opacity:0}100%{opacity:1;transform:rotate(-2.5deg)}}
.cs-swing{transform-box:fill-box;transform-origin:20% 50%;animation:cs-swing 18s ease-in-out infinite}
@keyframes cs-swing{0%,100%{transform:scaleX(1)}50%{transform:scaleX(-.5)}}
.cs-car{animation:cs-car 12s linear infinite}
.cs-car.b{animation-duration:17s;animation-delay:-8s}
@keyframes cs-car{from{transform:translateX(-160px)}to{transform:translateX(960px)}}
.cs-birds{animation:cs-birds 26s linear infinite}
@keyframes cs-birds{from{transform:translate(-120px,30px)}to{transform:translate(920px,-40px)}}
.cs-flap{transform-box:fill-box;transform-origin:50% 50%;animation:cs-flap .55s ease-in-out infinite alternate}
@keyframes cs-flap{to{transform:scaleY(.3)}}
.cs-rays{animation:cs-rays 9s ease-in-out infinite alternate}
@keyframes cs-rays{from{opacity:.35}to{opacity:.65}}
.cs-spark{animation:cs-spark 1.2s steps(1) infinite}
@keyframes cs-spark{0%,100%{opacity:0}8%,26%{opacity:1}17%{opacity:.25}}
.cs-beacon{animation:cs-blink 1.6s steps(2,start) infinite}
@keyframes cs-blink{to{opacity:.12}}
.cs-dusk,.cs-glow,.cs-street{opacity:0;transition:opacity 1.4s ease}
.cs-nl{opacity:0;transition:opacity 1.2s ease .5s}
.is-signing .cs-s,.is-signing .cs-g,.is-signing .cs-core,.is-signing .cs-crown,
.is-success .cs-s,.is-success .cs-g,.is-success .cs-core,.is-success .cs-crown{animation:none;opacity:1;transform:none;clip-path:none}
.is-signing .cs-l,.is-success .cs-l{animation:cs-on .45s ease forwards;animation-delay:calc(var(--f) * 100ms)}
@keyframes cs-on{from{opacity:0}to{opacity:1}}
.is-signing .cs-dusk,.is-success .cs-dusk{opacity:.5}
.is-signing .cs-nl,.is-success .cs-nl,.is-signing .cs-street,.is-success .cs-street{opacity:1}
.is-success .cs-glow{opacity:1}
@media (prefers-reduced-motion:reduce){
  .cs-s,.cs-g,.cs-core,.cs-crown{animation:none!important;opacity:1!important;transform:none!important;clip-path:none!important}
  .cs-l{animation:none!important;opacity:1!important}
  .cs-trolley,.cs-hook,.cs-load,.cs-swing,.cs-car,.cs-birds,.cs-flap,.cs-spark,.cs-beacon,.cs-rays{animation:none!important}
}
`;

/** A truss (crane mast or jib): two chords and diagonal lacing; `back` draws the far side darker for depth. */
function Truss({ x, y, w, h, vertical, color, back }: { x: number; y: number; w: number; h: number; vertical?: boolean; color: string; back?: string }) {
  const n = Math.max(1, Math.round((vertical ? h : w) / (vertical ? w : h) / 1.1));
  const lace: React.ReactNode[] = [];
  for (let k = 0; k < n; k++) {
    if (vertical) {
      const a = y + (k * h) / n, b = y + ((k + 1) * h) / n;
      lace.push(<line key={k} x1={x} y1={b} x2={x + w} y2={a} />, <line key={`h${k}`} x1={x} y1={a} x2={x + w} y2={a} strokeWidth="1" />);
    } else {
      const a = x + (k * w) / n, b = x + ((k + 1) * w) / n;
      lace.push(<line key={k} x1={a} y1={y + h} x2={b} y2={y} />, <line key={`v${k}`} x1={a} y1={y} x2={a} y2={y + h} strokeWidth="1" />);
    }
  }
  const o = vertical ? { dx: 4, dy: -3 } : { dx: 3, dy: -4 };
  return (
    <g fill="none" strokeLinecap="round">
      {back && (
        <g stroke={back} strokeWidth="1.3" transform={`translate(${o.dx} ${o.dy})`}>
          {vertical ? <><line x1={x} y1={y} x2={x} y2={y + h} /><line x1={x + w} y1={y} x2={x + w} y2={y + h} /></> : <><line x1={x} y1={y} x2={x + w} y2={y} /><line x1={x} y1={y + h} x2={x + w} y2={y + h} /></>}
          {lace}
        </g>
      )}
      <g stroke={color} strokeWidth="1.5">
        {vertical ? <><line x1={x} y1={y} x2={x} y2={y + h} strokeWidth="2.4" /><line x1={x + w} y1={y} x2={x + w} y2={y + h} strokeWidth="2.4" /></> : <><line x1={x} y1={y} x2={x + w} y2={y} strokeWidth="2.4" /><line x1={x} y1={y + h} x2={x + w} y2={y + h} strokeWidth="2.4" /></>}
        {lace}
      </g>
    </g>
  );
}

/** A finished building in perspective (front + side + roof), with a window grid. */
function Block({ x, y, w, d, h, front, sideFill, win, rows, cols, lit }: { x: number; y: number; w: number; d: number; h: number; front: string; sideFill: string; win: string; rows: number; cols: number; lit?: number[] }) {
  const k = d * 0.35;
  const cw = w / cols, rh = (h - 12) / rows;
  return (
    <g>
      <polygon points={`${x},${y} ${x + d},${y - k} ${x + w + d},${y - k} ${x + w},${y}`} fill="#C9B8A6" opacity=".7" />
      <rect x={x} y={y} width={w} height={BASE - y} fill={front} />
      <polygon points={`${x + w},${y} ${x + w + d},${y - k} ${x + w + d},${BASE - k} ${x + w},${BASE}`} fill={sideFill} />
      <g fill={win}>{Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => <rect key={`${r}-${c}`} x={x + c * cw + cw * 0.18} y={y + 8 + r * rh} width={cw * 0.64} height={rh * 0.62} />))}</g>
      {lit && <g className="cs-nl" fill="#FFD9A0">{lit.map((n) => { const r = Math.floor(n / cols), c = n % cols; return <rect key={n} x={x + c * cw + cw * 0.18} y={y + 8 + r * rh} width={cw * 0.64} height={rh * 0.62} />; })}</g>}
    </g>
  );
}

function Tree({ x, s = 1 }: { x: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${BASE + 18}) scale(${s})`}>
      <ellipse cx="-10" cy="2" rx="26" ry="5" fill="#2E2A22" opacity=".25" />
      <rect x="-1.5" y="-24" width="3" height="24" fill="#4A3B2E" />
      <circle cx="-6" cy="-34" r="13" fill="#4F6B48" /><circle cx="7" cy="-38" r="14" fill="#5E7B55" />
      <circle cx="1" cy="-48" r="11" fill="#6F8C63" /><circle cx="10" cy="-30" r="9" fill="#46613F" />
    </g>
  );
}

function Car({ y, body, className }: { y: number; body: string; className: string }) {
  return (
    <g className={className}>
      <g transform={`translate(0 ${y})`}>
        <ellipse cx="32" cy="3" rx="36" ry="4" fill="#1B1B1B" opacity=".3" />
        <path d="M2 -3 h60 a4 4 0 0 0 4 -4 v-5 q0 -3 -3 -4 l-9 -3 -9 -8 q-2 -2 -5 -2 h-18 q-3 0 -5 2 l-8 8 -6 2 q-3 1 -3 4 v6 a4 4 0 0 0 4 4z" fill={body} />
        <path d="M22 -27 h16 l8 7 h-30z" fill="#B9CCDA" opacity=".9" />
        <rect x="2" y="-12" width="64" height="2" fill="#fff" opacity=".18" />
        <circle cx="15" cy="-2" r="5.5" fill="#1F1F1F" /><circle cx="15" cy="-2" r="2" fill="#8C8C8C" />
        <circle cx="51" cy="-2" r="5.5" fill="#1F1F1F" /><circle cx="51" cy="-2" r="2" fill="#8C8C8C" />
        <rect x="62" y="-13" width="4" height="3" rx="1" fill="#FFE9B0" />
      </g>
    </g>
  );
}

export function ConstructionScene({ mode = 'idle' }: { mode?: SceneMode }) {
  const cr = '#E0A63A', crBack = '#9C7228';
  return (
    <svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMax slice" className={`absolute inset-0 h-full w-full ${mode === 'signing' ? 'is-signing' : mode === 'success' ? 'is-success' : ''}`} aria-hidden="true">
      <style>{css + keyframes()}</style>
      <defs>
        <linearGradient id="cs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8FA9C0" /><stop offset=".45" stopColor="#C9C4BC" /><stop offset=".72" stopColor="#EBCBA4" /><stop offset=".82" stopColor="#F1C08A" />
        </linearGradient>
        <radialGradient id="cs-sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#FFF4DC" /><stop offset=".25" stopColor="#FFE1AE" stopOpacity=".9" /><stop offset="1" stopColor="#FFD08A" stopOpacity="0" /></radialGradient>
        <linearGradient id="cs-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F3D2AC" stopOpacity="0" /><stop offset="1" stopColor="#F3D2AC" stopOpacity=".75" /></linearGradient>
        {/* the curtain wall reflects the sky: bright at the top, darker low down */}
        <linearGradient id="cs-glassF" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={BASE}>
          <stop offset="0" stopColor="#C9D8E4" /><stop offset=".35" stopColor="#8DA9C0" /><stop offset=".7" stopColor="#4F6F8B" /><stop offset="1" stopColor="#2C4459" />
        </linearGradient>
        <linearGradient id="cs-glassS" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={BASE}>
          <stop offset="0" stopColor="#6E869B" /><stop offset="1" stopColor="#1F3243" />
        </linearGradient>
        <linearGradient id="cs-concrete" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#D8CDBE" /><stop offset="1" stopColor="#A99B8B" /></linearGradient>
        <linearGradient id="cs-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".35" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <linearGradient id="cs-shadow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2A2620" stopOpacity=".45" /><stop offset="1" stopColor="#2A2620" stopOpacity="0" /></linearGradient>
        <linearGradient id="cs-road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6A6E73" /><stop offset="1" stopColor="#4C5056" /></linearGradient>
        <linearGradient id="cs-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#B3A78F" /><stop offset="1" stopColor="#8F8470" /></linearGradient>
        <radialGradient id="cs-vignette" cx="0.5" cy="0.45" r="0.75"><stop offset=".6" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#1A140E" stopOpacity=".35" /></radialGradient>
        <radialGradient id="cs-towerglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#FFD08A" stopOpacity=".5" /><stop offset="1" stopColor="#FFD08A" stopOpacity="0" /></radialGradient>
        <radialGradient id="cs-lamp" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#FFE2A8" stopOpacity=".9" /><stop offset="1" stopColor="#FFE2A8" stopOpacity="0" /></radialGradient>
        <filter id="cs-far" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.4" /></filter>
        <filter id="cs-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" /></filter>
        <filter id="cs-grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <clipPath id="cs-below-trolley"><rect x="0" y="196" width="800" height="600" /></clipPath>
      </defs>

      {/* golden-hour sky, sun and rays */}
      <rect width="800" height="800" fill="url(#cs-sky)" />
      <circle cx="660" cy="520" r="260" fill="url(#cs-sun)" />
      <g className="cs-rays" fill="#FFF0D2" opacity=".5">
        <polygon points="660,520 380,0 470,0" opacity=".25" /><polygon points="660,520 560,0 610,0" opacity=".3" /><polygon points="660,520 760,0 800,0 800,40" opacity=".22" />
      </g>
      <g className="cs-birds" fill="none" stroke="#4A3F36" strokeWidth="1.4" strokeLinecap="round">
        {[[0, 0], [20, 9], [38, -5], [56, 6]].map(([x, y]) => <path key={x} className="cs-flap" d={`M${90 + x} ${170 + y} q5 -5 10 0 q5 -5 10 0`} />)}
      </g>

      {/* the far city, soft and hazy */}
      <g filter="url(#cs-far)" fill="#A59A93" opacity=".75">
        {[[0, 520, 52], [48, 548, 40], [86, 500, 34], [118, 538, 58], [178, 512, 30], [206, 556, 44], [600, 530, 40], [636, 498, 30], [664, 540, 56], [718, 516, 36], [752, 552, 48]].map(([x, y, w]) => <rect key={x} x={x} y={y} width={w} height={BASE - y} />)}
        <line x1="732" y1={BASE} x2="732" y2="420" stroke="#A59A93" strokeWidth="3" />
        <g className="cs-swing"><line x1="712" y1="422" x2="800" y2="422" stroke="#A59A93" strokeWidth="2.5" /></g>
      </g>
      <rect x="0" y="420" width="800" height={BASE - 420} fill="url(#cs-haze)" />

      {/* neighbours (lit windows only show while signing in) */}
      <Block x={60} y={430} w={120} d={34} h={BASE - 430} front="#4A5A68" sideFill="#33404C" win="#8FA3B4" rows={9} cols={4} lit={[1, 6, 9, 14, 19, 22, 27, 30]} />
      <Block x={640} y={500} w={96} d={30} h={BASE - 500} front="#B68C61" sideFill="#8E6B48" win="#E8D2B4" rows={6} cols={3} lit={[0, 4, 8, 10, 15]} />

      {/* glow behind the finished tower when you are in */}
      <circle className="cs-glow" cx={TX + TW / 2} cy={TOP + 120} r="240" fill="url(#cs-towerglow)" />

      {/* tower: shadow, core, then per floor slab + columns, glazing (front and side) */}
      <polygon points={`${TX},${BASE} ${TX + TW},${BASE} ${TX + TW - 90},${BASE + 70} ${TX - 170},${BASE + 70}`} fill="url(#cs-shadow)" />
      <rect className="cs-core" x={TX + TW / 2 - 24} y={TOP - 16} width="48" height={BASE - TOP + 16} fill="url(#cs-concrete)" />
      {Array.from({ length: FLOORS }, (_, i) => {
        const y = BASE - (i + 1) * FH;
        return (
          <g key={i}>
            <g className={`cs-s cs-s${i}`}>
              <rect x={TX - 5} y={y} width={TW + 5} height="4" fill="#CFC3B3" />
              <polygon points={side(y, 4)} fill="#A5978A" />
              {Array.from({ length: BAYS + 1 }, (_, c) => <rect key={c} x={TX + c * BW - (c === BAYS ? 3 : 0)} y={y + 4} width="3" height={FH - 4} fill="#9D8F82" />)}
              {/* the far corner column of the side face */}
              <polygon points={`${TX + TW + SD - 3},${y + 4 - SK} ${TX + TW + SD},${y + 4 - SK} ${TX + TW + SD},${y + FH - SK} ${TX + TW + SD - 3},${y + FH - SK}`} fill="#7F7366" />
            </g>
            <g className={`cs-g cs-g${i}`}>
              {Array.from({ length: BAYS }, (_, b) => <rect key={b} x={TX + b * BW + 3} y={y + 4} width={BW - 3} height={FH - 4} fill="url(#cs-glassF)" />)}
              <polygon points={side(y + 4, FH - 4)} fill="url(#cs-glassS)" />
              {/* the sun's streak across the glass */}
              <polygon points={`${TX + 40 + (BASE - y) * 0.12},${y + 4} ${TX + 70 + (BASE - y) * 0.12},${y + 4} ${TX + 66 + (BASE - y - FH) * 0.12},${y + FH} ${TX + 36 + (BASE - y - FH) * 0.12},${y + FH}`} fill="url(#cs-shine)" />
              <rect x={TX} y={y + FH - 1.5} width={TW} height="1.5" fill="#1D2E3D" opacity=".55" />
            </g>
          </g>
        );
      })}
      <g className="cs-crown">
        <polygon points={`${TX - 6},${TOP} ${TX + SD - 6},${TOP - SK} ${TX + TW + SD + 4},${TOP - SK} ${TX + TW + 4},${TOP}`} fill="#3A4E60" />
        <rect x={TX - 6} y={TOP} width={TW + 10} height="7" fill="#24384A" />
        <rect x={TX + 50} y={TOP - 30} width="40" height="22" fill="#2F4558" />
        <line x1={TX + 70} y1={TOP - 30} x2={TX + 70} y2={TOP - 66} stroke="#2F4558" strokeWidth="2.2" />
        <circle className="cs-beacon" cx={TX + 70} cy={TOP - 68} r="3" fill="#F04438" />
      </g>
      <g className="cs-spark" fill="#FFB547"><circle cx={TX + 22} cy={BASE - 5 * FH + 6} r="2.4" /><circle cx={TX + 28} cy={BASE - 5 * FH + 2} r="1.3" /><circle cx={TX + 18} cy={BASE - 5 * FH + 1} r="1.1" /></g>

      {/* tower crane, with depth */}
      <Truss x={300} y={186} w={14} h={BASE - 186} vertical color={cr} back={crBack} />
      <rect x="292" y="178" width="30" height="12" fill="#B9842E" />
      <Truss x={240} y={188} w={330} h={11} color={cr} back={crBack} />
      <polygon points="307,128 300,178 314,178" fill={cr} />
      <line x1="307" y1="128" x2="566" y2="188" stroke={cr} strokeWidth="1.4" />
      <line x1="307" y1="128" x2="246" y2="188" stroke={cr} strokeWidth="1.4" />
      <rect x="244" y="199" width="34" height="22" fill="#5E5248" /><rect x="244" y="199" width="34" height="5" fill="#776A5E" />
      <rect x="316" y="200" width="22" height="20" rx="2" fill="#C99230" /><rect x="320" y="204" width="13" height="9" fill="#D9E6EF" opacity=".9" />
      <circle className="cs-beacon" cx="307" cy="124" r="3" fill="#F04438" />
      <g className="cs-trolley">
        <rect x="398" y="199" width="22" height="7" rx="1.5" fill="#4E4136" />
        <g clipPath="url(#cs-below-trolley)">
          <g className="cs-hook">
            <line x1="406" y1="60" x2="406" y2="252" stroke="#2F2A25" strokeWidth="1.1" />
            <line x1="412" y1="60" x2="412" y2="252" stroke="#2F2A25" strokeWidth="1.1" />
            <rect x="402" y="250" width="14" height="10" rx="2" fill="#E0A63A" />
            <path d="M406 260 h6 l-1 7 a3.5 3.5 0 1 1 -4 0z" fill="#2F2A25" />
            <g className="cs-load">
              <line x1="409" y1="270" x2="386" y2="284" stroke="#2F2A25" strokeWidth=".9" />
              <line x1="409" y1="270" x2="432" y2="284" stroke="#2F2A25" strokeWidth=".9" />
              <rect x="380" y="284" width="58" height="26" fill="url(#cs-glassF)" stroke="#D4DFE8" strokeWidth="1.2" />
              <rect x="380" y="284" width="58" height="26" fill="url(#cs-shine)" opacity=".7" />
            </g>
          </g>
        </g>
      </g>

      {/* dusk falls while signing in */}
      <rect className="cs-dusk" width="800" height={BASE + 10} fill="#16263A" style={{ mixBlendMode: 'multiply' }} />

      {/* the tower's lights, above the dusk so they glow */}
      {Array.from({ length: FLOORS }, (_, i) => {
        const y = BASE - (i + 1) * FH;
        return (
          <g key={i} className={`cs-l cs-l${i}`} style={{ '--f': i } as React.CSSProperties}>
            {Array.from({ length: BAYS }, (_, b) => (b * 3 + i) % 4 !== 1 && <rect key={b} x={TX + b * BW + 5} y={y + 8} width={BW - 7} height={FH - 12} fill="#FFD9A0" opacity=".88" />)}
            {i % 2 === 0 && <polygon points={side(y + 8, FH - 12, 6)} fill="#FFC979" opacity=".55" />}
          </g>
        );
      })}

      {/* street: pavement, site hoarding, road, cars, trees, lamps */}
      <rect x="0" y={BASE} width="800" height="22" fill="url(#cs-ground)" />
      <rect x={TX - 40} y={BASE - 20} width={TW + SD + 70} height="20" fill="#E5B850" />
      <g fill="#2B2722" opacity=".8">{Array.from({ length: 14 }, (_, k) => <polygon key={k} points={`${TX - 36 + k * 19},${BASE} ${TX - 27 + k * 19},${BASE - 20} ${TX - 19 + k * 19},${BASE - 20} ${TX - 28 + k * 19},${BASE}`} />)}</g>
      <rect x={TX - 40} y={BASE - 20} width={TW + SD + 70} height="3" fill="#FFF" opacity=".25" />
      <rect x="0" y={BASE + 22} width="800" height="128" fill="url(#cs-road)" />
      <rect x="0" y={BASE + 22} width="800" height="4" fill="#C8BBA6" />
      <g fill="#EDE3D1" opacity=".85">{Array.from({ length: 16 }, (_, k) => <rect key={k} x={k * 54 + 6} y={BASE + 70} width="28" height="3" rx="1" />)}</g>
      <Car y={BASE + 100} body="#B23A30" className="cs-car" />
      <Car y={BASE + 62} body="#2B5079" className="cs-car b" />
      {[150, 600].map((x) => (
        <g key={x}>
          <rect x={x} y={BASE - 74} width="3" height="74" fill="#3A3A3A" />
          <rect x={x - 10} y={BASE - 76} width="16" height="4" rx="2" fill="#3A3A3A" />
          <g className="cs-street"><circle cx={x - 4} cy={BASE - 66} r="38" fill="url(#cs-lamp)" /><circle cx={x - 4} cy={BASE - 71} r="3" fill="#FFF3D0" /></g>
        </g>
      ))}
      <Tree x={232} /><Tree x={352} s={0.85} /><Tree x={612} s={0.9} /><Tree x={770} />

      {/* film grain and a soft vignette: less flat, more like a photo */}
      <rect width="800" height="800" filter="url(#cs-grain)" opacity=".07" style={{ mixBlendMode: 'overlay' }} />
      <rect width="800" height="800" fill="url(#cs-vignette)" />
    </svg>
  );
}
