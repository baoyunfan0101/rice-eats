// Controlled vocabularies of the canonical database: the only list of valid
// keys. Restaurant data stores these language-independent keys; display labels
// belong to the website (src/lib/labels.ts). To add a cuisine, add its key here
// and its label there (TypeScript reports a missing label).
//
// Tags are not a fixed list: they live in the tag registry (content/tags.json,
// schema in schema.ts), which grows through reviewed submissions.

export const CUISINE_IDS = [
  'american',
  'bakery',
  'bbq',
  'cantonese',
  'chinese',
  'coffee',
  'dessert',
  'fast-food',
  'japanese',
  'korean',
  'mexican',
  'ramen',
  'sichuan',
  'steak',
  'taiwanese',
  'thai',
  'vietnamese',
] as const;
export type CuisineId = (typeof CUISINE_IDS)[number];

/** Personal rating: an integer from 5 (highest) to 1 (lowest). */
export const RATINGS = [5, 4, 3, 2, 1] as const;
export type Rating = (typeof RATINGS)[number];

/** Dish verdict: 1 recommended, -1 not recommended. Absent: no opinion. */
export const VERDICTS = [1, -1] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Per-person price ranges in US dollars that a review may give (the form's
 * "人均价格" question). `max` is exclusive; the last range has no upper end.
 */
export const PRICE_RANGES = [
  { id: 'under-10', min: 0, max: 10 },
  { id: '10-20', min: 10, max: 20 },
  { id: '20-30', min: 20, max: 30 },
  { id: '30-50', min: 30, max: 50 },
  { id: '50-100', min: 50, max: 100 },
  { id: '100-plus', min: 100 },
] as const;
export type PriceRange = (typeof PRICE_RANGES)[number]['id'];
export const PRICE_RANGE_IDS = PRICE_RANGES.map((r) => r.id) as readonly PriceRange[];

/** What a range counts as in an average: its middle, or its lower end when it has no upper end. */
export function priceValue(id: PriceRange): number {
  const range = PRICE_RANGES.find((r) => r.id === id)!;
  return 'max' in range ? (range.min + range.max) / 2 : range.min;
}

/** The range a price falls in (a boundary belongs to the higher range). */
export function priceRangeOf(price: number): PriceRange {
  return [...PRICE_RANGES].reverse().find((r) => price >= r.min)!.id;
}
