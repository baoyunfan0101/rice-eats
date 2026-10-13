import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPoiCache,
  distanceText,
  geoapifyUrl,
  MAX_TILES,
  normalizeGeoapify,
  PoiError,
  restaurantsInArea,
  searchRestaurants,
  tilesFor,
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

  it('searches a rectangle with a larger limit for map tiles', () => {
    const url = new URL(
      geoapifyUrl(
        { bounds: { south: 29.71, west: -95.41, north: 29.72, east: -95.4 }, limit: 100 },
        'k1',
      ),
    );
    expect(url.searchParams.get('filter')).toBe('rect:-95.410000,29.710000,-95.400000,29.720000');
    expect(url.searchParams.get('bias')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('100');
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

describe('map tiles', () => {
  it('covers an area with fixed tiles, aligned so panning reuses them', () => {
    const tiles = tilesFor({ south: 29.7134, west: -95.4078, north: 29.7214, east: -95.3958 })!;
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toEqual({ south: 29.71, north: 29.72, west: -95.41, east: -95.4 });
    expect(tiles.at(-1)).toEqual({ south: 29.72, north: 29.73, west: -95.4, east: -95.39 });
    // A slightly moved view inside the same tiles needs the same tiles.
    expect(tilesFor({ south: 29.7135, west: -95.4077, north: 29.7215, east: -95.3959 })).toEqual(
      tiles,
    );
  });

  it('refuses areas that would need too many tiles', () => {
    expect(tilesFor({ south: 29.6, west: -95.6, north: 29.8, east: -95.2 })).toBeUndefined();
    const side = Math.floor(Math.sqrt(MAX_TILES));
    expect(
      tilesFor({
        south: 0.0001,
        west: 0.0001,
        north: side / 100 - 0.0001,
        east: side / 100 - 0.0001,
      }),
    ).toHaveLength(side * side);
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

  it('merges the tiles of an area and caches each tile', async () => {
    fetchMock.mockImplementation(async (input) => {
      const filter = new URL(String(input)).searchParams.get('filter')!;
      const [w, south] = filter.slice(5).split(',').map(Number) as [number, number];
      return Response.json({
        features: [
          feature({ place_id: 'shared', name: 'Shared', lat: 29.715, lon: -95.405 }),
          feature({ place_id: `t${w}${south}`, name: 'Tile', lat: south + 0.005, lon: w + 0.005 }),
        ],
      });
    });
    const bounds = { south: 29.712, west: -95.408, north: 29.722, east: -95.398 };
    const first = await restaurantsInArea(bounds);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(first.filter((c) => c.poiId === 'shared')).toHaveLength(1);
    expect(first).toHaveLength(5);
    await restaurantsInArea(bounds);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
