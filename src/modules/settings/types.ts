/**
 * Settings module — local type extensions.
 *
 * The server's `getSettings` returns a few fields that `src/types/crm.ts` does not
 * declare. They are typed here so the settings sections stay strictly typed
 * without touching core/ or types/.
 */
import type { CRMSettings, ServerSettings, UserAccount } from '../../types/crm';
import type { Permission } from '../../core/rbac';

/** Integration secrets the server can hold (encrypted in MongoDB or set as environment variables). */
export type SecretKey = 'GEMINI_API_KEY' | 'CHAT360_API_KEY' | 'CHAT360_LOGIN_PASSWORD' | 'CHAT360_WEBHOOK_SECRET' | 'TELEPHONY_WEBHOOK_SECRET';

/** `getSettings` payload — superset of ServerSettings. */
export interface ServerSettingsExt extends ServerSettings {
  chat360DefaultSource?: string;
  telephonyFieldMap?: string;
  dailyDigestEmail?: string;
  webAppUrl?: string;
  /** Obsolete since companies manage their own keys (always all-false); still accepted, no longer read. */
  secretsFromEnv?: Partial<Record<SecretKey, boolean>>;
  /** Where uploaded files are stored (e.g. "MongoDB GridFS"). */
  storage?: string;
}

export type CanFn = (p: Permission) => boolean;

/** Props shared by most sections. */
export interface SectionBaseProps {
  settings: CRMSettings;
  serverSettings?: ServerSettingsExt;
  currentUser: UserAccount | null;
  can: CanFn;
  onApplyServerSettings: (s: ServerSettings) => void;
}

/** Small helper used by every section: run an api call, report + surface errors. */
export type AsyncResult<T> = { ok: true; data: T } | { ok: false; message: string };
