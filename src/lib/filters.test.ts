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
  ...extra,
});

const list = [
  r('Bayou', { cuisines: ['BBQ'], neighborhood: 'Montrose', tier: '夯', pricePerPerson: 28 }),
  r('Pho', {
    altNames: ['河粉'],
    cuisines: ['Vietnamese'],
    neighborhood: 'Midtown',
    tier: 'npc',
    pricePerPerson: 12,
  }),
  r('Steak', { cuisines: ['BBQ', 'Steak'], neighborhood: 'Montrose', pricePerPerson: 80 }),
];

describe('browse state', () => {
  it('round-trips through URL parameters and ignores invalid values', () => {
    const state = {
      ...DEFAULT_STATE,
      view: 'map' as const,
      query: 'pho',
      cuisine: 'BBQ',
      price: '2' as const,
      selected: 'x',
    };
    expect(parseBrowseState(toSearchParams(state))).toEqual(state);
    expect(toSearchParams(DEFAULT_STATE).toString()).toBe('');
    expect(parseBrowseState(new URLSearchParams('view=nope&price=9&sort=bad'))).toEqual(
      DEFAULT_STATE,
    );
  });

  it('filters by name, alternative name, cuisine, neighborhood, and price', () => {
    const ids = (s: Partial<typeof DEFAULT_STATE>) =>
      filterRestaurants(list, { ...DEFAULT_STATE, ...s }).map((x) => x.id);
    expect(ids({ query: 'PHO' })).toEqual(['Pho']);
    expect(ids({ query: '河粉' })).toEqual(['Pho']);
    expect(ids({ cuisine: 'BBQ' })).toEqual(['Bayou', 'Steak']);
    expect(ids({ neighborhood: 'Midtown' })).toEqual(['Pho']);
    expect(ids({ price: '1' })).toEqual(['Pho']);
    expect(ids({ price: '4' })).toEqual(['Steak']);
    expect(ids({ cuisine: 'BBQ', price: '2' })).toEqual(['Bayou']);
    expect(ids({ query: 'nothing' })).toEqual([]);
  });

  it('sorts by tier (unrated last), name, or price', () => {
    const ids = (sort: typeof DEFAULT_STATE.sort) =>
      filterRestaurants(list, { ...DEFAULT_STATE, sort }).map((x) => x.id);
    expect(ids('tier')).toEqual(['Bayou', 'Pho', 'Steak']);
    expect(ids('price')).toEqual(['Pho', 'Bayou', 'Steak']);
    expect(ids('name')).toEqual(['Bayou', 'Pho', 'Steak']);
  });

  it('lists facet values by frequency', () => {
    expect(facetValues(list, (x) => x.cuisines)).toEqual(['BBQ', 'Steak', 'Vietnamese']);
  });
});
