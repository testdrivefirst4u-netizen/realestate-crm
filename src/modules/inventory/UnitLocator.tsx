/**
 * UnitLocator — a 3D view of one residence among Amaya's three towers (seen from the south, the forest
 * on the left), with a compass rose, a floor-plan inset and a details card, plus PNG / WhatsApp sharing
 * for customers.
 *
 * Everything is hand-drawn SVG (oblique projection in unitLocatorLayout.ts — no 3D library). Residences
 * are placed from the floor plans in the brochure (see AMAYA_PLANS); towers the plans do not describe fall
 * back to a schematic arrangement and the view says so. The shared PNG is the same drawing re-composed
 * 1200 px wide with the details as text (SVG → Image → canvas → PNG).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Info, MessageCircle, Share2, Trees } from 'lucide-react';
import type { InventoryUnit, Lead } from '../../types/crm';
import { F } from '../../core/config';
import { formatPhone, toE164Digits } from '../../core/phone';
import { Badge, Button, InlineNotice, Modal } from '../../components/ui';
import { statusTone } from './inventoryUtils';
import {
  FacingInfo, LocatorConfig, LocatorScene, PLATE, Rect, SITE, TowerInfo,
  bearingVector, buildScene, customerStatus, facingPhrase, formatArea, shareCaption, shareDetails, sitePoint,
} from './unitLocatorLayout';

/* ------------------------------------------------------------------------ */
/* Palette & type                                                            */
/* ------------------------------------------------------------------------ */

const C = {
  navy: '#1D2F3F',
  midnight: '#23384A',
  limestone: '#E7D8C6',
  stone: '#D8CEC3',
  mist: '#ECE8E1',
  white: '#FDFCFA',
  gold: '#A9825A',
  sage: '#7C8B78',
  // shades of the palette for lit / shaded faces
  goldLight: '#C2A07A',
  goldDeep: '#8A6844',
  goldShadow: '#73563A',
  goldPale: '#F4ECE1',
  sageDeep: '#4F5D4C',
  ink: '#6B5F57',
  faint: '#9E948D',
  edge: '#B5A796',
} as const;

const FONT = "Jost, 'Helvetica Neue', Arial, sans-serif";
const SVG_NS = 'http://www.w3.org/2000/svg';
const EXPORT_WIDTH = 1200;

type Pt = [number, number];
type Shape =
  | { k: 'poly'; pts: Pt[]; fill: string; fo?: number; stroke?: string; sw?: number; so?: number; dash?: string }
  | { k: 'line'; pts: Pt[]; stroke: string; sw: number; so?: number; dash?: string }
  | { k: 'circle'; c: Pt; r: number; fill: string; fo?: number; stroke?: string; sw?: number }
  | { k: 'text'; at: Pt; text: string; size: number; fill: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; spacing?: number; halo?: boolean };

/** Where a drawing sits inside the 1200-px share image (omit → a responsive, full-width SVG). */
interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const ptsAttr = (pts: Pt[]) => pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function renderShape(s: Shape, key: number): React.ReactElement {
  switch (s.k) {
    case 'poly':
      return (
        <polygon key={key} points={ptsAttr(s.pts)} fill={s.fill} fillOpacity={s.fo} stroke={s.stroke || 'none'} strokeWidth={s.sw} strokeOpacity={s.so} strokeDasharray={s.dash} strokeLinejoin="round" />
      );
    case 'line':
      return <polyline key={key} points={ptsAttr(s.pts)} fill="none" stroke={s.stroke} strokeWidth={s.sw} strokeOpacity={s.so} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" />;
    case 'circle':
      return <circle key={key} cx={r1(s.c[0])} cy={r1(s.c[1])} r={s.r} fill={s.fill} fillOpacity={s.fo} stroke={s.stroke || 'none'} strokeWidth={s.sw} />;
    default:
      return (
        <text
          key={key}
          x={r1(s.at[0])}
          y={r1(s.at[1])}
          fontFamily={FONT}
          fontSize={s.size}
          fontWeight={s.weight || 400}
          fill={s.fill}
          textAnchor={s.anchor || 'start'}
          letterSpacing={s.spacing}
          stroke={s.halo ? C.white : undefined}
          strokeWidth={s.halo ? 3.2 : undefined}
          strokeLinejoin={s.halo ? 'round' : undefined}
          paintOrder={s.halo ? 'stroke' : undefined}
        >
          {s.text}
        </text>
      );
  }
}

function sizeProps(placement?: Placement): React.SVGProps<SVGSVGElement> {
  return placement
    ? { x: placement.x, y: placement.y, width: placement.width, height: placement.height }
    : { width: '100%', style: { display: 'block', width: '100%', height: 'auto' } };
}

