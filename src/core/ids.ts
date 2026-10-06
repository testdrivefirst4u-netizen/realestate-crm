/** ID helpers. The backend is authoritative; the frontend only proposes IDs. */

export function nextSequentialId(prefix: string, existingIds: Array<string | undefined>, width = 4): string {
  let max = 0;
  for (const id of existingIds) {
    const m = String(id || '').match(/(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

export function randomId(prefix = 'id'): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

/** Stable hash (djb2) for change detection. */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function hashObject(o: unknown): string {
  try {
    return hashString(JSON.stringify(o));
  } catch {
    return '';
  }
}
