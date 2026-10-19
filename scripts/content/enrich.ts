// Restaurant information from outside the submission (docs/submissions.md,
// "Restaurant information"). Objective facts only: other names, address,
// cuisines, and the official website (the price per person comes from the
// reviews, never from here). Every fact records where it came from, how it was obtained, and how
// sure it is; nothing here guesses, and every source may fail without
// blocking a draft.
//
// Deterministic sources: the map listing the contributor selected (its POI),
// read through Geoapify Place Details (with a key) or OpenStreetMap's Overpass
// API (free; for OSM POIs, and as a fallback that looks for the same named
// place within a few meters of the selected location, so another branch of a
// chain is never used). Results are cached in private/cache/ so a POI is
// fetched once. A listing is used only after verifyListing confirms it is the
// intended restaurant (the POI id is an unverified form field). Facts that need judgment (a name from the
// official site) come from the Skill as reviewed decisions (prepare.ts), with
// pages fetched through fetchEvidencePage.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { normalizeKeyword } from '../../shared/content/schema.ts';
import { CUISINE_IDS, type CuisineId } from '../../shared/content/vocabulary.ts';
import { isValidLatLng, type LatLngValue } from '../../shared/submission.ts';
import { ANY_PUBLIC_HOST, DownloadError, redactUrl, safeFetch, type Lookup } from './safe-fetch.ts';
import { distanceMeters } from './submissions.ts';

export const ENRICHED_FIELDS = ['altNames', 'address', 'cuisines', 'website'] as const;
export type EnrichedField = (typeof ENRICHED_FIELDS)[number];

const httpUrl = z.url({ protocol: /^https?$/ });

const provenance = {
  /** Who or what supplied it, e.g. "OpenStreetMap", "official website menu". */
  source: z.string().trim().min(1).max(200),
  /** A URL or a short quotation that shows it. */
  evidence: z.string().trim().min(1).max(500),
  /** direct: stated by the source; inferred: derived from what the source states. */
  method: z.enum(['direct', 'inferred']),
  confidence: z.enum(['high', 'medium', 'low']),
  verifiedAt: z.string().optional(),
};

/** One piece of restaurant information with its provenance. */
export const factSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('altNames'), value: z.array(z.string().trim().min(1).max(80)).min(1), ...provenance }),
  z.strictObject({ field: z.literal('address'), value: z.string().trim().min(1).max(200), ...provenance }),
  z.strictObject({ field: z.literal('cuisines'), value: z.array(z.enum(CUISINE_IDS)).min(1), ...provenance }),
  z.strictObject({ field: z.literal('website'), value: httpUrl, ...provenance }),
]);
export type Fact = z.infer<typeof factSchema>;

/** The cached result of looking up one POI. */
export interface PoiDetails {
  key: string;
  status: 'ok' | 'not-found' | 'failed' | 'skipped';
  /** Why the lookup failed or was skipped (no secrets or link tokens). */
  reason?: string;
  fetchedAt: string;
  /** The listing's own name, to compare with the submitted one. */
  name?: string;
  /** Every name of the listing (name, other languages, official and short names). */
  names: string[];
  /** The listing's coordinates and address, to check it is the intended restaurant. */
  location?: LatLngValue;
  address?: string;
  facts: Fact[];
  /** OSM cuisine values with no matching cuisine key, for the maintainer. */
  unmappedCuisines: string[];
}

/** OSM `cuisine=*` values (and a few amenity types) mapped to cuisine keys. */
const OSM_CUISINES: Record<string, CuisineId> = {
  american: 'american',
  burger: 'american',
  bakery: 'bakery',
  barbecue: 'bbq',
  bbq: 'bbq',
  cantonese: 'cantonese',
  dim_sum: 'cantonese',
  chinese: 'chinese',
  coffee_shop: 'coffee',
  coffee: 'coffee',
  dessert: 'dessert',
  ice_cream: 'dessert',
  frozen_yogurt: 'dessert',
  japanese: 'japanese',
  sushi: 'japanese',
  korean: 'korean',
  mexican: 'mexican',
  'tex-mex': 'mexican',
  tacos: 'mexican',
  ramen: 'ramen',
  sichuan: 'sichuan',
  szechuan: 'sichuan',
  steak_house: 'steak',
  steak: 'steak',
  taiwanese: 'taiwanese',
  thai: 'thai',
  vietnamese: 'vietnamese',
  pho: 'vietnamese',
};

