import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { addUnit, getAllUnits, importUnits, updateUnit } from '../server/modules/inventory';
import { col, getVersion } from '../server/core/db';
import { CFG } from '../server/core/config';

let t: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('inventory', () => {
  it('adds a unit with an INV id, defaults and CRM stamp', async () => {
    const ctx = await t.ctx('Admin', 'Asha');
    const v0 = await getVersion();
    const { unit, version } = await addUnit({ unitId: ' A101 ', tower: 'A', floor: 1, unitType: '2bhk', carpetArea: '1,050', price: '₹ 75,00,000' }, ctx);
    expect(unit.inventoryId).toBe('INV-0001');
    expect(unit.unitId).toBe('A101');
    expect(unit.floor).toBe('1');
    expect(unit.unitType).toBe('2 BHK');
    expect(unit.carpetArea).toBe(1050);
    expect(unit.price).toBe(7500000);
    expect(unit.status).toBe('Available');
    expect(unit.modifiedBy).toBe('CRM:Asha');
    expect(unit.syncStatus).toBe('Synced');
    expect(new Date(unit.lastModified).getTime()).toBeGreaterThan(0);
    expect(version).not.toBe(v0);
    const all = await getAllUnits();
    expect(all).toHaveLength(1);
    expect(all[0].inventoryId).toBe('INV-0001');
  });

  it('rejects a missing or duplicate unit number (case-insensitive)', async () => {
    const ctx = await t.ctx('Admin');
    await expect(addUnit({ tower: 'A' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await addUnit({ unitId: 'B202' }, ctx);
    await expect(addUnit({ unitId: 'b202' }, ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('updates by inventory id or unit number, stamps booked date, clears customer on release', async () => {
    const ctx = await t.ctx('Manager', 'Ravi');
    const { unit } = await addUnit({ unitId: 'C303' }, ctx);
    const booked = await updateUnit(unit.inventoryId, { status: 'Booked', customerName: 'Mr Rao', leadId: 'ENQ-0007' }, ctx);
    expect(booked.conflict).toBeUndefined();
    expect(booked.unit.status).toBe('Booked');
    expect(booked.unit.bookedDate).not.toBe('');
    expect(booked.unit.modifiedBy).toBe('CRM:Ravi');

    const tl = await (await col(CFG.COLL.TIMELINE)).find({ leadId: 'ENQ-0007' }).toArray();
    expect(tl.length).toBe(1);
    expect(tl[0].type).toBe('inventory');
    const ev = await (await col(CFG.COLL.EVENTS)).find({ type: 'inventory_status' }).toArray();
    expect(ev.length).toBe(1);
    const audit = await (await col(CFG.COLL.AUDIT_LOG)).find({ action: 'Unit Updated' }).toArray();
    expect(audit.length).toBe(1);

    const released = await updateUnit('C303', { status: 'Available' }, ctx);
    expect(released.unit.inventoryId).toBe(unit.inventoryId);
    expect(released.unit.customerName).toBe('');
    expect(released.unit.leadId).toBe('');
    expect(released.unit.bookedDate).toBe('');

    await expect(updateUnit('NOPE', { status: 'Booked' }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns a conflict with the server copy when the unit changed since expectedLastModified', async () => {
    const ctx = await t.ctx('Admin');
    const { unit } = await addUnit({ unitId: 'D404', price: 100 }, ctx);
    // someone else edits the unit later
    await (await col(CFG.COLL.INVENTORY)).updateOne({ _id: unit.inventoryId as any }, { $set: { lastModified: new Date(Date.now() + 60_000), price: 200 } });
    const res = await updateUnit(unit.inventoryId, { price: 300 }, ctx, unit.lastModified);
    expect(res.conflict).toBeDefined();
    expect(res.conflict.price).toBe(200);
    expect(res.unit.price).toBe(200);
    const stored = (await getAllUnits())[0];
    expect(stored.price).toBe(200); // not overwritten

    // with the fresh timestamp the update goes through
    const ok = await updateUnit(unit.inventoryId, { price: 300 }, ctx, res.conflict.lastModified);
    expect(ok.conflict).toBeUndefined();
    expect(ok.unit.price).toBe(300);
  });

  it('an empty patch changes nothing', async () => {
    const ctx = await t.ctx('Admin');
    const { unit } = await addUnit({ unitId: 'E505' }, ctx);
    const res = await updateUnit(unit.inventoryId, {}, ctx);
    expect(res.unit.lastModified).toBe(unit.lastModified);
  });

  it('imports new units and skips existing / blank / duplicate unit numbers without overwriting', async () => {
    const ctx = await t.ctx('Admin', 'Importer');
    await addUnit({ unitId: 'A101', price: 1 }, ctx);
    const res = await importUnits(
      [
        { unitId: 'a101', price: 999 },
        { unitNumber: 'A102', tower: 'A', status: 'Booked' },
        { unitId: 'A103' },
        { unitId: 'A103' },
        { unitId: '' },
      ],
      ctx,
    );
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(3);
    const all = await getAllUnits();
    expect(all.map((u) => u.unitId)).toEqual(['A101', 'A102', 'A103']);
    expect(all[0].price).toBe(1);
    expect(all[1].status).toBe('Booked');
    expect(all[1].modifiedBy).toBe('Import:Importer');
    await expect(importUnits('x' as any, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
