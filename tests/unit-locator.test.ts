/**
 * Unit locator (src/modules/inventory/unitLocatorLayout.ts + UnitLocator.tsx): unit-number parsing, facing,
 * placement from the Amaya floor plans (odd numbers east, even west, north → south), the schematic
 * fallback for towers the plans do not describe, the scene, the share text — and a server render of the
 * panel (no DOM needed; effects such as the PNG pre-render do not run here).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InventoryUnit, Lead } from '../src/types/crm';
import { F } from '../src/core/config';
import {
  AMAYA_PLANS, FOREST_NOTE, LOCATOR_DEFAULTS, PLAN_NOTE, PLATE, SCHEMATIC_NOTE, SITE,
  arrangeFloor, buildScene, facingAngle, floorLabel, floorUnits, isoPoint, ordinal, parseFloor, parseUnitRef, planCell, planCellRect,
  planForFloor, planLayout, plateLayout, shareCaption, shareDetails, shortUnitCode, sideForBearing, sitePoint, towerCode, unitCode, unitSlot,
} from '../src/modules/inventory/unitLocatorLayout';
import { UnitLocator } from '../src/modules/inventory/UnitLocator';

const mk = (unitId: string, tower: string, floor: string | number, extra: Partial<InventoryUnit> = {}): InventoryUnit => ({
  inventoryId: `INV-${unitId}`,
  unitId,
  tower,
  floor,
  unitType: '2 BHK-A',
  carpetArea: 1112.94,
  totalArea: 1533.28,
  uds: 55.22,
  status: 'Available',
  ...extra,
});

/** Tower A, 12th floor (+ a few residences elsewhere). */
const A1203 = mk('A-1203', 'Tower A', '12', { unitType: '2.5 BHK Type A', carpetArea: 1231.08, totalArea: 1696.03, facing: 'East' });
const inventory: InventoryUnit[] = [
  mk('A-1201', 'Tower A', '12', { facing: 'East' }),
  mk('A-1202', 'Tower A', '12'),
  A1203,
  mk('A-1204', 'Tower A', '12', { facing: 'Forest', status: 'Booked', customerName: 'Meera Rao', leadId: 'ENQ-0042' }),
  mk('A-1205', 'Tower A', '12', { facing: 'West' }),
  mk('A-1206', 'Tower A', '12'),
  mk('A-1101', 'Tower A', '11', { facing: 'East' }),
  mk('B-G-04', 'B', 'G', { unitType: '1 BHK-A' }),
  mk('C-305', 'Tower C', '3', { facing: 'South' }),
];