/** Facts from a place's OpenStreetMap tags (as served by Overpass or inside Geoapify's datasource). */
export function factsFromOsmTags(
  tags: Record<string, unknown>,
  source: string,
  evidence: string,
  confidence: Fact['confidence'] = 'high',
): { name?: string; names: string[]; address?: string; facts: Fact[]; unmappedCuisines: string[] } {
  const str = (key: string) => (typeof tags[key] === 'string' ? (tags[key] as string).trim() : '') || undefined;
  const name = str('name');
  const facts: Fact[] = [];
  const base = { source, evidence, method: 'direct' as const, confidence };
  const alt = [
    ...['name:en', 'name:zh', 'name:zh-Hans', 'name:zh-Hant', 'official_name', 'short_name'].map(str),
    ...(str('alt_name')?.split(';') ?? []),
  ]
    .map((n) => n?.trim())
    .filter((n): n is string => !!n && (!name || normalizeKeyword(n) !== normalizeKeyword(name)));
  const altNames = [...new Map(alt.map((n) => [normalizeKeyword(n), n])).values()];
  if (altNames.length) facts.push({ field: 'altNames', value: altNames, ...base });

  const street = str('addr:street');
  const number = str('addr:housenumber');
  const line = street ? (number ? `${number} ${street}` : street) : undefined;
  const city = [str('addr:city'), [str('addr:state'), str('addr:postcode')].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const address = str('addr:full') ?? (line ? [line, city].filter(Boolean).join(', ') : undefined);
  if (address) facts.push({ field: 'address', value: address, ...base });

  const unmappedCuisines: string[] = [];
  const cuisines = new Set<CuisineId>();
  for (const value of (str('cuisine') ?? '').split(';').map((v) => v.trim().toLowerCase()).filter(Boolean)) {
    const id = OSM_CUISINES[value];
    if (id) cuisines.add(id);
    else unmappedCuisines.push(value);
  }
  if (cuisines.size) facts.push({ field: 'cuisines', value: [...cuisines], ...base });
  else if (str('amenity') === 'cafe' && unmappedCuisines.length === 0) {
    facts.push({ field: 'cuisines', value: ['coffee'], ...base, method: 'inferred', confidence: 'medium', evidence: `${evidence} (amenity=cafe)` });
  }

  const website = str('website') ?? str('contact:website') ?? str('url');
  if (website && httpUrl.safeParse(website).success) facts.push({ field: 'website', value: website, ...base });
  return { name, names: [...(name ? [name] : []), ...altNames], ...(address ? { address } : {}), facts, unmappedCuisines };
}

export interface EnrichOptions {
  cacheDir: string;
  /** Geoapify key for server-side requests (GEOAPIFY_API_KEY); optional. */
  geoapifyKey?: string;
  /** false: no network, cached results only. */
  network?: boolean;
  /** Ignore the cache and look the POI up again. */
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => string;
}

export const GEOAPIFY_HOSTS = ['api.geoapify.com'];
export const OVERPASS_HOSTS = ['overpass-api.de'];
/** A same-named OSM place this close to the selected location is the same place. */
export const SAME_PLACE_METERS = 60;
const REQUEST = { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 };

const cacheFile = (dir: string, key: string) =>
  path.join(dir, 'poi', `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);

async function writeJsonAtomic(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * Looks up the selected place. Uses the cache unless `refresh`; never throws:
 * a failure is returned (and not cached, so a later run can retry).
 */
export async function poiDetails(
  place: { poi?: { provider: string; id: string }; name?: string; location?: LatLngValue },
  options: EnrichOptions,
): Promise<PoiDetails> {
  const now = options.now ?? (() => new Date().toISOString());
  const key = place.poi
    ? `${place.poi.provider}:${place.poi.id}`
    : place.name && place.location
      ? `near:${place.location.lat.toFixed(5)},${place.location.lng.toFixed(5)}:${normalizeKeyword(place.name)}`
      : '';
  const result = (status: PoiDetails['status'], reason?: string): PoiDetails => ({
    key,
    status,
    ...(reason ? { reason } : {}),
    fetchedAt: now(),
    names: [],
    facts: [],
    unmappedCuisines: [],
  });
  if (!key) return result('skipped', 'no map listing and no location to look up');
  const file = cacheFile(options.cacheDir, key);
  if (!options.refresh && existsSync(file)) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as PoiDetails;
    } catch {
      // A broken cache entry is looked up again.
    }
  }
  if (options.network === false) return result('skipped', 'offline (--offline): no lookup');

  const get = async (url: string, hosts: string[]) => {
    const response = await safeFetch(url, { ...REQUEST, hosts, fetchImpl: options.fetchImpl, lookup: options.lookup, headers: { accept: 'application/json' } });
    return JSON.parse(response.body.toString('utf8')) as unknown;
  };
  let details: PoiDetails;
  try {
    if (place.poi?.provider === 'geoapify' && options.geoapifyKey) {
      details = await fromGeoapify(place.poi.id, options.geoapifyKey, get, result);
    } else if (place.poi?.provider === 'osm' && /^(node|way|relation)\/\d+$/.test(place.poi.id)) {
      details = await fromOverpassId(place.poi.id, get, result);
    } else if (place.name && isValidLatLng(place.location)) {
      details = await fromOverpassNearby(place.name, place.location, get, result);
    } else {
      return result('skipped', 'no lookup available for this map listing (a Geoapify POI needs GEOAPIFY_API_KEY)');
    }
  } catch (e) {
    const reason =
      e instanceof DownloadError ? e.message : e instanceof SyntaxError ? 'the answer was not JSON' : 'lookup failed';
    return result('failed', reason);
  }
  await writeJsonAtomic(file, details);
  return details;
}

type Get = (url: string, hosts: string[]) => Promise<unknown>;
type Result = (status: PoiDetails['status'], reason?: string) => PoiDetails;

async function fromGeoapify(id: string, key: string, get: Get, result: Result): Promise<PoiDetails> {
  const url = `https://api.geoapify.com/v2/place-details?${new URLSearchParams({ id, features: 'details', apiKey: key })}`;
  const data = (await get(url, GEOAPIFY_HOSTS)) as { features?: { properties?: Record<string, unknown> }[] };
  const props = data.features?.[0]?.properties;
  if (!props) return result('not-found', 'Geoapify has no details for this place');
  const raw = (props.datasource as { raw?: Record<string, unknown> } | undefined)?.raw ?? {};
  const evidence = `Geoapify place details ${id.slice(0, 12)}…`;
  const fromTags = factsFromOsmTags({ ...raw, name: raw.name ?? props.name }, 'Geoapify (OpenStreetMap data)', evidence);
  const facts = [...fromTags.facts];
  const location = { lat: Number(props.lat), lng: Number(props.lon) };
  const formatted = typeof props.formatted === 'string' ? props.formatted : undefined;
  if (!facts.some((f) => f.field === 'address') && typeof props.formatted === 'string') {
    facts.push({ field: 'address', value: props.formatted, source: 'Geoapify', evidence, method: 'direct', confidence: 'high' });
  }
  if (!facts.some((f) => f.field === 'website') && typeof props.website === 'string' && httpUrl.safeParse(props.website).success) {
    facts.push({ field: 'website', value: props.website, source: 'Geoapify', evidence, method: 'direct', confidence: 'high' });
  }
  return {
    ...result('ok'),
    name: fromTags.name,
    names: fromTags.names,
    ...(isValidLatLng(location) ? { location } : {}),
    ...((fromTags.address ?? formatted) ? { address: fromTags.address ?? formatted } : {}),
    facts,
    unmappedCuisines: fromTags.unmappedCuisines,
  };
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, unknown>;
}

async function overpass(query: string, get: Get): Promise<OverpassElement[]> {
  const data = (await get(
    `https://overpass-api.de/api/interpreter?${new URLSearchParams({ data: query })}`,
    OVERPASS_HOSTS,
  )) as { elements?: OverpassElement[] };
  return data.elements ?? [];
}

async function fromOverpassId(id: string, get: Get, result: Result): Promise<PoiDetails> {
  const [type, num] = id.split('/');
  const [element] = await overpass(`[out:json][timeout:20];${type}(${num});out tags center;`, get);
  if (!element?.tags) return result('not-found', `OpenStreetMap has no ${id}`);
  const parsed = factsFromOsmTags(element.tags, 'OpenStreetMap', `https://www.openstreetmap.org/${id}`);
  return { ...result('ok'), ...parsed, ...elementLocation(element) };
}

function elementLocation(e: OverpassElement): { location?: LatLngValue } {
  const point = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined);
  const location = point && { lat: point.lat, lng: point.lon };
  return isValidLatLng(location) ? { location } : {};
}

