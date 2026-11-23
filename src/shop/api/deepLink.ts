/**
 * The shop app's links, as data.
 *
 * A shop hands out two kinds of link and a farmer's phone has to tell them apart
 * without a network: a *join* (`agrishop://join?code=ABC123`), printed on a
 * sticker, and an *invitation* (`agrishop://farmer?token=…`), sent by the owner
 * to one farmer in particular. The second is the more dangerous of the two —
 * a token is a credential — so the parser accepts nothing that is not exactly one
 * of those shapes and never guesses at a truncated one.
 *
 * The join code is six characters here, not the eight this app issues itself: the
 * shop backend owns the code, so the rule is theirs (see the shop integration
 * contract). Both code lengths live side by side because the app can be invited by
 * a shop it does not host.
 */

/** The length of a code the shop backend issues. Not the app's own 8-character code. */
export const SHOP_CODE_LENGTH = 6;

/** The scheme the shop app registers. */
export const SHOP_SCHEME = 'agrishop';

export type ShopLink =
  | { kind: 'join'; code: string }
  | { kind: 'invite'; token: string };

/**
 * Whatever arrived, reduced to the six characters that identify a shop — or null.
 *
 * Case, spaces, dashes and surrounding junk are forgiven, because these codes are
 * read off a printed sticker and typed by hand. Length and alphabet are not: a
 * half-read code connects a farmer to the wrong shop, which is worse than asking
 * them to try again.
 */
export function normaliseShopCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length !== SHOP_CODE_LENGTH) return null;
  if (!/^[A-Z0-9]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * A link from the shop app, or null.
 *
 * Everything is matched on the *query*, not on the host: `agrishop://join?code=…`
 * and `agrishop://farmer?token=…` differ only in the parameter they carry, and a
 * phone that received one of these through a URL handler has no reliable host.
 */
export function parseShopLink(input: string | null | undefined): ShopLink | null {
  if (!input) return null;

  const value = input.trim();
  if (!value) return null;

  const queryStart = value.indexOf('?');
  if (queryStart < 0) return null;

  /* A `#` can appear inside a token, so only a genuine fragment separator after
     the query string is treated as one. */
  const query = value.slice(queryStart + 1).split('#')[0] ?? '';
  if (!query) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }

  /* Parameter names are matched without case: `CODE=` and `code=` are the same
     instruction, and a link that has been through a clipboard, a chat app or a
     print workshop has every chance of arriving shouted. */
  const lookup = (name: string): string | null => {
    for (const [key, value] of params.entries()) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  };

  const code = normaliseShopCode(lookup('code'));
  if (code) return { kind: 'join', code };

  const token = lookup('token')?.trim() ?? '';
  /* A credential, so it has to look like one: long, single-line, and with no
     whitespace to be silently swallowed by a paste. */
  if (token.length >= 20 && token.length <= 4096 && !/\s/.test(token)) {
    return { kind: 'invite', token };
  }

  return null;
}

/** The link to hand a farmer who already has the app: the invitation, not the code. */
export function invitationLink(token: string): string {
  return `${SHOP_SCHEME}://farmer?token=${encodeURIComponent(token)}`;
}