function towerList(scene: LocatorScene): string {
  const ids = scene.towers.map((t) => t.id);
  return ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}` : ids.join('');
}

/** [value, detail] for the facing — `forShare` keeps internal hints off the customer image. */
function facingText(f: FacingInfo, forShare = false): [string, string] {
  if (f.kind === 'none') return forShare ? ['To be confirmed', ''] : ['Not recorded', 'Add it to the unit in Inventory'];
  if (f.kind === 'compass') return [f.label, f.fromPlan ? 'As per the floor plan' : `${f.angle}° bearing`];
  if (f.assumed) return [f.label, `Indicative ${f.angle}° bearing`];
  return [f.label, forShare ? '' : 'Not a compass direction'];
}

/** "Floor plan · as per plans" / "· schematic" for the inset headings. */
function planHeading(scene: LocatorScene, upper = false): string {
  const tail = scene.placement === 'plan' ? 'as per plans' : 'schematic';
  return upper ? `FLOOR PLAN · ${tail.toUpperCase()}` : `Floor plan · ${tail}`;
}

/* ------------------------------------------------------------------------ */
/* Isometric scene                                                           */
/* ------------------------------------------------------------------------ */

const STOREY = 11; // height of one storey, plan units
const CUT = 0.55; // the highlighted storey is cut at 55 % of its height so its plan shows
const LAWN = 10; // lawn round the row of towers
const BAND = 46; // width of the forest / gardens bands either side of the campus

interface Palette {
  west: string;
  south: string;
  roof: string;
  edge: string;
  glass: number; // opacity of the navy glazing bands
}
const PLAIN: Palette = { west: '#F0EBE4', south: '#E3DBD1', roof: C.white, edge: '#CFC5B9', glass: 0.08 };
const SELECTED: Palette = { west: C.limestone, south: C.stone, roof: C.white, edge: '#9E8F80', glass: 0.16 };

type Projector = (x: number, y: number, z: number) => Pt;

const rectAt = (P: Projector, r: Rect, z: number, inset = 0): Pt[] => [
  P(r.x + inset, r.y + inset, z),
  P(r.x + r.w - inset, r.y + inset, z),
  P(r.x + r.w - inset, r.y + r.h - inset, z),
  P(r.x + inset, r.y + r.h - inset, z),
];
const westFace = (P: Projector, z0: number, z1: number): Pt[] => [P(0, 0, z0), P(0, PLATE.depth, z0), P(0, PLATE.depth, z1), P(0, 0, z1)];
const southFace = (P: Projector, z0: number, z1: number): Pt[] => [P(0, 0, z0), P(PLATE.width, 0, z0), P(PLATE.width, 0, z1), P(0, 0, z1)];
const topFace = (P: Projector, z: number): Pt[] => rectAt(P, { x: 0, y: 0, w: PLATE.width, h: PLATE.depth }, z);

/** Solid storeys [from, to): two lit faces, a glazing band per storey and (optionally) the roof. */
function drawSolid(out: Shape[], P: Projector, from: number, to: number, pal: Palette, roof: boolean) {
  const { width: W, depth: D } = PLATE;
  const z0 = from * STOREY;
  const z1 = to * STOREY;
  out.push({ k: 'poly', pts: westFace(P, z0, z1), fill: pal.west, stroke: pal.edge, sw: 0.8 });
  out.push({ k: 'poly', pts: southFace(P, z0, z1), fill: pal.south, stroke: pal.edge, sw: 0.8 });
  for (let k = from; k < to; k++) {
    const a = k * STOREY + STOREY * 0.3;
    const b = k * STOREY + STOREY * 0.78;
    out.push({ k: 'poly', pts: [P(0, 5, a), P(0, D - 5, a), P(0, D - 5, b), P(0, 5, b)], fill: C.midnight, fo: pal.glass });
    out.push({ k: 'poly', pts: [P(5, 0, a), P(W - 5, 0, a), P(W - 5, 0, b), P(5, 0, b)], fill: C.midnight, fo: pal.glass * 1.25 });
  }
  if (roof) out.push({ k: 'poly', pts: topFace(P, z1), fill: pal.roof, stroke: pal.edge, sw: 0.8 });
}

/** Storeys above the highlighted one, drawn as frosted glass so the highlighted floor shows through. */
function drawGhost(out: Shape[], P: Projector, from: number, to: number) {
  const { width: W, depth: D } = PLATE;
  const z0 = from * STOREY;
  const z1 = to * STOREY;
  out.push({ k: 'line', pts: [P(0, D, z0), P(W, D, z0), P(W, 0, z0)], stroke: C.edge, sw: 0.6, so: 0.7, dash: '2 2' });
  out.push({ k: 'line', pts: [P(W, D, z0), P(W, D, z1)], stroke: C.edge, sw: 0.6, so: 0.7, dash: '2 2' });
  out.push({ k: 'poly', pts: westFace(P, z0, z1), fill: C.white, fo: 0.5, stroke: '#A79888', sw: 0.7, so: 0.85 });
  out.push({ k: 'poly', pts: southFace(P, z0, z1), fill: C.mist, fo: 0.55, stroke: '#A79888', sw: 0.7, so: 0.85 });
  for (let k = from; k < to; k++) {
    const a = k * STOREY + STOREY * 0.3;
    const b = k * STOREY + STOREY * 0.78;
    out.push({ k: 'poly', pts: [P(0, 5, a), P(0, D - 5, a), P(0, D - 5, b), P(0, 5, b)], fill: C.midnight, fo: 0.045 });
    out.push({ k: 'poly', pts: [P(5, 0, a), P(W - 5, 0, a), P(W - 5, 0, b), P(5, 0, b)], fill: C.midnight, fo: 0.06 });
  }
  out.push({ k: 'poly', pts: topFace(P, z1), fill: C.white, fo: 0.6, stroke: '#A79888', sw: 0.7, so: 0.85 });
}

/** A flat arrow lying on the plane z, from (x, y) along a compass bearing. */
function drawArrow(out: Shape[], P: Projector, x: number, y: number, z: number, angle: number, length: number, dashed: boolean, head = 7, width = 4.6, sw = 2.2) {
  const [dx, dy] = bearingVector(angle);
  const tip: Pt = [x + dx * length, y + dy * length];
  const base: Pt = [tip[0] - dx * head, tip[1] - dy * head];
  const left: Pt = [base[0] - dy * width, base[1] + dx * width];
  const right: Pt = [base[0] + dy * width, base[1] - dx * width];
  out.push({ k: 'line', pts: [P(x, y, z), P(base[0], base[1], z)], stroke: C.white, sw: sw + 3, so: 0.9 });
  out.push({ k: 'line', pts: [P(x, y, z), P(base[0], base[1], z)], stroke: C.navy, sw, dash: dashed ? '4 3' : undefined });
  out.push({ k: 'poly', pts: [P(tip[0], tip[1], z), P(left[0], left[1], z), P(right[0], right[1], z)], fill: C.navy, stroke: C.white, sw: 0.9 });
  out.push({ k: 'circle', c: P(x, y, z), r: 2.2, fill: C.navy, stroke: C.white, sw: 0.8 });
}

function drawTower(out: Shape[], scene: LocatorScene, tower: TowerInfo) {
  const { width: W, depth: D } = PLATE;
  const P: Projector = (x, y, z) => sitePoint(tower.x + x, y, z);
  const top = tower.floors * STOREY;
  const floor = tower.selected ? scene.floorIndex : null;
  const pal = tower.selected ? SELECTED : PLAIN;

  if (tower.selected) out.push({ k: 'poly', pts: rectAt(P, { x: -4, y: -4, w: W + 8, h: D + 8 }, 0), fill: C.gold, fo: 0.18 });

  if (floor === null) {
    drawSolid(out, P, 0, tower.floors, pal, true);
  } else {
    if (floor > 0) drawSolid(out, P, 0, floor, pal, false);
    const z0 = floor * STOREY;
    const zc = z0 + STOREY * CUT;
    out.push({ k: 'poly', pts: westFace(P, z0, zc), fill: C.goldLight, stroke: C.goldDeep, sw: 0.8 });
    out.push({ k: 'poly', pts: southFace(P, z0, zc), fill: C.gold, stroke: C.goldDeep, sw: 0.8 });
    out.push({ k: 'poly', pts: topFace(P, zc), fill: C.goldPale, stroke: C.gold, sw: 1 });
    const plate = scene.plate;
    if (plate) {
      out.push({ k: 'poly', pts: rectAt(P, plate.core, zc, 2), fill: C.stone, fo: 0.8 });
      for (const cell of plate.cells) {
        if (cell.slot === scene.slot) continue;
        out.push({ k: 'poly', pts: rectAt(P, cell, zc, 1.2), fill: C.limestone, stroke: C.edge, sw: 0.5 });
      }
    }
    if (floor + 1 < tower.floors) {
      drawGhost(out, P, floor + 1, tower.floors);
      // keep the highlighted floor's outline readable through the glass
      out.push({ k: 'poly', pts: topFace(P, zc), fill: 'none', stroke: C.gold, sw: 1.1, so: 0.9 });
    }
    const cell = plate ? plate.cells.find((c) => c.slot === scene.slot) : undefined;
    if (cell) {
      const zt = (floor + 1) * STOREY - 1.5;
      const i = 1.2;
      const x0 = cell.x + i;
      const x1 = cell.x + cell.w - i;
      const y0 = cell.y + i;
      const y1 = cell.y + cell.h - i;
      out.push({ k: 'poly', pts: [P(x0, y0, zc), P(x0, y1, zc), P(x0, y1, zt), P(x0, y0, zt)], fill: C.goldDeep, stroke: C.navy, sw: 0.9 });
      out.push({ k: 'poly', pts: [P(x0, y0, zc), P(x1, y0, zc), P(x1, y0, zt), P(x0, y0, zt)], fill: C.goldShadow, stroke: C.navy, sw: 0.9 });
      out.push({ k: 'poly', pts: [P(x0, y0, zt), P(x1, y0, zt), P(x1, y1, zt), P(x0, y1, zt)], fill: C.gold, stroke: C.navy, sw: 0.9 });
      if (scene.facing.angle !== null) {
        const len = 34;
        drawArrow(out, P, cell.fx, cell.fy, zt, scene.facing.angle, len, scene.facing.assumed);
        // Name the direction at the tip (west → left, east → right, north → up-right in this view).
        const [dx, dy] = bearingVector(scene.facing.angle);
        const [lx, ly] = P(cell.fx + dx * (len + 11), cell.fy + dy * (len + 11), zt);
        out.push({ k: 'text', at: [lx, ly + 3.6], text: scene.facing.short, size: 10.5, weight: 600, fill: C.navy, anchor: 'middle', halo: true });
      }
    }
  }

  // Tower letter above the roof
  const cx = P(W / 2, D / 2, top)[0];
  const cy = P(W, D, top)[1] - 24;
  out.push({ k: 'text', at: [cx, cy - 22], text: 'TOWER', size: 7.5, weight: 500, fill: C.faint, anchor: 'middle', spacing: 1.6 });
  out.push({ k: 'circle', c: [cx, cy], r: 15, fill: tower.selected ? C.gold : C.white, stroke: tower.selected ? C.goldDeep : C.stone, sw: 1.2 });
  out.push({ k: 'text', at: [cx, cy + 5.6], text: tower.id, size: 16, weight: 600, fill: tower.selected ? C.white : C.navy, anchor: 'middle' });
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bounds(shapes: Shape[], pad: number): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const s of shapes) {
    if (s.k === 'poly' || s.k === 'line') s.pts.forEach(([x, y]) => add(x, y));
    else if (s.k === 'circle') {
      add(s.c[0] - s.r, s.c[1] - s.r);
      add(s.c[0] + s.r, s.c[1] + s.r);
    } else {
      const w = s.text.length * s.size * 0.62;
      const left = s.anchor === 'middle' ? s.at[0] - w / 2 : s.anchor === 'end' ? s.at[0] - w : s.at[0];
      add(left, s.at[1] - s.size);
      add(left + w, s.at[1] + s.size * 0.3);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: r1(x0 - pad), y: r1(y0 - pad), w: r1(x1 - x0 + 2 * pad), h: r1(y1 - y0 + 2 * pad) };
}

/** The campus ground: lawn under the row of towers, the reserve forest to the west, gardens to the east. */
function drawSite(out: Shape[], scene: LocatorScene) {
  const { depth: D, width: W } = PLATE;
  const first = scene.towers[0];
  const last = scene.towers[scene.towers.length - 1];
  if (!first || !last) return;
  const x0 = first.x - LAWN;
  const x1 = last.x + W + LAWN;
  const G: Projector = (x, y, z) => sitePoint(x, y, z);
  const strip = (xa: number, xb: number, fill: string, fo: number) =>
    out.push({ k: 'poly', pts: rectAt(G, { x: xa, y: -LAWN, w: xb - xa, h: D + 2 * LAWN }, 0), fill, fo });
  strip(x0 - BAND - 6, x0 - 6, C.sage, 0.42); // forest
  strip(x0, x1, C.sage, 0.16); // campus lawn
  strip(x1 + 6, x1 + BAND + 6, C.sage, 0.26); // gardens
  // driveways north and south of the towers
  out.push({ k: 'line', pts: [G(x0, D + LAWN * 0.55, 0), G(x1, D + LAWN * 0.55, 0)], stroke: C.faint, sw: 0.7, dash: '3 3' });
  out.push({ k: 'line', pts: [G(x0, -LAWN * 0.55, 0), G(x1, -LAWN * 0.55, 0)], stroke: C.faint, sw: 0.7, dash: '3 3' });
  // band names at the south end, clear of the towers (which stand in front of the bands' northern halves)
  const fl = G(x0 - BAND / 2 - 6, 4, 0);
  const gl = G(x1 + BAND / 2 + 6, 4, 0);
  out.push({ k: 'text', at: [fl[0], fl[1] + 3], text: 'RESERVE FOREST', size: 5.8, weight: 600, fill: C.sageDeep, anchor: 'middle', spacing: 0.8 });
  out.push({ k: 'text', at: [gl[0], gl[1] + 3], text: 'GARDENS', size: 5.8, weight: 600, fill: C.sageDeep, anchor: 'middle', spacing: 0.8 });
  const sl = G((x0 + x1) / 2, -LAWN * 1.9, 0);
  out.push({ k: 'text', at: [sl[0], sl[1] + 3], text: 'DRIVEWAY · SOUTH', size: 5.6, weight: 500, fill: C.faint, anchor: 'middle', spacing: 1.1 });
}

function buildIsoGeometry(scene: LocatorScene): { shapes: Shape[]; box: Box } {
  const shapes: Shape[] = [];
  drawSite(shapes, scene);
  // West to east; the selected tower last so its highlights sit on top.
  [...scene.towers].sort((a, b) => Number(a.selected) - Number(b.selected) || a.x - b.x).forEach((tower) => drawTower(shapes, scene, tower));

  // North marker above the forest band: north runs up-right in this view.
  const b = bounds(shapes, 0);
  const base: Pt = [b.x + 30, b.y + 40];
  const G = (x: number, y: number): Pt => {
    const [px, py] = sitePoint(x, y, 0);
    return [base[0] + px, base[1] + py];
  };
  shapes.push({ k: 'line', pts: [G(-10, 0), G(14, 0)], stroke: C.faint, sw: 1 });
  shapes.push({ k: 'line', pts: [G(0, -10), G(0, 22)], stroke: C.navy, sw: 1.3 });
  shapes.push({ k: 'poly', pts: [G(0, 38), G(-5, 20), G(5, 22)], fill: C.navy });
  const n = G(0, 50);
  shapes.push({ k: 'text', at: [n[0], n[1] + 4.2], text: 'N', size: 12, weight: 700, fill: C.navy, anchor: 'middle' });
  const e = G(22, 0);
  shapes.push({ k: 'text', at: [e[0], e[1] + 3.4], text: 'E', size: 9.5, weight: 500, fill: C.faint, anchor: 'middle' });
  return { shapes, box: bounds(shapes, 14) };
}

function sceneTitle(scene: LocatorScene): string {
  const where = [scene.floorIndex !== null ? `on the ${lowerFirst(scene.floorLabel)}` : '', scene.knownTower ? `of ${scene.towerName}` : ''].filter(Boolean).join(' ');
  const facing = scene.facing.label ? `, facing ${scene.facing.label}` : '';
  return `3D view of towers ${towerList(scene)} from the south: residence ${scene.code || '—'} highlighted${where ? ` ${where}` : ''}${facing}.`;
}

export const IsoScene: React.FC<{ scene: LocatorScene; placement?: Placement }> = ({ scene, placement }) => {
  const uid = useId();
  const geo = useMemo(() => buildIsoGeometry(scene), [scene]);
  const { x, y, w, h } = geo.box;
  return (
    <svg viewBox={`${x} ${y} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby={`${uid}-t ${uid}-d`} {...sizeProps(placement)}>
      <title id={`${uid}-t`}>{sceneTitle(scene)}</title>
      <desc id={`${uid}-d`}>{scene.placementNote}</desc>
      {geo.shapes.map(renderShape)}
    </svg>
  );
};

