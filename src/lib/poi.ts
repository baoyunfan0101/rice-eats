// Restaurant discovery for the submission page: nearby and name searches
// through a POI (point of interest) provider. Components only see the
// provider-independent RestaurantCandidate; the Geoapify Places API is the
// current provider (docs/submissions.md). The browser key is public by
// nature and restricted to the site's domain in the Geoapify dashboard.

import { isValidLatLng, type LatLngValue } from '../../shared/submission';

export interface RestaurantCandidate {
  /** Stable key for lists: "<provider>:<poiId>". */
  key: string;
  provider: string;
  poiId: string;
  name: string;
  address?: string;
  location: LatLngValue;
  /** Distance in meters from the search center, when known. */
  distance?: number;
}

/** A map area in degrees. */
export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Places in a circle (name search) or a rectangle (map discovery). */
export type PoiSearch = (
  | { center: LatLngValue; radiusMeters: number; bounds?: undefined }
  | { bounds: Bounds; center?: undefined; radiusMeters?: undefined }
) & {
  /** Optional name filter. */
  name?: string;
  /** Maximum number of places (Geoapify allows up to 500; every 20 cost one credit). */
  limit?: number;
};

export type PoiErrorKind = 'not-configured' | 'quota' | 'network' | 'failed';

export class PoiError extends Error {
  constructor(
    readonly kind: PoiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const POI_PROVIDER = 'geoapify';
export const POI_ATTRIBUTION = 'Powered by Geoapify · © OpenStreetMap contributors';
const ENDPOINT = 'https://api.geoapify.com/v2/places';
const CATEGORIES = [
  'catering.restaurant',
  'catering.fast_food',
  'catering.cafe',
  'catering.food_court',
];
const LIMIT = 30;

/**
 * Map discovery loads fixed tiles of TILE_DEGREES (about 1 km) covering the
 * visible area, so panning reuses cached tiles instead of searching again.
 * TILE_LIMIT places per tile is plenty around Rice and caps the cost of a
 * tile at 5 credits.
 */
export const TILE_DEGREES = 0.01;
export const TILE_LIMIT = 100;
/** Below this zoom the visible area needs too many tiles; the page asks to zoom in. */
export const DISCOVERY_MIN_ZOOM = 14;
export const MAX_TILES = 30;

export function poiApiKey(): string | undefined {
  return import.meta.env.VITE_GEOAPIFY_API_KEY?.trim() || undefined;
}

/** Builds the Geoapify request URL (lon/lat order, as the API expects). */
export function geoapifyUrl(search: PoiSearch, apiKey: string): string {
  const params = new URLSearchParams({ categories: CATEGORIES.join(',') });
  if (search.bounds) {
    const b = search.bounds;
    params.set(
      'filter',
      `rect:${b.west.toFixed(6)},${b.south.toFixed(6)},${b.east.toFixed(6)},${b.north.toFixed(6)}`,
    );
  } else {
    const { lat, lng } = search.center;
    params.set(
      'filter',
      `circle:${lng.toFixed(6)},${lat.toFixed(6)},${Math.round(search.radiusMeters)}`,
    );
    params.set('bias', `proximity:${lng.toFixed(6)},${lat.toFixed(6)}`);
  }
  params.set('limit', String(search.limit ?? LIMIT));
  params.set('apiKey', apiKey);
  if (search.name?.trim()) params.set('name', search.name.trim());
  return `${ENDPOINT}?${params}`;
}

interface GeoapifyFeature {
  properties?: {
    place_id?: unknown;
    name?: unknown;
    formatted?: unknown;
    address_line2?: unknown;
    lat?: unknown;
    lon?: unknown;
    distance?: unknown;
  };
}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Turns a Geoapify response into candidates: valid coordinates and a name only, deduplicated. */
export function normalizeGeoapify(body: unknown, center?: LatLngValue): RestaurantCandidate[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const seen = new Set<string>();
  const candidates: RestaurantCandidate[] = [];
  for (const feature of features as GeoapifyFeature[]) {
    const p = feature?.properties;
    const poiId = text(p?.place_id);
    const name = text(p?.name);
    const location = { lat: p?.lat as number, lng: p?.lon as number };
    // A place without a name cannot be confirmed by the contributor.
    if (!p || !poiId || !name || !isValidLatLng(location)) continue;
    const key = `${POI_PROVIDER}:${poiId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const address = text(p.address_line2) ?? text(p.formatted);
    const distance =
      typeof p.distance === 'number' && Number.isFinite(p.distance)
        ? p.distance
        : center
          ? distanceMeters(center, location)
          : undefined;
    candidates.push({
      key,
      provider: POI_PROVIDER,
      poiId,
      name,
      ...(address ? { address } : {}),
      location,
      ...(distance !== undefined ? { distance } : {}),
    });
  }
  return candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLngValue, b: LatLngValue): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const cache = new Map<string, Promise<RestaurantCandidate[]>>();

export function clearPoiCache() {
  cache.clear();
}

/**
 * Searches restaurants around a point. Results are cached for the session
 * (same rounded center, radius, and name), and failed requests are not
 * cached. Pass an AbortSignal to cancel superseded searches.
 */
export async function searchRestaurants(
  search: PoiSearch,
  signal?: AbortSignal,
): Promise<RestaurantCandidate[]> {
  const apiKey = poiApiKey();
  if (!apiKey) throw new PoiError('not-configured', 'POI search is not configured');
  const url = geoapifyUrl(search, apiKey);
  const cacheKey = url.replace(/&apiKey=[^&]*/, '');
  let promise = cache.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      let response: Response;
      try {
        response = await fetch(url, { signal });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new PoiError('network', 'network error');
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw new PoiError('quota', `HTTP ${response.status}`);
      }
      if (!response.ok) throw new PoiError('failed', `HTTP ${response.status}`);
      return normalizeGeoapify(await response.json(), search.center);
    })();
    promise.catch(() => cache.delete(cacheKey));
    cache.set(cacheKey, promise);
  }
  return promise;
}

/** The fixed tiles covering an area, or undefined when there would be more than MAX_TILES. */
export function tilesFor(bounds: Bounds): Bounds[] | undefined {
  const t = TILE_DEGREES;
  // Rounding before flooring keeps float noise (e.g. 29.72 / 0.01) on the right tile.
  const index = (v: number) => Math.floor(Math.round((v / t) * 1e6) / 1e6);
  const [s, n] = [index(bounds.south), index(bounds.north)];
  const [w, e] = [index(bounds.west), index(bounds.east)];
  if ((n - s + 1) * (e - w + 1) > MAX_TILES) return undefined;
  const tiles: Bounds[] = [];
  for (let y = s; y <= n; y++) {
    for (let x = w; x <= e; x++) {
      const f = (i: number) => Number((i * t).toFixed(6));
      tiles.push({ south: f(y), north: f(y + 1), west: f(x), east: f(x + 1) });
    }
  }
  return tiles;
}

/**
 * Restaurants in the visible map area, loaded tile by tile (each tile cached
 * for the session) and merged. Returns [] when the area needs more than
 * MAX_TILES tiles. Rejects like searchRestaurants; tiles that loaded stay cached.
 */
export async function restaurantsInArea(bounds: Bounds): Promise<RestaurantCandidate[]> {
  const tiles = tilesFor(bounds);
  if (!tiles) return [];
  // Tiles are not cancelled when the map moves on: they stay useful in the
  // cache, and callers ignore results for an area that is no longer shown.
  const lists = await Promise.all(
    tiles.map((tile) => searchRestaurants({ bounds: tile, limit: TILE_LIMIT })),
  );
  const byKey = new Map<string, RestaurantCandidate>();
  for (const c of lists.flat()) if (!byKey.has(c.key)) byKey.set(c.key, c);
  return [...byKey.values()];
}

/** Short Chinese description of a distance, e.g. "120 米", "1.2 公里". */
export function distanceText(meters: number | undefined): string | undefined {
  if (meters === undefined) return undefined;
  return meters < 1000
    ? `${Math.max(1, Math.round(meters / 10) * 10)} 米`
    : `${(meters / 1000).toFixed(1)} 公里`;
}
