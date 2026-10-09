/**
 * Profile photos: the Avatar render (server render — no DOM needed), the data-URL rule shared with the
 * backend, and the client-side resize pipeline driven through a fake canvas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AVATAR_MAX_LENGTH,
  Avatar,
  assertAvatarFile,
  centreCropRect,
  isAvatarDataUrl,
  resizeImageToDataUrl,
  type AvatarProps,
} from '../src/components/Avatar';
import { Sidebar } from '../src/components/Sidebar';
import { ProfileSection } from '../src/modules/settings/ProfileSection';
import type { UserAccount } from '../src/types/crm';

const JPEG = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50);
const RAHUL: UserAccount = { id: 'USR-0001', name: 'Rahul Mehta', email: 'rahul@veravitaliving.com', role: 'Admin', createdAt: '2026-10-01T09:00:00.000Z' };
const render = (props: AvatarProps) => renderToStaticMarkup(createElement(Avatar, props));
const imageFile = (name = 'me.jpg', type = 'image/jpeg', bytes = 64) => new File([new Uint8Array(bytes)], name, { type });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isAvatarDataUrl', () => {
  it('accepts the JPEG, PNG and WebP data URLs the backend stores', () => {
    expect(isAvatarDataUrl(JPEG)).toBe(true);
    expect(isAvatarDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isAvatarDataUrl('data:image/webp;base64,UklGRg==')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of [undefined, null, '', 42, 'javascript:alert(1)', 'https://example.com/me.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGOD', 'data:text/html;base64,PGI+', 'data:image/jpeg;base64,QU JD']) {
      expect(isAvatarDataUrl(v)).toBe(false);
    }
    expect(isAvatarDataUrl('data:image/jpeg;base64,' + 'A'.repeat(AVATAR_MAX_LENGTH))).toBe(false); // over the backend limit
  });
});

describe('Avatar', () => {
  it('shows the photo, cropped to a circle, with the name as alt text', () => {
    const html = render({ user: { name: 'Rahul Mehta', avatar: JPEG }, size: 'xl' });
    expect(html).toContain('<img');
    expect(html).toContain(`src="${JPEG}"`);
    expect(html).toContain('alt="Rahul Mehta"');
    expect(html).toContain('object-cover');
    expect(html).toContain('rounded-full');
    expect(html).toContain('w-20 h-20');
    expect(html).not.toContain('>RM<');
  });
  it('falls back to the blue initials circle without a usable photo', () => {
    for (const avatar of [undefined, '', 'javascript:alert(1)', 'https://example.com/me.jpg']) {
      const html = render({ user: { name: 'Rahul Mehta', avatar }, size: 'sm' });
      expect(html).not.toContain('<img');
      expect(html).toContain('>RM</span>');
      expect(html).toContain('bg-[#0B6BB0]');
      expect(html).toContain('w-7 h-7');
      expect(html).toContain('aria-label="Rahul Mehta"');
    }
  });
  it('copes with a missing user and passes className through', () => {
    const html = render({ user: null, className: 'ring-2' });
    expect(html).toContain('>U</span>');
    expect(html).toContain('ring-2');
  });
});

describe('where the photo replaces the initials', () => {
  it('Sidebar shows the signed-in user’s photo, or their initials without one', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }); // AppLogo reads it
    const sidebar = (currentUser: UserAccount) =>
      renderToStaticMarkup(createElement(Sidebar, {
        currentView: 'dashboard', isCollapsed: false, onToggleCollapse: () => {}, isMobileOpen: false, onCloseMobile: () => {},
        sync: { status: 'idle', hasLoadedOnce: true }, isOnline: true, currentUser, can: () => true, features: {}, onLogout: () => {},
      }));
    expect(sidebar({ ...RAHUL, avatar: JPEG })).toContain(`src="${JPEG}"`);
    const initialsOnly = sidebar(RAHUL);
    expect(initialsOnly).not.toContain(`src="${JPEG}"`);
    expect(initialsOnly).toContain('>RM</span>');
  });

  it('My profile offers Upload photo without a photo, and Change / Remove photo with one', () => {
    const profile = (currentUser: UserAccount) => renderToStaticMarkup(createElement(ProfileSection, { currentUser, onRefreshAll: () => {} }));
    const without = profile(RAHUL);
    expect(without).toContain('Upload photo');
    expect(without).not.toContain('Remove photo');
    expect(without).toContain('>RM</span>');
    expect(without).toContain('type="file"');
    expect(without).toContain('accept="image/*"');
    const withPhoto = profile({ ...RAHUL, avatar: JPEG });
    expect(withPhoto).toContain(`src="${JPEG}"`);
    expect(withPhoto).toContain('Change photo');
    expect(withPhoto).toContain('Remove photo');
  });
});

describe('centreCropRect', () => {
  it('takes the largest centred square', () => {
    expect(centreCropRect(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centreCropRect(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
    expect(centreCropRect(128, 128)).toEqual({ sx: 0, sy: 0, side: 128 });
  });
});

describe('assertAvatarFile', () => {
  it('accepts images, including ones the browser gave no MIME type', () => {
    expect(() => assertAvatarFile(imageFile())).not.toThrow();
    expect(() => assertAvatarFile(imageFile('IMG_0001.HEIC', ''))).not.toThrow();
  });
  it('rejects non-images, empty files and files over 8 MB with a clear message', () => {
    expect(() => assertAvatarFile(imageFile('brochure.pdf', 'application/pdf'))).toThrow('brochure.pdf is not an image');
    expect(() => assertAvatarFile(imageFile('notes.txt', ''))).toThrow(/not an image/);
    expect(() => assertAvatarFile(imageFile('me.jpg', 'image/jpeg', 0))).toThrow(/empty/);
    expect(() => assertAvatarFile(imageFile('big.jpg', 'image/jpeg', 8 * 1024 * 1024 + 1))).toThrow('That photo is 8.1 MB — the limit is 8 MB');
    expect(() => assertAvatarFile(null)).toThrow(/No file/);
  });
});

/* ---------------------------- fake canvas ---------------------------- */