/* ------------------------------------------------------------------------ */
/* Compass rose (north up)                                                   */
/* ------------------------------------------------------------------------ */

const polar = (deg: number, r: number, c = 80): Pt => {
  const a = (deg * Math.PI) / 180;
  return [c + r * Math.sin(a), c - r * Math.cos(a)];
};

export const CompassRose: React.FC<{ facing: FacingInfo; placement?: Placement }> = ({ facing, placement }) => {
  const uid = useId();
  const ticks: React.ReactElement[] = [];
  for (let i = 0; i < 16; i++) {
    const a = i * 22.5;
    const major = i % 4 === 0;
    const mid = i % 2 === 0;
    const [x1, y1] = polar(a, 55);
    const [x2, y2] = polar(a, major ? 45 : mid ? 48 : 51);
    ticks.push(<line key={i} x1={r1(x1)} y1={r1(y1)} x2={r1(x2)} y2={r1(y2)} stroke={major ? C.navy : mid ? C.ink : C.stone} strokeWidth={major ? 1.8 : 1.1} strokeLinecap="round" />);
    if (mid && !major) {
      const [a1, b1] = polar(a, 61);
      const [a2, b2] = polar(a, 69);
      ticks.push(<line key={`r${i}`} x1={r1(a1)} y1={r1(b1)} x2={r1(a2)} y2={r1(b2)} stroke={C.stone} strokeWidth={1.2} strokeLinecap="round" />);
    }
  }
  const letters: Array<[string, number]> = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  const a = facing.angle;
  const needle =
    a === null ? null : (
      <g>
        <polygon points={ptsAttr([polar(a, 42), polar(a + 90, 6), polar(a + 180, 14), polar(a - 90, 6)])} fill={C.stone} />
        <polygon points={ptsAttr([polar(a, 42), polar(a + 90, 6), polar(a - 90, 6)])} fill={C.gold} fillOpacity={facing.assumed ? 0.6 : 1} stroke={C.goldDeep} strokeWidth={0.8} strokeDasharray={facing.assumed ? '3 2' : undefined} />
      </g>
    );
  const title = a === null ? `Compass — facing ${facing.kind === 'none' ? 'not recorded' : facing.label}` : `Compass — facing ${facing.label} (${facing.assumed ? 'indicative ' : ''}${a}°)`;
  return (
    <svg viewBox="0 0 160 160" role="img" aria-labelledby={`${uid}-t`} {...sizeProps(placement)}>
      <title id={`${uid}-t`}>{title}</title>
      <circle cx={80} cy={80} r={75} fill={C.white} stroke={C.stone} strokeWidth={1.5} />
      <circle cx={80} cy={80} r={55} fill={C.mist} fillOpacity={0.6} stroke={C.stone} strokeWidth={0.8} />
      {ticks}
      {letters.map(([l, deg]) => {
        const [x, y] = polar(deg, 65);
        return (
          <text key={l} x={r1(x)} y={r1(y + 4.4)} fontFamily={FONT} fontSize={12.5} fontWeight={l === 'N' ? 700 : 500} fill={l === 'N' ? C.navy : C.ink} textAnchor="middle">
            {l}
          </text>
        );
      })}
      {needle}
      <circle cx={80} cy={80} r={4.5} fill={C.navy} stroke={C.white} strokeWidth={1.2} />
    </svg>
  );
};

