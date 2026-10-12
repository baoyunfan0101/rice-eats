import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPoiCache,
  distanceText,
  geoapifyUrl,
  normalizeGeoapify,
  PoiError,
  searchRestaurants,
} from './poi';

const center = { lat: 29.717, lng: -95.402 };
const feature = (properties: Record<string, unknown>) => ({ type: 'Feature', properties });

describe('Geoapify requests', () => {
  it('searches restaurant categories in a circle, nearest first', () => {
    const url = new URL(geoapifyUrl({ center, radiusMeters: 300 }, 'k1'));
    expect(url.origin + url.pathname).toBe('https://api.geoapify.com/v2/places');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      categories: 'catering.restaurant,catering.fast_food,catering.cafe,catering.food_court',
      filter: 'circle:-95.402000,29.717000,300',
      bias: 'proximity:-95.402000,29.717000',
      limit: '30',
      apiKey: 'k1',
    });
  });

  it('adds a trimmed name filter', () => {
    const url = new URL(geoapifyUrl({ center, radiusMeters: 5000, name: ' 河粉 ' }, 'k1'));
    expect(url.searchParams.get('name')).toBe('河粉');
  });
});

describe('normalizing places', () => {
  it('keeps named places with valid coordinates, deduplicated and sorted by distance', () => {
    const candidates = normalizeGeoapify(
      {
        features: [
          feature({
            place_id: 'far',
            name: 'Far',
            lat: 29.73,
            lon: -95.402,
            address_line2: '2 B St',
          }),
          feature({ place_id: 'near', name: ' Near ', lat: 29.7171, lon: -95.4021, distance: 15 }),
          feature({ place_id: 'near', name: 'Near again', lat: 29.7171, lon: -95.4021 }),
          feature({ place_id: 'nameless', lat: 29.717, lon: -95.402 }),
          feature({ place_id: 'bad', name: 'Bad', lat: 120, lon: -95.4 }),
          feature({ name: 'No id', lat: 29.717, lon: -95.402 }),
          { properties: null },
        ],
      },
      center,
    );
    expect(candidates.map((c) => c.poiId)).toEqual(['near', 'far']);
    expect(candidates[0]).toEqual({
      key: 'geoapify:near',
      provider: 'geoapify',
      poiId: 'near',
      name: 'Near',
      location: { lat: 29.7171, lng: -95.4021 },
      distance: 15,
    });
    expect(candidates[1]!.address).toBe('2 B St');
    expect(candidates[1]!.distance).toBeGreaterThan(1400);
  });

  it('tolerates unexpected bodies', () => {
    expect(normalizeGeoapify(null)).toEqual([]);
    expect(normalizeGeoapify({ features: 'x' })).toEqual([]);
  });

  it('describes distances', () => {
    expect(distanceText(123)).toBe('120 米');
    expect(distanceText(1)).toBe('1 米');
    expect(distanceText(1234)).toBe('1.2 公里');
    expect(distanceText(undefined)).toBeUndefined();
  });
});

describe('searching', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    clearPoiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('requires a configured key', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    await expect(searchRestaurants({ center, radiusMeters: 300 })).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches successful searches', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        features: [feature({ place_id: 'a', name: 'A', lat: 29.717, lon: -95.402 })],
      }),
    );
    const first = await searchRestaurants({ center, radiusMeters: 300 });
    const second = await searchRestaurants({ center, radiusMeters: 300 });
    expect(first.map((c) => c.name)).toEqual(['A']);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'quota'],
    [403, 'quota'],
    [429, 'quota'],
    [500, 'failed'],
  ])('maps HTTP %i to %s and does not cache it', async (status, kind) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    const error = await searchRestaurants({ center, radiusMeters: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(PoiError);
    expect(error.kind).toBe(kind);
    fetchMock.mockResolvedValue(Response.json({ features: [] }));
    await expect(searchRestaurants({ center, radiusMeters: 300 })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports network errors and passes cancellation through', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(searchRestaurants({ center, radiusMeters: 300 })).rejects.toMatchObject({
      kind: 'network',
    });
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    await expect(
      searchRestaurants({ center, radiusMeters: 300 }, AbortSignal.abort()),
    ).rejects.toBe(abort);
  });
});
