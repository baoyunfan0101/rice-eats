import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeocodeCache,
  geocode,
  geoapifyGeocodeUrl,
  normalizeGeoapifyGeocode,
  normalizeNominatim,
  nominatimUrl,
} from './geocode';

const RICE = { lat: 29.7174, lng: -95.4018 };

describe('geocoding requests', () => {
  it('asks Geoapify for a few US results near the map center', () => {
    const url = new URL(geoapifyGeocodeUrl('2111 Norfolk St', RICE, 'key'));
    expect(url.origin + url.pathname).toBe('https://api.geoapify.com/v1/geocode/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      text: '2111 Norfolk St',
      limit: '5',
      filter: 'countrycode:us',
      bias: 'proximity:-95.4018,29.7174',
      format: 'json',
    });
  });

  it('asks Nominatim with Houston preferred but not required', () => {
    const url = new URL(nominatimUrl('Rice Village'));
    expect(url.searchParams.get('viewbox')).toBe('-95.95,30.15,-94.95,29.4');
    expect(url.searchParams.get('bounded')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('5');
  });
});

describe('normalizing results', () => {
  it('names Geoapify places and addresses readably and drops invalid ones', () => {
    expect(
      normalizeGeoapifyGeocode({
        results: [
          {
            place_id: 'a',
            name: 'Rice Village',
            formatted: 'Rice Village, Houston, TX, United States',
            result_type: 'suburb',
            lat: 29.716,
            lon: -95.414,
          },
          {
            place_id: 'b',
            address_line1: '2111 Norfolk St',
            address_line2: 'Houston, TX 77098, United States',
            housenumber: '2111',
            lat: 29.7333,
            lon: -95.4123,
          },
          { place_id: 'c', name: 'Nowhere', lat: 'x', lon: 1 },
        ],
      }),
    ).toEqual([
      {
        key: 'geoapify:a',
        name: 'Rice Village',
        address: 'Rice Village, Houston, TX, United States',
        location: { lat: 29.716, lng: -95.414 },
        isAddress: false,
      },
      {
        key: 'geoapify:b',
        name: '2111 Norfolk St',
        address: 'Houston, TX 77098, United States',
        location: { lat: 29.7333, lng: -95.4123 },
        isAddress: true,
      },
    ]);
    expect(normalizeGeoapifyGeocode({})).toEqual([]);
  });

  it('turns Nominatim house numbers into a street address', () => {
    expect(
      normalizeNominatim([
        {
          osm_type: 'way',
          osm_id: 1,
          name: '',
          addresstype: 'building',
          display_name: '2111, Norfolk Street, Houston, Harris County, Texas, 77098, United States',
          lat: '29.7333',
          lon: '-95.4123',
        },
      ]),
    ).toEqual([
      {
        key: 'osm:way/1',
        name: '2111 Norfolk Street',
        address: '2111, Norfolk Street, Houston, Harris County, Texas, 77098',
        location: { lat: 29.7333, lng: -95.4123 },
        isAddress: true,
      },
    ]);
    expect(
      normalizeNominatim([
        {
          osm_type: 'node',
          osm_id: 3,
          name: 'Star Pizza',
          display_name: 'Star Pizza, 2111, Norfolk Street, Houston, Texas, 77098, United States',
          lat: '29.7333',
          lon: '-95.4123',
        },
      ])[0],
    ).toMatchObject({ name: 'Star Pizza', address: '2111, Norfolk Street, Houston, Texas, 77098' });
    expect(normalizeNominatim('oops')).toEqual([]);
  });
});

describe('geocode', () => {
  let calls: string[];
  let geoapifyStatus: number;
  beforeEach(() => {
    clearGeocodeCache();
    calls = [];
    geoapifyStatus = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('geoapify')) {
          if (geoapifyStatus !== 200) return new Response('', { status: geoapifyStatus });
          return Response.json({
            results: [{ place_id: 'g', name: 'Place', lat: 29.7, lon: -95.4 }],
          });
        }
        return Response.json([
          { osm_type: 'node', osm_id: 2, name: 'OSM Place', lat: '29.7', lon: '-95.4' },
        ]);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses Geoapify with a key and caches repeated searches', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'key');
    const first = await geocode('Place', RICE);
    expect(first.provider).toBe('geoapify');
    await geocode('  place ', RICE);
    expect(calls).toHaveLength(1);
  });

  it('falls back to Nominatim once Geoapify refuses the key, for the rest of the session', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'key');
    geoapifyStatus = 429;
    expect((await geocode('Place', RICE)).places[0]!.name).toBe('OSM Place');
    await geocode('Other', RICE);
    expect(calls.filter((u) => u.includes('geoapify'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('nominatim'))).toHaveLength(2);
  });

  it('spaces Nominatim requests at least a second apart', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    vi.useFakeTimers();
    try {
      await geocode('One', RICE);
      const second = geocode('Two', RICE);
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600);
      await second;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