/* ------------------------------------------------------------------------ */
/* Floor-plan inset (top-down, north up)                                     */
/* ------------------------------------------------------------------------ */

export const FloorPlan: React.FC<{ scene: LocatorScene; placement?: Placement; forShare?: boolean }> = ({ scene, placement, forShare }) => {
  const uid = useId();
  const plate = scene.plate;
  const m = 16;
  const side = 40; // room either side of the plate for the outlook captions
  if (!plate) {
    const headline = forShare ? 'Floor plan to follow' : 'Floor plan not available';
    return (
      <svg viewBox="0 0 164 124" role="img" aria-labelledby={`${uid}-t`} {...sizeProps(placement)}>
        <title id={`${uid}-t`}>{headline}</title>
        <rect x={2} y={2} width={160} height={120} rx={8} fill={C.mist} stroke={C.stone} strokeDasharray="4 3" />
        <text x={82} y={forShare ? 65 : 60} fontFamily={FONT} fontSize={8} fill={C.ink} textAnchor="middle">{headline}</text>
        {!forShare && <text x={82} y={74} fontFamily={FONT} fontSize={6.5} fill={C.faint} textAnchor="middle">Record the tower and floor to place it</text>}
      </svg>
    );
  }
  const { width: W, depth: D } = plate;
  const sy = (y: number) => D - y; // plan north-up → SVG y-down
  const sel = plate.cells.find((c) => c.slot === scene.slot);
  const shapes: Shape[] = [];
  if (sel && scene.facing.angle !== null) {
    // Same arrow helper, flat projection: x east, y north (flipped).
    drawArrow(shapes, (x, y) => [x, sy(y)], sel.fx, sel.fy, 0, scene.facing.angle, 14, scene.facing.assumed, 4.5, 3, 1.5);
  }
  const north: Pt = [W + side - 8, -4];
  const coreVertical = plate.core.h > plate.core.w * 2;
  const outlooks = scene.outlooks;
  const caption = (text: string, x: number, anchor: 'start' | 'end') => {
    // wrap at ~15 characters so the captions stay inside their band
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 15 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    const y0 = D / 2 - ((lines.length - 1) * 6.4) / 2;
    return lines.slice(0, 4).map((l, i) => (
      <text key={i} x={x} y={r1(y0 + i * 6.4)} fontFamily={FONT} fontSize={5.2} fill={C.sageDeep} textAnchor={anchor}>
        {l}
      </text>
    ));
  };
  const title = `${scene.floorLabel} of ${scene.towerName}: ${scene.placement === 'plan' ? 'floor plan' : 'schematic plan'} with ${plate.cells.length} ${plate.cells.length === 1 ? 'residence' : 'residences'}; ${scene.code} highlighted.`;
  return (
    <svg viewBox={`${-m - side} ${-m} ${W + 2 * m + 2 * side} ${D + 2 * m}`} role="img" aria-labelledby={`${uid}-t`} {...sizeProps(placement)}>
      <title id={`${uid}-t`}>{title}</title>
      {outlooks && (
        <g>
          <rect x={-side - m + 2} y={-2} width={side - 6} height={D + 4} rx={3} fill={C.sage} fillOpacity={0.14} />
          <rect x={W + 4 + m - 2} y={-2} width={side - 6} height={D + 4} rx={3} fill={C.sage} fillOpacity={0.14} />
          <text x={-side - m + 2 + (side - 6) / 2} y={D / 2 - 14} fontFamily={FONT} fontSize={5} fontWeight={700} fill={C.sageDeep} textAnchor="middle" letterSpacing={0.8}>WEST</text>
          <text x={W + 4 + m - 2 + (side - 6) / 2} y={D / 2 - 14} fontFamily={FONT} fontSize={5} fontWeight={700} fill={C.sageDeep} textAnchor="middle" letterSpacing={0.8}>EAST</text>
          <g transform={`translate(${-side - m + 2 + (side - 6) / 2} 0)`}>{caption(outlooks.W, 0, 'start').map((t) => React.cloneElement(t, { x: -(side - 6) / 2 + 3 }))}</g>
          <g transform={`translate(${W + 4 + m - 2 + (side - 6) / 2} 0)`}>{caption(outlooks.E, 0, 'start').map((t) => React.cloneElement(t, { x: -(side - 6) / 2 + 3 }))}</g>
        </g>
      )}
      <rect x={0} y={0} width={W} height={D} fill={C.white} stroke={C.midnight} strokeWidth={1} />
      {scene.emptyFaces.map((face) => {
        const x = face === 'W' ? 1 : plate.core.x + plate.core.w + 1;
        const w = face === 'W' ? plate.core.x - 2 : W - plate.core.x - plate.core.w - 2;
        return (
          <g key={face}>
            <rect x={x} y={1} width={w} height={D - 2} rx={1.5} fill={C.mist} fillOpacity={0.7} />
            <text transform={`translate(${x + w / 2 + 1.8} ${D / 2}) rotate(-90)`} fontFamily={FONT} fontSize={4.6} fill={C.faint} textAnchor="middle" letterSpacing={0.6}>
              {scene.floorIndex === 1 ? 'CLUB AMAYA' : 'NO RESIDENCES'}
            </text>
          </g>
        );
      })}
      <rect x={plate.core.x + 1} y={sy(plate.core.y + plate.core.h) + 1} width={plate.core.w - 2} height={plate.core.h - 2} rx={1.5} fill={C.mist} stroke={C.stone} strokeWidth={0.5} />
      {coreVertical ? (
        <text transform={`translate(${plate.core.x + plate.core.w / 2 + 1.8} ${sy(plate.core.y + plate.core.h / 2)}) rotate(-90)`} fontFamily={FONT} fontSize={3.6} fill={C.faint} textAnchor="middle" letterSpacing={0.5}>
          LIFTS · LOBBY
        </text>
      ) : (
        <text x={plate.core.x + plate.core.w / 2} y={sy(plate.core.y + plate.core.h / 2) + 2} fontFamily={FONT} fontSize={5.6} fill={C.faint} textAnchor="middle" letterSpacing={0.4}>
          LIFTS · LOBBY
        </text>
      )}
      {plate.cells.map((cell, i) => {
        const selected = cell === sel;
        const label = selected ? scene.label : scene.neighbours.find((n) => n.unit === cell.slot.unit)?.label || '';
        const size = Math.min(6.2, (cell.w - 3) / Math.max(1, label.length * 0.6), cell.h * 0.42);
        const cx = cell.x + cell.w / 2;
        const cy = sy(cell.y + cell.h / 2);
        return (
          <g key={i}>
            <rect x={r1(cell.x + 0.8)} y={r1(sy(cell.y + cell.h) + 0.8)} width={r1(cell.w - 1.6)} height={r1(cell.h - 1.6)} rx={1.2} fill={selected ? C.gold : C.limestone} stroke={selected ? C.goldDeep : 'none'} strokeWidth={0.8} />
            {label && size >= 3.4 && (
              <text x={r1(cx)} y={r1(cy + size * 0.36)} fontFamily={FONT} fontSize={r1(size)} fontWeight={selected ? 600 : 500} fill={selected ? C.white : C.navy} textAnchor="middle">
                {label}
              </text>
            )}
          </g>
        );
      })}
      {shapes.map(renderShape)}
      <g>
        <line x1={north[0]} y1={north[1]} x2={north[0]} y2={north[1] - 10} stroke={C.navy} strokeWidth={1} />
        <polygon points={ptsAttr([[north[0], north[1] - 13], [north[0] - 2.5, north[1] - 7.5], [north[0] + 2.5, north[1] - 7.5]])} fill={C.navy} />
        <text x={north[0]} y={north[1] + 8} fontFamily={FONT} fontSize={6.5} fontWeight={700} fill={C.navy} textAnchor="middle">N</text>
      </g>
    </svg>
  );
};

