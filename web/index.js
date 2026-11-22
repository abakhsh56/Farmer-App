/**
 * The app's static host.
 *
 * Every environment serves the same build; the differences are baked in at build
 * time (`VITE_APP_ENV`, the OTA channel) rather than switched here, because a
 * runtime switch is a thing a phone could disagree about.
 *
 * The only job of this file is to answer from the asset store and to send an
 * unknown path to `index.html`: the app is a single page with client-side
 * navigation, so `/dealers` is not a file and a 404 there would break a deep link
 * a farmer followed from a shop's message.
 */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);

    if (response.status !== 404 || request.method !== 'GET') return response;

    const url = new URL(request.url);
    /* An asset that is genuinely missing must stay missing: only page paths fall back. */
    if (/\.[a-z0-9]+$/i.test(url.pathname)) return response;

    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  },
};
