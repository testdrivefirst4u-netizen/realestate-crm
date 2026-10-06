/**
 * User avatar — the profile photo when one is set, otherwise the gold initials circle.
 *
 * Photos live on the user record as small data URLs. They are resized in the browser
 * (`resizeImageToDataUrl`) to a 128 px square JPEG before upload, so the stored string stays well under
 * the backend's 48 000-character limit (typically 5–15 KB).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { initials } from '../core/format';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarUser {
  name?: string | null;
  avatar?: string | null;
}

export interface AvatarProps {
  user?: AvatarUser | null;
  size?: AvatarSize;
  className?: string;
  title?: string;
}

/** Longest photo string the backend stores (validated again by the server on updateProfile). */
export const AVATAR_MAX_LENGTH = 48_000;
/** Largest image file accepted for upload, before resizing. */
export const AVATAR_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Edge length, in pixels, of the square photo that is uploaded. */
export const AVATAR_UPLOAD_PX = 128;

/** Same rule as the backend: JPEG, PNG or WebP as a base64 data URL. */
const AVATAR_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const IMAGE_EXT_RE = /\.(?:jpe?g|jfif|png|webp|gif|bmp|avif|heic|heif|tiff?|svg)$/i;

const UNREADABLE =
  'That image could not be read — it may be in a format this browser does not support (such as HEIC). Please choose a JPEG, PNG or WebP photo.';
const NO_CANVAS = 'This browser cannot resize photos. Please update it or try another browser.';
const ENCODE_FAILED = 'This browser could not prepare the photo. Please try another image or browser.';

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'w-6 h-6 text-[9px]',
  sm: 'w-7 h-7 text-[11px]',
  md: 'w-8 h-8 text-xs',
  lg: 'w-14 h-14 text-lg',
  xl: 'w-20 h-20 text-2xl',
};

const join = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** True when `value` is a profile photo the app can show and the backend accepts. */
export function isAvatarDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= AVATAR_MAX_LENGTH && AVATAR_RE.test(value);
}

export const Avatar: React.FC<AvatarProps> = ({ user, size = 'sm', className, title }) => {
  const name = String(user?.name || '').trim();
  const photo = user?.avatar || '';
  const valid = useMemo(() => isAvatarDataUrl(photo), [photo]);
  // A photo that fails to decode falls back to the initials (and is retried if the photo changes).
  const [broken, setBroken] = useState('');
  const base = join('relative inline-flex items-center justify-center rounded-full overflow-hidden flex-shrink-0 select-none align-middle', SIZE_CLASSES[size] || SIZE_CLASSES.sm, className);

  if (valid && broken !== photo) {
    return (
      <span className={join(base, 'bg-[#ECE8E1]')} title={title}>
        <img src={photo} alt={name || 'Profile photo'} className="w-full h-full object-cover" draggable={false} onError={() => setBroken(photo)} />
      </span>
    );
  }
  return (
    <span className={join(base, 'bg-[#A9825A] text-white font-bold leading-none')} title={title} role="img" aria-label={name || 'User'}>
      {initials(name)}
    </span>
  );
};

/* ------------------------------------------------------------------------ */
/* Upload helpers                                                            */
/* ------------------------------------------------------------------------ */

function formatMb(bytes: number): string {
  return `${(Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`;
}

/** Throws an Error with a message fit for the user when `file` cannot be used as a profile photo. */
export function assertAvatarFile(file: File | null | undefined): asserts file is File {
  if (!file) throw new Error('No file was chosen.');
  const type = String(file.type || '').toLowerCase();
  const isImage = type ? type.startsWith('image/') : IMAGE_EXT_RE.test(file.name || '');
  if (!isImage) throw new Error(`${file.name || 'That file'} is not an image. Please choose a JPEG, PNG or WebP photo.`);
  if (file.size > AVATAR_MAX_FILE_BYTES) throw new Error(`That photo is ${formatMb(file.size)} — the limit is 8 MB. Please choose a smaller one.`);
  if (file.size === 0) throw new Error('That file is empty. Please choose another photo.');
}