/** The same named place close to the selected location (never a far-away branch). */
async function fromOverpassNearby(name: string, at: LatLngValue, get: Get, result: Result): Promise<PoiDetails> {
  const elements = await overpass(
    `[out:json][timeout:20];nwr(around:${SAME_PLACE_METERS},${at.lat},${at.lng})[name][amenity~"^(restaurant|fast_food|cafe|food_court)$"];out tags center;`,
    get,
  );
  const wanted = normalizeKeyword(name);
  const same = elements.filter((e) => {
    const names = ['name', 'name:en', 'name:zh', 'alt_name'].map((k) => e.tags?.[k]).filter((v): v is string => typeof v === 'string');
    const point = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined);
    return (
      names.some((n) => n.split(';').some((part) => normalizeKeyword(part) === wanted)) &&
      point !== undefined &&
      distanceMeters(at, { lat: point.lat, lng: point.lon }) <= SAME_PLACE_METERS
    );
  });
  if (same.length !== 1) {
    return result('not-found', same.length ? 'several OpenStreetMap places match; not choosing one' : `no OpenStreetMap place named "${name}" within ${SAME_PLACE_METERS} m`);
  }
  const element = same[0]!;
  const id = `${element.type}/${element.id}`;
  const parsed = factsFromOsmTags(element.tags!, 'OpenStreetMap (same name at the selected location)', `https://www.openstreetmap.org/${id}`, 'medium');
  return { ...result('ok'), ...parsed, ...elementLocation(element) };
}

