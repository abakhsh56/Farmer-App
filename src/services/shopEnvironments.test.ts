import { describe, expect, it } from 'vitest';
import { resolveShopEnvironment } from './shopEnvironments';

/**
 * Which shop project a build talks to.
 *
 * This is the whole point of the table, and it is the one thing a mistake here
 * would make invisible: a development build pointed at the production shop would
 * look exactly like a working one until a farmer's message landed in a live shop's
 * conversation.
 */
describe('shop environments', () => {
  it('sends development and staging to the staging shop project', () => {
    for (const name of ['dev', 'staging']) {
      const resolved = resolveShopEnvironment(name);
      expect(resolved?.shopApi.url).toContain('bpybjrjenwccowvtrevu');
      expect(resolved?.marketplace.url).toBe(resolved?.shopApi.url);
    }
  });

  it('sends production to the production shop project', () => {
    const resolved = resolveShopEnvironment('production');
    expect(resolved?.shopApi.url).toContain('gkswcfljxlutkfdvvqng');
    expect(resolved?.marketplace.url).toBe(resolved?.shopApi.url);
  });

  it('treats an unnamed environment as pre-production', () => {
    // `npm run build` in CI names no environment; it must not reach live shops.
    expect(resolveShopEnvironment(null)?.shopApi.url).toContain('bpybjrjenwccowvtrevu');
  });

  it('resolves nothing for the test run, so the suite stays offline', () => {
    expect(resolveShopEnvironment('test')).toBeNull();
  });
});
