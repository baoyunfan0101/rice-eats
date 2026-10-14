import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPoiCache,
  distanceText,
  geoapifyUrl,
  MAX_TILES,
  normalizeGeoapify,
  normalizeOverpass,
  OVERPASS_ENDPOINT,
  overpassQuery,
  PoiError,
  restaurantsInArea,
  searchRestaurants,
  setOverpassRetryDelay,
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

  it('describes distances in miles', () => {
    expect(distanceText(20)).toBe('<0.1 mi');
    expect(distanceText(140)).toBe('0.1 mi');
    expect(distanceText(1609)).toBe('1.0 mi');
    expect(distanceText(1234 * 2)).toBe('1.5 mi');
    expect(distanceText(30000)).toBe('19 mi');
    expect(distanceText(undefined)).toBeUndefined();
  });
});

describe('OpenStreetMap Overpass', () => {
  it('queries named restaurants in a tile, with centers for buildings', () => {
    expect(
      overpassQuery({
        bounds: { south: 29.71, west: -95.41, north: 29.72, east: -95.4 },
        limit: 100,
      }),
    ).toBe(
      '[out:json][timeout:20];nwr["amenity"~"^(restaurant|fast_food|cafe|food_court)$"]["name"]' +
        '(29.710000,-95.410000,29.720000,-95.400000);out center 100;',
    );
  });

  it('searches names case-insensitively with regex characters escaped', () => {
    expect(overpassQuery({ center, radiusMeters: 5000, name: ' Pho "1" (Rice) ' })).toContain(
      '["name"~"Pho \\"1\\" \\\\(Rice\\\\)",i](around:5000,29.717000,-95.402000)',
    );
  });

  it('normalizes nodes and ways, with street addresses', () => {
    const found = normalizeOverpass(
      {
        elements: [
          {
            type: 'way',
            id: 12,
            center: { lat: 29.73, lon: -95.402 },
            tags: { name: 'Far Way', 'addr:housenumber': '6100', 'addr:street': 'Main St' },
          },
          { type: 'node', id: 3, lat: 29.7171, lon: -95.4021, tags: { name: ' Near ' } },
          { type: 'node', id: 3, lat: 29.7171, lon: -95.4021, tags: { name: 'Near again' } },
          { type: 'node', id: 4, lat: 29.7171, lon: -95.4021, tags: {} },
          { type: 'node', id: 5, lat: 120, lon: -95.4, tags: { name: 'Bad' } },
        ],
      },
      center,
    );
    expect(found.map((c) => c.key)).toEqual(['osm:node/3', 'osm:way/12']);
    expect(found[0]).toMatchObject({ name: 'Near', provider: 'osm', poiId: 'node/3' });
    expect(found[1]).toMatchObject({
      address: '6100 Main St',
      location: { lat: 29.73, lng: -95.402 },
    });
    expect(normalizeOverpass({})).toEqual([]);
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
    setOverpassRetryDelay(0);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const overpassBody = {
    elements: [{ type: 'node', id: 7, lat: 29.7171, lon: -95.4021, tags: { name: 'OSM Place' } }],
  };
  const isOverpass = (input: unknown) => String(input) === OVERPASS_ENDPOINT;

  it('uses OpenStreetMap Overpass when there is no key', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    fetchMock.mockResolvedValue(Response.json(overpassBody));
    const found = await searchRestaurants({ center, radiusMeters: 300 });
    expect(found).toMatchObject([{ key: 'osm:node/7', provider: 'osm', name: 'OSM Place' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OVERPASS_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('around%3A300');
  });

  it('falls back to Overpass when Geoapify is out of credits, and stops asking Geoapify', async () => {
    fetchMock.mockImplementation(async (input) =>
      isOverpass(input) ? Response.json(overpassBody) : new Response('', { status: 429 }),
    );
    const first = await searchRestaurants({ center, radiusMeters: 300 });
    expect(first.map((c) => c.provider)).toEqual(['osm']);
    await searchRestaurants({ center, radiusMeters: 1000 });
    const geoapifyCalls = fetchMock.mock.calls.filter(([u]) => !isOverpass(u));
    expect(geoapifyCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to Overpass once when a Geoapify request fails', async () => {
    fetchMock.mockImplementation(async (input) =>
      isOverpass(input) ? Response.json(overpassBody) : new Response('', { status: 500 }),
    );
    await searchRestaurants({ center, radiusMeters: 300 });
    await searchRestaurants({ center, radiusMeters: 1000 });
    // A server error is not a refusal: Geoapify is tried again.
    expect(fetchMock.mock.calls.filter(([u]) => !isOverpass(u))).toHaveLength(2);
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
  ])('maps HTTP %i from both providers to %s and does not cache it', async (status, kind) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    const error = await searchRestaurants({ center, radiusMeters: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(PoiError);
    expect(error.kind).toBe(kind);
    // Geoapify, then Overpass (retried once unless it refused).
    expect(fetchMock).toHaveBeenCalledTimes(kind === 'quota' ? 2 : 3);
    clearPoiCache();
    fetchMock.mockResolvedValue(Response.json({ features: [] }));
    await expect(searchRestaurants({ center, radiusMeters: 300 })).resolves.toEqual([]);
  });

  it('retries a busy Overpass server once', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(Response.json(overpassBody));
    await expect(searchRestaurants({ center, radiusMeters: 300 })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets a caller retry a shared search that another caller cancelled', async () => {
    let calls = 0;
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Promise((resolve, reject) => {
          calls++;
          if (calls === 1) {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          } else resolve(Response.json({ features: [] }));
        }),
    );
    const first = new AbortController();
    const cancelled = searchRestaurants({ center, radiusMeters: 300 }, first.signal);
    const wanted = searchRestaurants({ center, radiusMeters: 300 });
    first.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(wanted).resolves.toEqual([]);
  });

  it('reports network errors and passes cancellation through', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
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

describe('map discovery', () => {
  const fetchMock = vi.fn<typeof fetch>();
  /** Two tiles wide, one tall: (29.71..29.72) x (-95.41..-95.39). */
  const twoTiles = { south: 29.712, west: -95.408, north: 29.718, east: -95.392 };
  const isOverpass = (input: unknown) => String(input) === OVERPASS_ENDPOINT;
  const overpassCalls = () => fetchMock.mock.calls.filter(([u]) => isOverpass(u));
  const geoapifyCalls = () => fetchMock.mock.calls.filter(([u]) => !isOverpass(u));
  const osm = {
    elements: [
      { type: 'node', id: 1, lat: 29.715, lon: -95.405, tags: { name: 'West' } },
      { type: 'node', id: 2, lat: 29.715, lon: -95.395, tags: { name: 'East' } },
    ],
  };
  /** A Geoapify answer with one place in the tile of the request. */
  const geoapifyTile = (input: unknown) => {
    const [w, south] = new URL(String(input)).searchParams
      .get('filter')!
      .slice(5)
      .split(',')
      .map(Number) as [number, number];
    return Response.json({
      features: [feature({ place_id: `g${w}`, name: `G${w}`, lat: south + 0.005, lon: w + 0.005 })],
    });
  };

  beforeEach(() => {
    clearPoiCache();
    setOverpassRetryDelay(0);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('loads each tile from Geoapify, merges shared places, and caches tiles', async () => {
    fetchMock.mockImplementation(async (input) => {
      const body = (await geoapifyTile(input).json()) as { features: unknown[] };
      body.features.push(feature({ place_id: 'shared', name: 'Shared', lat: 29.715, lon: -95.4 }));
      return Response.json(body);
    });
    const first = await restaurantsInArea(twoTiles);
    expect(first).toMatchObject({ failed: 0, total: 2, truncated: false });
    expect(first.candidates.map((c) => c.poiId).sort()).toEqual(['g-95.4', 'g-95.41', 'shared']);
    expect(geoapifyCalls()[0]![0]).toContain('limit=500');
    await restaurantsInArea(twoTiles);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses one Overpass request for an area when there is no key', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    fetchMock.mockResolvedValue(Response.json(osm));
    const found = await restaurantsInArea(twoTiles);
    expect(found.candidates.map((c) => c.name).sort()).toEqual(['East', 'West']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = new URLSearchParams(String(fetchMock.mock.calls[0]![1]?.body)).get('data');
    expect(sent).toContain('(29.710000,-95.410000,29.720000,-95.390000);out center 2000;');
    // A view inside the loaded tiles needs no request.
    await restaurantsInArea({ south: 29.713, west: -95.399, north: 29.717, east: -95.393 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back with a single Overpass request when every tile is refused at once', async () => {
    const wide = { south: 29.712, west: -95.418, north: 29.728, east: -95.382 }; // 8 tiles
    fetchMock.mockImplementation(async (input) =>
      isOverpass(input) ? Response.json(osm) : new Response('', { status: 429 }),
    );
    const found = await restaurantsInArea(wide);
    expect(found).toMatchObject({ failed: 0, total: 8 });
    expect(found.candidates.map((c) => c.provider)).toEqual(['osm', 'osm']);
    expect(geoapifyCalls()).toHaveLength(8);
    expect(overpassCalls()).toHaveLength(1);
    // Refused for the session: the next area skips Geoapify.
    await restaurantsInArea({ south: 29.732, west: -95.408, north: 29.738, east: -95.392 });
    expect(geoapifyCalls()).toHaveLength(8);
    expect(overpassCalls()).toHaveLength(2);
  });

  it('sends only the tiles Geoapify failed to Overpass, in one request', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (isOverpass(input)) return Response.json(osm);
      // The western tile fails (server error), the eastern one loads.
      return decodeURIComponent(String(input)).includes('rect:-95.41')
        ? new Response('', { status: 500 })
        : geoapifyTile(input);
    });
    const found = await restaurantsInArea(twoTiles);
    expect(found.failed).toBe(0);
    expect(found.candidates.map((c) => `${c.provider}:${c.name}`).sort()).toEqual([
      'geoapify:G-95.4',
      'osm:West',
    ]);
    const sent = new URLSearchParams(String(overpassCalls()[0]![1]?.body)).get('data');
    expect(sent).toContain('(29.710000,-95.410000,29.720000,-95.400000)');
    // A server error is not a refusal: Geoapify stays the first choice.
    clearPoiCache();
    await restaurantsInArea(twoTiles);
    expect(geoapifyCalls()).toHaveLength(4);
  });

  it('keeps the tiles that loaded when others fail, and retries only the failed ones', async () => {
    let overpassUp = false;
    fetchMock.mockImplementation(async (input) => {
      if (isOverpass(input))
        return overpassUp ? Response.json(osm) : new Response('', { status: 504 });
      return decodeURIComponent(String(input)).includes('rect:-95.41')
        ? new Response('', { status: 500 })
        : geoapifyTile(input);
    });
    const partial = await restaurantsInArea(twoTiles);
    expect(partial).toMatchObject({ failed: 1, total: 2 });
    expect(partial.error).toBeInstanceOf(PoiError);
    expect(partial.candidates.map((c) => c.name)).toEqual(['G-95.4']);

    overpassUp = true;
    fetchMock.mockClear();
    const retried = await restaurantsInArea(twoTiles);
    expect(retried.failed).toBe(0);
    expect(retried.candidates.map((c) => c.name).sort()).toEqual(['G-95.4', 'West']);
    // The eastern tile came from the cache; only the western one was loaded again.
    expect(geoapifyCalls()).toHaveLength(1);
    expect(decodeURIComponent(String(geoapifyCalls()[0]![0]))).toContain('rect:-95.41');
  });

  it('reports a complete failure without rejecting', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));
    const result = await restaurantsInArea(twoTiles);
    expect(result).toMatchObject({ candidates: [], failed: 2, total: 2 });
    expect(result.error).toMatchObject({ kind: 'quota' });
  });

  it('flags tiles that reach the result limit', async () => {
    fetchMock.mockImplementation(async (input) => {
      const w = Number(new URL(String(input)).searchParams.get('filter')!.slice(5).split(',')[0]);
      const many = w < -95.405 ? 500 : 3;
      return Response.json({
        features: Array.from({ length: many }, (_, i) =>
          feature({ place_id: `${w}-${i}`, name: `P${i}`, lat: 29.715, lon: w + 0.001 }),
        ),
      });
    });
    expect(await restaurantsInArea(twoTiles)).toMatchObject({ truncated: true });
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    clearPoiCache();
    fetchMock.mockResolvedValue(Response.json(osm));
    expect(await restaurantsInArea(twoTiles)).toMatchObject({ truncated: false });
  });
});
