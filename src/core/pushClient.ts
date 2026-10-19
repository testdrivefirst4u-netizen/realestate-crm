/**
 * Phone notifications in the browser: register the service worker (/sw.js), subscribe this device with the
 * server's VAPID public key, or unsubscribe. iPhone needs the CRM opened from the Home Screen (iOS 16.4+).
 */

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const isIOS = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** Opened from the Home Screen (installed), not a browser tab. */
export const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = (await navigator.serviceWorker.getRegistration('/')) || (await registerServiceWorker());
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask for permission (must run from a tap) and subscribe this device. */
export async function subscribeDevice(publicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in your phone or browser settings, then try again.' : 'Notifications were not allowed.');
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  return sub.toJSON();
}

export async function unsubscribeDevice(): Promise<string> {
  const sub = await currentSubscription();
  if (!sub) return '';
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
