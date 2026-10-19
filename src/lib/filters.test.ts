import { describe, expect, it } from 'vitest';
import type { RestaurantSummary } from '../../shared/content/model';
import {
  clearFilters,
  DEFAULT_STATE,
  facetValues,
  filterRestaurants,
  hasActiveFilters,
  parseBrowseState,
  resultKey,
  sortRestaurants,
  toggle,
  toSearchParams,
  type BrowseState,
} from './filters';

const TAG_LABELS: Record<string, string> = {
  date: '适合约会',
  group: '适合聚餐',
  budget: '实惠',
  solo: '适合一人食',
  spicy: '偏辣',
};
const r = (
  id: string,
  { tags = [], ...extra }: Partial<Omit<RestaurantSummary, 'tags'>> & { tags?: string[] } = {},
): RestaurantSummary => ({
  id,
  status: 'published',
  name: id,
  altNames: [],
  cuisines: [],
  tags: tags.map((t) => ({ id: t, label: TAG_LABELS[t] ?? t })),
  links: {},
  raterCount: 1,
  reviewCount: 1,
  // Sorting uses the average; here it is the rating itself.
  ...(extra.rating !== undefined ? { ratingAverage: extra.rating } : {}),
  ...extra,
});

const list = [
  r('Bayou', {
    cuisines: ['bbq'],
    tags: ['group'],
    rating: 5,
    pricePerPerson: 28,
    location: { lat: 29.74, lng: -95.39 },
  }),
  r('Pho', {
    altNames: ['河粉'],
    cuisines: ['vietnamese'],
    tags: ['budget', 'solo'],
    rating: 2,
    pricePerPerson: 12,
    location: { lat: 29.72, lng: -95.4 },
  }),
  r('Steak', { cuisines: ['bbq', 'steak'], tags: ['date', 'group'], pricePerPerson: 80 }),
  r('Sichuan', {
    cuisines: ['sichuan'],
    tags: ['spicy', 'group'],
    rating: 4,
    pricePerPerson: 40,
    location: { lat: 29.73, lng: -95.42 },
  }),
  r('Ramen', { cuisines: ['japanese', 'ramen'], tags: ['solo'], rating: 4 }),
];

const ids = (s: Partial<BrowseState>) =>
  filterRestaurants(list, { ...DEFAULT_STATE, ...s }).map((x) => x.id);

