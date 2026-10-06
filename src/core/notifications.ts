/**
 * Notification bus with deduplication.
 *
 * Two channels:
 *  - `notify()`  persistent, deduplicated by `key`, shown in the Notification
 *                Center and (optionally) as a browser notification. One event
 *                key → one notification, ever (seen keys are persisted).
 *  - `toast()`   transient feedback for the user's own actions ("Saved").
 *                Never persisted, never deduplicated, auto-dismissed.
 *
 * Event keys look like `<type>:<recordId>:<eventId>`; e.g.
 *   task_due:TASK-0012:2026-10-01T11:00:00.000Z
 *   lead_created:ENQ-0042:EVT-000913
 */
import { NotificationItem, NotificationType, ToastItem } from '../types/crm';
import { STORAGE_KEYS } from './config';
import { sound } from '../services/sound';

type Listener = (items: NotificationItem[]) => void;
type ToastListener = (items: ToastItem[]) => void;

const MAX_NOTIFICATIONS = 200;
const MAX_SEEN_KEYS = 3000;
const SOUND_THROTTLE_MS = 4000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — notifications are best effort */
  }
}

export interface NotifyInput {
  key: string;
  title: string;
  message: string;
  type?: NotificationType;
  recordType?: string;
  recordId?: string;
  link?: string;
  playAudio?: boolean;
  browser?: boolean;
  timestamp?: string;
}

class NotificationBus {
  private items: NotificationItem[] = [];
  private seen: Set<string> = new Set();
  private seenOrder: string[] = [];
  private listeners = new Set<Listener>();
  private toastListeners = new Set<ToastListener>();
  private toasts: ToastItem[] = [];
  private lastSoundAt = 0;

  constructor() {
    this.items = readJson<NotificationItem[]>(STORAGE_KEYS.NOTIFICATIONS, []).filter((n) => n && n.id);
    const seen = readJson<string[]>(STORAGE_KEYS.NOTIFICATION_SEEN, []);
    this.seenOrder = seen.slice(-MAX_SEEN_KEYS);
    this.seen = new Set(this.seenOrder);
    for (const n of this.items) if (n.key) this.remember(n.key, false);
    // Cross-tab consistency
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEYS.NOTIFICATIONS) {
          this.items = readJson<NotificationItem[]>(STORAGE_KEYS.NOTIFICATIONS, []);
          this.emit(false);
        }
        if (e.key === STORAGE_KEYS.NOTIFICATION_SEEN) {
          const seen = readJson<string[]>(STORAGE_KEYS.NOTIFICATION_SEEN, []);
          for (const k of seen) this.remember(k, false);
        }
      });
    }
  }

  /* ----------------------------- persistent ----------------------------- */

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener([...this.items]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(persist = true) {
    const copy = [...this.items];
    this.listeners.forEach((l) => l(copy));
    if (persist) writeJson(STORAGE_KEYS.NOTIFICATIONS, this.items.slice(0, MAX_NOTIFICATIONS));
  }

  private remember(key: string, persist = true) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN_KEYS) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - MAX_SEEN_KEYS);
      drop.forEach((k) => this.seen.delete(k));
    }
    if (persist) writeJson(STORAGE_KEYS.NOTIFICATION_SEEN, this.seenOrder);
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  /** Mark an event key as handled without showing anything (e.g. own actions echoed by the server). */
  ack(key: string) {
    this.remember(key);
  }

  /** Returns the created item, or null when the key was already seen. */
  notify(input: NotifyInput): NotificationItem | null {
    const key = String(input.key || '').trim();
    if (!key) return null;
    if (this.seen.has(key)) return null;
    this.remember(key);

    const item: NotificationItem = {
      id: `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      key,
      title: input.title,
      message: input.message,
      timestamp: input.timestamp || new Date().toISOString(),
      type: input.type || 'info',
      read: false,
      recordType: input.recordType,
      recordId: input.recordId,
      link: input.link,
    };
    this.items.unshift(item);
    if (this.items.length > MAX_NOTIFICATIONS) this.items.length = MAX_NOTIFICATIONS;
    this.emit();

    if (input.playAudio !== false) this.playSound(item.type);
    if (input.browser !== false) this.browserNotify(item);
    return item;
  }

  private playSound(type: NotificationType) {
    const now = Date.now();
    if (now - this.lastSoundAt < SOUND_THROTTLE_MS) return;
    this.lastSoundAt = now;
    try {
      if (type === 'success') sound.playSuccess();
      else sound.playChime();
    } catch {
      /* audio may be blocked until user interaction */
    }
  }

  private browserNotify(item: NotificationItem) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return; // in-app UI is enough
    try {
      new Notification(item.title, { body: item.message, tag: item.key });
    } catch {
      /* ignore */
    }
  }

  markAsRead(id: string) {
    const t = this.items.find((n) => n.id === id);
    if (t && !t.read) {
      t.read = true;
      this.emit();
    }
  }

  markAllAsRead() {
    let changed = false;
    this.items.forEach((n) => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });
    if (changed) this.emit();
  }

  remove(id: string) {
    const before = this.items.length;
    this.items = this.items.filter((n) => n.id !== id);
    if (this.items.length !== before) this.emit();
  }

  clearAll() {
    this.items = [];
    this.emit();
  }

  getUnreadCount(): number {
    return this.items.filter((n) => !n.read).length;
  }

  getAll(): NotificationItem[] {
    return [...this.items];
  }

  /* -------------------------------- toasts ------------------------------ */

  subscribeToasts(listener: ToastListener) {
    this.toastListeners.add(listener);
    listener([...this.toasts]);
    return () => {
      this.toastListeners.delete(listener);
    };
  }

  toast(title: string, message?: string, type: NotificationType = 'info', durationMs = 3500): ToastItem {
    const item: ToastItem = {
      id: `tst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      message,
      type,
      createdAt: Date.now(),
    };
    this.toasts = [...this.toasts.slice(-4), item];
    this.toastListeners.forEach((l) => l([...this.toasts]));
    setTimeout(() => this.dismissToast(item.id), durationMs);
    return item;
  }

  dismissToast(id: string) {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) this.toastListeners.forEach((l) => l([...this.toasts]));
  }

  /* ---------------------------- browser perms --------------------------- */

  getBrowserPermission(): NotificationPermission {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
    return Notification.permission;
  }

  async requestBrowserPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }
}

export const notifications = new NotificationBus();

export const notify = (input: NotifyInput) => notifications.notify(input);
export const toast = (title: string, message?: string, type: NotificationType = 'info') =>
  notifications.toast(title, message, type);

/** Build a stable key for a record event. */
export function eventKey(type: string, recordId: string, eventId: string | number): string {
  return `${type}:${recordId}:${eventId}`;
}