/** The largest centred square inside a `width` × `height` image. */
export function centreCropRect(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.max(0, Math.min(width, height));
  return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width > 0 && bmp.height > 0) return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
      bmp.close?.();
    } catch {
      /* e.g. SVG in Chromium — fall back to an <img> element below */
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error(UNREADABLE);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(UNREADABLE));
      el.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error(UNREADABLE);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createSquareCanvas(px: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx || typeof canvas.toDataURL !== 'function') return null;
  canvas.width = px;
  canvas.height = px;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/**
 * Read an image file, centre-crop it to a square, scale it to `size` px and return it as a JPEG data URL
 * (PNG only where the browser cannot encode JPEG). Rejects with a user-facing Error for non-images, files
 * over 8 MB, images the browser cannot decode, and browsers without canvas support.
 */
export async function resizeImageToDataUrl(file: File, size = AVATAR_UPLOAD_PX, quality = 0.82): Promise<string> {
  assertAvatarFile(file);
  const edge = Number.isFinite(size) && size >= 1 ? Math.round(size) : AVATAR_UPLOAD_PX;
  const q = Number.isFinite(quality) ? Math.min(1, Math.max(0.1, quality)) : 0.82;
  const out = createSquareCanvas(edge);
  if (!out) throw new Error(NO_CANVAS);

  const img = await decodeImage(file);
  try {
    let { sx, sy, side } = centreCropRect(img.width, img.height);
    let source: CanvasImageSource = img.source;
    // Halve large photos step by step: one 20–30× reduction aliases badly where high-quality smoothing is unavailable.
    while (side / 2 >= edge) {
      const half = Math.round(side / 2);
      const step = createSquareCanvas(half);
      if (!step) break;
      step.ctx.drawImage(source, sx, sy, side, side, 0, 0, half, half);
      source = step.canvas;
      sx = 0;
      sy = 0;
      side = half;
    }
    // JPEG has no transparency: flatten transparent images onto white rather than black.
    out.ctx.fillStyle = '#FFFFFF';
    out.ctx.fillRect(0, 0, edge, edge);
    out.ctx.drawImage(source, sx, sy, side, side, 0, 0, edge, edge);
  } finally {
    img.release();
  }

  let url: string;
  try {
    url = out.canvas.toDataURL('image/jpeg', q);
    // A browser that cannot encode JPEG returns PNG instead — ask for it explicitly.
    if (!url.startsWith('data:image/jpeg')) url = out.canvas.toDataURL('image/png');
  } catch {
    throw new Error(ENCODE_FAILED); // e.g. a canvas tainted by an SVG
  }
  if (url.length > AVATAR_MAX_LENGTH) throw new Error('The photo is still too large after resizing. Please choose a simpler image.');
  if (!isAvatarDataUrl(url)) throw new Error(ENCODE_FAILED);
  return url;
}

/**
 * File-picker plumbing shared by the profile and user-admin screens: render `input` anywhere, call `open()`
 * from a button. The chosen image is resized to a 128 px square before `onPicked` receives the data URL;
 * problems (not an image, over 8 MB, unreadable) go to `onError` as a user-facing message.
 */
export function useAvatarPicker(onPicked: (dataUrl: string) => void, onError: (message: string) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const callbacks = useRef({ onPicked, onError });
  callbacks.current = { onPicked, onError };

  const open = useCallback(() => inputRef.current?.click(), []);
  const handleChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so choosing the same file again still fires `change`
    if (!file) return;
    setBusy(true);
    try {
      callbacks.current.onPicked(await resizeImageToDataUrl(file));
    } catch (err) {
      callbacks.current.onError(err instanceof Error && err.message ? err.message : 'That image could not be used.');
    } finally {
      setBusy(false);
    }
  }, []);

  const input = <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} tabIndex={-1} aria-hidden="true" />;
  return { open, busy, input };
}
