// Restaurant discovery for the submission page: nearby and name searches
// through a POI (point of interest) provider. Components only see the
// provider-independent RestaurantCandidate (docs/submissions.md).
//
// The Geoapify Places API is the main provider; its browser key is public by
// nature and restricted to the site's domain in the Geoapify dashboard. The
// free OpenStreetMap Overpass API (no key) is the fallback when there is no
// key, the Geoapify credits are used up, or a Geoapify request fails. Both
// serve OpenStreetMap data, so they find the same restaurants.

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

export type PoiErrorKind = 'quota' | 'network' | 'failed';

export class PoiError extends Error {
  constructor(
    readonly kind: PoiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const POI_PROVIDER = 'geoapify';
export const OSM_PROVIDER = 'osm';
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const OSM_AMENITIES = ['restaurant', 'fast_food', 'cafe', 'food_court'];

/** Data attribution for the providers in use. */
export function poiAttribution(): string {
  return poiApiKey()
    ? 'Powered by Geoapify · © OpenStreetMap contributors'
    : '© OpenStreetMap contributors';
}
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
 * TILE_LIMIT is Geoapify's maximum: credits are charged per place returned
 * (one per 20), not per limit, so a high limit costs nothing extra and makes
 * a truncated tile (reported to the page) very unlikely.
 */
export const TILE_DEGREES = 0.01;
export const TILE_LIMIT = 500;
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

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

/** Fetches and maps HTTP and network failures to PoiError (aborts pass through). */
async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new PoiError('network', 'network error');
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    throw new PoiError('quota', `HTTP ${response.status}`);
  }
  if (!response.ok) throw new PoiError('failed', `HTTP ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// OpenStreetMap Overpass (fallback)

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the Overpass QL query: named restaurants in a rectangle or circle, with centers for areas. */
export function overpassQuery(search: PoiSearch): string {
  const amenity = `["amenity"~"^(${OSM_AMENITIES.join('|')})$"]`;
  const name = search.name?.trim();
  const named = name ? `["name"~${JSON.stringify(escapeRegex(name))},i]` : '["name"]';
  const area = search.bounds
    ? `(${[search.bounds.south, search.bounds.west, search.bounds.north, search.bounds.east]
        .map((v) => v.toFixed(6))
        .join(',')})`
    : `(around:${Math.round(search.radiusMeters)},${search.center.lat.toFixed(6)},${search.center.lng.toFixed(6)})`;
  return `[out:json][timeout:20];nwr${amenity}${named}${area};out center ${search.limit ?? LIMIT};`;
}

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: { lat?: unknown; lon?: unknown };
  tags?: Record<string, unknown>;
}

/** Turns an Overpass response into candidates, like normalizeGeoapify. */
export function normalizeOverpass(body: unknown, center?: LatLngValue): RestaurantCandidate[] {
  const elements = (body as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const seen = new Set<string>();
  const candidates: RestaurantCandidate[] = [];
  for (const el of elements as OverpassElement[]) {
    const tags = el?.tags ?? {};
    const name = text(tags.name);
    const type = text(el?.type);
    const id = typeof el?.id === 'number' || typeof el?.id === 'string' ? String(el.id) : undefined;
    const point = el?.center ?? el;
    const location = { lat: point?.lat as number, lng: point?.lon as number };
    if (!name || !type || !id || !isValidLatLng(location)) continue;
    const poiId = `${type}/${id}`;
    const key = `${OSM_PROVIDER}:${poiId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const street = text(tags['addr:street']);
    const number = text(tags['addr:housenumber']);
    const address =
      text(tags['addr:full']) ?? (street ? (number ? `${number} ${street}` : street) : undefined);
    const distance = center ? distanceMeters(center, location) : undefined;
    candidates.push({
      key,
      provider: OSM_PROVIDER,
      poiId,
      name,
      ...(address ? { address } : {}),
      location,
      ...(distance !== undefined ? { distance } : {}),
    });
  }
  return candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

/**
 * The public Overpass server allows only a couple of requests at a time per
 * visitor and answers 429 beyond that, so requests wait for a free slot.
 */
const OVERPASS_SLOTS = 2;
let overpassActive = 0;
const overpassWaiting: (() => void)[] = [];

async function withOverpassSlot<T>(run: () => Promise<T>): Promise<T> {
  if (overpassActive >= OVERPASS_SLOTS) {
    await new Promise<void>((resolve) => overpassWaiting.push(resolve));
  }
  overpassActive++;
  try {
    return await run();
  } finally {
    overpassActive--;
    overpassWaiting.shift()?.();
  }
}

/** Delay before retrying a failed Overpass request (shortened in tests). */
let overpassRetryMs = 1500;
export function setOverpassRetryDelay(ms: number) {
  overpassRetryMs = ms;
}

async function fromOverpass(search: PoiSearch, signal?: AbortSignal) {
  const post = () =>
    request(OVERPASS_ENDPOINT, {
      method: 'POST',
      // A form body keeps this a simple CORS request (no preflight).
      body: new URLSearchParams({ data: overpassQuery(search) }),
      signal,
    });
  const body = await withOverpassSlot(async () => {
    try {
      return await post();
    } catch (e) {
      // A busy server answers 504 now and then; one retry usually succeeds.
      if (!(e instanceof PoiError) || e.kind === 'quota' || signal?.aborted) throw e;
      await new Promise((resolve) => setTimeout(resolve, overpassRetryMs));
      return post();
    }
  });
  return normalizeOverpass(body, search.center);
}

// ---------------------------------------------------------------------------
// Searching with fallback and caching

const cache = new Map<string, Promise<RestaurantCandidate[]>>();

const searchKey = (search: PoiSearch) =>
  JSON.stringify([
    search.bounds ?? [
      search.center.lat.toFixed(6),
      search.center.lng.toFixed(6),
      search.radiusMeters,
    ],
    search.name?.trim() ?? '',
    search.limit ?? LIMIT,
  ]);

/** Set when Geoapify refuses the key (credits used up or key rejected) this session. */
let geoapifyRefused = false;
const noteGeoapifyFailure = (e: unknown) => {
  if (e instanceof PoiError && e.kind === 'quota') geoapifyRefused = true;
};

export function clearPoiCache() {
  cache.clear();
  tileCache.clear();
  geoapifyRefused = false;
}

/**
 * Searches restaurants in an area: through Geoapify when a key is set and has
 * not been refused this session, otherwise (or when that request fails)
 * through Overpass. Results are cached for the session per search, and failed
 * searches are not cached. Pass an AbortSignal to cancel superseded searches.
 */
export async function searchRestaurants(
  search: PoiSearch,
  signal?: AbortSignal,
): Promise<RestaurantCandidate[]> {
  try {
    return await cachedSearch(search, signal);
  } catch (e) {
    // A cached request started by a caller that has since cancelled it: this
    // caller still wants the result, so it asks again (the cache entry is gone).
    if (isAbort(e) && !signal?.aborted) return cachedSearch(search, signal);
    throw e;
  }
}

function cachedSearch(search: PoiSearch, signal?: AbortSignal): Promise<RestaurantCandidate[]> {
  const cacheKey = searchKey(search);
  let promise = cache.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const apiKey = poiApiKey();
      if (apiKey && !geoapifyRefused) {
        try {
          return normalizeGeoapify(
            await request(geoapifyUrl(search, apiKey), { signal }),
            search.center,
          );
        } catch (e) {
          if (isAbort(e)) throw e;
          noteGeoapifyFailure(e);
        }
      }
      return fromOverpass(search, signal);
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

// ---------------------------------------------------------------------------
// Map discovery
//
// The visible area is covered by fixed tiles (tilesFor), each cached for the
// session. Uncached tiles of a view are loaded as one batch:
//  - through Geoapify, one request per tile, while it has a key that has not
//    been refused;
//  - tiles Geoapify could not load (refused, rate-limited, failed) and every
//    tile once Geoapify is not used go to Overpass in ONE request for their
//    bounding box, split back into tiles. So a fallback never fans out into
//    one Overpass request per tile.
// Each tile succeeds or fails on its own: failures are not cached (a retry
// loads them again) and do not hide the tiles that loaded.

interface TileResult {
  candidates: RestaurantCandidate[];
  /** The provider's result limit was reached, so the tile may be incomplete. */
  truncated: boolean;
}

/** Places per Overpass batch (Overpass has no per-result cost). */
export const OVERPASS_AREA_LIMIT = 2000;

const tileCache = new Map<string, Promise<TileResult>>();
const tileKey = (t: Bounds) => `${t.south},${t.west}`;

const inTile = (tile: Bounds) => (c: RestaurantCandidate) =>
  c.location.lat >= tile.south &&
  c.location.lat < tile.north &&
  c.location.lng >= tile.west &&
  c.location.lng < tile.east;

async function geoapifyTile(tile: Bounds, apiKey: string): Promise<TileResult> {
  const body = await request(geoapifyUrl({ bounds: tile, limit: TILE_LIMIT }, apiKey), {});
  const raw = (body as { features?: unknown[] })?.features;
  return {
    candidates: normalizeGeoapify(body),
    truncated: Array.isArray(raw) && raw.length >= TILE_LIMIT,
  };
}

async function overpassTiles(tiles: Bounds[]): Promise<TileResult[]> {
  const box: Bounds = {
    south: Math.min(...tiles.map((t) => t.south)),
    west: Math.min(...tiles.map((t) => t.west)),
    north: Math.max(...tiles.map((t) => t.north)),
    east: Math.max(...tiles.map((t) => t.east)),
  };
  const all = await fromOverpass({ bounds: box, limit: OVERPASS_AREA_LIMIT });
  // A full batch may have dropped places anywhere in the box.
  const truncated = all.length >= OVERPASS_AREA_LIMIT;
  return tiles.map((tile) => ({ candidates: all.filter(inTile(tile)), truncated }));
}

/** Starts loading the tiles that are not cached (or loading) yet. */
function loadMissingTiles(tiles: Bounds[]) {
  const missing = tiles.filter((t) => !tileCache.has(tileKey(t)));
  if (missing.length === 0) return;
  const settle = new Map<
    string,
    { resolve: (r: TileResult) => void; reject: (e: unknown) => void }
  >();
  for (const tile of missing) {
    const key = tileKey(tile);
    const promise = new Promise<TileResult>((resolve, reject) =>
      settle.set(key, { resolve, reject }),
    );
    promise.catch(() => tileCache.delete(key));
    tileCache.set(key, promise);
  }
  void (async () => {
    let remaining = missing;
    const apiKey = poiApiKey();
    if (apiKey && !geoapifyRefused) {
      const results = await Promise.allSettled(missing.map((t) => geoapifyTile(t, apiKey)));
      remaining = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') settle.get(tileKey(missing[i]!))!.resolve(r.value);
        else {
          noteGeoapifyFailure(r.reason);
          remaining.push(missing[i]!);
        }
      });
    }
    if (remaining.length === 0) return;
    try {
      const results = await overpassTiles(remaining);
      remaining.forEach((t, i) => settle.get(tileKey(t))!.resolve(results[i]!));
    } catch (e) {
      for (const t of remaining) settle.get(tileKey(t))!.reject(e);
    }
  })();
}

export interface AreaResult {
  candidates: RestaurantCandidate[];
  /** Tiles that could not be loaded (not cached; loading the area again retries them). */
  failed: number;
  /** Tiles in the area. */
  total: number;
  /** Some tile reached the provider's result limit and may be incomplete. */
  truncated: boolean;
  /** The first failure, for the message when nothing loaded. */
  error?: unknown;
}

/**
 * Restaurants in the visible map area, merged from its tiles. Never rejects:
 * tiles that fail are reported in `failed` while the others are returned.
 * An area that needs more than MAX_TILES tiles returns nothing.
 */
export async function restaurantsInArea(bounds: Bounds): Promise<AreaResult> {
  const tiles = tilesFor(bounds);
  if (!tiles) return { candidates: [], failed: 0, total: 0, truncated: false };
  loadMissingTiles(tiles);
  // Tiles are not cancelled when the map moves on: they stay useful in the
  // cache, and callers ignore results for an area that is no longer shown.
  const settled = await Promise.allSettled(tiles.map((t) => tileCache.get(tileKey(t))!));
  const lists: RestaurantCandidate[][] = [];
  let failed = 0;
  let truncated = false;
  let error: unknown;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      lists.push(r.value.candidates);
      truncated ||= r.value.truncated;
    } else {
      failed++;
      error ??= r.reason;
    }
  }
  // Tiles loaded before and after a fallback come from different providers;
  // the same restaurant then has two keys, so also merge by name and place.
  const merged: RestaurantCandidate[] = [];
  const keys = new Set<string>();
  const same = (a: RestaurantCandidate, b: RestaurantCandidate) =>
    a.name.toLowerCase() === b.name.toLowerCase() && distanceMeters(a.location, b.location) < 50;
  for (const c of lists.flat()) {
    if (keys.has(c.key) || merged.some((m) => m.provider !== c.provider && same(m, c))) continue;
    keys.add(c.key);
    merged.push(c);
  }
  return {
    candidates: merged,
    failed,
    total: tiles.length,
    truncated,
    ...(error ? { error } : {}),
  };
}

/** Meters in a mile. */
const METERS_PER_MILE = 1609.344;

/** Distance for people, in miles: "0.3 mi", "1.2 mi", "12 mi" ("<0.1 mi" when very close). */
export function distanceText(meters: number | undefined): string | undefined {
  if (meters === undefined) return undefined;
  const miles = meters / METERS_PER_MILE;
  if (miles < 0.05) return '<0.1 mi';
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}
