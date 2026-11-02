/** Project Library: sections made of table rows are shown as a table (an uploaded location sheet keeps place, km, time). */
import { describe, expect, it } from 'vitest';
import { rowTable } from '../src/components/LibraryModal';

const v = (text: string) => ({ id: text.slice(0, 8), text } as any);
const sheet = [
  'Location Name: Abids · Category: Locality · Side of Hyderabad: West · Approx. Distance from Amaya: 30–35 km · Approx. Car Travel Time: 40–60 min',
  'Location Name: Adibatla · Category: Locality · Side of Hyderabad: South · Approx. Distance from Amaya: 45–55 km · Approx. Car Travel Time: 50–75 min',
  'Location Name: AIG Hospitals, Gachibowli · Category: Major hospital · Side of Hyderabad: West · Approx. Distance from Amaya: 40–45 km · Approx. Car Travel Time: 45–65 min',
].map(v);

describe('library tables', () => {
  it('an uploaded location sheet shows only Location, Distance and By car', () => {
    const t = rowTable(sheet)!;
    expect(t.labels).toEqual(['Location', 'Distance', 'By car']);
    expect(t.cells(sheet[2])).toEqual(['AIG Hospitals, Gachibowli', '40–45 km', '45–65 min']);
  });
  it('the built-in Locations lines become the same table', () => {
    const rows = ['Kandlakoya — 0–5 km · 5–15 min', 'Medchal — 10–15 km · 15–25 min'].map(v);
    const t = rowTable(rows)!;
    expect(t.labels).toEqual(['Location', 'Distance', 'By car']);
    expect(t.cells(rows[1])).toEqual(['Medchal', '10–15 km', '15–25 min']);
  });
  it('any other sheet keeps its own columns; ordinary text is not a table', () => {
    const units = ['Unit: A101 · Type: 2 BHK · Price: ₹1.2 Cr', 'Unit: A102 · Type: 1 BHK · Price: ₹80 L'].map(v);
    expect(rowTable(units)!.labels).toEqual(['Unit', 'Type', 'Price']);
    expect(rowTable(['Amaya is a senior living community.', 'It has 256 homes: three towers.'].map(v))).toBeNull();
  });
});