describe('filters', () => {
  it('returns every restaurant without filters, in the original order', () => {
    expect(ids({})).toEqual(['Bayou', 'Pho', 'Steak', 'Sichuan', 'Ramen']);
    expect(hasActiveFilters(DEFAULT_STATE)).toBe(false);
  });

  it('searches names and alternative names', () => {
    expect(ids({ query: 'PHO' })).toEqual(['Pho']);
    expect(ids({ query: '河粉' })).toEqual(['Pho']);
    expect(ids({ query: 'nothing' })).toEqual([]);
  });

  it('matches any selected value within a dimension', () => {
    expect(ids({ cuisines: ['sichuan', 'japanese'] })).toEqual(['Sichuan', 'Ramen']);
    expect(ids({ tags: ['date', 'budget'] })).toEqual(['Pho', 'Steak']);
    // Exactly these ratings, not "this or better".
    expect(ids({ ratings: [4] })).toEqual(['Sichuan', 'Ramen']);
    expect(ids({ ratings: [5, 2] })).toEqual(['Bayou', 'Pho']);
  });

  it('requires every dimension to match', () => {
    expect(ids({ cuisines: ['bbq', 'sichuan'], tags: ['group'], ratings: [5, 4] })).toEqual([
      'Bayou',
      'Sichuan',
    ]);
    expect(ids({ cuisines: ['bbq'], tags: ['spicy'] })).toEqual([]);
    expect(ids({ query: 'bay', cuisines: ['bbq'] })).toEqual(['Bayou']);
  });

  it('filters by an inclusive price range, open at either end', () => {
    expect(ids({ priceMin: 12, priceMax: 28 })).toEqual(['Bayou', 'Pho']);
    expect(ids({ priceMin: 28.01, priceMax: 40 })).toEqual(['Sichuan']);
    expect(ids({ priceMin: 40 })).toEqual(['Steak', 'Sichuan']);
    expect(ids({ priceMax: 12 })).toEqual(['Pho']);
    // A price above the slider's top end is still reachable.
    expect(ids({ priceMin: 75 })).toEqual(['Steak']);
  });

  it('leaves out unknown prices only when a range is set', () => {
    expect(ids({})).toContain('Ramen');
    expect(ids({ priceMin: 0 })).not.toContain('Ramen');
    expect(ids({ priceMax: 1000 })).not.toContain('Ramen');
  });

  it('clears filters but keeps the sort', () => {
    const state: BrowseState = {
      ...DEFAULT_STATE,
      query: 'x',
      cuisines: ['bbq'],
      tags: ['date'],
      ratings: [5],
      priceMin: 1,
      priceMax: 2,
      sort: 'price-desc',
    };
    expect(hasActiveFilters(state)).toBe(true);
    expect(clearFilters(state)).toEqual({ ...DEFAULT_STATE, sort: 'price-desc' });
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('sorting', () => {
  const sorted = (
    sort: Parameters<typeof sortRestaurants>[1],
    from?: { lat: number; lng: number },
  ) => sortRestaurants(list, sort, from).map((x) => x.id);

  it('sorts by rating (highest first, unrated last) by default', () => {
    expect(sorted('rating')).toEqual(['Bayou', 'Ramen', 'Sichuan', 'Pho', 'Steak']);
  });

  it('sorts by price both ways, unknown prices last', () => {
    expect(sorted('price-asc')).toEqual(['Pho', 'Bayou', 'Sichuan', 'Steak', 'Ramen']);
    expect(sorted('price-desc')).toEqual(['Steak', 'Sichuan', 'Bayou', 'Pho', 'Ramen']);
  });

  it('sorts by distance from the visitor, restaurants without a location last', () => {
    expect(sorted('distance', { lat: 29.721, lng: -95.401 })).toEqual([
      'Pho',
      'Sichuan',
      'Bayou',
      'Ramen',
      'Steak',
    ]);
    // Without a location yet, distance falls back to the rating order.
    expect(sorted('distance')).toEqual(sorted('rating'));
  });

  it('sorts by name and keeps same-name restaurants apart', () => {
    expect(sorted('name')).toEqual(['Bayou', 'Pho', 'Ramen', 'Sichuan', 'Steak']);
    const twins = [r('r-2', { name: '街角塔可' }), r('r-1', { name: '街角塔可' })];
    expect(sortRestaurants(twins, 'name').map((x) => x.id)).toEqual(['r-1', 'r-2']);
  });

  it('never changes the set of results, so the map key stays the same', () => {
    const results = filterRestaurants(list, { ...DEFAULT_STATE, tags: ['group'] });
    const key = resultKey(results);
    for (const sort of ['rating', 'price-asc', 'price-desc', 'name', 'distance'] as const) {
      expect(resultKey(sortRestaurants(results, sort, { lat: 29.7, lng: -95.4 }))).toBe(key);
    }
  });
});

describe('URL state', () => {
  it('round-trips multi-select filters, the price range, the sort, and the selection', () => {
    const state: BrowseState = {
      query: 'pho',
      cuisines: ['sichuan', 'bbq'],
      tags: ['group', 'date'],
      ratings: [4, 5],
      priceMin: 15,
      priceMax: 40,
      sort: 'price-asc',
      selected: 'x',
    };
    const params = toSearchParams(state);
    // A stable order: vocabulary order for keys, ratings from high to low.
    expect(params.toString()).toBe(
      'q=pho&cuisine=bbq%2Csichuan&tag=date%2Cgroup&rating=5%2C4&min=15&max=40&sort=price-asc&id=x',
    );
    expect(parseBrowseState(params)).toEqual({
      ...state,
      cuisines: ['bbq', 'sichuan'],
      tags: ['date', 'group'],
      ratings: [5, 4],
    });
    expect(toSearchParams(DEFAULT_STATE).toString()).toBe('');
  });

  it('keeps one end of the price range on its own', () => {
    expect(parseBrowseState(new URLSearchParams('min=20'))).toMatchObject({ priceMin: 20 });
    expect(parseBrowseState(new URLSearchParams('max=20')).priceMin).toBeUndefined();
  });

  it('ignores invalid values and swaps a reversed price range', () => {
    expect(
      parseBrowseState(new URLSearchParams('sort=bad&rating=7,x&min=-3&max=abc&tag=')),
    ).toEqual(DEFAULT_STATE);
    expect(parseBrowseState(new URLSearchParams('min=40&max=15'))).toMatchObject({
      priceMin: 15,
      priceMax: 40,
    });
    // Distance needs the visitor's location, so it is never restored from a link.
    expect(parseBrowseState(new URLSearchParams('sort=distance')).sort).toBe('rating');
  });

  it('reads single and repeated filter keys', () => {
    // Repeated keys work too.
    expect(parseBrowseState(new URLSearchParams('tag=date&tag=group')).tags).toEqual([
      'date',
      'group',
    ]);
  });
});

describe('facets', () => {
  it('lists facet values by frequency', () => {
    expect(facetValues(list, (x) => x.cuisines)).toEqual([
      'bbq',
      'japanese',
      'ramen',
      'sichuan',
      'steak',
      'vietnamese',
    ]);
  });
});
