import { Capacitor } from '@capacitor/core';
import { useEffect, useRef } from 'react';
import { onPushTap, registerShopDevice } from '@/services/push';
import { useShopApi } from './ShopApiProvider';

/**
 * This phone, registered with the shop.
 *
 * Two separate jobs, and both have to happen on a phone that has already joined a
 * shop:
 *
 *  · **Register.** The shop backend addresses a farmer by his credential plus a
 *    device token, so the token is sent through `farmer_api_register_device` every
 *    time the app opens. FCM rotates tokens; the shop backend moves its row rather
 *    than adding one, so a phone opened daily never accumulates duplicates.
 *  · **Route a tap.** Every push the shop sends carries `data.route`, and for a
 *    farmer that is `/` — open the conversation. The route is used as a signal, not
 *    as a URL: the app has one conversation, and a route it does not recognise must
 *    not navigate anywhere.
 */

export function useShopPush(onOpenConversation: () => void): void {
  const { status, credential } = useShopApi();
  const token = credential?.token ?? null;
  const open = useRef(onOpenConversation);
  open.current = onOpenConversation;

  useEffect(() => {
    if (status !== 'ready' || !token) return;
    if (!Capacitor.isNativePlatform()) return;

    void registerShopDevice(token);
  }, [status, token]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;

    void onPushTap((route) => {
      if (!route || route === '/') open.current();
    }).then((detach) => {
      remove = detach;
    });

    return () => remove?.();
  }, []);
}
