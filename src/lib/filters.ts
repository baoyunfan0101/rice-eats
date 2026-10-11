// Browsing state (view, search, filters, selection) lives in the URL query so
// it is shareable and survives reloads. All views use the same filtered list.

import {
  PRICE_BUCKETS,
  priceBucketOf,
  RATINGS,
  type PriceBucketId,
  type Rating,
  type RestaurantSummary,
} from '../content/model';

export const VIEWS = ['list', 'grid', 'map'] as const;
export type View = (typeof VIEWS)[number];

export const SORTS = ['rating', 'name', 'price'] as const;
export type Sort = (typeof SORTS)[number];

export interface BrowseState {
  view: View;
  query: string;
  /** Cuisine key. */
  cuisine: string;
  /** Tag key. */
  tag: string;
  rating: Rating | '';
  price: PriceBucketId | '';
  sort: Sort;
  /** Selected restaurant (highlighted on the map). */
  selected: string;
}

export const DEFAULT_STATE: BrowseState = {
  view: 'list',
  query: '',
  cuisine: '',
  tag: '',
  rating: '',
  price: '',
  sort: 'rating',
  selected: '',
};

const oneOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

export function parseBrowseState(params: URLSearchParams): BrowseState {
  const rating = Number(params.get('rating'));
  return {
    view: oneOf(VIEWS, params.get('view'), DEFAULT_STATE.view),
    query: params.get('q') ?? '',
    cuisine: params.get('cuisine') ?? '',
    tag: params.get('tag') ?? '',
    rating: (RATINGS as readonly number[]).includes(rating) ? (rating as Rating) : '',
    price: oneOf(
      PRICE_BUCKETS.map((b) => b.id),
      params.get('price'),
      '',
    ),
    sort: oneOf(SORTS, params.get('sort'), DEFAULT_STATE.sort),
    selected: params.get('id') ?? '',
  };
}

export function toSearchParams(state: BrowseState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.view !== DEFAULT_STATE.view) params.set('view', state.view);
  if (state.query) params.set('q', state.query);
  if (state.cuisine) params.set('cuisine', state.cuisine);
  if (state.tag) params.set('tag', state.tag);
  if (state.rating) params.set('rating', String(state.rating));
  if (state.price) params.set('price', state.price);
  if (state.sort !== DEFAULT_STATE.sort) params.set('sort', state.sort);
  if (state.selected) params.set('id', state.selected);
  return params;
}

export function hasActiveFilters(state: BrowseState): boolean {
  return Boolean(state.query || state.cuisine || state.tag || state.rating || state.price);
}

export function clearFilters(state: BrowseState): BrowseState {
  return { ...state, query: '', cuisine: '', tag: '', rating: '', price: '' };
}

const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function filterRestaurants(
  restaurants: RestaurantSummary[],
  state: BrowseState,
): RestaurantSummary[] {
  const query = normalize(state.query);
  const result = restaurants.filter((r) => {
    if (query && ![r.name, ...r.altNames].some((name) => normalize(name).includes(query))) {
      return false;
    }
    if (state.cuisine && !r.cuisines.includes(state.cuisine)) return false;
    if (state.tag && !r.tags.includes(state.tag)) return false;
    if (state.rating && r.rating !== state.rating) return false;
    if (state.price && priceBucketOf(r.pricePerPerson) !== state.price) return false;
    return true;
  });
  return sortRestaurants(result, state.sort);
}

// Highest rating first; unrated restaurants (0) last.
const ratingOf = (r: RestaurantSummary) => r.rating ?? 0;
const byName = (a: RestaurantSummary, b: RestaurantSummary) =>
  a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id);

export function sortRestaurants(list: RestaurantSummary[], sort: Sort): RestaurantSummary[] {
  const sorted = [...list];
  if (sort === 'name') sorted.sort(byName);
  if (sort === 'rating') sorted.sort((a, b) => ratingOf(b) - ratingOf(a) || byName(a, b));
  if (sort === 'price') {
    sorted.sort(
      (a, b) => (a.pricePerPerson ?? Infinity) - (b.pricePerPerson ?? Infinity) || byName(a, b),
    );
  }
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
