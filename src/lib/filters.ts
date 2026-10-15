// Browsing state (search, filters, sort, map selection) lives in the URL query
// so it is shareable and survives reloads. The list (A) and the map (B) show
// the same filtered restaurants; only the list order depends on the sort.
//
// Filters: within one dimension any selected value matches (OR); across
// dimensions all must match (AND); an empty dimension does not restrict.

import type { LatLng, RestaurantSummary } from '../../shared/content/model';
import { CUISINE_IDS, RATINGS, type Rating } from '../../shared/content/vocabulary';
import { distanceMeters } from './poi';
import { PRICE_BUCKETS } from './price';

/** Sorts kept in the URL. Distance needs the visitor's location, so it is never stored. */
export const SORTS = ['rating', 'price-asc', 'price-desc', 'name'] as const;
export type Sort = (typeof SORTS)[number] | 'distance';

export interface BrowseState {
  query: string;
  /** Cuisine keys (any of them). */
  cuisines: string[];
  /** Tag ids from the registry (any of them). */
  tags: string[];
  /** Exact ratings (any of them), not "this rating or better". */
  ratings: Rating[];
  /** Price per person in USD, inclusive; undefined means no bound. */
  priceMin?: number;
  priceMax?: number;
  sort: (typeof SORTS)[number];
  /** Restaurant selected on the map (its preview is shown). */
  selected: string;
}

export const DEFAULT_STATE: BrowseState = {
  query: '',
  cuisines: [],
  tags: [],
  ratings: [],
  sort: 'rating',
  selected: '',
};

/**
 * Canonical order for a list of keys: vocabulary order, then other keys
 * alphabetically. Tags have no fixed list, so they are always alphabetical,
 * and a link keeps working when new tags are added.
 */
function canonical(values: Iterable<string>, order: readonly string[]): string[] {
  const unique = [...new Set([...values].map((v) => v.trim()).filter(Boolean))];
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i < 0 ? order.length : i;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Values of a list parameter: comma-separated, and repeated keys are accepted too. */
const listParam = (params: URLSearchParams, key: string) =>
  params.getAll(key).flatMap((v) => v.split(','));

const price = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
};

/**
 * Reads the state from the URL. Invalid values are ignored. Older links still
 * work: `view=list|grid|map` is ignored (there is one page now), and the
 * single-value `cuisine`, `tag`, `rating`, `price=<bucket>`, and `sort=price`
 * map onto the new filters.
 */
export function parseBrowseState(params: URLSearchParams): BrowseState {
  const ratings = listParam(params, 'rating')
    .map(Number)
    .filter((r): r is Rating => (RATINGS as readonly number[]).includes(r));
  let priceMin = price(params.get('min'));
  let priceMax = price(params.get('max'));
  const bucket = PRICE_BUCKETS.find((b) => b.id === params.get('price'));
  if (bucket && priceMin === undefined && priceMax === undefined) {
    priceMin = bucket.min > 0 ? bucket.min : undefined;
    priceMax = Number.isFinite(bucket.max) ? bucket.max : undefined;
  }
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }
  const sortParam = params.get('sort') === 'price' ? 'price-asc' : params.get('sort');
  return {
    query: params.get('q') ?? '',
    cuisines: canonical(listParam(params, 'cuisine'), CUISINE_IDS),
    tags: canonical(listParam(params, 'tag'), []),
    ratings: [...new Set(ratings)].sort((a, b) => b - a),
    ...(priceMin !== undefined ? { priceMin } : {}),
    ...(priceMax !== undefined ? { priceMax } : {}),
    sort: (SORTS as readonly string[]).includes(sortParam ?? '')
      ? (sortParam as BrowseState['sort'])
      : DEFAULT_STATE.sort,
    selected: params.get('id') ?? '',
  };
}

/** Writes the state to URL parameters in a stable order (defaults are left out). */
export function toSearchParams(state: BrowseState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  const cuisines = canonical(state.cuisines, CUISINE_IDS);
  if (cuisines.length) params.set('cuisine', cuisines.join(','));
  const tags = canonical(state.tags, []);
  if (tags.length) params.set('tag', tags.join(','));
  if (state.ratings.length) {
    params.set('rating', [...new Set(state.ratings)].sort((a, b) => b - a).join(','));
  }
  if (state.priceMin !== undefined) params.set('min', String(state.priceMin));
  if (state.priceMax !== undefined) params.set('max', String(state.priceMax));
  if (state.sort !== DEFAULT_STATE.sort) params.set('sort', state.sort);
  if (state.selected) params.set('id', state.selected);
  return params;
}

