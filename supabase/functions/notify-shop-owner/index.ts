/**
 * Tells a shop owner's phone that something happened at their shop.
 *
 *   POST /notify-shop-owner  { dealer_id, title, body, data? }
 *
 * Called server-to-server — by a trigger on `dealer_farmer_links` when a farmer
 * joins, or by the messaging path when one writes — never by a client. A client
 * that could call this could notify any shop in the app, so the caller must prove
 * it is the database.
 *
 * That proof is `SHOP_PUSH_TOKEN`, a secret generated for exactly this hop and
 * shared with the trigger through Vault. It is deliberately *not* the service-role
 * key: the service-role key opens every table in the project, and one caller does
 * not need the whole building to post a notification. The token is only ever
 * compared here, so a leak of it costs a forged push, not the database.
 *
 * Delivery is FCM HTTP v1, which is what both platforms take: Android natively,
 * iOS through APNs linked inside the Firebase project. The service account is
 * read from `FCM_SERVICE_ACCOUNT` (the JSON key, as one line) and the token is
 * signed here with WebCrypto, so no vendor SDK and no legacy server key.
 *
 * When nothing is configured the function says so — `503 not-configured` — rather
 * than reporting a delivery that did not happen. A shop that reads the app is a
 * working shop; a shop told a notification was sent when it was not is not.
 *
 * Tokens the provider reports as gone are deleted: an uninstalled phone would
 * otherwise be retried on every join forever.
 */

type Payload = {
  dealer_id?: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CALLER_PROOF = Deno.env.get('SHOP_PUSH_TOKEN') ?? '';
const SERVICE_ACCOUNT = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '';
const PROJECT_ID = Deno.env.get('FCM_PROJECT_ID') ?? '';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The function is never loaded by a browser; a CORS policy would only
      // advertise it to one.
      'Access-Control-Allow-Origin': 'null',
    },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encoder = new TextEncoder();

/** A service-account access token, signed with this service, valid for an hour. */
async function accessToken(account: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(
    encoder.encode(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  );

  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(`${header}.${claims}`),
  );

  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) throw new Error('token_refused');

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('token_missing');
  return body.access_token;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ error: 'not-configured' }, 503);

  /* Server-to-server only: the trigger's shared token is the caller's proof. */
  if (!CALLER_PROOF) return json({ error: 'not-configured', missing: ['SHOP_PUSH_TOKEN'] }, 503);

  const authorization = request.headers.get('Authorization') ?? '';
  if (authorization !== `Bearer ${CALLER_PROOF}`) return json({ error: 'forbidden' }, 403);

  const payload = (await request.json().catch(() => null)) as Payload | null;
  if (!payload?.dealer_id || !payload.title) return json({ error: 'dealer_id-required' }, 400);

  if (!SERVICE_ACCOUNT || !PROJECT_ID) {
    return json({ error: 'not-configured', missing: ['FCM_SERVICE_ACCOUNT', 'FCM_PROJECT_ID'] }, 503);
  }

  /* The shop's party, then that party's phones. Two reads, because the party is
     the account and the tokens are the devices it has signed in on. */
  const dealer = await fetch(
    `${SUPABASE_URL}/rest/v1/dealer_profiles?id=eq.${encodeURIComponent(payload.dealer_id)}&select=party_id`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
  ).then((response) => response.json() as Promise<Array<{ party_id: string | null }>>);

  const partyId = dealer[0]?.party_id;
  if (!partyId) return json({ sent: 0, reason: 'shop-has-no-account' });

  const tokens = await fetch(
    `${SUPABASE_URL}/rest/v1/device_push_tokens?party_id=eq.${partyId}&revoked_at=is.null&select=id,token`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
  ).then((response) => response.json() as Promise<Array<{ id: string; token: string }>>);

  if (tokens.length === 0) return json({ sent: 0, reason: 'no-devices' });

  let account: { client_email: string; private_key: string };
  try {
    account = JSON.parse(SERVICE_ACCOUNT);
  } catch {
    return json({ error: 'fcm-service-account-unreadable' }, 503);
  }

  let bearer: string;
  try {
    bearer = await accessToken(account);
  } catch {
    return json({ error: 'fcm-auth-failed' }, 502);
  }

  let sent = 0;
  const dead: string[] = [];

  for (const device of tokens) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: device.token,
          notification: { title: payload.title, body: payload.body ?? '' },
          data: payload.data ?? {},
          android: { priority: 'HIGH' },
          apns: { headers: { 'apns-priority': '10' } },
        },
      }),
    });

    if (response.ok) {
      sent += 1;
      continue;
    }

    /* 404 and 400/UNREGISTERED both mean the install is gone. */
    if (response.status === 404) dead.push(device.id);
    else {
      const text = await response.text().catch(() => '');
      if (/UNREGISTERED|INVALID_ARGUMENT/.test(text)) dead.push(device.id);
    }
  }

  if (dead.length > 0) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/device_push_tokens?id=in.(${dead.map(encodeURIComponent).join(',')})`,
      {
        method: 'DELETE',
        headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
      },
    );
  }

  return json({ sent, devices: tokens.length, removed: dead.length });
});
