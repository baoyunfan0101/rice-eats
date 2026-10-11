// Shared data model for generated restaurant content.
// The content pipeline (scripts/content) writes these shapes; the website reads them.

/**
 * Personal rating: an integer from 1 (lowest) to 5 (highest). Restaurant data
 * stores only the number; display labels live in src/lib/format.ts.
 */
export const RATINGS = [5, 4, 3, 2, 1] as const;
export type Rating = (typeof RATINGS)[number];

export const VERDICTS = ['推荐', '不推荐'] as const;
export type Verdict = (typeof VERDICTS)[number];

export type PublicationStatus = 'draft' | 'published';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ImageAsset {
  /** Absolute URL (including the site base path) of a mid-size rendition. */
  src: string;
  /** `srcset` value listing every generated width. */
  srcset: string;
  /** Intrinsic size of the largest rendition; used to reserve layout space. */
  width: number;
  height: number;
  alt: string;
}

export interface Contributor {
  name: string;
  url?: string;
}

export interface Dish {
  name: string;
  verdict?: Verdict;
  comment?: string;
  image?: ImageAsset;
}

export interface RestaurantSummary {
  id: string;
  status: PublicationStatus;
  name: string;
  altNames: string[];
  summary?: string;
  cuisines: string[];
  neighborhood?: string;
  address?: string;
  location?: LatLng;
  rating?: Rating;
  pricePerPerson?: number;
  tags: string[];
  cover?: ImageAsset;
  /** Link that opens the restaurant in Google Maps, if one can be derived. */
  mapsUrl?: string;
}

export interface RestaurantDetail extends RestaurantSummary {
  dishes: Dish[];
  /** Sanitized HTML rendered from review.md. Empty when there is no review. */
  reviewHtml: string;
  website?: string;
  contributors: Contributor[];
}

export type ContentSource = 'content' | 'fixtures';

export interface ContentIndex {
  source: ContentSource;
  includesDrafts: boolean;
  restaurants: RestaurantSummary[];
}

/** Price buckets used by the price filter, in US dollars per person. */
export const PRICE_BUCKETS = [
  { id: '1', min: 0, max: 15 },
  { id: '2', min: 15, max: 30 },
  { id: '3', min: 30, max: 60 },
  { id: '4', min: 60, max: Infinity },
] as const;
export type PriceBucketId = (typeof PRICE_BUCKETS)[number]['id'];

export function priceBucketOf(price: number | undefined): PriceBucketId | undefined {
  if (price === undefined) return undefined;
  return PRICE_BUCKETS.find((bucket) => price >= bucket.min && price < bucket.max)?.id;
}

/** Rice University main quad; the map centers here and coordinates are checked against it. */
export const RICE_CENTER: LatLng = { lat: 29.7174, lng: -95.4018 };

export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
