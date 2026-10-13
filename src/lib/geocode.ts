// Address and place search ("输入地址或地点") for the submission page: turns
// what the contributor typed into map locations to move the map to. It only
// locates the search area (or, when the contributor confirms it, a manually
// added restaurant); it never selects a restaurant by itself.
//
// The Geoapify Geocoding API (same key and project as the Places API) is the
// main provider. Without a key, or when Geoapify refuses or fails, the public
// OpenStreetMap Nominatim service is the fallback. Its usage policy allows no
// autocomplete and at most one request per second, so searches only run when
// the contributor submits the search (never per keystroke), identical searches
// are cached for the session, and requests are spaced at least a second apart.

import { isValidLatLng, type LatLngValue } from '../../shared/submission';
import { isAbort, PoiError, poiApiKey, request } from './poi';

export interface Place {
  /** Stable key for lists. */
  key: string;
  /** A readable name: the place name or the street address. */
  name: string;
  /** The rest of the address, when known. */
  address?: string;
  location: LatLngValue;
  /** Whether the result is a street address (as opposed to an area or landmark). */
  isAddress: boolean;
}

export const GEOAPIFY_GEOCODE_ENDPOINT = 'https://api.geoapify.com/v1/geocode/search';
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
/** Results offered when a search is ambiguous. */
const LIMIT = 5;
/** Greater Houston (west, south, east, north): results here come first. */
const HOUSTON = { west: -95.95, south: 29.4, east: -94.95, north: 30.15 };

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Builds the Geoapify Geocoding request, biased towards the map center. */
export function geoapifyGeocodeUrl(query: string, near: LatLngValue, apiKey: string): string {
  const params = new URLSearchParams({
    text: query,
    format: 'json',
    limit: String(LIMIT),
    filter: 'countrycode:us',
    bias: `proximity:${near.lng.toFixed(4)},${near.lat.toFixed(4)}`,
    apiKey,
  });
  return `${GEOAPIFY_GEOCODE_ENDPOINT}?${params}`;
}

/** Builds the Nominatim request, preferring (not limited to) the Houston area. */
export function nominatimUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(LIMIT),
    countrycodes: 'us',
    viewbox: `${HOUSTON.west},${HOUSTON.north},${HOUSTON.east},${HOUSTON.south}`,
    bounded: '0',
  });
  return `${NOMINATIM_ENDPOINT}?${params}`;
}

function place(
  key: string,
  name: string | undefined,
  address: string | undefined,
  lat: unknown,
  lon: unknown,
  isAddress: boolean,
): Place | undefined {
  const location = { lat: Number(lat), lng: Number(lon) };
  if (!name || !isValidLatLng(location)) return undefined;
  return {
    key,
    name,
    ...(address && address !== name ? { address } : {}),
    location,
    isAddress,
  };
}

const dedupe = (places: (Place | undefined)[]) => {
  const seen = new Set<string>();
  return places.filter((p): p is Place => {
    if (!p) return false;
    const id = `${p.name}|${p.address ?? ''}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** Turns a Geoapify Geocoding response (format=json) into places. */
export function normalizeGeoapifyGeocode(body: unknown): Place[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return dedupe(
    results.map((r: Record<string, unknown>, i) => {
      const type = text(r.result_type);
      const line1 = text(r.address_line1);
      const line2 = text(r.address_line2);
      return place(
        `geoapify:${text(r.place_id) ?? i}`,
        text(r.name) ?? line1 ?? text(r.formatted),
        text(r.name) ? text(r.formatted) : line2,
        r.lat,
        r.lon,
        type === 'building' || type === 'street' || !!text(r.housenumber),
      );
    }),
  );
}

/** Turns a Nominatim response (format=jsonv2) into places. */
export function normalizeNominatim(body: unknown): Place[] {
  if (!Array.isArray(body)) return [];
  return dedupe(
    body.map((r: Record<string, unknown>, i) => {
      const display = text(r.display_name)?.replace(/, United States$/, '');
      const parts = display?.split(',').map((s) => s.trim()) ?? [];
      const name = text(r.name) ?? parts[0];
      const isAddress =
        r.addresstype === 'building' || r.category === 'building' || /^\d/.test(parts[0] ?? '');
      // A house number on its own is not a readable name.
      const label =
        isAddress && parts.length > 1 && /^\d+$/.test(parts[0]!) ? `${parts[0]} ${parts[1]}` : name;
      return place(
        `osm:${text(r.osm_type) ?? 'place'}/${String(r.osm_id ?? i)}`,
        label,
        // The address without the place name it starts with.
        label && display?.startsWith(`${label}, `) ? display.slice(label.length + 2) : display,
        r.lat,
        r.lon,
        isAddress,
      );
    }),
  );
}

/** Data attribution for the geocoding provider that answered. */
export function geocodeAttribution(provider: 'geoapify' | 'osm'): string {
  return provider === 'geoapify'
    ? 'Powered by Geoapify · © OpenStreetMap contributors'
    : '地址搜索：© OpenStreetMap contributors（Nominatim）';
}

export interface GeocodeResult {
  places: Place[];
  provider: 'geoapify' | 'osm';
}

const cache = new Map<string, Promise<GeocodeResult>>();
let geoapifyRefused = false;
/** Nominatim allows one request per second. */
const NOMINATIM_SPACING_MS = 1000;
let nominatimNext = 0;

export function clearGeocodeCache() {
  cache.clear();
  geoapifyRefused = false;
  nominatimNext = 0;
}

async function fromNominatim(query: string, signal?: AbortSignal): Promise<GeocodeResult> {
  const wait = nominatimNext - Date.now();
  nominatimNext = Math.max(Date.now(), nominatimNext) + NOMINATIM_SPACING_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    places: normalizeNominatim(await request(nominatimUrl(query), { signal })),
    provider: 'osm',
  };
}

/**
 * Finds places matching an address or place name, nearest `near` first when
 * the provider supports it. Results are cached per query (and, for Geoapify,
 * per ~10 km of map position); failed searches are not cached.
 */
export async function geocode(
  query: string,
  near: LatLngValue,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  try {
    return await cachedGeocode(query, near, signal);
  } catch (e) {
    // A shared request cancelled by another caller: this caller asks again.
    if (isAbort(e) && !signal?.aborted) return cachedGeocode(query, near, signal);
    throw e;
  }
}

function cachedGeocode(
  query: string,
  near: LatLngValue,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return Promise.resolve({ places: [], provider: poiApiKey() ? 'geoapify' : 'osm' });
  const key = `${q.toLowerCase()}|${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = (async () => {
      const apiKey = poiApiKey();
      if (apiKey && !geoapifyRefused) {
        try {
          const body = await request(geoapifyGeocodeUrl(q, near, apiKey), { signal });
          return { places: normalizeGeoapifyGeocode(body), provider: 'geoapify' as const };
        } catch (e) {
          if (isAbort(e)) throw e;
          if (e instanceof PoiError && e.kind === 'quota') geoapifyRefused = true;
        }
      }
      return fromNominatim(q, signal);
    })();
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return promise;
}
