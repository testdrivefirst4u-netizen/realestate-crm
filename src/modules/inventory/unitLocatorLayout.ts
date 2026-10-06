/**
 * Unit locator — the pure layout maths behind the "where is this residence?" view.
 *
 * Amaya has three towers (A, B, C), Ground + 12 storeys, standing in a row from west (Tower A, beside the
 * Kandlakoya Reserve Forest) to east (Tower C). Each tower is a north–south slab with a WEST column and an
 * EAST column of residences either side of the lift core — see the Typical Floor Plan and Club Floor Plan
 * in "Floor Plans – Amaya Senior Living" (Vera Vita). Residences are numbered north → south, odd numbers
 * on the east face and even numbers on the west face (A-1201 east row 1, A-1202 west row 1 …); the club
 * floor (1st) of Tower A has only its west column (A101–A103), the 1st floors of Towers B and C are Club
 * Amaya and the ground floor is parking + lobbies. `AMAYA_PLANS` encodes exactly that, so a residence is
 * placed from its unit number alone and its facing follows from the face it sits on.
 *
 * Towers the plan does not describe (a future Tower D, a villa block) fall back to a schematic arrangement:
 * residences walk clockwise round the plate from the north-east corner, a recorded facing choosing the side.
 * Everything here is UI-free so it can be unit-tested.
 *
 *   parseUnitRef({ unitId: 'A-1203', tower: 'Tower A', floor: '12' }) → { tower: 'A', floorIndex: 12, unitNo: 3 }
 *   planCell(AMAYA_PLANS.A.typical, 3) → { side: 'E', row: 1, rows: 4, type: '1 BHK-B' }
 *   facingAngle('North-East') → { angle: 45, label: 'North-East', kind: 'compass', … }
 */
import type { InventoryUnit } from '../../types/crm';
import { normalizeUnitType, parseUnitType } from '../../core/units';
import { naturalCompare, unitKey } from './inventoryUtils';

/* ------------------------------------------------------------------------ */
/* Configuration                                                             */
/* ------------------------------------------------------------------------ */

export interface LocatorConfig {
  /** Towers drawn side by side, west to east (left to right in the view). */
  towers: readonly string[];
  /** Floor plates by tower letter. Towers missing here are arranged schematically. */
  plans: Readonly<Record<string, TowerPlans>>;
  /** Storeys per tower including the ground floor (Amaya: G + 12 = 13). */
  floorsPerTower: number;
  /**
   * Compass bearings (degrees clockwise from north) used for residences whose facing is recorded as
   * "Forest" or "Club". INDICATIVE until the site plan is loaded — the UI marks them as such.
   */
  forestBearing: number;
  clubBearing: number;
  /** Shown on the shared image. Empty string hides it. */
  projectName: string;
  projectPlace: string;
  reraNumber: string;
}

/* ------------------------------------------------------------------------ */
/* Floor plates (from the Floor Plans brochure)                               */
/* ------------------------------------------------------------------------ */

/**
 * Site geometry in plan units — x runs east, y runs north, origin at the south-west corner of Tower A's
 * plate. Proportions are taken off the Typical Floor Plan page (towers ≈ 2.5 × longer north–south than
 * wide, gaps between towers about one tower wide); the drawing is indicative, not to scale.
 */
export const SITE = Object.freeze({
  towerWidth: 40,
  towerDepth: 100,
  towerGap: 42,
  /** Lift core / corridor strip between the two columns of residences. */
  coreWidth: 6,
});

/** One column (face) of residences on a floor, listed north → south. */
export interface PlanColumn {
  /** Share of the tower's length each residence takes, north → south (sums to 1). */
  rows: readonly number[];
  /** Residence type at each row, as named on the plan. */
  types: readonly string[];
}

/** The two faces of a tower on one floor; `null` = no residences on that face. */
export interface TowerPlan {
  west: PlanColumn | null;
  east: PlanColumn | null;
  /** What each face looks out on, for the details card and the shared image. */
  outlook: { W: string; E: string };
}

export interface TowerPlans {
  /** The typical floor. */
  typical: TowerPlan;
  /** Floors that differ from the typical one; `null` = no residences on that floor (lobby, club). */
  floors: Readonly<Record<number, TowerPlan | null>>;
}

const BC_WEST: PlanColumn = Object.freeze({ rows: Object.freeze([0.24, 0.22, 0.26, 0.28]), types: Object.freeze(['2.5 BHK-A', '1 BHK-A', '2 BHK-A', '3 BHK']) });
const BC_EAST: PlanColumn = Object.freeze({ rows: Object.freeze([0.24, 0.22, 0.26, 0.28]), types: Object.freeze(['2.5 BHK-A', '1 BHK-B', '2 BHK-B', '2.5 BHK-B']) });
const A_WEST: PlanColumn = Object.freeze({ rows: Object.freeze([0.32, 0.37, 0.31]), types: Object.freeze(['3.5 BHK-A', '3 BHK', '3 BHK']) });
const A_EAST: PlanColumn = Object.freeze({ rows: Object.freeze([0.24, 0.24, 0.26, 0.26]), types: Object.freeze(['2.5 BHK-A', '1 BHK-B', '2 BHK-B', '2.5 BHK-B']) });

const FOREST = 'Reserve forest';
const COURT_AB = 'Courtyard garden (A–B)';
const COURT_BC = 'Pool courtyard (B–C)';
const GARDENS = 'East gardens';

const A_TYPICAL: TowerPlan = Object.freeze({ west: A_WEST, east: A_EAST, outlook: Object.freeze({ W: FOREST, E: COURT_AB }) });
const B_TYPICAL: TowerPlan = Object.freeze({ west: BC_WEST, east: BC_EAST, outlook: Object.freeze({ W: COURT_AB, E: COURT_BC }) });
const C_TYPICAL: TowerPlan = Object.freeze({ west: BC_WEST, east: BC_EAST, outlook: Object.freeze({ W: COURT_BC, E: GARDENS }) });

