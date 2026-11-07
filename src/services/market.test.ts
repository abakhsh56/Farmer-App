import { describe, expect, it } from 'vitest';
import { isTodayRate, mandiSourceKind, maundPrice } from './market';
import { mandiTiles } from '../components/MandiRatesCard';
import type { MarketRate } from './types';

/**
 * Mandi rates, honestly dated and honestly converted.
 *
 * AMIS reports per 100 kg; the farmer reads per 40 kg maund. A rate from
 * another day is never today's number, and a missing price is never zero.
 */

const NOW = new Date('2026-11-07T10:00:00').getTime();

function rate(over: Partial<MarketRate> = {}): MarketRate {
  return {
    commodity: 'wheat',
    nameEn: 'Wheat',
    nameKey: 'crop.wheat',
    unit: '40kg',
    marketName: 'Wazirabad',
    district: 'Gujranwala',
    observedOn: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(),
    minPrice: 3900,
    maxPrice: 4050,
    modalPrice: 3980,
    currency: 'PKR',
    sourceLabel: 'AMIS Punjab',
    ...over,
  };
}

describe('maundPrice', () => {
  it('shows a per-40-kg price as it is', () => {
    expect(maundPrice(rate({ modalPrice: 3980, unit: '40kg' }))).toBe(3980);
  });

  it('divides a per-100-kg AMIS price by 2.5 for the maund', () => {
    expect(maundPrice(rate({ modalPrice: 9950, unit: '100kg' }))).toBe(3980);
  });

  it('never turns a missing price into zero', () => {
    expect(maundPrice(rate({ modalPrice: null }))).toBeNull();
  });

  it('never guesses a conversion for an unrecognised unit', () => {
    expect(maundPrice(rate({ modalPrice: 3980, unit: 'per bag' }))).toBeNull();
  });
});

describe('isTodayRate', () => {
  it('is true for a rate observed today', () => {
    expect(isTodayRate(rate(), NOW)).toBe(true);
  });

  it('is false for a rate observed yesterday', () => {
    expect(isTodayRate(rate({ observedOn: new Date(NOW - 26 * 60 * 60 * 1000).toISOString() }), NOW)).toBe(false);
  });
});

describe('mandiSourceKind', () => {
  it('reads AMIS as the government source and community as local', () => {
    expect(mandiSourceKind('AMIS Punjab')).toBe('govt');
    expect(mandiSourceKind('Community local')).toBe('community');
    expect(mandiSourceKind('Research feed')).toBe('other');
  });
});

describe('mandiTiles', () => {
  it('shows today’s quotable rates and says no rate today for the rest', () => {
    const rates = [
      rate({ commodity: 'cotton', nameEn: 'Cotton', modalPrice: 8300 }),
      rate({ commodity: 'wheat', nameEn: 'Wheat', modalPrice: 3980 }),
      /* Maize was observed five days ago: stale, so its tile is honest. */
      rate({
        commodity: 'maize',
        nameEn: 'Maize',
        modalPrice: 2820,
        observedOn: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const tiles = mandiTiles(rates, NOW);
    expect(tiles.map((tile) => tile.commodity)).toEqual(['cotton', 'wheat', 'maize']);
    expect(tiles[0]?.pricePerMaund).toBe(8300);
    expect(tiles[1]?.pricePerMaund).toBe(3980);
    expect(tiles[2]?.pricePerMaund).toBeNull();
  });

  it('never shows yesterday’s number as today’s, even inside the 36-hour window', () => {
    const rates = [
      rate({
        commodity: 'wheat',
        modalPrice: 3980,
        observedOn: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const tiles = mandiTiles(rates, NOW);
    expect(tiles.find((tile) => tile.commodity === 'wheat')?.pricePerMaund).toBeNull();
  });

  it('converts a per-100-kg AMIS rate to the maund on the tile', () => {
    const rates = [rate({ commodity: 'cotton', modalPrice: 20750, unit: '100kg' })];
    const tiles = mandiTiles(rates, NOW);
    expect(tiles.find((tile) => tile.commodity === 'cotton')?.pricePerMaund).toBe(8300);
  });
});
