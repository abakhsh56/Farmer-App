import { useCallback, useEffect, useState } from 'react';
import { serviceConfig } from '@/services/config';
import { getSupabaseClient } from '@/services/supabaseClient';
import { joinCodeFromUrl, parseJoinCode } from './joinLink';

/**
 * Joining a shop from a code.
 *
 * The code can arrive two ways and both end here: a phone's camera opened the
 * link (`?join=ABCD2345`), or the farmer typed it. The URL is read once and then
 * removed from the address bar, because leaving it there means a reload rejoins
 * the shop — and on a shared phone, the next person to open the app inherits the
 * previous farmer's scan.
 */

export type JoinState =
  | { status: 'idle' }
  | { status: 'joining'; code: string }
  | { status: 'joined'; shopName: string; dealerId: string; alreadyJoined: boolean }
  | { status: 'failed'; code: string; reason: 'unknown' | 'expired' | 'unavailable' };

type RpcResult = { dealer_id: string; shop_name: string; already_joined: boolean };

/** Server codes, mapped to the four things a farmer can actually do about them. */
function reasonFor(message: string): 'unknown' | 'expired' | 'unavailable' {
  if (/code_expired|code_revoked|code_exhausted|unknown_code/.test(message)) return 'expired';
  if (/not_signed_in|not_a_farmer|42501/.test(message)) return 'unavailable';
  return 'unknown';
}

export function useShopJoin() {
  const [state, setState] = useState<JoinState>({ status: 'idle' });

  /** The code waiting in the URL, if this launch came from a scan. */
  useEffect(() => {
    const code = joinCodeFromUrl(window.location.href);
    if (!code) return;

    setState({ status: 'joining', code });

    const url = new URL(window.location.href);
    url.searchParams.delete('join');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const join = useCallback(async (rawCode: string) => {
    const code = parseJoinCode(rawCode);
    if (!code) {
      setState({ status: 'failed', code: rawCode, reason: 'unknown' });
      return;
    }

    if (!serviceConfig.supabase.configured) {
      setState({ status: 'failed', code, reason: 'unavailable' });
      return;
    }

    setState({ status: 'joining', code });

    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      if (!client) {
        setState({ status: 'failed', code, reason: 'unavailable' });
        return;
      }

      const { data, error } = await client.rpc('join_shop_with_code', { p_code: code });

      if (error) {
        setState({ status: 'failed', code, reason: reasonFor(`${error.message} ${error.code ?? ''}`) });
        return;
      }

      const row = (Array.isArray(data) ? data[0] : data) as RpcResult | null;
      if (!row) {
        setState({ status: 'failed', code, reason: 'unknown' });
        return;
      }

      setState({
        status: 'joined',
        dealerId: row.dealer_id,
        shopName: row.shop_name,
        alreadyJoined: row.already_joined,
      });
    } catch {
      setState({ status: 'failed', code, reason: 'unavailable' });
    }
  }, []);

  const dismiss = useCallback(() => setState({ status: 'idle' }), []);

  return { state, join, dismiss };
}