/**
 * Amaya's floor plates. Floor 0 is parking + lobbies everywhere; floor 1 is Club Amaya in Towers B and C
 * and, in Tower A, holds only the west column (A101 3.5 BHK, A102 and A103 3 BHK).
 */
export const AMAYA_PLANS: Readonly<Record<string, TowerPlans>> = Object.freeze({
  A: Object.freeze({ typical: A_TYPICAL, floors: Object.freeze({ 0: null, 1: Object.freeze({ west: A_WEST, east: null, outlook: A_TYPICAL.outlook }) }) }),
  B: Object.freeze({ typical: B_TYPICAL, floors: Object.freeze({ 0: null, 1: null }) }),
  C: Object.freeze({ typical: C_TYPICAL, floors: Object.freeze({ 0: null, 1: null }) }),
});

export const LOCATOR_DEFAULTS: Readonly<LocatorConfig> = Object.freeze({
  towers: Object.freeze(['A', 'B', 'C']),
  plans: AMAYA_PLANS,
  floorsPerTower: 13,
  forestBearing: 90,
  clubBearing: 270,
  projectName: 'Amaya by Vera Vita',
  projectPlace: 'Medchal, Hyderabad',
  reraNumber: 'TG RERA P02200011109',
});

export function resolveConfig(config?: Partial<LocatorConfig>): LocatorConfig {
  const c = { ...LOCATOR_DEFAULTS, ...(config || {}) };
  const towers = (c.towers && c.towers.length ? c.towers : LOCATOR_DEFAULTS.towers).map((t) => towerCode(t)).filter(Boolean);
  return {
    ...c,
    towers,
    plans: c.plans || {},
    floorsPerTower: Math.max(1, Math.round(Number(c.floorsPerTower) || LOCATOR_DEFAULTS.floorsPerTower)),
    forestBearing: normalizeBearing(c.forestBearing),
    clubBearing: normalizeBearing(c.clubBearing),
  };
}

/** Floor plate of a tower in plan units — x runs east, y runs north, origin at the south-west corner. `band` = depth of a residence in the schematic fallback. */
export const PLATE = Object.freeze({ width: SITE.towerWidth, depth: SITE.towerDepth, band: 16 });

export const PLAN_NOTE = 'Placed as per the Amaya floor plans (typical floor plan, north up). Drawing indicative, not to scale.';
export const SCHEMATIC_NOTE = 'Schematic view — unit positions are indicative; this tower is not in the loaded floor plans.';
export const FOREST_NOTE = 'Forest-facing: on the side of the 700-acre Kandlakoya Reserve Forest.';
export const CLUB_NOTE = 'Club-facing: on the Club Amaya side of the campus.';

/* ------------------------------------------------------------------------ */
/* Unit references (tower / floor / number)                                  */
/* ------------------------------------------------------------------------ */

export interface UnitRef {
  /** 'A' | 'B' | 'C' for Amaya's towers, another letter/label when the sheet says so, '' when unknown. */
  tower: string;
  /** 0 = Ground … 12. null when neither the Floor column nor the unit number gives it. */
  floorIndex: number | null;
  /** The residence's own number on its floor (A-1203 → 3, B-G-04 → 4); null when the id has none. */
  unitNo: number | null;
}

const TOWER_WORD = /\b(?:TOWER|TWR|BLOCK|BLK|WING|T)\s*[-_.:#]?\s*([A-Z])(?![A-Z])/;
const TOWER_SUFFIX = /^([A-Z])\s*[-_]?\s*(?:TOWER|TWR|BLOCK|BLK|WING)\b/;
const GROUND_TOKENS = new Set(['G', 'GF', 'GR', 'GRD', 'GND', 'GROUND']);

/** "Tower A", "a", "block-b", "C Tower" → "A" / "a" → "A" / "B" / "C". Other labels come back upper-cased; blank → ''. */
export function towerCode(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  if (/^[A-Z]$/.test(s)) return s;
  const m = s.match(TOWER_WORD) || s.match(TOWER_SUFFIX);
  return m ? m[1] : s.replace(/\s+/g, ' ');
}

/** "G", "GF", "Ground floor", 0 → 0 · "12", "12th Floor", "Floor 3", 7 → the number · blank / unreadable → null. */
export function parseFloor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const s = String(value).trim().toUpperCase();
  if (!s) return null;
  if (/^(?:G|GF|GR|GRD|GND|GROUND|UPPER GROUND)(?:\b|$)/.test(s)) return 0;
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 0 && n <= 200 ? n : null;
}

interface IdParts {
  tower: string;
  ground: boolean;
  nums: string[];
}

/** Split a unit number such as "Tower A-101", "A-1203", "B-G-04", "AG01", "A/12/03" into its parts. */
function splitUnitId(unitId: unknown): IdParts {
  let s = String(unitId ?? '').toUpperCase();
  let tower = '';
  const tw = s.match(TOWER_WORD);
  if (tw) {
    tower = tw[1];
    s = s.replace(tw[0], ' ');
  }
  s = s.replace(/\b(?:FLAT|UNIT|APT|APARTMENT|RESIDENCE|HOME|NO|NUMBER)\b\.?/g, ' ');
  let ground = false;
  const nums: string[] = [];
  for (const t of s.match(/[A-Z]+|\d+/g) || []) {
    if (/^\d+$/.test(t)) {
      nums.push(t);
      continue;
    }
    if (nums.length) continue; // letters after the number ("A-101B") are a suffix, not a tower
    if (GROUND_TOKENS.has(t)) {
      ground = true;
      continue;
    }
    if (!tower && /^[A-FH-Z]$/.test(t)) {
      tower = t; // a lone G is the ground floor, never a tower
      continue;
    }
    const combo = t.match(/^([A-FH-Z])(?:G|GF)$/); // "AG01" = tower A, ground floor, 01
    if (!tower && combo) {
      tower = combo[1];
      ground = true;
    }
  }
  return { tower, ground, nums };
}