class FakeContext {
  ops: Array<{ op: 'fillRect' | 'drawImage'; args: unknown[] }> = [];
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  fillRect(...args: unknown[]) {
    this.ops.push({ op: 'fillRect', args });
  }
  drawImage(...args: unknown[]) {
    this.ops.push({ op: 'drawImage', args });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  ctx = new FakeContext();
  constructor(private encode: (type: string, quality?: number) => string) {}
  getContext(kind: string) {
    return kind === '2d' ? this.ctx : null;
  }
  toDataURL(type = 'image/png', quality?: number) {
    return this.encode(type, quality);
  }
}

function installCanvas(opts: { jpeg?: boolean; output?: string } = {}) {
  const canvases: FakeCanvas[] = [];
  const encoded: Array<{ type: string; quality?: number }> = [];
  const encode = (type: string, quality?: number) => {
    encoded.push({ type, quality });
    if (opts.output) return opts.output;
    if (type === 'image/jpeg' && opts.jpeg !== false) return 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    return 'data:image/png;base64,iVBORw0KGgo='; // what browsers return for an unsupported type
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      const c = new FakeCanvas(encode);
      canvases.push(c);
      return c;
    },
  });
  return { canvases, encoded };
}

function installBitmap(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  return bitmap;
}

describe('resizeImageToDataUrl', () => {
  it('rejects non-images and oversized files before decoding anything', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(resizeImageToDataUrl(imageFile('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).rejects.toThrow(/not an image/);
    await expect(resizeImageToDataUrl(imageFile('big.png', 'image/png', 9 * 1024 * 1024))).rejects.toThrow(/limit is 8 MB/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('explains when the browser has no canvas support', async () => {
    await expect(resizeImageToDataUrl(imageFile())).rejects.toThrow('This browser cannot resize photos');
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null, toDataURL: () => '' }) });
    await expect(resizeImageToDataUrl(imageFile())).rejects.toThrow('This browser cannot resize photos');
  });

  it('centre-crops to a 128 px square JPEG, stepping large images down first', async () => {
    const { canvases, encoded } = installCanvas();
    const bitmap = installBitmap(400, 300);
    const url = await resizeImageToDataUrl(imageFile());

    expect(url).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    expect(encoded).toEqual([{ type: 'image/jpeg', quality: 0.82 }]);
    const [out, step] = canvases;
    expect([out.width, out.height]).toEqual([128, 128]);
    // 300 px crop → 150 px intermediate → 128 px output
    expect([step.width, step.height]).toEqual([150, 150]);
    expect(step.ctx.ops).toEqual([{ op: 'drawImage', args: [bitmap, 50, 0, 300, 300, 0, 0, 150, 150] }]);
    expect(out.ctx.ops).toEqual([
      { op: 'fillRect', args: [0, 0, 128, 128] },
      { op: 'drawImage', args: [step, 0, 0, 150, 150, 0, 0, 128, 128] },
    ]);
    expect(out.ctx.fillStyle).toBe('#FFFFFF'); // transparent images flatten onto white
    expect(out.ctx.imageSmoothingQuality).toBe('high');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('honours a custom size and quality, drawing small images directly', async () => {
    const { canvases, encoded } = installCanvas();
    const bitmap = installBitmap(90, 120);
    await resizeImageToDataUrl(imageFile(), 64, 0.7);
    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([64, 64]);
    expect(canvases[0].ctx.ops[1]).toEqual({ op: 'drawImage', args: [bitmap, 0, 15, 90, 90, 0, 0, 64, 64] });
    expect(encoded[0]).toEqual({ type: 'image/jpeg', quality: 0.7 });
  });

  it('falls back to PNG only when the browser cannot encode JPEG', async () => {
    const { encoded } = installCanvas({ jpeg: false });
    installBitmap(200, 200);
    const url = await resizeImageToDataUrl(imageFile('logo.png', 'image/png'));
    expect(url).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(encoded.map((e) => e.type)).toEqual(['image/jpeg', 'image/png']);
  });

  it('refuses a result the backend would reject as too large', async () => {
    installCanvas({ output: 'data:image/jpeg;base64,' + 'A'.repeat(AVATAR_MAX_LENGTH) });
    installBitmap(200, 200);
    await expect(resizeImageToDataUrl(imageFile())).rejects.toThrow(/too large/);
  });

  it('decodes through an <img> when createImageBitmap fails, and releases the object URL', async () => {
    const { canvases } = installCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported'); }));
    const images: FakeImage[] = [];
    class FakeImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        images.push(this);
      }
      set src(_v: string) {
        queueMicrotask(() => {
          this.naturalWidth = 300;
          this.naturalHeight = 500;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar-test');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const url = await resizeImageToDataUrl(imageFile('me.svg', 'image/svg+xml'));
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(canvases[1].ctx.ops[0]).toEqual({ op: 'drawImage', args: [images[0], 0, 100, 300, 300, 0, 0, 150, 150] });
    expect(revoke).toHaveBeenCalledWith('blob:avatar-test');
  });

  it('says so when the image cannot be decoded at all', async () => {
    installCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported'); }));
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await expect(resizeImageToDataUrl(imageFile('IMG_0001.HEIC', 'image/heic'))).rejects.toThrow(/could not be read.*HEIC/);
    expect(revoke).toHaveBeenCalledWith('blob:broken');
  });
});
