/**
 * Shop join links.
 *
 * A shop owner shows one code; a farmer's phone turns it into a link and the app
 * turns the link back into a join. Everything here is pure — no network, no
 * React — because the parsing is the part that has to be right when a farmer
 * scans a printed sticker in bad light and the code arrives mixed with a URL
 * fragment, a trailing slash or a stray space from a QR payload typed by hand.
 *
 * The code itself is deliberately short and unambiguous: eight characters from
 * an alphabet with no `0/O`, `1/I/L`, `5/S` or `2/Z` pairs, so a code read aloud
 * over a phone call, or typed from a smudged label, still lands on the right shop.
 */

/**
 * No look-alike pairs: this alphabet is meant to be read out and typed.
 *
 * Left out: `I` and `L` (read as 1), `O` (read as 0), `S` (read as 5), `Z` (read as
 * 2), and the digits `0 1 2 5 7 8` for the same reason in reverse. It must stay
 * character-for-character equal to the check on `shop_join_codes.code`.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY349';

export const CODE_LENGTH = 8;

/** The query parameter a join link carries. */
const JOIN_PARAM = 'join';

/**
 * Normalises whatever arrived into the canonical code form, or `null`.
 *
 * Accepts the code bare (`ABCD-2345`), with spaces, in lower case, or the whole
 * link (`https://…/?join=abcd2345`). Anything that is not exactly a code is
 * rejected rather than half-read: a partial code joins the wrong shop, which is
 * worse than asking the farmer to scan again.
 */
export function parseJoinCode(input: string | null | undefined): string | null {
  if (!input) return null;

  let candidate = input.trim();

  // A full link: take the `join` parameter and ignore the rest of the URL.
  if (/^[a-z]+:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      /*
       * The hash is read as well as the query: a WebView deep link arrives as
       * `https://localhost/#/join?join=…` and its parameter is in the fragment,
       * where `searchParams` cannot see it.
       */
      candidate =
        url.searchParams.get(JOIN_PARAM) ??
        new URLSearchParams(url.hash.replace(/^#\/?/, '').replace(/^[^?]*\?/, '')).get(JOIN_PARAM) ??
        '';
    } catch {
      return null;
    }
  } else if (candidate.includes(`${JOIN_PARAM}=`)) {
    // A pasted fragment without a scheme, e.g. `farmer.app/?join=ABCD2345`.
    candidate = candidate.slice(candidate.indexOf(`${JOIN_PARAM}=`) + JOIN_PARAM.length + 1);
    const cut = candidate.search(/[&#\s]/);
    if (cut >= 0) candidate = candidate.slice(0, cut);
  }

  const cleaned = candidate.replace(/[\s-]/g, '').toUpperCase();

  if (cleaned.length !== CODE_LENGTH) return null;
  for (const character of cleaned) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }

  return cleaned;
}

/**
 * A fresh code, drawn from `random` (0 ≤ r < 1).
 *
 * Takes its randomness as an argument so a test can pin it: the alphabet rule is
 * the thing worth testing, not the platform's random generator.
 */
export function codeFrom(random: () => number): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const pick = Math.floor(random() * CODE_ALPHABET.length);
    code += CODE_ALPHABET[Math.min(pick, CODE_ALPHABET.length - 1)];
  }
  return code;
}

/** The code as it is printed and shown: two groups, which is easier to read out. */
export function formatJoinCode(code: string): string {
  const normalised = parseJoinCode(code) ?? code.toUpperCase();
  return `${normalised.slice(0, 4)}-${normalised.slice(4)}`;
}

/**
 * The link a QR code carries.
 *
 * Plain HTTPS with no custom scheme on purpose: a farmer without the app yet
 * lands on the site, signs in, and the join is still waiting in the URL. A
 * `farmer://` scheme would only work for someone who already installed it, which
 * is the opposite of what a sticker in a shop window is for.
 */
export function joinLink(code: string, origin: string): string {
  const normalised = parseJoinCode(code);
  if (!normalised) throw new Error('A join code is 8 characters from the shop alphabet.');

  const base = origin.replace(/\/+$/, '');
  return `${base}/?${JOIN_PARAM}=${normalised}`;
}

/** The join code waiting in a URL, if any. */
export function joinCodeFromUrl(href: string): string | null {
  try {
    return parseJoinCode(new URL(href).searchParams.get(JOIN_PARAM));
  } catch {
    return null;
  }
}
