/**
 * useCrmEngine — the single owner of CRM state on the client.
 *
 *  - Session (login / first-run setup / token expiry)
 *  - Live data: bootstrap + cheap version polling (`since`), events feed
 *  - Optimistic mutations with server reconciliation and rollback
 *  - Deduplicated notifications and task alarms (persisted snooze)
 *  - Device preferences persisted locally; CRM records are never cached in the browser
 *
 * Views receive data + callbacks as props; nothing else talks to the backend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AuthSession,
  CRMData,
  ChecklistItem,
  CrmDocument,
  CrmEvent,
  InventoryUnit,
  Lead,
  MessageTemplate,
  NoteItem,
  TaskItem,
  UserAccount,
  SyncState,
  ServerSettings,
  ClientSegment,
} from '../types/crm';
import { api, configureApi, BootstrapPayload } from './api';
import { F, LEAD_DATE_FIELDS, STAGES, SYNC } from './config';
import { dedupeUnitTypes, normalizeUnitType } from './units';
import { normalizeDateValue, nowIso, parseDate, setTimeZone, formatRelative, toSheetDateTime } from './dates';
import { AppError, reportError, setErrorReporter, toAppError } from './errors';
import { nextSequentialId, randomId } from './ids';
import { eventKey, notifications, notify, toast } from './notifications';
import { clearCachedData, emptyCRMData, loadCachedData, loadSession, saveCachedData, saveSession } from './persistence';
import { can } from './rbac';
import { isActive, nextFollowupDate } from './analytics';

/**
 * There is no first-run setup in the app any more: companies and their first administrator are created
 * by the platform administrator, so a signed-out user always lands on the sign-in form.
 */
export type AuthStatus = 'checking' | 'login' | 'ready';

/* ------------------------------------------------------------------------ */
/* Normalisation                                                             */
/* ------------------------------------------------------------------------ */

export function normalizeLead(raw: Lead): Lead {
  const out: Lead = { ...raw };
  for (const f of LEAD_DATE_FIELDS) {
    if (out[f] !== undefined && out[f] !== null && out[f] !== '') out[f] = normalizeDateValue(out[f]);
  }
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === 'string') out[k] = v.trim();
  }
  if (out[F.UNIT_TYPE] !== undefined && out[F.UNIT_TYPE] !== null) out[F.UNIT_TYPE] = normalizeUnitType(out[F.UNIT_TYPE]);
  if (!out[F.STAGE]) out[F.STAGE] = STAGES.NEW;
  return out;
}

/** Config options from the database may list the same unit type under several spellings. */
export function normalizeConfig<T extends { options: Record<string, string[]> }>(config: T): T {
  if (!config || !config.options) return config;
  const units = config.options[F.UNIT_TYPE];
  if (!Array.isArray(units)) return config;
  return { ...config, options: { ...config.options, [F.UNIT_TYPE]: dedupeUnitTypes(units) } };
}

export function normalizeTask(t: TaskItem): TaskItem {
  return {
    ...t,
    datetime: normalizeDateValue(t.datetime),
    createdAt: t.createdAt ? normalizeDateValue(t.createdAt) : t.createdAt,
    completedAt: t.completedAt ? normalizeDateValue(t.completedAt) : t.completedAt,
    snoozedUntil: t.snoozedUntil ? normalizeDateValue(t.snoozedUntil) : t.snoozedUntil,
    checklist: Array.isArray(t.checklist) ? t.checklist : [],
    completed: !!t.completed || t.status === 'Completed',
    status: !!t.completed || t.status === 'Completed' ? 'Completed' : 'Pending',
  };
}

/* ------------------------------------------------------------------------ */

const EVENT_TYPE_MAP: Record<string, { type: 'info' | 'success' | 'warning' | 'alert'; audio?: boolean }> = {
  lead_created: { type: 'info', audio: true },
  lead_booked: { type: 'success', audio: true },
  stage_changed: { type: 'info' },
  site_visit_scheduled: { type: 'info' },
  site_visit_completed: { type: 'success' },
  rm_assigned: { type: 'info' },
  task_created: { type: 'info' },
  task_completed: { type: 'success' },
  followup_overdue: { type: 'alert', audio: true },
  chat_received: { type: 'info', audio: true },
  call_logged: { type: 'info' },
  inventory_status: { type: 'info' },
  document_uploaded: { type: 'info' },
  lead_trashed: { type: 'warning' },
  code_saved: { type: 'warning' },
  code_deployed: { type: 'warning' },
};

export interface CrmEngine {
  data: CRMData;
  authStatus: AuthStatus;
  session: AuthSession | null;
  currentUser: UserAccount | null;
  sync: SyncState;
  isOnline: boolean;
  activeAlarmTask: TaskItem | null;
  can: (perm: Parameters<typeof can>[1]) => boolean;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Save your own display name and/or profile photo (a data URL; `null` removes it). Updates the signed-in
   * session (persisted, so the sidebar shows it at once and after a reload) and your entry in `data.users`.
   * Rejects with an AppError on failure (no toast — the caller reports it); resolves `null` when signed out.
   */
  updateProfile: (data: { name?: string; avatar?: string | null }) => Promise<UserAccount | null>;
  refresh: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  updateLocalSettings: (patch: Partial<CRMData['settings']>) => void;