describe('parseUnitRef', () => {
  it('reads tower, floor and number from the usual spellings', () => {
    const cases: Array<[Partial<InventoryUnit>, { tower: string; floorIndex: number | null; unitNo: number | null }]> = [
      [{ unitId: 'Tower A-101', tower: 'Tower A', floor: '1' }, { tower: 'A', floorIndex: 1, unitNo: 1 }],
      [{ unitId: 'A-1203', tower: 'A', floor: '12' }, { tower: 'A', floorIndex: 12, unitNo: 3 }],
      [{ unitId: 'B-G-04', tower: '', floor: 'G' }, { tower: 'B', floorIndex: 0, unitNo: 4 }],
      [{ unitId: 'B-G-04', tower: '', floor: '' }, { tower: 'B', floorIndex: 0, unitNo: 4 }],
      [{ unitId: 'A1203', tower: '', floor: '' }, { tower: 'A', floorIndex: 12, unitNo: 3 }],
      [{ unitId: 'C-001', tower: 'Tower C', floor: 'Ground' }, { tower: 'C', floorIndex: 0, unitNo: 1 }],
      [{ unitId: '1203', tower: 'Block B', floor: 12 }, { tower: 'B', floorIndex: 12, unitNo: 3 }],
      [{ unitId: 'A-12-03', tower: '', floor: undefined }, { tower: 'A', floorIndex: 12, unitNo: 3 }],
      [{ unitId: 'G-02', tower: 'C', floor: '' }, { tower: 'C', floorIndex: 0, unitNo: 2 }],
      [{ unitId: 'AG01', tower: '', floor: '' }, { tower: 'A', floorIndex: 0, unitNo: 1 }],
      [{ unitId: 'Flat No. C-1001', tower: '', floor: '' }, { tower: 'C', floorIndex: 10, unitNo: 1 }],
      [{ unitId: 'A-110', tower: 'A', floor: '1' }, { tower: 'A', floorIndex: 1, unitNo: 10 }],
      [{ unitId: 'B-1010', tower: 'tower b', floor: '10th Floor' }, { tower: 'B', floorIndex: 10, unitNo: 10 }],
      [{ unitId: 'A-5', tower: 'A', floor: '7' }, { tower: 'A', floorIndex: 7, unitNo: 5 }],
      [{ unitId: 'Villa 7', tower: 'Villas', floor: '' }, { tower: 'VILLAS', floorIndex: null, unitNo: 7 }],
      [{ unitId: '', tower: '', floor: '' }, { tower: '', floorIndex: null, unitNo: null }],
    ];
    for (const [input, expected] of cases) expect(parseUnitRef(input), JSON.stringify(input)).toEqual(expected);
  });

  it('lets the Floor column win over the unit number', () => {
    expect(parseUnitRef({ unitId: 'A-1203', tower: 'A', floor: '11' })).toEqual({ tower: 'A', floorIndex: 11, unitNo: 3 });
  });

  it('normalises tower and floor cells', () => {
    expect(['A', 'a', 'Tower A', 'TOWER-A', 'Block A', 'A Tower', 'T-A', 'Wing A'].map(towerCode)).toEqual(Array(8).fill('A'));
    expect(towerCode('')).toBe('');
    expect(towerCode('Villas')).toBe('VILLAS');
    const floors: Array<[unknown, number | null]> = [
      ['G', 0], ['GF', 0], ['Gr', 0], ['Ground floor', 0], ['0', 0], [0, 0], ['1', 1], ['1st', 1], ['12th Floor', 12], ['Floor 3', 3], [12, 12], ['', null], [null, null], ['Terrace', null],
    ];
    for (const [input, expected] of floors) expect(parseFloor(input), String(input)).toBe(expected);
  });

  it('formats codes and floor names for people', () => {
    expect(unitCode({ unitId: 'Tower A-101' })).toBe('A-101');
    expect(unitCode({ unitId: 'A-1203' })).toBe('A-1203');
    expect(unitCode({ unitId: '', tower: 'B', floor: 'G' })).toBe('B-G');
    expect(shortUnitCode({ unitId: 'A-1203', tower: 'A' })).toBe('1203');
    expect(shortUnitCode({ unitId: 'B-G-04', tower: 'B' })).toBe('G-04');
    expect(shortUnitCode({ unitId: '1203', tower: 'B' })).toBe('1203');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(floorLabel(0)).toBe('Ground floor');
    expect(floorLabel(12)).toBe('12th floor');
    expect(floorLabel(null)).toBe('');
  });
});