/* ------------------------------------------------------------------------ */
/* Shareable image (1200 px wide)                                            */
/* ------------------------------------------------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const ShareImage: React.FC<{ scene: LocatorScene; includeCustomer: boolean }> = ({ scene, includeCustomer }) => {
  const u = scene.unit;
  const cfg = scene.config;
  const M = 48;
  const headerH = 156;
  const bodyY = headerH + 28;
  const rightX = 776;
  const rightW = EXPORT_WIDTH - M - rightX;
  const status = customerStatus(u.status);
  const customer = includeCustomer ? String(u.customerName ?? '').trim() : '';
  const facts: Array<[string, string]> = [
    ['Type', scene.typeLabel || '—'],
    ['Floor', scene.floorLabel || '—'],
    ['Tower', scene.towerName || '—'],
    ['Facing', facingText(scene.facing, true)[0]],
    ['Carpet area', formatArea(u.carpetArea) || '—'],
    ['Built-up area', formatArea(u.totalArea) || '—'],
  ];
  if (scene.outlook) facts.push(['Outlook', scene.outlook]);
  if (status) facts.push(['Status', status]);
  if (customer) facts.push(['Customer', customer]);
  const cols = 4;
  const colW = (EXPORT_WIDTH - 2 * M - 56) / cols;
  const rows = Math.ceil(facts.length / cols);
  const factsY = bodyY + 584;
  const panelH = 34 + rows * 70;
  const noteY = factsY + panelH + 44;
  const footerY = (scene.note ? noteY + 22 : factsY + panelH) + 54;
  const height = footerY + 36;
  const headline = [scene.typeLabel, scene.floorLabel, scene.towerName, facingPhrase(scene.facing)].filter(Boolean).join('  ·  ');
  const [facingValue, facingDetail] = facingText(scene.facing, true);
  return (
    <svg xmlns={SVG_NS} viewBox={`0 0 ${EXPORT_WIDTH} ${height}`} width={EXPORT_WIDTH} height={height}>
      <rect x={0} y={0} width={EXPORT_WIDTH} height={height} fill={C.white} />
      <rect x={0} y={0} width={EXPORT_WIDTH} height={headerH} fill={C.navy} />
      <rect x={0} y={headerH - 5} width={EXPORT_WIDTH} height={5} fill={C.gold} />
      <text x={M} y={56} fontFamily={FONT} fontSize={19} fill={C.limestone} letterSpacing={1.2}>
        {[cfg.projectName, cfg.projectPlace].filter(Boolean).join('  ·  ')}
      </text>
      <text x={EXPORT_WIDTH - M} y={56} fontFamily={FONT} fontSize={14} fontWeight={500} fill={C.gold} letterSpacing={2.4} textAnchor="end">
        RESIDENCE LOCATOR
      </text>
      <text x={M} y={110} fontFamily={FONT} fontSize={46} fontWeight={500} fill={C.white}>
        {clip(`Residence ${scene.code || '—'}`, 36)}
      </text>
      <text x={M} y={140} fontFamily={FONT} fontSize={20} fill={C.limestone}>
        {clip(headline, 90)}
      </text>

      <IsoScene scene={scene} placement={{ x: M - 12, y: bodyY, width: 712, height: 560 }} />

      <CompassRose facing={scene.facing} placement={{ x: rightX, y: bodyY + 6, width: 150, height: 150 }} />
      <text x={rightX + 172} y={bodyY + 52} fontFamily={FONT} fontSize={13} fontWeight={500} fill={C.ink} letterSpacing={1.8}>
        FACING
      </text>
      <text x={rightX + 172} y={bodyY + 90} fontFamily={FONT} fontSize={facingValue.length > 12 ? 24 : 30} fontWeight={500} fill={C.navy}>
        {clip(facingValue, 17)}
      </text>
      {facingDetail && (
        <text x={rightX + 172} y={bodyY + 118} fontFamily={FONT} fontSize={16} fill={C.ink}>
          {facingDetail}
        </text>
      )}

      <rect x={rightX - 8} y={bodyY + 184} width={rightW + 16} height={376} rx={18} fill={C.white} stroke={C.stone} strokeWidth={1.5} />
      <text x={rightX + 14} y={bodyY + 220} fontFamily={FONT} fontSize={18} fontWeight={500} fill={C.navy}>
        {clip([scene.floorLabel, scene.towerName].filter(Boolean).join(' · ') || 'Floor plan', 34)}
      </text>
      <text x={rightX + 14} y={bodyY + 244} fontFamily={FONT} fontSize={13} fill={C.ink} letterSpacing={1.4}>
        {planHeading(scene, true)}
      </text>
      <FloorPlan forShare scene={scene} placement={{ x: rightX + 2, y: bodyY + 258, width: rightW - 4, height: 292 }} />

      <rect x={M} y={factsY} width={EXPORT_WIDTH - 2 * M} height={panelH} rx={20} fill={C.mist} />
      {facts.map(([label, value], i) => {
        const x = M + 28 + (i % cols) * colW;
        const y = factsY + 42 + Math.floor(i / cols) * 70;
        return (
          <g key={label}>
            <text x={x} y={y} fontFamily={FONT} fontSize={13} fontWeight={500} fill={C.ink} letterSpacing={1.8}>
              {label.toUpperCase()}
            </text>
            <text x={x} y={y + 30} fontFamily={FONT} fontSize={value.length > 19 ? 17 : 23} fontWeight={500} fill={C.navy}>
              {clip(value, 26)}
            </text>
          </g>
        );
      })}

      {scene.note && (
        <g>
          <circle cx={M + 8} cy={noteY - 7} r={6} fill={C.sage} />
          <text x={M + 24} y={noteY} fontFamily={FONT} fontSize={19} fill={C.sageDeep}>
            {scene.note}
          </text>
        </g>
      )}

      <line x1={M} y1={footerY - 30} x2={EXPORT_WIDTH - M} y2={footerY - 30} stroke={C.stone} strokeWidth={1} />
      <text x={M} y={footerY} fontFamily={FONT} fontSize={15} fill={C.ink}>
        {scene.placementNote}
      </text>
      {cfg.reraNumber && (
        <text x={EXPORT_WIDTH - M} y={footerY} fontFamily={FONT} fontSize={15} fill={C.ink} textAnchor="end">
          {cfg.reraNumber}
        </text>
      )}
    </svg>
  );
};

/* ------------------------------------------------------------------------ */
/* PNG / share plumbing (browser only)                                       */
/* ------------------------------------------------------------------------ */

