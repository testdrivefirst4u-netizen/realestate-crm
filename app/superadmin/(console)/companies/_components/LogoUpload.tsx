'use client';
import { useId, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Button, cx } from '../../../_components/ui';

const MAX_SIDE = 128;
const MAX_BYTES = 48 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

/** Resizes an image so its longest side is ≤ 128 px and returns a data URL of at most 48 KB. */
export async function imageToLogoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPG, SVG or WebP).');
  const img = await loadImage(file);
  const w0 = img.naturalWidth || MAX_SIDE;
  const h0 = img.naturalHeight || MAX_SIDE;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot process images here.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const fits = (s: string) => s.length <= MAX_BYTES;
  const png = canvas.toDataURL('image/png');
  if (fits(png)) return png;
  for (const q of [0.92, 0.8, 0.65, 0.5]) {
    const webp = canvas.toDataURL('image/webp', q);
    if (webp.startsWith('data:image/webp') && fits(webp)) return webp;
  }
  // JPEG has no alpha: flatten on white first.
  const flat = document.createElement('canvas');
  flat.width = w;
  flat.height = h;
  const fctx = flat.getContext('2d')!;
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, w, h);
  fctx.drawImage(canvas, 0, 0);
  for (const q of [0.9, 0.75, 0.6, 0.45]) {
    const jpg = flat.toDataURL('image/jpeg', q);
    if (fits(jpg)) return jpg;
  }
  throw new Error('This image is too detailed to fit in 48 KB. Try a simpler logo.');
}

export function LogoUpload({ value, onChange, name, disabled }: { value: string; onChange: (v: string) => void; name: string; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      onChange(await imageToLogoDataUrl(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process the image.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-l`} className="text-[13px] font-medium text-[#3B342E]">
        Logo
      </span>
      <div className="flex items-center gap-4">
        <div className={cx('flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#E4DCD2] bg-[#FBF9F6]', !value && 'border-dashed')}>
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt={`${name} logo`} className="max-h-full max-w-full object-contain" />
          ) : (
            <ImagePlus className="h-5 w-5 text-[#B5AA9E]" aria-hidden />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id={id}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-labelledby={`${id}-l`}
            aria-describedby={`${id}-h`}
            disabled={disabled || busy}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <Button variant="secondary" size="sm" loading={busy} disabled={disabled} onClick={() => inputRef.current?.click()}>
            {value ? 'Replace logo' : 'Upload logo'}
          </Button>
          {value && (
            <Button variant="ghost" size="sm" disabled={disabled || busy} icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => onChange('')}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-[#B42318]">
          {error}
        </p>
      ) : (
        <p id={`${id}-h`} className="text-[13px] text-[#7A6F64]">
          Resized to at most 128 px and 48 KB. Shown in the company&apos;s CRM header.
        </p>
      )}
    </div>
  );
}