describe('facingAngle', () => {
  it('maps compass words and abbreviations to bearings', () => {
    const cases: Array<[string, number, string]> = [
      ['North', 0, 'North'], ['East', 90, 'East'], ['east facing', 90, 'East'], ['E', 90, 'East'], ['South', 180, 'South'], ['W', 270, 'West'],
      ['North-East', 45, 'North-East'], ['North East', 45, 'North-East'], ['NE', 45, 'North-East'], ['N-E', 45, 'North-East'], ['Northeast', 45, 'North-East'],
      ['S-W', 225, 'South-West'], ['south west', 225, 'South-West'], ['NW', 315, 'North-West'], ['East-North', 45, 'North-East'],
      ['NNE', 22.5, 'North-North-East'], ['WNW', 292.5, 'West-North-West'], ['Corner (E & N)', 45, 'North-East'], ['135°', 135, '135°'],
    ];
    for (const [text, angle, label] of cases) {
      const f = facingAngle(text);
      expect(f.angle, text).toBe(angle);
      expect(f.label, text).toBe(label);
      expect(f.kind, text).toBe('compass');
      expect(f.assumed, text).toBe(false);
    }
  });

  it('gives Forest and Club the configured, indicative bearing', () => {
    expect(facingAngle('Forest')).toMatchObject({ angle: LOCATOR_DEFAULTS.forestBearing, label: 'Forest', kind: 'forest', assumed: true });
    expect(facingAngle('Reserve forest view')).toMatchObject({ kind: 'forest' });
    expect(facingAngle('Club House')).toMatchObject({ angle: LOCATOR_DEFAULTS.clubBearing, label: 'Club', kind: 'club', assumed: true });
    expect(facingAngle('Forest', { forestBearing: 270 }).angle).toBe(270);
    expect(facingAngle('Club', { clubBearing: -90 }).angle).toBe(270);
  });

  it('keeps blanks and unknown words without a bearing', () => {
    expect(facingAngle('')).toEqual({ angle: null, label: '', short: '', kind: 'none', assumed: false });
    expect(facingAngle(undefined).kind).toBe('none');
    expect(facingAngle('Garden')).toMatchObject({ angle: null, label: 'Garden', kind: 'other' });
  });

  it('assigns each bearing to one side of the plate', () => {
    expect([0, 44, 45, 90, 134, 135, 180, 224, 225, 270, 314, 315, 359].map(sideForBearing)).toEqual(['N', 'N', 'E', 'E', 'E', 'S', 'S', 'S', 'W', 'W', 'W', 'N', 'N']);
  });
});