  addLead: (lead: Partial<Lead>) => Promise<Lead | null>;
  updateLead: (id: string, patch: Partial<Lead>) => Promise<Lead | null>;
  appendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  setLeadStage: (id: string, stage: string) => Promise<boolean>;
  trashLead: (id: string) => Promise<boolean>;
  restoreLead: (id: string) => Promise<boolean>;
  deleteLeadPermanently: (id: string) => Promise<boolean>;
  importLeads: (leads: Lead[], strategy: string) => Promise<{ created: number; updated: number } | null>;

  addTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
  updateTask: (id: string, patch: Partial<TaskItem>) => Promise<boolean>;
  toggleTask: (id: string, completed: boolean) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  toggleTaskChecklist: (id: string, index: number, checked: boolean) => void;
  snoozeAlarm: (task: TaskItem, minutes: number) => Promise<void>;
  dismissAlarm: () => void;
  completeAlarm: (task: TaskItem) => Promise<void>;

  updateUnit: (inventoryId: string, patch: Partial<InventoryUnit>) => Promise<{ ok: boolean; conflict?: InventoryUnit }>;
  addUnit: (unit: Partial<InventoryUnit>) => Promise<boolean>;
  importInventory: (units: Partial<InventoryUnit>[]) => Promise<{ created: number; skipped: number } | null>;

  saveDocument: (doc: Partial<CrmDocument>) => Promise<boolean>;
  deleteDocument: (id: string) => Promise<boolean>;
  saveTemplate: (tpl: Partial<MessageTemplate>) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<boolean>;
  addNote: (text: string) => Promise<boolean>;
  deleteNote: (id: string) => Promise<boolean>;
  addChecklist: (text: string) => Promise<boolean>;
  toggleChecklist: (id: string, completed: boolean) => Promise<boolean>;
  deleteChecklist: (id: string) => Promise<boolean>;

  createSegment: (s: Omit<ClientSegment, 'id' | 'createdAt'>) => void;
  updateSegment: (id: string, patch: Partial<ClientSegment>) => void;
  deleteSegment: (id: string) => void;

  applyServerSettings: (s: ServerSettings) => void;
}

