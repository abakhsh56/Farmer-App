import { describe, expect, it } from 'vitest';
import { backendFor, resolveAppBackend } from './appEnvironments';

describe('resolveAppBackend', () => {
  it('sends a production build to the production project', () => {
    const choice = resolveAppBackend('production');
    expect(choice.source).toBe('environment');
    expect(choice.source === 'environment' && choice.backend.url).toBe(
      'https://swmbmtvwgksicfnfsehg.supabase.co',
    );
  });

  it('sends a staging build to the staging project', () => {
    const choice = resolveAppBackend('staging');
    expect(choice.source).toBe('environment');
    expect(choice.source === 'environment' && choice.backend.url).toBe(
      'https://zmyvkwijloqylvftvhvq.supabase.co',
    );
  });

  it('never lets the two environments share a project', () => {
    const staging = backendFor('staging');
    const production = backendFor('production');
    expect(staging).not.toBeNull();
    expect(production).not.toBeNull();
    expect(staging?.url).not.toBe(production?.url);
    expect(staging?.key).not.toBe(production?.key);
  });

  it('leaves dev to the developer machine rather than a shared project', () => {
    expect(resolveAppBackend('dev')).toEqual({ source: 'configured' });
  });

  it('gives the suite no backend at all', () => {
    expect(resolveAppBackend('test')).toEqual({ source: 'local' });
  });

  it('does not guess an environment for an unlabelled build', () => {
    expect(resolveAppBackend(undefined)).toEqual({ source: 'local' });
    expect(resolveAppBackend('')).toEqual({ source: 'local' });
    expect(resolveAppBackend('prod')).toEqual({ source: 'local' });
  });

  it('commits only publishable keys, never a secret key', () => {
    for (const env of ['staging', 'production'] as const) {
      const key = backendFor(env)?.key ?? '';
      expect(key.length).toBeGreaterThan(20);
      expect(key.startsWith('sb_secret_')).toBe(false);
      // The publishable key of the new platform, or the legacy anon JWT: both are
      // safe to ship, and neither is the service-role credential.
      expect(key.startsWith('sb_publishable_') || key.startsWith('eyJ')).toBe(true);
    }
  });
});