describe('floors and slots', () => {
  const plain = (n: number) => Array.from({ length: n }, (_, i) => mk(`D-50${i + 1}`, 'D', 5));

  it('lists a floor sorted by unit number, whatever the tower spelling', () => {
    const shuffled = [inventory[5], inventory[2], inventory[0], inventory[4], inventory[1], inventory[3]];
    expect(floorUnits(shuffled, 'A', 12).map((u) => u.unitId)).toEqual(['A-1201', 'A-1202', 'A-1203', 'A-1204', 'A-1205', 'A-1206']);
    expect(floorUnits(inventory, 'Tower A', 12)).toHaveLength(6);
    expect(floorUnits(inventory, 'B', 0).map((u) => u.unitId)).toEqual(['B-G-04']);
    expect(floorUnits(inventory, 'A', null)).toEqual([]);
  });

  it('walks clockwise from the north-east corner, balancing the sides by length', () => {
    const units = plain(8);
    const arr = arrangeFloor(units);
    expect(arr.count).toBe(8);
    expect(arr.slots.map((s) => s.unit.unitId)).toEqual(units.map((u) => u.unitId)); // sequential round the plate
    expect(arr.slots.map((s) => s.side).join('')).toBe('EEESWWWN'); // the long east and west faces take three each
    expect(arr.slots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const first = unitSlot(units, units[0]);
    expect(first).toMatchObject({ index: 0, count: 8, side: 'E', sideIndex: 0, sideCount: 3 });
    expect(first.position).toBeCloseTo(1 / 6);
    expect(unitSlot(units, units[7])).toMatchObject({ index: 7, side: 'N', sideIndex: 0, position: 0.5 });
    expect(arrangeFloor(plain(6)).slots.map((s) => s.side).join('')).toBe('EESWWN');
    expect(unitSlot([], plain(1)[0])).toMatchObject({ index: 0, count: 1, side: 'E', position: 0.5 });
  });

  it('puts a residence on the side it faces, corner facings at their corner', () => {
    const units = [
      mk('D-501', 'D', 5, { facing: 'West' }),
      mk('D-502', 'D', 5),
      mk('D-503', 'D', 5, { facing: 'East' }),
      mk('D-504', 'D', 5, { facing: 'North-East' }),
      mk('D-505', 'D', 5, { facing: 'South' }),
      mk('D-506', 'D', 5),
    ];
    const arr = arrangeFloor(units);
    const at = (id: string) => arr.slots.find((s) => s.unit.unitId === id)!;
    expect(at('D-504')).toMatchObject({ side: 'E', index: 0, sideIndex: 0, fromFacing: true }); // the NE corner
    expect(at('D-503')).toMatchObject({ side: 'E', index: 1 });
    expect(at('D-501')).toMatchObject({ side: 'W', fromFacing: true });
    expect(at('D-505').side).toBe('S');
    expect(at('D-502')).toMatchObject({ side: 'W', fromFacing: false }); // free residences fill the long faces first
    expect(at('D-506')).toMatchObject({ side: 'N', fromFacing: false });
    expect(arr.slots.map((s) => s.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('adds the residence when it is missing from the floor list', () => {
    const units = plain(3);
    const extra = mk('D-509', 'D', 5);
    expect(unitSlot(units, extra)).toMatchObject({ count: 4, index: 3 });
  });

  it('lays the cells out inside the plate without overlaps, each against its own wall', () => {
    for (const n of [1, 2, 5, 6, 7, 8, 11]) {
      const plate = plateLayout(arrangeFloor(plain(n)));
      expect(plate.cells).toHaveLength(n);
      for (const c of plate.cells) {
        expect(c.x).toBeGreaterThanOrEqual(-1e-9);
        expect(c.y).toBeGreaterThanOrEqual(-1e-9);
        expect(c.x + c.w).toBeLessThanOrEqual(PLATE.width + 1e-9);
        expect(c.y + c.h).toBeLessThanOrEqual(PLATE.depth + 1e-9);
        const wall = { E: c.x + c.w === PLATE.width, W: c.x === 0, N: c.y + c.h === PLATE.depth, S: c.y === 0 }[c.slot.side];
        expect(wall, `${n}:${c.slot.side}`).toBe(true);
      }
      for (let i = 0; i < plate.cells.length; i++) {
        for (let j = i + 1; j < plate.cells.length; j++) {
          const a = plate.cells[i];
          const b = plate.cells[j];
          const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-9 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-9;
          expect(overlap, `${n}: cells ${i} and ${j}`).toBe(false);
        }
      }
    }
    const eight = plateLayout(arrangeFloor(plain(8))).cells;
    expect(eight[0]).toMatchObject({ x: PLATE.width - PLATE.band, y: PLATE.depth - 28, w: PLATE.band, h: 28, fx: PLATE.width }); // first slot owns the NE corner
  });

  it('places Amaya residences from the floor plans: odd numbers east, even west, north → south', () => {
    const typical = AMAYA_PLANS.B.typical;
    expect(planCell(typical, 1)).toEqual({ side: 'E', row: 0, rows: 4, type: '2.5 BHK-A' });
    expect(planCell(typical, 2)).toEqual({ side: 'W', row: 0, rows: 4, type: '2.5 BHK-A' });
    expect(planCell(typical, 3)).toMatchObject({ side: 'E', row: 1, type: '1 BHK-B' });
    expect(planCell(typical, 4)).toMatchObject({ side: 'W', row: 1, type: '1 BHK-A' });
    expect(planCell(typical, 8)).toMatchObject({ side: 'W', row: 3, type: '3 BHK' });
    expect(planCell(typical, 9)).toBeNull(); // only eight on a typical floor of B
    expect(planCell(typical, null)).toBeNull();
    // Tower A: three on the west face (3.5 BHK, 3 BHK, 3 BHK), four on the east
    const a = AMAYA_PLANS.A.typical;
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => planCell(a, n)!.type)).toEqual(['2.5 BHK-A', '3.5 BHK-A', '1 BHK-B', '3 BHK', '2 BHK-B', '3 BHK', '2.5 BHK-B']);
    expect(planCell(a, 8)).toBeNull();
    // The club floor of Tower A holds only its west column, numbered north → south
    const club = planForFloor(AMAYA_PLANS, 'Tower A', 1)!;
    expect(club.east).toBeNull();
    expect([1, 2, 3].map((n) => planCell(club, n)!)).toMatchObject([{ side: 'W', row: 0, type: '3.5 BHK-A' }, { side: 'W', row: 1, type: '3 BHK' }, { side: 'W', row: 2, type: '3 BHK' }]);
    expect(planCell(club, 4)).toBeNull();
    expect(planForFloor(AMAYA_PLANS, 'B', 1)).toBeNull(); // Club Amaya
    expect(planForFloor(AMAYA_PLANS, 'C', 0)).toBeNull(); // parking + lobbies
    expect(planForFloor(AMAYA_PLANS, 'C', 7)).toBe(AMAYA_PLANS.C.typical);
    expect(planForFloor(AMAYA_PLANS, 'D', 7)).toBeUndefined();
    // every row share adds up to the tower's length
    for (const t of Object.values(AMAYA_PLANS)) for (const col of [t.typical.west, t.typical.east]) expect(col!.rows.reduce((p, q) => p + q, 0)).toBeCloseTo(1);
    const r = planCellRect(typical, planCell(typical, 1)!);
    expect(r).toMatchObject({ x: SITE.towerWidth - (SITE.towerWidth - SITE.coreWidth) / 2, w: (SITE.towerWidth - SITE.coreWidth) / 2 });
    expect(r.y + r.h).toBeCloseTo(SITE.towerDepth); // row 1 touches the north end
    const laid = planLayout(typical, Array.from({ length: 8 }, (_, i) => mk(`B-70${i + 1}`, 'B', 7)));
    expect(laid.unplaced).toEqual([]);
    expect(laid.arrangement.slots.map((s) => s.unit.unitId)).toEqual(['B-701', 'B-703', 'B-705', 'B-707', 'B-708', 'B-706', 'B-704', 'B-702']); // clockwise round the core
    expect(laid.plate.cells.every((c) => c.x >= 0 && c.x + c.w <= SITE.towerWidth && c.y >= -1e-9 && c.y + c.h <= SITE.towerDepth + 1e-9)).toBe(true);
    expect(laid.plate.core).toMatchObject({ w: SITE.coreWidth, h: SITE.towerDepth });
  });

  it('projects isometrically from the south-west', () => {
    expect(isoPoint(0, 0, 0).map(Math.abs)).toEqual([0, 0]);
    const [ex, ey] = isoPoint(10, 0, 0); // east → right and up
    expect(ex).toBeGreaterThan(0);
    expect(ey).toBeLessThan(0);
    const [nx, ny] = isoPoint(0, 10, 0); // north → left and up
    expect(nx).toBeLessThan(0);
    expect(ny).toBeLessThan(0);
    expect(isoPoint(0, 0, 20)).toEqual([0, -20]);
    // the site view: from the south, east → right, north → up-right (reduced), up → up
    expect(sitePoint(10, 0, 0)).toEqual([10, -0]);
    const [sx, sy] = sitePoint(0, 10, 0);
    expect(sx).toBeGreaterThan(0);
    expect(sx).toBeLessThan(10);
    expect(sy).toBeLessThan(0);
    expect(sitePoint(0, 0, 20)).toEqual([0, -20]);
  });
});

describe('buildScene', () => {
  it('describes the tower, floor, slot, facing and neighbours', () => {
    const s = buildScene(inventory, A1203);
    expect(s.towers.map((t) => [t.id, t.floors, t.selected])).toEqual([['A', 13, true], ['B', 13, false], ['C', 13, false]]);
    expect(s.towers.map((t) => t.units)).toEqual([7, 1, 1]);
    expect(s).toMatchObject({ code: 'A-1203', label: '1203', towerName: 'Tower A', floorIndex: 12, floorLabel: '12th floor', typeLabel: '2.5 BHK-A', knownTower: true });
    expect(s.facing).toMatchObject({ angle: 90, label: 'East', kind: 'compass' }); // the sheet's own facing agrees with the plan
    expect(s.floorUnits).toHaveLength(6);
    expect(s.placement).toBe('plan');
    expect(s.placementNote).toBe(PLAN_NOTE);
    expect(s.towers.map((t) => [t.x, t.inPlans])).toEqual([[0, true], [82, true], [164, true]]);
    expect(s.slot).toMatchObject({ side: 'E', index: 1, sideIndex: 1, sideCount: 4 }); // 1203 → east face, second from the north
    expect(s.neighbours.map((n) => n.label)).toEqual(['1201', '1205', '1206', '1204', '1202']); // east face north → south, then west south → north
    expect(s.adjacent.before?.code).toBe('A-1201');
    expect(s.adjacent.after?.code).toBe('A-1205');
    expect(s.plate?.cells).toHaveLength(6);
    expect(s.outlook).toBe('Courtyard garden (A–B)');
    expect(s.outlooks).toEqual({ W: 'Reserve forest', E: 'Courtyard garden (A–B)' });
    expect(s.planType).toBe('1 BHK-B');
    expect(s.note).toBe('');
    expect(s.warnings).toEqual(['The floor plan shows a 1 BHK-B at this position; the inventory says 2.5 BHK-A.']);
  });

  it('derives the facing from the face the residence sits on, and keeps Forest as a note', () => {
    const s = buildScene(inventory, inventory[3]); // A-1204 → west face, sheet says "Forest"
    expect(s.facing).toMatchObject({ angle: 270, label: 'West', kind: 'forest', assumed: false, fromPlan: true });
    expect(s.note).toBe(FOREST_NOTE);
    expect(s.outlook).toBe('Reserve forest');
    expect(s.warnings.join(' ')).not.toMatch(/indicative/);

    const blank = buildScene(inventory, inventory[5]); // A-1206, nothing recorded → west face
    expect(blank.facing).toMatchObject({ angle: 270, label: 'West', kind: 'compass', fromPlan: true });
    expect(blank.warnings.join(' ')).not.toMatch(/Facing not recorded/);

    const south = buildScene(inventory, inventory[8]); // C-305: the sheet says South, the plan says east face
    expect(south.facing).toMatchObject({ angle: 90, label: 'East', fromPlan: true });
    expect(south.warnings.join(' ')).toMatch(/inventory records “South” facing, but the floor plan puts this residence on the east face/);
    expect(south.outlook).toBe('East gardens');

    const club = buildScene(inventory, mk('B-104', 'B', '1'));
    expect(club.placement).toBe('schematic');
    expect(club.warnings.join(' ')).toMatch(/no residences on the 1st floor of Tower B \(Club Amaya\)/);
    const nine = buildScene([...inventory, mk('C-309', 'C', '3')], mk('C-309', 'C', '3'));
    expect(nine.placement).toBe('schematic');
    expect(nine.warnings.join(' ')).toMatch(/number 9 is not on the floor plan/);

    // a tower outside the plans keeps the schematic walk and says so
    const d = buildScene([mk('D-501', 'D', '5'), mk('D-502', 'D', '5')], mk('D-501', 'D', '5'), { towers: ['A', 'B', 'C', 'D'] });
    expect(d.placement).toBe('schematic');
    expect(d.placementNote).toBe(SCHEMATIC_NOTE);
    expect(d.towers[3]).toMatchObject({ id: 'D', x: 3 * (SITE.towerWidth + SITE.towerGap), inPlans: false });
  });

  it('copes with missing or unexpected data', () => {
    const ground = buildScene(inventory, inventory[7]);
    expect(ground).toMatchObject({ code: 'B-G-04', floorIndex: 0, floorLabel: 'Ground floor', towerName: 'Tower B', placement: 'schematic' });
    expect(ground.warnings.join(' ')).toMatch(/Facing not recorded/);
    expect(ground.warnings.join(' ')).toMatch(/no residences on the ground floor of Tower B \(parking and lobbies\)/);

    const villa = buildScene(inventory, mk('Villa 7', 'Villas', ''));
    expect(villa.knownTower).toBe(false);
    expect(villa.towers.every((t) => !t.selected)).toBe(true);
    expect(villa).toMatchObject({ floorIndex: null, plate: null, slot: null, towerName: 'Villas' });
    expect(villa.warnings.join(' ')).toMatch(/not one of the project's towers/);

    const blank = buildScene([], mk('', '', ''));
    expect(blank.warnings.join(' ')).toMatch(/Tower not recorded/);
    expect(blank.warnings.join(' ')).toMatch(/Floor not recorded/);

    const high = buildScene(inventory, mk('A-1601', 'A', '16'));
    expect(high.towers[0].floors).toBe(17); // a level above G+12 in the sheet is drawn…
    const typo = buildScene(inventory, mk('A-12001', 'A', '120'));
    expect(typo.towers[0].floors).toBe(13); // …a typo is not
    expect(typo.floorIndex).toBeNull();
  });
});

describe('share text', () => {
  it('builds the WhatsApp caption', () => {
    expect(shareCaption(buildScene(inventory, A1203))).toBe('Amaya by Vera Vita — Residence A-1203 · 2.5 BHK-A · 12th floor, Tower A · East facing · Carpet 1,231 sq. ft.');
    expect(shareCaption(buildScene(inventory, inventory[7]))).toBe('Amaya by Vera Vita — Residence B-G-04 · 1 BHK-A · Ground floor, Tower B · Carpet 1,113 sq. ft.');
  });

  it('lists the details, adding the customer only when asked', () => {
    const booked = buildScene(inventory, inventory[3]);
    const lines = shareDetails(booked);
    expect(lines).toEqual([
      'Amaya by Vera Vita · Medchal, Hyderabad',
      'Residence A-1204 · Tower A · 12th floor',
      '2 BHK-A · West facing',
      'Carpet area 1,113 sq. ft. · Built-up area 1,533 sq. ft.',
      'Status: Booked',
      'Outlook: Reserve forest',
      FOREST_NOTE,
      PLAN_NOTE,
    ]);
    expect(shareDetails(booked, { includeCustomer: true })).toContain('Status: Booked · Meera Rao');
    expect(shareDetails(buildScene(inventory, mk('A-1207', 'A', '12', { status: 'Owner' }))).join('\n')).not.toMatch(/Status/);
  });
});

describe('UnitLocator panel (server render)', () => {
  const leads = [{ [F.ID]: 'ENQ-0042', [F.NAME]: 'Meera Rao', [F.PHONE]: '98490 12345' } as unknown as Lead];

  it('renders the scene, compass, plan, details and share actions', () => {
    const html = renderToStaticMarkup(createElement(UnitLocator, { unit: A1203, inventory, leads, onClose: () => {} }));
    expect(html).toContain('Locate residence A-1203');
    expect(html).toContain(PLAN_NOTE);
    expect(html).toContain('3D view of towers A, B and C from the south: residence A-1203 highlighted on the 12th floor of Tower A, facing East.');
    expect(html).toContain('Compass — facing East (90°)');
    expect(html).toContain('12th floor of Tower A: floor plan with 6 residences; A-1203 highlighted.');
    expect(html).toContain('RESERVE FOREST');
    expect(html).toContain('Courtyard garden (A–B)');
    expect(html).toContain('Amaya by Vera Vita — Residence A-1203 · 2.5 BHK-A · 12th floor, Tower A · East facing · Carpet 1,231 sq. ft.');
    expect(html).toContain('aria-label="Download the locator image as Amaya-Residence-A-1203.png"');
    expect(html).toContain('aria-label="Copy the residence details as text"');
    expect(html).toContain('Share on WhatsApp — choose the contact in WhatsApp');
    expect(html).toContain('width="1200"'); // the off-screen share image
    expect(html).toContain('TG RERA P02200011109');
    expect(html).not.toContain('NaN');
  });

  it('targets the linked enquiry on WhatsApp and offers the customer-name option', () => {
    const html = renderToStaticMarkup(createElement(UnitLocator, { unit: inventory[3], inventory, leads, onClose: () => {} }));
    expect(html).toContain('aria-label="Share on WhatsApp with Meera Rao"');
    expect(html).toContain('(+91 98490 12345)');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(FOREST_NOTE);
    expect(html).not.toContain('NaN');
  });

  it('still renders when the tower and floor are unknown', () => {
    const html = renderToStaticMarkup(createElement(UnitLocator, { unit: mk('Villa 7', 'Villas', ''), inventory, onClose: () => {} }));
    expect(html).toContain('Floor plan not available');
    expect(html).not.toContain(PLAN_NOTE);
    expect(html).not.toContain('NaN');
  });
});
