// The search box of the submission page ("搜索餐厅名称或地址"): turns what
// the contributor typed into places. A result that is clearly a place to eat
// carries its POI, so the contributor can choose it as the restaurant; any
// other result only moves the map (or, when the contributor confirms it,
// marks a manually added restaurant). Nothing is selected by itself.
//
// The Geoapify Geocoding API (same key and project as the Places API, whose
// plan allows browser use with a domain-restricted key) is the only provider.
// There is deliberately no fallback to the public OpenStreetMap Nominatim
// service: its limit (one request a second) applies to the whole site, which
// a static site cannot enforce across visitors. Without a key, or when
// Geoapify refuses or fails, the page says address search is unavailable and
// the presets, the current location, and the map itself still work. Searches
// run only when the contributor submits one (never per keystroke), and
// successful results are cached for the session.

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
  /** Set when the result is a place to eat (Geoapify's catering categories): its POI. */
  restaurant?: { provider: string; id: string };
}

export const GEOAPIFY_GEOCODE_ENDPOINT = 'https://api.geoapify.com/v1/geocode/search';
/** Results offered when a search is ambiguous. */
const LIMIT = 5;

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

/**
 * A provider's coordinate as a number: a finite number, or a decimal number
 * written as text. Anything else (null, "", true, "29.7N") is NaN, so the
 * result is dropped instead of being placed at 0 or 1.
 */
const coordinate = (value: unknown): number =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)
      ? Number(value)
      : Number.NaN;

function place(
  key: string,
  name: string | undefined,
  address: string | undefined,
  lat: unknown,
  lon: unknown,
  isAddress: boolean,
): Place | undefined {
  const location = { lat: coordinate(lat), lng: coordinate(lon) };
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
/** OSM amenities that are places to eat, for results without a Geoapify category. */
const FOOD_AMENITIES = ['restaurant', 'fast_food', 'cafe', 'food_court', 'ice_cream', 'pub', 'bar'];

export function normalizeGeoapifyGeocode(body: unknown): Place[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return dedupe(
    results.map((r: Record<string, unknown>, i) => {
      const type = text(r.result_type);
      const line1 = text(r.address_line1);
      const line2 = text(r.address_line2);
      const id = text(r.place_id);
      const raw = (r.datasource as { raw?: Record<string, unknown> } | undefined)?.raw;
      // Only clear places to eat count as restaurants; anything else is a place that moves the map.
      const food =
        type === 'amenity' &&
        (!!text(r.category)?.startsWith('catering') ||
          FOOD_AMENITIES.includes(text(raw?.amenity) ?? ''));
      const found = place(
        `geoapify:${id ?? i}`,
        text(r.name) ?? line1 ?? text(r.formatted),
        text(r.name) ? text(r.formatted) : line2,
        r.lat,
        r.lon,
        type === 'building' || type === 'street' || !!text(r.housenumber),
      );
      return found && food && id && text(r.name)
        ? { ...found, restaurant: { provider: 'geoapify', id } }
        : found;
    }),
  );
}

/** Data attribution for address search results. */
export const GEOCODE_ATTRIBUTION = 'Powered by Geoapify · © OpenStreetMap contributors';

/** Whether address search can run (a Geoapify key is configured). */
export function geocodingAvailable(): boolean {
  return !!poiApiKey();
}

const cache = new Map<string, Promise<Place[]>>();

export function clearGeocodeCache() {
  cache.clear();
}

/**
 * Finds places matching an address or place name, nearest `near` first.
 * Results are cached per query and ~10 km of map position; failed or
 * cancelled searches are not cached. Without a key it fails at once (no
 * request). Pass an AbortSignal to cancel a superseded search: a search
 * shared with another caller is cancelled only for this caller.
 */
export async function geocode(
  query: string,
  near: LatLngValue,
  signal?: AbortSignal,
): Promise<Place[]> {
  try {
    return await cachedGeocode(query, near, signal);
  } catch (e) {
    // A shared request cancelled by another caller: this caller asks again.
    if (isAbort(e) && !signal?.aborted) return cachedGeocode(query, near, signal);
    throw e;
  }
}

function cachedGeocode(query: string, near: LatLngValue, signal?: AbortSignal): Promise<Place[]> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return Promise.resolve([]);
  const apiKey = poiApiKey();
  if (!apiKey) return Promise.reject(new PoiError('quota', 'no Geoapify key'));
  const key = `${q.toLowerCase()}|${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = request(geoapifyGeocodeUrl(q, near, apiKey), { signal }).then(
      normalizeGeoapifyGeocode,
    );
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return promise;
}
