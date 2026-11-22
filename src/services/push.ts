import { Capacitor } from '@capacitor/core';
import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

/**
 * Push registration, for the phone that answers a shop's counter.
 *
 * A shop owner needs to know a farmer joined, or a message is waiting, without
 * opening the app. That is a device token: per install, not per account, because
 * the same owner often has a counter phone and a personal one.
 *
 * Three things this deliberately does not do:
 *
 *  · It does not ask for permission on launch. A notification prompt with no
 *    context is the fastest way to be denied forever, and a phone that is denied
 *    cannot be asked again from inside the app. The caller asks at the moment the
 *    owner is told why — see `requestShopOwnerPush`.
 *  · It does not run in the browser. Web push needs a service worker subscription
 *    with VAPID keys and a sender that speaks Web Push; the native path is what
 *    this project ships, and a half-wired browser path would report success for
 *    notifications it cannot deliver.
 *  · It does not throw at the caller. A shop without push is a shop that reads the
 *    app; it is not an error the owner should see.
 */

export type PushRegistration =
  | { status: 'registered'; platform: 'android' | 'ios' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** True when the app is the installed build rather than the browser tab. */
export function pushSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Registers this phone and hands the token to the server.
 *
 * The token is stored through `register_push_token`, which is idempotent on the
 * token itself — launching the app again must not double every notification.
 */
export async function requestShopOwnerPush(): Promise<PushRegistration> {
  if (!Capacitor.isNativePlatform()) return { status: 'unsupported' };
  if (!serviceConfig.supabase.configured) return { status: 'unavailable' };

  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return { status: 'unsupported' };

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const existing = await PushNotifications.checkPermissions();
    let permission = existing.receive;

    if (permission === 'prompt' || permission === 'prompt-with-rationale') {
      permission = (await PushNotifications.requestPermissions()).receive;
    }

    if (permission !== 'granted') return { status: 'denied' };

    const token = await new Promise<string | null>((resolve) => {
      const settle = (value: string | null) => {
        resolve(value);
      };

      void PushNotifications.addListener('registration', (value) => settle(value.value));
      void PushNotifications.addListener('registrationError', () => settle(null));

      void PushNotifications.register();

      /* The platform answers in milliseconds; a refusal must not hang the caller. */
      setTimeout(() => settle(null), 10_000);
    });

    if (!token) return { status: 'unavailable' };

    const client = await getSupabaseClient(serviceConfig.supabase);
    if (!client) return { status: 'unavailable' };

    const { error } = await client.rpc('register_push_token', {
      p_token: token,
      p_platform: platform,
    });

    if (error) return { status: 'unavailable' };

    return { status: 'registered', platform };
  } catch {
    return { status: 'unavailable' };
  }
}