function floorFromId(p: IdParts): number | null {
  if (p.ground) return 0;
  if (p.nums.length >= 2) return parseInt(p.nums[0], 10);
  if (p.nums.length === 1 && p.nums[0].length >= 3) return parseInt(p.nums[0].slice(0, -2), 10);
  return null;
}

function unitNoFromId(p: IdParts, floor: number | null): number | null {
  if (!p.nums.length) return null;
  const last = p.nums[p.nums.length - 1];
  if (p.ground || p.nums.length >= 2 || last.length <= 2) return parseInt(last, 10);
  // One run of 3+ digits = floor digits followed by the residence's own number (1203 → 12 | 03).
  if (floor !== null) {
    const f = String(floor);
    const rest = last.length - f.length;
    if (last.startsWith(f) && rest >= 1 && rest <= 2) return parseInt(last.slice(f.length), 10);
  }
  return parseInt(last.slice(-2), 10);
}

/**
 * Tower, floor and number of a residence. The Tower / Floor columns win; the unit number fills gaps
 * ("B-G-04" with a blank Floor → ground floor). Tolerant of "Tower A-101", "A-1203", "B-G-04", "A1203".
 */
export function parseUnitRef(unit: Partial<Pick<InventoryUnit, 'unitId' | 'tower' | 'floor'>>): UnitRef {
  const id = splitUnitId(unit.unitId);
  const tower = towerCode(unit.tower) || id.tower;
  const fromColumn = parseFloor(unit.floor);
  const floorIndex = fromColumn !== null ? fromColumn : floorFromId(id);
  return { tower, floorIndex, unitNo: unitNoFromId(id, floorIndex) };
}

/** The residence code shown to people: the sheet's unit number without a leading "Tower " ("Tower A-101" → "A-101"). */
export function unitCode(unit: Partial<InventoryUnit>): string {
  const raw = String(unit.unitId ?? '').trim();
  const stripped = raw.replace(/^(?:tower|block|wing)\s*/i, '').trim();
  if (stripped) return stripped;
  const ref = parseUnitRef(unit);
  const floor = ref.floorIndex === null ? '' : ref.floorIndex === 0 ? 'G' : String(ref.floorIndex);
  const no = ref.unitNo === null ? '' : String(ref.unitNo).padStart(2, '0');
  return [ref.tower, `${floor}${no}`].filter(Boolean).join('-');
}

/** Code without the tower prefix, for a cell on the floor plan: "A-1203" → "1203", "B-G-04" → "G-04". */
export function shortUnitCode(unit: Partial<InventoryUnit>, ref: UnitRef = parseUnitRef(unit)): string {
  const code = unitCode(unit);
  if (ref.tower.length === 1) {
    const s = code.replace(new RegExp(`^${ref.tower}\\s*[-_/ ]?\\s*(?=[0-9G])`, 'i'), '');
    if (s && s !== code) return s;
  }
  return code;
}