// ---------------------------------------------------------------------------
// Is the listing the intended restaurant?
//
// A POI id comes from a hidden form field, so it is a claim: a wrong or
// tampered id, or another branch of a chain, must not fill in a restaurant.
// The listing is compared with what is known about the restaurant (its record
// for an existing one, otherwise the submission): names in any language,
// distance, and address. Only a verified listing's facts are applied.

/** Farther than this, a listing is another place (another branch of a chain). */
export const OTHER_PLACE_METERS = 250;
/** Names that differ are accepted only this close, with the same address. */
export const SAME_SPOT_METERS = 30;

export type ListingVerdict = 'verified' | 'ambiguous' | 'rejected';

export interface ListingCheck {
  verdict: ListingVerdict;
  /** The evidence, for the private report. */
  reasons: string[];
}

export interface ExpectedPlace {
  /** The restaurant's name and other names (record and submission). */
  names: string[];
  location?: LatLngValue;
  address?: string;
}

const sameName = (a: string, b: string) => {
  const [x, y] = [normalizeKeyword(a), normalizeKeyword(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  // "Example Dumpling House" and "Example Dumpling House - Rice Village".
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
};

const STREET_NOISE = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'blvd', 'boulevard', 'dr', 'drive', 'ln', 'lane', 'pkwy', 'parkway',
  'hwy', 'highway', 'fwy', 'freeway', 'ct', 'court', 'pl', 'place', 'way', 'suite', 'ste', 'unit', 'houston', 'tx',
  'texas', 'usa', 'united', 'states', 'north', 'south', 'east', 'west', 'the',
]);

