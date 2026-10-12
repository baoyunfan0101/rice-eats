// Controlled vocabularies of the canonical database: the only list of valid
// keys. Restaurant data stores these language-independent keys; display labels
// belong to the website (src/lib/labels.ts). To add a cuisine or tag, add its
// key here and its label there (TypeScript reports a missing label).

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

/** Scenario tags ("good for ..."). */
export const TAG_IDS = [
  'budget',
  'date',
  'group',
  'late-night',
  'quick',
  'solo',
  'spicy',
  'study',
] as const;
export type TagId = (typeof TAG_IDS)[number];

/** Personal rating: an integer from 5 (highest) to 1 (lowest). */
export const RATINGS = [5, 4, 3, 2, 1] as const;
export type Rating = (typeof RATINGS)[number];

/** Dish verdict: 1 recommended, -1 not recommended. Absent: no opinion. */
export const VERDICTS = [1, -1] as const;
export type Verdict = (typeof VERDICTS)[number];
