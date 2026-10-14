import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeocodeCache,
  geocode,
  geoapifyGeocodeUrl,
  geocodingAvailable,
  normalizeGeoapifyGeocode,
} from './geocode';
import { PoiError } from './poi';

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
});

describe('geocode', () => {
  let calls: string[];
  let respond: (url: string) => Promise<Response>;
  beforeEach(() => {
    clearGeocodeCache();
    calls = [];
    respond = async () =>
      Response.json({ results: [{ place_id: 'g', name: 'Place', lat: 29.7, lon: -95.4 }] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        const response = respond(url);
        // Like fetch: an abort rejects the pending request.
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
          response.then(resolve, reject);
        });
      }),
    );
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', 'key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns Geoapify results and caches repeated searches', async () => {
    expect((await geocode('Place', RICE))[0]!.name).toBe('Place');
    await geocode('  place ', RICE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/api\.geoapify\.com\/v1\/geocode\/search\?/);
  });

  it.each([401, 403, 429, 500])(
    'reports HTTP %i as unavailable, never asks another service, and does not cache it',
    async (status) => {
      respond = async () => new Response('', { status });
      await expect(geocode('Place', RICE)).rejects.toBeInstanceOf(PoiError);
      expect(calls).toHaveLength(1);
      // A later search (e.g. "重试" once the service is back) asks again.
      respond = async () => Response.json({ results: [] });
      await expect(geocode('Place', RICE)).resolves.toEqual([]);
      expect(calls).toHaveLength(2);
      expect(calls.every((u) => u.startsWith('https://api.geoapify.com/'))).toBe(true);
    },
  );

  it('reports network failures', async () => {
    respond = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(geocode('Place', RICE)).rejects.toMatchObject({ kind: 'network' });
  });

  it('sends nothing without a key', async () => {
    vi.stubEnv('VITE_GEOAPIFY_API_KEY', '');
    expect(geocodingAvailable()).toBe(false);
    await expect(geocode('Place', RICE)).rejects.toBeInstanceOf(PoiError);
    expect(calls).toEqual([]);
  });

  it('cancels a search for one caller only, without caching the cancellation', async () => {
    let release!: () => void;
    respond = () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            Response.json({ results: [{ place_id: 'g', name: 'Place', lat: 29.7, lon: -95.4 }] }),
          );
      });
    const first = new AbortController();
    const a = geocode('Place', RICE, first.signal);
    const b = geocode('Place', RICE);
    first.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    // The other caller still gets its answer (asking again once).
    await Promise.resolve();
    release();
    await expect(b).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