export function ordinal(n: number): string {
  const v = Math.abs(n) % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${n}${suffix}`;
}

/** 0 → "Ground floor", 12 → "12th floor", null → ''. */
export function floorLabel(floorIndex: number | null): string {
  if (floorIndex === null || floorIndex === undefined) return '';
  return floorIndex === 0 ? 'Ground floor' : `${ordinal(floorIndex)} floor`;
}

/* ------------------------------------------------------------------------ */
/* Facing                                                                    */
/* ------------------------------------------------------------------------ */

export type FacingKind = 'compass' | 'forest' | 'club' | 'other' | 'none';

export interface FacingInfo {
  /** Compass bearing, degrees clockwise from north (N 0, NE 45 … NW 315); null when unknown. */
  angle: number | null;
  /** "North-East", "Forest", "Club", the sheet's own text for anything else, '' when blank. */
  label: string;
  /** "NE" for compass facings, otherwise the label. */
  short: string;
  kind: FacingKind;
  /** True when the bearing is the configured default for Forest / Club rather than read from the sheet. */
  assumed: boolean;
  /** True when the facing follows from the residence's face on the floor plan (nothing recorded in the sheet). */
  fromPlan?: boolean;
}

const POINTS: ReadonlyArray<readonly [string, string]> = [
  ['N', 'North'], ['NNE', 'North-North-East'], ['NE', 'North-East'], ['ENE', 'East-North-East'],
  ['E', 'East'], ['ESE', 'East-South-East'], ['SE', 'South-East'], ['SSE', 'South-South-East'],
  ['S', 'South'], ['SSW', 'South-South-West'], ['SW', 'South-West'], ['WSW', 'West-South-West'],
  ['W', 'West'], ['WNW', 'West-North-West'], ['NW', 'North-West'], ['NNW', 'North-North-West'],
];

const WORD_POINT: Record<string, string> = {
  north: 'N', northern: 'N', south: 'S', southern: 'S', east: 'E', eastern: 'E', west: 'W', western: 'W',
  northeast: 'NE', northeastern: 'NE', northwest: 'NW', northwestern: 'NW',
  southeast: 'SE', southeastern: 'SE', southwest: 'SW', southwestern: 'SW',
};

function compassCode(text: string): string {
  let code = '';
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue;
    if (WORD_POINT[w]) code += WORD_POINT[w];
    else if (/^[nsew]{1,3}$/.test(w)) code += w.toUpperCase();
    // other words ("facing", "side", "corner", "view") carry no direction
  }
  if (/^[EW][NS]$/.test(code)) code = code[1] + code[0]; // "East-North" → NE
  return code;
}

export function normalizeBearing(deg: number): number {
  const d = (((Number(deg) || 0) % 360) + 360) % 360;
  return Math.round(d * 10) / 10;
}

/**
 * Facing text → compass bearing + label. "East", "E", "east facing" → 90 · "North-East", "NE", "N-E" → 45 ·
 * "NNE" → 22.5 · "Forest" / "Club" → the configured (indicative) bearing · blank → null.
 */
export function facingAngle(facing: unknown, config?: Partial<LocatorConfig>): FacingInfo {
  const raw = String(facing ?? '').trim();
  if (!raw) return { angle: null, label: '', short: '', kind: 'none', assumed: false };
  const t = raw.toLowerCase();
  if (/forest|kandlakoya|\breserve\b/.test(t)) {
    return { angle: resolveConfig(config).forestBearing, label: 'Forest', short: 'Forest', kind: 'forest', assumed: true };
  }
  if (/\bclub/.test(t)) {
    return { angle: resolveConfig(config).clubBearing, label: 'Club', short: 'Club', kind: 'club', assumed: true };
  }
  const deg = t.match(/^(\d{1,3}(?:\.\d+)?)\s*(?:°|deg(?:rees?)?)?$/);
  if (deg) {
    const a = normalizeBearing(parseFloat(deg[1]));
    return { angle: a, label: `${a}°`, short: `${a}°`, kind: 'compass', assumed: false };
  }
  const code = compassCode(raw);
  const i = POINTS.findIndex(([c]) => c === code);
  if (i >= 0) return { angle: i * 22.5, label: POINTS[i][1], short: POINTS[i][0], kind: 'compass', assumed: false };
  return { angle: null, label: raw, short: raw, kind: 'other', assumed: false };
}

/** "East" → "East facing"; '' when the facing is blank. */
export function facingPhrase(f: FacingInfo): string {
  return f.label ? `${f.label.replace(/\s*facing\s*$/i, '')} facing` : '';
}

/** The facing a residence has by sitting on the west or east face of its tower. */
export function planFacing(side: 'W' | 'E'): FacingInfo {
  return side === 'W'
    ? { angle: 270, label: 'West', short: 'W', kind: 'compass', assumed: false, fromPlan: true }
    : { angle: 90, label: 'East', short: 'E', kind: 'compass', assumed: false, fromPlan: true };
}

/* ------------------------------------------------------------------------ */
/* Placement from the floor plans                                            */
/* ------------------------------------------------------------------------ */

/**
 * The plate of `tower` on `floorIndex`: a TowerPlan, `null` when the plan says the floor has no residences
 * (lobby, club), `undefined` when the tower is not in the loaded plans.
 */
export function planForFloor(plans: Readonly<Record<string, TowerPlans>>, tower: string, floorIndex: number | null): TowerPlan | null | undefined {
  const t = plans[towerCode(tower)];
  if (!t) return undefined;
  if (floorIndex === null) return t.typical;
  return Object.prototype.hasOwnProperty.call(t.floors, floorIndex) ? t.floors[floorIndex] : t.typical;
}

export interface PlanCell {
  side: 'W' | 'E';
  /** 0-based row from the north end of the face. */
  row: number;
  /** Rows on that face. */
  rows: number;
  /** Residence type the plan shows at this position. */
  type: string;
}

/**
 * Where residence number `unitNo` sits on a plate. With both faces built, odd numbers take the east face
 * and even numbers the west face, each counted north → south (1 → E row 1, 2 → W row 1, 3 → E row 2 …);
 * with one face only, numbers run north → south along it. null when the number is off the plan.
 */
export function planCell(plan: TowerPlan, unitNo: number | null): PlanCell | null {
  if (unitNo === null || !Number.isFinite(unitNo) || unitNo < 1) return null;
  const n = Math.floor(unitNo);
  let side: 'W' | 'E';
  let row: number;
  if (plan.west && plan.east) {
    side = n % 2 === 1 ? 'E' : 'W';
    row = Math.ceil(n / 2) - 1;
  } else if (plan.west || plan.east) {
    side = plan.west ? 'W' : 'E';
    row = n - 1;
  } else return null;
  const col = side === 'W' ? plan.west : plan.east;
  if (!col || row >= col.rows.length) return null;
  return { side, row, rows: col.rows.length, type: col.types[row] || '' };
}

/** Rectangle of a plan cell in plan units (x east, y north, origin at the plate's south-west corner). */
export function planCellRect(plan: TowerPlan, cell: PlanCell): Rect {
  const col = (cell.side === 'W' ? plan.west : plan.east) as PlanColumn;
  const colW = (SITE.towerWidth - SITE.coreWidth) / 2;
  const before = col.rows.slice(0, cell.row).reduce((a, b) => a + b, 0);
  const h = SITE.towerDepth * col.rows[cell.row];
  const top = SITE.towerDepth * (1 - before);
  return { x: cell.side === 'W' ? 0 : SITE.towerWidth - colW, y: top - h, w: colW, h };
}

/** Every residence of a floor placed on the plan; `unplaced` lists the ones whose number is off the plan. */
export function planLayout(plan: TowerPlan, units: InventoryUnit[]): { plate: PlateLayout; arrangement: FloorArrangement; unplaced: InventoryUnit[]; cellOf: Map<InventoryUnit, PlanCell> } {
  const placed: Array<{ unit: InventoryUnit; cell: PlanCell; rect: Rect }> = [];
  const unplaced: InventoryUnit[] = [];
  const cellOf = new Map<InventoryUnit, PlanCell>();
  for (const unit of sortByUnitNumber(units)) {
    const cell = planCell(plan, parseUnitRef(unit).unitNo);
    if (!cell) {
      unplaced.push(unit);
      continue;
    }
    cellOf.set(unit, cell);
    placed.push({ unit, cell, rect: planCellRect(plan, cell) });
  }
  // Clockwise round the core: east face north → south, then west face south → north.
  const order = [
    ...placed.filter((p) => p.cell.side === 'E').sort((a, b) => a.cell.row - b.cell.row),
    ...placed.filter((p) => p.cell.side === 'W').sort((a, b) => b.cell.row - a.cell.row),
  ];
  const slots: UnitSlot[] = order.map((p, index) => ({
    unit: p.unit,
    index,
    count: order.length,
    side: p.cell.side,
    sideIndex: p.cell.row,
    sideCount: p.cell.rows,
    position: (p.cell.row + 0.5) / p.cell.rows,
    fromFacing: true,
  }));
  const bySide: Record<Side, UnitSlot[]> = { N: [], E: [], S: [], W: [] };
  for (const slot of slots) bySide[slot.side].push(slot);
  const cells: PlateCell[] = order.map((p, i) => ({
    ...p.rect,
    slot: slots[i],
    fx: p.cell.side === 'W' ? 0 : SITE.towerWidth,
    fy: p.rect.y + p.rect.h / 2,
  }));
  const colW = (SITE.towerWidth - SITE.coreWidth) / 2;
  const plate: PlateLayout = {
    width: SITE.towerWidth,
    depth: SITE.towerDepth,
    band: colW,
    cells,
    core: { x: colW, y: 0, w: SITE.coreWidth, h: SITE.towerDepth },
  };
  return { plate, arrangement: { count: slots.length, slots, bySide }, unplaced, cellOf };
}

/* ------------------------------------------------------------------------ */
/* Floors and slots                                                          */
/* ------------------------------------------------------------------------ */

export type Side = 'N' | 'E' | 'S' | 'W';
/** The walk round the plate, clockwise from the north-east corner. */
export const SIDES_CLOCKWISE: readonly Side[] = ['E', 'S', 'W', 'N'];
/** Bearing of the corner each side starts from when walking clockwise (east side starts at the NE corner). */
const SIDE_START: Record<Side, number> = { E: 45, S: 135, W: 225, N: 315 };
/** Room for residences along each side — north and south are the long sides of the plate. */
const SIDE_LENGTH: Record<Side, number> = {
  N: PLATE.width - PLATE.band,
  S: PLATE.width - PLATE.band,
  E: PLATE.depth - PLATE.band,
  W: PLATE.depth - PLATE.band,
};

/** Side of the plate a bearing faces out of: N [315°, 45°), E [45°, 135°), S [135°, 225°), W [225°, 315°). */
export function sideForBearing(angle: number): Side {
  const a = normalizeBearing(angle);
  return (['N', 'E', 'S', 'W'] as const)[Math.floor(((a + 45) % 360) / 90)];
}

export function sameUnit(a: InventoryUnit, b: InventoryUnit): boolean {
  if (a === b) return true;
  const ka = unitKey(a);
  return !!ka && ka === unitKey(b);
}

/** Sorted by the residence's own number, then naturally by unit number. */
export function sortByUnitNumber(units: InventoryUnit[]): InventoryUnit[] {
  return units
    .map((u) => ({ u, n: parseUnitRef(u).unitNo }))
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || naturalCompare(String(a.u.unitId || ''), String(b.u.unitId || '')))
    .map((x) => x.u);
}

/** Residences of one tower floor, sorted by unit number. `tower` may be "A" or "Tower A". */
export function floorUnits(inventory: InventoryUnit[], tower: string, floorIndex: number | null): InventoryUnit[] {
  const t = towerCode(tower);
  if (!t || floorIndex === null || floorIndex === undefined) return [];
  return sortByUnitNumber(
    inventory.filter((u) => {
      const r = parseUnitRef(u);
      return r.tower === t && r.floorIndex === floorIndex;
    }),
  );
}

export interface UnitSlot {
  unit: InventoryUnit;
  /** Place in the clockwise walk round the plate from the north-east corner (0-based). */
  index: number;
  /** Residences on the floor. */
  count: number;
  side: Side;
  /** 0-based place along its side, clockwise. */
  sideIndex: number;
  sideCount: number;
  /** Centre of the slot along its side, 0 → 1 clockwise (east side: 0 = north end, 1 = south end). */
  position: number;
  /** True when the side came from the residence's facing; false when it was filled in schematically. */
  fromFacing: boolean;
}

export interface FloorArrangement {
  count: number;
  /** All slots in clockwise order (slot.index === array index). */
  slots: UnitSlot[];
  bySide: Record<Side, UnitSlot[]>;
}

/**
 * Arrange a floor's residences round the plate. Residences with a facing go on that side (corner facings
 * at the start of the side that begins at that corner, e.g. North-East first on the east side); the rest
 * fill the sides that have the most room, in unit-number order, side by side clockwise from the NE corner.
 */
export function arrangeFloor(units: InventoryUnit[], config?: Partial<LocatorConfig>): FloorArrangement {
  const entries = sortByUnitNumber(units).map((unit, order) => {
    const f = facingAngle(unit.facing, config);
    const side: Side | null = f.angle === null ? null : sideForBearing(f.angle);
    const lean = side === null ? 45 : (normalizeBearing(f.angle as number) - SIDE_START[side] + 360) % 360;
    return { unit, order, side, lean, fromFacing: side !== null };
  });
  const fixed: Record<Side, number> = { N: 0, E: 0, S: 0, W: 0 };
  for (const e of entries) if (e.side) fixed[e.side]++;
  const total = { ...fixed };
  const free = entries.filter((e) => !e.side);
  for (let k = 0; k < free.length; k++) {
    let best: Side = SIDES_CLOCKWISE[0];
    for (const s of SIDES_CLOCKWISE) if (total[s] / SIDE_LENGTH[s] < total[best] / SIDE_LENGTH[best] - 1e-9) best = s;
    total[best]++;
  }
  let next = 0;
  for (const s of SIDES_CLOCKWISE) {
    for (let room = total[s] - fixed[s]; room > 0 && next < free.length; room--) free[next++].side = s;
  }

  const bySide: Record<Side, UnitSlot[]> = { N: [], E: [], S: [], W: [] };
  const slots: UnitSlot[] = [];
  for (const s of SIDES_CLOCKWISE) {
    const onSide = entries.filter((e) => e.side === s).sort((a, b) => a.lean - b.lean || a.order - b.order);
    onSide.forEach((e, i) => {
      const slot: UnitSlot = {
        unit: e.unit,
        index: slots.length,
        count: entries.length,
        side: s,
        sideIndex: i,
        sideCount: onSide.length,
        position: (i + 0.5) / onSide.length,
        fromFacing: e.fromFacing,
      };
      bySide[s].push(slot);
      slots.push(slot);
    });
  }
  return { count: entries.length, slots, bySide };
}

/** The slot of `unit` among the residences of its floor (the unit is added if the list does not hold it). */
export function unitSlot(unitsOnFloor: InventoryUnit[], unit: InventoryUnit, config?: Partial<LocatorConfig>): UnitSlot {
  const list = unitsOnFloor.some((u) => sameUnit(u, unit)) ? unitsOnFloor : [...unitsOnFloor, unit];
  return arrangeFloor(list, config).slots.find((s) => sameUnit(s.unit, unit)) as UnitSlot;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlateCell extends Rect {
  slot: UnitSlot;
  /** Mid-point of the cell's outside wall — where its facing arrow starts. */
  fx: number;
  fy: number;
}

export interface PlateLayout {
  width: number;
  depth: number;
  band: number;
  cells: PlateCell[];
  /** Lift core / lobby in the middle. */
  core: Rect;
}

/**
 * Cells for a floor arrangement in plan units (x east, y north). The sides form a pinwheel so each one
 * starts at its clockwise corner: east owns the NE corner, south the SE, west the SW, north the NW.
 */
export function plateLayout(arrangement: FloorArrangement): PlateLayout {
  const { width: W, depth: D, band: t } = PLATE;
  const cells = arrangement.slots.map((slot): PlateCell => {
    const k = slot.sideCount;
    const i = slot.sideIndex;
    switch (slot.side) {
      case 'E': {
        const h = (D - t) / k;
        const top = D - i * h;
        return { slot, x: W - t, y: top - h, w: t, h, fx: W, fy: top - h / 2 };
      }
      case 'S': {
        const w = (W - t) / k;
        const right = W - i * w;
        return { slot, x: right - w, y: 0, w, h: t, fx: right - w / 2, fy: 0 };
      }
      case 'W': {
        const h = (D - t) / k;
        const bottom = i * h;
        return { slot, x: 0, y: bottom, w: t, h, fx: 0, fy: bottom + h / 2 };
      }
      default: {
        const w = (W - t) / k;
        const left = i * w;
        return { slot, x: left, y: D - t, w, h: t, fx: left + w / 2, fy: D };
      }
    }
  });
  return { width: W, depth: D, band: t, cells, core: { x: t, y: t, w: W - 2 * t, h: D - 2 * t } };
}

/* ------------------------------------------------------------------------ */
/* Projection                                                                */
/* ------------------------------------------------------------------------ */

export const ISO_COS = Math.cos(Math.PI / 6);

/** Isometric projection seen from the south-west (x east, y north, z up) → SVG coordinates (y down). */
export function isoPoint(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * ISO_COS, -(x + y) / 2 - z];
}

/**
 * Oblique "front" projection used for the three-tower view: seen from the south, x (east) runs right,
 * z up, and north recedes up-right at a reduced scale — so towers standing in a west–east row never hide
 * one another and the cut floor's plan stays readable.
 */
export const SITE_VIEW = Object.freeze({ kx: 0.48, ky: 0.42 });
export function sitePoint(x: number, y: number, z = 0): [number, number] {
  return [x + y * SITE_VIEW.kx, -(z + y * SITE_VIEW.ky)];
}

/** (east, north) unit vector of a compass bearing. */
export function bearingVector(angle: number): [number, number] {
  const r = (angle * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/* ------------------------------------------------------------------------ */
/* Scene                                                                     */
/* ------------------------------------------------------------------------ */

export interface TowerInfo {
  id: string;
  /** Storeys drawn, ground floor included. */
  floors: number;
  /** Residences of this tower in the inventory. */
  units: number;
  selected: boolean;
  /** West edge of the tower's plate on the site, plan units (towers stand in a row west → east). */
  x: number;
  /** The tower is described by the loaded floor plans. */
  inPlans: boolean;
}

export interface NeighbourInfo {
  unit: InventoryUnit;
  code: string;
  /** Short code for a floor-plan cell ("1202"). */
  label: string;
  side: Side;
  index: number;
}

export interface LocatorScene {
  unit: InventoryUnit;
  config: LocatorConfig;
  ref: UnitRef;
  /** "A-1203" */
  code: string;
  /** "1203" */
  label: string;
  /** The residence's tower is one of the drawn towers. */
  knownTower: boolean;
  /** "Tower A" (or the sheet's own label for an unexpected tower); '' when unknown. */
  towerName: string;
  towers: TowerInfo[];
  /** Highlighted floor; null when unknown or above the drawn storeys. */
  floorIndex: number | null;
  floorLabel: string;
  typeLabel: string;
  facing: FacingInfo;
  /** Every residence on the highlighted floor (the selected one included), sorted by number. */
  floorUnits: InventoryUnit[];
  arrangement: FloorArrangement | null;
  plate: PlateLayout | null;
  slot: UnitSlot | null;
  /** The other residences on the floor, clockwise. */
  neighbours: NeighbourInfo[];
  /** The slots either side of this residence on the clockwise walk. */
  adjacent: { before: NeighbourInfo | null; after: NeighbourInfo | null };
  /** One line for forest- or club-facing residences, '' otherwise. */
  note: string;
  /** How the residence was positioned: from the floor plans, schematically, or not at all. */
  placement: 'plan' | 'schematic' | 'none';
  /** The footer line that goes with `placement`. */
  placementNote: string;
  /** What the residence's face looks out on (from the plan), '' when unknown. */
  outlook: string;
  /** Outlook of the plate's west and east faces, for the plan inset. */
  outlooks: { W: string; E: string } | null;
  /** The plan's own type at this position, '' when not placed by the plan. */
  planType: string;
  /** Faces of the plate with no residences on this floor (Tower A's club floor has an empty east face). */
  emptyFaces: Array<'W' | 'E'>;
  /** Data gaps the view had to work around (shown to the team, not on the shared image). */
  warnings: string[];
}

/** "3.5 BHK" and "3.5 BHK-A" are the same layout (no variant recorded); "1 BHK-A" and "1 BHK-B" are not. */
function sameLayout(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseUnitType(a);
  const pb = parseUnitType(b);
  if (!pa || !pb) return false;
  return pa.size === pb.size && (!pa.variant || !pb.variant || pa.variant === pb.variant);
}

/** Everything the locator needs to draw `unit` among the three towers. */
export function buildScene(inventory: InventoryUnit[], unit: InventoryUnit, config?: Partial<LocatorConfig>): LocatorScene {
  const cfg = resolveConfig(config);
  const ref = parseUnitRef(unit);
  const knownTower = !!ref.tower && cfg.towers.includes(ref.tower);
  const maxFloors = cfg.floorsPerTower + 4; // tolerate a terrace / extra level in the sheet, not typos like "120"

  const refs = inventory.map((u) => parseUnitRef(u));
  const towers: TowerInfo[] = cfg.towers.map((id, i) => {
    let top = cfg.floorsPerTower - 1;
    let units = 0;
    for (const r of refs) {
      if (r.tower !== id) continue;
      units++;
      if (r.floorIndex !== null && r.floorIndex < maxFloors) top = Math.max(top, r.floorIndex);
    }
    if (knownTower && id === ref.tower && ref.floorIndex !== null && ref.floorIndex < maxFloors) top = Math.max(top, ref.floorIndex);
    return { id, floors: top + 1, units, selected: knownTower && id === ref.tower, x: i * (SITE.towerWidth + SITE.towerGap), inPlans: !!cfg.plans[id] };
  });

  const warnings: string[] = [];
  const tower = towers.find((t) => t.selected);
  const floorIndex = tower && ref.floorIndex !== null && ref.floorIndex < tower.floors ? ref.floorIndex : null;
  if (!ref.tower) warnings.push('Tower not recorded for this residence — add it to the unit in Inventory to place it on the view.');
  else if (!knownTower) warnings.push(`Tower “${ref.tower}” is not one of the project's towers (${cfg.towers.join(', ')}), so no tower is highlighted.`);
  if (ref.floorIndex === null) warnings.push('Floor not recorded — the tower is shown without a highlighted floor.');
  else if (tower && floorIndex === null) warnings.push(`Floor ${ref.floorIndex} is above the ${tower.floors} storeys drawn for Tower ${tower.id}.`);

  let onFloor: InventoryUnit[] = [];
  if (tower && floorIndex !== null) {
    onFloor = floorUnits(inventory, tower.id, floorIndex);
    if (!onFloor.some((u) => sameUnit(u, unit))) onFloor = sortByUnitNumber([...onFloor, unit]);
  }

  // Placement: the floor plans when they describe this tower and floor, otherwise the schematic walk.
  const plan = tower && floorIndex !== null ? planForFloor(cfg.plans, tower.id, floorIndex) : undefined;
  let placement: LocatorScene['placement'] = 'none';
  let arrangement: FloorArrangement | null = null;
  let plate: PlateLayout | null = null;
  let planType = '';
  let outlooks: LocatorScene['outlooks'] = null;
  let emptyFaces: Array<'W' | 'E'> = [];
  let cell: PlanCell | null = null;
  if (plan) {
    const laid = planLayout(plan, onFloor);
    cell = laid.cellOf.get(unit) || null;
    if (cell) {
      placement = 'plan';
      arrangement = laid.arrangement;
      plate = laid.plate;
      planType = cell.type;
      outlooks = plan.outlook;
      emptyFaces = (['W', 'E'] as const).filter((f) => !(f === 'W' ? plan.west : plan.east));
      for (const u of laid.unplaced) warnings.push(`${unitCode(u)} has no place on the floor plan (number ${parseUnitRef(u).unitNo ?? '?'} is beyond the ${(plan.west?.rows.length || 0) + (plan.east?.rows.length || 0)} residences drawn on this floor).`);
    } else {
      warnings.push(`Residence number ${ref.unitNo ?? '?'} is not on the floor plan of ${floorLabel(floorIndex)} of Tower ${tower?.id} — shown schematically instead.`);
    }
  } else if (plan === null && tower && floorIndex !== null) {
    warnings.push(`The floor plans show no residences on the ${floorLabel(floorIndex).toLowerCase()} of Tower ${tower.id} (${floorIndex === 0 ? 'parking and lobbies' : 'Club Amaya'}) — check the unit number.`);
  }
  if (placement !== 'plan' && onFloor.length) {
    placement = 'schematic';
    arrangement = arrangeFloor(onFloor, cfg);
    plate = plateLayout(arrangement);
  }

  // Facing: the plan's face unless the sheet records a facing of its own.
  let facing = facingAngle(unit.facing, cfg);
  if (cell) {
    const fromPlan = planFacing(cell.side);
    if (facing.kind === 'none') facing = fromPlan;
    else if (facing.kind === 'compass' && facing.angle !== null && sideForBearing(facing.angle) !== cell.side) {
      warnings.push(`The inventory records “${facing.label}” facing, but the floor plan puts this residence on the ${cell.side === 'W' ? 'west' : 'east'} face — the plan is used.`);
      facing = fromPlan;
    } else if (facing.kind === 'forest' || facing.kind === 'club') facing = { ...fromPlan, label: fromPlan.label, kind: facing.kind };
  }
  if (facing.kind === 'none') warnings.push('Facing not recorded — the residence is placed by its unit number and no facing arrow is drawn.');
  else if (facing.kind === 'other') warnings.push(`Facing “${facing.label}” is not a compass direction, so no facing arrow is drawn.`);
  else if (facing.assumed) warnings.push(`“${facing.label}” facing is drawn at an indicative ${facing.angle}° bearing until the site plan is loaded.`);

  const sheetType = normalizeUnitType(unit.unitType);
  if (planType && sheetType && !sameLayout(sheetType, planType)) {
    warnings.push(`The floor plan shows a ${planType} at this position; the inventory says ${sheetType}.`);
  }

  const slot = arrangement ? arrangement.slots.find((s) => sameUnit(s.unit, unit)) || null : null;
  const toNeighbour = (s: UnitSlot): NeighbourInfo => ({ unit: s.unit, code: unitCode(s.unit), label: shortUnitCode(s.unit), side: s.side, index: s.index });
  const neighbours = arrangement ? arrangement.slots.filter((s) => s !== slot).map(toNeighbour) : [];
  const ring = arrangement ? arrangement.slots : [];
  const adjacent =
    slot && ring.length > 1
      ? { before: toNeighbour(ring[(slot.index - 1 + ring.length) % ring.length]), after: ring.length > 2 ? toNeighbour(ring[(slot.index + 1) % ring.length]) : null }
      : { before: null, after: null };

  const rawTower = String(unit.tower ?? '').trim();
  const towerName = ref.tower.length === 1 ? `Tower ${ref.tower}` : rawTower || ref.tower;
  const outlook = cell && outlooks ? outlooks[cell.side] : '';
  const note = facing.kind === 'forest' || /reserve forest/i.test(outlook) ? FOREST_NOTE : facing.kind === 'club' ? CLUB_NOTE : '';

  return {
    unit,
    config: cfg,
    ref,
    code: unitCode(unit),
    label: shortUnitCode(unit, ref),
    knownTower,
    towerName,
    towers,
    floorIndex,
    floorLabel: floorLabel(ref.floorIndex),
    typeLabel: sheetType || planType,
    facing,
    floorUnits: onFloor,
    arrangement,
    plate,
    slot,
    neighbours,
    adjacent,
    note,
    placement,
    placementNote: placement === 'plan' ? PLAN_NOTE : placement === 'schematic' ? SCHEMATIC_NOTE : '',
    outlook,
    outlooks,
    planType,
    emptyFaces,
    warnings,
  };
}

