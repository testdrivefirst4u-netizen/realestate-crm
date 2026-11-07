/** Meta's Embedded Signup in the browser: its script, the popup, and the two answers it gives (a code, and the account ids). */

export interface SignupConfig { ready: boolean; appId: string; configId: string; version: string; solutionId: string }
export interface SignupResult { code: string; wabaId: string; phoneNumberId: string; event: string }
export type SignupMessage = { kind: 'finish'; event: string; wabaId: string; phoneNumberId: string } | { kind: 'cancel'; step: string } | { kind: 'error'; message: string };

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
/** The code only lasts 30 seconds, so the ids get a short wait; the server can find them without. */
const WAIT_FOR_IDS_MS = 6000;

/** The real facebook.com only: ending in those letters would also let in evilfacebook.com. */
export function isFacebookOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com'));
  } catch {
    return false;
  }
}

/** What a message from the popup means. Null for anything else a page may post. */
export function parseSignupMessage(origin: string, raw: unknown): SignupMessage | null {
  if (!isFacebookOrigin(origin)) return null;
  let m: any;
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (m?.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const event = String(m.event || '');
  if (event === 'CANCEL') return { kind: 'cancel', step: String(m.data?.current_step || '') };
  if (event === 'ERROR') return { kind: 'error', message: String(m.data?.error_message || 'Meta reported a problem.') };
  if (event.startsWith('FINISH')) return { kind: 'finish', event, wabaId: String(m.data?.waba_id || ''), phoneNumberId: String(m.data?.phone_number_id || '') };
  return null;
}

/** The options for Meta's popup. The partner's solution id is what puts the client on BroaddCast's billing. */
export function loginOptions(cfg: Pick<SignupConfig, 'configId' | 'solutionId'>, keepApp: boolean) {
  return {
    config_id: cfg.configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: {
      setup: cfg.solutionId ? { solutionID: cfg.solutionId } : {},
      featureType: keepApp ? 'whatsapp_business_app_onboarding' : '',
      sessionInfoVersion: '3',
    },
  };
}

let sdk: Promise<void> | null = null;

/** Loaded before the click: browsers block a popup opened after waiting for a script. */
export function loadSignupSdk(cfg: Pick<SignupConfig, 'appId' | 'version'>): Promise<void> {
  if (sdk) return sdk;
  sdk = new Promise<void>((resolve, reject) => {
    const w = window as any;
    w.fbAsyncInit = () => {
      w.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: true, version: cfg.version });
      resolve();
    };
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => { sdk = null; reject(new Error('Could not load Facebook. Check that nothing is blocking it, then try again.')); };
    document.body.appendChild(s);
  });
  return sdk;
}

/** Opens Meta's popup. Must be called straight from the click. Resolves with what the server needs, or null if it was closed. */
export function startSignup(cfg: SignupConfig, keepApp: boolean): Promise<SignupResult | null> {
  return new Promise((resolve, reject) => {
    let finish: Extract<SignupMessage, { kind: 'finish' }> | null = null;
    let code = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
    };
    const settle = () => {
      done();
      resolve({ code, wabaId: finish?.wabaId || '', phoneNumberId: finish?.phoneNumberId || '', event: finish?.event || '' });
    };
    const onMessage = (e: MessageEvent) => {
      const m = parseSignupMessage(e.origin, e.data);
      if (!m) return;
      if (m.kind === 'error') { done(); reject(new Error(m.message)); return; }
      if (m.kind === 'cancel') return; // the popup's own answer below says it was closed
      finish = m;
      if (code) settle();
    };
    window.addEventListener('message', onMessage);
    // Meta's SDK refuses an async function here
    (window as any).FB.login((response: any) => {
      const c = String(response?.authResponse?.code || '');
      if (!c) { done(); resolve(null); return; }
      code = c;
      if (finish) settle();
      else timer = setTimeout(settle, WAIT_FOR_IDS_MS);
    }, loginOptions(cfg, keepApp));
  });
}
