import { describe, expect, it } from 'vitest';
import {
  clearShopCredential,
  hydrateShopCredential,
  loadShopCredential,
  saveShopCredential,
  serialiseShopCredential,
  type ShopCredential,
} from './credential';

const credential: ShopCredential = {
  token: 'a'.repeat(64),
  farmerId: 'farmer-1',
  shopId: 'shop-1',
  shopName: 'Al-Madina Agriculture Store',
  joinedAt: 1_700_000_000_000,
};

describe('shop credential', () => {
  it('round-trips through storage', () => {
    expect(hydrateShopCredential(serialiseShopCredential(credential))).toEqual(credential);
  });

  it('keeps the credential through a real save and load', () => {
    saveShopCredential(credential);
    expect(loadShopCredential()).toEqual(credential);
    clearShopCredential();
    expect(loadShopCredential()).toBeNull();
  });

  it('refuses half a credential instead of rendering a conversation nobody owns', () => {
    const half = JSON.parse(serialiseShopCredential(credential)) as Record<string, unknown>;
    delete half.shopId;
    expect(hydrateShopCredential(JSON.stringify(half))).toBeNull();
  });

  it('refuses a token that cannot be one, and an older document', () => {
    expect(hydrateShopCredential(JSON.stringify({ ...credential, version: 1, token: 'short' }))).toBeNull();
    expect(hydrateShopCredential(JSON.stringify({ ...credential, version: 0 }))).toBeNull();
    expect(hydrateShopCredential('not json')).toBeNull();
    expect(hydrateShopCredential(null)).toBeNull();
  });

  it('survives a stored shop name that is missing', () => {
    const withoutName = JSON.parse(serialiseShopCredential(credential)) as Record<string, unknown>;
    delete withoutName.shopName;
    expect(hydrateShopCredential(JSON.stringify(withoutName))?.shopName).toBe('');
  });
});
