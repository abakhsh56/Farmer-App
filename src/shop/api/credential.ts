/**
 * The farmer's shop credential, on this phone.
 *
 * It is a bearer credential — whoever holds it is the farmer, to that shop — so it
 * is stored in one place, validated on the way in and on the way out, and removed
 * the moment the shop says it is gone. Storing it is the only reason this app has
 * a conversation that survives a reinstall-free restart: there is no farmer login
 * on the shop side, so this string *is* the account.
 *
 * `localStorage` rather than a cookie or a session: the app is a WebView on a
 * phone, and a session that clears when the WebView is reclaimed would sign a
 * farmer out of his own conversation every time Android needed the memory.
 */

export type ShopCredential = {
  token: string;
  farmerId: string;
  shopId: string;
  shopName: string;
  joinedAt: number;
};

export const SHOP_CREDENTIAL_KEY = 'farmer.shop.credential';
export const SHOP_CREDENTIAL_VERSION = 1;

type Persisted = {
  version: number;
  token: string;
  farmerId: string;
  shopId: string;
  shopName: string;
  joinedAt: number;
};

/** A token that is plausibly one, used by both the writer and the reader. */
export function isPlausibleToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096 && !/\s/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function serialiseShopCredential(credential: ShopCredential): string {
  const payload: Persisted = { version: SHOP_CREDENTIAL_VERSION, ...credential };
  return JSON.stringify(payload);
}

/**
 * Read a stored credential back.
 *
 * Strict on purpose. Half a credential — a token without a shop id — would render
 * a conversation with no shop and send messages nobody can attribute, which looks
 * exactly like a working chat until the shop answers the wrong farmer.
 */
export function hydrateShopCredential(raw: string | null): ShopCredential | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as Partial<Persisted>;
  if (payload.version !== SHOP_CREDENTIAL_VERSION) return null;
  if (!isPlausibleToken(payload.token)) return null;
  if (!nonEmpty(payload.farmerId) || !nonEmpty(payload.shopId)) return null;

  return {
    token: payload.token,
    farmerId: payload.farmerId,
    shopId: payload.shopId,
    shopName: nonEmpty(payload.shopName) ? payload.shopName : '',
    joinedAt: typeof payload.joinedAt === 'number' ? payload.joinedAt : Date.now(),
  };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    /* A WebView with storage disabled is a phone that cannot keep a credential;
       the conversation still works for as long as the app is open. */
    return null;
  }
}

export function loadShopCredential(): ShopCredential | null {
  return hydrateShopCredential(storage()?.getItem(SHOP_CREDENTIAL_KEY) ?? null);
}

export function saveShopCredential(credential: ShopCredential): void {
  try {
    storage()?.setItem(SHOP_CREDENTIAL_KEY, serialiseShopCredential(credential));
  } catch {
    // Quota or a locked store: the session in memory is still correct.
  }
}

export function clearShopCredential(): void {
  try {
    storage()?.removeItem(SHOP_CREDENTIAL_KEY);
  } catch {
    // Nothing to do; the caller has already dropped it from state.
  }
}
