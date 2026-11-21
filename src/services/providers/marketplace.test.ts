import { afterEach, describe, expect, it } from 'vitest';
import { MarketplaceDealerProvider } from './marketplace';

/**
 * The marketplace has no listings published right now, so its mapping cannot be
 * proven against production. These tests prove it against rows in the API's own
 * shape instead — branch folding, price, distance and the three-state stock rule —
 * which is what the Shop tab will rely on the day a branch publishes.
 */

type Row = Record<string, unknown>;

const CONFIG = { url: 'https://market.example', key: 'anon-key', configured: true };

function listing(overrides: Row = {}): Row {
  return {
    listing_id: 'l1',
    branch_id: 'b1',
    branch_name: 'Baba jaani',
    branch_address: null,
    branch_latitude: 31.5204,
    branch_longitude: 74.3587,
    branch_location_label: 'Lahore',
    product_id: 'p1',
    product_name: 'Lambda arc',
    category: 'pesticide',
    image_url: null,
    variant_id: 'v1',
    variant_label: '1 Liter',
    unit_size: 1,
    qty_step: 1,
    base_unit: 'litre',
    selling_price: 750,
    availability: 'available',
    listed_at: '2026-11-21T10:00:00Z',
    updated_at: '2026-11-21T10:00:00Z',
    ...overrides,
  };
}

/** The stub of the test in flight, so a failed assertion cannot leak it onward. */
let restoreFetch: (() => void) | null = null;

function stubFetch(respond: (url: string, body: unknown) => { status: number; payload: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const { status, payload } = respond(url, body);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;

  const restore = () => void (globalThis.fetch = original);
  restoreFetch = restore;
  return { calls, restore };
}

const ORIGIN = { lat: 31.5204, lon: 74.3587 };

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe('the marketplace dealer provider', () => {
  it('folds listings of one branch into one shop, keeping the nearest distance', async () => {
    const rows = [
      listing({ listing_id: 'a1', branch_id: 'near', branch_name: 'Baba jaani', distance_km: 0.2 }),
      listing({ listing_id: 'a2', branch_id: 'near', branch_name: 'Baba jaani', distance_km: 0.9, category: 'seed' }),
      listing({ listing_id: 'b1', branch_id: 'far', branch_name: 'Kisan Store', distance_km: 6.4 }),
    ];
    const stub = stubFetch(() => ({ status: 200, payload: rows }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.search({ radiusKm: 25, origin: ORIGIN });
    stub.restore();

    expect(result.status).toBe('live');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ id: 'near', name: 'Baba jaani', distanceKm: 0.2 });
    /* No shop carries the verified mark, because the marketplace publishes none. */
    expect(result.data[0]?.verifiedAt).toBeNull();
    expect([...(result.data[0]?.tags ?? [])].sort()).toEqual(['pesticide', 'seed']);
    /* Nearest first is the API's order, preserved rather than re-sorted. */
    expect(result.data.map((shop) => shop.id)).toEqual(['near', 'far']);
    expect(stub.calls[0]?.body).toMatchObject({ p_latitude: ORIGIN.lat, p_radius_km: 25 });
  });

  it('reads one branch by id and keeps unknown stock unknown', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      payload: [listing(), listing({ listing_id: 'l2', product_name: 'Urea', selling_price: null, variant_label: '50 kg' })],
    }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.products('b1');
    stub.restore();

    expect(stub.calls[0]?.url).toContain('branch_id=eq.b1');
    expect(result.data[0]).toMatchObject({
      name: 'Lambda arc',
      packSize: '1 Liter',
      unitPrice: 750,
      currency: 'PKR',
      availableQty: null,
      inStock: true,
      syncState: 'fresh',
    });
    /* A listing without a price stays without one; it is never zero. */
    expect(result.data[1]?.unitPrice).toBeNull();
    expect(result.data[1]?.packSize).toBe('50 kg');
  });

  it('keeps the same product at two branches as two rows with their own prices', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      payload: [
        listing({ listing_id: 'a1', branch_id: 'b1', branch_name: 'Baba jaani', distance_km: 0.2, selling_price: 750 }),
        listing({ listing_id: 'a2', branch_id: 'b2', branch_name: 'Kisan Store', distance_km: 4.1, selling_price: 820 }),
      ],
    }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.searchProducts({ radiusKm: 25, origin: ORIGIN, query: 'lambda' });
    stub.restore();

    expect(stub.calls[0]?.body).toMatchObject({ p_query: 'lambda', p_category: null });
    expect(result.data).toHaveLength(2);
    expect(result.data.map((hit) => [hit.dealerId, hit.product.unitPrice])).toEqual([
      ['b1', 750],
      ['b2', 820],
    ]);
  });

  it('measures distance from published coordinates when reading stockists', async () => {
    /* ~1.1 km north of the origin, and ~11 km north of it. */
    const stub = stubFetch(() => ({
      status: 200,
      payload: [
        listing({ listing_id: 'a1', branch_id: 'close', branch_latitude: 31.5304, branch_longitude: 74.3587 }),
        listing({ listing_id: 'a2', branch_id: 'outside', branch_latitude: 31.6204, branch_longitude: 74.3587 }),
      ],
    }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.stockists({ canonicalProductId: 'p1', radiusKm: 5, origin: ORIGIN });
    stub.restore();

    expect(stub.calls[0]?.url).toContain('product_id=eq.p1');
    expect(result.data.map((row) => row.dealerId)).toEqual(['close']);
    expect(result.data[0]?.distanceKm).toBeGreaterThan(1);
    expect(result.data[0]?.distanceKm).toBeLessThan(1.2);
  });

  it('reports a refused key as a failed read, once', async () => {
    const stub = stubFetch(() => ({
      status: 401,
      payload: { message: 'permission denied for function search_marketplace' },
    }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.search({ radiusKm: 25, origin: ORIGIN });
    stub.restore();

    expect(result.status).toBe('failing');
    expect(result.data).toEqual([]);
    expect(result.error).toContain('refused');
    expect(stub.calls).toHaveLength(1);
  });

  it('treats an empty answer as a live answer, not a failure', async () => {
    const stub = stubFetch(() => ({ status: 200, payload: [] }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.search({ radiusKm: 25, origin: ORIGIN });
    stub.restore();

    expect(result.status).toBe('live');
    expect(result.data).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('refuses to search without an area, without calling the API', async () => {
    const stub = stubFetch(() => ({ status: 200, payload: [] }));
    const provider = new MarketplaceDealerProvider(CONFIG);

    const result = await provider.search({ radiusKm: 25 });
    stub.restore();

    expect(result.status).toBe('failing');
    expect(stub.calls).toHaveLength(0);
  });
});