const JOST_CSS = 'https://fonts.googleapis.com/css2?family=Jost:wght@300..700&display=swap';
let fontCssPromise: Promise<string> | null = null;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    window.clearTimeout(t);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the font.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * An SVG drawn as an image cannot use the page's web fonts, so the Jost (Latin) font file is inlined as a
 * data URL. Best effort: offline or blocked → '' and the image falls back to the system sans-serif.
 */
function embeddedFontCss(): Promise<string> {
  if (!fontCssPromise) {
    fontCssPromise = (async () => {
      try {
        const css = await (await fetchWithTimeout(JOST_CSS, 3500)).text();
        const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
        const latin = blocks.find((b) => b[1] === 'latin') || blocks[blocks.length - 1];
        const url = latin ? (latin[2].match(/url\(([^)]+)\)/) || [])[1] : '';
        if (!latin || !url) return '';
        const dataUrl = await blobToDataUrl(await (await fetchWithTimeout(url.replace(/["']/g, ''), 6000)).blob());
        return `@font-face{${latin[2].replace(/url\([^)]+\)/, `url(${dataUrl})`)}}`;
      } catch {
        return '';
      }
    })();
  }
  return fontCssPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not draw the locator image.'));
    img.src = src;
  });
}

/** Serialise the hidden share SVG → Image → canvas → PNG blob, EXPORT_WIDTH px wide. */
async function renderSharePng(container: HTMLElement | null): Promise<Blob> {
  const svg = container ? container.querySelector('svg') : null;
  if (!svg) throw new Error('The locator image is not ready yet — try again in a moment.');
  const fontCss = await embeddedFontCss();
  const vb = svg.viewBox.baseVal;
  const width = EXPORT_WIDTH;
  const height = Math.round(vb && vb.width ? (vb.height * width) / vb.width : width);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (fontCss) {
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = fontCss;
    clone.insertBefore(style, clone.firstChild);
  }
  const xml = new XMLSerializer().serializeToString(clone);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
  if (fontCss && typeof img.decode === 'function') await img.decode().catch(() => undefined);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot create images.');
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the PNG.'))), 'image/png'));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong — please try again.');

/* ------------------------------------------------------------------------ */
/* Panel                                                                     */
/* ------------------------------------------------------------------------ */

export interface UnitLocatorProps {
  unit: InventoryUnit;
  /** The whole inventory — used to place the residence's neighbours on its floor. */
  inventory: InventoryUnit[];
  /** Enquiries — when the unit is linked to one, its phone number opens that WhatsApp chat. Optional. */
  leads?: Lead[];
  onClose: () => void;
  /** Override the drawn towers / storeys, the indicative Forest & Club bearings or the project lines. */
  config?: Partial<LocatorConfig>;
}

type Busy = 'png' | 'wa' | 'share' | null;

const Fact: React.FC<{ label: string; value: React.ReactNode; wide?: boolean }> = ({ label, value, wide }) => (
  <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
    <dt className="text-[10px] font-bold uppercase tracking-wider text-[#6B5F57]">{label}</dt>
    <dd className="mt-0.5 truncate text-sm font-semibold text-[#1D2F3F]">{value}</dd>
  </div>
);

const Swatch: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span className="inline-flex items-center gap-1.5">
    <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
    {children}
  </span>
);

export const UnitLocator: React.FC<UnitLocatorProps> = ({ unit, inventory, leads, onClose, config }) => {
  const scene = useMemo(() => buildScene(inventory, unit, config), [inventory, unit, config]);
  const caption = useMemo(() => shareCaption(scene), [scene]);
  const lead = useMemo(() => (unit.leadId && leads ? leads.find((l) => String(l[F.ID] || '') === unit.leadId) : undefined), [leads, unit.leadId]);
  const phone = lead ? toE164Digits(lead[F.PHONE]) : '';
  const leadName = lead ? String(lead[F.NAME] || '').trim() : '';
  const customerName = String(unit.customerName ?? '').trim();

  const [includeCustomer, setIncludeCustomer] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'success' | 'warning'; text: React.ReactNode } | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const gen = useRef(0);
  const png = useRef<{ gen: number; promise: Promise<Blob>; blob?: Blob } | null>(null);

  const fileName = `Amaya-Residence-${(scene.code || 'unit').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unit'}.png`;
  const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(caption)}`;

  // Escape closes only this panel — the unit drawer may be open underneath and its Modal listens on document.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    try {
      const probe = new File([new Blob(['x'], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
      setCanShareFiles(typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] }));
    } catch {
      setCanShareFiles(false);
    }
  }, []);

  const ensurePng = useCallback((): Promise<Blob> => {
    if (png.current && png.current.gen === gen.current) return png.current.promise;
    const entry: { gen: number; promise: Promise<Blob>; blob?: Blob } = { gen: gen.current, promise: Promise.resolve(new Blob()) };
    entry.promise = renderSharePng(exportRef.current).then((b) => {
      entry.blob = b;
      return b;
    });
    entry.promise.catch(() => {
      if (png.current === entry) png.current = null;
    });
    png.current = entry;
    return entry.promise;
  }, []);

  // Pre-render the image so "Share image…" can hand it to the share sheet straight from the click.
  useEffect(() => {
    gen.current += 1;
    png.current = null;
    const t = window.setTimeout(() => {
      ensurePng().catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(t);
  }, [scene, includeCustomer, ensurePng]);

  const download = async () => {
    setNotice(null);
    setBusy('png');
    try {
      downloadBlob(await ensurePng(), fileName);
      setNotice({ tone: 'success', text: <>Saved <strong>{fileName}</strong> to your downloads.</> });
    } catch (e) {
      setNotice({ tone: 'warning', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const shareOnWhatsApp = async () => {
    setNotice(null);
    // Open WhatsApp straight from the click (pop-up blockers allow that), then save the image to attach.
    const win = window.open(waUrl, '_blank');
    if (win) {
      try {
        win.opener = null;
      } catch {
        /* already navigated away */
      }
    }
    setBusy('wa');
    try {
      downloadBlob(await ensurePng(), fileName);
      setNotice(
        win
          ? { tone: 'success', text: <>WhatsApp opened with the caption. Attach <strong>{fileName}</strong> from your downloads, then send.</> }
          : {
              tone: 'warning',
              text: (
                <>
                  Your browser blocked the WhatsApp window —{' '}
                  <a href={waUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                    open WhatsApp
                  </a>
                  . The image <strong>{fileName}</strong> is in your downloads.
                </>
              ),
            },
      );
    } catch (e) {
      setNotice({ tone: 'warning', text: `${win ? 'WhatsApp opened, but' : 'The WhatsApp window was blocked and'} the image could not be created: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const shareImage = async () => {
    setNotice(null);
    const ready = png.current && png.current.gen === gen.current ? png.current.blob : undefined;
    setBusy('share');
    try {
      const blob = ready || (await ensurePng());
      await navigator.share({ files: [new File([blob], fileName, { type: 'image/png' })], text: caption, title: `Residence ${scene.code}` });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setNotice({ tone: 'warning', text: 'The share sheet could not open — use Download PNG instead.' });
    } finally {
      setBusy(null);
    }
  };

  const copyDetails = async () => {
    if (await copyText(shareDetails(scene, { includeCustomer }).join('\n'))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      setNotice({ tone: 'warning', text: 'Your browser blocked the clipboard — select the caption above and copy it by hand.' });
    }
  };

  const u = scene.unit;
  const subtitle = [scene.typeLabel, scene.floorLabel, scene.towerName, facingPhrase(scene.facing)].filter(Boolean).join(' · ');

  return (
    <Modal
      open
      width="xl"
      onClose={onClose}
      title={`Locate residence ${scene.code || '—'}`}
      subtitle={subtitle || '3D view'}
      footer={
        <>
          <Button variant="ghost" onClick={copyDetails} icon={copied ? <Check size={13} /> : <Copy size={13} />} aria-label="Copy the residence details as text">
            {copied ? 'Copied' : 'Copy details'}
          </Button>
          <Button variant="secondary" onClick={download} loading={busy === 'png'} disabled={!!busy && busy !== 'png'} icon={<Download size={13} />} aria-label={`Download the locator image as ${fileName}`}>
            Download PNG
          </Button>
          {canShareFiles && (
            <Button variant="secondary" onClick={shareImage} loading={busy === 'share'} disabled={!!busy && busy !== 'share'} icon={<Share2 size={13} />} aria-label="Share the image and caption with your device's share sheet">
              Share image…
            </Button>
          )}
          <Button
            variant="gold"
            onClick={shareOnWhatsApp}
            loading={busy === 'wa'}
            disabled={!!busy && busy !== 'wa'}
            icon={<MessageCircle size={13} />}
            aria-label={phone ? `Share on WhatsApp with ${leadName || formatPhone(phone)}` : 'Share on WhatsApp — choose the contact in WhatsApp'}
          >
            Share on WhatsApp
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {scene.placementNote && (
          <InlineNotice>
            <span className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 flex-shrink-0 text-[#A9825A]" aria-hidden="true" />
              <span>{scene.placementNote}</span>
            </span>
          </InlineNotice>
        )}
        {scene.warnings.length > 0 && (
          <InlineNotice tone="warning">
            <ul className="list-disc space-y-0.5 pl-4">
              {scene.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </InlineNotice>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <figure className="m-0 min-w-0 rounded-2xl border border-[#D2C9BF] bg-white p-3 sm:p-4">
            <IsoScene scene={scene} />
            <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5F57]">
              <Swatch color={C.gold}>{scene.floorIndex !== null ? `${scene.floorLabel}, ${scene.towerName}` : 'Highlighted floor'}</Swatch>
              <Swatch color={C.goldShadow}>Residence {scene.code}</Swatch>
              {scene.facing.angle !== null && <span>Arrow: {facingPhrase(scene.facing).toLowerCase()}{scene.facing.assumed ? ' (indicative)' : ''}</span>}
              <span>Seen from the south · forest on the left · floors above shown as glass</span>
            </figcaption>
          </figure>

          <div className="min-w-0 space-y-4">
            <section aria-label="Residence details" className="rounded-2xl border border-[#D2C9BF] bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A9825A]">Residence</div>
                  <div className="truncate text-2xl font-semibold leading-tight text-[#1D2F3F]">{scene.code || '—'}</div>
                </div>
                <Badge tone={statusTone(u.status)}>{u.status || 'Unknown'}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Fact label="Tower" value={scene.towerName || '—'} />
                <Fact label="Floor" value={scene.floorLabel || '—'} />
                <Fact label="Type" value={scene.typeLabel || '—'} />
                <Fact label="Facing" value={scene.facing.kind === 'none' ? 'Not recorded' : `${scene.facing.label}${scene.facing.assumed ? ' (indicative)' : ''}`} />
                <Fact label="Carpet area" value={formatArea(u.carpetArea) || '—'} />
                <Fact label="Built-up area" value={formatArea(u.totalArea) || '—'} />
                {scene.outlook && <Fact wide label="Outlook" value={scene.outlook} />}
                {customerName && <Fact wide label={u.status === 'Booked' || u.status === 'Sold' ? `${u.status} by` : 'Customer'} value={customerName} />}
              </dl>
              {scene.note && (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-[#7C8B78]/10 p-2.5 text-xs text-[#3C573A]">
                  <Trees size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span>{scene.note}</span>
                </p>
              )}
            </section>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.5fr)]">
              <section aria-label="Facing" className="flex flex-col items-center rounded-2xl border border-[#D2C9BF] bg-white p-3 text-center">
                <div className="self-start text-[10px] font-bold uppercase tracking-wider text-[#6B5F57]">Facing · north up</div>
                <div className="mt-1 w-full max-w-[150px]">
                  <CompassRose facing={scene.facing} />
                </div>
                <div className="mt-1 text-sm font-semibold text-[#1D2F3F]">{facingText(scene.facing)[0]}</div>
                <div className="text-[10px] text-[#9E948D]">{facingText(scene.facing)[1]}</div>
              </section>
              <section aria-label="Floor plan" className="min-w-0 rounded-2xl border border-[#D2C9BF] bg-white p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#6B5F57]">{planHeading(scene)}</div>
                  {scene.plate && <div className="text-[10px] text-[#9E948D]">{scene.plate.cells.length} on this floor</div>}
                </div>
                <div className="mt-2">
                  <FloorPlan scene={scene} />
                </div>
              </section>
            </div>
          </div>
        </div>

        <section aria-label="Share" className="space-y-2.5 rounded-2xl border border-[#D2C9BF] bg-[#F4F0EB] p-3 sm:p-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#6B5F57]">WhatsApp caption</div>
          <p className="break-words text-xs text-[#1D2F3F]">{caption}</p>
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#6B5F57]">
            <Info size={13} className="mt-0.5 flex-shrink-0 text-[#A9825A]" aria-hidden="true" />
            <span>
              <strong>Share on WhatsApp</strong> saves the image to your downloads and opens WhatsApp (WhatsApp Web on a computer) with this caption already typed — attach the downloaded image to the chat, then send.{' '}
              {phone
                ? `The chat opens with ${leadName || 'the linked enquiry'} (${formatPhone(phone)}).`
                : 'No enquiry with a phone number is linked to this residence, so WhatsApp asks you to choose the contact.'}
              {canShareFiles && ' On this device, Share image… sends the picture and caption together.'}
            </span>
          </p>
          {customerName && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[#3D3530]">
              <input type="checkbox" checked={includeCustomer} onChange={(e) => setIncludeCustomer(e.target.checked)} className="h-3.5 w-3.5 accent-[#A9825A]" />
              Show the customer's name ({customerName}) on the image and in copied details
            </label>
          )}
          <div aria-live="polite">{notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}</div>
        </section>

        {/* The 1200-px share image, rendered off-screen and serialised on demand. */}
        <div ref={exportRef} hidden aria-hidden="true">
          <ShareImage scene={scene} includeCustomer={includeCustomer} />
        </div>
      </div>
    </Modal>
  );
};

export default UnitLocator;
