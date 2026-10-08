/** App icons: the Broaddcast "bc" mark everywhere (browser tab, bookmarks, phone home screen); no RM logo left. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p));

describe('app icons', () => {
  it('icon.svg is the Broaddcast mark, square', () => {
    const svg = read('app/icon.svg').toString('utf8');
    expect(svg).toContain('viewBox="33 13 191 191"');
    expect(svg.match(/<path class="fil[01]"/g)).toHaveLength(2); // the two "bc" shapes, not the wordmark
    expect(svg).toContain('linearGradient');
  });

  it('favicon.ico holds 16, 32 and 48 px images; apple-icon is 180 px', () => {
    const ico = read('app/favicon.ico');
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    expect([0, 1, 2].map((i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 32, 48]);
    const png = read('app/apple-icon.png');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it('the old RM logo is gone and the layout does not point at another favicon', () => {
    for (const f of ['public/favicon.png', 'public/rm-logo.png', 'public/rm-logo.svg', 'public/RM Logo.png']) expect(fs.existsSync(path.join(root, f))).toBe(false);
    expect(read('app/layout.tsx').toString()).not.toMatch(/icons\s*:/);
  });
});
