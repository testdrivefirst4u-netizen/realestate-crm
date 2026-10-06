/**
 * Local persistence — UI preferences only. MongoDB (through the server) is the source of truth.
 *
 * CRM records (leads, tasks, inventory, users, documents, templates, notes, checklist, events)
 * are never written to the browser: every reload fetches them again after sign-in. What is kept:
 *   - device preferences: local settings (templates, sync interval…), customisation, segments
 *   - the signed-in user for the boot flow — `{user, expiresAt, token:'cookie'}`; the real session
 *     token lives in an httpOnly cookie the page cannot read
 * No seed/mock data lives here: an empty CRM renders empty states.
 */
import { AuthSession, CRMData, CRMSettings } from '../types/crm';
import { DEFAULT_CONFIG, DEFAULT_CUSTOMIZATION, DEFAULT_SETTINGS, LEAD_BASE_HEADERS, STORAGE_KEYS } from './config';
import { DEFAULT_SEGMENTS } from '../services/segmentationService';

export function emptyCRMData(): CRMData {
  return {
    headers: [...LEAD_BASE_HEADERS],
    leads: [],
    config: { fields: [...DEFAULT_CONFIG.fields], options: { ...DEFAULT_CONFIG.options } },
    tasks: [],
    inventory: [],
    documents: [],
    templates: [],
    notes: [],
    checklist: [],
    segments: DEFAULT_SEGMENTS,
    users: [],
    customization: { ...DEFAULT_CUSTOMIZATION },
    settings: { ...DEFAULT_SETTINGS },
    serverSettings: undefined,
    lastEventId: '',
  };
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The persisted subset of CRMData. */
type CachedPrefs = Pick<CRMData, 'settings' | 'customization' | 'segments'>;

/** Local settings minus anything tied to a data snapshot (a sync version is meaningless without the data). */
function prefSettings(settings: CRMSettings): Partial<CRMSettings> {
  const { lastSyncVersion: _v, lastSyncTime: _t, ...rest } = settings as CRMSettings & { appsScriptUrl?: string };
  delete (rest as any).appsScriptUrl;
  return rest;
}

/** Older builds cached whole CRM snapshots in the browser — remove them wherever they are found. */
export function purgeLegacyCaches() {
  try {
    for (const k of [STORAGE_KEYS.CRM_STATE, STORAGE_KEYS.LEGACY_STATE, STORAGE_KEYS.LAST_EVENT_ID]) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function loadCachedData(): CRMData {
  const base = emptyCRMData();
  purgeLegacyCaches();
  try {
    const cached = safeParse<Partial<CachedPrefs>>(localStorage.getItem(STORAGE_KEYS.PREFS));
    if (cached && typeof cached === 'object') {
      return {
        ...base,
        settings: { ...base.settings, ...prefSettings({ ...base.settings, ...(cached.settings || {}) }) },
        customization: { ...base.customization, ...(cached.customization || {}) } as any,
        segments: cached.segments && cached.segments.length ? cached.segments : base.segments,
      };
    }
  } catch {
    /* corrupted prefs → start clean */
  }
  return base;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Persist the UI preferences of `data` (debounced). CRM records are deliberately dropped. */
export function saveCachedData(data: CRMData) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const prefs: CachedPrefs = { settings: prefSettings(data.settings) as CRMSettings, customization: data.customization, segments: data.segments };
      localStorage.setItem(STORAGE_KEYS.PREFS, JSON.stringify(prefs));
    } catch {
      /* quota exceeded / storage blocked: preferences are optional */
    }
  }, 400);
}

/** Drop everything cached for the signed-in user (sign-out and session expiry). Preferences stay. */
export function clearCachedData() {
  purgeLegacyCaches();
  try {
    localStorage.removeItem(STORAGE_KEYS.SESSION);
    localStorage.removeItem(STORAGE_KEYS.NOTIFICATIONS);
  } catch {
    /* ignore */
  }
}

export function loadSession(): AuthSession | null {
  try {
    const s = safeParse<AuthSession>(localStorage.getItem(STORAGE_KEYS.SESSION));
    if (s && s.user) {
      const clean: AuthSession = { user: s.user, expiresAt: s.expiresAt, token: 'cookie' };
      if (s.token !== 'cookie') saveSession(clean); // a session saved by an older build still holds its token
      return clean;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Stores who is signed in — never a secret: the token field is always the `'cookie'` placeholder. */
export function saveSession(session: AuthSession | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ user: session.user, expiresAt: session.expiresAt, token: 'cookie' }));
    else localStorage.removeItem(STORAGE_KEYS.SESSION);
  } catch {
    /* ignore */
  }
}

export function loadUiPref<T>(key: string, fallback: T): T {
  try {
    const all = safeParse<Record<string, any>>(localStorage.getItem(STORAGE_KEYS.UI_PREFS)) || {};
    return key in all ? (all[key] as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveUiPref(key: string, value: unknown) {
  try {
    const all = safeParse<Record<string, any>>(localStorage.getItem(STORAGE_KEYS.UI_PREFS)) || {};
    all[key] = value;
    localStorage.setItem(STORAGE_KEYS.UI_PREFS, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