export const hasPriceRange = (state: Pick<BrowseState, 'priceMin' | 'priceMax'>) =>
  state.priceMin !== undefined || state.priceMax !== undefined;

export function hasActiveFilters(state: BrowseState): boolean {
  return Boolean(
    state.query ||
    state.cuisines.length ||
    state.tags.length ||
    state.ratings.length ||
    hasPriceRange(state),
  );
}

/** Clears the search and every filter; the sort is kept. */
export function clearFilters(state: BrowseState): BrowseState {
  return { ...DEFAULT_STATE, sort: state.sort, selected: state.selected };
}

const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The restaurants matching the search and filters, in their original order. */
export function filterRestaurants(
  restaurants: RestaurantSummary[],
  state: BrowseState,
): RestaurantSummary[] {
  const query = normalize(state.query);
  const priced = hasPriceRange(state);
  return restaurants.filter((r) => {
    if (query && ![r.name, ...r.altNames].some((name) => normalize(name).includes(query))) {
      return false;
    }
    if (state.cuisines.length && !r.cuisines.some((c) => state.cuisines.includes(c))) return false;
    if (state.tags.length && !r.tags.some((t) => state.tags.includes(t.id))) return false;
    if (state.ratings.length && (r.rating === undefined || !state.ratings.includes(r.rating))) {
      return false;
    }
    if (priced) {
      // An unknown price cannot be in a range.
      const p = r.pricePerPerson;
      if (p === undefined) return false;
      if (state.priceMin !== undefined && p < state.priceMin) return false;
      if (state.priceMax !== undefined && p > state.priceMax) return false;
    }
    return true;
  });
}

// Highest rating first; unrated restaurants (0) last.
const ratingOf = (r: RestaurantSummary) => r.rating ?? 0;
const byName = (a: RestaurantSummary, b: RestaurantSummary) =>
  a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id);
/** Unknown prices sort after known ones in either direction. */
const byPrice = (direction: 1 | -1) => (a: RestaurantSummary, b: RestaurantSummary) => {
  const pa = a.pricePerPerson;
  const pb = b.pricePerPerson;
  if (pa === undefined || pb === undefined) {
    return (pa === undefined ? 1 : 0) - (pb === undefined ? 1 : 0) || byName(a, b);
  }
  return (pa - pb) * direction || byName(a, b);
};

/**
 * Orders restaurants without changing which ones are shown. Distance needs
 * `from` (the visitor's location, kept in memory only); restaurants without a
 * location come last.
 */
export function sortRestaurants(
  list: RestaurantSummary[],
  sort: Sort,
  from?: LatLng,
): RestaurantSummary[] {
  const sorted = [...list];
  if (sort === 'name') sorted.sort(byName);
  else if (sort === 'price-asc') sorted.sort(byPrice(1));
  else if (sort === 'price-desc') sorted.sort(byPrice(-1));
  else if (sort === 'distance' && from) {
    const d = (r: RestaurantSummary) => (r.location ? distanceMeters(from, r.location) : Infinity);
    sorted.sort((a, b) => d(a) - d(b) || byName(a, b));
  } else sorted.sort((a, b) => ratingOf(b) - ratingOf(a) || byName(a, b));
  return sorted;
}

/** Distinct values for filter menus, most common first. */
export function facetValues(
  restaurants: RestaurantSummary[],
  pick: (r: RestaurantSummary) => string[],
): string[] {
  const counts = new Map<string, number>();
  for (const r of restaurants) for (const v of pick(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

/** Toggles a value in a list (for multi-select filters). */
export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * A stable key for the set of restaurants on the map: changes when the
 * filtered set changes, never when only the order (sort) changes.
 */
export function resultKey(restaurants: RestaurantSummary[]): string {
  return restaurants
    .map((r) => r.id)
    .sort()
    .join(',');
}