export function useCrmEngine(): CrmEngine {
  const [data, setData] = useState<CRMData>(() => loadCachedData());
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [sync, setSync] = useState<SyncState>({ status: 'idle', hasLoadedOnce: false });
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [activeAlarmTask, setActiveAlarmTask] = useState<TaskItem | null>(null);

  const dataRef = useRef(data);
  dataRef.current = data;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const syncingRef = useRef(false);
  const lastFocusSyncRef = useRef(0);
  const versionRef = useRef<string>('');
  const lastEventIdRef = useRef<string>('');
  const pendingLocalRef = useRef<Map<string, number>>(new Map());
  /** Our mutations currently awaiting a server response (a snapshot that arrives meanwhile may pre-date them). */
  const writesInFlightRef = useRef(0);
  /** Newest data version returned by one of our own writes — a snapshot older than this is stale. */
  const lastWriteVersionRef = useRef<string>('');
  const authStatusRef = useRef(authStatus);
  authStatusRef.current = authStatus;
  const activeAlarmRef = useRef(activeAlarmTask);
  activeAlarmRef.current = activeAlarmTask;

  /* ------------------------------ helpers ------------------------------- */

  const markLocal = (id: string) => pendingLocalRef.current.set(id, Date.now());
  const isLocalRecent = (id: string) => {
    const t = pendingLocalRef.current.get(id);
    if (!t) return false;
    if (Date.now() - t > SYNC.localMutationTtlMs) {
      pendingLocalRef.current.delete(id);
      return false;
    }
    return true;
  };

  const patchData = useCallback((fn: (prev: CRMData) => CRMData) => {
    setData((prev) => fn(prev));
  }, []);

  /** Run a mutation request while counting it as in flight (see `refresh` — a concurrent snapshot must not roll it back). */
  const write = async <T,>(fn: () => Promise<T>): Promise<T> => {
    writesInFlightRef.current += 1;
    try {
      return await fn();
    } finally {
      writesInFlightRef.current -= 1;
    }
  };

  /** Forget everything the signed-in user could see: in memory and in this browser. Preferences stay. */
  const clearUserData = useCallback(() => {
    clearCachedData();
    notifications.clearAll();
    versionRef.current = '';
    lastEventIdRef.current = '';
    lastWriteVersionRef.current = '';
    setData((p) => ({ ...emptyCRMData(), settings: p.settings, customization: p.customization, segments: p.segments }));
  }, []);

  /** The server ended the session. `message` (e.g. "This company account is suspended…") is shown on the sign-in screen. */
  const handleAuthExpired = useCallback((message?: string) => {
    setSession(null);
    saveSession(null);
    clearUserData();
    setAuthStatus('login');
    const explain = message && /suspend/i.test(message) ? message : undefined;
    setSync((s) => ({ ...s, status: 'auth', lastError: explain }));
  }, [clearUserData]);

  // configure API client once (the session itself travels in an httpOnly cookie)
  useEffect(() => {
    configureApi({ onAuthExpired: handleAuthExpired });
    setErrorReporter((rec) => {
      if (sessionRef.current) api.system.logError(rec).catch(() => {});
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (data.settings.timeZone) setTimeZone(data.settings.timeZone);
  }, [data.settings.timeZone]);

  // persist cache
  useEffect(() => {
    saveCachedData(data);
  }, [data]);

  // online/offline
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  /* ------------------------------- events ------------------------------- */

  const processEvents = useCallback((events: CrmEvent[] | undefined, lastEventId?: string) => {
    const cursorBefore = lastEventIdRef.current;
    if (!events || !events.length) {
      // Nothing newer than our cursor: adopt the server's (this also recovers a client whose cursor is ahead of the server).
      if (lastEventId) lastEventIdRef.current = lastEventId;
    } else {
      const me = sessionRef.current?.user?.name || '';
      const sorted = [...events].sort((a, b) => a.id.localeCompare(b.id));
      for (const ev of sorted) {
        if (!ev.id) continue;
        const key = ev.key || eventKey(ev.type, ev.recordId, ev.id);
        if (ev.actor && me && ev.actor === me) {
          notifications.ack(key); // my own action — toast already shown
          continue;
        }
        const map = EVENT_TYPE_MAP[ev.type] || { type: 'info' as const };
        notify({
          key,
          title: ev.title,
          message: ev.message,
          type: map.type,
          recordType: ev.recordType,
          recordId: ev.recordId,
          timestamp: ev.createdAt,
          playAudio: !!map.audio,
        });
      }
      const maxId = sorted[sorted.length - 1].id;
      if (!lastEventIdRef.current || maxId > lastEventIdRef.current) lastEventIdRef.current = maxId;
      // A full page may have been truncated by the server: keep the cursor on the last event we actually
      // processed so the next poll continues from there instead of skipping to the newest id.
      const truncated = events.length >= SYNC.maxEventsPerPoll;
      if (!truncated && lastEventId && lastEventId > lastEventIdRef.current) lastEventIdRef.current = lastEventId;
    }
    if (lastEventIdRef.current !== cursorBefore) patchData((prev) => ({ ...prev, lastEventId: lastEventIdRef.current }));
  }, [patchData]);

  /* ------------------------------- sync --------------------------------- */

  const applyBootstrap = useCallback(
    (payload: BootstrapPayload) => {
      const prev = dataRef.current;
      const leads = payload.leads?.leads ? payload.leads.leads.map(normalizeLead) : prev.leads;
      const tasks = payload.tasks ? payload.tasks.map(normalizeTask) : prev.tasks;

      // Fallback change detection for backends without an Events feed
      if (!payload.lastEventId && prev.leads.length && payload.leads?.leads) {
        const prevById = new Map(prev.leads.map((l) => [l[F.ID], l]));
        for (const l of leads) {
          const id = l[F.ID];
          if (isLocalRecent(id)) continue;
          const old = prevById.get(id);
          if (!old) {
            notify({ key: eventKey('lead_created', id, 'diff'), title: `New enquiry: ${l[F.NAME]}`, message: `${l[F.UNIT_TYPE] || 'Unit'} via ${l[F.SOURCE] || 'another device'}`, type: 'info', recordType: 'Lead', recordId: id, playAudio: true });
          } else if (old[F.STAGE] !== l[F.STAGE]) {
            notify({ key: eventKey('stage_changed', id, `${old[F.STAGE]}>${l[F.STAGE]}`), title: `${l[F.NAME]}: ${old[F.STAGE]} → ${l[F.STAGE]}`, message: 'Changed by a colleague', type: l[F.STAGE] === STAGES.BOOKED ? 'success' : 'info', recordType: 'Lead', recordId: id });
          }
        }
      }

      versionRef.current = payload.version;
      setData((p) => ({
        ...p,
        headers: payload.leads?.headers?.length ? payload.leads.headers : p.headers,
        leads,
        tasks,
        config: payload.config && payload.config.options ? normalizeConfig(payload.config) : p.config,
        inventory: payload.inventory ? payload.inventory.map((u) => ({ ...u, unitType: normalizeUnitType(u.unitType) })) : p.inventory,
        users: payload.users ? payload.users : p.users,
        documents: payload.documents ? payload.documents : p.documents,
        templates: payload.templates ? payload.templates : p.templates,
        notes: payload.notes ? payload.notes : p.notes,
        checklist: payload.checklist ? payload.checklist : p.checklist,
        serverSettings: payload.settings ? { ...(p.serverSettings || {}), ...payload.settings } : p.serverSettings,
        settings: {
          ...p.settings,
          lastSyncTime: nowIso(),
          lastSyncVersion: payload.version,
          timeZone: payload.settings?.timeZone || p.settings.timeZone,
          aiConfigured: payload.settings?.aiConfigured ?? p.settings.aiConfigured,
          geminiModel: payload.settings?.aiModel || p.settings.geminiModel,
        },
      }));
      if (payload.events || payload.lastEventId) {
        if (!lastEventIdRef.current && payload.lastEventId) {
          // first load: do not replay history, just record the cursor
          lastEventIdRef.current = payload.lastEventId;
          patchData((p) => ({ ...p, lastEventId: payload.lastEventId }));
        } else if (payload.events) {
          processEvents(payload.events, payload.lastEventId);
        }
        // No events embedded (the backend only sends the newest id): `refresh` polls the feed from the
        // cursor it held before this snapshot — advancing it here would silently drop those events.
      }
    },
    [patchData, processEvents]
  );

  const refresh = useCallback(
    async (opts: { silent?: boolean; force?: boolean } = {}) => {
      if (!sessionRef.current) return;
      if (syncingRef.current) return;
      if (!navigator.onLine) {
        setSync((s) => ({ ...s, status: 'offline' }));
        return;
      }
      syncingRef.current = true;
      setSync((s) => ({ ...s, status: s.hasLoadedOnce ? 'syncing' : 'loading' }));
      try {
        const cursorBefore = lastEventIdRef.current;
        const payload = await api.bootstrap(opts.force ? '' : versionRef.current);
        if (!payload.unchanged) {
          // A snapshot built before one of our writes completed — or while one is still in flight — may not
          // contain that write; applying it would roll the UI back. Skip it: the next poll fetches a fresh one.
          const lastWrite = Number(lastWriteVersionRef.current);
          const stale = writesInFlightRef.current > 0 || (!!lastWriteVersionRef.current && Number(payload.version) < lastWrite);
          if (!stale) applyBootstrap(payload);
        }
        // The bootstrap carries only the newest event id, never the events themselves, so the feed has to be
        // polled from the cursor we held before — after a changed bootstrap too (that is precisely when a
        // colleague's lead_created / lead_booked / chat_received was written), not only when nothing changed.
        const serverMoved = payload.unchanged || (!payload.events && !!payload.lastEventId && payload.lastEventId !== cursorBefore);
        if (cursorBefore && serverMoved) {
          try {
            const ev = await api.events.since(cursorBefore);
            processEvents(ev.events, ev.lastEventId);
          } catch {
            /* non-fatal */
          }
        }
        setSync({ status: 'idle', hasLoadedOnce: true, lastSyncAt: nowIso(), version: payload.version, lastError: undefined });
        if (!opts.silent) toast('Synced', 'Data refreshed from the server', 'success');
      } catch (e) {
        const err = toAppError(e);
        if (err.code === 'AUTH_REQUIRED') {
          handleAuthExpired(err.message);
          return;
        }
        reportError('sync', err);
        setSync((s) => ({ ...s, status: err.code === 'NETWORK' ? 'offline' : 'error', lastError: err.userMessage, hasLoadedOnce: s.hasLoadedOnce }));
        if (!opts.silent) toast('Sync failed', err.userMessage, 'warning');
      } finally {
        syncingRef.current = false;
      }
    },
    [applyBootstrap, handleAuthExpired, processEvents]
  );

  // Session validation on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = loadSession();
      if (!s) {
        // Accounts are created by the company administrator (companies by the platform) — always sign in.
        if (!cancelled) setAuthStatus('login');
        return;
      }
      try {
        const me = await api.auth.me();
        if (cancelled) return;
        const fresh = { ...s, user: me.user, expiresAt: me.expiresAt };
        setSession(fresh);
        saveSession(fresh);
        setAuthStatus('ready');
      } catch (e) {
        if (cancelled) return;
        const err = toAppError(e);
        if (err.code === 'AUTH_REQUIRED' || err.code === 'FORBIDDEN' || err.code === 'VALIDATION') {
          handleAuthExpired(err.message);
        } else {
          // offline / backend down: keep the signed-in user; data loads on the next successful sync
          setSession(s);
          setAuthStatus('ready');
          setSync((x) => ({ ...x, status: err.code === 'NETWORK' ? 'offline' : 'error', lastError: err.userMessage }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleAuthExpired]);

  // initial load when ready
  useEffect(() => {
    if (authStatus === 'ready') refresh({ silent: true, force: true });
  }, [authStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // polling
  useEffect(() => {
    if (authStatus !== 'ready') return;
    const sec = Math.max(SYNC.minIntervalSec, data.settings.autoSyncIntervalSec || 0);
    if (!data.settings.autoSyncIntervalSec) return; // manual mode
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh({ silent: true });
    }, sec * 1000);
    return () => clearInterval(t);
  }, [authStatus, data.settings.autoSyncIntervalSec, refresh]);

  // focus / visibility (debounced)
  useEffect(() => {
    if (authStatus !== 'ready') return;
    const maybe = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastFocusSyncRef.current < SYNC.focusDebounceMs) return;
      lastFocusSyncRef.current = now;
      refresh({ silent: true });
    };
    window.addEventListener('focus', maybe);
    document.addEventListener('visibilitychange', maybe);
    window.addEventListener('online', maybe);
    return () => {
      window.removeEventListener('focus', maybe);
      document.removeEventListener('visibilitychange', maybe);
      window.removeEventListener('online', maybe);
    };
  }, [authStatus, refresh]);

  /* ------------------------------- alarms ------------------------------- */

  useEffect(() => {
    if (authStatus !== 'ready') return;
    const check = () => {
      const now = Date.now();
      const tasks = dataRef.current.tasks;
      let candidate: TaskItem | null = null;
      for (const t of tasks) {
        if (t.completed || t.status === 'Completed') continue;
        const due = parseDate(t.datetime);
        if (!due || due.getTime() > now) continue;
        if (t.snoozedUntil && (parseDate(t.snoozedUntil)?.getTime() || 0) > now) continue;
        const key = eventKey('task_due', t.id, t.datetime);
        if (notifications.hasSeen(key)) continue;
        candidate = t;
        break;
      }
      // One alarm at a time: while a modal is open the next due task keeps its (unseen) key, so its own
      // modal appears once this one is dismissed instead of being swallowed by the dedup.
      if (candidate && !activeAlarmRef.current) {
        const key = eventKey('task_due', candidate.id, candidate.datetime);
        notify({ key, title: '⏰ Task due now', message: `${candidate.name}${candidate.lead ? ` · ${candidate.lead}` : ''}`, type: 'alert', recordType: 'Task', recordId: candidate.id, playAudio: false });
        setActiveAlarmTask((cur) => cur || candidate);
      }
      // follow-up reminders at the due time (one per lead per due time)
      for (const l of dataRef.current.leads) {
        if (!isActive(l)) continue;
        const d = nextFollowupDate(l);
        if (!d) continue;
        const diff = now - d.getTime();
        if (diff < 0 || diff > 6 * 3_600_000) continue; // only within 6h after it became due
        const key = eventKey('followup_due', l[F.ID], l[F.NEXT_FOLLOWUP]);
        if (notifications.hasSeen(key)) continue;
        notify({ key, title: `Follow-up due: ${l[F.NAME]}`, message: `${formatRelative(d)} · ${l[F.STAGE]} · RM ${l[F.RM] || '—'}`, type: 'warning', recordType: 'Lead', recordId: l[F.ID], playAudio: true });
      }
    };
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [authStatus]);

  /* -------------------------------- auth -------------------------------- */

  const login = useCallback(async (email: string, password: string) => {
    const s = await api.auth.login(email, password);
    setSession(s);
    saveSession(s);
    setSync((x) => ({ ...x, lastError: undefined }));
    setAuthStatus('ready');
    toast(`Welcome, ${s.user.name}`, undefined, 'success');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* ignore */
    }
    setSession(null);
    saveSession(null);
    clearUserData();
    setAuthStatus('login');
  }, [clearUserData]);

  const updateProfile = useCallback(
    async (input: { name?: string; avatar?: string | null }): Promise<UserAccount | null> => {
      if (!sessionRef.current) return null;
      const updated = await write(() => api.auth.updateProfile(input));
      const cur = sessionRef.current;
      if (cur && cur.user.id === updated.id) {
        const fresh: AuthSession = { ...cur, user: { ...cur.user, ...updated } };
        sessionRef.current = fresh;
        setSession(fresh);
        saveSession(fresh);
      }
      // The bootstrap users list feeds RM names/photos elsewhere — refresh our own entry without waiting for a poll.
      patchData((p) =>
        (p.users || []).some((u) => u.id === updated.id)
          ? { ...p, users: (p.users || []).map((u) => (u.id === updated.id ? { ...u, name: updated.name, avatar: updated.avatar || '' } : u)) }
          : p
      );
      return updated;
    },
    [patchData]
  );

  const updateLocalSettings = useCallback((patch: Partial<CRMData['settings']>) => {
    patchData((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  }, [patchData]);

  /* ----------------------------- mutations ------------------------------ */

  const failToast = (scope: string, e: unknown) => {
    const err = reportError(scope, e);
    toast(err.code === 'CONFLICT' ? 'Conflict' : 'Could not save', err.userMessage, err.code === 'CONFLICT' ? 'warning' : 'alert');
    return err;
  };

  /**
   * Record the data version one of our writes produced. Deliberately does NOT move `versionRef` (the
   * `since` cursor): the write response carries only our own record, so the next poll must still fetch
   * everything that changed since the last full snapshot — otherwise a colleague's lead added seconds
   * before our write would be masked by an `unchanged` reply until someone else writes again.
   */
  const applyServerVersion = (version?: string) => {
    if (!version) return;
    const n = Number(version);
    if (!lastWriteVersionRef.current || n > Number(lastWriteVersionRef.current)) lastWriteVersionRef.current = version;
  };

  const addLead = useCallback(
    async (input: Partial<Lead>): Promise<Lead | null> => {
      const tempId = input[F.ID] || nextSequentialId('ENQ', dataRef.current.leads.map((l) => l[F.ID]));
      const now = nowIso();
      const optimistic = normalizeLead({
        ...(input as Lead),
        [F.ID]: tempId,
        [F.ENQUIRY_DATE]: input[F.ENQUIRY_DATE] || now,
        [F.STAGE]: input[F.STAGE] || STAGES.NEW,
        [F.CREATED_AT]: now,
        [F.UPDATED_AT]: now,
      });
      markLocal(tempId);
      patchData((p) => ({ ...p, leads: [optimistic, ...p.leads] }));
      try {
        const res = await write(() => api.leads.add(optimistic));
        const saved = normalizeLead(res.lead);
        markLocal(saved[F.ID]);
        patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === tempId ? saved : l)) }));
        applyServerVersion(res.version);
        toast('Enquiry created', `${saved[F.NAME]} · ${saved[F.ID]}`, 'success');
        return saved;
      } catch (e) {
        patchData((p) => ({ ...p, leads: p.leads.filter((l) => l[F.ID] !== tempId) }));
        const err = failToast('leads.add', e);
        if (err.code === 'CONFLICT' && err.details?.existingId) {
          toast('Existing enquiry', `This phone number belongs to ${err.details.existingId}.`, 'warning');
        }
        return null;
      }
    },
    [patchData]
  );

  const updateLead = useCallback(
    async (id: string, patch: Partial<Lead>): Promise<Lead | null> => {
      const before = dataRef.current.leads.find((l) => l[F.ID] === id);
      if (!before) return null;
      const optimistic = normalizeLead({ ...before, ...patch, [F.UPDATED_AT]: nowIso() });
      markLocal(id);
      patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? optimistic : l)) }));
      try {
        const cleanPatch: Partial<Lead> = {};
        for (const k of Object.keys(patch)) if (k !== '_row') (cleanPatch as any)[k] = (patch as any)[k];
        const res = await write(() => api.leads.update(id, cleanPatch, before[F.UPDATED_AT]));
        const saved = normalizeLead(res.lead);
        patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? saved : l)) }));
        applyServerVersion(res.version);
        return saved;
      } catch (e) {
        patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? before : l)) }));
        const err = failToast('leads.update', e);
        if (err.code === 'CONFLICT' && err.details?.lead) {
          const serverLead = normalizeLead(err.details.lead);
          patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? serverLead : l)) }));
        }
        return null;
      }
    },
    [patchData]
  );

  const appendRemark = useCallback(
    async (id: string, remark: string, nextFollowup?: string): Promise<boolean> => {
      const before = dataRef.current.leads.find((l) => l[F.ID] === id);
      if (!before) return false;
      const now = new Date();
      let target = 0;
      for (let i = 1; i <= 50; i++) if (!before[`Follow-up ${i}`]) { target = i; break; }
      if (!target) {
        toast('Follow-up limit reached', 'This lead already has 50 follow-ups.', 'warning');
        return false;
      }
      const optimistic: Lead = { ...before, [`Follow-up ${target}`]: `${toSheetDateTime(now)} — ${remark}`, [F.LAST_FOLLOWUP]: now.toISOString() };
      if (nextFollowup) optimistic[F.NEXT_FOLLOWUP] = normalizeDateValue(nextFollowup);
      markLocal(id);
      patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? optimistic : l)) }));
      try {
        const res = await write(() => api.leads.appendRemark(id, remark, nextFollowup));
        patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? normalizeLead(res.lead) : l)) }));
        applyServerVersion(res.version);
        toast('Follow-up saved', `Follow-up #${res.index} logged for ${before[F.NAME]}`, 'success');
        return true;
      } catch (e) {
        patchData((p) => ({ ...p, leads: p.leads.map((l) => (l[F.ID] === id ? before : l)) }));
        failToast('leads.remark', e);
        return false;
      }
    },
    [patchData]
  );

  const setLeadStage = useCallback(
    async (id: string, stage: string) => {
      const res = await updateLead(id, { [F.STAGE]: stage });
      if (res) toast('Stage updated', `${res[F.NAME]} → ${stage}`, stage === STAGES.BOOKED ? 'success' : 'info');
      return !!res;
    },
    [updateLead]
  );

  const trashLead = useCallback(async (id: string) => !!(await updateLead(id, { [F.STAGE]: STAGES.TRASH })), [updateLead]);
  const restoreLead = useCallback(async (id: string) => !!(await updateLead(id, { [F.STAGE]: STAGES.NEW })), [updateLead]);

  const deleteLeadPermanently = useCallback(
    async (id: string) => {
      const before = dataRef.current.leads;
      patchData((p) => ({ ...p, leads: p.leads.filter((l) => l[F.ID] !== id) }));
      try {
        const res = await write(() => api.leads.remove(id));
        applyServerVersion(res.version);
        toast('Lead removed', `${id} moved to the archive`, 'info');
        return true;
      } catch (e) {
        patchData((p) => ({ ...p, leads: before }));
        failToast('leads.delete', e);
        return false;
      }
    },
    [patchData]
  );

  const importLeads = useCallback(
    async (leads: Lead[], strategy: string) => {
      try {
        const res = await write(() => api.leads.importBulk(leads, strategy));
        toast('Import complete', `${res.created} created, ${res.updated} updated`, 'success');
        await refresh({ silent: true, force: true });
        return { created: res.created, updated: res.updated };
      } catch (e) {
        failToast('leads.import', e);
        return null;
      }
    },
    [refresh]
  );

  /* -------------------------------- tasks ------------------------------- */

  const addTask = useCallback(
    async (task: Omit<TaskItem, 'id'>) => {
      const tempId = nextSequentialId('TASK', dataRef.current.tasks.map((t) => t.id));
      const optimistic = normalizeTask({ ...task, id: tempId, createdAt: nowIso(), createdBy: sessionRef.current?.user.name });
      markLocal(tempId);
      patchData((p) => ({ ...p, tasks: [optimistic, ...p.tasks] }));
      try {
        const res = await write(() => api.tasks.add(optimistic));
        const saved = normalizeTask(res.task);
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === tempId ? saved : t)) }));
        applyServerVersion(res.version);
        toast('Task scheduled', `${saved.name} · ${formatRelative(saved.datetime)}`, 'success');
        return saved;
      } catch (e) {
        patchData((p) => ({ ...p, tasks: p.tasks.filter((t) => t.id !== tempId) }));
        failToast('tasks.add', e);
        return null;
      }
    },
    [patchData]
  );

  const updateTask = useCallback(
    async (id: string, patch: Partial<TaskItem>) => {
      const before = dataRef.current.tasks.find((t) => t.id === id);
      if (!before) return false;
      const optimistic = normalizeTask({ ...before, ...patch });
      patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? optimistic : t)) }));
      try {
        const res = await write(() => api.tasks.update(id, patch));
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? normalizeTask(res.task) : t)) }));
        applyServerVersion(res.version);
        return true;
      } catch (e) {
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? before : t)) }));
        failToast('tasks.update', e);
        return false;
      }
    },
    [patchData]
  );

  const toggleTask = useCallback(
    async (id: string, completed: boolean) => {
      const before = dataRef.current.tasks.find((t) => t.id === id);
      if (!before) return false;
      patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? { ...t, completed, status: completed ? 'Completed' : 'Pending', completedAt: completed ? nowIso() : '' } : t)) }));
      try {
        const res = await write(() => api.tasks.toggle(id, completed));
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? normalizeTask(res.task) : t)) }));
        applyServerVersion(res.version);
        if (completed) toast('Task completed', before.name, 'success');
        return true;
      } catch (e) {
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === id ? before : t)) }));
        failToast('tasks.toggle', e);
        return false;
      }
    },
    [patchData]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      const before = dataRef.current.tasks;
      patchData((p) => ({ ...p, tasks: p.tasks.filter((t) => t.id !== id) }));
      try {
        const res = await write(() => api.tasks.remove(id));
        applyServerVersion(res.version);
        return true;
      } catch (e) {
        patchData((p) => ({ ...p, tasks: before }));
        failToast('tasks.delete', e);
        return false;
      }
    },
    [patchData]
  );

  const toggleTaskChecklist = useCallback(
    (id: string, index: number, checked: boolean) => {
      const t = dataRef.current.tasks.find((x) => x.id === id);
      if (!t) return;
      const checklist = t.checklist.map((c, i) => (i === index ? { ...c, checked } : c));
      updateTask(id, { checklist });
    },
    [updateTask]
  );

  const snoozeAlarm = useCallback(
    async (task: TaskItem, minutes: number) => {
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      setActiveAlarmTask(null);
      try {
        const res = await write(() => api.tasks.snooze(task.id, until));
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === task.id ? normalizeTask(res.task) : t)) }));
        applyServerVersion(res.version);
        toast('Snoozed', `${task.name} · ${formatRelative(until)}`, 'info');
      } catch (e) {
        patchData((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, snoozedUntil: until, datetime: until } : t)) }));
        failToast('tasks.snooze', e);
      }
    },
    [patchData]
  );

  const dismissAlarm = useCallback(() => {
    setActiveAlarmTask((t) => {
      if (t) notifications.ack(eventKey('task_due', t.id, t.datetime));
      return null;
    });
  }, []);

  const completeAlarm = useCallback(
    async (task: TaskItem) => {
      setActiveAlarmTask(null);
      await toggleTask(task.id, true);
    },
    [toggleTask]
  );

  /* ------------------------------ inventory ----------------------------- */

  const updateUnit = useCallback(
    async (inventoryId: string, patch: Partial<InventoryUnit>) => {
      const before = dataRef.current.inventory.find((u) => u.inventoryId === inventoryId || u.unitId === inventoryId);
      if (!before) return { ok: false };
      const optimistic = { ...before, ...patch, syncStatus: 'Pending' as const };
      patchData((p) => ({ ...p, inventory: p.inventory.map((u) => (u === before ? optimistic : u)) }));
      try {
        const res = await write(() => api.inventory.update(before.inventoryId || before.unitId, patch, before.lastModified));
        if (res.conflict) {
          patchData((p) => ({ ...p, inventory: p.inventory.map((u) => (u.inventoryId === before.inventoryId ? { ...res.conflict!, syncStatus: 'Conflict' } : u)) }));
          toast('Unit changed elsewhere', `Unit ${before.unitId} was edited by someone else. Showing the latest version — please re-apply your change.`, 'warning');
          return { ok: false, conflict: res.conflict };
        }
        patchData((p) => ({ ...p, inventory: p.inventory.map((u) => (u.inventoryId === before.inventoryId || u.unitId === before.unitId ? res.unit : u)) }));
        applyServerVersion(res.version);
        toast('Inventory updated', `Unit ${res.unit.unitId} → ${res.unit.status}`, res.unit.status === 'Booked' ? 'success' : 'info');
        return { ok: true };
      } catch (e) {
        patchData((p) => ({ ...p, inventory: p.inventory.map((u) => (u === optimistic ? { ...before, syncStatus: 'Error', syncError: toAppError(e).userMessage } : u)) }));
        failToast('inventory.update', e);
        return { ok: false };
      }
    },
    [patchData]
  );

  const addUnit = useCallback(
    async (unit: Partial<InventoryUnit>) => {
      try {
        const res = await write(() => api.inventory.add(unit));
        patchData((p) => ({ ...p, inventory: [...p.inventory, res.unit] }));
        applyServerVersion(res.version);
        toast('Unit added', res.unit.unitId, 'success');
        return true;
      } catch (e) {
        failToast('inventory.add', e);
        return false;
      }
    },
    [patchData]
  );

  const importInventory = useCallback(
    async (units: Partial<InventoryUnit>[]) => {
      try {
        const res = await write(() => api.inventory.importUnits(units));
        toast('Inventory imported', `${res.created} units added, ${res.skipped} already existed`, 'success');
        await refresh({ silent: true, force: true });
        return { created: res.created, skipped: res.skipped };
      } catch (e) {
        failToast('inventory.import', e);
        return null;
      }
    },
    [refresh]
  );

  /* ------------------------------- records ------------------------------ */

  const saveRecord = async <T extends { id?: string }>(kind: 'documents' | 'templates' | 'notes' | 'checklist', rec: T, key: keyof CRMData) => {
    const list = (dataRef.current[key] as any[]) || [];
    const isNew = !rec.id || !list.some((r) => r.id === rec.id);
    const tempId = rec.id || randomId('tmp');
    const optimistic = { ...rec, id: tempId };
    patchData((p) => ({ ...p, [key]: isNew ? [optimistic, ...((p[key] as any[]) || [])] : ((p[key] as any[]) || []).map((r) => (r.id === tempId ? optimistic : r)) }));
    try {
      const saved = await write(() => api.records.save<T & { id: string }>(kind, { ...rec, id: isNew ? undefined : rec.id } as any));
      patchData((p) => ({ ...p, [key]: ((p[key] as any[]) || []).map((r) => (r.id === tempId ? saved : r)) }));
      return true;
    } catch (e) {
      patchData((p) => ({ ...p, [key]: isNew ? ((p[key] as any[]) || []).filter((r) => r.id !== tempId) : list }));
      failToast(`records.${kind}`, e);
      return false;
    }
  };

  const removeRecord = async (kind: 'documents' | 'templates' | 'notes' | 'checklist', id: string, key: keyof CRMData) => {
    const before = (dataRef.current[key] as any[]) || [];
    patchData((p) => ({ ...p, [key]: ((p[key] as any[]) || []).filter((r) => r.id !== id) }));
    try {
      await write(() => api.records.remove(kind, id));
      return true;
    } catch (e) {
      patchData((p) => ({ ...p, [key]: before }));
      failToast(`records.${kind}`, e);
      return false;
    }
  };

  const saveDocument = useCallback((doc: Partial<CrmDocument>) => saveRecord('documents', { uploadedDate: nowIso(), ...doc } as CrmDocument, 'documents'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const deleteDocument = useCallback((id: string) => removeRecord('documents', id, 'documents'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveTemplate = useCallback((tpl: Partial<MessageTemplate>) => saveRecord('templates', { ...tpl, updated: nowIso() } as MessageTemplate, 'templates'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const deleteTemplate = useCallback((id: string) => removeRecord('templates', id, 'templates'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const addNote = useCallback((text: string) => saveRecord('notes', { text, created: nowIso(), updated: nowIso() } as NoteItem, 'notes'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const deleteNote = useCallback((id: string) => removeRecord('notes', id, 'notes'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const addChecklist = useCallback((text: string) => saveRecord('checklist', { text, completed: false, updated: nowIso() } as ChecklistItem, 'checklist'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleChecklist = useCallback(
    (id: string, completed: boolean) => {
      const item = dataRef.current.checklist.find((c) => c.id === id);
      if (!item) return Promise.resolve(false);
      return saveRecord('checklist', { ...item, completed, updated: nowIso() }, 'checklist');
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const deleteChecklist = useCallback((id: string) => removeRecord('checklist', id, 'checklist'), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------- segments ----------------------------- */

  const createSegment = useCallback(
    (s: Omit<ClientSegment, 'id' | 'createdAt'>) => {
      patchData((p) => ({
        ...p,
        segments: [...(p.segments || []), { ...s, id: nextSequentialId('SEG', (p.segments || []).map((x) => x.id)), createdAt: nowIso(), createdBy: sessionRef.current?.user.name }],
      }));
      toast('Segment created', s.name, 'success');
    },
    [patchData]
  );
  const updateSegment = useCallback((id: string, patch: Partial<ClientSegment>) => patchData((p) => ({ ...p, segments: (p.segments || []).map((s) => (s.id === id ? { ...s, ...patch } : s)) })), [patchData]);
  const deleteSegment = useCallback((id: string) => patchData((p) => ({ ...p, segments: (p.segments || []).filter((s) => s.id !== id) })), [patchData]);

  const applyServerSettings = useCallback((s: ServerSettings) => {
    patchData((p) => ({ ...p, serverSettings: { ...(p.serverSettings || {}), ...s }, settings: { ...p.settings, aiConfigured: !!s.aiConfigured, geminiModel: s.aiModel || p.settings.geminiModel, timeZone: s.timeZone || p.settings.timeZone } }));
  }, [patchData]);

  const currentUser = session?.user || null;
  const canDo = useCallback((perm: Parameters<typeof can>[1]) => can(currentUser, perm), [currentUser]);

  return useMemo<CrmEngine>(
    () => ({
      data, authStatus, session, currentUser, sync, isOnline, activeAlarmTask, can: canDo,
      login, logout, updateProfile, refresh, updateLocalSettings,
      addLead, updateLead, appendRemark, setLeadStage, trashLead, restoreLead, deleteLeadPermanently, importLeads,
      addTask, updateTask, toggleTask, deleteTask, toggleTaskChecklist, snoozeAlarm, dismissAlarm, completeAlarm,
      updateUnit, addUnit, importInventory,
      saveDocument, deleteDocument, saveTemplate, deleteTemplate, addNote, deleteNote, addChecklist, toggleChecklist, deleteChecklist,
      createSegment, updateSegment, deleteSegment, applyServerSettings,
    }),
    [data, authStatus, session, currentUser, sync, isOnline, activeAlarmTask, canDo, login, logout, updateProfile, refresh, updateLocalSettings, addLead, updateLead, appendRemark, setLeadStage, trashLead, restoreLead, deleteLeadPermanently, importLeads, addTask, updateTask, toggleTask, deleteTask, toggleTaskChecklist, snoozeAlarm, dismissAlarm, completeAlarm, updateUnit, addUnit, importInventory, saveDocument, deleteDocument, saveTemplate, deleteTemplate, addNote, deleteNote, addChecklist, toggleChecklist, deleteChecklist, createSegment, updateSegment, deleteSegment, applyServerSettings]
  );
}

export { AppError };