/* ------------------------------------------------------------------------ */
/* Share text                                                                */
/* ------------------------------------------------------------------------ */

/** 1231.08 → "1,231 sq. ft." · 0 / blank → ''. */
export function formatArea(value: unknown): string {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 ? `${Math.round(v).toLocaleString('en-IN')} sq. ft.` : '';
}

/** Statuses that make sense to a customer; internal ones (Owner, Blocked, …) are left off shared material. */
export const CUSTOMER_STATUSES: readonly string[] = ['Available', 'Reserved', 'Booked', 'Sold'];

export function customerStatus(status: unknown): string {
  const s = String(status ?? '').trim();
  return CUSTOMER_STATUSES.includes(s) ? s : '';
}

/** One-line WhatsApp caption: "Amaya by Vera Vita — Residence A-1203 · 2.5 BHK-A · 12th floor, Tower A · East facing · Carpet 1,231 sq. ft." */
export function shareCaption(scene: LocatorScene): string {
  const carpet = formatArea(scene.unit.carpetArea);
  const parts = [
    scene.code ? `Residence ${scene.code}` : '',
    scene.typeLabel,
    [scene.floorLabel, scene.towerName].filter(Boolean).join(', '),
    facingPhrase(scene.facing),
    carpet ? `Carpet ${carpet}` : '',
  ].filter(Boolean);
  const name = scene.config.projectName;
  return name ? `${name} — ${parts.join(' · ')}` : parts.join(' · ');
}

