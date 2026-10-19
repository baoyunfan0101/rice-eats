// Data contract for generated website data: the build pipeline
// (scripts/content) writes these shapes into public/generated/, and the website
// reads them. Framework-independent; imports nothing from src/ or scripts/.

import type { PriceRange, Rating, Verdict } from './vocabulary';

export type { PriceRange, Rating, Verdict };

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

/** Public contributor identity. Contact details are never part of generated data. */
export interface Contributor {
  id: string;
  name: string;
}

/** One review's word on a dish. */
export interface DishReview {
  /** The review it comes from. */
  reviewId: string;
  contributor: Contributor;
  /** The review's submission time (ISO 8601) and its day, YYYY-MM-DD. */
  submittedAt: string;
  date: string;
  verdict?: Verdict;
  comment?: string;
  /** Indexes into RestaurantDetail.images of this review's photos of the dish. */
  imageIndexes: number[];
}

export interface Dish {
  id: string;
  name: string;
  /** How many reviews recommend it / warn against it. */
  recommend: number;
  avoid: number;
  /** Indexes into RestaurantDetail.images of every photo of this dish (newest review first). */
  imageIndexes: number[];
  /** Every review that mentions the dish, newest first. */
  reviews: DishReview[];
}

/** One review of the restaurant (one submission); a contributor may have several. */
export interface Review {
  /** The review id (reviews/<id>.json). */
  id: string;
  contributor: Contributor;
  /** When it was submitted (ISO 8601), and its day, YYYY-MM-DD. */
  submittedAt: string;
  date: string;
  rating: Rating;
  /** The per-person price range it gives, if any. */
  price?: PriceRange;
  /** Sanitized HTML of the review text; empty without text. */
  html: string;
  /** Indexes into RestaurantDetail.images of the review's photos (not of one dish). */
  imageIndexes: number[];
  /** The dishes it rates, in its order. */
  dishes: { id: string; name: string; verdict?: Verdict }[];
}

/** A tag from the registry (content/tags.json), with its display label. */
export interface Tag {
  id: string;
  label: string;
}

/** Optional explicit map links; otherwise the site derives them from location or address. */
export interface MapLinks {
  googleMaps?: string;
  appleMaps?: string;
  website?: string;
}

export interface RestaurantSummary {
  id: string;
  status: PublicationStatus;
  name: string;
  altNames: string[];
  /** Cuisine keys (see vocabulary.ts). */
  cuisines: string[];
  /** Tags from the registry, with their labels. */
  tags: Tag[];
  address?: string;
  location?: LatLng;
  /**
   * The average rating over contributors: each contributor's latest review
   * counts once. Rounded to a level; absent without reviews (a draft).
   */
  rating?: Rating;
  /** The average itself, one decimal. */
  ratingAverage?: number;
  /** How many contributors the rating counts (one latest review each). */
  raterCount: number;
  /** How many reviews there are (a contributor may have several). */
  reviewCount: number;
  /**
   * The average per-person price in US dollars over contributors (each
   * contributor's latest review that gives a price range counts once, as the
   * range's middle), the range it falls in, and how many contributors it counts.
   */
  pricePerPerson?: number;
  priceRange?: PriceRange;
  priceCount: number;
  /** The first image of the restaurant, if any. */
  cover?: ImageAsset;
  links: MapLinks;
}

export interface RestaurantDetail extends RestaurantSummary {
  /** Every image of the restaurant in its stored order; images[0] is the cover. */
  images: ImageAsset[];
  dishes: Dish[];
  /** Every review, newest first. */
  reviews: Review[];
  /** The people who wrote them, each once. */
  contributors: Contributor[];
}

export type ContentSource = 'content' | 'fixtures';

export interface ContentIndex {
  source: ContentSource;
  includesDrafts: boolean;
  restaurants: RestaurantSummary[];
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
