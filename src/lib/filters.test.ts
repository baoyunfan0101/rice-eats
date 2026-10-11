import { describe, expect, it } from 'vitest';
import type { RestaurantSummary } from '../content/model';
import {
  DEFAULT_STATE,
  facetValues,
  filterRestaurants,
  parseBrowseState,
  toSearchParams,
} from './filters';

const r = (id: string, extra: Partial<RestaurantSummary> = {}): RestaurantSummary => ({
  id,
  status: 'published',
  name: id,
  altNames: [],
  cuisines: [],
  tags: [],
  links: {},
  ...extra,
});

const list = [
  r('Bayou', { cuisines: ['bbq'], tags: ['group'], rating: 5, pricePerPerson: 28 }),
  r('Pho', {
    altNames: ['河粉'],
    cuisines: ['vietnamese'],
    tags: ['budget', 'solo'],
    rating: 2,
    pricePerPerson: 12,
  }),
  r('Steak', { cuisines: ['bbq', 'steak'], tags: ['date', 'group'], pricePerPerson: 80 }),
];

describe('browse state', () => {
  it('round-trips through URL parameters and ignores invalid values', () => {
    const state = {
      ...DEFAULT_STATE,
      view: 'map' as const,
      query: 'pho',
      cuisine: 'bbq',
      tag: 'date',
      rating: 5 as const,
      price: '2' as const,
      selected: 'x',
    };
    expect(parseBrowseState(toSearchParams(state))).toEqual(state);
    expect(toSearchParams(DEFAULT_STATE).toString()).toBe('');
    expect(parseBrowseState(new URLSearchParams('view=nope&price=9&sort=bad&rating=7'))).toEqual(
      DEFAULT_STATE,
    );
  });

  it('filters by name, alternative name, cuisine, tag, rating, and price', () => {
    const ids = (s: Partial<typeof DEFAULT_STATE>) =>
      filterRestaurants(list, { ...DEFAULT_STATE, ...s }).map((x) => x.id);
    expect(ids({ query: 'PHO' })).toEqual(['Pho']);
    expect(ids({ query: '河粉' })).toEqual(['Pho']);
    expect(ids({ cuisine: 'bbq' })).toEqual(['Bayou', 'Steak']);
    expect(ids({ tag: 'group' })).toEqual(['Bayou', 'Steak']);
    expect(ids({ tag: 'date' })).toEqual(['Steak']);
    expect(ids({ rating: 2 })).toEqual(['Pho']);
    expect(ids({ price: '1' })).toEqual(['Pho']);
    expect(ids({ price: '4' })).toEqual(['Steak']);
    expect(ids({ cuisine: 'bbq', price: '2' })).toEqual(['Bayou']);
    expect(ids({ query: 'nothing' })).toEqual([]);
  });

  it('sorts by numeric rating (highest first, unrated last), name, or price', () => {
    const ids = (sort: typeof DEFAULT_STATE.sort) =>
      filterRestaurants(list, { ...DEFAULT_STATE, sort }).map((x) => x.id);
    expect(ids('rating')).toEqual(['Bayou', 'Pho', 'Steak']);
    const more = [
      r('Low', { rating: 1 }),
      r('None'),
      r('Top', { rating: 5 }),
      r('Mid', { rating: 3 }),
    ];
    expect(filterRestaurants(more, DEFAULT_STATE).map((x) => x.id)).toEqual([
      'Top',
      'Mid',
      'Low',
      'None',
    ]);
    expect(ids('price')).toEqual(['Pho', 'Bayou', 'Steak']);
    expect(ids('name')).toEqual(['Bayou', 'Pho', 'Steak']);
  });

  it('keeps restaurants with the same name apart', () => {
    const twins = [r('r-2', { name: '街角塔可' }), r('r-1', { name: '街角塔可' })];
    expect(filterRestaurants(twins, { ...DEFAULT_STATE, sort: 'name' }).map((x) => x.id)).toEqual([
      'r-1',
      'r-2',
    ]);
  });

  it('lists facet values by frequency', () => {
    expect(facetValues(list, (x) => x.cuisines)).toEqual(['bbq', 'steak', 'vietnamese']);
  });
});