export interface ShareDetailsOptions {
  /** Add the customer's name (off by default — the image may be sent to someone else). */
  includeCustomer?: boolean;
}

/** The details card as plain lines — used for "Copy details" and the text block of the shared image. */
export function shareDetails(scene: LocatorScene, options: ShareDetailsOptions = {}): string[] {
  const u = scene.unit;
  const cfg = scene.config;
  const carpet = formatArea(u.carpetArea);
  const built = formatArea(u.totalArea);
  const status = customerStatus(u.status);
  const customer = options.includeCustomer ? String(u.customerName ?? '').trim() : '';
  return [
    [cfg.projectName, cfg.projectPlace].filter(Boolean).join(' · '),
    [scene.code ? `Residence ${scene.code}` : '', scene.towerName, scene.floorLabel].filter(Boolean).join(' · '),
    [scene.typeLabel, facingPhrase(scene.facing)].filter(Boolean).join(' · '),
    [carpet ? `Carpet area ${carpet}` : '', built ? `Built-up area ${built}` : ''].filter(Boolean).join(' · '),
    status ? `Status: ${status}${customer ? ` · ${customer}` : ''}` : customer ? `Customer: ${customer}` : '',
    scene.outlook ? `Outlook: ${scene.outlook}` : '',
    scene.note,
    scene.placementNote,
  ].filter(Boolean);
}
