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