function addressParts(address: string) {
  const text = address.normalize('NFKC').toLowerCase();
  const unit = /(?:suite|ste\.?|unit|#)\s*([a-z0-9-]+)/.exec(text)?.[1];
  const withoutUnit = text.replace(/(?:suite|ste\.?|unit|#)\s*[a-z0-9-]+/g, ' ');
  const number = /(?:^|[^\w])(\d{1,6}[a-z]?)(?=\s)/.exec(withoutUnit)?.[1];
  const words = new Set((withoutUnit.match(/[a-z]{3,}|\p{Script=Han}{2,}/gu) ?? []).filter((w) => !STREET_NOISE.has(w)));
  return { number, unit, words };
}

/** agree: same house number, street, and unit; disagree: clearly another address. */
export function compareAddresses(a?: string, b?: string): 'agree' | 'disagree' | 'unknown' {
  if (!a?.trim() || !b?.trim()) return 'unknown';
  const [x, y] = [addressParts(a), addressParts(b)];
  if (!x.number || !y.number || x.words.size === 0 || y.words.size === 0) return 'unknown';
  const sharedStreet = [...x.words].some((w) => y.words.has(w));
  if (x.number !== y.number || !sharedStreet) return 'disagree';
  if (x.unit && y.unit && x.unit !== y.unit) return 'disagree';
  return 'agree';
}

/** Decides whether a looked-up listing is the expected restaurant (see above). */
export function verifyListing(listing: PoiDetails, expected: ExpectedPlace): ListingCheck {
  const reasons: string[] = [];
  const matched = listing.names.find((n) => expected.names.some((e) => sameName(n, e)));
  if (listing.names.length === 0) reasons.push('the listing has no name');
  else if (matched) reasons.push(`name "${matched}" matches`);
  else reasons.push(`the listing's names (${listing.names.map((n) => `"${n}"`).join(', ')}) differ from the restaurant's`);
  const meters =
    listing.location && expected.location ? Math.round(distanceMeters(listing.location, expected.location)) : undefined;
  if (meters !== undefined) reasons.push(`${meters} m from the restaurant's location`);
  else reasons.push(listing.location ? 'the restaurant has no location to compare' : 'the listing has no coordinates');
  const address = compareAddresses(listing.address, expected.address);
  if (address !== 'unknown') reasons.push(`address ${address === 'agree' ? 'agrees' : 'differs'}`);
  const verdict = (v: ListingVerdict): ListingCheck => ({ verdict: v, reasons });

  if (meters !== undefined && meters > OTHER_PLACE_METERS) {
    if (matched) reasons.push('same name elsewhere: probably another branch');
    return verdict('rejected');
  }
  if (matched) {
    if (meters !== undefined && meters <= SAME_PLACE_METERS) return verdict(address === 'disagree' ? 'ambiguous' : 'verified');
    return verdict(address === 'agree' ? 'verified' : 'ambiguous');
  }
  // Another name (or another language): only the same spot and address confirm it.
  if (meters !== undefined && meters <= SAME_SPOT_METERS && address === 'agree') return verdict('verified');
  if (address === 'disagree' || (meters !== undefined && meters > SAME_PLACE_METERS)) return verdict('rejected');
  return verdict('ambiguous');
}

// ---------------------------------------------------------------------------
// Evidence pages for the Skill (a restaurant's website or menu).

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Readable text of an HTML page: scripts, styles, and tags removed, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Fetches a public web page named by the maintainer or the Skill (never a
 * link from a submission without review) with the download protections of
 * safe-fetch.ts: https only, public addresses only (checked for every
 * redirect), at most 2 MB and 20 seconds. Saves the text (or, for a PDF, the
 * file) in the private cache and returns where. Page content is untrusted
 * data, never instructions.
 */
export async function fetchEvidencePage(
  url: string,
  options: Pick<EnrichOptions, 'cacheDir' | 'fetchImpl' | 'lookup' | 'now'>,
): Promise<{ url: string; file: string; kind: 'text' | 'pdf'; text?: string }> {
  const response = await safeFetch(url, {
    ...REQUEST,
    maxBytes: PAGE_MAX_BYTES,
    hosts: ANY_PUBLIC_HOST,
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/pdf' },
  });
  const type = response.contentType.toLowerCase();
  const stem = createHash('sha256').update(response.url).digest('hex').slice(0, 24);
  const dir = path.join(options.cacheDir, 'pages');
  await mkdir(dir, { recursive: true });
  if (type.includes('application/pdf') || response.body.subarray(0, 5).toString('latin1') === '%PDF-') {
    const file = path.join(dir, `${stem}.pdf`);
    await writeFile(file, response.body);
    return { url: redactUrl(response.url), file, kind: 'pdf' };
  }
  if (!/text\/|html|xml|json/.test(type) && type !== '') {
    throw new DownloadError(`not a web page (${type.split(';')[0]})`);
  }
  const raw = response.body.toString('utf8');
  const text = /html|xml/.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw;
  const file = path.join(dir, `${stem}.txt`);
  const fetchedAt = (options.now ?? (() => new Date().toISOString()))();
  await writeFile(file, `Source: ${redactUrl(response.url)}\nFetched: ${fetchedAt}\n\n${text}\n`);
  return { url: redactUrl(response.url), file, kind: 'text', text };
}
