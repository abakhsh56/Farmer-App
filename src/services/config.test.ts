/**
 * The gateway switch, as configuration.
 *
 * The providers already switch on these flags — the registry picks the Supabase
 * repository, market and dealer providers the moment `supabase.configured` is
 * true. What the assistant was still waiting on was its own endpoint: the AI
 * gateway lives on the same project as the database, so its URL is derived from
 * the Supabase URL exactly like the voice endpoint, instead of needing a second
 * variable that is easy to forget on a deployment. Forgetting it left the
 * assistant and the scan diagnosis on the scripted development provider even
 * with a backend configured — which is the defect these tests pin.
 */

import { describe, expect, it } from 'vitest';
import { buildServiceConfig } from './config';
import { createServices } from './registry';
import { DevelopmentAiProvider } from './providers/develop';
import { RemoteAiProvider } from './providers/remote';

type Env = Parameters<typeof buildServiceConfig>[0];

function env(overrides: Record<string, string | undefined> = {}): Env {
  return {
    VITE_SUPABASE_URL: undefined,
    VITE_SUPABASE_ANON_KEY: undefined,
    VITE_AI_ENDPOINT: undefined,
    VITE_OTP_ENDPOINT: undefined,
    VITE_DEALER_ENDPOINT: undefined,
    VITE_WEATHER_INGEST_ENDPOINT: undefined,
    VITE_WEATHER_PROVIDER: undefined,
    VITE_ANALYTICS_KEY: undefined,
    VITE_POSTHOG_KEY: undefined,
    VITE_POSTHOG_HOST: undefined,
    ...overrides,
  };
}

const BACKEND = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon',
};

describe('AI gateway derivation', () => {
  it('derives the AI gateway URL from the Supabase URL when no endpoint is named', () => {
    const config = buildServiceConfig(env(BACKEND));

    expect(config.supabase.configured).toBe(true);
    expect(config.aiEndpoint).toEqual({
      url: 'https://example.supabase.co/functions/v1/ai',
      configured: true,
    });
  });

  it('an explicit AI endpoint wins over the derivation', () => {
    const config = buildServiceConfig(
      env({ ...BACKEND, VITE_AI_ENDPOINT: 'https://gateway.example.invalid/ai' }),
    );

    expect(config.aiEndpoint).toEqual({
      url: 'https://gateway.example.invalid/ai',
      configured: true,
    });
  });

  it('no backend means no AI gateway', () => {
    const config = buildServiceConfig(env());

    expect(config.supabase.configured).toBe(false);
    expect(config.aiEndpoint).toEqual({ url: null, configured: false });
  });

  it('a trailing slash on the project URL does not double the slash', () => {
    const config = buildServiceConfig(
      env({ ...BACKEND, VITE_SUPABASE_URL: 'https://example.supabase.co///' }),
    );

    expect(config.aiEndpoint.url).toBe('https://example.supabase.co/functions/v1/ai');
    expect(config.speakEndpoint.url).toBe('https://example.supabase.co/functions/v1/speak');
  });

  it('the voice endpoint is still derived the same way', () => {
    const config = buildServiceConfig(env(BACKEND));

    expect(config.speakEndpoint).toEqual({
      url: 'https://example.supabase.co/functions/v1/speak',
      configured: true,
    });
  });
});

describe('weather default', () => {
  it('still defaults to the live vendor when no provider is named', () => {
    // Deliberate, not an oversight: the normalised table is empty until
    // weather ingestion runs, so `supabase` is an explicit choice. The vendor
    // is live data, not a fixture — the app must not go silent on weather
    // while ingestion is parked.
    const config = buildServiceConfig(env(BACKEND));

    expect(config.weather.provider).toBe('open-meteo');
  });

  it('an explicit provider is still honoured', () => {
    const config = buildServiceConfig(env({ ...BACKEND, VITE_WEATHER_PROVIDER: 'supabase' }));

    expect(config.weather.provider).toBe('supabase');
  });
});

describe('registry selection from a derived config', () => {
  it('picks the server AI gateway once a backend is configured', () => {
    const services = createServices(buildServiceConfig(env(BACKEND)));

    expect(services.ai).toBeInstanceOf(RemoteAiProvider);
    expect(services.ai.name).toBe('Server AI gateway');
    expect(services.anyRemote).toBe(true);
  });

  it('stays on the scripted assistant with no backend', () => {
    const services = createServices(buildServiceConfig(env()));

    expect(services.ai).toBeInstanceOf(DevelopmentAiProvider);
    expect(services.ai.name).toContain('Development');
    expect(services.anyRemote).toBe(false);
  });
});
